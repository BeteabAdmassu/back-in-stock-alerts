'use strict';
// Back-in-Stock challenge test harness.
// - Mock stock API candidates call:      GET  /api/stock/:sku
// - Mock Resend API candidates send to:  POST /emails (and /emails/batch)
// - Sends stock webhooks to candidate apps and simulates a live store.
// Zero dependencies. State is kept in DATA_DIR/db.json.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const INVITE_CODE = process.env.INVITE_CODE || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CHALLENGE_TEXT = (() => {
  for (const f of [path.join(__dirname, 'BRIEF.md'), path.join(__dirname, '..', 'BRIEF.md')]) {
    try { return fs.readFileSync(f, 'utf8'); } catch { /* try next */ }
  }
  return 'BRIEF.md not found.';
})();

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { candidates: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* fresh start */ }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 250);
}
function pushCapped(arr, item, cap) { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); }
const rand = (n) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function newCandidate(name, profile) {
  const c = {
    id: rand(4), token: rand(16), name, profile,
    apiKey: 're_test_' + rand(12), webhookSecret: 'whsec_' + rand(12),
    baseUrl: '', createdAt: now(),
    stock: {}, emails: [], webhooks: [], stockChecks: [],
    failNextEmails: 0, failFor: {},
  };
  ensureSim(c);
  db.candidates[c.id] = c; save();
  return c;
}
// ---------- simulated store ----------
const SIM_INTERVAL_MS = 1000 * Number(process.env.SIM_INTERVAL_SECONDS || 30);
const CATALOG = [
  ['TEE-ORG-WHT-M', 'Organic Cotton Tee, White, M', 24, 'Apparel'],
  ['TEE-ORG-BLK-L', 'Organic Cotton Tee, Black, L', 24, 'Apparel'],
  ['HOOD-FLC-GRY-M', 'Fleece Hoodie, Heather Grey, M', 58, 'Apparel'],
  ['SOCK-MRN-3PK', 'Merino Socks, 3-pack', 19, 'Apparel'],
  ['CAP-WAX-OLV', 'Waxed Canvas Cap, Olive', 32, 'Accessories'],
  ['TOTE-CNV-NAT', 'Heavy Canvas Tote, Natural', 28, 'Accessories'],
  ['BTL-STL-750', 'Insulated Steel Bottle, 750 ml', 35, 'Kitchen'],
  ['MUG-STN-SAGE', 'Stoneware Mug, Sage', 18, 'Kitchen'],
  ['KNF-CHF-20', "Chef's Knife, 20 cm", 89, 'Kitchen'],
  ['PAN-CI-26', 'Cast Iron Skillet, 26 cm', 64, 'Kitchen'],
  ['GRND-BRR-01', 'Burr Coffee Grinder', 149, 'Coffee'],
  ['BEAN-ETH-250', 'Ethiopia Yirgacheffe Beans, 250 g', 14, 'Coffee'],
  ['KTL-GSN-BLK', 'Gooseneck Kettle, Matte Black', 79, 'Coffee'],
  ['CNDL-CDR-200', 'Cedar & Smoke Candle, 200 g', 26, 'Home'],
  ['THRW-WOL-OAT', 'Wool Throw, Oatmeal', 120, 'Home'],
  ['LAMP-DSK-BRS', 'Brass Desk Lamp', 135, 'Home'],
  ['PLNT-MON-M', 'Monstera in Ceramic Pot, Medium', 45, 'Home'],
  ['NB-DOT-A5', 'Dot Grid Notebook, A5', 16, 'Stationery'],
  ['PEN-FTN-NVY', 'Fountain Pen, Navy', 42, 'Stationery'],
  ['BAG-LTH-TAN', 'Leather Weekender, Tan', 289, 'Accessories'],
].map(([sku, name, price, category]) => ({ sku, name, price, currency: 'GBP', category, image: `https://picsum.photos/seed/${sku}/600/600` }));
const CATALOG_BY_SKU = Object.fromEntries(CATALOG.map((p) => [p.sku, p]));
const FIRST = ['amira', 'ben', 'chloe', 'dev', 'ella', 'finn', 'grace', 'hugo', 'isla', 'jamal', 'kate', 'leo', 'maya', 'noah', 'olivia', 'priya', 'quinn', 'rosa', 'sam', 'tom', 'uma', 'vik', 'willow', 'yusuf', 'zara'];
const LAST = ['adams', 'brown', 'chen', 'davies', 'evans', 'fischer', 'garcia', 'hughes', 'ito', 'jones', 'khan', 'lewis', 'murphy', 'novak', 'okafor', 'patel', 'reid', 'smith', 'taylor', 'walsh'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function ensureSim(c) {
  if (!c.sim) c.sim = { on: true, paused: '', fails: 0, seeded: false, log: [], customers: [] };
  if (!c.sim.catalogInit) {
    for (const p of CATALOG) if (c.stock[p.sku] === undefined) c.stock[p.sku] = Math.random() < 0.45 ? 0 : 3 + Math.floor(Math.random() * 40);
    c.sim.catalogInit = true;
  }
}
const simBusy = new Set();
function simLog(c, text, ok = true) { pushCapped(c.sim.log, { at: now(), text, ok }, 150); save(); }
async function simPost(c, p, body) {
  try {
    const r = await fetch(c.baseUrl + p, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'bis-store-sim/1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status };
  } catch (e) { return { status: 0, error: String(e.message || e) }; }
}
function simHealth(c, reachable) {
  if (reachable) { c.sim.fails = 0; return; }
  if (++c.sim.fails >= 10) c.sim.paused = 'Paused: your app could not be reached 10 times in a row. Resume once it is up.';
}
// Each action takes optional overrides (o) so the test API can force a specific event.
const hookOk = (h) => h.status >= 200 && h.status < 300;
const hookDesc = (hs) => hs.map((h) => h.error || 'HTTP ' + h.status).join(', ');
async function simCustomerSignup(c, o = {}) {
  const out = CATALOG.filter((p) => !c.stock[p.sku]);
  const sku = o.sku || (Math.random() < 0.85 && out.length ? pick(out) : pick(CATALOG)).sku;
  const reuse = !o.email && c.sim.customers.length > 5 && Math.random() < 0.3;
  const email = o.email || (reuse ? pick(c.sim.customers) : `${pick(FIRST)}.${pick(LAST)}${Math.floor(Math.random() * 90) + 10}@example.com`);
  if (!reuse && !o.email) pushCapped(c.sim.customers, email, 200);
  const r = await simPost(c, '/api/requests', { email, sku });
  simHealth(c, r.status !== 0);
  simLog(c, `${o.via || 'Customer'} ${email} asked about ${sku} → ${r.error ? r.error : 'HTTP ' + r.status}`, r.status >= 200 && r.status < 500);
  return { action: 'request', email, sku, app_status: r.status, error: r.error };
}
async function simRestock(c, o = {}) {
  const out = CATALOG.filter((p) => !c.stock[p.sku]);
  if (!o.sku && !out.length) return simSellout(c, o);
  const sku = o.sku || pick(out).sku;
  const qty = o.quantity > 0 ? Math.floor(o.quantity) : 2 + Math.floor(Math.random() * 30);
  c.stock[sku] = qty;
  const eventId = o.event_id || `evt_${rand(6)}`;
  const twice = o.twice ?? Math.random() < 0.2;
  const hooks = await Promise.all([sendWebhook(c, { sku, quantity: qty, eventId, source: o.via || 'sim' }),
    ...(twice ? [sendWebhook(c, { sku, quantity: qty, eventId, source: o.via || 'sim' })] : [])]);
  simHealth(c, hooks.some((h) => !h.error));
  simLog(c, `${o.via ? o.via + ': r' : 'R'}estocked ${sku} to ${qty}${twice ? ' (webhook delivered twice)' : ''} → ${hookDesc(hooks)}`, hooks.every(hookOk));
  return { action: 'restock', sku, quantity: qty, event_id: eventId, deliveries: hooks.map((h) => h.error || h.status) };
}
async function simSellout(c, o = {}) {
  const inStock = CATALOG.filter((p) => c.stock[p.sku] > 0);
  if (!o.sku && !inStock.length) return simRestock(c, o);
  const sku = o.sku || pick(inStock).sku;
  c.stock[sku] = 0;
  const eventId = o.event_id || `evt_${rand(6)}`;
  const h = await sendWebhook(c, { sku, quantity: 0, eventId, source: o.via || 'sim' });
  simHealth(c, !h.error);
  simLog(c, `${o.via ? o.via + ': s' : 'S'}old out ${sku} → ${hookDesc([h])}`, hookOk(h));
  return { action: 'sellout', sku, event_id: eventId, deliveries: [h.error || h.status] };
}
async function simPhantom(c, o = {}) {
  const out = CATALOG.filter((p) => !c.stock[p.sku]);
  if (!o.sku && !out.length) return { action: 'phantom', skipped: 'nothing is sold out' };
  const sku = o.sku || pick(out).sku;
  const eventId = o.event_id || `evt_${rand(6)}`;
  const h = await sendWebhook(c, { sku, quantity: o.quantity > 0 ? Math.floor(o.quantity) : 12, eventId, source: o.via || 'sim' });
  simLog(c, `${o.via ? o.via + ': w' : 'W'}ebhook claimed ${sku} is back, but stock is still ${c.stock[sku] || 0} → ${hookDesc([h])}`, hookOk(h));
  return { action: 'phantom', sku, event_id: eventId, deliveries: [h.error || h.status] };
}
async function simTick(c, forced = false) {
  ensureSim(c);
  if (!c.baseUrl || ext?.busy?.(c)) return;
  if (!forced && (!c.sim.on || c.sim.paused)) return;
  if (!c.sim.seeded) {
    c.sim.seeded = true;
    simLog(c, 'Store simulation started: sending the first customer requests');
    for (let i = 0; i < 6; i++) await simCustomerSignup(c);
    return;
  }
  if (Math.random() < 0.7) await simCustomerSignup(c);
  const roll = Math.random();
  if (roll < 0.3) await simRestock(c);
  else if (roll < 0.5) await simSellout(c);
  else if (roll < 0.55) await simPhantom(c);
}
setInterval(() => {
  for (const c of Object.values(db.candidates)) {
    if (simBusy.has(c.id) || !c.baseUrl) continue;
    simBusy.add(c.id);
    simTick(c).catch((e) => console.error('sim', e)).finally(() => simBusy.delete(c.id));
  }
}, SIM_INTERVAL_MS);

const byToken = (t) => Object.values(db.candidates).find((c) => c.token === t);
const byKey = (k) => k && Object.values(db.candidates).find((c) => c.apiKey === k);

// ---------- http helpers ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json' });
const html = (res, body, status = 200) => send(res, status, body, { 'content-type': 'text/html; charset=utf-8' });
const redirect = (res, to) => send(res, 303, '', { location: to });
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (ch) => { size += ch.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const readForm = async (req) => Object.fromEntries(new URLSearchParams(await readBody(req)));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmt = (iso) => (iso ? iso.replace('T', ' ').slice(0, 19) : '');

function page(title, body, { refresh } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title><style>
:root{--bg:#f5f6f7;--card:#fff;--text:#16191d;--muted:#5f6b76;--border:#dde1e5;--accent:#2457d6;--ok:#11753f;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111417;--card:#1a1e23;--text:#e6e9ec;--muted:#98a3ad;--border:#2d333a;--accent:#6d97ff;--ok:#4cc98a;--bad:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:28px 16px 64px}h1{font-size:1.5rem;margin:0 0 6px}h2{font-size:1.1rem;margin:28px 0 10px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px;overflow-x:auto}
.muted{color:var(--muted)}a{color:var(--accent)}code,pre{font-family:ui-monospace,Consolas,monospace;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;margin:0}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--muted);font-weight:600}
input,select{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px}
button{font:inherit;font-weight:600;border:0;border-radius:6px;padding:7px 14px;background:var(--accent);color:#fff;cursor:pointer}
form.inline{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
</style></head><body><main>${body}</main></body></html>`;
}

// ---------- mock Resend ----------
function handleEmail(c, payload, headers) {
  payload = payload && typeof payload === 'object' ? payload : {};
  const to = (Array.isArray(payload.to) ? payload.to : [payload.to])
    .filter(Boolean).map((s) => String(s).trim().toLowerCase());
  const missing = [];
  if (!payload.from) missing.push('from');
  if (!to.length) missing.push('to');
  if (!payload.subject) missing.push('subject');
  if (!payload.html && !payload.text) missing.push('html or text');
  if (missing.length) return { status: 422, body: { statusCode: 422, name: 'validation_error', message: `Missing required field(s): ${missing.join(', ')}` } };

  const idem = headers['idempotency-key'] || null;
  if (idem) {
    const prev = c.emails.find((e) => e.idempotencyKey === idem && e.status === 'accepted');
    if (prev) {
      pushCapped(c.emails, { id: rand(8), at: now(), from: String(payload.from), to, subject: String(payload.subject), html: '', text: '', idempotencyKey: idem, status: 'deduped (idempotency key)' }, 1000);
      save();
      return { status: 200, body: { id: prev.id } };
    }
  }
  const rec = {
    id: crypto.randomUUID(), at: now(), from: String(payload.from), to, subject: String(payload.subject),
    html: payload.html ? String(payload.html).slice(0, 200_000) : '', text: payload.text ? String(payload.text).slice(0, 50_000) : '',
    idempotencyKey: idem, status: 'accepted',
  };
  let fail = false;
  for (const t of to) if (c.failFor[t] > 0) { c.failFor[t]--; fail = true; }
  if (!fail && c.failNextEmails > 0) { c.failNextEmails--; fail = true; }
  if (fail) rec.status = 'failed (injected 500)';
  pushCapped(c.emails, rec, 1000); save();
  if (fail) return { status: 500, body: { statusCode: 500, name: 'application_error', message: 'Injected failure from the test harness. Treat this as a failed send.' } };
  return { status: 200, body: { id: rec.id } };
}

// ---------- calls to candidate apps ----------
async function sendWebhook(c, { sku, quantity, eventId, secret, source }) {
  const body = { event_id: eventId, type: 'stock.updated', sku, quantity: Number(quantity), occurred_at: now() };
  const rec = { at: body.occurred_at, eventId, sku, quantity: body.quantity, source, status: 0, ms: 0, response: '', badSecret: secret !== undefined };
  const t0 = Date.now();
  try {
    if (!c.baseUrl) throw new Error('No app URL set');
    const r = await fetch(c.baseUrl + '/webhooks/stock', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': secret ?? c.webhookSecret, 'user-agent': 'bis-test-harness/1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    rec.status = r.status; rec.response = (await r.text()).slice(0, 300);
  } catch (e) { rec.error = String(e.message || e); }
  rec.ms = Date.now() - t0;
  pushCapped(c.webhooks, rec, 300); save();
  return rec;
}
// Optional local extensions (harness/extensions.js). The server runs fine without them.
let ext = null;
try { ext = require('./extensions.js')({ db, rand, now, sleep, save, sendWebhook, esc, fmt, readForm, redirect, send, cleanUrl: (u) => cleanUrl(u) }); }
catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// ---------- pages ----------
function homePage(msg = '') {
  return page('Back-in-Stock Challenge', `<h1>Back-in-Stock challenge: test server</h1>
<p class="muted">Sign up to get your stock API key, email key and webhook secret. Read the <a href="/challenge">challenge spec</a> first.</p>
${msg ? `<p class="bad">${esc(msg)}</p>` : ''}
<div class="card"><form method="post" action="/signup" class="inline">
<input name="name" placeholder="Your name" required maxlength="80">
<input name="profile" placeholder="Upwork profile URL" maxlength="200">
${INVITE_CODE ? '<input name="invite" placeholder="Invite code" required maxlength="80">' : ''}
<button>Get my credentials</button></form></div>
<p class="muted">Bookmark your dashboard link after signing up. It is the only way back in.</p>`);
}

function dashboard(c) {
  ensureSim(c);
  const skus = Object.keys(c.stock).filter((s) => !CATALOG_BY_SKU[s]);
  const simState = !c.baseUrl ? 'Waiting for your app URL' : c.sim.paused ? c.sim.paused : c.sim.on ? `Running: something happens about every ${SIM_INTERVAL_MS / 1000}s` : 'Stopped';
  const emails = c.emails.slice(-50).reverse();
  const hooks = c.webhooks.slice(-30).reverse();
  const checks = c.stockChecks.slice(-30).reverse();
  const base = `/c/${c.token}`;
  return page(`Dashboard · ${c.name}`, `<h1>${esc(c.name)}: test dashboard</h1>
<p class="muted">Keep this URL private. <a href="/challenge">Read the challenge spec</a></p>
<h2>Environment variables for your app</h2>
<div class="card"><pre>STOCK_API_URL=${PUBLIC_URL}/api/stock
STOCK_API_KEY=${c.apiKey}
RESEND_API_KEY=${c.apiKey}
RESEND_BASE_URL=${PUBLIC_URL}
WEBHOOK_SECRET=${c.webhookSecret}</pre></div>

<h2>Your app</h2>
<div class="card"><form method="post" action="${base}/baseurl" class="inline">
<input name="baseUrl" value="${esc(c.baseUrl)}" placeholder="https://your-app.example.com" style="flex:1;min-width:260px">
<button>Save URL</button></form>
<p class="muted">We send webhooks to <code>${esc(c.baseUrl || '<your url>')}/webhooks/stock</code>.</p></div>

<h2>Simulated store</h2>
<div class="card"><p><b>${esc(simState)}</b></p>
<p class="muted">Once your app URL is saved, simulated customers ask about sold-out products, products restock and sell out, and webhooks arrive, all the time.
Sometimes a webhook is delivered twice, and sometimes a webhook claims a product is back when it isn't.
<code>GET ${PUBLIC_URL}/api/stock</code> lists the catalogue.</p>
<form method="post" action="${base}/sim" class="inline">
${c.sim.on && !c.sim.paused ? '<button name="action" value="stop">Stop simulation</button>' : '<button name="action" value="start">Start simulation</button>'}</form>
<details><summary>Activity (latest first)</summary><table>${c.sim.log.slice(-40).reverse().map((l) => `<tr><td>${fmt(l.at)}</td><td class="${l.ok ? '' : 'bad'}">${esc(l.text)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet</td></tr>'}</table></details></div>

<h2>Catalogue</h2>
<div class="card"><table><tr><th>SKU</th><th>Product</th><th>Price</th><th>Stock</th></tr>
${CATALOG.map((pr) => `<tr><td><code>${pr.sku}</code></td><td>${esc(pr.name)}</td><td>£${pr.price}</td><td>${c.stock[pr.sku] ? c.stock[pr.sku] : '<span class="bad">sold out</span>'}</td></tr>`).join('')}</table></div>

<h2>Set stock by hand</h2>
<div class="card"><form method="post" action="${base}/stock" class="inline">
<input name="sku" placeholder="SKU, e.g. ABC-1" required maxlength="64"><input name="quantity" type="number" min="0" value="5" style="width:90px">
<button>Set stock</button></form>
<table><tr><th>SKU</th><th>Quantity</th></tr>${skus.map((s) => `<tr><td>${esc(s)}</td><td>${c.stock[s]}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Catalogue SKUs are listed above. Any other SKU returns quantity 0 until you set it here.</td></tr>'}</table></div>

<h2>Send a webhook</h2>
<div class="card"><form method="post" action="${base}/webhook" class="inline">
<input name="sku" placeholder="SKU" required maxlength="64"><input name="quantity" type="number" min="0" value="5" style="width:90px">
<input name="eventId" value="evt_${rand(4)}" maxlength="64"><button>Send</button></form>
<p class="muted">Send the same event ID again to test duplicate delivery. The webhook quantity is only a hint: your app must check the stock API.</p></div>

<h2>Email failures</h2>
<div class="card"><form method="post" action="${base}/fail" class="inline">
Make the next <input name="n" type="number" min="0" max="20" value="${c.failNextEmails || 1}" style="width:70px"> email(s) fail with HTTP 500 <button>Set</button>
<span class="muted">(currently ${c.failNextEmails} queued)</span></form></div>

<h2>Inbox (emails your app sent)</h2>
<div class="card"><table><tr><th>Time</th><th>To</th><th>Subject</th><th>Status</th><th></th></tr>
${emails.map((e) => `<tr><td>${fmt(e.at)}</td><td>${esc(e.to.join(', '))}</td><td>${esc(e.subject)}</td><td>${esc(e.status)}</td><td>${e.html || e.text ? `<a href="${base}/email/${e.id}" target="_blank" rel="noopener">view</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing yet</td></tr>'}</table></div>

<h2>Webhooks sent</h2>
<div class="card"><table><tr><th>Time</th><th>Event</th><th>SKU</th><th>Qty</th><th>Result</th></tr>
${hooks.map((w) => `<tr><td>${fmt(w.at)}</td><td>${esc(w.eventId)}${w.badSecret ? ' <span class="muted">(wrong secret)</span>' : ''}</td><td>${esc(w.sku)}</td><td>${w.quantity}</td><td>${w.error ? `<span class="bad">${esc(w.error)}</span>` : `HTTP ${w.status} · ${w.ms}ms`}<div class="muted">${esc(w.response)}</div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing yet</td></tr>'}</table></div>

<h2>Stock API calls from your app</h2>
<div class="card"><table><tr><th>Time</th><th>SKU</th><th>Returned</th></tr>
${checks.map((s) => `<tr><td>${fmt(s.at)}</td><td>${esc(s.sku)}</td><td>${s.quantity}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing yet</td></tr>'}</table></div>`, {});
}

function adminList() {
  const cs = Object.values(db.candidates).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return page('Admin · Back-in-Stock', `<h1>Candidates</h1>
<div class="card"><form method="post" action="/admin/new" class="inline"><input name="name" placeholder="Candidate name" required><input name="profile" placeholder="Upwork profile"><button>Add candidate</button></form></div>
<div class="card"><table><tr><th>Name</th><th>Signed up</th><th>App URL</th><th>Emails</th>${ext?.listHeader || ''}<th></th></tr>
${cs.map((c) => { return `<tr><td>${esc(c.name)}${c.profile ? `<div class="muted">${esc(c.profile)}</div>` : ''}</td><td>${fmt(c.createdAt)}</td><td>${c.baseUrl ? `<a href="${esc(c.baseUrl)}" target="_blank" rel="noopener">${esc(c.baseUrl)}</a>` : '<span class="muted">not set</span>'}</td><td>${c.emails.length}</td>${ext?.listCell ? ext.listCell(c) : ''}<td><a href="/admin/c/${c.id}">open</a></td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No candidates yet</td></tr>'}
</table></div>`);
}

function adminCandidate(c) {
  return page(`Admin · ${c.name}`, `<p><a href="/admin">All candidates</a></p><h1>${esc(c.name)}</h1>
<p class="muted">${esc(c.profile)} · <a href="/c/${c.token}" target="_blank" rel="noopener">candidate dashboard</a> (share this link with the candidate)</p>
<div class="card">App URL: ${c.baseUrl ? `<a href="${esc(c.baseUrl)}" target="_blank" rel="noopener">${esc(c.baseUrl)}</a>` : '<span class="muted">not set</span>'} · ${c.emails.length} email(s) · ${c.webhooks.length} webhook(s)</div>
${ext?.adminSection ? ext.adminSection(c) : ''}`, { refresh: ext?.refresh?.(c) });
}

function checkAdmin(req, res) {
  if (!ADMIN_PASSWORD) { send(res, 503, 'Set ADMIN_PASSWORD to enable the admin pages.'); return false; }
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  send(res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="harness-admin"' });
  return false;
}
const cleanUrl = (u) => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.origin + x.pathname.replace(/\/+$/, '') : ''; } catch { return ''; } };

// ---------- router ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname, m = req.method;
  let mm;

  if (p === '/healthz') return send(res, 200, 'ok');
  if (m === 'GET' && p === '/') return html(res, homePage());
  if (m === 'GET' && p === '/challenge') return html(res, page('Challenge spec', `<p><a href="/">Back</a></p><div class="card"><pre>${esc(CHALLENGE_TEXT)}</pre></div>`));
  if (m === 'POST' && p === '/signup') {
    const f = await readForm(req);
    if (INVITE_CODE && f.invite !== INVITE_CODE) return html(res, homePage('Wrong invite code.'), 403);
    if (Object.keys(db.candidates).length >= 500) return html(res, homePage('Sign-ups are closed.'), 403);
    const c = newCandidate(String(f.name || '').slice(0, 80) || 'Anonymous', String(f.profile || '').slice(0, 200));
    return redirect(res, `/c/${c.token}`);
  }

  // Mock stock API
  if (m === 'GET' && (mm = p.match(/^\/api\/stock(?:\/(.*))?$/))) {
    const auth = req.headers.authorization || '';
    const c = byKey(auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('key'));
    if (!c) return json(res, 401, { error: 'Missing or invalid API key. Use Authorization: Bearer <STOCK_API_KEY>.' });
    ensureSim(c);
    const sku = decodeURIComponent(mm[1] || '').trim();
    if (!sku) return json(res, 200, { products: CATALOG.map((pr) => ({ ...pr, quantity: c.stock[pr.sku] || 0, in_stock: c.stock[pr.sku] > 0 })) });
    const quantity = Number(c.stock[sku] ?? c.stock[sku.toUpperCase()] ?? 0);
    pushCapped(c.stockChecks, { at: now(), sku, quantity }, 500); save();
    const known = CATALOG_BY_SKU[sku.toUpperCase()]
      || ((c.stock[sku] ?? c.stock[sku.toUpperCase()]) !== undefined
        ? { name: `Sample item ${sku.toUpperCase()}`, price: 10, currency: 'GBP', category: 'Other', image: `https://picsum.photos/seed/${encodeURIComponent(sku)}/600/600` }
        : {});
    return json(res, 200, { ...known, sku, quantity, in_stock: quantity > 0 });
  }

  // Test API: force store events. Same key as the stock API.
  if (m === 'POST' && (mm = p.match(/^\/api\/test\/(restock|sellout|request|phantom|tick)$/))) {
    const auth = req.headers.authorization || '';
    const c = byKey(auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('key'));
    if (!c) return json(res, 401, { error: 'Missing or invalid API key.' });
    if (!c.baseUrl) return json(res, 409, { error: 'Save your app URL on the dashboard first.' });
    let o = {};
    try { const b = await readBody(req); o = b ? JSON.parse(b) : {}; } catch { return json(res, 400, { error: 'Body must be JSON.' }); }
    o = { sku: o.sku ? String(o.sku).slice(0, 64) : undefined, quantity: Number(o.quantity) || undefined, email: o.email ? String(o.email).slice(0, 200) : undefined,
      event_id: o.event_id ? String(o.event_id).slice(0, 64) : undefined, twice: typeof o.twice === 'boolean' ? o.twice : undefined, via: 'Test API' };
    ensureSim(c);
    c.testApiCalls = (c.testApiCalls || 0) + 1; c.testApiLastAt = now();
    const fn = { restock: simRestock, sellout: simSellout, request: simCustomerSignup, phantom: simPhantom }[mm[1]];
    const result = fn ? await fn(c, o) : (await simTick(c, true), { action: 'tick' });
    save();
    return json(res, 200, result);
  }

  // Mock Resend API
  if (m === 'POST' && (p === '/emails' || p === '/emails/batch')) {
    const auth = req.headers.authorization || '';
    const c = byKey(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    if (!c) return json(res, 401, { statusCode: 401, name: 'missing_api_key', message: 'Missing or invalid API key. Use Authorization: Bearer <RESEND_API_KEY>.' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return json(res, 400, { statusCode: 400, name: 'invalid_json', message: 'Body must be JSON.' }); }
    if (p === '/emails') { const r = handleEmail(c, payload, req.headers); return json(res, r.status, r.body); }
    if (!Array.isArray(payload)) return json(res, 422, { statusCode: 422, name: 'validation_error', message: 'Batch body must be an array.' });
    const results = payload.slice(0, 100).map((e) => handleEmail(c, e, {}));
    const failed = results.find((r) => r.status !== 200);
    if (failed) return json(res, failed.status, failed.body);
    return json(res, 200, { data: results.map((r) => r.body) });
  }

  // Candidate dashboard
  if ((mm = p.match(/^\/c\/([a-f0-9]{32})(\/.*)?$/))) {
    const c = byToken(mm[1]);
    if (!c) return send(res, 404, 'Not found');
    const sub = mm[2] || '';
    const back = `/c/${c.token}`;
    if (m === 'GET' && sub === '') return html(res, dashboard(c));
    if (m === 'GET' && (mm = sub.match(/^\/email\/([\w-]+)$/))) {
      const e = c.emails.find((x) => x.id === mm[1]);
      if (!e) return send(res, 404, 'Not found');
      return e.html
        ? send(res, 200, e.html, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'sandbox' })
        : send(res, 200, e.text);
    }
    if (m === 'POST') {
      const f = await readForm(req);
      if (sub === '/baseurl') { c.baseUrl = cleanUrl(f.baseUrl); ensureSim(c); c.sim.paused = ''; c.sim.fails = 0; save(); return redirect(res, back); }
      if (sub === '/sim') { ensureSim(c); c.sim.on = f.action === 'start'; c.sim.paused = ''; c.sim.fails = 0; save(); return redirect(res, back); }
      if (sub === '/stock') { const s = String(f.sku || '').trim().slice(0, 64); if (s) c.stock[s] = Math.max(0, Number(f.quantity) || 0); save(); return redirect(res, back); }
      if (sub === '/fail') { c.failNextEmails = Math.min(20, Math.max(0, Number(f.n) || 0)); save(); return redirect(res, back); }
      if (sub === '/webhook') {
        await sendWebhook(c, { sku: String(f.sku || '').trim().slice(0, 64), quantity: Number(f.quantity) || 0, eventId: String(f.eventId || `evt_${rand(4)}`).slice(0, 64), source: 'manual' });
        return redirect(res, back);
      }
    }
    return send(res, 404, 'Not found');
  }

  // Admin
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!checkAdmin(req, res)) return;
    if (m === 'GET' && p === '/admin') return html(res, adminList());
    if (m === 'POST' && p === '/admin/new') {
      const f = await readForm(req);
      const c = newCandidate(String(f.name || '').slice(0, 80) || 'Unnamed', String(f.profile || '').slice(0, 200));
      return redirect(res, `/admin/c/${c.id}`);
    }
    if (m === 'GET' && (mm = p.match(/^\/admin\/c\/(\w+)$/))) {
      const c = db.candidates[mm[1]];
      return c ? html(res, adminCandidate(c)) : send(res, 404, 'Not found');
    }
    if (ext?.adminRoute && (await ext.adminRoute(req, res, p, m))) return;
    return send(res, 404, 'Not found');
  }

  return send(res, 404, 'Not found');
}

for (const c of Object.values(db.candidates)) ensureSim(c);
ext?.init?.();

http.createServer((req, res) => {
  route(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Internal error'); });
}).listen(PORT, () => console.log(`Harness on ${PUBLIC_URL} (port ${PORT})`));
