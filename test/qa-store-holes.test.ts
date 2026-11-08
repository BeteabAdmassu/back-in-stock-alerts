// Independent QA: state-machine interleavings, driving the real Store on a real SQLite file.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';

const LEASE = 60_000;

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-store-'));
  const file = join(dir, 'a.db');
  const clockState = { now: Date.parse('2026-01-01T00:00:00.000Z') };
  const clock = () => new Date(clockState.now);
  let db = openDatabase(file);
  let store = createStore({ db, clock, leaseMs: LEASE });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    clockState,
    get store() {
      return store;
    },
    /** A hard restart: the connection goes away with no cleanup and the file is reopened. */
    restart() {
      store.close();
      db = openDatabase(file);
      store = createStore({ db, clock, leaseMs: LEASE });
      return store.recoverAfterRestart();
    },
    tick(ms: number) {
      clockState.now += ms;
    },
  };
}

function toSending(c: ReturnType<typeof setup>, email: string, sku = 'S-1') {
  const { request } = c.store.createRequest({ email, sku });
  for (const claim of c.store.claimDueStockChecks(10)) {
    c.store.completeStockCheck(claim, { kind: 'in_stock', quantity: 3, product: { name: 'P' } });
  }
  c.tick(1);
  const [row] = c.store.claimDueEmails(1);
  assert.equal(row?.id, request.id);
  return request.id;
}

test('QA-H1 crash after beginSend: restart gives ambiguous, same id, and hold is refused', (t) => {
  const c = setup(t);
  const id = toSending(c, 'a@example.com');
  assert.equal(c.store.beginSend(id), true);
  assert.deepEqual(c.restart(), { emails: 1, checks: 0 });
  const row = c.store.getRequest(id);
  assert.equal(row?.status, 'queued');
  assert.equal(row?.sendInFlight, false);
  assert.equal(row?.ambiguousSend, true);
  c.tick(1);
  c.store.claimDueEmails(1);
  assert.equal(c.store.holdForStock(id), false);
});

test('QA-H2 crash before beginSend: not ambiguous, and hold is allowed', (t) => {
  const c = setup(t);
  const id = toSending(c, 'a@example.com');
  c.restart();
  assert.equal(c.store.getRequest(id)?.ambiguousSend, false);
  c.tick(1);
  c.store.claimDueEmails(1);
  assert.equal(c.store.holdForStock(id), true);
  assert.equal(c.store.getRequest(id)?.status, 'open');
});

test('QA-H3 expired lease with a send in flight: the stale holder cannot start or hold', (t) => {
  const c = setup(t);
  const id = toSending(c, 'a@example.com');
  assert.equal(c.store.beginSend(id), true);
  c.tick(LEASE + 1);
  const [again] = c.store.claimDueEmails(1);
  assert.equal(again?.id, id);
  assert.equal(again?.ambiguousSend, true);
  assert.equal(c.store.holdForStock(id), false);
  // The new holder sends; a second begin (the stale holder waking) is refused while it is in flight.
  assert.equal(c.store.beginSend(id), true);
  assert.equal(c.store.beginSend(id), false);
});

test('QA-H4 stale accept after a re-claim still lands as notified, and only once', (t) => {
  const c = setup(t);
  const id = toSending(c, 'a@example.com');
  c.store.beginSend(id);
  c.tick(LEASE + 1);
  c.store.claimDueEmails(1);
  c.store.markEmailSent(id, 'prov');
  assert.equal(c.store.getRequest(id)?.status, 'notified');
  c.store.markEmailRetry(id, {
    error: 'late',
    nextAttemptAt: new Date(c.clockState.now),
    ambiguous: true,
  });
  c.store.markEmailFailed(id, { error: 'late', ambiguous: true });
  assert.equal(c.store.retryFailed(id), false);
  assert.equal(c.store.holdForStock(id), false);
  const row = c.store.getRequest(id);
  assert.equal(row?.status, 'notified');
  assert.equal(row?.lastError, null);
});

test('QA-H6 admin retry keeps "may have been delivered" knowledge', (t) => {
  const c = setup(t);
  const id = toSending(c, 'a@example.com');
  c.store.beginSend(id);
  c.store.markEmailFailed(id, { error: 'gave up', ambiguous: true });
  assert.equal(c.store.getRequest(id)?.ambiguousSend, true);
  assert.equal(c.store.retryFailed(id), true);
  // Now sold out before the retry. If the flag was wiped, the row looks clean and goes back to
  // open, and a later restock can email a customer who may have the first email.
  c.tick(1);
  c.store.claimDueEmails(1);
  assert.equal(
    c.store.holdForStock(id),
    false,
    'hold succeeded on a row whose first send may have been delivered',
  );
});

test('QA-H7 retry with a newer open request is a clean no-op', (t) => {
  const c = setup(t);
  const id = toSending(c, 'a@example.com');
  c.store.beginSend(id);
  c.store.markEmailFailed(id, { error: 'x', ambiguous: false });
  const { request: newer, created } = c.store.createRequest({ email: 'a@example.com', sku: 'S-1' });
  assert.equal(created, true);
  assert.equal(c.store.retryFailed(id), false);
  assert.equal(c.store.getRequest(id)?.status, 'failed');
  assert.equal(c.store.getRequest(newer.id)?.status, 'open');
});

test('QA-H8 generation: a request created during a sold-out read is re-checked', (t) => {
  const c = setup(t);
  c.store.createRequest({ email: 'a@example.com', sku: 'G-1' });
  const [claim] = c.store.claimDueStockChecks(1);
  assert.ok(claim);
  c.tick(5);
  c.store.createRequest({ email: 'b@example.com', sku: 'G-1' });
  c.store.completeStockCheck(claim, { kind: 'out_of_stock', quantity: 0 });
  const [next] = c.store.claimDueStockChecks(1);
  assert.equal(next?.skuKey, 'G-1');
});

test('QA-H9 reschedule of a stale claim cannot clobber the new holder', (t) => {
  const c = setup(t);
  c.store.createRequest({ email: 'a@example.com', sku: 'G-2' });
  const [a] = c.store.claimDueStockChecks(1);
  assert.ok(a);
  c.tick(LEASE + 1);
  const [b] = c.store.claimDueStockChecks(1);
  assert.ok(b);
  c.store.rescheduleStockCheck(a, 'late', new Date(c.clockState.now + 999_999));
  assert.deepEqual(
    c.store.completeStockCheck(a, { kind: 'in_stock', quantity: 1, product: null }),
    {
      queued: 0,
    },
  );
  assert.deepEqual(
    c.store.completeStockCheck(b, { kind: 'in_stock', quantity: 1, product: null }),
    {
      queued: 1,
    },
  );
});

test('QA-H10 a check in far-future backoff does not outlive a restart or a new event', (t) => {
  const c = setup(t);
  c.store.createRequest({ email: 'a@example.com', sku: 'G-3' });
  const [a] = c.store.claimDueStockChecks(1);
  assert.ok(a);
  c.store.rescheduleStockCheck(a, 'down', new Date(c.clockState.now + 300_000));
  assert.equal(c.store.claimDueStockChecks(1).length, 0);
  c.store.recordWebhookEvent({ eventId: 'e', sku: 'g-3', quantity: 1 });
  assert.equal(c.store.claimDueStockChecks(1).length, 1);
});

test('QA-H11 held rows are picked up by the reconciler without an enqueue', (t) => {
  const c = setup(t);
  const id = toSending(c, 'a@example.com');
  assert.equal(c.store.holdForStock(id), true);
  assert.equal(c.store.enqueueChecksForOpenSkus(), 1);
});

test('QA-H12 no row is unreachable: every status with a due time is claimable after restart', (t) => {
  const c = setup(t);
  toSending(c, 'a@example.com', 'R-1');
  const b = toSending(c, 'b@example.com', 'R-2');
  c.store.beginSend(b);
  c.store.createRequest({ email: 'c@example.com', sku: 'R-3' });
  c.restart();
  c.tick(1);
  assert.equal(c.store.claimDueEmails(10).length, 2);
  assert.equal(c.store.claimDueStockChecks(10).length, 1);
});
