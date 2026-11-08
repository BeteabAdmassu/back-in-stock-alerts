import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import type { EmailSender } from '../src/contracts.ts';
import { createEmailClient } from '../src/integrations/email-client.ts';

const API_KEY = 're_secret_key';
const RECIPIENT = 'customer@example.com';
const MESSAGE = { to: RECIPIENT, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };
const OPTS = { idempotencyKey: 'back-in-stock/req-1' };

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function serve(handler: Handler): Promise<{ baseUrl: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

const clientFor = (baseUrl: string, timeoutMs = 2_000): EmailSender =>
  createEmailClient({ baseUrl, apiKey: API_KEY, from: 'Shop <alerts@shop.example>', timeoutMs });

const respond =
  (status: number, body: unknown = {}, headers: Record<string, string> = {}): Handler =>
  (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

test('sends the Resend request format and headers', async () => {
  const { baseUrl, requests } = await serve(respond(200, { id: 'em_1' }));
  const result = await clientFor(`${baseUrl}/`).send(MESSAGE, OPTS);

  assert.deepEqual(result, { kind: 'accepted', providerId: 'em_1' });
  const [request] = requests;
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/emails');
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['idempotency-key'], 'back-in-stock/req-1');
  assert.deepEqual(JSON.parse(request.body), {
    from: 'Shop <alerts@shop.example>',
    to: [RECIPIENT],
    subject: 'Hi',
    html: '<p>Hi</p>',
    text: 'Hi',
  });
});

test('2xx is accepted, whatever the state of the body', async (t) => {
  const cases: [string, Handler, string | null][] = [
    ['201 with an id', respond(201, { id: 'em_2' }), 'em_2'],
    ['200 with a non-string id', respond(200, { id: 42 }), null],
    ['200 with an empty id', respond(200, { id: '' }), null],
    ['200 with no id', respond(200, {}), null],
    ['200 with a JSON null', respond(200, 'null'), null],
    ['200 with an unparseable body', respond(200, 'not json'), null],
    [
      '204 with no body',
      (_req, res) => {
        res.writeHead(204);
        res.end();
      },
      null,
    ],
    [
      '200 whose body dies mid-read',
      (_req, res) => {
        res.writeHead(200, { 'content-length': '100' });
        res.write('{"id":');
        setTimeout(() => res.destroy(), 10);
      },
      null,
    ],
  ];
  for (const [name, handler, providerId] of cases) {
    await t.test(name, async () => {
      const { baseUrl } = await serve(handler);
      assert.deepEqual(await clientFor(baseUrl).send(MESSAGE, OPTS), {
        kind: 'accepted',
        providerId,
      });
    });
  }

  await t.test('200 whose body hangs past the timeout', async () => {
    const { baseUrl } = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('{');
    });
    assert.deepEqual(await clientFor(baseUrl, 100).send(MESSAGE, OPTS), {
      kind: 'accepted',
      providerId: null,
    });
  });
});

test('408, 502 and 504 are retryable and ambiguous: the provider may have accepted', async (t) => {
  for (const status of [408, 502, 504]) {
    await t.test(String(status), async () => {
      const { baseUrl } = await serve(respond(status, { name: 'some_error', message: 'no' }));
      assert.deepEqual(await clientFor(baseUrl).send(MESSAGE, OPTS), {
        kind: 'retryable',
        ambiguous: true,
        error: `HTTP ${status} some_error`,
      });
    });
  }
});

test('401, 403, 409, 425, 429 and other 5xx are retryable and not ambiguous', async (t) => {
  for (const status of [401, 403, 409, 425, 429, 500, 503]) {
    await t.test(String(status), async () => {
      const { baseUrl } = await serve(respond(status, { name: 'some_error', message: 'no' }));
      assert.deepEqual(await clientFor(baseUrl).send(MESSAGE, OPTS), {
        kind: 'retryable',
        ambiguous: false,
        error: `HTTP ${status} some_error`,
      });
    });
  }
});

test('other 4xx are rejected', async (t) => {
  for (const status of [400, 404, 405, 410, 413, 422]) {
    await t.test(String(status), async () => {
      const { baseUrl } = await serve(respond(status, { name: 'validation_error' }));
      assert.deepEqual(await clientFor(baseUrl).send(MESSAGE, OPTS), {
        kind: 'rejected',
        error: `HTTP ${status} validation_error`,
      });
    });
  }
});

test('an unrecognised non-2xx response is treated as possibly accepted', async () => {
  const { baseUrl } = await serve(respond(304, ''));
  const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
  assert.equal(result.kind, 'retryable');
  assert.equal(result.kind === 'retryable' && result.ambiguous, true);
});

test('a timeout is retryable and ambiguous', async () => {
  const { baseUrl, requests } = await serve(() => {}); // Records the request, then hangs.
  const started = Date.now();
  const result = await clientFor(baseUrl, 100).send(MESSAGE, OPTS);
  assert.deepEqual(result, { kind: 'retryable', ambiguous: true, error: 'Request timed out' });
  assert.equal(requests.length, 1);
  assert.ok(Date.now() - started < 1_500, 'the timeout bounds the call');
});

test('a lost connection is retryable and ambiguous', async () => {
  const { baseUrl } = await serve((req) => req.socket.destroy());
  const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
  assert.equal(result.kind, 'retryable');
  assert.ok(result.kind === 'retryable' && result.ambiguous);
  assert.match(result.kind === 'retryable' ? result.error : '', /^Network error/);
});

test('a refused connection is retryable and ambiguous', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  const result = await clientFor(`http://127.0.0.1:${port}`).send(MESSAGE, OPTS);
  assert.equal(result.kind, 'retryable');
  assert.ok(result.kind === 'retryable' && result.ambiguous);
});

test('a redirect is refused, not followed, and is ambiguous', async () => {
  const target = await serve(respond(200, { id: 'stolen' }));
  const { baseUrl } = await serve(respond(307, '', { location: `${target.baseUrl}/steal` }));
  const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
  assert.equal(result.kind, 'retryable');
  assert.ok(result.kind === 'retryable' && result.ambiguous);
  assert.equal(target.requests.length, 0, 'neither the token nor the message left');
});

test('Retry-After in seconds or as a date is honoured on 429 and 5xx', async (t) => {
  for (const status of [429, 503]) {
    await t.test(`${status} with seconds`, async () => {
      const { baseUrl } = await serve(respond(status, {}, { 'retry-after': '120' }));
      const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
      assert.ok(result.kind === 'retryable');
      assert.equal(result.retryAfterMs, 120_000);
      assert.equal(result.ambiguous, false);
    });
    await t.test(`${status} with a date`, async () => {
      const when = new Date(Date.now() + 90_000).toUTCString();
      const { baseUrl } = await serve(respond(status, {}, { 'retry-after': when }));
      const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
      assert.ok(result.kind === 'retryable');
      const ms = result.retryAfterMs ?? 0;
      assert.ok(ms > 80_000 && ms <= 90_000, `got ${ms}`);
    });
  }

  await t.test('409, as the architecture table says', async () => {
    const { baseUrl } = await serve(respond(409, {}, { 'retry-after': '5' }));
    const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
    assert.ok(result.kind === 'retryable');
    assert.equal(result.retryAfterMs, 5_000);
  });

  await t.test('401 ignores it', async () => {
    const { baseUrl } = await serve(respond(401, {}, { 'retry-after': '5' }));
    const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
    assert.ok(result.kind === 'retryable');
    assert.equal(result.retryAfterMs, undefined);
  });

  for (const value of ['soon', '-5', '1.5', new Date(Date.now() - 60_000).toUTCString()]) {
    await t.test(`unusable value: ${value}`, async () => {
      const { baseUrl } = await serve(respond(429, {}, { 'retry-after': value }));
      const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
      assert.ok(result.kind === 'retryable');
      assert.equal(result.retryAfterMs, undefined);
    });
  }

  await t.test('an absurd value still gives a usable delay', async () => {
    const { baseUrl } = await serve(respond(429, {}, { 'retry-after': '9'.repeat(30) }));
    const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
    assert.ok(result.kind === 'retryable');
    assert.equal(result.retryAfterMs, 60 * 60 * 1000);
  });
});

test('errors never carry the recipient, body text or key', async (t) => {
  const leaky = {
    name: `bad <${RECIPIENT}> ${API_KEY}`,
    message: `Could not send to ${RECIPIENT} using ${API_KEY}`,
  };
  for (const status of [401, 422, 500]) {
    await t.test(String(status), async () => {
      const { baseUrl } = await serve(respond(status, leaky));
      const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
      assert.ok(result.kind !== 'accepted');
      assert.equal(result.error, `HTTP ${status}`);
    });
  }

  await t.test('a thrown error message is not repeated', async () => {
    const client = createEmailClient({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: API_KEY,
      from: 'a@b.example',
      timeoutMs: 100,
      fetchImpl: async () => {
        throw new TypeError(`fetch failed for ${RECIPIENT} with ${API_KEY}`);
      },
    });
    assert.deepEqual(await client.send(MESSAGE, OPTS), {
      kind: 'retryable',
      ambiguous: true,
      error: 'Network error',
    });
  });

  await t.test('a non-JSON error body gives the status alone', async () => {
    const { baseUrl } = await serve(respond(502, `<html>${RECIPIENT}</html>`));
    const result = await clientFor(baseUrl).send(MESSAGE, OPTS);
    assert.ok(result.kind === 'retryable');
    assert.equal(result.error, 'HTTP 502');
  });
});
