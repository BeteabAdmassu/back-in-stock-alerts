import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type Clock,
  type ProductInfo,
  REQUEST_STATUSES,
  type RequestFilter,
  type RequestRow,
  type RequestStatus,
  type StockCheckClaim,
  type StockCheckOutcome,
  type Store,
  type WebhookEventRow,
  type WebhookOutcome,
} from '../contracts.ts';
import { transaction } from './database.ts';

// Stale-worker policy.
//
// Stock checks have an exact guard: a claim carries claimedAt, and claimedAt + leaseMs is the
// lease_until that claim wrote, so a claim that was re-taken or released no longer matches and its
// completion or reschedule changes nothing. Whoever holds the check now does that work instead.
//
// Email methods take only an id, so they cannot tell two holders of a row apart:
// - markEmailSent requires status='sending' but not a live lease. "The provider accepted it" is a
//   fact about the world rather than a claim to own the row, and dropping it could end in `failed`
//   for a delivered email. A concurrent holder then finds the row notified and is a no-op.
// - The others also require a live lease, so a worker whose lease lapsed is a no-op unless the row
//   was re-claimed. That remaining window needs a worker to outlive leaseMs (which must exceed
//   httpTimeoutMs) and is bounded by the idempotency key: a stale write can at worst requeue the
//   row, and the next send is deduplicated. It cannot erase doubt: re-claiming a row with a send in
//   flight has already set ambiguous_send=1, and nothing ever clears that flag.
// - beginSend also refuses while send_in_flight=1, so a stalled holder that wakes up cannot start a
//   send over the row's new holder. Two sends can therefore overlap only after a re-claim recorded
//   the first as ambiguous, so refusing one can never leave a clean row with the other in the air.

interface RawRequest {
  id: string;
  email: string;
  sku: string;
  sku_key: string;
  status: RequestStatus;
  created_at: string;
  updated_at: string;
  product_json: string | null;
  verified_at: string | null;
  attempts: number;
  first_attempt_at: string | null;
  next_attempt_at: string | null;
  lease_until: string | null;
  send_in_flight: number;
  ambiguous_send: number;
  last_error: string | null;
  provider_id: string | null;
  notified_at: string | null;
}

interface RawEvent {
  event_id: string;
  sku: string;
  sku_key: string;
  quantity: number;
  received_at: string;
  processed_at: string | null;
  verified_quantity: number | null;
  outcome: WebhookOutcome;
}

interface RawCheck {
  sku_key: string;
  query_sku: string;
  generation: number;
  attempts: number;
  lease_until: string | null;
}

function toRequest(raw: RawRequest): RequestRow {
  return {
    id: raw.id,
    email: raw.email,
    sku: raw.sku,
    skuKey: raw.sku_key,
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    product: raw.product_json === null ? null : (JSON.parse(raw.product_json) as ProductInfo),
    verifiedAt: raw.verified_at,
    attempts: raw.attempts,
    firstAttemptAt: raw.first_attempt_at,
    nextAttemptAt: raw.next_attempt_at,
    leaseUntil: raw.lease_until,
    sendInFlight: raw.send_in_flight === 1,
    ambiguousSend: raw.ambiguous_send === 1,
    lastError: raw.last_error,
    providerId: raw.provider_id,
    notifiedAt: raw.notified_at,
  };
}

function toEvent(raw: RawEvent): WebhookEventRow {
  return {
    eventId: raw.event_id,
    sku: raw.sku,
    skuKey: raw.sku_key,
    quantity: raw.quantity,
    receivedAt: raw.received_at,
    processedAt: raw.processed_at,
    verifiedQuantity: raw.verified_quantity,
    outcome: raw.outcome,
  };
}

/** How long a repeat request can wait for a sell-out before it is emailed anyway. */
const REPEAT_SUPPRESSION_MS = 24 * 60 * 60 * 1000;

const skuKeyOf = (sku: string): string => sku.trim().toUpperCase();
const normaliseEmail = (email: string): string => email.trim().toLowerCase();
const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');

export function createStore(deps: { db: DatabaseSync; clock: Clock; leaseMs: number }): Store {
  const { db, clock, leaseMs } = deps;

  const nowIso = (): string => clock().toISOString();
  const leaseFrom = (nowMs: number): string => new Date(nowMs + leaseMs).toISOString();

  const selectRequest = db.prepare('SELECT * FROM requests WHERE id = ?');
  const insertRequest = db.prepare(`
    INSERT INTO requests (id, email, sku, sku_key, status, created_at, updated_at, suppress_until)
    VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
    ON CONFLICT (email, sku_key) WHERE status IN ('open', 'queued', 'sending') DO NOTHING
    RETURNING *
  `);
  const selectOpenRequest = db.prepare(`
    SELECT * FROM requests
    WHERE email = ? AND sku_key = ? AND status IN ('open', 'queued', 'sending')
  `);
  const selectLastNotified = db.prepare(`
    SELECT MAX(notified_at) AS at FROM requests
    WHERE email = ? AND sku_key = ? AND status = 'notified'
  `);
  const selectOpenSpellings = db.prepare(
    "SELECT DISTINCT sku FROM requests WHERE sku_key = ? AND status = 'open' ORDER BY sku",
  );
  const clearSuppression = db.prepare(
    'UPDATE requests SET suppress_until = NULL WHERE sku_key = ? AND suppress_until IS NOT NULL',
  );
  const upsertCheck = db.prepare(`
    INSERT INTO stock_checks (sku_key, query_sku, generation, due_at, attempts)
    VALUES (?, ?, 1, ?, 0)
    ON CONFLICT (sku_key) DO UPDATE SET
      query_sku = excluded.query_sku,
      generation = generation + 1,
      due_at = excluded.due_at,
      attempts = 0,
      last_error = NULL
  `);
  const insertEvent = db.prepare(`
    INSERT INTO webhook_events (event_id, sku, sku_key, quantity, received_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (event_id) DO NOTHING
  `);
  const selectRecentEvents = db.prepare(
    'SELECT * FROM webhook_events ORDER BY received_at DESC, rowid DESC LIMIT ?',
  );
  const insertMissingChecks = db.prepare(`
    INSERT INTO stock_checks (sku_key, query_sku, generation, due_at, attempts)
    SELECT sku_key, sku, 1, ?, 0
    FROM (SELECT sku_key, sku, MAX(created_at) FROM requests WHERE status = 'open' GROUP BY sku_key)
    WHERE true
    ON CONFLICT (sku_key) DO NOTHING
  `);
  const claimChecks = db.prepare(`
    UPDATE stock_checks SET lease_until = ?
    WHERE sku_key IN (
      SELECT sku_key FROM stock_checks
      WHERE due_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY due_at, sku_key
      LIMIT ?
    )
    RETURNING sku_key, query_sku, generation, attempts, lease_until
  `);
  const selectOpenExists = db.prepare(
    "SELECT 1 FROM requests WHERE sku_key = ? AND status = 'open' LIMIT 1",
  );
  const selectHeldCheck = db.prepare(
    'SELECT generation FROM stock_checks WHERE sku_key = ? AND lease_until = ?',
  );
  const promoteOpen = db.prepare(`
    UPDATE requests SET
      status = 'queued',
      next_attempt_at = ?,
      verified_at = ?,
      updated_at = ?,
      suppress_until = NULL,
      product_json = CASE WHEN attempts = 0 THEN ? ELSE product_json END
    WHERE sku_key = ? AND status = 'open' AND (suppress_until IS NULL OR suppress_until <= ?)
  `);
  const settleEvents = db.prepare(`
    UPDATE webhook_events SET outcome = ?, processed_at = ?, verified_quantity = ?
    WHERE sku_key = ? AND outcome = 'pending' AND received_at <= ?
  `);
  const deleteCheck = db.prepare('DELETE FROM stock_checks WHERE sku_key = ?');
  const releaseCheckNow = db.prepare(
    'UPDATE stock_checks SET lease_until = NULL, due_at = ? WHERE sku_key = ?',
  );
  // If an enqueue arrived during the failed attempt it has already reset attempts and asked to run
  // now; its reset stands, so that work is not delayed by the backoff of an older failure.
  const rescheduleCheck = db.prepare(`
    UPDATE stock_checks SET
      lease_until = NULL,
      last_error = ?,
      due_at = CASE WHEN generation = ? THEN ? ELSE ? END,
      attempts = CASE WHEN generation = ? THEN attempts + 1 ELSE attempts END
    WHERE sku_key = ? AND lease_until = ?
  `);
  const selectDueEmails = db.prepare(`
    SELECT id FROM requests
    WHERE (status = 'queued' AND next_attempt_at <= ?)
       OR (status = 'sending' AND lease_until <= ?)
    ORDER BY CASE status WHEN 'queued' THEN next_attempt_at ELSE lease_until END, created_at, rowid
    LIMIT ?
  `);
  const claimEmail = db.prepare(`
    UPDATE requests SET
      status = 'sending',
      lease_until = ?,
      next_attempt_at = NULL,
      ambiguous_send = MAX(ambiguous_send, send_in_flight),
      send_in_flight = 0,
      updated_at = ?
    WHERE id = ?
    RETURNING *
  `);
  const startSend = db.prepare(`
    UPDATE requests SET
      send_in_flight = 1,
      attempts = attempts + 1,
      first_attempt_at = COALESCE(first_attempt_at, ?),
      updated_at = ?
    WHERE id = ? AND status = 'sending' AND lease_until > ? AND send_in_flight = 0
  `);
  const markSent = db.prepare(`
    UPDATE requests SET
      status = 'notified',
      notified_at = ?,
      provider_id = ?,
      lease_until = NULL,
      send_in_flight = 0,
      next_attempt_at = NULL,
      last_error = NULL,
      updated_at = ?
    WHERE id = ? AND status = 'sending'
  `);
  const markRetry = db.prepare(`
    UPDATE requests SET
      status = 'queued',
      next_attempt_at = ?,
      last_error = ?,
      lease_until = NULL,
      send_in_flight = 0,
      ambiguous_send = MAX(ambiguous_send, ?),
      updated_at = ?
    WHERE id = ? AND status = 'sending' AND lease_until > ?
  `);
  const markFailed = db.prepare(`
    UPDATE requests SET
      status = 'failed',
      last_error = ?,
      lease_until = NULL,
      send_in_flight = 0,
      ambiguous_send = MAX(ambiguous_send, ?),
      next_attempt_at = NULL,
      updated_at = ?
    WHERE id = ? AND status = 'sending' AND lease_until > ?
  `);
  const markVerified = db.prepare(`
    UPDATE requests SET verified_at = ?, updated_at = ?
    WHERE id = ? AND status = 'sending' AND lease_until > ?
  `);
  const hold = db.prepare(`
    UPDATE requests SET
      status = 'open',
      attempts = 0,
      first_attempt_at = NULL,
      product_json = NULL,
      verified_at = NULL,
      next_attempt_at = NULL,
      lease_until = NULL,
      ambiguous_send = 0,
      last_error = NULL,
      updated_at = ?
    WHERE id = ? AND status = 'sending' AND lease_until > ?
      AND ambiguous_send = 0 AND send_in_flight = 0
  `);
  // OR IGNORE: if another open request now exists for this customer and SKU, the partial unique
  // index makes this a no-op rather than an error. The product snapshot stays, so the same key
  // keeps sending the same payload.
  const retryRequest = db.prepare(`
    UPDATE OR IGNORE requests SET
      status = 'queued',
      attempts = 0,
      first_attempt_at = NULL,
      next_attempt_at = ?,
      lease_until = NULL,
      send_in_flight = 0,
      last_error = NULL,
      updated_at = ?
    WHERE id = ? AND status = 'failed'
  `);
  const recoverEmails = db.prepare(`
    UPDATE requests SET
      status = 'queued',
      next_attempt_at = ?,
      lease_until = NULL,
      ambiguous_send = MAX(ambiguous_send, send_in_flight),
      send_in_flight = 0,
      updated_at = ?
    WHERE status = 'sending'
  `);
  const recoverChecks = db.prepare(
    'UPDATE stock_checks SET lease_until = NULL WHERE lease_until IS NOT NULL',
  );
  const purgeEvents = db.prepare('DELETE FROM webhook_events WHERE received_at < ?');
  const countByStatus = db.prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status');
  const selectOne = db.prepare('SELECT 1');

  function enqueueCheck(sku: string, now: string): void {
    const trimmed = sku.trim();
    upsertCheck.run(skuKeyOf(trimmed), trimmed, now);
  }

  return {
    createRequest({ email, sku }) {
      const normalEmail = normaliseEmail(email);
      const trimmedSku = sku.trim();
      const skuKey = skuKeyOf(trimmedSku);
      return transaction(db, () => {
        const now = nowIso();
        const last = selectLastNotified.get(normalEmail, skuKey) as { at: string | null };
        const suppressUntil = last.at
          ? new Date(Date.parse(last.at) + REPEAT_SUPPRESSION_MS).toISOString()
          : null;
        const inserted = insertRequest.get(
          randomUUID(),
          normalEmail,
          trimmedSku,
          skuKey,
          now,
          now,
          suppressUntil !== null && suppressUntil > now ? suppressUntil : null,
        );
        if (inserted) {
          enqueueCheck(trimmedSku, now);
          return { request: toRequest(inserted as unknown as RawRequest), created: true };
        }
        const existing = selectOpenRequest.get(normalEmail, skuKey);
        if (!existing) throw new Error('Open request conflict without an open request');
        return { request: toRequest(existing as unknown as RawRequest), created: false };
      });
    },

    getRequest(id) {
      const raw = selectRequest.get(id);
      return raw ? toRequest(raw as unknown as RawRequest) : null;
    },

    listRequests(filter: RequestFilter) {
      const conditions: string[] = [];
      const params: string[] = [];
      const search = filter.search?.trim();
      if (search) {
        const pattern = `%${escapeLike(search)}%`;
        conditions.push("(email LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
      }
      if (filter.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }
      // Only these constant fragments are concatenated; all values are bound.
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM requests ${where}`).get(...params) as {
        n: number;
      };
      const rows = db
        .prepare(
          `SELECT * FROM requests ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, Math.max(0, filter.limit), Math.max(0, filter.offset));
      return { rows: (rows as unknown as RawRequest[]).map(toRequest), total: total.n };
    },

    statusCounts() {
      const counts = Object.fromEntries(REQUEST_STATUSES.map((status) => [status, 0])) as Record<
        RequestStatus,
        number
      >;
      for (const row of countByStatus.all() as unknown as { status: RequestStatus; n: number }[]) {
        counts[row.status] = row.n;
      }
      return counts;
    },

    recordWebhookEvent({ eventId, sku, quantity }) {
      const trimmedSku = sku.trim();
      return transaction(db, () => {
        const now = nowIso();
        const { changes } = insertEvent.run(
          eventId,
          trimmedSku,
          skuKeyOf(trimmedSku),
          quantity,
          now,
        );
        if (Number(changes) === 0) return { inserted: false };
        enqueueCheck(trimmedSku, now);
        return { inserted: true };
      });
    },

    listRecentWebhookEvents(limit) {
      const rows = selectRecentEvents.all(Math.max(0, limit));
      return (rows as unknown as RawEvent[]).map(toEvent);
    },

    enqueueStockCheck(sku) {
      enqueueCheck(sku, nowIso());
    },

    enqueueChecksForOpenSkus() {
      return Number(insertMissingChecks.run(nowIso()).changes);
    },

    claimDueStockChecks(limit) {
      if (limit <= 0) return [];
      const now = clock();
      const claimedAt = now.toISOString();
      const rows = claimChecks.all(leaseFrom(now.getTime()), claimedAt, claimedAt, limit);
      return (rows as unknown as RawCheck[]).map((row) => ({
        skuKey: row.sku_key,
        querySku: row.query_sku,
        generation: row.generation,
        attempts: row.attempts,
        claimedAt,
      }));
    },

    hasOpenRequests(skuKey) {
      return selectOpenExists.get(skuKeyOf(skuKey)) !== undefined;
    },

    openSkuSpellings(skuKey) {
      const rows = selectOpenSpellings.all(skuKeyOf(skuKey)) as unknown as { sku: string }[];
      return rows.map((row) => row.sku);
    },

    completeStockCheck(claim: StockCheckClaim, outcome: StockCheckOutcome) {
      const heldLease = leaseFrom(Date.parse(claim.claimedAt));
      return transaction(db, () => {
        const held = selectHeldCheck.get(claim.skuKey, heldLease) as
          | { generation: number }
          | undefined;
        if (!held) return { queued: 0 };

        const now = nowIso();
        let queued = 0;
        if (outcome.kind === 'in_stock') {
          const productJson = outcome.product === null ? null : JSON.stringify(outcome.product);
          queued = Number(promoteOpen.run(now, now, now, productJson, claim.skuKey, now).changes);
        } else if (outcome.kind === 'out_of_stock') {
          clearSuppression.run(claim.skuKey);
        }
        const verifiedQuantity = outcome.kind === 'skipped' ? null : outcome.quantity;
        settleEvents.run(outcome.kind, now, verifiedQuantity, claim.skuKey, claim.claimedAt);

        if (held.generation === claim.generation) deleteCheck.run(claim.skuKey);
        else releaseCheckNow.run(now, claim.skuKey);
        return { queued };
      });
    },

    rescheduleStockCheck(claim, error, dueAt) {
      rescheduleCheck.run(
        error,
        claim.generation,
        dueAt.toISOString(),
        nowIso(),
        claim.generation,
        claim.skuKey,
        leaseFrom(Date.parse(claim.claimedAt)),
      );
    },

    claimDueEmails(limit) {
      if (limit <= 0) return [];
      return transaction(db, () => {
        const now = clock();
        const nowText = now.toISOString();
        const leaseUntil = leaseFrom(now.getTime());
        const due = selectDueEmails.all(nowText, nowText, limit) as unknown as { id: string }[];
        return due.map(({ id }) => {
          const row = claimEmail.get(leaseUntil, nowText, id);
          return toRequest(row as unknown as RawRequest);
        });
      });
    },

    beginSend(id) {
      const now = nowIso();
      return Number(startSend.run(now, now, id, now).changes) > 0;
    },

    markEmailSent(id, providerId) {
      const now = nowIso();
      markSent.run(now, providerId, now, id);
    },

    markEmailRetry(id, input) {
      const now = nowIso();
      markRetry.run(
        input.nextAttemptAt.toISOString(),
        input.error,
        input.ambiguous ? 1 : 0,
        now,
        id,
        now,
      );
    },

    markEmailFailed(id, input) {
      const now = nowIso();
      markFailed.run(input.error, input.ambiguous ? 1 : 0, now, id, now);
    },

    touchVerified(id) {
      const now = nowIso();
      markVerified.run(now, now, id, now);
    },

    holdForStock(id) {
      const now = nowIso();
      return Number(hold.run(now, id, now).changes) > 0;
    },

    retryFailed(id) {
      const now = nowIso();
      return Number(retryRequest.run(now, now, id).changes) > 0;
    },

    recoverAfterRestart() {
      return transaction(db, () => {
        const now = nowIso();
        return {
          emails: Number(recoverEmails.run(now, now).changes),
          checks: Number(recoverChecks.run().changes),
        };
      });
    },

    purgeWebhookEventsBefore(date) {
      return Number(purgeEvents.run(date.toISOString()).changes);
    },

    ping() {
      try {
        return selectOne.get() !== undefined;
      } catch {
        return false;
      }
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}
