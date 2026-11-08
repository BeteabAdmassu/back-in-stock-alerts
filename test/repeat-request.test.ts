import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';

const HOUR_MS = 60 * 60 * 1000;

function setup() {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = createStore({
    db: openDatabase(':memory:'),
    clock: () => new Date(now),
    leaseMs: 60_000,
  });
  const advance = (ms: number): void => {
    now += ms;
  };
  const runCheck = (inStock: boolean): number => {
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
  const deliver = (): void => {
    const [row] = store.claimDueEmails(1);
    assert.ok(row);
    assert.equal(store.beginSend(row.id), true);
    store.markEmailSent(row.id, 'provider-id');
  };
  const notifiedOnce = (): void => {
    store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
    assert.equal(runCheck(true), 1);
    deliver();
  };
  return { store, advance, runCheck, deliver, notifiedOnce };
}

test('a repeat request while the item stays in stock sends nothing', () => {
  const { store, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  const { request, created } = store.createRequest({ email: 'A@example.com', sku: 'sku-1' });
  assert.equal(created, true);
  assert.equal(runCheck(true), 0);
  assert.equal(store.getRequest(request.id)?.status, 'open');
});

test('a repeat request is emailed once a sell-out was seen and stock returns', () => {
  const { store, runCheck, deliver, notifiedOnce } = setup();
  notifiedOnce();
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 0);
  assert.equal(runCheck(false), 0);
  assert.equal(runCheck(true), 1);
  deliver();
  assert.equal(store.getRequest(request.id)?.status, 'notified');
});

test('a repeat request is not silenced for good if no sell-out is ever seen', () => {
  const { store, advance, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  advance(23 * HOUR_MS);
  assert.equal(runCheck(true), 0);
  advance(2 * HOUR_MS);
  assert.equal(runCheck(true), 1);
});

test('a request long after the last notification is not suppressed', () => {
  const { store, advance, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  advance(25 * HOUR_MS);
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
});

test('suppression for one customer does not hold back another', () => {
  const { store, runCheck, notifiedOnce } = setup();
  notifiedOnce();
  store.createRequest({ email: 'a@example.com', sku: 'SKU-1' });
  const other = store.createRequest({ email: 'b@example.com', sku: 'SKU-1' });
  assert.equal(runCheck(true), 1);
  assert.equal(store.getRequest(other.request.id)?.status, 'queued');
});
