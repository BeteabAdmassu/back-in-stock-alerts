// Independent QA: paths to a missed or duplicate email, through real HTTP, real SQLite, real clients.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { postRequest, postWebhook, stack, until } from './qa-helpers.ts';

const HOUR = 3_600_000;

test('QA-D1 fractional stock quantity with a pending webhook event still notifies', async (t) => {
  const s = await stack(t);
  s.stockBody.value = () => ({ body: { quantity: 0, in_stock: false } });
  const { id } = (await (await postRequest(s.url, 'a@example.com', 'FRAC-1')).json()) as {
    id: string;
  };
  await until(() => s.stockCalls.length >= 1);
  await sleep(100);
  s.stockBody.value = () => ({ body: { quantity: 2.5, in_stock: true } });
  const r = await postWebhook(s.url, { event_id: 'frac-1', sku: 'FRAC-1', quantity: 3 });
  assert.equal(r.status, 200);
  const ok = await until(() => s.store.getRequest(id)?.status === 'notified', 3000);
  const errors = s.logs.filter((l) => l.level === 'error').map((l) => l.obj);
  assert.ok(
    ok,
    `status=${s.store.getRequest(id)?.status} emails=${s.sent.length} errors=${JSON.stringify(errors.slice(0, 2))}`,
  );
});

test('QA-D2 very large stock quantity with a pending webhook event still notifies', async (t) => {
  const s = await stack(t);
  s.stockBody.value = () => ({ body: { quantity: 0, in_stock: false } });
  const { id } = (await (await postRequest(s.url, 'b@example.com', 'BIG-1')).json()) as {
    id: string;
  };
  await until(() => s.stockCalls.length >= 1);
  await sleep(100);
  s.stockBody.value = () => ({ body: { quantity: 1e21, in_stock: true } });
  await postWebhook(s.url, { event_id: 'big-1', sku: 'BIG-1', quantity: 3 });
  const ok = await until(() => s.store.getRequest(id)?.status === 'notified', 3000);
  assert.ok(ok, `status=${s.store.getRequest(id)?.status} emails=${s.sent.length}`);
});

test('QA-D3 a retried POST for an in-stock item after delivery does not email twice', async (t) => {
  const s = await stack(t);
  const first = await postRequest(s.url, 'retry@example.com', 'INSTOCK-1');
  assert.equal(first.status, 201);
  await until(() => s.sent.length === 1);
  await until(() => s.store.statusCounts().notified === 1);
  // Same customer, same SKU, same uninterrupted stock episode: a client retry or a double submit.
  await postRequest(s.url, 'retry@example.com', 'INSTOCK-1');
  await sleep(500);
  assert.equal(s.sent.length, 1, `emails to one customer for one restock: ${s.sent.length}`);
});

test('QA-D4 a long Retry-After does not turn into failed without a second attempt', async (t) => {
  const s = await stack(t);
  s.emailReply.value = (_e, n) =>
    n === 1
      ? { status: 429, headers: { 'retry-after': '86400' }, body: { name: 'rate_limit_exceeded' } }
      : { status: 200, body: { id: 'ok' } };
  const { id } = (await (await postRequest(s.url, 'ra@example.com', 'RA-1')).json()) as {
    id: string;
  };
  await until(() => s.sent.length === 1);
  await until(() => s.store.getRequest(id)?.status === 'queued');
  // Retried within the 1h cap, well before the 23h window ends, despite the 24h Retry-After.
  s.now.offsetMs = HOUR + 5000;
  await until(() => ['notified', 'failed'].includes(s.store.getRequest(id)?.status ?? ''));
  const row = s.store.getRequest(id);
  assert.equal(
    row?.status,
    'notified',
    `status=${row?.status} attempts=${row?.attempts} error=${row?.lastError}`,
  );
});

for (const status of [408, 425]) {
  test(`QA-D6 HTTP ${status} from the provider is transient and retried`, async (t) => {
    const s = await stack(t);
    s.emailReply.value = (_e, n) =>
      n === 1 ? { status, body: {} } : { status: 200, body: { id: 'ok' } };
    const { id } = (await (await postRequest(s.url, `s${status}@example.com`, 'T-1')).json()) as {
      id: string;
    };
    await until(() => s.sent.length === 1);
    await until(() => ['queued', 'failed'].includes(s.store.getRequest(id)?.status ?? ''));
    const row = s.store.getRequest(id);
    assert.equal(row?.status, 'queued', `status=${row?.status} error=${row?.lastError}`);
  });
}

test('QA-D7 customers typing a SKU in different case are both served by a case-sensitive stock API', async (t) => {
  const s = await stack(t);
  // The harness behaves like this for a hand-set mixed-case SKU: only the exact spelling or its
  // upper-case form resolves.
  let restocked = false;
  s.stockBody.value = (sku) => ({
    body:
      restocked && sku === 'Mixed-1'
        ? { quantity: 5, in_stock: true }
        : { quantity: 0, in_stock: false },
  });
  const a = (await (await postRequest(s.url, 'exact@example.com', 'Mixed-1')).json()) as {
    id: string;
  };
  await sleep(60);
  await postRequest(s.url, 'lower@example.com', 'mixed-1');
  await sleep(100);
  restocked = true; // No webhook: the reconciler is the only way to find out.
  const ok = await until(() => s.store.getRequest(a.id)?.status === 'notified', 2000);
  assert.ok(
    ok,
    `exact-spelling customer status=${s.store.getRequest(a.id)?.status}, queried: ${[...new Set(s.stockCalls)].join(',')}, last=${s.stockCalls.at(-1)}`,
  );
});

test('QA-S1 one event 40 times at once: one record, all 2xx, one email per customer', async (t) => {
  const s = await stack(t);
  s.stockBody.value = () => ({ body: { quantity: 0, in_stock: false } });
  const emails = ['c1@example.com', 'c2@example.com', 'c3@example.com'];
  await Promise.all(emails.map((e) => postRequest(s.url, e, 'CONC-1')));
  await sleep(100);
  s.stockBody.value = () => ({ body: { quantity: 7, in_stock: true } });
  const rs = await Promise.all(
    Array.from({ length: 40 }, () =>
      postWebhook(s.url, { event_id: 'dup', sku: 'CONC-1', quantity: 7 }),
    ),
  );
  assert.ok(rs.every((r) => r.status === 200));
  const bodies = (await Promise.all(rs.map((r) => r.json()))) as { duplicate: boolean }[];
  assert.equal(bodies.filter((b) => !b.duplicate).length, 1);
  await until(() => s.store.statusCounts().notified === 3);
  await sleep(300);
  assert.deepEqual(s.sent.map((e) => e.body.to[0]).sort(), emails);
  assert.equal(new Set(s.sent.map((e) => e.key)).size, 3);
});

test('QA-S2 concurrent POSTs of one request create one row', async (t) => {
  const s = await stack(t);
  s.stockBody.value = () => ({ body: { quantity: 0, in_stock: false } });
  const rs = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      postRequest(
        s.url,
        i % 2 ? 'SAME@example.com ' : 'same@example.com',
        i % 3 ? 'abc-1' : 'ABC-1',
      ),
    ),
  );
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.equal(rs.filter((r) => r.status === 200).length, 39);
  assert.equal(s.store.listRequests({ limit: 100, offset: 0 }).total, 1);
});

test('QA-S3 a phantom webhook sends nothing, and the real restock later is found with no webhook', async (t) => {
  const s = await stack(t);
  s.stockBody.value = () => ({ body: { quantity: 0, in_stock: false } });
  const { id } = (await (await postRequest(s.url, 'p@example.com', 'PH-1')).json()) as {
    id: string;
  };
  await postWebhook(s.url, { event_id: 'ph', sku: 'PH-1', quantity: 12 });
  await sleep(300);
  assert.equal(s.sent.length, 0);
  s.stockBody.value = () => ({ body: { quantity: 2, in_stock: true } });
  assert.ok(await until(() => s.store.getRequest(id)?.status === 'notified', 3000));
  assert.equal(s.sent.length, 1);
});

test('QA-S4 sold out at reverify goes back to open, then the reconciler sends exactly one', async (t) => {
  const s = await stack(t, { stockFreshnessMs: -1 });
  let phase = 0;
  s.stockBody.value = () => {
    phase += 1;
    // 1st read (check): in stock. 2nd read (worker reverify): sold out. Then in stock again.
    return {
      body: phase === 2 ? { quantity: 0, in_stock: false } : { quantity: 3, in_stock: true },
    };
  };
  const { id } = (await (await postRequest(s.url, 'h@example.com', 'HOLD-1')).json()) as {
    id: string;
  };
  assert.ok(await until(() => s.store.getRequest(id)?.status === 'notified', 3000));
  await sleep(300);
  assert.equal(s.sent.length, 1);
  assert.ok(phase >= 3, 'row must have been held and re-verified');
});

test('QA-S5 timeout then retry uses the same key and a byte-identical body', async (t) => {
  const s = await stack(t);
  s.emailReply.value = (_e, n) =>
    n === 1 ? { status: 503, body: {} } : { status: 200, body: { id: 'ok' } };
  const { id } = (await (await postRequest(s.url, 'k@example.com', 'KEY-1')).json()) as {
    id: string;
  };
  await until(() => s.sent.length === 1);
  await until(() => s.store.getRequest(id)?.status === 'queued');
  s.now.offsetMs = 10_000;
  // The stock answer changing must not change the payload of a retry under the same key.
  s.stockBody.value = () => ({
    body: { quantity: 5, in_stock: true, name: 'Renamed', price: 99, currency: 'USD' },
  });
  assert.ok(await until(() => s.store.getRequest(id)?.status === 'notified', 3000));
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0]?.key, s.sent[1]?.key);
  assert.equal(s.sent[0]?.raw, s.sent[1]?.raw);
});

test('QA-S6 held row after a clean refusal keeps nothing stale, and sends once after the next restock', async (t) => {
  const s = await stack(t, { stockFreshnessMs: 50 });
  let inStock = true;
  s.stockBody.value = () => ({
    body: inStock ? { quantity: 2, in_stock: true } : { quantity: 0, in_stock: false },
  });
  s.emailReply.value = (_e, n) =>
    n === 1 ? { status: 500, body: {} } : { status: 200, body: { id: 'ok' } };
  const { id } = (await (await postRequest(s.url, 'r@example.com', 'REF-1')).json()) as {
    id: string;
  };
  await until(() => s.sent.length === 1);
  await until(() => s.store.getRequest(id)?.status === 'queued');
  inStock = false;
  s.now.offsetMs = 10_000;
  await until(() => s.store.getRequest(id)?.status === 'open');
  const held = s.store.getRequest(id);
  assert.equal(held?.status, 'open');
  assert.equal(held?.attempts, 0);
  await sleep(300);
  assert.equal(s.sent.length, 1);
  inStock = true;
  assert.ok(await until(() => s.store.getRequest(id)?.status === 'notified', 3000));
  assert.equal(s.sent.length, 2);
});

test('QA-S7 stalled 2xx body from the provider still records notified', async (t) => {
  const s = await stack(t);
  s.emailReply.value = () => ({ status: 200, body: { id: 'x' } });
  const { id } = (await (await postRequest(s.url, 'st@example.com', 'ST-1')).json()) as {
    id: string;
  };
  assert.ok(await until(() => s.store.getRequest(id)?.status === 'notified', 2000));
  assert.equal(s.store.getRequest(id)?.providerId, 'x');
});

test('QA-S8 no PII or secret reaches the logs across a send, a refusal and bad input', async (t) => {
  const s = await stack(t);
  s.emailReply.value = (_e, n) =>
    n === 1
      ? { status: 422, body: { name: 'validation_error', message: 'bad leak-me@example.com' } }
      : { status: 200, body: { id: 'ok' } };
  await postRequest(s.url, 'leak-me@example.com', 'LOG-1');
  await postRequest(s.url, 'leak-too@example.com', 'LOG-2');
  await fetch(`${s.url}/admin?q=leak-me@example.com`, { headers: { accept: 'application/json' } });
  await postWebhook(s.url, { event_id: 'e', sku: 'bad sku', quantity: 1 }, 'WRONG-SECRET');
  await until(() => s.store.statusCounts().notified >= 1);
  const text = JSON.stringify(s.logs);
  assert.ok(text.length > 10);
  for (const needle of [
    'leak-me',
    'leak-too',
    'WRONG-SECRET',
    'qa-admin-password',
    'qa-webhook-secret',
  ]) {
    assert.ok(!text.includes(needle), `log contains ${needle}`);
  }
});
