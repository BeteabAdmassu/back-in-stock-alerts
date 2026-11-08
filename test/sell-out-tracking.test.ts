import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DEFAULT_TIMINGS } from '../src/contracts.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/schema.ts';
import { createStore } from '../src/db/store.ts';
import { createEmailWorker } from '../src/workers/email-worker.ts';

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * 1000;

function setup() {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = createStore({
    db: openDatabase(':memory:'),
    clock: () => new Date(now),
    leaseMs: 60_000,
  });
  const advance = (ms: number = SECOND_MS): void => {
    now += ms;
  };
  let events = 0;
  const webhook = (quantity: number): void => {
    advance();
    store.recordWebhookEvent({ eventId: `evt-${++events}`, sku: 'SKU-1', quantity });
  };
  const runCheck = (inStock: boolean): number => {
    advance();
    store.enqueueStockCheck('SKU-1');
    const [claim] = store.claimDueStockChecks(1);
    assert.ok(claim);
    return store.completeStockCheck(
      claim,
      inStock
        ? { kind: 'in_stock', quantity: 5, product: null }
        : { kind: 'out_of_stock', quantity: 0 },
    ).queued;
  };
  const claimEmail = () => {
    advance();
    const [row] = store.claimDueEmails(1);
    assert.ok(row);
    assert.equal(store.beginSend(row.id), true);
    return row;
  };
  const notifiedOnce = (): void => {
    store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
    assert.equal(runCheck(true), 1);
    store.markEmailSent(claimEmail().id, 'provider-id');
  };
  return { store, advance, webhook, runCheck, claimEmail, notifiedOnce };
}

test('a database from the first schema upgrades in place and keeps its work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bis-upgrade-'));
  const path = join(dir, 'app.db');
  const old = new DatabaseSync(path);
  old.exec(MIGRATIONS[0] as string);
  old.exec('PRAGMA user_version = 1');
  old.exec(`
    INSERT INTO requests (id, email, sku, sku_key, created_at, updated_at)
    VALUES ('r1', 'a@example.com', 'SKU-1', 'SKU-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO stock_checks (sku_key, query_sku, due_at)
    VALUES ('SKU-1', 'SKU-1', '2026-01-01T00:00:00.000Z');
  `);
  old.close();

  const db = openDatabase(path);
  const store = createStore({
    db,
    clock: () => new Date('2026-01-01T00:01:00.000Z'),
    leaseMs: 60_000,
  });
  assert.equal(store.getRequest('r1')?.status, 'open');
  const [claim] = store.claimDueStockChecks(1);
  assert.equal(claim?.skuKey, 'SKU-1');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// The zero-email bug: suppression used to lift only if a stock check read the sell-out while a
// request was open, so a sell-out nobody read left the customer silent for up to 24h.

test('sell-out webhook with nothing open, then restock, then a repeat request: emailed', () => {
  const { store, webhook, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  webhook(0);
  webhook(5);
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
  assert.equal(store.getRequest(request.id)?.status, 'queued');
});

test('repeat request, then a sell-out webhook no check ever read as sold out: emailed', () => {
  const { store, webhook, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 0);
  webhook(0);
  assert.equal(runCheck(true), 1);
});

test('an out-of-stock read before the repeat request also ends suppression', () => {
  const { store, runCheck, advance, notifiedOnce } = setup();
  notifiedOnce();
  store.createRequest({ email: 'b@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(false), 0);
  advance();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 2);
});

test('a webhook saying it is in stock does not end suppression', () => {
  const { store, webhook, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  webhook(5);
  assert.equal(runCheck(true), 0);
});

test('a sell-out older than the notification does not end suppression', () => {
  const { store, webhook, runCheck, notifiedOnce } = setup();
  webhook(0);
  notifiedOnce();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 0);
});

test('a sell-out webhook alone sends nothing: the stock API still decides', () => {
  const { store, webhook, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  webhook(0);
  assert.equal(runCheck(false), 0);
  assert.equal(store.getRequest(request.id)?.status, 'open');
});

test('a redelivered sell-out webhook does not end a later suppression', () => {
  const { store, advance, runCheck, notifiedOnce } = setup();
  store.recordWebhookEvent({ eventId: 'evt-sold', sku: 'SKU-1', quantity: 0 });
  advance();
  notifiedOnce();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  advance();
  store.recordWebhookEvent({ eventId: 'evt-sold', sku: 'SKU-1', quantity: 0 });
  assert.equal(runCheck(true), 0);
});

// Telling a customer an item is back when we already know it isn't.

test('a sell-out makes a queued retry verify stock again before it sends', () => {
  const { store, webhook, runCheck, claimEmail, advance } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
  const row = claimEmail();
  store.markEmailRetry(row.id, {
    error: 'HTTP 500',
    nextAttemptAt: new Date(Date.parse(row.updatedAt) + SECOND_MS),
    ambiguous: false,
  });
  assert.ok(store.getRequest(request.id)?.verifiedAt);
  webhook(0);
  advance();
  assert.equal(store.getRequest(request.id)?.verifiedAt, null);
});

test('an in-stock read overtaken by a sell-out promotes nobody, and the check runs again', () => {
  const { store, advance } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  advance();
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  advance();
  store.recordWebhookEvent({ eventId: 'evt-sold', sku: 'SKU-1', quantity: 0 });
  advance();
  const overtaken = store.completeStockCheck(claim, {
    kind: 'in_stock',
    quantity: 5,
    product: null,
  });
  assert.equal(overtaken.queued, 0);
  assert.equal(store.getRequest(request.id)?.status, 'open');
  assert.equal(store.listRecentWebhookEvents(1)[0]?.outcome, 'pending');

  // The true restock that follows is still found.
  advance();
  const [next] = store.claimDueStockChecks(1);
  assert.ok(next, 'the check must be due again');
  const restocked = store.completeStockCheck(next, {
    kind: 'in_stock',
    quantity: 5,
    product: null,
  });
  assert.equal(restocked.queued, 1);
});

// A failed send that may have been delivered, and a new request under a new idempotency key.

test('a repeat request after an ambiguous failure is treated as already notified', () => {
  const { store, advance, runCheck, claimEmail } = setup();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
  store.markEmailFailed(claimEmail().id, { error: 'Gave up', ambiguous: true });
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 0);
  advance(25 * HOUR_MS);
  assert.equal(runCheck(true), 1);
});

test('a repeat request after a definite failure is emailed normally', () => {
  const { store, runCheck, claimEmail } = setup();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
  store.markEmailFailed(claimEmail().id, { error: 'HTTP 422', ambiguous: false });
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
});

test('a sell-out during an in-flight send makes its retry verify stock again', () => {
  const { store, webhook, runCheck, claimEmail } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
  const row = claimEmail();
  webhook(0);
  store.markEmailRetry(row.id, {
    error: 'HTTP 500',
    nextAttemptAt: new Date('2026-01-01T01:00:00.000Z'),
    ambiguous: false,
  });
  const after = store.getRequest(request.id);
  assert.equal(after?.status, 'queued');
  assert.equal(after?.verifiedAt, null);
});

test('a slow out-of-stock read is dated when it began, so it cannot lift a later suppression', () => {
  const { store, advance, claimEmail } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  advance();
  const [restock] = store.claimDueStockChecks(1);
  assert.ok(restock);
  store.completeStockCheck(restock, { kind: 'in_stock', quantity: 5, product: null });

  // The read starts while the email is on its way, and only finishes after it was delivered.
  store.createRequest({ email: 'b@example.com', sku: 'SKU-1' });
  advance();
  const [slowRead] = store.claimDueStockChecks(1);
  assert.ok(slowRead);
  store.markEmailSent(claimEmail().id, 'provider-id');
  assert.equal(store.getRequest(request.id)?.status, 'notified');
  advance();
  store.completeStockCheck(slowRead, { kind: 'out_of_stock', quantity: 0 });

  advance();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  advance();
  const [next] = store.claimDueStockChecks(1);
  assert.ok(next);
  const result = store.completeStockCheck(next, { kind: 'in_stock', quantity: 5, product: null });
  assert.equal(result.queued, 1, 'only b, who has never been emailed');
});

test('a clock stepping backwards cannot make every in-stock read count as overtaken', () => {
  const { store, webhook, advance, runCheck } = setup();
  webhook(0);
  advance(-HOUR_MS);
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
});

test('a sell-out in the same millisecond as the claim still overtakes the read', () => {
  const { store, advance } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  advance();
  const [claim] = store.claimDueStockChecks(1);
  assert.ok(claim);
  store.recordWebhookEvent({ eventId: 'evt-sold', sku: 'SKU-1', quantity: 0 });
  store.completeStockCheck(claim, { kind: 'in_stock', quantity: 5, product: null });
  assert.equal(store.getRequest(request.id)?.status, 'open');
});

test('findOpenRequest matches like the unique index and ignores closed requests', () => {
  const { store, runCheck, claimEmail } = setup();
  assert.equal(store.findOpenRequest({ email: 'a@example.com', sku: 'SKU-1' }), null);
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(store.findOpenRequest({ email: ' A@EXAMPLE.com', sku: 'sku-1' })?.id, request.id);
  assert.equal(runCheck(true), 1);
  store.markEmailSent(claimEmail().id, 'provider-id');
  assert.equal(store.findOpenRequest({ email: 'a@example.com', sku: 'SKU-1' }), null);
});

test('an unverifiable sell-out holds the email until the stock API answers', async () => {
  const { store, webhook, runCheck, claimEmail, advance } = setup();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
  const first = claimEmail();
  advance();
  store.markEmailRetry(first.id, {
    error: 'HTTP 500',
    nextAttemptAt: new Date(0),
    ambiguous: false,
  });
  webhook(0);

  const sends: string[] = [];
  const worker = createEmailWorker({
    store,
    stock: {
      getStock: async () => ({ kind: 'error', error: 'stock API timed out' }),
      getCatalogue: async () => [],
    },
    sender: {
      send: async (message) => {
        sends.push(message.to);
        return { kind: 'accepted', providerId: 'x' };
      },
    },
    clock: () => new Date(Date.parse(first.updatedAt) + 60_000),
    logger: { info() {}, warn() {}, error() {} },
    timings: { ...DEFAULT_TIMINGS, pollIntervalMs: 5 },
    productUrlTemplate: null,
  });
  worker.start();
  worker.wake();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await worker.stop();

  assert.deepEqual(sends, []);
  const after = store.getRequest(request.id);
  assert.equal(after?.status, 'queued');
  assert.match(after?.lastError ?? '', /verify stock/);
});

// Reconciler load must not delay a check a customer or a webhook is waiting on.

test('a reconciler re-check takes its turn after waiting long enough', () => {
  const { store, advance } = setup();
  store.createRequest({ email: 'a@example.com', sku: 'OLD-1' });
  const [first] = store.claimDueStockChecks(1);
  assert.ok(first);
  store.completeStockCheck(first, { kind: 'out_of_stock', quantity: 0 });
  assert.equal(store.enqueueChecksForOpenSkus(), 1);
  advance(6 * 60 * SECOND_MS);
  store.createRequest({ email: 'b@example.com', sku: 'NEW-1' });
  assert.equal(store.claimDueStockChecks(1)[0]?.skuKey, 'OLD-1');
});

test('checks asked for by a customer or webhook run ahead of reconciler re-checks', () => {
  const { store, advance } = setup();
  store.createRequest({ email: 'a@example.com', sku: 'OLD-1' });
  const [first] = store.claimDueStockChecks(1);
  assert.ok(first);
  store.completeStockCheck(first, { kind: 'out_of_stock', quantity: 0 });

  assert.equal(store.enqueueChecksForOpenSkus(), 1);
  advance();
  store.createRequest({ email: 'b@example.com', sku: 'NEW-1' });
  assert.equal(store.claimDueStockChecks(1)[0]?.skuKey, 'NEW-1');
  assert.equal(store.claimDueStockChecks(1)[0]?.skuKey, 'OLD-1');
});

test('a webhook for a SKU awaiting a reconciler re-check moves it to the front', () => {
  const { store, advance } = setup();
  for (const sku of ['OLD-1', 'OLD-2']) {
    store.createRequest({ email: 'a@example.com', sku });
    const [claim] = store.claimDueStockChecks(1);
    assert.ok(claim);
    store.completeStockCheck(claim, { kind: 'out_of_stock', quantity: 0 });
  }
  assert.equal(store.enqueueChecksForOpenSkus(), 2);
  advance();
  store.recordWebhookEvent({ eventId: 'evt-1', sku: 'OLD-2', quantity: 3 });
  assert.equal(store.claimDueStockChecks(1)[0]?.skuKey, 'OLD-2');
});
