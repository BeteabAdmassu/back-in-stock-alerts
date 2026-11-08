// Real Chrome against the real app process: login, retry, sign out, embed in a cross-origin iframe
// and in a file:// page. Stub provider refuses the first send, so a real `failed` row exists.
//
// Usage: node test/e2e/browser.e2e.mjs
// Optional: CHROME_PATH, BROWSER_SHOTS (a directory to save screenshots in).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.BROWSER_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'browser-check-password';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

let refuse = true;
let sends = 0;
const listen = (fn) =>
  new Promise((res) => {
    const server = createServer(fn).listen(0, '127.0.0.1', () => res(server));
  });
const stock = await listen((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify(
      req.url === '/'
        ? { products: [] }
        : { name: 'Brass Desk Lamp', price: 135, currency: 'GBP', quantity: 5, in_stock: true },
    ),
  );
});
const email = await listen((req, res) => {
  req.resume();
  req.on('end', () => {
    sends++;
    res.writeHead(refuse ? 422 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refuse ? { name: 'validation_error' } : { id: `id-${sends}` }));
  });
});

const dataDir = mkdtempSync(join(tmpdir(), 'bis-browser-'));
const APP_PORT = 8095;
const APP = `http://127.0.0.1:${APP_PORT}`;
const app = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: REPO,
  stdio: 'ignore',
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    DATA_DIR: dataDir,
    STOCK_API_URL: `http://127.0.0.1:${stock.address().port}`,
    STOCK_API_KEY: 'k',
    RESEND_API_KEY: 'k',
    RESEND_BASE_URL: `http://127.0.0.1:${email.address().port}`,
    WEBHOOK_SECRET: 's',
    ADMIN_PASSWORD: PASSWORD,
  },
});
for (let i = 0; i < 50; i++) {
  if (
    await fetch(`${APP}/healthz`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await sleep(200);
}
await fetch(`${APP}/api/requests`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'failed.row@example.com', sku: 'LAMP-1' }),
});
for (let i = 0; i < 30 && sends === 0; i++) await sleep(200);
await sleep(500);
refuse = false;

const profile = mkdtempSync(join(tmpdir(), 'bis-chrome-'));
const port = 9390 + Math.floor(Math.random() * 40);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let version;
for (let i = 0; i < 50 && !version; i++) {
  version = await fetch(`http://127.0.0.1:${port}/json/version`).then(
    (r) => r.json(),
    () => null,
  );
  await sleep(200);
}
const sock = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => {
  sock.onopen = r;
});
let id = 0;
const pending = new Map();
const events = [];
sock.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
    return;
  }
  events.push(d);
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, (d) =>
      d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result),
    );
    sock.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
for (const domain of ['Page', 'Network', 'Runtime', 'Log']) await send(`${domain}.enable`, {}, s);
await send(
  'Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
  s,
);
const ev = async (expression, contextId) => {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) },
    s,
  );
  return r.exceptionDetails ? `THROW ${r.exceptionDetails.text}` : r.result.value;
};
async function click(sel) {
  const box = await ev(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  if (!box) throw new Error(`nothing to click: ${sel}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send(
      'Input.dispatchMouseEvent',
      { type, x: box.x, y: box.y, button: 'left', clickCount: 1 },
      s,
    );
  }
}
async function type(sel, text) {
  await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`);
  await send('Input.insertText', { text }, s);
}
const go = async (url) => {
  await send('Page.navigate', { url }, s);
  await sleep(900);
};
const body = () => ev('document.body.innerText');
const shot = async (name) => {
  if (!SHOTS) return;
  const r = await send('Page.captureScreenshot', { format: 'png' }, s);
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'));
};

try {
  await go(`${APP}/admin`);
  check(
    'unauthenticated /admin shows the login page',
    (await ev('!!document.querySelector("#password")')) === true,
  );
  check('no request data on the login page', !(await body()).includes('failed.row@example.com'));

  await type('#password', 'wrong-password');
  await click('button[type=submit]');
  await sleep(900);
  const wrong = await body();
  check(
    'wrong password shows the styled page, not JSON or 403',
    (await ev('!!document.querySelector("#password")')) === true && !wrong.includes('"error"'),
    wrong.slice(0, 80).replace(/\s+/g, ' '),
  );

  await go(`${APP}/admin`);
  await type('#password', PASSWORD);
  await click('button[type=submit]');
  await sleep(1200);
  const admin = await body();
  check(
    'correct password reaches the dashboard',
    admin.includes('failed.row@example.com'),
    `path ${await ev('location.pathname')}`,
  );
  check(
    'the failed row is shown as failed with Retry',
    (await ev('!!document.querySelector("form[action*=retry] button")')) === true,
  );
  await shot('final-admin-failed.png');

  const before = sends;
  await click('form[action*=retry] button');
  await sleep(2500);
  check('Retry works and the email goes out', sends === before + 1, `sends ${before} -> ${sends}`);
  await go(`${APP}/admin`);
  const after = await body();
  check(
    'the row shows as notified after Retry',
    (await ev('!document.querySelector("form[action*=retry]")')) === true &&
      /notified/i.test(after),
  );
  await shot('final-admin-notified.png');

  await click('form[action*=logout] button');
  await sleep(1000);
  check(
    'Sign out returns to the login page',
    (await ev('!!document.querySelector("#password")')) === true,
  );
  await go(`${APP}/admin`);
  check(
    'still signed out after reloading',
    (await ev('!!document.querySelector("#password")')) === true,
  );

  const host = await listen((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><title>shop</title><h1>Store</h1><iframe id="f" src="${APP}/embed?sku=TEE-1" width="380" height="460"></iframe>`,
    );
  });
  await go(`http://127.0.0.1:${host.address().port}/`);
  await sleep(500);
  const frame = (await send('Page.getFrameTree', {}, s)).frameTree.childFrames?.[0]?.frame;
  check('embed loads in a cross-origin iframe', frame?.url?.includes('/embed') === true);
  const { executionContextId } = await send(
    'Page.createIsolatedWorld',
    { frameId: frame.id, worldName: 'check' },
    s,
  );
  const flow = await ev(
    `(async()=>{const d=document;d.getElementById('email').value='iframe.user@example.com';d.getElementById('bis-submit').click();await new Promise(r=>setTimeout(r,1200));return d.getElementById('bis-done-title').textContent})()`,
    executionContextId,
  );
  check('embed submits from inside the cross-origin iframe', /on the list/i.test(flow), flow);
  host.close();

  const file = join(dataDir, 'parent.html');
  writeFileSync(
    file,
    `<!doctype html><title>local</title><iframe id="f" src="${APP}/embed" width="380" height="460"></iframe>`,
  );
  await go(pathToFileURL(file).href);
  await sleep(500);
  await sleep(800);
  const { targetInfos } = await send('Target.getTargets');
  const embedded = targetInfos.find((t) => t.type === 'iframe' && t.url.includes('/embed'));
  check(
    'embed renders when framed from a file:// page',
    embedded !== undefined,
    embedded?.url ?? JSON.stringify(targetInfos.map((t) => [t.type, t.url.slice(0, 40)])),
  );
  await shot('final-embed-file-parent.png');

  const csp = events.filter((e) =>
    JSON.stringify(e.params ?? {}).includes('Content Security Policy'),
  );
  check(
    'no CSP violations anywhere in the run',
    csp.length === 0,
    csp.length ? JSON.stringify(csp[0]).slice(0, 200) : '',
  );
  const thrown = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  check('no uncaught JS exceptions', thrown.length === 0);
} catch (e) {
  check('browser run completed', false, e.message);
}
await send('Browser.close').catch(() => {});
chrome.kill();
app.kill();
stock.close();
email.close();
await sleep(500);
for (const dir of [profile, dataDir]) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
