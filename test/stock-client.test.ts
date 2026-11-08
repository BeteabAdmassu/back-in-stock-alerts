import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import type { Logger, StockClient } from '../src/contracts.ts';
import { createStockClient } from '../src/integrations/stock-client.ts';

const TOKEN = 'stock-secret-token';
const BODY_MARKER = 'response-body-marker';

const servers: Server[] = [];
after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

interface Seen {
  url: string;
  authorization: string | undefined;
  method: string;
}

async function listen(handler: RequestListener): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      authorization: req.headers.authorization,
      method: req.method ?? '',
    });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/stock`, seen };
}

function recordingLogger() {
  const lines: unknown[] = [];
  const logger: Logger = {
    info: (obj, msg) => lines.push([obj, msg]),
    warn: (obj, msg) => lines.push([obj, msg]),
    error: (obj, msg) => lines.push([obj, msg]),
  };
  return { logger, lines };
}

function client(baseUrl: string, timeoutMs = 2_000, apiKey = TOKEN) {
  const { logger, lines } = recordingLogger();
  return { stock: createStockClient({ baseUrl, apiKey, timeoutMs, logger }), lines };
}

function replying(status: number, body: string): RequestListener {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  };
}

async function stockFor(body: unknown): Promise<StockClient> {
  const api = await listen(replying(200, JSON.stringify(body)));
  return client(api.url).stock;
}

function assertErrorWithoutSecrets(
  result: Awaited<ReturnType<StockClient['getStock']>>,
  lines: unknown[],
): void {
  assert.equal(result.kind, 'error');
  const output = JSON.stringify([result, lines]);
  assert.ok(!output.includes(TOKEN), 'token leaked');
  assert.ok(!output.includes(BODY_MARKER), 'response body leaked');
  assert.ok(!output.includes('127.0.0.1'), 'URL leaked');
  if (result.kind === 'error') assert.ok(result.error.length < 80, 'error is not short');
}

test('valid response: authenticates, reads stock and product', async () => {
  const api = await listen(
    replying(
      200,
      JSON.stringify({
        sku: 'SKU-1',
        quantity: 5,
        in_stock: true,
        name: 'Mug',
        price: 18.5,
        currency: 'GBP',
        image: 'https://img.example/mug.png',
        category: 'ignored',
      }),
    ),
  );
  const result = await client(api.url).stock.getStock('SKU-1');
  assert.deepEqual(result, {
    kind: 'ok',
    quantity: 5,
    available: true,
    product: { name: 'Mug', price: 18.5, currency: 'GBP', image: 'https://img.example/mug.png' },
  });
  assert.deepEqual(api.seen, [
    { url: '/api/stock/SKU-1', authorization: `Bearer ${TOKEN}`, method: 'GET' },
  ]);
});

test('in_stock is optional: quantity alone decides', async () => {
  const stock = await stockFor({ quantity: 2 });
  assert.deepEqual(await stock.getStock('A'), {
    kind: 'ok',
    quantity: 2,
    available: true,
    product: null,
  });
});

test('in_stock false with a positive quantity is unavailable', async () => {
  const stock = await stockFor({ quantity: 7, in_stock: false });
  assert.deepEqual(await stock.getStock('A'), {
    kind: 'ok',
    quantity: 7,
    available: false,
    product: null,
  });
});

test('quantity 0 with in_stock true is unavailable', async () => {
  const stock = await stockFor({ quantity: 0, in_stock: true });
  const result = await stock.getStock('A');
  assert.ok(result.kind === 'ok');
  assert.equal(result.available, false);
});

test('404 is an unknown SKU: ok, quantity 0, unavailable', async () => {
  const api = await listen(replying(404, JSON.stringify({ error: BODY_MARKER })));
  assert.deepEqual(await client(api.url).stock.getStock('NOPE'), {
    kind: 'ok',
    quantity: 0,
    available: false,
    product: null,
  });
});

for (const status of [400, 403, 429, 500, 503]) {
  test(`${status} is an error, never out of stock`, async () => {
    const api = await listen(replying(status, JSON.stringify({ quantity: 0, msg: BODY_MARKER })));
    const { stock, lines } = client(api.url);
    const result = await stock.getStock('A');
    assertErrorWithoutSecrets(result, lines);
    assert.deepEqual(result, { kind: 'error', error: `stock API returned ${status}` });
  });
}

test('a wrong token gets 401 from the server and is an error', async () => {
  const api = await listen((req, res) => {
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { quantity: 3 } : { error: BODY_MARKER }));
  });
  const wrong = client(api.url, 2_000, 'wrong-token');
  const result = await wrong.stock.getStock('A');
  assert.deepEqual(result, { kind: 'error', error: 'stock API returned 401' });
  assert.ok(!JSON.stringify(wrong.lines).includes('wrong-token'));
  assert.equal((await client(api.url).stock.getStock('A')).kind, 'ok');
});

test('timeout is an error', async () => {
  const api = await listen(() => {}); // Never answers.
  const { stock, lines } = client(api.url, 50);
  const result = await stock.getStock('A');
  assertErrorWithoutSecrets(result, lines);
  assert.deepEqual(result, { kind: 'error', error: 'stock API timed out' });
});

test('a body that stalls after the headers also times out', async () => {
  const api = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"quantity":');
  });
  const result = await client(api.url, 50).stock.getStock('A');
  assert.deepEqual(result, { kind: 'error', error: 'stock API timed out' });
});

test('connection refused is an error', async () => {
  const { stock, lines } = client('http://127.0.0.1:1/api/stock', 1_000);
  const result = await stock.getStock('A');
  assertErrorWithoutSecrets(result, lines);
});

test('garbage JSON is an error', async () => {
  const api = await listen(replying(200, `<html>${BODY_MARKER}</html>`));
  const { stock, lines } = client(api.url);
  const result = await stock.getStock('A');
  assertErrorWithoutSecrets(result, lines);
  assert.deepEqual(result, { kind: 'error', error: 'stock API returned invalid JSON' });
});

const BAD_BODIES: [string, string][] = [
  ['missing quantity', JSON.stringify({ in_stock: true, name: 'Mug' })],
  ['string quantity', JSON.stringify({ quantity: '5' })],
  ['null quantity', JSON.stringify({ quantity: null })],
  ['negative quantity', JSON.stringify({ quantity: -1 })],
  ['infinite quantity', '{"quantity":1e999}'],
  ['string in_stock', JSON.stringify({ quantity: 5, in_stock: 'false' })],
  ['null in_stock', JSON.stringify({ quantity: 5, in_stock: null })],
  ['array body', '[{"quantity":5}]'],
  ['null body', 'null'],
  ['number body', '5'],
  ['catalogue shape', JSON.stringify({ products: [] })],
];

for (const [label, body] of BAD_BODIES) {
  test(`${label} is an error, never out of stock`, async () => {
    const api = await listen(replying(200, body));
    assert.equal((await client(api.url).stock.getStock('A')).kind, 'error');
  });
}

test('a redirect is not followed, so the token never reaches the target', async () => {
  const target = await listen(replying(200, JSON.stringify({ quantity: 9 })));
  const api = await listen((_req, res) => {
    res.writeHead(302, { location: `${target.url}/A` });
    res.end();
  });
  const { stock, lines } = client(api.url);
  const result = await stock.getStock('A');
  assertErrorWithoutSecrets(result, lines);
  assert.equal(api.seen.length, 1);
  assert.equal(target.seen.length, 0);

  const items = await client(api.url).stock.getCatalogue();
  assert.deepEqual(items, []);
  assert.equal(target.seen.length, 0);
});

test('SKUs are URL-encoded', async () => {
  const api = await listen(replying(200, JSON.stringify({ quantity: 1 })));
  const { stock } = client(api.url);
  await stock.getStock('a/b c?d=1#e');
  await stock.getStock('../admin');
  await stock.getStock('%2e%2e');
  assert.deepEqual(
    api.seen.map((s) => s.url),
    ['/api/stock/a%2Fb%20c%3Fd%3D1%23e', '/api/stock/..%2Fadmin', '/api/stock/%252e%252e'],
  );
});

test('SKUs the URL parser would resolve as path segments are errors with no request', async () => {
  const api = await listen(replying(200, JSON.stringify({ quantity: 5 })));
  const { stock } = client(api.url);
  for (const sku of ['', '.', '..']) {
    assert.equal((await stock.getStock(sku)).kind, 'error');
  }
  assert.equal(api.seen.length, 0);
});

test('a trailing slash on the base URL does not double up', async () => {
  const api = await listen(replying(200, JSON.stringify({ quantity: 1 })));
  await client(`${api.url}/`).stock.getStock('A');
  assert.equal(api.seen[0]?.url, '/api/stock/A');
});

const BAD_IMAGES: [string, unknown][] = [
  ['http', 'http://img.example/a.png'],
  ['javascript', 'javascript:alert(1)'],
  ['data', 'data:image/png;base64,AAAA'],
  ['unparseable', 'not a url'],
  ['relative', '/a.png'],
  ['non-string', 42],
];

for (const [label, image] of BAD_IMAGES) {
  test(`bad image (${label}) is dropped, the stock result stands`, async () => {
    const stock = await stockFor({ quantity: 1, name: 'Mug', image });
    assert.deepEqual(await stock.getStock('A'), {
      kind: 'ok',
      quantity: 1,
      available: true,
      product: { name: 'Mug' },
    });
  });
}

test('product is null when nothing in it is valid', async () => {
  const stock = await stockFor({
    quantity: 1,
    name: '   ',
    price: -1,
    currency: 'gbp',
    image: 'http://x.example/',
  });
  const result = await stock.getStock('A');
  assert.ok(result.kind === 'ok');
  assert.equal(result.product, null);
});

test('invalid product fields are dropped individually', async () => {
  const invalid: Record<string, unknown>[] = [
    { name: 42 },
    { price: '10' },
    { currency: 'GBPX' },
    { currency: 'GB' },
    { currency: 'GBP\n' },
    { currency: 5 },
  ];
  for (const fields of invalid) {
    const stock = await stockFor({ quantity: 1, ...fields });
    const result = await stock.getStock('A');
    assert.ok(result.kind === 'ok');
    assert.equal(result.product, null, JSON.stringify(fields));
  }
  const stock = await stockFor({ quantity: 1, price: 0 });
  const result = await stock.getStock('A');
  assert.ok(result.kind === 'ok');
  assert.deepEqual(result.product, { price: 0 });
});

test('name is capped at 200 chars without splitting a surrogate pair', async () => {
  const long = await (await stockFor({ quantity: 1, name: 'x'.repeat(500) })).getStock('A');
  assert.ok(long.kind === 'ok');
  assert.equal(long.product?.name?.length, 200);

  const emoji = `${'x'.repeat(199)}\u{1F600}tail`;
  const split = await (await stockFor({ quantity: 1, name: emoji })).getStock('A');
  assert.ok(split.kind === 'ok');
  assert.equal(split.product?.name, 'x'.repeat(199));
});

test('catalogue: reads products, skips malformed entries, sanitises the rest', async () => {
  const api = await listen(
    replying(
      200,
      JSON.stringify({
        products: [
          {
            sku: 'A',
            quantity: 3,
            in_stock: true,
            name: 'Mug',
            price: 18,
            currency: 'GBP',
            image: 'http://insecure.example/a.png',
          },
          { sku: 'B', quantity: 0, in_stock: false },
          { sku: 'C', quantity: 2, in_stock: false },
          { sku: 'NO-QTY', name: 'Missing quantity' },
          { sku: 'BAD-FLAG', quantity: 2, in_stock: 'yes' },
          { sku: '  ', quantity: 2 },
          { sku: 5, quantity: 2 },
          { quantity: 2 },
          null,
          'junk',
          [],
        ],
      }),
    ),
  );
  assert.deepEqual(await client(api.url).stock.getCatalogue(), [
    { name: 'Mug', price: 18, currency: 'GBP', sku: 'A', available: true },
    { sku: 'B', available: false },
    { sku: 'C', available: false },
  ]);
  assert.deepEqual(api.seen, [
    { url: '/api/stock', authorization: `Bearer ${TOKEN}`, method: 'GET' },
  ]);
});

const CATALOGUE_FAILURES: [string, RequestListener][] = [
  ['401', replying(401, '{}')],
  ['404', replying(404, '{}')],
  ['500', replying(500, JSON.stringify({ products: [{ sku: 'A', quantity: 1 }] }))],
  ['garbage', replying(200, 'not json')],
  ['no products', replying(200, '{}')],
  ['products not an array', replying(200, JSON.stringify({ products: { sku: 'A' } }))],
  ['array body', replying(200, '[]')],
  ['null body', replying(200, 'null')],
  ['timeout', () => {}],
];

for (const [label, handler] of CATALOGUE_FAILURES) {
  test(`catalogue returns [] on failure: ${label}`, async () => {
    const api = await listen(handler);
    assert.deepEqual(await client(api.url, 50).stock.getCatalogue(), []);
  });
}

test('catalogue returns [] when the server is unreachable', async () => {
  const { stock } = client('http://127.0.0.1:1/api/stock', 1_000);
  assert.deepEqual(await stock.getCatalogue(), []);
});

test('a throwing fetch implementation is reported, not thrown', async () => {
  const { logger } = recordingLogger();
  const stock = createStockClient({
    baseUrl: 'http://stock.invalid',
    apiKey: TOKEN,
    timeoutMs: 100,
    logger,
    fetchImpl: () => Promise.reject(new Error(`boom ${TOKEN}`)),
  });
  assert.deepEqual(await stock.getStock('A'), {
    kind: 'error',
    error: 'stock API request failed',
  });
  assert.deepEqual(await stock.getCatalogue(), []);
});
