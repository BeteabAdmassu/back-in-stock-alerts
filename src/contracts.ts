// Shared contracts between layers. Changes here belong to the coordinator: every module depends on
// them, so they must not drift. See docs/ARCHITECTURE.md for the reasoning behind each state.

// ---------- configuration ----------

export interface Timings {
  /** How often workers look for due work when not woken explicitly. */
  pollIntervalMs: number;
  /** How often open SKUs are re-checked, to catch webhooks that never arrived. */
  reconcileIntervalMs: number;
  /** A claimed row is considered abandoned after this. Must exceed twice httpTimeoutMs. */
  leaseMs: number;
  /** Per-request timeout for the stock and email APIs. */
  httpTimeoutMs: number;
  /** Stock verified more recently than this is trusted at send time; older is re-verified. */
  stockFreshnessMs: number;
  /** Stop retrying this long after the first send: the provider's idempotency window is 24h. */
  emailGiveUpAfterMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  pollIntervalMs: 1_000,
  reconcileIntervalMs: 60_000,
  leaseMs: 60_000,
  httpTimeoutMs: 10_000,
  stockFreshnessMs: 60_000,
  emailGiveUpAfterMs: 23 * 60 * 60 * 1000,
};

export interface AppConfig {
  port: number;
  dataDir: string;
  stockApiUrl: string; // no trailing slash
  stockApiKey: string;
  resendApiKey: string;
  resendBaseUrl: string; // no trailing slash
  webhookSecret: string;
  adminPassword: string;
  emailFrom: string;
  /** Optional, e.g. https://shop.example/p/{sku}. Without it the email has no shop button. */
  productUrlTemplate: string | null;
  logLevel: string;
  /** Reverse proxies in front of the app whose forwarded client IP to believe. 0 trusts none. */
  trustProxyHops: number;
  timings: Timings;
}

export type Clock = () => Date;

// ---------- domain ----------

/**
 * open      waiting for the product to come back
 * queued    stock verified; an email is due at next_attempt_at
 * sending   claimed by the email worker under a lease
 * notified  provider accepted the email (terminal)
 * failed    gave up; visible in admin, can be retried there (terminal unless retried)
 *
 * open, queued and sending are the "open" states covered by the partial unique index.
 */
export type RequestStatus = 'open' | 'queued' | 'sending' | 'notified' | 'failed';

export const REQUEST_STATUSES: readonly RequestStatus[] = [
  'open',
  'queued',
  'sending',
  'notified',
  'failed',
];

/** Product details from the stock API, already sanitised by the client. All fields optional. */
export interface ProductInfo {
  name?: string;
  price?: number;
  currency?: string;
  /** Only ever an https URL. */
  image?: string;
}

export interface RequestRow {
  id: string;
  email: string;
  /** SKU as supplied by the customer; used for display and the stock API. */
  sku: string;
  /** Upper-cased SKU; used for all matching. */
  skuKey: string;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  /** Frozen once a send is attempted, so retries send an identical payload. */
  product: ProductInfo | null;
  verifiedAt: string | null;
  attempts: number;
  firstAttemptAt: string | null;
  nextAttemptAt: string | null;
  leaseUntil: string | null;
  /** An HTTP send was started and has no recorded outcome yet. Durable write-ahead marker. */
  sendInFlight: boolean;
  /** Sticky: some earlier attempt may have been accepted by the provider. */
  ambiguousSend: boolean;
  lastError: string | null;
  providerId: string | null;
  notifiedAt: string | null;
}

export type WebhookOutcome = 'pending' | 'in_stock' | 'out_of_stock' | 'skipped';

export interface WebhookEventRow {
  eventId: string;
  sku: string;
  skuKey: string;
  /** The sender's claim. Never used to make decisions. */
  quantity: number;
  receivedAt: string;
  processedAt: string | null;
  verifiedQuantity: number | null;
  outcome: WebhookOutcome;
}

export interface StockCheckClaim {
  skuKey: string;
  querySku: string;
  /** Bumped by every enqueue, so work arriving mid-check is not lost. */
  generation: number;
  attempts: number;
  claimedAt: string;
}

export interface RequestFilter {
  /** Case-insensitive substring of the email or SKU. */
  search?: string;
  status?: RequestStatus;
  limit: number;
  offset: number;
}

export type StockCheckOutcome =
  | { kind: 'skipped' }
  | { kind: 'out_of_stock'; quantity: number }
  | { kind: 'in_stock'; quantity: number; product: ProductInfo | null };

// ---------- persistence ----------

/** Synchronous by design: each method is one atomic SQLite transaction. */
export interface Store {
  /**
   * Inserts an open request, or returns the existing open one for (email, skuKey) with
   * created=false. On insert, atomically enqueues a stock check for the SKU, so an item that is
   * already in stock (or restocked moments ago) still produces an email. A repeat request within
   * 24h of the customer's last notification for the SKU, with no sell-out known since, waits for a
   * sell-out (or those 24h to pass), so repeating a POST cannot send a second email for the same
   * restock. A failed send that may have been delivered counts as a notification here.
   */
  createRequest(input: { email: string; sku: string }): { request: RequestRow; created: boolean };
  /** The open request for this customer and SKU, without creating one. */
  findOpenRequest(input: { email: string; sku: string }): RequestRow | null;
  getRequest(id: string): RequestRow | null;
  listRequests(filter: RequestFilter): { rows: RequestRow[]; total: number };
  statusCounts(): Record<RequestStatus, number>;

  /**
   * Inserts the event and enqueues its stock check atomically. inserted=false means the event_id
   * was already recorded, by a retry or a simultaneous delivery; nothing else changes. quantity=0
   * also records a sell-out, which can end suppression but can never queue an email by itself.
   */
  recordWebhookEvent(input: { eventId: string; sku: string; quantity: number }): {
    inserted: boolean;
  };
  listRecentWebhookEvents(limit: number): WebhookEventRow[];

  /** Upsert: sets due now, resets attempts, bumps generation. */
  enqueueStockCheck(sku: string): void;
  /** Ensures a check exists for each SKU with open requests. Leaves existing checks untouched. */
  enqueueChecksForOpenSkus(): number;
  /** Claims due, unleased checks under a lease. */
  claimDueStockChecks(limit: number): StockCheckClaim[];
  hasOpenRequests(skuKey: string): boolean;
  /** Each spelling among open requests: a stock API may treat SKU case as significant. */
  openSkuSpellings(skuKey: string): string[];
  /**
   * Atomically: if in stock, moves the SKU's open requests to queued unless suppressed, snapshotting
   * the product (only where attempts = 0, so a retried payload never changes), and does nothing if
   * a sell-out was recorded after the claim, since the read is then stale; if out of stock, records
   * a sell-out; marks pending events received up to claim.claimedAt with the outcome; deletes the
   * check unless its generation moved on, in which case it is released and due now. Returns the
   * number of requests queued.
   */
  completeStockCheck(claim: StockCheckClaim, outcome: StockCheckOutcome): { queued: number };
  /** Releases the claim and schedules the retry. */
  rescheduleStockCheck(claim: StockCheckClaim, error: string, dueAt: Date): void;

  /**
   * Claims due queued rows and rows in `sending` whose lease expired (a crash mid-send), setting
   * status=sending and the lease. If the row has send_in_flight=1, the previous holder died with
   * an unknown outcome: ambiguous_send becomes 1 and send_in_flight 0.
   */
  claimDueEmails(limit: number): RequestRow[];
  /**
   * Write-ahead, committed immediately before the HTTP call: send_in_flight=1, attempts+1,
   * first_attempt_at set if null. Returns false, and the caller must not send or touch the row, if
   * it is not in `sending` under a live lease or another send is already in flight.
   */
  beginSend(id: string): boolean;
  /** Terminal success. Requires status=sending, not the lease: acceptance is a fact. */
  markEmailSent(id: string, providerId: string | null): void;
  /**
   * Back to queued, send_in_flight=0. ambiguous=true sets ambiguous_send=1; ambiguous=false leaves
   * it alone, since a refusal proves nothing about earlier attempts.
   */
  markEmailRetry(
    id: string,
    input: { error: string; nextAttemptAt: Date; ambiguous: boolean },
  ): void;
  /** Terminal failure, send_in_flight=0. `ambiguous` as in markEmailRetry. */
  markEmailFailed(id: string, input: { error: string; ambiguous: boolean }): void;
  /** Records a fresh stock verification for a claimed row. */
  touchVerified(id: string): void;
  /**
   * Stock is gone before sending. Only legal when ambiguous_send=0 and send_in_flight=0: returns
   * the row to open with attempts, first_attempt_at and the product snapshot cleared, and enqueues
   * nothing. Returns false (changing nothing) if the row may already have been delivered.
   */
  holdForStock(id: string): boolean;
  /** Admin action: failed back to queued, attempts reset, ambiguous_send kept. False if not failed. */
  retryFailed(id: string): boolean;

  /**
   * Releases all leases at startup: this process is the only worker, so they are orphans. Emails in
   * `sending` return to queued, due now, with send_in_flight converted to ambiguous_send.
   */
  recoverAfterRestart(): { emails: number; checks: number };
  /** Deletes webhook events older than the date. Returns the number deleted. */
  purgeWebhookEventsBefore(date: Date): number;
  ping(): boolean;
  close(): void;
}

// ---------- external services ----------

export type StockResult =
  | { kind: 'ok'; quantity: number; available: boolean; product: ProductInfo | null }
  /** Timeouts, non-2xx other than 404, malformed bodies. Never to be read as "out of stock". */
  | { kind: 'error'; error: string };

export interface CatalogueItem extends ProductInfo {
  sku: string;
  available: boolean;
}

export interface StockClient {
  getStock(sku: string): Promise<StockResult>;
  /** Returns [] on any failure: the catalogue only powers form suggestions. */
  getCatalogue(): Promise<CatalogueItem[]>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type SendResult =
  | { kind: 'accepted'; providerId: string | null }
  /**
   * Worth retrying with the same idempotency key. ambiguous=true means the provider may have
   * accepted it (timeout, connection lost); false means an HTTP response refused it.
   */
  | { kind: 'retryable'; ambiguous: boolean; error: string; retryAfterMs?: number }
  /** The provider will never accept this message (e.g. 422). */
  | { kind: 'rejected'; error: string };

export interface EmailSender {
  send(message: EmailMessage, opts: { idempotencyKey: string }): Promise<SendResult>;
}

/** Stable per request and identical across restarts and retries. */
export const idempotencyKeyFor = (requestId: string): string => `back-in-stock/${requestId}`;

// ---------- workers ----------

export interface Worker {
  start(): void;
  /** Runs the loop now rather than at the next poll. Safe to call at any time. */
  wake(): void;
  /** Stops claiming and waits for in-flight work. */
  stop(): Promise<void>;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

// ---------- views (pure functions returning full HTML documents) ----------

export interface EmbedViewModel {
  /** Pre-selected SKU from ?sku=, already validated. */
  sku: string | null;
  /** Details for the pre-selected SKU, if the stock API answered in time. */
  product: ProductInfo | null;
  /** Suggestions; may be empty. The SKU field must stay a free-text input regardless. */
  catalogue: CatalogueItem[];
  nonce: string;
}

export interface LoginViewModel {
  error: string | null;
  nonce: string;
}

export interface AdminViewModel {
  rows: RequestRow[];
  total: number;
  counts: Record<RequestStatus, number>;
  search: string;
  status: RequestStatus | null;
  page: number;
  pageSize: number;
  events: WebhookEventRow[];
  nonce: string;
}
