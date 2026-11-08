// End-to-end scenarios against a running app container and a real harness.
// Prints scenario results only, never credentials. See README "Testing" for how to run it.
//
// Env: APP_URL, DASHBOARD_URL (harness dashboard), WEBHOOK_SECRET, ADMIN_PASSWORD, APP_CONTAINER.
// Optional: HARNESS_CONTAINER enables the scenario where the stock and email APIs go down.
// Optional: ONLY=s1,s2 runs a subset.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const { APP_URL, DASHBOARD_URL, WEBHOOK_SECRET, ADMIN_PASSWORD, APP_CONTAINER, HARNESS_CONTAINER } =
  process.env;
for (const [k, v] of Object.entries({
  APP_URL,
  DASHBOARD_URL,
  WEBHOOK_SECRET,
  ADMIN_PASSWORD,
  APP_CONTAINER,
})) {
  if (!v) throw new Error(`Missing env ${k}`);
}
const only = process.env.ONLY?.split(',');
const run = randomBytes(3).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const form = (path, body) =>
  fetch(DASHBOARD_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    redirect: 'manual',
  });
const setStock = (sku, quantity) => form('/stock', { sku, quantity: String(quantity) });
const failNext = (n) => form('/fail', { n: String(n) });

const postRequest = (email, sku) =>
  fetch(`${APP_URL}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, sku }),
  });
const postWebhook = (event, secret = WEBHOOK_SECRET) =>
  fetch(`${APP_URL}/webhooks/stock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
    body: JSON.stringify({ type: 'stock.updated', ...event }),
  });
const adminSearch = async (q) => {
  const r = await fetch(`${APP_URL}/admin?q=${encodeURIComponent(q)}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64')}`,
      accept: 'text/html',
    },
  });
  return { status: r.status, html: await r.text() };
};

/** Rows of the harness inbox for this run: { to, subject, status }. */
async function inbox(prefix) {
  const html = await (await fetch(DASHBOARD_URL)).text();
  const section = html.split('Inbox (emails your app sent)')[1]?.split('Webhooks sent')[0] ?? '';
  const rows = [
    ...section.matchAll(/<tr><td>[^<]*<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td><td>([^<]*)<\/td>/g),
  ].map((m) => ({ to: m[1], subject: m[2], status: m[3] }));
  return rows.filter((r) => r.to.startsWith(prefix));
}
const accepted = (rows) => rows.filter((r) => r.status === 'accepted');
const perRecipient = (rows) => {
  const counts = {};
  for (const r of accepted(rows)) counts[r.to] = (counts[r.to] ?? 0) + 1;
  return counts;
};
async function until(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(1000);
  }
  return false;
}
function check(cond, msg) {
  if (!cond) throw new Error(msg);
}
const docker = (...args) => execFileSync('docker', args, { stdio: 'ignore' });
async function waitHealthy() {
  check(
    await until(
      () =>
        fetch(`${APP_URL}/healthz`).then(
          (r) => r.ok,
          () => false,
        ),
      30_000,
    ),
    'app did not come back',
  );
}
const sku = (s) => `QA-${run}-${s}`.toUpperCase();
const mail = (s, who) => `qa-${run}-${s}-${who}@example.com`;
const expectOneEach = async (prefix, n, timeoutMs) => {
  const ok = await until(
    async () => Object.keys(perRecipient(await inbox(prefix))).length >= n,
    timeoutMs,
  );
  const counts = perRecipient(await inbox(prefix));
  check(ok, `expected ${n} recipients, saw ${Object.keys(counts).length}`);
  // Linger: a duplicate would show up after the first delivery.
  await sleep(8000);
  const final = perRecipient(await inbox(prefix));
  check(Object.keys(final).length === n, `recipients ${Object.keys(final).length} != ${n}`);
  check(
    Object.values(final).every((c) => c === 1),
    `duplicate emails: ${JSON.stringify(Object.values(final))}`,
  );
};

const scenarios = {
  async s1_multi_customer_concurrent_duplicate_webhook() {
    const s = sku('s1');
    await setStock(s, 0);
    const rs = await Promise.all(['a', 'b', 'c'].map((w) => postRequest(mail('s1', w), s)));
    check(
      rs.every((r) => r.status === 201),
      'requests not created',
    );
    const dupes = await Promise.all(
      Array.from({ length: 10 }, () => postRequest(mail('s1', 'a').toUpperCase(), s.toLowerCase())),
    );
    check(
      dupes.every((r) => r.status === 200),
      'duplicate request status',
    );
    await setStock(s, 5);
    const hooks = await Promise.all(
      Array.from({ length: 10 }, () =>
        postWebhook({ event_id: `evt_${run}_s1`, sku: s, quantity: 5 }),
      ),
    );
    check(
      hooks.every((r) => r.ok),
      'a webhook delivery was not 2xx',
    );
    const bodies = await Promise.all(hooks.map((r) => r.json()));
    check(bodies.filter((b) => !b.duplicate).length === 1, 'event processed more than once');
    await expectOneEach(`qa-${run}-s1-`, 3, 30_000);
    const a = await adminSearch(mail('s1', 'a'));
    check(a.status === 200 && a.html.includes(mail('s1', 'a')), 'admin does not list the request');
    return '3 customers, 10 concurrent duplicate requests and webhooks: 1 email each';
  },
  async s2_phantom_webhook_sends_nothing() {
    const s = sku('s2');
    await setStock(s, 0);
    await postRequest(mail('s2', 'a'), s);
    const r = await postWebhook({ event_id: `evt_${run}_s2`, sku: s, quantity: 12 });
    check(r.ok, 'webhook rejected');
    await sleep(8000);
    check((await inbox(`qa-${run}-s2-`)).length === 0, 'email sent for a phantom restock');
    return 'webhook claimed 12, stock API said 0: no email';
  },
  async s3_webhook_auth_and_validation() {
    const s = sku('s3');
    const bad = await postWebhook({ event_id: `evt_${run}_s3`, sku: s, quantity: 1 }, 'wrong');
    check(bad.status === 401, `wrong secret gave ${bad.status}`);
    const missing = await fetch(`${APP_URL}/webhooks/stock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    check(missing.status === 401, `missing secret gave ${missing.status}`);
    const invalid = await postWebhook({ event_id: `evt_${run}_s3b`, sku: s, quantity: 'lots' });
    check(invalid.status === 400, `invalid payload gave ${invalid.status}`);
    const noAuth = await fetch(`${APP_URL}/admin`, { headers: { accept: 'application/json' } });
    check(noAuth.status === 401, `admin without auth gave ${noAuth.status}`);
    return 'wrong and missing secret 401, bad payload 400, admin 401';
  },
  async s4_email_failures_are_retried() {
    const s = sku('s4');
    await setStock(s, 0);
    await postRequest(mail('s4', 'a'), s);
    await sleep(2000);
    await setStock(s, 5);
    await failNext(2);
    await postWebhook({ event_id: `evt_${run}_s4`, sku: s, quantity: 5 });
    await expectOneEach(`qa-${run}-s4-`, 1, 60_000);
    const rows = await inbox(`qa-${run}-s4-`);
    const failed = rows.filter((r) => r.status.startsWith('failed'));
    check(failed.length === 2, `expected 2 injected failures, saw ${failed.length}`);
    return '2 injected 500s, then exactly 1 accepted';
  },
  async s5_already_in_stock_at_signup() {
    const s = sku('s5');
    await setStock(s, 3);
    await postRequest(mail('s5', 'a'), s);
    await expectOneEach(`qa-${run}-s5-`, 1, 20_000);
    return 'signup for an in-stock item emails without any webhook';
  },
  async s6_missed_webhook_found_by_reconciler() {
    const s = sku('s6');
    await setStock(s, 0);
    await postRequest(mail('s6', 'a'), s);
    await sleep(3000);
    await setStock(s, 4);
    await expectOneEach(`qa-${run}-s6-`, 1, 90_000);
    return 'no webhook sent at all: reconciler emailed within its interval';
  },
  async s7_sigkill_restock_while_down() {
    const s = sku('s7');
    await setStock(s, 0);
    for (const w of ['a', 'b', 'c', 'd', 'e']) await postRequest(mail('s7', w), s);
    await sleep(2000);
    docker('kill', '--signal=KILL', APP_CONTAINER);
    await setStock(s, 5);
    docker('start', APP_CONTAINER);
    await waitHealthy();
    await expectOneEach(`qa-${run}-s7-`, 5, 30_000);
    return 'SIGKILL, restock during downtime, restart: 5 requests survived, 1 email each';
  },
  async s8_sigkill_mid_send() {
    // docker kill has its own latency, so try increasing delays until the kill lands mid-batch.
    const outcomes = [];
    for (const [round, delayMs] of [0, 0, 5, 15, 30, 60].entries()) {
      const tag = `s8r${round}`;
      const s = sku(tag);
      await setStock(s, 0);
      const who = Array.from({ length: 40 }, (_, i) => `c${i}`);
      await Promise.all(who.map((w) => postRequest(mail(tag, w), s)));
      await sleep(1500);
      await setStock(s, 9);
      await postWebhook({ event_id: `evt_${run}_${tag}`, sku: s, quantity: 9 });
      if (delayMs) await sleep(delayMs);
      docker('kill', '--signal=KILL', APP_CONTAINER);
      const before = accepted(await inbox(`qa-${run}-${tag}-`)).length;
      docker('start', APP_CONTAINER);
      await waitHealthy();
      await expectOneEach(`qa-${run}-${tag}-`, 40, 60_000);
      const deduped = (await inbox(`qa-${run}-${tag}-`)).filter((r) =>
        r.status.startsWith('deduped'),
      ).length;
      outcomes.push(`${before}/40 accepted at kill, ${deduped} deduped`);
      if (before > 0 && before < 40) {
        return `SIGKILL landed mid-batch: ${outcomes.join('; ')}; 1 email each`;
      }
    }
    return `INCONCLUSIVE, kill never landed mid-batch: ${outcomes.join('; ')}; 1 email each`;
  },
  async s9_future_restock_cycle() {
    const s = sku('s9');
    await setStock(s, 3);
    await postRequest(mail('s9', 'a'), s);
    await expectOneEach(`qa-${run}-s9-`, 1, 20_000);
    await setStock(s, 0);
    const again = await postRequest(mail('s9', 'a'), s);
    check(again.status === 201, `re-request after notified gave ${again.status}`);
    await sleep(3000);
    check(accepted(await inbox(`qa-${run}-s9-`)).length === 1, 'emailed while sold out');
    await setStock(s, 3);
    await postWebhook({ event_id: `evt_${run}_s9`, sku: s, quantity: 3 });
    check(
      await until(async () => accepted(await inbox(`qa-${run}-s9-`)).length === 2, 20_000),
      'second cycle email missing',
    );
    return 'second restock cycle gives exactly one more email';
  },
  async s10_stock_and_email_api_outage() {
    if (!HARNESS_CONTAINER) return 'SKIPPED: needs a local harness container';
    const s = sku('s10');
    await setStock(s, 0);
    await postRequest(mail('s10', 'a'), s);
    await sleep(2000);
    await setStock(s, 6);
    await sleep(1500); // The harness saves state on a 250ms timer.
    docker('stop', HARNESS_CONTAINER);
    const r = await postWebhook({ event_id: `evt_${run}_s10`, sku: s, quantity: 6 });
    check(r.ok, `webhook during outage gave ${r.status}`);
    await sleep(10_000);
    docker('start', HARNESS_CONTAINER);
    check(
      await until(
        () =>
          fetch(DASHBOARD_URL).then(
            (x) => x.ok,
            () => false,
          ),
        30_000,
      ),
      'harness did not return',
    );
    await expectOneEach(`qa-${run}-s10-`, 1, 90_000);
    return 'webhook acked during a 10s outage, email delivered after recovery';
  },
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (only && !only.some((o) => name.startsWith(`${o}_`))) continue;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS ${name} (${Math.round((Date.now() - t0) / 1000)}s): ${detail}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);
