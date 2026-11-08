// Independent QA: the real entry point as a real process, killed for real, against local stubs.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ADMIN_PASSWORD,
  listen,
  postRequest,
  postWebhook,
  until,
  WEBHOOK_SECRET,
} from './qa-helpers.ts';

const PORT = 8090;
const URL_BASE = `http://127.0.0.1:${PORT}`;

function startApp(env: Record<string, string>): { child: ChildProcess; output: () => string } {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => {
    out += String(d);
  });
  child.stderr?.on('data', (d) => {
    out += String(d);
  });
  return { child, output: () => out };
}

const exited = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });

async function healthy(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${URL_BASE}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await sleep(100);
  }
  throw new Error('app did not come up');
}

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'qa-proc-'));
  let quantity = 0;
  const keys: { key: string; raw: string; accepted: boolean }[] = [];
  const hooks: { onEmail: (() => void) | null } = { onEmail: null };
  const stock = await listen((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer stock-secret-value');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/') return void res.end(JSON.stringify({ products: [] }));
    res.end(JSON.stringify({ quantity, in_stock: quantity > 0, name: 'Stub product' }));
  });
  const mail = await listen((req, res, raw) => {
    const key = String(req.headers['idempotency-key']);
    const prior = keys.find((k) => k.key === key && k.accepted);
    keys.push({ key, raw, accepted: !prior });
    if (hooks.onEmail) {
      const fn = hooks.onEmail;
      hooks.onEmail = null;
      // The provider has accepted it; the reply never reaches the app.
      fn();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `prov-${keys.length}` }));
  });
  const env = {
    PORT: String(PORT),
    DATA_DIR: dataDir,
    STOCK_API_URL: stock.url,
    STOCK_API_KEY: 'stock-secret-value',
    RESEND_API_KEY: 'resend-secret-value',
    RESEND_BASE_URL: mail.url,
    WEBHOOK_SECRET,
    ADMIN_PASSWORD,
  };
  let current: ReturnType<typeof startApp> | null = null;
  t.after(async () => {
    if (current) {
      current.child.kill('SIGKILL');
      await exited(current.child);
    }
    stock.server.closeAllConnections();
    mail.server.closeAllConnections();
    await new Promise((r) => stock.server.close(r));
    await new Promise((r) => mail.server.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    env,
    keys,
    hooks,
    dataDir,
    setQuantity: (q: number) => {
      quantity = q;
    },
    async boot() {
      current = startApp(env);
      await healthy();
      return current;
    },
    async kill() {
      if (!current) return;
      current.child.kill('SIGKILL');
      await exited(current.child);
    },
    output: () => current?.output() ?? '',
  };
}

function statuses(dataDir: string): { status: string; n: number }[] {
  const db = new DatabaseSync(join(dataDir, 'back-in-stock.db'), { readOnly: true });
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status ORDER BY status')
    .all() as unknown as { status: string; n: number }[];
  db.close();
  return rows.map((r) => ({ status: r.status, n: r.n }));
}

test('QA-P1 SIGKILL while the provider holds an accepted send: one acceptance, same key and body', async (t) => {
  const f = await fixture(t);
  await f.boot();
  f.setQuantity(4);
  let killed: Promise<void> | null = null;
  f.hooks.onEmail = () => {
    killed = f.kill();
  };
  assert.equal((await postRequest(URL_BASE, 'kill@example.com', 'KILL-1')).status, 201);
  assert.ok(await until(() => killed !== null, 5000));
  await killed;
  await f.boot();
  assert.ok(await until(() => f.keys.length >= 2, 15_000), `sends=${f.keys.length}`);
  await sleep(1500);
  assert.equal(f.keys.length, 2, 'exactly one retry after the crash');
  assert.equal(f.keys[0]?.key, f.keys[1]?.key);
  assert.equal(f.keys[0]?.raw, f.keys[1]?.raw);
  assert.equal(f.keys.filter((k) => k.accepted).length, 1);
  await f.kill();
  assert.deepEqual(statuses(f.dataDir), [{ status: 'notified', n: 1 }]);
});

test('QA-P2 restock during downtime with no webhook: everybody is notified after restart', async (t) => {
  const f = await fixture(t);
  await f.boot();
  for (const w of ['a', 'b', 'c']) await postRequest(URL_BASE, `${w}@example.com`, 'DOWN-1');
  await sleep(500);
  assert.equal(f.keys.length, 0);
  await f.kill();
  f.setQuantity(9);
  await f.boot();
  assert.ok(await until(() => f.keys.length >= 3, 10_000), `sends=${f.keys.length}`);
  await sleep(1000);
  assert.equal(f.keys.length, 3);
  assert.equal(new Set(f.keys.map((k) => k.key)).size, 3);
});

test('QA-P3 an acked webhook survives SIGKILL before it was processed', async (t) => {
  const f = await fixture(t);
  await f.boot();
  await postRequest(URL_BASE, 'ack@example.com', 'ACK-1');
  await sleep(300);
  f.setQuantity(2);
  const r = await postWebhook(URL_BASE, { event_id: 'ack-1', sku: 'ACK-1', quantity: 2 });
  assert.equal(r.status, 200);
  await f.kill();
  await f.boot();
  assert.ok(await until(() => f.keys.length >= 1, 10_000));
  await sleep(1000);
  assert.equal(f.keys.filter((k) => k.accepted).length, 1);
});

test('QA-P4 logs of a real run carry no email, no key, no secret', async (t) => {
  const f = await fixture(t);
  const app = await f.boot();
  f.setQuantity(1);
  await postRequest(URL_BASE, 'private-person@example.com', 'LOGS-1');
  await until(() => f.keys.length === 1, 5000);
  await fetch(`${URL_BASE}/admin?q=private-person@example.com`, {
    headers: { authorization: `Basic ${Buffer.from(`a:${ADMIN_PASSWORD}`).toString('base64')}` },
  });
  await sleep(200);
  const out = app.output();
  assert.ok(out.includes('Listening'));
  for (const needle of [
    'private-person',
    'stock-secret-value',
    'resend-secret-value',
    WEBHOOK_SECRET,
    ADMIN_PASSWORD,
  ]) {
    assert.ok(!out.includes(needle), `leak: ${needle}`);
  }
});

test('QA-P5 missing env exits non-zero and names variables only', async () => {
  const app = startApp({
    PORT: String(PORT),
    WEBHOOK_SECRET: 'do-not-print-me',
    STOCK_API_URL: 'nope',
  });
  const code = await exited(app.child);
  assert.equal(code, 1);
  assert.ok(app.output().includes('RESEND_API_KEY'));
  assert.ok(!app.output().includes('do-not-print-me'));
});
