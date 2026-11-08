import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_TIMINGS,
  type Logger,
  type RequestRow,
  type Store,
  type Worker,
} from '../src/contracts.ts';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';
import { createStockClient } from '../src/integrations/stock-client.ts';
import { createStockCheckWorker } from '../src/workers/stock-check-worker.ts';

const TOKEN = 'worker-test-token';
const LONG_INTERVAL = 3_600_000;
const POLL_FAST = 5;
const PRODUCT = { name: 'Mug', price: 18, currency: 'GBP', image: 'https://img.example/m.png' };

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

const inStock = (quantity = 5): Reply => ({
  status: 200,
  body: { ...PRODUCT, quantity, in_stock: true },
});
const soldOut = (): Reply => ({ status: 200, body: { quantity: 0, in_stock: false } });

interface Harness {
  db: DatabaseSync;
  store: Store;
  worker: Worker;
  advance(ms: number): void;
  calls: string[];
  queuedSignals: () => number;
  warnings: object[];
  checkRow(sku: string): { attempts: number; last_error: string | null } | undefined;
}

/** A real Store on SQLite, a real HTTP stock API and the real client, torn down after the test. */
async function setup(
  t: { after(fn: () => void | Promise<void>): void },
  reply: (callNumber: number, url: string) => Reply,
  pollIntervalMs = LONG_INTERVAL,
): Promise<Harness> {
  const calls: string[] = [];
  const handler: RequestListener = async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('{}');
      return;
    }
    calls.push(req.url ?? '');
    const { status, body } = await reply(calls.length, req.url ?? '');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  let ms = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(ms);
  const db = openDatabase(':memory:');
  const store = createStore({ db, clock, leaseMs: 60_000 });

  const warnings: object[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (obj) => warnings.push(obj),
    error: (obj) => warnings.push(obj),
  };
  const stock = createStockClient({
    baseUrl: `http://127.0.0.1:${port}/api/stock`,
    apiKey: TOKEN,
    timeoutMs: 2_000,
    logger,
  });
  let signals = 0;
  const worker = createStockCheckWorker({
    store,
    stock,
    clock,
    logger,
    timings: { ...DEFAULT_TIMINGS, pollIntervalMs },
    onQueued: () => {
      signals += 1;
    },
  });

  t.after(async () => {
    await worker.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });

  return {
    db,
    store,
    worker,
    calls,
    warnings,
    advance: (by) => {
      ms += by;
    },
    queuedSignals: () => signals,
    checkRow: (sku) =>
      db
        .prepare('SELECT attempts, last_error FROM stock_checks WHERE sku_key = ?')
        .get(sku.toUpperCase()) as { attempts: number; last_error: string | null } | undefined,
  };
}

async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'condition not met in time');
    await delay(2);
  }
}

function status(store: Store, request: RequestRow): string | undefined {
  return store.getRequest(request.id)?.status;
}

const ask = (store: Store, email: string, sku = 'SKU-1'): RequestRow =>
  store.createRequest({ email, sku }).request;

test('phantom webhook: the API says 0, requests stay open and nothing is queued', async (t) => {
  const h = await setup(t, () => soldOut());
  const request = ask(h.store, 'a@example.com');
  h.store.recordWebhookEvent({ eventId: 'evt-phantom', sku: 'SKU-1', quantity: 50 });

  h.worker.start();
  await until(() => h.checkRow('SKU-1') === undefined);

  assert.equal(status(h.store, request), 'open');
  assert.deepEqual(h.calls, ['/api/stock/SKU-1']);
  assert.equal(h.queuedSignals(), 0);
  assert.deepEqual(h.store.claimDueEmails(10), [], 'nothing to send');
  const [event] = h.store.listRecentWebhookEvents(1);
  assert.equal(event?.outcome, 'out_of_stock');
  assert.equal(event?.verifiedQuantity, 0);
  assert.equal(event?.quantity, 50, 'the claim is kept for the audit trail');
});

test('real restock: every customer for the SKU is queued once, with the product', async (t) => {
  const h = await setup(t, () => inStock(5));
  const requests = [
    ask(h.store, 'a@example.com', 'SKU-1'),
    ask(h.store, 'b@example.com', 'sku-1'),
    ask(h.store, 'c@example.com', 'Sku-1'),
  ];
  const other = ask(h.store, 'd@example.com', 'OTHER');
  h.store.recordWebhookEvent({ eventId: 'evt-1', sku: 'SKU-1', quantity: 5 });

  h.worker.start();
  await until(() => h.checkRow('SKU-1') === undefined && h.checkRow('OTHER') === undefined);

  for (const request of [...requests, other]) {
    const row = h.store.getRequest(request.id);
    assert.equal(row?.status, 'queued');
    assert.deepEqual(row?.product, PRODUCT);
    assert.ok(row?.verifiedAt);
  }
  assert.equal(h.calls.filter((url) => url.toUpperCase().endsWith('/SKU-1')).length, 1);
  assert.equal(h.queuedSignals(), 2, 'one per check that queued something');
  assert.equal(h.store.listRecentWebhookEvents(1)[0]?.outcome, 'in_stock');
  assert.equal(h.store.listRecentWebhookEvents(1)[0]?.verifiedQuantity, 5);
});

test('quantity 0 webhook with the API in stock still queues', async (t) => {
  const h = await setup(t, () => inStock(3));
  const request = ask(h.store, 'a@example.com');
  h.store.recordWebhookEvent({ eventId: 'evt-zero', sku: 'SKU-1', quantity: 0 });

  h.worker.start();
  await until(() => status(h.store, request) === 'queued');

  assert.equal(h.store.listRecentWebhookEvents(1)[0]?.outcome, 'in_stock');
  assert.equal(h.store.listRecentWebhookEvents(1)[0]?.verifiedQuantity, 3);
  await until(() => h.queuedSignals() === 1);
});

test('stock API 500 then recovery: retried with backoff, the request is never lost', async (t) => {
  let healthy = false;
  const h = await setup(
    t,
    () => (healthy ? inStock(2) : { status: 500, body: { error: 'down' } }),
    POLL_FAST,
  );
  const request = ask(h.store, 'a@example.com');
  h.store.recordWebhookEvent({ eventId: 'evt-500', sku: 'SKU-1', quantity: 2 });

  h.worker.start();
  await until(() => h.checkRow('SKU-1')?.attempts === 1);

  assert.equal(status(h.store, request), 'open');
  assert.equal(h.store.listRecentWebhookEvents(1)[0]?.outcome, 'pending', 'not out_of_stock');
  assert.equal(h.checkRow('SKU-1')?.last_error, 'stock API returned 500');
  assert.ok(h.warnings.some((w) => (w as { skuKey?: string }).skuKey === 'SKU-1'));

  // The clock is frozen, so polling must not retry before the backoff (5s +/- 10%).
  await delay(40);
  assert.equal(h.calls.length, 1, 'no retry before the backoff elapses');

  h.advance(4_000);
  await delay(40);
  assert.equal(h.calls.length, 1, 'still inside the shortest possible backoff');

  h.advance(2_000); // 6s in total, past the longest possible first backoff.
  await until(() => h.checkRow('SKU-1')?.attempts === 2);
  assert.equal(h.calls.length, 2);

  // The second backoff is 15s +/- 10%: 6s is not enough, 17s is.
  h.advance(6_000);
  await delay(40);
  assert.equal(h.calls.length, 2, 'the backoff grew with the attempts');

  healthy = true;
  h.advance(11_000);
  await until(() => status(h.store, request) === 'queued');

  assert.equal(h.calls.length, 3);
  assert.equal(h.store.getRequest(request.id)?.lastError, null);
  assert.equal(h.store.listRecentWebhookEvents(1)[0]?.outcome, 'in_stock');
  await until(() => h.checkRow('SKU-1') === undefined);
  assert.equal(h.queuedSignals(), 1);
});

test('a malformed API body is retried, not read as out of stock', async (t) => {
  const h = await setup(t, () => ({ status: 200, body: { in_stock: true } }), POLL_FAST);
  const request = ask(h.store, 'a@example.com');
  h.store.recordWebhookEvent({ eventId: 'evt-bad', sku: 'SKU-1', quantity: 2 });

  h.worker.start();
  await until(() => h.checkRow('SKU-1')?.attempts === 1);

  assert.equal(status(h.store, request), 'open');
  assert.equal(h.store.listRecentWebhookEvents(1)[0]?.outcome, 'pending');
});

test('a client that throws still backs off rather than waiting for the lease', async (t) => {
  const db = openDatabase(':memory:');
  const clock = () => new Date('2026-01-01T00:00:00.000Z');
  const store = createStore({ db, clock, leaseMs: 60_000 });
  const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const worker = createStockCheckWorker({
    store,
    stock: {
      getStock: () => Promise.reject(new Error('boom')),
      getCatalogue: () => Promise.resolve([]),
    },
    clock,
    logger,
    timings: { ...DEFAULT_TIMINGS, pollIntervalMs: LONG_INTERVAL },
    onQueued: () => {},
  });
  t.after(async () => {
    await worker.stop();
    store.close();
  });
  const request = ask(store, 'a@example.com');
  const row = () =>
    db.prepare('SELECT attempts, lease_until FROM stock_checks').get() as {
      attempts: number;
      lease_until: string | null;
    };

  worker.start();
  await until(() => row().attempts === 1);

  assert.equal(row().lease_until, null);
  assert.equal(store.getRequest(request.id)?.status, 'open');
});

test('a request arriving mid-check is re-checked promptly', async (t) => {
  let release: (reply: { status: number; body: unknown }) => void = () => {};
  const firstReply = new Promise<{ status: number; body: unknown }>((resolve) => {
    release = resolve;
  });
  // The first read is taken before the restock and only answered after the new request arrives.
  const h = await setup(t, (call) => (call === 1 ? firstReply : inStock(4)));
  const early = ask(h.store, 'early@example.com');
  h.store.recordWebhookEvent({ eventId: 'evt-before', sku: 'SKU-1', quantity: 0 });
  h.advance(1);

  h.worker.start();
  await until(() => h.calls.length === 1);

  h.advance(1);
  const late = ask(h.store, 'late@example.com');
  h.store.recordWebhookEvent({ eventId: 'evt-during', sku: 'SKU-1', quantity: 4 });
  release({ status: 200, body: { quantity: 0, in_stock: false } });

  // The poll interval is an hour, so only the post-completion pass can pick this up.
  await until(() => h.calls.length === 2);
  await until(() => status(h.store, late) === 'queued' && status(h.store, early) === 'queued');
  await until(() => h.checkRow('SKU-1') === undefined);

  const outcomes = Object.fromEntries(
    h.store.listRecentWebhookEvents(10).map((event) => [event.eventId, event.outcome]),
  );
  assert.deepEqual(outcomes, { 'evt-before': 'out_of_stock', 'evt-during': 'in_stock' });
  assert.equal(h.queuedSignals(), 1);
});

test('a check that fails while newer work arrives reruns without the backoff', async (t) => {
  let release: (reply: { status: number; body: unknown }) => void = () => {};
  const firstReply = new Promise<{ status: number; body: unknown }>((resolve) => {
    release = resolve;
  });
  const h = await setup(t, (call) => (call === 1 ? firstReply : inStock(1)));
  const request = ask(h.store, 'a@example.com');

  h.worker.start();
  await until(() => h.calls.length === 1);

  h.store.recordWebhookEvent({ eventId: 'evt-during', sku: 'SKU-1', quantity: 1 });
  release({ status: 500, body: {} });

  // The clock never moves, so this only passes if the retry was not pushed into the future.
  await until(() => status(h.store, request) === 'queued');
  assert.equal(h.calls.length, 2);
});

test('no open requests: no API call, the check is settled as skipped', async (t) => {
  const h = await setup(t, () => inStock(5));
  h.store.recordWebhookEvent({ eventId: 'evt-nobody', sku: 'SKU-1', quantity: 5 });

  h.worker.start();
  await until(() => h.checkRow('SKU-1') === undefined);

  assert.equal(h.calls.length, 0);
  assert.equal(h.queuedSignals(), 0);
  const [event] = h.store.listRecentWebhookEvents(1);
  assert.equal(event?.outcome, 'skipped');
  assert.equal(event?.verifiedQuantity, null);
});

test('onQueued is not called when an in-stock check queues nothing', async (t) => {
  const h = await setup(t, () => inStock(5));
  const request = ask(h.store, 'a@example.com');
  h.worker.start();
  await until(() => status(h.store, request) === 'queued');
  await until(() => h.queuedSignals() === 1);

  // The only open request has moved on, so this one is skipped before the API is called.
  h.store.enqueueStockCheck('SKU-1');
  h.worker.wake();
  await until(() => h.checkRow('SKU-1') === undefined);

  assert.equal(h.queuedSignals(), 1);
  assert.equal(h.calls.length, 1);
});

test('at most four checks run at once', async (t) => {
  let active = 0;
  let peak = 0;
  const h = await setup(t, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(20);
    active -= 1;
    return { status: 200, body: { quantity: 0 } };
  });
  for (let i = 0; i < 10; i += 1) ask(h.store, 'a@example.com', `SKU-${i}`);

  h.worker.start();
  await until(() => h.calls.length === 10);
  await until(() => active === 0);

  assert.equal(peak, 4);
});
