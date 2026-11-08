import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_TIMINGS, type Logger, type Store } from '../src/contracts.ts';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';
import { createStockClient } from '../src/integrations/stock-client.ts';
import { createReconciler } from '../src/workers/reconciler.ts';
import { createStockCheckWorker } from '../src/workers/stock-check-worker.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_INTERVAL = 3_600_000;

function recordingLogger() {
  const errors: object[] = [];
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: (obj) => errors.push(obj),
  };
  return { logger, errors };
}

function setup(t: { after(fn: () => void): void }) {
  let ms = Date.parse('2026-06-01T00:00:00.000Z');
  const clock = () => new Date(ms);
  const db = openDatabase(':memory:');
  const store = createStore({ db, clock, leaseMs: 60_000 });
  t.after(() => store.close());
  return {
    db,
    store,
    clock,
    advance: (by: number) => {
      ms += by;
    },
    checks: () => db.prepare('SELECT sku_key FROM stock_checks ORDER BY sku_key').all().length,
  };
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition not met in time');
    await delay(2);
  }
}

/** Leaves requests open with no check row, the state after a completed out_of_stock check. */
function settleOutOfStock(store: Store): void {
  for (const claim of store.claimDueStockChecks(100)) {
    store.completeStockCheck(claim, { kind: 'out_of_stock', quantity: 0 });
  }
}

test('a missed webhook is caught: open request plus restock with no webhook queues', async (t) => {
  let quantity = 0;
  let apiCalls = 0;
  const server = createServer((_req, res) => {
    apiCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ quantity, in_stock: quantity > 0, name: 'Mug' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const { store, clock, checks } = setup(t);
  const { logger } = recordingLogger();
  const timings = {
    ...DEFAULT_TIMINGS,
    pollIntervalMs: LONG_INTERVAL,
    reconcileIntervalMs: 20,
  };
  const worker = createStockCheckWorker({
    store,
    stock: createStockClient({
      baseUrl: `http://127.0.0.1:${port}/api/stock`,
      apiKey: 'key',
      timeoutMs: 2_000,
      logger,
    }),
    clock,
    logger,
    timings,
    onQueued: () => {},
  });
  const reconciler = createReconciler({
    store,
    clock,
    logger,
    timings,
    onEnqueued: () => worker.wake(),
  });
  t.after(async () => {
    await reconciler.stop();
    await worker.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  worker.start();
  await until(() => apiCalls === 1 && checks() === 0);
  assert.equal(store.getRequest(request.id)?.status, 'open');

  // The product comes back and no webhook ever announces it.
  quantity = 5;
  reconciler.start();
  await until(() => store.getRequest(request.id)?.status === 'queued');

  assert.deepEqual(store.getRequest(request.id)?.product, { name: 'Mug' });
  assert.equal(store.listRecentWebhookEvents(10).length, 0);
});

test('runs immediately on start: enqueues open SKUs and signals', (t) => {
  const { store, clock, checks } = setup(t);
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  store.createRequest({ email: 'b@example.com', sku: 'SKU-2' });
  settleOutOfStock(store);
  assert.equal(checks(), 0);

  let signals = 0;
  const reconciler = createReconciler({
    store,
    clock,
    logger: recordingLogger().logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: LONG_INTERVAL },
    onEnqueued: () => {
      signals += 1;
    },
  });
  t.after(() => reconciler.stop());
  reconciler.start();

  assert.equal(checks(), 2);
  assert.equal(signals, 1);
});

test('existing checks are left alone and no signal is sent when nothing was enqueued', (t) => {
  const { store, clock, db } = setup(t);
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  const generation = () =>
    (db.prepare('SELECT generation FROM stock_checks').get() as { generation: number }).generation;
  const before = generation();

  let signals = 0;
  const reconciler = createReconciler({
    store,
    clock,
    logger: recordingLogger().logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: LONG_INTERVAL },
    onEnqueued: () => {
      signals += 1;
    },
  });
  t.after(() => reconciler.stop());
  reconciler.start();

  assert.equal(signals, 0);
  assert.equal(generation(), before);
});

test('repeats on the interval, wakes on demand, and stops', async (t) => {
  const { store, clock, checks } = setup(t);
  const reconciler = createReconciler({
    store,
    clock,
    logger: recordingLogger().logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: 10 },
    onEnqueued: () => {},
  });
  t.after(() => reconciler.stop());
  reconciler.start();

  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  settleOutOfStock(store);
  await until(() => checks() === 1);

  await reconciler.stop();
  settleOutOfStock(store);
  await delay(40);
  assert.equal(checks(), 0, 'no run after stop');
  reconciler.wake();
  assert.equal(checks(), 0, 'wake after stop does nothing');
});

test('wake runs a pass now', async (t) => {
  const { store, clock, checks } = setup(t);
  const reconciler = createReconciler({
    store,
    clock,
    logger: recordingLogger().logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: LONG_INTERVAL },
    onEnqueued: () => {},
  });
  t.after(() => reconciler.stop());
  reconciler.start();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  settleOutOfStock(store);
  assert.equal(checks(), 0);

  reconciler.wake();
  assert.equal(checks(), 1);
});

test('purges webhook events older than the retention period only', (t) => {
  const { store, clock, advance } = setup(t);
  store.recordWebhookEvent({ eventId: 'old', sku: 'SKU-1', quantity: 1 });
  advance(2 * DAY_MS);
  store.recordWebhookEvent({ eventId: 'recent', sku: 'SKU-1', quantity: 1 });
  advance(29 * DAY_MS); // old is now 31 days old, recent 29.

  const reconciler = createReconciler({
    store,
    clock,
    logger: recordingLogger().logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: LONG_INTERVAL },
    onEnqueued: () => {},
  });
  t.after(() => reconciler.stop());
  reconciler.start();

  assert.deepEqual(
    store.listRecentWebhookEvents(10).map((event) => event.eventId),
    ['recent'],
  );
});

test('retentionDays can be configured', (t) => {
  const { store, clock, advance } = setup(t);
  store.recordWebhookEvent({ eventId: 'evt', sku: 'SKU-1', quantity: 1 });
  advance(2 * DAY_MS);

  const reconciler = createReconciler({
    store,
    clock,
    logger: recordingLogger().logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: LONG_INTERVAL },
    onEnqueued: () => {},
    retentionDays: 1,
  });
  t.after(() => reconciler.stop());
  reconciler.start();

  assert.equal(store.listRecentWebhookEvents(10).length, 0);
});

test('store errors are logged without their message, and the next run still works', async (t) => {
  const { store, clock, checks } = setup(t);
  store.createRequest({ email: 'secret@example.com', sku: 'SKU-1' });
  settleOutOfStock(store);

  let failing = true;
  const flaky: Store = {
    ...store,
    enqueueChecksForOpenSkus() {
      if (failing) throw new Error('failure mentioning secret@example.com');
      return store.enqueueChecksForOpenSkus();
    },
  };
  let purgeRuns = 0;
  flaky.purgeWebhookEventsBefore = (date) => {
    purgeRuns += 1;
    if (failing) throw new Error('purge failure');
    return store.purgeWebhookEventsBefore(date);
  };

  const { logger, errors } = recordingLogger();
  const reconciler = createReconciler({
    store: flaky,
    clock,
    logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: 10 },
    onEnqueued: () => {},
  });
  t.after(() => reconciler.stop());

  assert.doesNotThrow(() => reconciler.start());
  assert.equal(purgeRuns, 1, 'an enqueue failure does not stop the purge');
  assert.equal(errors.length, 2);
  assert.ok(!JSON.stringify(errors).includes('secret@example.com'));

  failing = false;
  await until(() => checks() === 1);
});

test('a throwing onEnqueued is logged and does not stop the reconciler or the purge', (t) => {
  const { store, clock, advance } = setup(t);
  store.recordWebhookEvent({ eventId: 'old', sku: 'SKU-9', quantity: 1 });
  advance(40 * DAY_MS);
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  settleOutOfStock(store);

  const { logger, errors } = recordingLogger();
  const reconciler = createReconciler({
    store,
    clock,
    logger,
    timings: { ...DEFAULT_TIMINGS, reconcileIntervalMs: LONG_INTERVAL },
    onEnqueued: () => {
      throw new Error('boom');
    },
  });
  t.after(() => reconciler.stop());

  assert.doesNotThrow(() => reconciler.start());
  assert.equal(errors.length, 1);
  assert.equal(store.listRecentWebhookEvents(10).length, 0);
});
