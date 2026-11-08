import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { RequestRow, Store } from '../src/contracts.ts';
import { openDatabase, transaction } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/schema.ts';
import { createStore } from '../src/db/store.ts';

const LEASE_MS = 60_000;
const START = Date.parse('2026-01-01T00:00:00.000Z');

const tempRoot = mkdtempSync(join(tmpdir(), 'bis-store-'));
let fileCounter = 0;
const tempDbPath = (): string => {
  fileCounter += 1;
  return join(tempRoot, `nested-${fileCounter}`, 'dir', 'app.db');
};
after(() => rmSync(tempRoot, { recursive: true, force: true }));

function testClock() {
  let ms = START;
  return {
    clock: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
    iso: () => new Date(ms).toISOString(),
  };
}

function setup(path = ':memory:') {
  const db = openDatabase(path);
  const time = testClock();
  const store = createStore({ db, clock: time.clock, leaseMs: LEASE_MS });
  return { db, store, ...time };
}

/** Takes a request to `queued` the way production does, through a verified stock check. */
function promote(store: Store, sku: string, product: { name: string } | null = null): void {
  store.enqueueStockCheck(sku);
  for (const claim of store.claimDueStockChecks(100)) {
    store.completeStockCheck(claim, { kind: 'in_stock', quantity: 5, product });
  }
}

function claimOne(store: Store): RequestRow {
  const [row] = store.claimDueEmails(1);
  assert.ok(row, 'expected a claimable email');
  return row;
}

function queuedRequest(store: Store, email = 'a@example.com', sku = 'SKU-1'): RequestRow {
  const { request } = store.createRequest({ email, sku });
  promote(store, sku);
  return request;
}

const mustGet = (store: Store, id: string): RequestRow => {
  const row = store.getRequest(id);
  assert.ok(row);
  return row;
};

const checkRow = (db: DatabaseSync, skuKey: string) =>
  db.prepare('SELECT * FROM stock_checks WHERE sku_key = ?').get(skuKey) as
    | {
        generation: number;
        due_at: string;
        attempts: number;
        lease_until: string | null;
        query_sku: string;
        last_error: string | null;
      }
    | undefined;

const countChecks = (db: DatabaseSync): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM stock_checks').get() as { n: number }).n;

// ---------- database ----------

test('openDatabase creates parent directories, sets pragmas and migrates once', () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const pragma = (name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
  assert.equal(pragma('journal_mode'), 'wal');
  assert.equal(pragma('synchronous'), 2);
  assert.equal(pragma('foreign_keys'), 1);
  assert.equal(pragma('busy_timeout'), 5000);
  assert.equal(pragma('user_version'), MIGRATIONS.length);
  db.close();

  const reopened = openDatabase(path);
  assert.equal(Object.values(reopened.prepare('PRAGMA user_version').get() ?? {})[0], 1);
  reopened.close();
});

test('openDatabase refuses a database newer than this build', () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  db.close();
  assert.throws(() => openDatabase(path), /newer than this build/);
});

test('transaction commits on return and rolls back on throw', () => {
  const { db, store } = setup();
  assert.throws(() =>
    transaction(db, () => {
      db.prepare(
        `INSERT INTO stock_checks (sku_key, query_sku, due_at) VALUES ('X', 'x', 'now')`,
      ).run();
      throw new Error('boom');
    }),
  );
  assert.equal(countChecks(db), 0);
  transaction(db, () => {
    db.prepare(
      `INSERT INTO stock_checks (sku_key, query_sku, due_at) VALUES ('X', 'x', 'now')`,
    ).run();
  });
  assert.equal(countChecks(db), 1);
  store.close();
});

// ---------- requests ----------

test('a duplicate open request returns the existing row and does not re-enqueue', () => {
  const { db, store } = setup();
  const first = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(first.created, true);
  assert.equal(first.request.status, 'open');
  const generation = checkRow(db, 'SKU-1')?.generation;

  const second = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(second.created, false);
  assert.equal(second.request.id, first.request.id);
  assert.equal(checkRow(db, 'SKU-1')?.generation, generation);
  assert.equal(store.listRequests({ limit: 10, offset: 0 }).total, 1);
});

test('email case and SKU case fold at the store, keeping the customer spelling of the SKU', () => {
  const { db, store } = setup();
  const first = store.createRequest({ email: '  Alice@Example.COM ', sku: ' sku-mix ' });
  assert.equal(first.request.email, 'alice@example.com');
  assert.equal(first.request.sku, 'sku-mix');
  assert.equal(first.request.skuKey, 'SKU-MIX');
  assert.equal(checkRow(db, 'SKU-MIX')?.query_sku, 'sku-mix');

  const second = store.createRequest({ email: 'ALICE@example.com', sku: 'SKU-mix' });
  assert.equal(second.created, false);
  assert.equal(second.request.id, first.request.id);
});

test('a new request is allowed once the previous one is notified or failed', () => {
  const { store } = setup();
  const first = queuedRequest(store);
  const claimed = claimOne(store);
  assert.equal(claimed.id, first.id);
  store.markEmailSent(claimed.id, 'p1');

  const afterNotified = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(afterNotified.created, true);
  assert.notEqual(afterNotified.request.id, first.id);

  promote(store, 'SKU-1');
  store.markEmailFailed(claimOne(store).id, { error: 'rejected', ambiguous: false });
  const afterFailed = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(afterFailed.created, true);
});

test('requests stay duplicate-free while queued and sending', () => {
  const { store } = setup();
  const first = queuedRequest(store);
  assert.equal(store.createRequest({ email: 'a@example.com', sku: 'sku-1' }).created, false);
  claimOne(store);
  const again = store.createRequest({ email: 'a@example.com', sku: 'sku-1' });
  assert.equal(again.created, false);
  assert.equal(again.request.id, first.id);
  assert.equal(again.request.status, 'sending');
});

test('duplicates across two connections to the same file yield one row', () => {
  const path = tempDbPath();
  const a = setup(path);
  const b = setup(path);
  const results = [];
  for (let i = 0; i < 20; i += 1) {
    const store = i % 2 === 0 ? a.store : b.store;
    results.push(store.createRequest({ email: 'A@example.com', sku: i % 2 === 0 ? 'x' : 'X' }));
  }
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.request.id)).size, 1);
  assert.equal(a.store.listRequests({ limit: 100, offset: 0 }).total, 1);
  a.store.close();
  b.store.close();
});

test('createRequest returns an open row committed by another connection', () => {
  const path = tempDbPath();
  const a = setup(path);
  const b = setup(path);
  transaction(a.db, () => {
    a.db
      .prepare(
        `INSERT INTO requests (id, email, sku, sku_key, created_at, updated_at)
         VALUES ('other', 'a@example.com', 'X', 'X', 'now', 'now')`,
      )
      .run();
  });
  const { created, request } = b.store.createRequest({ email: 'a@example.com', sku: 'x' });
  assert.equal(created, false);
  assert.equal(request.id, 'other');
  a.store.close();
  b.store.close();
});

test('a new request enqueues a check that survives into a promotion', () => {
  const { store } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  const [claim] = store.claimDueStockChecks(10);
  assert.ok(claim);
  assert.equal(claim.querySku, 'SKU-1');
  const { queued } = store.completeStockCheck(claim, {
    kind: 'in_stock',
    quantity: 3,
    product: { name: 'Shirt', price: 10 },
  });
  assert.equal(queued, 1);
  const row = mustGet(store, request.id);
  assert.equal(row.status, 'queued');
  assert.deepEqual(row.product, { name: 'Shirt', price: 10 });
  assert.equal(row.verifiedAt, row.nextAttemptAt);
});

// ---------- webhooks ----------

test('a duplicate webhook event inserts and enqueues once, including across connections', () => {
  const path = tempDbPath();
  const a = setup(path);
  const b = setup(path);
  const input = { eventId: 'evt-1', sku: 'sku-9', quantity: 2 };
  assert.deepEqual(a.store.recordWebhookEvent(input), { inserted: true });
  assert.deepEqual(b.store.recordWebhookEvent(input), { inserted: false });
  assert.equal(checkRow(a.db, 'SKU-9')?.generation, 1);
  const events = a.store.listRecentWebhookEvents(10);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, 'pending');
  assert.equal(events[0]?.quantity, 2);
  a.store.close();
  b.store.close();
});

test('a failed enqueue rolls back the event, so a retried webhook is not lost', () => {
  const { db, store } = setup();
  db.exec(`
    CREATE TRIGGER fail_check BEFORE INSERT ON stock_checks
    BEGIN SELECT RAISE(ABORT, 'injected'); END;
  `);
  const input = { eventId: 'evt-1', sku: 'S', quantity: 1 };
  assert.throws(() => store.recordWebhookEvent(input), /injected/);
  assert.equal(store.listRecentWebhookEvents(10).length, 0);
  db.exec('DROP TRIGGER fail_check');
  assert.deepEqual(store.recordWebhookEvent(input), { inserted: true });
  assert.equal(countChecks(db), 1);
});

test('completing marks only events received up to claimedAt, with the verified quantity', () => {
  const { store, advance } = setup();
  store.recordWebhookEvent({ eventId: 'before', sku: 'S', quantity: 0 });
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  advance(1000);
  store.recordWebhookEvent({ eventId: 'during', sku: 'S', quantity: 0 });
  store.recordWebhookEvent({ eventId: 'other-sku', sku: 'T', quantity: 0 });
  store.completeStockCheck(claim, { kind: 'in_stock', quantity: 7, product: null });

  const byId = new Map(store.listRecentWebhookEvents(10).map((e) => [e.eventId, e]));
  assert.equal(byId.get('before')?.outcome, 'in_stock');
  assert.equal(byId.get('before')?.verifiedQuantity, 7);
  assert.ok(byId.get('before')?.processedAt);
  assert.equal(byId.get('during')?.outcome, 'pending');
  assert.equal(byId.get('other-sku')?.outcome, 'pending');
});

test('out_of_stock queues nothing; skipped records a null quantity', () => {
  const { db, store } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'S' });
  store.recordWebhookEvent({ eventId: 'e1', sku: 'S', quantity: 9 });
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  const result = store.completeStockCheck(claim, { kind: 'out_of_stock', quantity: 0 });
  assert.equal(result.queued, 0);
  assert.equal(mustGet(store, request.id).status, 'open');
  assert.equal(store.listRecentWebhookEvents(1)[0]?.outcome, 'out_of_stock');
  assert.equal(store.listRecentWebhookEvents(1)[0]?.verifiedQuantity, 0);
  assert.equal(countChecks(db), 0);

  store.recordWebhookEvent({ eventId: 'e2', sku: 'U', quantity: 9 });
  const [skip] = store.claimDueStockChecks(1);
  assert.ok(skip);
  store.completeStockCheck(skip, { kind: 'skipped' });
  const skipped = store.listRecentWebhookEvents(10).find((e) => e.eventId === 'e2');
  assert.equal(skipped?.outcome, 'skipped');
  assert.equal(skipped?.verifiedQuantity, null);
  assert.ok(skipped?.processedAt);
});

// ---------- stock checks ----------

test('enqueue upserts: due now, attempts reset, generation bumped, latest spelling kept', () => {
  const { db, store, advance, iso } = setup();
  store.enqueueStockCheck('sku-a');
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  store.rescheduleStockCheck(claim, 'down', new Date(START + 999_999));
  assert.equal(checkRow(db, 'SKU-A')?.attempts, 1);
  advance(10);
  store.enqueueStockCheck('SKU-a');
  const row = checkRow(db, 'SKU-A');
  assert.equal(row?.generation, 2);
  assert.equal(row?.attempts, 0);
  assert.equal(row?.due_at, iso());
  assert.equal(row?.query_sku, 'SKU-a');
  assert.equal(row?.last_error, null);
});

test('a generation bump mid-check keeps the lease exclusive and keeps the check', () => {
  const { db, store } = setup();
  store.enqueueStockCheck('S');
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);

  store.recordWebhookEvent({ eventId: 'mid', sku: 'S', quantity: 1 });
  assert.notEqual(checkRow(db, 'S')?.lease_until, null, 'enqueue must not clear a live lease');
  assert.deepEqual(store.claimDueStockChecks(1), [], 'the lease stays exclusive');

  store.completeStockCheck(claim, { kind: 'out_of_stock', quantity: 0 });
  assert.equal(checkRow(db, 'S')?.lease_until, null);
  const [again] = store.claimDueStockChecks(1);
  assert.ok(again, 'the check must be due again');
  assert.equal(again.generation, 2);
  store.completeStockCheck(again, { kind: 'out_of_stock', quantity: 0 });
  assert.equal(checkRow(db, 'S'), undefined);
});

test('stock check claims are exclusive and honour limit; an expired lease is re-claimed', () => {
  const { store, advance } = setup();
  store.enqueueStockCheck('A');
  store.enqueueStockCheck('B');
  store.enqueueStockCheck('C');
  assert.equal(store.claimDueStockChecks(0).length, 0);
  assert.equal(store.claimDueStockChecks(2).length, 2);
  assert.equal(store.claimDueStockChecks(5).length, 1);
  assert.equal(store.claimDueStockChecks(5).length, 0);
  advance(LEASE_MS - 1);
  assert.equal(store.claimDueStockChecks(5).length, 0);
  advance(1);
  assert.equal(store.claimDueStockChecks(5).length, 3);
});

test('rescheduling releases the claim, delays it and counts the attempt', () => {
  const { db, store, advance } = setup();
  store.enqueueStockCheck('S');
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  assert.equal(claim.attempts, 0);
  store.rescheduleStockCheck(claim, 'timeout', new Date(START + 5000));
  const row = checkRow(db, 'S');
  assert.equal(row?.lease_until, null);
  assert.equal(row?.last_error, 'timeout');
  assert.equal(store.claimDueStockChecks(1).length, 0);
  advance(5000);
  assert.equal(store.claimDueStockChecks(1)[0]?.attempts, 1);
});

test('rescheduling after a mid-check enqueue does not delay the new work', () => {
  const { db, store, iso } = setup();
  store.enqueueStockCheck('S');
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  store.enqueueStockCheck('S');
  store.rescheduleStockCheck(claim, 'timeout', new Date(START + 999_999));
  const row = checkRow(db, 'S');
  assert.equal(row?.due_at, iso());
  assert.equal(row?.attempts, 0);
  assert.equal(store.claimDueStockChecks(1).length, 1);
});

test('a stale check claim cannot complete, reschedule or delete the current holder', () => {
  const { db, store, advance } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'S' });
  const [stale] = store.claimDueStockChecks(1);
  assert.ok(stale);
  advance(LEASE_MS);
  const [current] = store.claimDueStockChecks(1);
  assert.ok(current);
  assert.equal(current.generation, stale.generation);

  const result = store.completeStockCheck(stale, { kind: 'in_stock', quantity: 1, product: null });
  assert.equal(result.queued, 0);
  store.rescheduleStockCheck(stale, 'late', new Date(START + 999_999_999));
  assert.equal(mustGet(store, request.id).status, 'open');
  assert.equal(checkRow(db, 'S')?.last_error, null);

  assert.equal(
    store.completeStockCheck(current, { kind: 'in_stock', quantity: 1, product: null }).queued,
    1,
  );
  assert.equal(countChecks(db), 0);
});

test('promotion queues every open request for the SKU and no others', () => {
  const { db, store } = setup();
  const count = 500;
  for (let i = 0; i < count; i += 1) {
    store.createRequest({ email: `c${i}@example.com`, sku: i % 2 === 0 ? 'many' : 'MANY' });
  }
  const other = store.createRequest({ email: 'other@example.com', sku: 'OTHER' });
  const [check] = store.claimDueStockChecks(1);
  assert.ok(check);
  const first = check.skuKey === 'MANY' ? check : store.claimDueStockChecks(1)[0];
  assert.ok(first);
  const { queued } = store.completeStockCheck(first, {
    kind: 'in_stock',
    quantity: 1,
    product: { name: 'Thing' },
  });
  assert.equal(queued, count);
  const counts = store.statusCounts();
  assert.equal(counts.queued, count);
  assert.equal(counts.open, 1);
  assert.equal(mustGet(store, other.request.id).status, 'open');
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM requests WHERE product_json IS NULL AND sku_key='MANY'")
        .get() as { n: number }
    ).n,
    0,
  );
});

test('the product snapshot is frozen once attempts > 0', () => {
  const { db, store } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'S' });
  promote(store, 'S', { name: 'original' });
  assert.deepEqual(mustGet(store, request.id).product, { name: 'original' });

  // The state a future transition could leave behind: open, but already attempted. The store must
  // not overwrite that row's payload, because the idempotency key is bound to it.
  db.prepare("UPDATE requests SET status = 'open', attempts = 2 WHERE id = ?").run(request.id);
  promote(store, 'S', { name: 'changed' });
  const row = mustGet(store, request.id);
  assert.equal(row.status, 'queued');
  assert.deepEqual(row.product, { name: 'original' });
});

test('enqueueChecksForOpenSkus adds missing checks only and leaves existing ones alone', () => {
  const { db, store } = setup();
  queuedRequest(store, 'd@example.com', 'D');
  const first = store.createRequest({ email: 'a@example.com', sku: 'A' });
  store.createRequest({ email: 'b@example.com', sku: 'B' });
  store.createRequest({ email: 'c@example.com', sku: 'C' });
  for (const claim of store.claimDueStockChecks(10)) {
    if (claim.skuKey !== 'B') store.completeStockCheck(claim, { kind: 'skipped' });
  }
  assert.equal(countChecks(db), 1);
  const leased = checkRow(db, 'B');
  assert.equal(store.hasOpenRequests('A'), true);
  assert.equal(store.hasOpenRequests('D'), false);

  assert.equal(store.enqueueChecksForOpenSkus(), 2); // A and C; D is queued, B already has a check.
  assert.deepEqual(checkRow(db, 'B'), leased);
  assert.equal(checkRow(db, 'A')?.query_sku, first.request.sku);
  assert.equal(store.enqueueChecksForOpenSkus(), 0);
});

// ---------- emails ----------

test('claiming sets only status and lease: no attempt is counted until beginSend', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  const [row] = store.claimDueEmails(5);
  assert.ok(row);
  assert.equal(row.id, request.id);
  assert.equal(row.status, 'sending');
  assert.equal(row.leaseUntil, new Date(START + LEASE_MS).toISOString());
  assert.equal(row.attempts, 0);
  assert.equal(row.firstAttemptAt, null);
  assert.equal(row.sendInFlight, false);
  assert.equal(row.ambiguousSend, false);
  assert.deepEqual(store.claimDueEmails(5), [], 'the claim is exclusive');
});

test('beginSend writes ahead and keeps the first attempt time across attempts', () => {
  const { store, advance, iso } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  assert.equal(store.beginSend(request.id), true);
  let row = mustGet(store, request.id);
  assert.equal(row.sendInFlight, true);
  assert.equal(row.ambiguousSend, false);
  assert.equal(row.attempts, 1);
  const firstAttemptAt = iso();
  assert.equal(row.firstAttemptAt, firstAttemptAt);

  store.markEmailRetry(request.id, {
    error: 'HTTP 503',
    nextAttemptAt: new Date(START),
    ambiguous: false,
  });
  advance(1000);
  claimOne(store);
  assert.equal(store.beginSend(request.id), true);
  row = mustGet(store, request.id);
  assert.equal(row.attempts, 2);
  assert.equal(row.firstAttemptAt, firstAttemptAt);
});

test('beginSend returns false, changing nothing, with an expired lease', () => {
  const { store, advance } = setup();
  const request = queuedRequest(store);
  const claimed = claimOne(store);
  advance(LEASE_MS);
  assert.equal(store.beginSend(request.id), false);
  assert.deepEqual(mustGet(store, request.id), claimed);
});

test('beginSend returns false unless the row is claimed', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  assert.equal(store.beginSend('missing'), false);
  assert.equal(store.beginSend(request.id), false, 'queued, not claimed');
  assert.equal(mustGet(store, request.id).attempts, 0);
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailSent(request.id, 'p');
  assert.equal(store.beginSend(request.id), false, 'already notified');
});

test('beginSend refuses a second send while one is in flight under the lease', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  assert.equal(store.beginSend(request.id), true);
  assert.equal(store.beginSend(request.id), false);
  assert.equal(mustGet(store, request.id).attempts, 1);
});

test('two connections cannot claim the same email', () => {
  const path = tempDbPath();
  const a = setup(path);
  const b = setup(path);
  for (let i = 0; i < 10; i += 1) queuedRequest(a.store, `c${i}@example.com`, 'S');
  const ids: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const store = i % 2 === 0 ? a.store : b.store;
    ids.push(...store.claimDueEmails(1).map((row) => row.id));
  }
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
  assert.deepEqual(a.store.claimDueEmails(5), []);
  a.store.close();
  b.store.close();
});

test('claims respect limit, oldest due first, and skip rows not yet due', () => {
  const { store, advance } = setup();
  const first = queuedRequest(store, 'first@example.com', 'S1');
  advance(1000);
  const second = queuedRequest(store, 'second@example.com', 'S2');
  advance(1000);
  const third = queuedRequest(store, 'third@example.com', 'S3');

  assert.deepEqual(store.claimDueEmails(0), []);
  const batch = store.claimDueEmails(2);
  assert.deepEqual(
    batch.map((row) => row.id),
    [first.id, second.id],
  );
  store.markEmailRetry(first.id, {
    error: 'x',
    nextAttemptAt: new Date(START + 100_000),
    ambiguous: false,
  });
  assert.deepEqual(
    store.claimDueEmails(5).map((row) => row.id),
    [third.id],
  );
});

test('an expired lease without beginSend is re-claimed clean, since nothing was sent', () => {
  const { store, advance } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  advance(LEASE_MS - 1);
  assert.deepEqual(store.claimDueEmails(1), []);
  advance(1);
  const reclaimed = claimOne(store);
  assert.equal(reclaimed.id, request.id);
  assert.equal(reclaimed.ambiguousSend, false);
  assert.equal(reclaimed.attempts, 0);
  assert.equal(store.holdForStock(request.id), true);
});

test('an expired lease after beginSend is re-claimed ambiguous, keeping the attempt record', () => {
  const { store, advance, iso } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  const firstAttemptAt = iso();
  store.beginSend(request.id);
  advance(LEASE_MS);
  const reclaimed = claimOne(store);
  assert.equal(reclaimed.id, request.id);
  assert.equal(reclaimed.sendInFlight, false);
  assert.equal(reclaimed.ambiguousSend, true);
  assert.equal(reclaimed.attempts, 1);
  assert.equal(reclaimed.firstAttemptAt, firstAttemptAt);
  assert.equal(store.holdForStock(request.id), false, 'the crashed attempt may have been sent');
});

test('markEmailSent is terminal and idempotent, and clears the in-flight marker', () => {
  const { store, advance, iso } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  advance(5);
  const sentAt = iso();
  store.markEmailSent(request.id, 'provider-1');
  advance(5);
  store.markEmailSent(request.id, 'provider-2');
  const row = mustGet(store, request.id);
  assert.equal(row.status, 'notified');
  assert.equal(row.providerId, 'provider-1');
  assert.equal(row.notifiedAt, sentAt);
  assert.equal(row.leaseUntil, null);
  assert.equal(row.sendInFlight, false);
  assert.deepEqual(store.claimDueEmails(1), []);
});

test('markEmailSent records a late acceptance after the lease lapsed', () => {
  const { store, advance } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  advance(LEASE_MS + 1);
  store.markEmailSent(request.id, 'provider-1');
  const row = mustGet(store, request.id);
  assert.equal(row.status, 'notified');
  assert.equal(row.sendInFlight, false);
});

test('an out-of-state markEmailSent changes nothing and never breaks the CHECK', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  store.markEmailSent(request.id, 'p');
  assert.equal(mustGet(store, request.id).status, 'queued');
  assert.equal(mustGet(store, request.id).notifiedAt, null);
});

test('markEmailRetry requeues and records whether the attempt may have been delivered', () => {
  const { store, advance } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  const next = new Date(START + 5000);
  store.markEmailRetry(request.id, { error: 'HTTP 503', nextAttemptAt: next, ambiguous: false });
  let row = mustGet(store, request.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.sendInFlight, false);
  assert.equal(row.ambiguousSend, false);
  assert.equal(row.leaseUntil, null);
  assert.equal(row.nextAttemptAt, next.toISOString());
  assert.equal(row.lastError, 'HTTP 503');
  assert.deepEqual(store.claimDueEmails(1), [], 'not due until nextAttemptAt');

  advance(5000);
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailRetry(request.id, {
    error: 'timeout',
    nextAttemptAt: new Date(START + 5001),
    ambiguous: true,
  });
  row = mustGet(store, request.id);
  assert.equal(row.ambiguousSend, true);
  assert.equal(row.sendInFlight, false);
  assert.equal(row.attempts, 2);
});

test('a timeout then a 503 stays ambiguous: a refusal says nothing about earlier attempts', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailRetry(request.id, {
    error: 'timeout',
    nextAttemptAt: new Date(START),
    ambiguous: true,
  });
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailRetry(request.id, {
    error: 'HTTP 503',
    nextAttemptAt: new Date(START),
    ambiguous: false,
  });
  assert.equal(mustGet(store, request.id).ambiguousSend, true);

  claimOne(store);
  assert.equal(store.holdForStock(request.id), false);
});

test('markEmailFailed is terminal and applies the same flag rule', () => {
  const { store } = setup();
  const refused = queuedRequest(store, 'refused@example.com', 'S1');
  claimOne(store);
  store.beginSend(refused.id);
  store.markEmailFailed(refused.id, { error: 'HTTP 422', ambiguous: false });
  let row = mustGet(store, refused.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.lastError, 'HTTP 422');
  assert.equal(row.leaseUntil, null);
  assert.equal(row.notifiedAt, null);
  assert.equal(row.sendInFlight, false);
  assert.equal(row.ambiguousSend, false);

  const unknown = queuedRequest(store, 'unknown@example.com', 'S2');
  claimOne(store);
  store.beginSend(unknown.id);
  store.markEmailFailed(unknown.id, { error: 'gave up after timeout', ambiguous: true });
  row = mustGet(store, unknown.id);
  assert.equal(row.ambiguousSend, true);
  assert.equal(row.sendInFlight, false);

  const sticky = queuedRequest(store, 'sticky@example.com', 'S3');
  claimOne(store);
  store.beginSend(sticky.id);
  store.markEmailRetry(sticky.id, {
    error: 'timeout',
    nextAttemptAt: new Date(START),
    ambiguous: true,
  });
  claimOne(store);
  store.beginSend(sticky.id);
  store.markEmailFailed(sticky.id, { error: 'HTTP 422', ambiguous: false });
  assert.equal(mustGet(store, sticky.id).ambiguousSend, true);

  assert.deepEqual(store.claimDueEmails(1), []);
});

test('a worker whose lease lapsed is a no-op for retry, failed, touch and hold', () => {
  const { store, advance } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  const before = mustGet(store, request.id);
  advance(LEASE_MS);
  store.markEmailRetry(request.id, {
    error: 'late',
    nextAttemptAt: new Date(START),
    ambiguous: false,
  });
  store.markEmailFailed(request.id, { error: 'late', ambiguous: false });
  store.touchVerified(request.id);
  assert.equal(store.holdForStock(request.id), false);
  assert.deepEqual(mustGet(store, request.id), before);
});

test('a stale worker cannot erase doubt or touch a row that has finished', () => {
  const { store, advance } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  advance(LEASE_MS);
  claimOne(store);
  store.beginSend(request.id);

  // The first holder's refusal arrives during the second claim. Ids cannot tell the holders apart,
  // so it may requeue, but the doubt about its own attempt was recorded when the row was re-claimed.
  store.markEmailRetry(request.id, {
    error: 'stale',
    nextAttemptAt: new Date(START),
    ambiguous: false,
  });
  assert.equal(mustGet(store, request.id).ambiguousSend, true);

  advance(1);
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailSent(request.id, 'p');
  const notified = mustGet(store, request.id);
  store.markEmailRetry(request.id, {
    error: 'stale',
    nextAttemptAt: new Date(START),
    ambiguous: true,
  });
  store.markEmailFailed(request.id, { error: 'stale', ambiguous: true });
  store.touchVerified(request.id);
  assert.equal(store.holdForStock(request.id), false);
  assert.deepEqual(mustGet(store, request.id), notified);
});

test('a stalled holder cannot start a send over the new holder of a row', () => {
  const { store, advance } = setup();
  const request = queuedRequest(store);
  claimOne(store); // The first holder stalls before beginSend.
  advance(LEASE_MS);
  claimOne(store);
  assert.equal(store.beginSend(request.id), true);
  assert.equal(store.beginSend(request.id), false, 'the first holder wakes up and must not send');
  assert.equal(mustGet(store, request.id).attempts, 1);
});

test('touchVerified refreshes a claimed row only', () => {
  const { store, advance, iso } = setup();
  const request = queuedRequest(store);
  const before = mustGet(store, request.id).verifiedAt;
  advance(1000);
  store.touchVerified(request.id);
  assert.equal(mustGet(store, request.id).verifiedAt, before, 'not claimed yet');
  claimOne(store);
  advance(1000);
  store.touchVerified(request.id);
  assert.equal(mustGet(store, request.id).verifiedAt, iso());
});

test('holdForStock returns a clean claim to open and clears the attempt', () => {
  const { db, store } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  const checksBefore = countChecks(db);

  assert.equal(store.holdForStock(request.id), true);
  const row = mustGet(store, request.id);
  assert.equal(row.status, 'open');
  assert.equal(row.attempts, 0);
  assert.equal(row.firstAttemptAt, null);
  assert.equal(row.product, null);
  assert.equal(row.ambiguousSend, false);
  assert.equal(row.sendInFlight, false);
  assert.equal(row.leaseUntil, null);
  assert.equal(row.nextAttemptAt, null);
  assert.equal(countChecks(db), checksBefore, 'hold enqueues nothing');
  assert.equal(store.holdForStock(request.id), false, 'no longer sending');
});

test('holdForStock succeeds for a clean row after a prior definite refusal', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailRetry(request.id, {
    error: 'HTTP 500',
    nextAttemptAt: new Date(START),
    ambiguous: false,
  });
  const claimed = claimOne(store);
  assert.equal(claimed.attempts, 1);
  assert.equal(store.holdForStock(request.id), true);
  const row = mustGet(store, request.id);
  assert.equal(row.status, 'open');
  assert.equal(row.attempts, 0);
  assert.equal(row.firstAttemptAt, null);
});

test('holdForStock refuses, changing nothing, while a send is in flight', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  const before = mustGet(store, request.id);
  assert.equal(store.holdForStock(request.id), false);
  assert.deepEqual(mustGet(store, request.id), before);
});

test('holdForStock refuses, changing nothing, after an ambiguous attempt', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailRetry(request.id, {
    error: 'timeout',
    nextAttemptAt: new Date(START),
    ambiguous: true,
  });
  const claimed = claimOne(store);
  assert.equal(store.holdForStock(request.id), false);
  assert.deepEqual(mustGet(store, request.id), claimed);
});

test('holdForStock decides from the database alone, whichever store instance asks', () => {
  const path = tempDbPath();
  const a = setup(path);
  const b = setup(path);
  const clean = queuedRequest(a.store, 'clean@example.com', 'S1');
  claimOne(a.store);
  assert.equal(b.store.holdForStock(clean.id), true);

  const inFlight = queuedRequest(a.store, 'flight@example.com', 'S2');
  claimOne(a.store);
  a.store.beginSend(inFlight.id);
  assert.equal(b.store.holdForStock(inFlight.id), false);
  a.store.close();
  b.store.close();
});

test('a request held for stock can be promoted again with a fresh product', () => {
  const { store } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'S' });
  promote(store, 'S', { name: 'old' });
  claimOne(store);
  store.holdForStock(request.id);
  promote(store, 'S', { name: 'new' });
  const row = mustGet(store, request.id);
  assert.equal(row.status, 'queued');
  assert.deepEqual(row.product, { name: 'new' });
});

// ---------- retryFailed ----------

test('retryFailed requeues a failed row with the same id and a kept snapshot', () => {
  const { store, iso } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'S' });
  promote(store, 'S', { name: 'snapshot' });
  claimOne(store);
  store.beginSend(request.id);
  store.markEmailFailed(request.id, { error: 'gave up', ambiguous: true });

  assert.equal(store.retryFailed(request.id), true);
  const row = mustGet(store, request.id);
  assert.equal(row.id, request.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0);
  assert.equal(row.firstAttemptAt, null);
  assert.equal(row.ambiguousSend, false);
  assert.equal(row.sendInFlight, false);
  assert.equal(row.nextAttemptAt, iso());
  assert.deepEqual(row.product, { name: 'snapshot' });
  assert.equal(claimOne(store).id, request.id);
});

test('retryFailed returns false unless the row is failed', () => {
  const { store } = setup();
  const request = queuedRequest(store);
  assert.equal(store.retryFailed(request.id), false);
  assert.equal(store.retryFailed('missing'), false);
  claimOne(store);
  store.markEmailSent(request.id, 'p');
  assert.equal(store.retryFailed(request.id), false);
  assert.equal(mustGet(store, request.id).status, 'notified');
});

test('retryFailed returns false rather than throwing if a newer open request exists', () => {
  const { store } = setup();
  const failed = queuedRequest(store);
  claimOne(store);
  store.markEmailFailed(failed.id, { error: 'rejected', ambiguous: false });
  const newer = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(newer.created, true);

  assert.equal(store.retryFailed(failed.id), false);
  assert.equal(mustGet(store, failed.id).status, 'failed');
  assert.equal(mustGet(store, newer.request.id).status, 'open');
});

// ---------- restart ----------

test('a crash after claim but before beginSend stays clean and holdable after reopen', () => {
  const path = tempDbPath();
  const first = setup(path);
  const request = queuedRequest(first.store);
  claimOne(first.store);
  first.store.close();

  const second = setup(path);
  assert.deepEqual(second.store.recoverAfterRestart(), { emails: 1, checks: 0 });
  const row = mustGet(second.store, request.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.ambiguousSend, false);
  assert.equal(row.sendInFlight, false);
  assert.equal(row.attempts, 0);
  assert.equal(row.nextAttemptAt, second.iso());

  assert.equal(claimOne(second.store).id, request.id);
  assert.equal(second.store.holdForStock(request.id), true);
  second.store.close();
});

test('a crash after beginSend is ambiguous, not holdable and re-claimable after reopen', () => {
  const path = tempDbPath();
  const first = setup(path);
  const request = queuedRequest(first.store);
  claimOne(first.store);
  assert.equal(first.store.beginSend(request.id), true);
  first.store.close();
  first.store.close(); // Closing twice is harmless.

  const second = setup(path);
  assert.equal(mustGet(second.store, request.id).sendInFlight, true, 'the marker is durable');
  assert.deepEqual(second.store.recoverAfterRestart(), { emails: 1, checks: 0 });
  const row = mustGet(second.store, request.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.sendInFlight, false);
  assert.equal(row.ambiguousSend, true);
  assert.equal(row.attempts, 1);
  assert.equal(row.leaseUntil, null);
  assert.equal(row.nextAttemptAt, second.iso());

  const reclaimed = claimOne(second.store);
  assert.equal(reclaimed.id, request.id, 'the same id means the same idempotency key');
  assert.equal(reclaimed.ambiguousSend, true);
  assert.equal(second.store.holdForStock(request.id), false);
  assert.equal(second.store.beginSend(request.id), true);
  second.store.markEmailSent(request.id, 'p');
  assert.equal(mustGet(second.store, request.id).status, 'notified');
  second.store.close();
});

test('a crash is also converted by a lease-expiry re-claim without recovery', () => {
  const path = tempDbPath();
  const first = setup(path);
  const request = queuedRequest(first.store);
  claimOne(first.store);
  first.store.beginSend(request.id);
  first.store.close();

  const second = setup(path);
  second.advance(LEASE_MS);
  const reclaimed = claimOne(second.store);
  assert.equal(reclaimed.id, request.id);
  assert.equal(reclaimed.ambiguousSend, true);
  assert.equal(reclaimed.sendInFlight, false);
  second.store.close();
});

test('recoverAfterRestart releases check leases and leaves other rows alone', () => {
  const path = tempDbPath();
  const first = setup(path);
  const stillQueued = queuedRequest(first.store, 'queued@example.com', 'S2');
  const before = mustGet(first.store, stillQueued.id);
  first.store.enqueueStockCheck('CHECK-1');
  assert.equal(first.store.claimDueStockChecks(5).length, 1);
  first.store.close();

  const second = setup(path);
  assert.deepEqual(second.store.recoverAfterRestart(), { emails: 0, checks: 1 });
  assert.deepEqual(mustGet(second.store, stillQueued.id), before);
  assert.equal(second.store.claimDueStockChecks(5).length, 1, 'the check lease was released');
  second.store.close();
});

test('a check claim from before a restart cannot complete', () => {
  const { db, store } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'S' });
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  store.recoverAfterRestart();
  store.completeStockCheck(claim, { kind: 'in_stock', quantity: 1, product: null });
  assert.equal(mustGet(store, request.id).status, 'open');
  assert.ok(checkRow(db, 'S'), 'the check is still there to run again');
});

test('committed state survives close and reopen', () => {
  const path = tempDbPath();
  const first = setup(path);
  const { request } = first.store.createRequest({ email: 'a@example.com', sku: 'S' });
  first.store.recordWebhookEvent({ eventId: 'e', sku: 'S', quantity: 1 });
  first.store.close();

  const second = setup(path);
  assert.equal(mustGet(second.store, request.id).email, 'a@example.com');
  assert.deepEqual(second.store.recordWebhookEvent({ eventId: 'e', sku: 'S', quantity: 1 }), {
    inserted: false,
  });
  second.store.close();
});

// ---------- admin ----------

test('search is case-insensitive over email and SKU and treats wildcards literally', () => {
  const { store } = setup();
  store.createRequest({ email: 'alice_smith@example.com', sku: 'RED-1' });
  store.createRequest({ email: 'aliceXsmith@example.com', sku: 'BLUE-1' });
  store.createRequest({ email: 'bob@example.com', sku: '100%_COTTON' });
  store.createRequest({ email: 'carol@example.com', sku: 'BACK\\SLASH' });
  const search = (term: string) =>
    store.listRequests({ search: term, limit: 10, offset: 0 }).rows.map((row) => row.email);

  assert.deepEqual(search('ALICE_'), ['alice_smith@example.com']);
  assert.deepEqual(search('red-'), ['alice_smith@example.com']);
  assert.deepEqual(search('%'), ['bob@example.com']);
  assert.deepEqual(search('0%_c'), ['bob@example.com']);
  assert.deepEqual(search('\\'), ['carol@example.com']);
  assert.deepEqual(search("' OR 1=1 --"), []);
  assert.equal(search('   ').length, 4);
});

test('listing filters by status, is newest first, pages, and reports the full total', () => {
  const { store, advance } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    advance(1000);
    ids.push(store.createRequest({ email: `c${i}@example.com`, sku: 'S' }).request.id);
  }
  const page = store.listRequests({ limit: 2, offset: 1 });
  assert.equal(page.total, 5);
  assert.deepEqual(
    page.rows.map((row) => row.id),
    [ids[3], ids[2]],
  );

  promote(store, 'S');
  claimOne(store);
  const sending = store.listRequests({ status: 'sending', limit: 10, offset: 0 });
  assert.equal(sending.total, 1);
  assert.equal(store.listRequests({ status: 'open', limit: 10, offset: 0 }).total, 0);
  assert.equal(
    store.listRequests({ status: 'queued', search: 'c1@', limit: 10, offset: 0 }).total,
    1,
  );
});

test('rows created in the same millisecond still list newest first', () => {
  const { store } = setup();
  const first = store.createRequest({ email: 'a@example.com', sku: 'S' }).request.id;
  const second = store.createRequest({ email: 'b@example.com', sku: 'S' }).request.id;
  assert.deepEqual(
    store.listRequests({ limit: 2, offset: 0 }).rows.map((row) => row.id),
    [second, first],
  );
});

test('statusCounts returns every status including zeroes', () => {
  const { store } = setup();
  assert.deepEqual(store.statusCounts(), {
    open: 0,
    queued: 0,
    sending: 0,
    notified: 0,
    failed: 0,
  });
  store.createRequest({ email: 'a@example.com', sku: 'S' });
  assert.deepEqual(store.statusCounts(), {
    open: 1,
    queued: 0,
    sending: 0,
    notified: 0,
    failed: 0,
  });
});

test('recent events are newest first and limited; purge deletes strictly older ones', () => {
  const { store, advance } = setup();
  store.recordWebhookEvent({ eventId: 'old', sku: 'S', quantity: 1 });
  advance(1000);
  const cutoff = new Date(START + 1000);
  store.recordWebhookEvent({ eventId: 'at-cutoff', sku: 'S', quantity: 1 });
  advance(1000);
  store.recordWebhookEvent({ eventId: 'new', sku: 'S', quantity: 1 });

  assert.deepEqual(
    store.listRecentWebhookEvents(2).map((e) => e.eventId),
    ['new', 'at-cutoff'],
  );
  assert.equal(store.purgeWebhookEventsBefore(cutoff), 1);
  assert.deepEqual(
    store.listRecentWebhookEvents(10).map((e) => e.eventId),
    ['new', 'at-cutoff'],
  );
  assert.deepEqual(store.recordWebhookEvent({ eventId: 'old', sku: 'S', quantity: 1 }), {
    inserted: true,
  });
});

test('ping reports health and close is safe', () => {
  const { store } = setup();
  assert.equal(store.ping(), true);
  store.close();
  assert.equal(store.ping(), false);
});
