import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  type AppConfig,
  type CatalogueItem,
  DEFAULT_TIMINGS,
  type Logger,
  type StockClient,
  type Store,
} from '../src/contracts.ts';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';
import { createApp } from '../src/http/app.ts';
import { createLoginThrottle } from '../src/http/auth.ts';
import { createCatalogueCache } from '../src/http/routes/embed.ts';

const WEBHOOK_SECRET = 'webhook-secret-value';
const ADMIN_PASSWORD = 'admin-password-value';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const JSON_HEADERS = { 'content-type': 'application/json' };
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };
const HTML_ACCEPT = { accept: 'text/html,application/xhtml+xml' };
const CATALOGUE: CatalogueItem[] = [
  { sku: 'Listed-1', available: false, name: 'Listed product', price: 12, currency: 'USD' },
];

const CONFIG: AppConfig = {
  port: 0,
  dataDir: './unused',
  stockApiUrl: 'http://stock.invalid',
  stockApiKey: 'stock-key',
  resendApiKey: 'resend-key',
  resendBaseUrl: 'http://mail.invalid',
  webhookSecret: WEBHOOK_SECRET,
  adminPassword: ADMIN_PASSWORD,
  emailFrom: 'from@example.com',
  productUrlTemplate: null,
  logLevel: 'info',
  timings: DEFAULT_TIMINGS,
};

function setup(t: TestContext, overrides: { stock?: Partial<StockClient>; store?: Store } = {}) {
  let now = START;
  const clock = () => new Date(now);
  const db = openDatabase(':memory:');
  const store = overrides.store ?? createStore({ db, clock, leaseMs: 60_000 });
  const logs: { level: string; obj: object; msg?: string }[] = [];
  const logger: Logger = {
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  const calls = { getStock: 0, getCatalogue: 0, wakes: 0 };
  const stock: StockClient = {
    getStock: async () => {
      calls.getStock += 1;
      return { kind: 'error', error: 'must not be called' };
    },
    getCatalogue: async () => {
      calls.getCatalogue += 1;
      return CATALOGUE;
    },
    ...overrides.stock,
  };
  // Stubs print their model, which lets tests assert exactly what a view was given.
  const views = {
    renderEmbed: (model: object) => `<!doctype html>EMBED${JSON.stringify(model)}`,
    renderLogin: (model: object) => `<!doctype html>LOGIN${JSON.stringify(model)}`,
    renderAdmin: (model: object) => `<!doctype html>ADMIN${JSON.stringify(model)}`,
  };
  const app = createApp({
    config: CONFIG,
    store,
    stock,
    clock,
    logger,
    views: views as never,
    wake: {
      stockChecks: () => {
        calls.wakes += 1;
      },
    },
  });
  t.after(async () => {
    await app.close();
    if (db.isOpen) db.close();
  });
  return {
    app,
    store,
    db,
    logs,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const postRequest = (app: FastifyInstance, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/requests',
    headers: JSON_HEADERS,
    payload: JSON.stringify(body),
  });

const postWebhook = (app: FastifyInstance, body: unknown, secret: string | null = WEBHOOK_SECRET) =>
  app.inject({
    method: 'POST',
    url: '/webhooks/stock',
    headers: { ...JSON_HEADERS, ...(secret === null ? {} : { 'x-webhook-secret': secret }) },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });

const login = (app: FastifyInstance, password: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: { ...FORM_HEADERS, ...headers },
    payload: new URLSearchParams({ password }).toString(),
  });

const basic = (password: string, user = 'anyone'): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  return (header as string).split(';')[0] as string;
}

const count = (db: ReturnType<typeof openDatabase>, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function assertBaseline(headers: Record<string, unknown>): void {
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
}

function assertAdminHeaders(headers: Record<string, unknown>): void {
  assertBaseline(headers);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-frame-options'], 'DENY');
  const csp = String(headers['content-security-policy']);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /img-src https: data:/);
  assert.match(csp, /script-src 'nonce-[^']+'/);
}

// ---------- basics ----------

test('GET / redirects to /embed', async (t) => {
  const { app } = setup(t);
  const response = await app.inject({ url: '/' });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/embed');
  assertBaseline(response.headers);
});

test('GET /healthz reports the store', async (t) => {
  const { app } = setup(t);
  const response = await app.inject({ url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  assertBaseline(response.headers);
});

test('GET /healthz is 503 when the store is down', async (t) => {
  const { app, db } = setup(t);
  db.close();
  const response = await app.inject({ url: '/healthz' });
  assert.equal(response.statusCode, 503);
  assert.notEqual(response.json().status, 'ok');
});

test('unknown routes get a JSON 404 with baseline headers', async (t) => {
  const { app } = setup(t);
  const response = await app.inject({ url: '/nope' });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'not_found');
  assertBaseline(response.headers);
  assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
});

test('undecodable URLs get a JSON 400 with baseline headers', async (t) => {
  const { app } = setup(t);
  const response = await app.inject({ url: '/admin/requests/%E0%A4%A/retry', method: 'POST' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'bad_request');
  assertBaseline(response.headers);
});

test('logs the route pattern, never the query string or raw URL', async (t) => {
  const { app, logs, store } = setup(t);
  store.createRequest({ email: 'secret-customer@example.com', sku: 'X1' });
  await app.inject({ url: '/embed?sku=SECRETSKU&email=secret-customer@example.com' });
  await app.inject({ url: '/nope?token=secret-token' });
  const id = store.listRequests({ limit: 1, offset: 0 }).rows[0]?.id;
  await app.inject({
    method: 'POST',
    url: `/admin/requests/${id}/retry?x=secret-q`,
    headers: { authorization: basic(ADMIN_PASSWORD) },
  });

  const lines = logs.filter((line) => line.msg === 'request').map((line) => line.obj);
  assert.deepEqual(
    lines.map((line) => ({ ...line, ms: 0 })),
    [
      { method: 'GET', route: '/embed', status: 200, ms: 0 },
      { method: 'GET', route: null, status: 404, ms: 0 },
      { method: 'POST', route: '/admin/requests/:id/retry', status: 303, ms: 0 },
    ],
  );
  const everything = JSON.stringify(logs);
  for (const secret of ['SECRETSKU', 'secret-customer', 'secret-token', 'secret-q', id as string]) {
    assert.ok(!everything.includes(secret), secret);
  }
});

test('an unknown error is a generic 500, logged without its message or the body', async (t) => {
  const db = openDatabase(':memory:');
  const real = createStore({ db, clock: () => new Date(START), leaseMs: 60_000 });
  t.after(() => db.close());
  const broken: Store = {
    ...real,
    createRequest: () => {
      throw new Error('sensitive internal detail');
    },
  };
  const { app, logs } = setup(t, { store: broken });
  const response = await postRequest(app, { email: 'customer@example.com', sku: 'X1' });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.code, 'internal_error');
  assert.ok(!response.body.includes('sensitive'));
  assertBaseline(response.headers);
  const everything = JSON.stringify(logs);
  assert.ok(logs.some((line) => line.level === 'error'));
  assert.ok(!everything.includes('sensitive'));
  assert.ok(!everything.includes('customer@example.com'));
});

// ---------- embed ----------

test('embed: framable by anyone, nonce CSP, no cookie', async (t) => {
  const { app } = setup(t);
  const first = await app.inject({ url: '/embed' });
  const second = await app.inject({ url: '/embed' });
  assert.equal(first.statusCode, 200);
  assert.match(String(first.headers['content-type']), /^text\/html/);
  assertBaseline(first.headers);
  assert.equal(first.headers['x-frame-options'], undefined);
  assert.equal(first.headers['set-cookie'], undefined);

  const nonce = /'nonce-([^']+)'/.exec(String(first.headers['content-security-policy']))?.[1];
  assert.ok(nonce);
  assert.equal(
    first.headers['content-security-policy'],
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors *`,
  );
  assert.ok(first.body.includes(`"nonce":"${nonce}"`));
  assert.notEqual(
    first.headers['content-security-policy'],
    second.headers['content-security-policy'],
  );
});

test('embed: a listed ?sku= takes its product from the catalogue, without getStock', async (t) => {
  const { app, calls } = setup(t);
  const response = await app.inject({ url: '/embed?sku=listed-1' });
  assert.ok(response.body.includes('"sku":"listed-1"'));
  assert.ok(
    response.body.includes('"product":{"name":"Listed product","price":12,"currency":"USD"}'),
  );
  assert.equal(calls.getStock, 0);
});

test('embed: an unlisted ?sku= has no product and still does not call getStock', async (t) => {
  const { app, calls } = setup(t);
  const response = await app.inject({ url: '/embed?sku=NOT-LISTED' });
  assert.ok(response.body.includes('"sku":"NOT-LISTED"'));
  assert.ok(response.body.includes('"product":null'));
  assert.equal(calls.getStock, 0);
});

test('embed: invalid ?sku= is ignored', async (t) => {
  const { app } = setup(t);
  for (const query of ['sku=%3Cscript%3Ealert(1)%3C/script%3E', 'sku=a&sku=b', 'sku=']) {
    const response = await app.inject({ url: `/embed?${query}` });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('"sku":null'), query);
    assert.ok(!response.body.includes('script>'), query);
  }
});

test('embed: renders with an empty catalogue when the stock API fails', async (t) => {
  for (const getCatalogue of [
    async () => [],
    async () => {
      throw new Error('down');
    },
  ]) {
    const { app } = setup(t, { stock: { getCatalogue } });
    const response = await app.inject({ url: '/embed' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('"catalogue":[]'));
  }
});

test('embed: never waits more than about 1500ms on a hung stock API', async (t) => {
  const { app } = setup(t, { stock: { getCatalogue: () => new Promise(() => {}) } });
  const started = Date.now();
  const response = await app.inject({ url: '/embed' });
  const elapsed = Date.now() - started;
  assert.equal(response.statusCode, 200);
  assert.ok(response.body.includes('"catalogue":[]'));
  assert.ok(elapsed >= 1400 && elapsed < 3000, `took ${elapsed}ms`);
});

test('catalogue cache: TTL, stale on failure, a single refresh at a time', async () => {
  let now = START;
  let answer: () => Promise<CatalogueItem[]> = async () => CATALOGUE;
  let loads = 0;
  const cache = createCatalogueCache({
    clock: () => new Date(now),
    logger: { info() {}, warn() {}, error() {} },
    stock: {
      getStock: async () => assert.fail('not used'),
      getCatalogue: () => {
        loads += 1;
        return answer();
      },
    },
  });

  assert.deepEqual(await cache.get(), CATALOGUE);
  assert.equal(loads, 1);

  now += 59_000;
  await cache.get();
  assert.equal(loads, 1, 'still fresh');

  now += 2_000;
  answer = async () => [];
  assert.deepEqual(await cache.get(), CATALOGUE, 'empty answer keeps stale data');
  assert.equal(loads, 2);

  answer = async () => {
    throw new Error('down');
  };
  now += 11_000;
  assert.deepEqual(await cache.get(), CATALOGUE, 'thrown error keeps stale data');
  assert.equal(loads, 3);

  now += 1_000;
  await cache.get();
  assert.equal(loads, 3, 'failures are not retried on every page load');

  now += 11_000;
  let release: (items: CatalogueItem[]) => void = () => {};
  answer = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const replacement: CatalogueItem[] = [{ sku: 'NEW', available: true }];
  const pending = Promise.all(Array.from({ length: 20 }, () => cache.get()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 4, 'concurrent callers share one refresh');
  release(replacement);
  for (const items of await pending) assert.deepEqual(items, replacement);
});

// ---------- POST /api/requests ----------

test('requests: valid inputs create a row', async (t) => {
  const cases: [unknown, string, string][] = [
    [{ email: 'a@example.com', sku: 'SKU-1' }, 'a@example.com', 'SKU-1'],
    [{ email: '  Mixed@Example.COM ', sku: ' sku_2.x ' }, 'mixed@example.com', 'sku_2.x'],
    [
      { email: 'b@example.com', sku: 'UNKNOWN-SKU', extra: 'ignored' },
      'b@example.com',
      'UNKNOWN-SKU',
    ],
  ];
  const { app, calls, store } = setup(t);
  let wakes = 0;
  for (const [body, email, sku] of cases) {
    const response = await postRequest(app, body);
    assert.equal(response.statusCode, 201);
    const json = response.json();
    assert.deepEqual(
      { ...json, id: 'x' },
      { id: 'x', email, sku, status: 'open', duplicate: false },
    );
    assert.equal(store.getRequest(json.id)?.email, email);
    wakes += 1;
    assert.equal(calls.wakes, wakes);
  }
  assert.equal(calls.getStock, 0);
  assert.equal(calls.getCatalogue, 0);
});

test('requests: invalid inputs give 400 with the field and write nothing', async (t) => {
  const cases: [unknown, string][] = [
    [{}, 'email'],
    [[], 'body'],
    ['text', 'body'],
    [5, 'body'],
    [null, 'body'],
    [{ sku: 'X1' }, 'email'],
    [{ email: 'a@example.com' }, 'sku'],
    [{ email: 'not-an-email', sku: 'X1' }, 'email'],
    [{ email: ['a@example.com'], sku: 'X1' }, 'email'],
    [{ email: 5, sku: 'X1' }, 'email'],
    [{ email: { a: 1 }, sku: 'X1' }, 'email'],
    [{ email: 'a@example.com', sku: ['X1'] }, 'sku'],
    [{ email: 'a@example.com', sku: 5 }, 'sku'],
    [{ email: 'a@example.com', sku: '<script>alert(1)</script>' }, 'sku'],
    [{ email: 'a@example.com', sku: '"><img src=x onerror=alert(1)>' }, 'sku'],
    [{ email: 'a@example.com', sku: 'A'.repeat(65) }, 'sku'],
    [{ email: `${'a'.repeat(250)}@example.com`, sku: 'X1' }, 'email'],
  ];
  const { app, db, calls } = setup(t);
  for (const [body, field] of cases) {
    const response = await postRequest(app, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    const { error } = response.json();
    assert.equal(error.code, 'invalid_request');
    assert.equal(error.field, field, JSON.stringify(body));
    assert.ok(error.message.length > 0);
    assert.ok(!response.body.includes('<script'));
  }
  assert.equal(count(db, 'requests'), 0);
  assert.equal(calls.wakes, 0);
});

test('requests: a duplicate open request is 200 with one row and no wake', async (t) => {
  const { app, db, calls } = setup(t);
  const first = await postRequest(app, { email: 'a@example.com', sku: 'X1' });
  const second = await postRequest(app, { email: 'a@example.com', sku: 'X1' });
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().duplicate, true);
  assert.equal(second.json().id, first.json().id);
  assert.equal(count(db, 'requests'), 1);
  assert.equal(calls.wakes, 1);
});

test('requests: email and SKU case and whitespace fold to one request', async (t) => {
  const { app, db } = setup(t);
  await postRequest(app, { email: 'a@example.com', sku: 'Sku-1' });
  const variants = [
    { email: ' A@EXAMPLE.com ', sku: 'Sku-1' },
    { email: 'a@example.com', sku: ' SKU-1 ' },
    { email: 'A@example.COM', sku: 'sku-1' },
  ];
  for (const body of variants) {
    const response = await postRequest(app, body);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().duplicate, true);
    assert.equal(response.json().sku, 'Sku-1');
  }
  assert.equal(count(db, 'requests'), 1);
});

test('requests: 50 concurrent identical posts yield one row', async (t) => {
  const { app, db, calls } = setup(t);
  const responses = await Promise.all(
    Array.from({ length: 50 }, () => postRequest(app, { email: 'a@example.com', sku: 'X1' })),
  );
  const codes = responses.map((response) => response.statusCode);
  assert.equal(codes.filter((code) => code === 201).length, 1);
  assert.equal(codes.filter((code) => code === 200).length, 49);
  assert.equal(new Set(responses.map((response) => response.json().id)).size, 1);
  assert.equal(count(db, 'requests'), 1);
  assert.equal(calls.wakes, 1);
});

test('requests: bad JSON 400, too large 413, non-JSON 415, all readable cross-origin', async (t) => {
  const { app, db } = setup(t);
  const cases: [string, Record<string, string>, string, number][] = [
    ['bad json', JSON_HEADERS, '{"email":', 400],
    ['empty json', JSON_HEADERS, '', 400],
    ['proto', JSON_HEADERS, '{"__proto__":{"a":1},"email":"a@b.co","sku":"x"}', 400],
    ['too large', JSON_HEADERS, JSON.stringify({ email: 'a'.repeat(20_000) }), 413],
    ['text/plain', { 'content-type': 'text/plain' }, '{"email":"a@b.co","sku":"x"}', 415],
    ['form', FORM_HEADERS, 'email=a%40b.co&sku=x', 415],
    ['xml', { 'content-type': 'application/xml' }, '<a/>', 415],
  ];
  for (const [label, headers, payload, status] of cases) {
    const response = await app.inject({ method: 'POST', url: '/api/requests', headers, payload });
    assert.equal(response.statusCode, status, label);
    assert.equal(typeof response.json().error.code, 'string', label);
    assert.equal(typeof response.json().error.message, 'string', label);
    assert.equal(response.headers['access-control-allow-origin'], '*', label);
    assertBaseline(response.headers);
  }
  assert.equal(count(db, 'requests'), 0);
});

test('requests: CORS allows any origin, without credentials', async (t) => {
  const { app } = setup(t);
  const preflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/requests',
    headers: {
      origin: 'https://store.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.match(String(preflight.headers['access-control-allow-methods']), /POST/);
  assert.match(String(preflight.headers['access-control-allow-headers']), /content-type/i);
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);

  const post = await postRequest(app, { email: 'a@example.com', sku: 'X1' });
  assert.equal(post.headers['access-control-allow-origin'], '*');
  assert.equal(post.headers['access-control-allow-credentials'], undefined);
  const invalid = await postRequest(app, {});
  assert.equal(invalid.headers['access-control-allow-origin'], '*');
});

// ---------- POST /webhooks/stock ----------

const EVENT = { event_id: 'evt_1', sku: 'Sku-1', quantity: 3, type: 'stock.updated' };

test('webhook: records the event, wakes, then treats a retry as a duplicate', async (t) => {
  const { app, store, calls, db } = setup(t);
  const first = await postWebhook(app, EVENT);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { received: true, duplicate: false });
  assert.equal(calls.wakes, 1);
  assert.equal(calls.getStock, 0);

  const retry = await postWebhook(app, EVENT);
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.json(), { received: true, duplicate: true });
  assert.equal(calls.wakes, 1);
  assert.equal(count(db, 'webhook_events'), 1);
  assert.equal(store.listRecentWebhookEvents(1)[0]?.quantity, 3);
});

test('webhook: missing or wrong secret is 401 and records nothing', async (t) => {
  const { app, db, calls } = setup(t);
  for (const secret of [null, '', 'wrong', `${WEBHOOK_SECRET}x`, WEBHOOK_SECRET.slice(0, -1)]) {
    const response = await postWebhook(app, EVENT, secret);
    assert.equal(response.statusCode, 401, String(secret));
    assert.equal(response.json().error.code, 'unauthorized');
  }
  assert.equal(count(db, 'webhook_events'), 0);
  assert.equal(calls.wakes, 0);
});

test('webhook: a wrong secret is 401 whatever the body looks like', async (t) => {
  const { app } = setup(t);
  const cases: [Record<string, string>, string][] = [
    [JSON_HEADERS, '{"bad json'],
    [JSON_HEADERS, ''],
    [JSON_HEADERS, 'x'.repeat(20_000)],
    [{ 'content-type': 'text/xml' }, '<a/>'],
    [JSON_HEADERS, JSON.stringify({ event_id: '' })],
  ];
  for (const [headers, payload] of cases) {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/stock',
      headers: { ...headers, 'x-webhook-secret': 'wrong' },
      payload,
    });
    assert.equal(response.statusCode, 401);
  }
});

test('webhook: invalid payloads with the right secret are 400', async (t) => {
  const { app, db, calls } = setup(t);
  const cases: [unknown, string][] = [
    [{ sku: 'X', quantity: 1 }, 'event_id'],
    [{ event_id: '', sku: 'X', quantity: 1 }, 'event_id'],
    [{ event_id: 5, sku: 'X', quantity: 1 }, 'event_id'],
    [{ event_id: 'a\u0000b', sku: 'X', quantity: 1 }, 'event_id'],
    [{ event_id: 'e'.repeat(256), sku: 'X', quantity: 1 }, 'event_id'],
    [{ event_id: 'e', quantity: 1 }, 'sku'],
    [{ event_id: 'e', sku: '<x>', quantity: 1 }, 'sku'],
    [{ event_id: 'e', sku: 'X' }, 'quantity'],
    [{ event_id: 'e', sku: 'X', quantity: '5' }, 'quantity'],
    [{ event_id: 'e', sku: 'X', quantity: -1 }, 'quantity'],
    [{ event_id: 'e', sku: 'X', quantity: 1.5 }, 'quantity'],
    [[], 'body'],
  ];
  for (const [body, field] of cases) {
    const response = await postWebhook(app, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.json().error.code, 'invalid_request');
    assert.equal(response.json().error.field, field);
  }
  assert.equal((await postWebhook(app, '{bad')).statusCode, 400);
  assert.equal(count(db, 'webhook_events'), 0);
  assert.equal(calls.wakes, 0);
});

test('webhook: 50 concurrent deliveries give one event and all 2xx', async (t) => {
  const { app, db, calls } = setup(t);
  const responses = await Promise.all(Array.from({ length: 50 }, () => postWebhook(app, EVENT)));
  for (const response of responses) assert.equal(response.statusCode, 200);
  const fresh = responses.filter((response) => !response.json().duplicate);
  assert.equal(fresh.length, 1);
  assert.equal(count(db, 'webhook_events'), 1);
  assert.equal(calls.wakes, 1);
});

// ---------- admin auth ----------

test('admin: no auth from a browser gets the login page and no native dialog', async (t) => {
  const { app, store } = setup(t);
  store.createRequest({ email: 'private@example.com', sku: 'PRIVATE-SKU' });
  const response = await app.inject({ url: '/admin', headers: HTML_ACCEPT });
  assert.equal(response.statusCode, 401);
  assert.match(String(response.headers['content-type']), /^text\/html/);
  assert.ok(response.body.includes('LOGIN'));
  assert.equal(response.headers['www-authenticate'], undefined);
  assertAdminHeaders(response.headers);
  assert.ok(!response.body.includes('private@example.com'));
  assert.ok(!response.body.includes('PRIVATE-SKU'));
});

test('admin: no auth from a non-browser gets a Basic challenge and JSON', async (t) => {
  const { app, store } = setup(t);
  store.createRequest({ email: 'private@example.com', sku: 'PRIVATE-SKU' });
  const response = await app.inject({ url: '/admin', headers: { accept: 'application/json' } });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['www-authenticate'], 'Basic realm="admin"');
  assert.equal(response.json().error.code, 'unauthorized');
  assertAdminHeaders(response.headers);
  assert.ok(!response.body.includes('private@example.com'));
  assert.ok(!response.body.includes('PRIVATE-SKU'));
});

test('admin: wrong Basic credentials are refused', async (t) => {
  const { app, store } = setup(t);
  store.createRequest({ email: 'private@example.com', sku: 'PRIVATE-SKU' });
  const headers = [
    basic('wrong'),
    basic(''),
    'Basic !!!',
    'Basic',
    `Basic ${Buffer.from(ADMIN_PASSWORD).toString('base64')}`, // No colon, so no password.
    `Bearer ${ADMIN_PASSWORD}`,
  ];
  for (const authorization of headers) {
    const response = await app.inject({ url: '/admin', headers: { authorization } });
    assert.equal(response.statusCode, 401, authorization);
    assert.ok(!response.body.includes('private@example.com'));
  }
});

test('admin: correct Basic with any username renders the view model', async (t) => {
  const { app, store } = setup(t);
  store.createRequest({ email: 'a@example.com', sku: 'X1' });
  store.recordWebhookEvent({ eventId: 'evt_9', sku: 'X1', quantity: 2 });
  for (const authorization of [
    basic(ADMIN_PASSWORD),
    basic(ADMIN_PASSWORD, ''),
    basic(ADMIN_PASSWORD, 'root').replace('Basic', 'basic'),
  ]) {
    const response = await app.inject({ url: '/admin', headers: { authorization } });
    assert.equal(response.statusCode, 200, authorization);
    assertAdminHeaders(response.headers);
    assert.ok(response.body.startsWith('<!doctype html>ADMIN'));
    const model = JSON.parse(response.body.slice('<!doctype html>ADMIN'.length));
    assert.equal(model.total, 1);
    assert.equal(model.rows[0].email, 'a@example.com');
    assert.equal(model.counts.open, 1);
    assert.equal(model.pageSize, 50);
    assert.equal(model.page, 1);
    assert.equal(model.status, null);
    assert.equal(model.search, '');
    assert.equal(model.events[0].eventId, 'evt_9');
    const nonce = /'nonce-([^']+)'/.exec(String(response.headers['content-security-policy']))?.[1];
    assert.equal(model.nonce, nonce);
  }
});

test('admin: query parameters filter, and invalid ones are ignored', async (t) => {
  const { app, store } = setup(t);
  store.createRequest({ email: 'alice@example.com', sku: 'X1' });
  store.createRequest({ email: 'bob@example.com', sku: 'X2' });
  const get = async (query: string) => {
    const response = await app.inject({
      url: `/admin?${query}`,
      headers: { authorization: basic(ADMIN_PASSWORD) },
    });
    assert.equal(response.statusCode, 200, query);
    return JSON.parse(response.body.slice('<!doctype html>ADMIN'.length));
  };

  assert.equal((await get('q=alice')).total, 1);
  assert.equal((await get('q=alice')).search, 'alice');
  assert.equal((await get('status=open')).status, 'open');
  assert.equal((await get('status=notified')).total, 0);

  const bogus = await get('status=bogus');
  assert.equal(bogus.status, null);
  assert.equal(bogus.total, 2);
  assert.equal((await get('status=open&status=failed')).status, null);
  assert.equal((await get('q=a&q=b')).search, '');

  const second = await get('page=2');
  assert.equal(second.page, 2);
  assert.equal(second.rows.length, 0);
  assert.equal(second.total, 2);
  for (const page of ['0', '-1', 'x', '1.5', '', '99999999999999999999']) {
    assert.equal((await get(`page=${page}`)).page, 1, page);
  }
  assert.equal((await get('page=1000000000')).page, 1000000000);
});

test('admin: login, cookie attributes, cookie access, logout', async (t) => {
  const { app } = setup(t);
  const success = await login(app, ADMIN_PASSWORD);
  assert.equal(success.statusCode, 303);
  assert.equal(success.headers.location, '/admin');
  assertAdminHeaders(success.headers);

  const setCookie = String(success.headers['set-cookie']);
  assert.match(setCookie, /^bis_admin=\d+\.[0-9a-f]{64};/);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Path=\/admin|Path=\/admin;/);
  assert.match(setCookie, /Max-Age=43200/);
  assert.doesNotMatch(setCookie, /Secure/);

  const cookie = cookieOf(success);
  const page = await app.inject({ url: '/admin', headers: { cookie } });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('ADMIN'));

  const withOthers = await app.inject({
    url: '/admin',
    headers: { cookie: `other=1; ${cookie}; another=2` },
  });
  assert.equal(withOthers.statusCode, 200);

  const logout = await app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie } });
  assert.equal(logout.statusCode, 303);
  assert.equal(logout.headers.location, '/admin');
  assertAdminHeaders(logout.headers);
  const cleared = String(logout.headers['set-cookie']);
  assert.match(cleared, /^bis_admin=;/);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Path=\/admin/);

  const afterLogout = await app.inject({
    url: '/admin',
    headers: { ...HTML_ACCEPT, cookie: cookieOf(logout) },
  });
  assert.equal(afterLogout.statusCode, 401);
});

test('admin: the session cookie is Secure only behind https', async (t) => {
  const { app } = setup(t);
  const secure = await login(app, ADMIN_PASSWORD, { 'x-forwarded-proto': 'https' });
  assert.match(String(secure.headers['set-cookie']), /; Secure/);
  const plain = await login(app, ADMIN_PASSWORD, { 'x-forwarded-proto': 'http' });
  assert.doesNotMatch(String(plain.headers['set-cookie']), /Secure/);
  const logout = await app.inject({
    method: 'POST',
    url: '/admin/logout',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.match(String(logout.headers['set-cookie']), /; Secure/);
});

test('admin: failed login shows the login page with an error and no cookie', async (t) => {
  const { app } = setup(t);
  const response = await login(app, 'wrong');
  assert.equal(response.statusCode, 401);
  assert.ok(response.body.includes('LOGIN'));
  assert.match(response.body, /"error":"[^"]+"/);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['www-authenticate'], undefined);
  assertAdminHeaders(response.headers);
});

test('admin: login accepts only a form body', async (t) => {
  const { app } = setup(t);
  const response = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: JSON_HEADERS,
    payload: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(response.statusCode, 415);
  assertAdminHeaders(response.headers);
});

test('admin: tampered cookies are refused', async (t) => {
  const { app, store } = setup(t);
  store.createRequest({ email: 'private@example.com', sku: 'PRIVATE-SKU' });
  const cookie = cookieOf(await login(app, ADMIN_PASSWORD));
  const value = cookie.slice('bis_admin='.length);
  const [expiry, signature] = value.split('.') as [string, string];
  const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  const forged = [
    `${expiry}.${flipped}`,
    `${Number(expiry) + 1}.${signature}`,
    `9999999999999.${signature}`,
    expiry,
    `.${signature}`,
    `${expiry}.`,
    `${expiry}.${signature}0`,
    `${expiry}.${signature.toUpperCase()}`,
    '',
    'garbage',
  ];
  for (const candidate of forged) {
    const response = await app.inject({
      url: '/admin',
      headers: { cookie: `bis_admin=${candidate}`, ...HTML_ACCEPT },
    });
    assert.equal(response.statusCode, 401, candidate);
    assert.ok(!response.body.includes('private@example.com'), candidate);
  }
});

test('admin: a cookie signed under another password is refused', async (t) => {
  const { app } = setup(t);
  const other = createApp({
    config: { ...CONFIG, adminPassword: 'a-different-password' },
    store: setup(t).store,
    stock: { getStock: async () => assert.fail(), getCatalogue: async () => [] },
    clock: () => new Date(START),
    logger: { info() {}, warn() {}, error() {} },
    views: { renderEmbed: () => '', renderLogin: () => '', renderAdmin: () => '' },
    wake: { stockChecks() {} },
  });
  t.after(() => other.close());
  const response = await login(other, 'a-different-password');
  const page = await app.inject({ url: '/admin', headers: { cookie: cookieOf(response) } });
  assert.equal(page.statusCode, 401);
});

test('admin: sessions expire after 12 hours', async (t) => {
  const { app, advance } = setup(t);
  const cookie = cookieOf(await login(app, ADMIN_PASSWORD));
  advance(12 * HOUR - 1);
  assert.equal((await app.inject({ url: '/admin', headers: { cookie } })).statusCode, 200);
  advance(1);
  assert.equal((await app.inject({ url: '/admin', headers: { cookie } })).statusCode, 401);
});

test('admin: login is throttled per IP after 10 failures, then recovers', async (t) => {
  const { app, advance } = setup(t);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await login(app, 'wrong')).statusCode, 401, `attempt ${i}`);
  }
  const blocked = await login(app, 'wrong');
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assertAdminHeaders(blocked.headers);

  const correctWhileBlocked = await login(app, ADMIN_PASSWORD);
  assert.equal(correctWhileBlocked.statusCode, 429);
  assert.equal(correctWhileBlocked.headers['set-cookie'], undefined);

  const otherIp = await app.inject({
    method: 'POST',
    url: '/admin/login',
    headers: FORM_HEADERS,
    payload: `password=${ADMIN_PASSWORD}`,
    remoteAddress: '203.0.113.9',
  });
  assert.equal(otherIp.statusCode, 303);

  advance(5 * 60 * 1000);
  assert.equal((await login(app, ADMIN_PASSWORD)).statusCode, 303);
});

test('admin: a successful login clears earlier failures', async (t) => {
  const { app } = setup(t);
  for (let i = 0; i < 9; i += 1) await login(app, 'wrong');
  assert.equal((await login(app, ADMIN_PASSWORD)).statusCode, 303);
  for (let i = 0; i < 10; i += 1) assert.equal((await login(app, 'wrong')).statusCode, 401);
});

test('admin: Basic guesses share the throttle, but a valid session still works', async (t) => {
  const { app } = setup(t);
  const cookie = cookieOf(await login(app, ADMIN_PASSWORD));
  const guess = (password: string) =>
    app.inject({ url: '/admin', headers: { authorization: basic(password) } });
  for (let i = 0; i < 10; i += 1) assert.equal((await guess('wrong')).statusCode, 401);
  assert.equal((await guess('wrong')).statusCode, 429);
  assert.equal((await guess(ADMIN_PASSWORD)).statusCode, 429);
  assert.equal((await app.inject({ url: '/admin', headers: { cookie } })).statusCode, 200);
});

test('throttle: the map stays bounded and evicts the oldest entry', () => {
  let now = START;
  const throttle = createLoginThrottle({
    clock: () => new Date(now),
    maxFailures: 1,
    windowMs: 1000,
    maxEntries: 3,
  });
  for (const ip of ['a', 'b', 'c', 'd']) throttle.recordFailure(ip);
  assert.equal(throttle.isBlocked('a'), false, 'oldest evicted');
  for (const ip of ['b', 'c', 'd']) assert.equal(throttle.isBlocked(ip), true);
  now += 1000;
  for (const ip of ['b', 'c', 'd']) assert.equal(throttle.isBlocked(ip), false, 'window over');
  throttle.recordFailure('e');
  assert.equal(throttle.isBlocked('e'), true);
});

test('admin: retry requires auth, moves a failed row back, and redirects', async (t) => {
  const { app, store, db } = setup(t);
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'X1' });
  db.prepare("UPDATE requests SET status = 'failed' WHERE id = ?").run(request.id);
  const url = `/admin/requests/${request.id}/retry`;

  const refused = await app.inject({ method: 'POST', url, headers: FORM_HEADERS, payload: '' });
  assert.equal(refused.statusCode, 401);
  assert.equal(store.getRequest(request.id)?.status, 'failed');
  assert.ok(!refused.body.includes('a@example.com'));

  const cookie = cookieOf(await login(app, ADMIN_PASSWORD));
  const done = await app.inject({
    method: 'POST',
    url,
    headers: { ...FORM_HEADERS, cookie },
    payload: '',
  });
  assert.equal(done.statusCode, 303);
  assert.equal(done.headers.location, '/admin');
  assertAdminHeaders(done.headers);
  assert.equal(store.getRequest(request.id)?.status, 'queued');

  const unknown = await app.inject({
    method: 'POST',
    url: '/admin/requests/missing/retry',
    headers: { cookie },
  });
  assert.equal(unknown.statusCode, 303);
});

test('admin: cross-origin POSTs are blocked', async (t) => {
  const { app, store, db } = setup(t);
  const { request } = store.createRequest({ email: 'a@example.com', sku: 'X1' });
  db.prepare("UPDATE requests SET status = 'failed' WHERE id = ?").run(request.id);
  const cookie = cookieOf(await login(app, ADMIN_PASSWORD));
  const paths = ['/admin/login', '/admin/logout', `/admin/requests/${request.id}/retry`];

  for (const url of paths) {
    for (const origin of ['https://evil.example', 'null', 'not a url']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { ...FORM_HEADERS, cookie, host: 'shop.example', origin },
        payload: `password=${ADMIN_PASSWORD}`,
      });
      assert.equal(response.statusCode, 403, `${url} ${origin}`);
      assert.equal(response.json().error.code, 'forbidden');
      assert.equal(response.headers['set-cookie'], undefined);
      assertAdminHeaders(response.headers);
    }
  }
  assert.equal(store.getRequest(request.id)?.status, 'failed');
});

test('admin: same-origin POSTs and POSTs with no Origin pass', async (t) => {
  const { app } = setup(t);
  const cases: [Record<string, string>, string][] = [
    [{ host: 'shop.example', origin: 'https://shop.example' }, 'same'],
    [{ host: 'SHOP.example:443', origin: 'https://shop.example' }, 'default port and case'],
    [{ host: 'localhost:3000', origin: 'http://localhost:3000' }, 'explicit port'],
    [{ host: 'shop.example' }, 'no origin'],
  ];
  for (const [headers, label] of cases) {
    const response = await login(app, ADMIN_PASSWORD, headers);
    assert.equal(response.statusCode, 303, label);
  }
  const otherPort = await login(app, ADMIN_PASSWORD, {
    host: 'localhost:3000',
    origin: 'http://localhost:4000',
  });
  assert.equal(otherPort.statusCode, 403);
});

test('admin: unknown admin paths are a 404 with admin headers', async (t) => {
  const { app } = setup(t);
  const response = await app.inject({ url: '/admin/nope' });
  assert.equal(response.statusCode, 404);
  assertAdminHeaders(response.headers);
});

test('admin: GET /admin/login returns to /admin', async (t) => {
  const { app } = setup(t);
  const response = await app.inject({ url: '/admin/login' });
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, '/admin');
});

test('the form parser does not leak outside /admin', async (t) => {
  const { app, db } = setup(t);
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/stock',
    headers: { ...FORM_HEADERS, 'x-webhook-secret': WEBHOOK_SECRET },
    payload: 'event_id=e&sku=x&quantity=1',
  });
  assert.equal(response.statusCode, 415);
  assert.equal(count(db, 'webhook_events'), 0);
});
