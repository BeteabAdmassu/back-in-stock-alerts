// Independent QA: auth, webhook hostility, XSS and CSP, over real HTTP with the real views.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_PASSWORD,
  postRequest,
  postWebhook,
  stack,
  until,
  WEBHOOK_SECRET,
} from './qa-helpers.ts';

const basic = (password: string): string =>
  `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

test('QA-A1 every admin method and spelling needs auth', async (t) => {
  const s = await stack(t);
  await postRequest(s.url, 'secret-customer@example.com', 'A-1');
  const cases: [string, string][] = [
    ['GET', '/admin'],
    ['GET', '/admin/'],
    ['HEAD', '/admin'],
    ['GET', '/admin?x=1'],
    ['GET', '/admin/?q=secret'],
  ];
  for (const [method, path] of cases) {
    const r = await fetch(s.url + path, { method, headers: { accept: 'application/json' } });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.ok(!(await r.text()).includes('secret-customer'), `${method} ${path}`);
  }
  const retry = await fetch(`${s.url}/admin/requests/x/retry`, { method: 'POST' });
  assert.equal(retry.status, 401);
});

test('QA-A2 forged, expired-looking and truncated cookies fail', async (t) => {
  const s = await stack(t);
  for (const cookie of [
    'bis_admin=99999999999999.' + 'a'.repeat(64),
    'bis_admin=1',
    'bis_admin=',
    'bis_admin=99999999999999.',
    `other=1; bis_admin=9.${'0'.repeat(64)}`,
  ]) {
    const r = await fetch(`${s.url}/admin`, { headers: { cookie, accept: 'application/json' } });
    assert.equal(r.status, 401, cookie);
  }
});

test('QA-A3 cross-site POST is refused even with valid Basic credentials', async (t) => {
  const s = await stack(t);
  const r = await fetch(`${s.url}/admin/requests/x/retry`, {
    method: 'POST',
    headers: { authorization: basic(ADMIN_PASSWORD), origin: 'https://evil.example' },
  });
  assert.equal(r.status, 403);
  const nullOrigin = await fetch(`${s.url}/admin/requests/x/retry`, {
    method: 'POST',
    headers: { authorization: basic(ADMIN_PASSWORD), origin: 'null' },
  });
  assert.equal(nullOrigin.status, 403);
});

test('QA-A4 login sets an HttpOnly SameSite cookie that opens the page', async (t) => {
  const s = await stack(t);
  const r = await fetch(`${s.url}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    redirect: 'manual',
  });
  assert.equal(r.status, 303);
  const cookie = r.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const page = await fetch(`${s.url}/admin`, { headers: { cookie: cookie.split(';')[0] ?? '' } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store, no-transform');
});

test('QA-A6 the admin retry button works as a browser sends it, and the row is then delivered', async (t) => {
  const s = await stack(t);
  s.emailReply.value = (_e, n) =>
    n === 1
      ? { status: 422, body: { name: 'validation_error' } }
      : { status: 200, body: { id: 'ok' } };
  const { id } = (await (await postRequest(s.url, 'ret@example.com', 'RET-1')).json()) as {
    id: string;
  };
  await until(() => s.store.getRequest(id)?.status === 'failed');
  const login = await fetch(`${s.url}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(ADMIN_PASSWORD),
    redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const page = await (await fetch(`${s.url}/admin`, { headers: { cookie } })).text();
  const action = /action="(\/admin\/requests\/[^"]+\/retry)"/.exec(page)?.[1];
  assert.ok(action, 'failed row has a retry form');
  const r = await fetch(s.url + action, {
    method: 'POST',
    headers: {
      cookie,
      origin: s.url,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: '',
    redirect: 'manual',
  });
  assert.equal(r.status, 303);
  assert.ok(await until(() => s.store.getRequest(id)?.status === 'notified'));
  assert.equal(s.sent.length, 2);
  const out = await fetch(`${s.url}/admin/logout`, {
    method: 'POST',
    headers: { cookie, origin: s.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
    redirect: 'manual',
  });
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
});

test('QA-A7 login works with the Origin a browser really sends from the login page', async (t) => {
  const s = await stack(t);
  const page = await fetch(`${s.url}/admin`, { headers: { accept: 'text/html' } });
  // Fetch spec, "serializing a request origin": a non-CORS POST from a document whose referrer
  // policy is no-referrer carries `Origin: null`. Observed in Chrome: see the QA report.
  const origin = page.headers.get('referrer-policy') === 'no-referrer' ? 'null' : s.url;
  const login = await fetch(`${s.url}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ password: ADMIN_PASSWORD }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303, `Origin: ${origin} got ${login.status}`);
});

test('QA-W1 webhook secret: missing, wrong, empty and case-changed all get 401 and record nothing', async (t) => {
  const s = await stack(t);
  const event = JSON.stringify({ event_id: 'w1', sku: 'W-1', quantity: 1 });
  const variants: Record<string, string>[] = [
    {},
    { 'x-webhook-secret': '' },
    { 'x-webhook-secret': 'wrong' },
    { 'x-webhook-secret': WEBHOOK_SECRET.toUpperCase() },
    { 'x-webhook-secret': `${WEBHOOK_SECRET} `.trimEnd() + 'x' },
  ];
  for (const headers of variants) {
    const r = await fetch(`${s.url}/webhooks/stock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: event,
    });
    assert.equal(r.status, 401, JSON.stringify(headers));
  }
  assert.equal(s.store.listRecentWebhookEvents(10).length, 0);
});

test('QA-W2 hostile webhook bodies with a valid secret get a 4xx, never a 5xx', async (t) => {
  const s = await stack(t);
  const bodies = [
    '',
    'not json',
    '[]',
    'null',
    '1',
    '{}',
    '{"event_id":"x"}',
    '{"event_id":1,"sku":"A","quantity":1}',
    '{"event_id":"x","sku":"../../etc","quantity":1}',
    '{"event_id":"x","sku":"A","quantity":"5"}',
    '{"event_id":"x","sku":"A","quantity":-1}',
    '{"event_id":"x","sku":"A","quantity":1.5}',
    '{"event_id":"x","sku":"A","quantity":1e400}',
    '{"__proto__":{"a":1},"event_id":"x","sku":"A","quantity":1}',
    `{"event_id":"${'x'.repeat(300)}","sku":"A","quantity":1}`,
    `{"event_id":"x","sku":"${'A'.repeat(65)}","quantity":1}`,
    `{"event_id":"x","sku":"A","quantity":1,"pad":"${'p'.repeat(40_000)}"}`,
  ];
  for (const body of bodies) {
    const r = await fetch(`${s.url}/webhooks/stock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body,
    });
    assert.ok(r.status >= 400 && r.status < 500, `${body.slice(0, 40)} -> ${r.status}`);
  }
  assert.equal(s.store.listRecentWebhookEvents(10).length, 0);
});

test('QA-W3 an event id replayed for a different SKU still prompts a check for that SKU', async (t) => {
  const s = await stack(t);
  s.stockBody.value = () => ({ body: { quantity: 0, in_stock: false } });
  await postRequest(s.url, 'w3@example.com', 'W-3B');
  await postWebhook(s.url, { event_id: 'same', sku: 'W-3A', quantity: 1 });
  const r = await postWebhook(s.url, { event_id: 'same', sku: 'W-3B', quantity: 1 });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { duplicate: boolean };
  // Not a missed email (the reconciler covers it), but the ack says duplicate about another SKU.
  assert.equal(body.duplicate, true);
});

test('QA-X1 hostile stock data and event ids are inert in the admin page and the email', async (t) => {
  const s = await stack(t);
  const evil = `"><script>alert(1)</script><img src=x onerror=alert(2)>'\``;
  s.stockBody.value = () => ({
    body: {
      quantity: 1,
      in_stock: true,
      name: `${evil}\r\nBcc: x@example.com`,
      image: `https://x.example/a.png"${evil}`,
      price: 3,
      currency: 'GBP',
    },
  });
  await postRequest(s.url, `o'brien+"x"@example.com`, 'X-1'); // quotes rejected by the validator
  await postRequest(s.url, `o'brien&<@example.com`, 'X-1'); // angle bracket rejected
  await postRequest(s.url, `o'brien&co@example.com`, 'X-1');
  await postWebhook(s.url, { event_id: evil, sku: 'X-1', quantity: 1 });
  await until(() => s.sent.length === 1);
  await until(() => s.store.statusCounts().notified === 1);
  const html = await (
    await fetch(`${s.url}/admin`, { headers: { authorization: basic(ADMIN_PASSWORD) } })
  ).text();
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('o&#39;brien&amp;co@example.com'));
  const mail = s.sent[0]?.body;
  assert.ok(mail);
  assert.ok(!mail.html.includes('<script>alert'));
  assert.ok(!mail.html.includes('<img src=x'));
  assert.ok(!/[\r\n]/.test(mail.subject));
  const search = await (
    await fetch(`${s.url}/admin?q=${encodeURIComponent(evil)}`, {
      headers: { authorization: basic(ADMIN_PASSWORD) },
    })
  ).text();
  assert.ok(!search.includes('<script>alert'));
});

test('QA-X2 embed reflects nothing unsafe from the query, and CSP nonces match and vary', async (t) => {
  const s = await stack(t);
  const a = await fetch(`${s.url}/embed?sku=${encodeURIComponent('"><script>alert(1)</script>')}`);
  const b = await fetch(`${s.url}/embed?sku=A.B-c_1`);
  const body = await a.text();
  assert.ok(!body.includes('<script>alert'));
  const nonce = (h: Headers): string =>
    /'nonce-([^']+)'/.exec(h.get('content-security-policy') ?? '')?.[1] ?? '';
  assert.ok(nonce(a.headers));
  assert.notEqual(nonce(a.headers), nonce(b.headers));
  for (const m of body.matchAll(/<(script|style)\b[^>]*>/g)) {
    assert.ok(m[0].includes(`nonce="${nonce(a.headers)}"`), m[0]);
  }
  assert.equal(a.headers.get('x-frame-options'), null);
  assert.equal(a.headers.get('set-cookie'), null);
  const page = await b.text();
  assert.ok(page.includes('value="A.B-c_1"'));
});

test('QA-X3 only /embed is frameable', async (t) => {
  const s = await stack(t);
  for (const path of ['/healthz', '/api/requests', '/admin', '/nope']) {
    const r = await fetch(s.url + path);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
  }
  const bad = await fetch(`${s.url}/%E0%A4%A`);
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});

test('QA-R1 POST /api/requests: cross-origin preflight works, text/plain and bad shapes are refused', async (t) => {
  const s = await stack(t);
  const pre = await fetch(`${s.url}/api/requests`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://shop.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-credentials'), null);
  const plain = await fetch(`${s.url}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{"email":"a@example.com","sku":"A"}',
  });
  assert.equal(plain.status, 415);
  for (const body of [
    '{"email":"a@example.com"}',
    '{"sku":"A"}',
    '{"email":["a@example.com"],"sku":"A"}',
    '{"email":"a@example.com,b@example.com","sku":"A"}',
    '{"email":"a@example.com\\r\\nBcc:x@example.com","sku":"A"}',
  ]) {
    const r = await fetch(`${s.url}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(r.status, 400, body);
  }
  assert.equal(s.store.listRequests({ limit: 10, offset: 0 }).total, 0);
});
