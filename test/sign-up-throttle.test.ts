import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AppConfig, DEFAULT_TIMINGS } from '../src/contracts.ts';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';
import { createApp } from '../src/http/app.ts';
import { NEW_REQUESTS_PER_MINUTE } from '../src/http/routes/requests.ts';

const CONFIG: AppConfig = {
  port: 0,
  dataDir: './unused',
  stockApiUrl: 'http://stock.invalid',
  stockApiKey: 'k',
  resendApiKey: 'k',
  resendBaseUrl: 'http://mail.invalid',
  webhookSecret: 'webhook-secret-value',
  adminPassword: 'admin-password-value',
  emailFrom: 'from@example.com',
  productUrlTemplate: null,
  logLevel: 'silent',
  trustProxyHops: 0,
  timings: DEFAULT_TIMINGS,
};

function setup(trustProxyHops = 0) {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const db = openDatabase(':memory:');
  const store = createStore({ db, clock, leaseMs: 60_000 });
  const app = createApp({
    config: { ...CONFIG, trustProxyHops },
    store,
    stock: { getStock: async () => assert.fail(), getCatalogue: async () => [] },
    clock,
    logger: { info() {}, warn() {}, error() {} },
    views: { renderEmbed: () => '', renderLogin: () => '', renderAdmin: () => '' },
    wake: { stockChecks() {} },
  });
  const post = (email: string, headers: Record<string, string> = {}, sku = 'SKU-1') =>
    app.inject({
      method: 'POST',
      url: '/api/requests',
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({ email, sku }),
    });
  const fill = async (headers: Record<string, string> = {}) => {
    for (let i = 0; i < NEW_REQUESTS_PER_MINUTE; i++) {
      assert.equal((await post(`c${i}@example.com`, headers)).statusCode, 201);
    }
  };
  return {
    app,
    post,
    fill,
    close: async () => {
      await app.close();
      db.close();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('too many new requests from one address get a 429 with Retry-After, then recover', async (t) => {
  const { post, fill, advance, close } = setup();
  t.after(close);
  await fill();
  const blocked = await post('next@example.com');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error.code, 'too_many_requests');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  advance(61_000);
  assert.equal((await post('next@example.com')).statusCode, 201);
});

test('duplicates do not count, so retries cannot use up the allowance', async (t) => {
  const { post, close } = setup();
  t.after(close);
  assert.equal((await post('same@example.com')).statusCode, 201);
  for (let i = 0; i < NEW_REQUESTS_PER_MINUTE + 5; i++) {
    assert.equal((await post('same@example.com')).statusCode, 200);
  }
});

test('someone already on the list still gets a 200 while the address is limited', async (t) => {
  const { post, fill, close } = setup();
  t.after(close);
  await fill();
  const again = await post('c0@example.com');
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().duplicate, true);
});

test('X-Forwarded-For is ignored by default, so it cannot dodge the limit', async (t) => {
  const { post, fill, close } = setup();
  t.after(close);
  await fill();
  const spoofed = await post('next@example.com', { 'x-forwarded-for': '198.51.100.9' });
  assert.equal(spoofed.statusCode, 429);
});

test('with TRUST_PROXY, visitors behind the proxy have separate allowances', async (t) => {
  const { post, fill, close } = setup(1);
  t.after(close);
  await fill({ 'x-forwarded-for': '198.51.100.1' });
  const sameVisitor = await post('a@example.com', { 'x-forwarded-for': '198.51.100.1' });
  assert.equal(sameVisitor.statusCode, 429);
  const otherVisitor = await post('a@example.com', { 'x-forwarded-for': '198.51.100.2' });
  assert.equal(otherVisitor.statusCode, 201);
});

test('with TRUST_PROXY, failed logins lock out only that visitor', async (t) => {
  const { app, close } = setup(1);
  t.after(close);
  const tryPassword = (password: string, ip: string) =>
    app.inject({
      url: '/admin',
      headers: {
        accept: 'application/json',
        'x-forwarded-for': ip,
        authorization: `Basic ${Buffer.from(`a:${password}`).toString('base64')}`,
      },
    });
  for (let i = 0; i < 10; i++) {
    assert.equal((await tryPassword('wrong', '198.51.100.1')).statusCode, 401);
  }
  assert.equal((await tryPassword('wrong', '198.51.100.1')).statusCode, 429);
  assert.equal((await tryPassword(CONFIG.adminPassword, '198.51.100.2')).statusCode, 200);
});
