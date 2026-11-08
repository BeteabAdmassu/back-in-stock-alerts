import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIMINGS,
  type EmailSender,
  idempotencyKeyFor,
  type Logger,
  type ProductInfo,
  type RequestRow,
  type Store,
  type Timings,
  type Worker,
} from '../src/contracts.ts';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';
import { renderBackInStockEmail } from '../src/email/template.ts';
import { createEmailClient } from '../src/integrations/email-client.ts';
import { createStockClient } from '../src/integrations/stock-client.ts';
import { createEmailWorker } from '../src/workers/email-worker.ts';

const SKU = 'MUG-1';
const PRODUCT: ProductInfo = { name: 'Stoneware Mug', price: 18, currency: 'GBP' };
const HTTP_TIMEOUT_MS = 300;
const TIMINGS: Timings = {
  ...DEFAULT_TIMINGS,
  pollIntervalMs: 5,
  leaseMs: 60_000,
  httpTimeoutMs: HTTP_TIMEOUT_MS,
};
const HOUR = 60 * 60 * 1000;

// ---------- shared scaffolding ----------

const tempRoot = mkdtempSync(join(tmpdir(), 'bis-email-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server: Server = createServer(handler);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

interface Captured {
  key: string;
  to: string;
  body: Buffer;
}

type ProviderStep =
  | { status: number; retryAfter?: string; name?: string }
  /** The provider records the email as accepted, then never answers. */
  | { acceptThenHang: true };

/** A provider that keeps to the Resend contract: a key that was accepted once is deduplicated. */
async function startProvider(steps: ProviderStep[] = []) {
  const requests: Captured[] = [];
  const accepted = new Map<string, string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const baseUrl = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const body = Buffer.concat(chunks);
      const key = String(req.headers['idempotency-key']);
      const to = (JSON.parse(body.toString('utf8')) as { to: string[] }).to[0] ?? '';
      requests.push({ key, to, body });
      const step = steps.shift() ?? { status: 200 };
      const accept = (): string => {
        const id = accepted.get(key) ?? `em_${accepted.size + 1}`;
        accepted.set(key, id);
        return id;
      };
      if ('acceptThenHang' in step) {
        accept();
        inFlight -= 1;
        return;
      }
      // Long enough for concurrent sends to overlap.
      setTimeout(() => {
        inFlight -= 1;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (step.retryAfter) headers['retry-after'] = step.retryAfter;
        res.writeHead(step.status, headers);
        res.end(
          JSON.stringify(
            step.status === 200 ? { id: accept() } : { name: step.name ?? 'provider_error' },
          ),
        );
      }, 2);
    });
  });
  return { baseUrl, requests, accepted, maxInFlight: () => maxInFlight };
}

/** A stock API whose answer the test changes; `status: 0` drops the connection. */
async function startStockApi(initial: { status: number; quantity: number }) {
  const state = { ...initial, calls: 0, onCall: () => {} };
  const baseUrl = await listen((req, res) => {
    state.calls += 1;
    state.onCall();
    if (state.status === 0) {
      req.socket.destroy();
      return;
    }
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...PRODUCT, quantity: state.quantity, in_stock: state.quantity > 0 }));
  });
  return { baseUrl, state };
}

function captureLogger() {
  const lines: string[] = [];
  const write = (obj: object, msg?: string): void => {
    lines.push(`${JSON.stringify(obj)} ${msg ?? ''}`);
  };
  const logger: Logger = { info: write, warn: write, error: write };
  return { logger, lines };
}

let fileCounter = 0;

/** A real Store on a SQLite file, with a clock the test moves. */
function setupStore() {
  fileCounter += 1;
  const path = join(tempRoot, `app-${fileCounter}.db`);
  const time = {
    ms: Date.parse('2026-01-01T00:00:00.000Z'),
  };
  const clock = (): Date => new Date(time.ms);
  const open = (): Store => {
    const store = createStore({ db: openDatabase(path), clock, leaseMs: TIMINGS.leaseMs });
    cleanups.push(() => store.close());
    return store;
  };
  return {
    open,
    store: open(),
    clock,
    advance: (by: number) => {
      time.ms += by;
    },
    now: () => time.ms,
  };
}

/** Takes customers to `queued` the way production does: through a verified stock check. */
function queue(store: Store, emails: string[], sku = SKU, product: ProductInfo = PRODUCT) {
  const rows = emails.map((email) => store.createRequest({ email, sku }).request);
  for (const claim of store.claimDueStockChecks(100)) {
    store.completeStockCheck(claim, { kind: 'in_stock', quantity: 5, product });
  }
  return rows;
}

function get(store: Store, id: string): RequestRow {
  const row = store.getRequest(id);
  assert.ok(row);
  return row;
}

interface WorkerSetup {
  store: Store;
  clock: () => Date;
  providerUrl?: string;
  stockUrl?: string;
  sender?: EmailSender;
  logger?: Logger;
  productUrlTemplate?: string | null;
  timings?: Timings;
}

function startWorker(setup: WorkerSetup): Worker {
  const { logger } = setup.logger ? { logger: setup.logger } : captureLogger();
  const sender =
    setup.sender ??
    createEmailClient({
      baseUrl: setup.providerUrl ?? 'http://127.0.0.1:1',
      apiKey: 'test-key',
      from: 'Shop <alerts@shop.example>',
      timeoutMs: HTTP_TIMEOUT_MS,
    });
  const stock = createStockClient({
    baseUrl: setup.stockUrl ?? 'http://127.0.0.1:1',
    apiKey: 'stock-key',
    timeoutMs: HTTP_TIMEOUT_MS,
    logger,
  });
  const worker = createEmailWorker({
    store: setup.store,
    stock,
    sender,
    clock: setup.clock,
    logger,
    timings: setup.timings ?? TIMINGS,
    productUrlTemplate: setup.productUrlTemplate === undefined ? null : setup.productUrlTemplate,
  });
  worker.start();
  cleanups.push(() => worker.stop());
  return worker;
}

const isOneOf = (store: Store, id: string, ...statuses: RequestRow['status'][]) =>
  statuses.includes(get(store, id).status);

/** Leaves the row with one recorded attempt, as a worker would after a failed send. */
function failOneAttempt(store: Store, clock: () => Date, ambiguous: boolean): void {
  const [row] = store.claimDueEmails(1);
  assert.ok(row);
  assert.equal(store.beginSend(row.id), true);
  store.markEmailRetry(row.id, { error: 'HTTP 500', nextAttemptAt: clock(), ambiguous });
}

// ---------- delivery ----------

describe('delivery', () => {
  test('success marks the row notified with the provider id', async () => {
    const { store, clock } = setupStore();
    const provider = await startProvider();
    const { logger, lines } = captureLogger();
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    startWorker({ store, clock, providerUrl: provider.baseUrl, logger });
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

    const after = get(store, row.id);
    assert.equal(after.providerId, 'em_1');
    assert.equal(after.attempts, 1);
    assert.equal(after.sendInFlight, false);
    assert.equal(after.ambiguousSend, false);
    assert.notEqual(after.notifiedAt, null);

    assert.equal(provider.requests.length, 1);
    const [request] = provider.requests;
    assert.equal(request?.key, idempotencyKeyFor(row.id));
    assert.equal(request?.to, 'a@example.com');
    const body = JSON.parse(request?.body.toString('utf8') ?? '{}') as Record<string, string>;
    assert.equal(body.subject, 'Back in stock: Stoneware Mug');
    assert.match(body.html ?? '', /It's back\./);
    assert.match(body.text ?? '', /£18\.00/);

    const log = lines.join('\n');
    assert.ok(log.includes(row.id), 'logs carry the request id');
    assert.match(log, /"outcome":"sent"/);
    assert.doesNotMatch(log, /a@example\.com/);
  });

  test('the product URL template fills in the encoded SKU', async () => {
    const { store, clock } = setupStore();
    const provider = await startProvider();
    const [row] = queue(store, ['a@example.com'], 'A B/C');
    assert.ok(row);

    startWorker({
      store,
      clock,
      providerUrl: provider.baseUrl,
      productUrlTemplate: 'https://shop.example/p/{sku}?from={sku}',
    });
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

    const body = JSON.parse(provider.requests[0]?.body.toString('utf8') ?? '{}') as {
      text: string;
    };
    assert.ok(body.text.includes('Shop now: https://shop.example/p/A%20B%2FC?from=A%20B%2FC'));
  });

  test('a 500 is retried after backoff with the same key and identical bytes', async () => {
    const { store, clock, advance, now } = setupStore();
    const provider = await startProvider([{ status: 500, name: 'application_error' }]);
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(
      () => isOneOf(store, row.id, 'queued') && provider.requests.length === 1,
      'retry',
    );

    const retrying = get(store, row.id);
    assert.equal(retrying.lastError, 'HTTP 500 application_error');
    assert.equal(retrying.ambiguousSend, false);
    assert.equal(retrying.sendInFlight, false);
    assert.equal(retrying.attempts, 1);
    // attempts=1 selects the first backoff step, 5s with 10% jitter.
    const delay = Date.parse(retrying.nextAttemptAt ?? '') - now();
    assert.ok(delay >= 4_500 && delay <= 5_500, `delay was ${delay}`);

    await settle();
    assert.equal(provider.requests.length, 1, 'no retry before it is due');

    advance(6_000);
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

    const [first, second] = provider.requests;
    assert.equal(provider.requests.length, 2);
    assert.equal(first?.key, idempotencyKeyFor(row.id));
    assert.equal(second?.key, first?.key);
    assert.ok(first && second && first.body.equals(second.body), 'identical body bytes');
    assert.equal(get(store, row.id).attempts, 2);
  });

  test('a later backoff step comes from the attempts including this one', async () => {
    const { store, clock, now } = setupStore();
    const provider = await startProvider([{ status: 500 }]);
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    failOneAttempt(store, clock, false);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(
      () => provider.requests.length === 1 && isOneOf(store, row.id, 'queued'),
      'retry',
    );

    // The second attempt failed, so this is step two: 15s with 10% jitter.
    const delay = Date.parse(get(store, row.id).nextAttemptAt ?? '') - now();
    assert.ok(delay >= 13_500 && delay <= 16_500, `delay was ${delay}`);
  });

  test('a 422 fails with no retry', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider([{ status: 422, name: 'validation_error' }]);
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'failed'), 'failed');

    const failed = get(store, row.id);
    assert.equal(failed.lastError, 'HTTP 422 validation_error');
    assert.equal(failed.ambiguousSend, false);
    assert.equal(failed.sendInFlight, false);

    advance(2 * HOUR);
    await settle();
    assert.equal(provider.requests.length, 1);
    assert.equal(get(store, row.id).status, 'failed');
  });

  test('429 Retry-After wins over a shorter backoff, and backoff over a shorter Retry-After', async () => {
    const { store, clock, advance, now } = setupStore();
    const provider = await startProvider([
      { status: 429, retryAfter: '120', name: 'rate_limit_exceeded' },
      { status: 429, retryAfter: '1' },
    ]);
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(() => provider.requests.length === 1 && isOneOf(store, row.id, 'queued'), '429');

    const limited = get(store, row.id);
    assert.equal(Date.parse(limited.nextAttemptAt ?? ''), now() + 120_000);
    assert.equal(limited.ambiguousSend, false);

    advance(60_000);
    await settle();
    assert.equal(provider.requests.length, 1, 'still inside Retry-After');

    advance(60_000);
    await waitFor(() => provider.requests.length === 2 && isOneOf(store, row.id, 'queued'), '429');
    const delay = Date.parse(get(store, row.id).nextAttemptAt ?? '') - now();
    assert.ok(delay >= 13_500, `Retry-After of 1s must not shorten the backoff, got ${delay}`);
  });

  test('an unexpected throw from send counts as ambiguous and leaks nothing', async () => {
    const { store, clock } = setupStore();
    const { logger, lines } = captureLogger();
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    const sender: EmailSender = {
      async send(message) {
        throw new Error(`could not reach ${message.to}`);
      },
    };

    startWorker({ store, clock, sender, logger });
    await waitFor(
      () => isOneOf(store, row.id, 'queued') && get(store, row.id).attempts === 1,
      'retry',
    );

    const after = get(store, row.id);
    assert.equal(after.ambiguousSend, true);
    assert.equal(after.sendInFlight, false);
    assert.doesNotMatch(after.lastError ?? '', /@example\.com/);
    assert.doesNotMatch(lines.join('\n'), /@example\.com/);
  });

  test('a render failure fails the row before any send or write-ahead', async () => {
    const { store, clock } = setupStore();
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    // encodeURIComponent throws on a lone surrogate, which SQLite would not round-trip.
    const hostile: Store = {
      ...store,
      claimDueEmails: (limit) => store.claimDueEmails(limit).map((r) => ({ ...r, sku: '\ud800' })),
    };
    let sends = 0;
    const sender: EmailSender = {
      async send() {
        sends += 1;
        return { kind: 'accepted', providerId: null };
      },
    };

    startWorker({ store: hostile, clock, sender, productUrlTemplate: 'https://x.example/{sku}' });
    await waitFor(() => isOneOf(store, row.id, 'failed'), 'failed');

    const failed = get(store, row.id);
    assert.equal(sends, 0);
    assert.equal(failed.attempts, 0, 'beginSend was never reached');
    assert.equal(failed.sendInFlight, false);
    assert.equal(failed.ambiguousSend, false);
  });
});

// ---------- once, not twice ----------

describe('ambiguous outcomes', () => {
  test('a timeout where the provider accepted is retried and deduplicated', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider([{ acceptThenHang: true }]);
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(
      () => provider.requests.length === 1 && isOneOf(store, row.id, 'queued'),
      'timeout',
    );

    const timedOut = get(store, row.id);
    assert.equal(timedOut.lastError, 'Request timed out');
    assert.equal(timedOut.ambiguousSend, true);
    assert.equal(timedOut.sendInFlight, false);

    advance(6_000);
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

    const [first, second] = provider.requests;
    assert.equal(provider.requests.length, 2);
    assert.equal(second?.key, first?.key);
    assert.ok(first && second && first.body.equals(second.body), 'identical body bytes');
    assert.equal(provider.accepted.size, 1, 'one logical email');

    const notified = get(store, row.id);
    assert.equal(notified.providerId, 'em_1', 'the id of the email the first attempt created');
    assert.equal(notified.ambiguousSend, true, 'the flag is sticky');
  });

  test('a refusal after a timeout leaves the ambiguous flag set', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider([{ acceptThenHang: true }, { status: 503 }]);
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(
      () => provider.requests.length === 1 && isOneOf(store, row.id, 'queued'),
      'timeout',
    );
    advance(6_000);
    await waitFor(
      () => provider.requests.length === 2 && isOneOf(store, row.id, 'queued'),
      'refusal',
    );

    assert.equal(get(store, row.id).lastError, 'HTTP 503 provider_error');
    assert.equal(get(store, row.id).ambiguousSend, true);
  });

  test('after a crash mid-send, a restart resends with the same key and payload', async () => {
    const { open, store, clock } = setupStore();
    const provider = await startProvider();
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    // The crashed process: it claimed, wrote ahead and reached the provider, but recorded nothing.
    const [claimed] = store.claimDueEmails(1);
    assert.ok(claimed);
    assert.equal(store.beginSend(claimed.id), true);
    assert.equal(get(store, row.id).sendInFlight, true);
    const client = createEmailClient({
      baseUrl: provider.baseUrl,
      apiKey: 'test-key',
      from: 'Shop <alerts@shop.example>',
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    const rendered = renderBackInStockEmail({
      sku: claimed.sku,
      product: claimed.product,
      productUrl: null,
    });
    await client.send(
      { to: claimed.email, ...rendered },
      { idempotencyKey: idempotencyKeyFor(claimed.id) },
    );
    store.close();

    // The restarted process.
    const reopened = open();
    assert.equal(reopened.recoverAfterRestart().emails, 1);
    const recovered = get(reopened, row.id);
    assert.equal(recovered.status, 'queued');
    assert.equal(recovered.sendInFlight, false);
    assert.equal(recovered.ambiguousSend, true);

    startWorker({ store: reopened, clock, providerUrl: provider.baseUrl });
    await waitFor(() => isOneOf(reopened, row.id, 'notified'), 'notified');

    const [first, second] = provider.requests;
    assert.equal(provider.requests.length, 2);
    assert.equal(first?.key, idempotencyKeyFor(row.id));
    assert.equal(second?.key, first?.key);
    assert.ok(first && second && first.body.equals(second.body), 'identical body bytes');
    assert.equal(provider.accepted.size, 1, 'one logical email');
    assert.equal(get(reopened, row.id).ambiguousSend, true);
  });

  test('two workers on one store never send one row twice', async () => {
    const { store, clock } = setupStore();
    const provider = await startProvider();
    const emails = Array.from({ length: 12 }, (_, i) => `c${i}@example.com`);
    const rows = queue(store, emails);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(() => rows.every((row) => isOneOf(store, row.id, 'notified')), 'all notified');

    assert.equal(provider.requests.length, 12, 'one HTTP send per row, with no dedupe needed');
    assert.equal(new Set(provider.requests.map((r) => r.key)).size, 12);
  });

  test('20 customers for one SKU each get exactly one email, at most 4 at once', async () => {
    const { store, clock } = setupStore();
    const provider = await startProvider();
    const emails = Array.from({ length: 20 }, (_, i) => `customer${i}@example.com`);
    const rows = queue(store, emails);
    assert.equal(rows.length, 20);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(() => rows.every((row) => isOneOf(store, row.id, 'notified')), 'all notified');

    const recipients = provider.requests.map((r) => r.to).sort();
    assert.deepEqual(recipients, [...emails].sort());
    assert.equal(new Set(provider.requests.map((r) => r.key)).size, 20);
    assert.ok(provider.maxInFlight() <= 4, `saw ${provider.maxInFlight()} sends at once`);
    assert.ok(provider.maxInFlight() > 1, 'sends do run concurrently');
  });
});

// ---------- stale restocks ----------

describe('stale restocks', () => {
  test('a fresh verification does not call the stock API', async () => {
    const { store, clock } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 0 });
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);

    startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');
    assert.equal(stockApi.state.calls, 0);
  });

  test('stale and sold out: back to open with no send', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 0 });
    const { logger, lines } = captureLogger();
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    advance(TIMINGS.stockFreshnessMs + 1);

    startWorker({
      store,
      clock,
      providerUrl: provider.baseUrl,
      stockUrl: stockApi.baseUrl,
      logger,
    });
    await waitFor(() => isOneOf(store, row.id, 'open'), 'open');

    const held = get(store, row.id);
    assert.equal(provider.requests.length, 0);
    assert.equal(stockApi.state.calls, 1);
    assert.equal(held.attempts, 0);
    assert.equal(held.product, null);
    assert.match(lines.join('\n'), /"outcome":"held_sold_out"/);
  });

  test('stale and sold out after a definite refusal: back to open with no send', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 0 });
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    failOneAttempt(store, clock, false);
    advance(TIMINGS.stockFreshnessMs + 1);

    startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'open'), 'open');
    assert.equal(provider.requests.length, 0);
  });

  test('stale and sold out with an ambiguous earlier attempt: still sends', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 0 });
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    failOneAttempt(store, clock, true);
    advance(TIMINGS.stockFreshnessMs + 1);

    startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

    assert.equal(stockApi.state.calls, 1);
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]?.key, idempotencyKeyFor(row.id));
  });

  test('stale and still available: refreshes the verification and sends', async () => {
    const { store, clock, advance, now } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 9 });
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    advance(TIMINGS.stockFreshnessMs + 1);

    startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

    assert.equal(stockApi.state.calls, 1);
    assert.equal(Date.parse(get(store, row.id).verifiedAt ?? ''), now());
  });

  test('exactly at the freshness limit the verification is still trusted', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 0 });
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    advance(TIMINGS.stockFreshnessMs);

    startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');
    assert.equal(stockApi.state.calls, 0);
  });

  for (const [label, status] of [
    ['answering 503', 503],
    ['dropping connections', 0],
  ] as const) {
    test(`stock API ${label} at re-verify: still sends`, async () => {
      const { store, clock, advance } = setupStore();
      const provider = await startProvider();
      const stockApi = await startStockApi({ status, quantity: 0 });
      const [row] = queue(store, ['a@example.com']);
      assert.ok(row);
      advance(TIMINGS.stockFreshnessMs + 1);

      startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
      await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

      assert.equal(stockApi.state.calls, 1);
      assert.equal(provider.requests.length, 1);
    });
  }

  test('a re-verify that outlasts the lease does not send', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 9 });
    const { logger, lines } = captureLogger();
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    advance(TIMINGS.stockFreshnessMs + 1);
    stockApi.state.onCall = () => advance(TIMINGS.leaseMs + 1);
    // Claims once, so what is seen is this holder's decision rather than a later claim's.
    let claims = 0;
    const claimOnce: Store = {
      ...store,
      claimDueEmails: (limit) => {
        claims += 1;
        return claims === 1 ? store.claimDueEmails(limit) : [];
      },
    };

    startWorker({
      store: claimOnce,
      clock,
      providerUrl: provider.baseUrl,
      stockUrl: stockApi.baseUrl,
      logger,
    });
    await waitFor(() => lines.join('\n').includes('"outcome":"lease_lost"'), 'lease lost');
    await settle();

    assert.equal(provider.requests.length, 0);
    assert.equal(get(store, row.id).attempts, 0);
    assert.equal(get(store, row.id).sendInFlight, false);
  });
});

// ---------- the retry window ----------

describe('retry window', () => {
  test('past the window the row fails with no send and no stock call', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 5 });
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    failOneAttempt(store, clock, true);
    advance(TIMINGS.emailGiveUpAfterMs);

    startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'failed'), 'failed');

    const failed = get(store, row.id);
    assert.equal(failed.lastError, 'Gave up: retry window exhausted');
    assert.equal(failed.ambiguousSend, true, 'the sticky flag stays');
    assert.equal(provider.requests.length, 0);
    assert.equal(stockApi.state.calls, 0);
  });

  test('without an earlier ambiguous attempt the flag stays clear', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    failOneAttempt(store, clock, false);
    advance(TIMINGS.emailGiveUpAfterMs);

    startWorker({ store, clock, providerUrl: provider.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'failed'), 'failed');
    assert.equal(get(store, row.id).ambiguousSend, false);
    assert.equal(provider.requests.length, 0);
  });

  test('just inside the window it still sends', async () => {
    const { store, clock, advance } = setupStore();
    const provider = await startProvider();
    const stockApi = await startStockApi({ status: 200, quantity: 5 });
    const [row] = queue(store, ['a@example.com']);
    assert.ok(row);
    failOneAttempt(store, clock, false);
    advance(TIMINGS.emailGiveUpAfterMs - 1);

    startWorker({ store, clock, providerUrl: provider.baseUrl, stockUrl: stockApi.baseUrl });
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');
    assert.equal(provider.requests.length, 1);
  });
});

// ---------- configuration ----------

describe('configuration', () => {
  test('the default timings fit a re-verify and a send inside the lease', () => {
    const { store, clock } = setupStore();
    assert.ok(DEFAULT_TIMINGS.leaseMs > 2 * DEFAULT_TIMINGS.httpTimeoutMs);
    startWorker({ store, clock, timings: DEFAULT_TIMINGS });
  });

  test('a lease too short for a re-verify and a send is refused', () => {
    const { store, clock } = setupStore();
    assert.throws(
      () =>
        startWorker({
          store,
          clock,
          timings: { ...DEFAULT_TIMINGS, leaseMs: 20_000, httpTimeoutMs: 10_000 },
        }),
      RangeError,
    );
  });
});

// ---------- against the real harness ----------

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe('real harness', () => {
  let child: ChildProcess;
  let harnessUrl = '';
  let dashboardPath = '';
  let apiKey = '';
  const dataDir = mkdtempSync(join(tmpdir(), 'bis-harness-'));

  const dashboard = async (): Promise<string> => {
    const response = await fetch(`${harnessUrl}${dashboardPath}`);
    return response.text();
  };

  before(async () => {
    const port = await freePort();
    harnessUrl = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
    delete env.INVITE_CODE;
    // harness/server.js is CommonJS but the root package.json says "type": "module", so Node refuses
    // to run it where it is. The unmodified file runs as .cjs from the temp directory.
    const script = join(dataDir, 'server.cjs');
    copyFileSync(fileURLToPath(new URL('../harness/server.js', import.meta.url)), script);
    child = spawn(process.execPath, [script], { env, stdio: 'ignore' });

    const deadline = Date.now() + 10_000;
    for (;;) {
      const up = await fetch(`${harnessUrl}/healthz`).then(
        (r) => r.ok,
        () => false,
      );
      if (up) break;
      assert.equal(child.exitCode, null, 'harness exited during startup');
      assert.ok(Date.now() < deadline, 'harness did not start');
      await settle(50);
    }

    const signup = await fetch(`${harnessUrl}/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=Email+worker+test',
      redirect: 'manual',
    });
    assert.equal(signup.status, 303);
    dashboardPath = signup.headers.get('location') ?? '';
    const key = /RESEND_API_KEY=(\S+)/.exec(await dashboard())?.[1];
    assert.ok(key, 'the dashboard shows the key');
    apiKey = key;
  });

  after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(dataDir, { recursive: true, force: true });
  });

  const harnessClient = (key: string): EmailSender =>
    createEmailClient({
      baseUrl: harnessUrl,
      apiKey: key,
      from: 'Shop <alerts@shop.example>',
      timeoutMs: 3_000,
    });

  test('an injected 500 is retried, and the inbox holds one accepted email', async () => {
    const { store, clock, advance } = setupStore();
    const inject = await fetch(`${harnessUrl}${dashboardPath}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'n=1',
      redirect: 'manual',
    });
    assert.equal(inject.status, 303);

    const [row] = queue(store, ['retry@example.com'], 'MUG-STN-SAGE', {
      name: 'Stoneware Mug, Sage',
      price: 18,
      currency: 'GBP',
    });
    assert.ok(row);

    startWorker({ store, clock, sender: harnessClient(apiKey) });
    await waitFor(
      () => isOneOf(store, row.id, 'queued') && get(store, row.id).attempts === 1,
      'retry',
    );
    assert.equal(get(store, row.id).lastError, 'HTTP 500 application_error');
    assert.equal(get(store, row.id).ambiguousSend, false);

    advance(6_000);
    await waitFor(() => isOneOf(store, row.id, 'notified'), 'notified');

    const page = await dashboard();
    assert.match(page, /failed \(injected 500\)/);
    const rowsForThisEmail = page.split('<tr>').filter((tr) => tr.includes('retry@example.com'));
    assert.equal(rowsForThisEmail.filter((tr) => tr.includes('>accepted<')).length, 1);

    const providerId = get(store, row.id).providerId;
    assert.ok(providerId);
    const view = await fetch(`${harnessUrl}${dashboardPath}/email/${providerId}`);
    assert.equal(view.status, 200);
    const rendered = await view.text();
    assert.match(rendered, /It's back\./);
    assert.match(rendered, /Stoneware Mug, Sage/);
    assert.match(rendered, /£18\.00/);
  });

  test('resending an accepted key is deduplicated by the harness, with the same id', async () => {
    const client = harnessClient(apiKey);
    const message = { to: 'dedupe@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };
    const opts = { idempotencyKey: 'back-in-stock/harness-dedupe' };

    const first = await client.send(message, opts);
    const second = await client.send(message, opts);
    assert.equal(first.kind, 'accepted');
    assert.deepEqual(second, first);

    const rows = (await dashboard())
      .split('<tr>')
      .filter((tr) => tr.includes('dedupe@example.com'));
    assert.equal(rows.filter((tr) => tr.includes('>accepted<')).length, 1);
    assert.equal(rows.filter((tr) => tr.includes('deduped (idempotency key)')).length, 1);
  });

  test('the harness classifies through the client: bad key retryable, bad payload rejected', async () => {
    const opts = { idempotencyKey: 'back-in-stock/harness-classify' };
    const message = { to: 'x@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };
    assert.deepEqual(await harnessClient('wrong-key').send(message, opts), {
      kind: 'retryable',
      ambiguous: false,
      error: 'HTTP 401 missing_api_key',
    });
    assert.deepEqual(await harnessClient(apiKey).send({ ...message, subject: '' }, opts), {
      kind: 'rejected',
      error: 'HTTP 422 validation_error',
    });
  });
});
