import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_TIMINGS, type Logger, type Timings } from '../src/contracts.ts';
import { openDatabase } from '../src/db/database.ts';
import { createStore } from '../src/db/store.ts';
import { createApp } from '../src/http/app.ts';
import { renderAdmin } from '../src/http/views/admin.ts';
import { renderEmbed } from '../src/http/views/embed.ts';
import { renderLogin } from '../src/http/views/login.ts';
import { createEmailClient } from '../src/integrations/email-client.ts';
import { createStockClient } from '../src/integrations/stock-client.ts';
import { createEmailWorker } from '../src/workers/email-worker.ts';
import { createReconciler } from '../src/workers/reconciler.ts';
import { createStockCheckWorker } from '../src/workers/stock-check-worker.ts';

export const WEBHOOK_SECRET = 'qa-webhook-secret';
export const ADMIN_PASSWORD = 'qa-admin-password';

export interface SentEmail {
  key: string | undefined;
  body: { from: string; to: string[]; subject: string; html: string; text: string };
  raw: string;
}

export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

export async function until(fn: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(15);
  }
  return fn();
}

const quiet: Logger = { info() {}, warn() {}, error() {} };

export interface Stack {
  store: ReturnType<typeof createStore>;
  url: string;
  sent: SentEmail[];
  /** Replace to control the stock API. Return null for the default in-stock answer. */
  stockBody: { value: (sku: string) => { status?: number; body?: unknown } };
  /** Replace to control the email API; default accepts. */
  emailReply: {
    value: (
      sent: SentEmail,
      n: number,
    ) => { status: number; headers?: Record<string, string>; body?: unknown };
  };
  now: { offsetMs: number };
  logs: { level: string; obj: object; msg?: string }[];
  stockCalls: string[];
  wakeAll: () => void;
}

export async function stack(
  t: TestContext,
  timingOverrides: Partial<Timings> = {},
): Promise<Stack> {
  const now = { offsetMs: 0 };
  const clock = () => new Date(Date.now() + now.offsetMs);
  const timings: Timings = {
    ...DEFAULT_TIMINGS,
    pollIntervalMs: 20,
    reconcileIntervalMs: 200,
    httpTimeoutMs: 400,
    leaseMs: 2_000,
    ...timingOverrides,
  };
  const sent: SentEmail[] = [];
  const stockCalls: string[] = [];
  const stockBody: Stack['stockBody'] = {
    value: () => ({
      body: { quantity: 5, in_stock: true, name: 'Thing', price: 10, currency: 'GBP' },
    }),
  };
  const emailReply: Stack['emailReply'] = {
    value: () => ({ status: 200, body: { id: `prov-${sent.length}` } }),
  };
  const stockServer = await listen((req, res) => {
    const sku = decodeURIComponent((req.url ?? '/').slice(1));
    stockCalls.push(sku);
    const { status = 200, body } = stockBody.value(sku);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  const mailServer = await listen((req, res, raw) => {
    const email: SentEmail = {
      key: req.headers['idempotency-key'] as string | undefined,
      body: JSON.parse(raw),
      raw,
    };
    sent.push(email);
    const reply = emailReply.value(email, sent.length);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });

  const logs: Stack['logs'] = [];
  const logger: Logger = {
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  void quiet;

  const db = openDatabase(':memory:');
  const store = createStore({ db, clock, leaseMs: timings.leaseMs });
  const stock = createStockClient({
    baseUrl: stockServer.url,
    apiKey: 'k',
    timeoutMs: timings.httpTimeoutMs,
    logger,
  });
  const sender = createEmailClient({
    baseUrl: mailServer.url,
    apiKey: 'k',
    from: 'Back in Stock <a@example.com>',
    timeoutMs: timings.httpTimeoutMs,
  });
  const emailWorker = createEmailWorker({
    store,
    stock,
    sender,
    clock,
    logger,
    timings,
    productUrlTemplate: null,
  });
  const stockWorker = createStockCheckWorker({
    store,
    stock,
    clock,
    logger,
    timings,
    onQueued: () => emailWorker.wake(),
  });
  const reconciler = createReconciler({
    store,
    clock,
    logger,
    timings,
    onEnqueued: () => stockWorker.wake(),
  });
  const app = createApp({
    config: {
      port: 0,
      dataDir: 'unused',
      stockApiUrl: stockServer.url,
      stockApiKey: 'k',
      resendApiKey: 'k',
      resendBaseUrl: mailServer.url,
      webhookSecret: WEBHOOK_SECRET,
      adminPassword: ADMIN_PASSWORD,
      emailFrom: 'x@example.com',
      productUrlTemplate: null,
      logLevel: 'silent',
      trustProxyHops: 0,
      timings,
    },
    store,
    stock,
    clock,
    logger,
    views: { renderEmbed, renderLogin, renderAdmin },
    wake: { stockChecks: () => stockWorker.wake() },
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  reconciler.start();
  stockWorker.start();
  emailWorker.start();

  t.after(async () => {
    await Promise.all([reconciler.stop(), stockWorker.stop(), emailWorker.stop()]);
    await app.close();
    store.close();
    stockServer.server.closeAllConnections();
    mailServer.server.closeAllConnections();
    await new Promise((r) => stockServer.server.close(r));
    await new Promise((r) => mailServer.server.close(r));
  });

  return {
    store,
    url,
    sent,
    stockBody,
    emailReply,
    now,
    logs,
    stockCalls,
    wakeAll: () => {
      stockWorker.wake();
      emailWorker.wake();
    },
  };
}

export const postRequest = (url: string, email: string, sku: string): Promise<Response> =>
  fetch(`${url}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, sku }),
  });

export const postWebhook = (
  url: string,
  event: object,
  secret: string = WEBHOOK_SECRET,
): Promise<Response> =>
  fetch(`${url}/webhooks/stock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
    body: JSON.stringify(event),
  });
