import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AdminViewModel,
  EmbedViewModel,
  RequestRow,
  WebhookEventRow,
} from '../src/contracts.ts';
import { renderAdmin } from '../src/http/views/admin.ts';
import { renderEmbed } from '../src/http/views/embed.ts';
import { esc, formatDateUtc, formatPrice, safeJson, timeTag } from '../src/http/views/html.ts';
import { renderLogin } from '../src/http/views/login.ts';

const NONCE = 'test-nonce-123';
const XSS = `<script>alert(1)</script>"'><img src=x onerror=alert(2)>`;
/** The payload's tag, which must never reach the output unescaped. */
const RAW_MARKERS = ['<script>alert', '<img src=x'];

const makeRow = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 'req-1',
  email: 'ada@example.com',
  sku: 'TEE-1',
  skuKey: 'TEE-1',
  status: 'open',
  createdAt: '2026-11-08T14:03:00.000Z',
  updatedAt: '2026-11-08T14:03:00.000Z',
  product: null,
  verifiedAt: null,
  attempts: 0,
  firstAttemptAt: null,
  nextAttemptAt: null,
  leaseUntil: null,
  sendInFlight: false,
  ambiguousSend: false,
  lastError: null,
  providerId: null,
  notifiedAt: null,
  ...over,
});

const makeEvent = (over: Partial<WebhookEventRow> = {}): WebhookEventRow => ({
  eventId: 'evt_1',
  sku: 'TEE-1',
  skuKey: 'TEE-1',
  quantity: 5,
  receivedAt: '2026-11-08T14:03:00.000Z',
  processedAt: null,
  verifiedQuantity: null,
  outcome: 'pending',
  ...over,
});

const makeAdmin = (over: Partial<AdminViewModel> = {}): AdminViewModel => ({
  rows: [makeRow()],
  total: 1,
  counts: { open: 1, queued: 0, sending: 0, notified: 0, failed: 0 },
  search: '',
  status: null,
  page: 1,
  pageSize: 25,
  events: [],
  nonce: NONCE,
  ...over,
});

const makeEmbed = (over: Partial<EmbedViewModel> = {}): EmbedViewModel => ({
  sku: null,
  product: null,
  catalogue: [],
  nonce: NONCE,
  ...over,
});

const pages = (): Record<string, string> => ({
  embed: renderEmbed(makeEmbed()),
  'embed with data': renderEmbed(
    makeEmbed({
      sku: 'TEE-1',
      product: { name: 'Tee', price: 10, currency: 'GBP', image: 'https://img.example/a.png' },
      catalogue: [{ sku: 'TEE-1', name: 'Tee', available: false }],
    }),
  ),
  login: renderLogin({ error: 'Wrong password', nonce: NONCE }),
  admin: renderAdmin(
    makeAdmin({
      rows: [makeRow({ status: 'failed', lastError: 'boom' })],
      events: [makeEvent()],
    }),
  ),
});

const assertNoRawPayload = (html: string): void => {
  for (const marker of RAW_MARKERS) {
    assert.equal(html.includes(marker), false, `output contains raw ${marker}`);
  }
};

/** Pulls a named option's href out of the pagination markup, decoding the attribute. */
const hrefOf = (html: string, rel: 'prev' | 'next'): string => {
  const match = html.match(new RegExp(`rel="${rel}" href="([^"]*)"`));
  assert.ok(match?.[1], `no ${rel} link`);
  return match[1].replaceAll('&amp;', '&');
};

describe('html helpers', () => {
  it('escapes all HTML-significant characters', () => {
    assert.equal(
      esc(`<a href="x" id='y'>&\``),
      '&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;&#96;',
    );
    assert.equal(esc(null), '');
  });

  it('produces JSON that cannot break out of a script element', () => {
    const json = safeJson({ a: '</script><!-- \u2028 &' });
    assert.equal(/[<>&\u2028]/.test(json), false);
    assert.deepEqual(JSON.parse(json), { a: '</script><!-- \u2028 &' });
  });

  it('formats prices and survives bad currencies', () => {
    assert.equal(formatPrice(10, 'GBP'), '£10.00');
    assert.equal(formatPrice(10, 'not a currency'), '10.00 not a currency');
    assert.equal(formatPrice(10), '10.00');
    assert.equal(formatPrice(undefined, 'GBP'), null);
    assert.equal(formatPrice(Number.NaN, 'GBP'), null);
  });

  it('formats dates in UTC inside a time element, and escapes what it cannot parse', () => {
    assert.equal(formatDateUtc('2026-11-08T14:03:00.000Z'), '8 Nov 2026, 14:03 UTC');
    assert.equal(
      timeTag('2026-11-08T14:03:00.000Z'),
      '<time datetime="2026-11-08T14:03:00.000Z">8 Nov 2026, 14:03 UTC</time>',
    );
    assertNoRawPayload(timeTag(XSS));
  });
});

describe('CSP compatibility', () => {
  for (const [name, html] of Object.entries(pages())) {
    it(`${name}: every style and script element carries the nonce`, () => {
      const tags = html.match(/<(style|script)\b[^>]*>/g) ?? [];
      assert.ok(tags.some((tag) => tag.startsWith('<style')));
      for (const tag of tags) assert.ok(tag.includes(`nonce="${NONCE}"`), `${tag} has no nonce`);
    });

    it(`${name}: no inline style attributes or event handlers`, () => {
      assert.equal(/\sstyle\s*=/.test(html), false, 'style attribute found');
      assert.equal(/\son\w+\s*=/.test(html), false, 'event handler found');
    });

    it(`${name}: is a full document with no external assets`, () => {
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.equal(/<link\b(?![^>]*href="data:)/.test(html), false);
      assert.equal(/<script\b[^>]*\ssrc=/.test(html), false);
    });
  }
});

describe('embed', () => {
  it('prefills a pre-selected SKU as readonly and offers no "add another"', () => {
    const html = renderEmbed(makeEmbed({ sku: 'TEE-1' }));
    const input = html.match(/<input[^>]*id="sku"[^>]*>/)?.[0] ?? '';
    assert.ok(input.includes('value="TEE-1"'));
    assert.ok(input.includes(' readonly'));
    assert.equal(html.includes('id="bis-again"'), false);
  });

  it('keeps the SKU a free-text input with a datalist, never a select', () => {
    const html = renderEmbed(
      makeEmbed({ catalogue: [{ sku: 'TEE-1', name: 'Tee', available: true }] }),
    );
    const input = html.match(/<input[^>]*id="sku"[^>]*>/)?.[0] ?? '';
    assert.ok(input.includes('type="text"'));
    assert.ok(input.includes('list="sku-options"'));
    assert.equal(input.includes('readonly'), false);
    assert.ok(html.includes('<datalist id="sku-options">'));
    assert.ok(html.includes('<option value="TEE-1">'));
    assert.equal(html.includes('<select'), false);
    assert.ok(html.includes('id="bis-again"'));
  });

  it('stays free text with an empty catalogue', () => {
    const html = renderEmbed(makeEmbed());
    assert.equal(html.includes('<select'), false);
    assert.equal(html.includes('<datalist'), false);
    assert.equal(html.includes(' list='), false);
  });

  it('has real labels and a noscript message', () => {
    const html = renderEmbed(makeEmbed());
    assert.ok(html.includes('<label for="email">'));
    assert.ok(html.includes('<label for="sku">'));
    assert.ok(html.includes('<noscript>'));
  });

  it('stays transparent in a frame: no viewport height, no colour scheme on the root', () => {
    const html = renderEmbed(makeEmbed());
    assert.equal(html.includes('100vh'), false);
    assert.ok(html.includes(':root { color-scheme: normal; }'));
  });

  it('shows the product, and only https images', () => {
    const shown = renderEmbed(
      makeEmbed({
        sku: 'TEE-1',
        product: { name: 'Tee', price: 12.5, currency: 'GBP', image: 'https://img.example/a.png' },
      }),
    );
    assert.ok(shown.includes('Tee'));
    assert.ok(shown.includes('£12.50'));
    assert.ok(shown.includes('src="https://img.example/a.png"'));

    const http = renderEmbed(
      makeEmbed({ sku: 'T', product: { image: 'http://img.example/a.png' } }),
    );
    assert.equal(http.includes('<img'), false);
    const js = renderEmbed(makeEmbed({ sku: 'T', product: { image: 'javascript:alert(1)' } }));
    assert.equal(js.includes('<img'), false);
  });

  it('escapes hostile values in every field', () => {
    const html = renderEmbed({
      sku: XSS,
      product: {
        name: XSS,
        price: 1,
        currency: XSS,
        image: `https://img.example/"><script>alert(3)</script>`,
      },
      catalogue: [{ sku: XSS, name: XSS, available: false }],
      nonce: NONCE,
    });
    assertNoRawPayload(html);
    assert.equal(html.includes('<script>alert(3)'), false);
  });

  it('keeps </script> in the catalogue from closing the JSON block', () => {
    const html = renderEmbed(
      makeEmbed({
        catalogue: [{ sku: '</script><script>alert(1)</script>', name: '<!--', available: true }],
      }),
    );
    const block = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(block);
    assert.equal(block.includes('<'), false);
    assert.deepEqual(JSON.parse(block), [
      { sku: '</script><script>alert(1)</script>', name: '<!--', available: true },
    ]);
    assert.equal(html.includes('<script>alert(1)'), false);
  });

  it('escapes the nonce too', () => {
    const html = renderEmbed(makeEmbed({ nonce: '"><script>alert(1)</script>' }));
    assert.equal(html.includes('<script>alert(1)'), false);
  });

  it('uses textContent, not innerHTML, for server data in client JS', () => {
    const html = renderEmbed(makeEmbed());
    assert.equal(html.includes('innerHTML'), false);
    assert.equal(html.includes('insertAdjacentHTML'), false);
    assert.ok(html.includes('back-in-stock:resize'));
    assert.ok(html.includes('AbortController'));
  });
});

describe('login', () => {
  it('posts the password to /admin/login, and works without script', () => {
    const html = renderLogin({ error: null, nonce: NONCE });
    assert.ok(html.includes('method="post" action="/admin/login"'));
    assert.ok(html.includes('name="password"'));
    assert.ok(html.includes('autocomplete="current-password"'));
    assert.ok(html.includes('autofocus'));
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('role="alert"'), false);
  });

  it('shows the error, escaped', () => {
    const html = renderLogin({ error: XSS, nonce: NONCE });
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes('&lt;script&gt;alert(1)'));
    assertNoRawPayload(html);
  });
});

describe('admin', () => {
  it('is noindex and works without client script', () => {
    const html = renderAdmin(makeAdmin());
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.equal(html.includes('<script'), false);
    assert.ok(html.includes('method="post" action="/admin/logout"'));
    assert.ok(html.includes('method="get" action="/admin"'));
  });

  it('escapes hostile values in every dynamic field', () => {
    const hostile = makeRow({
      id: XSS,
      email: XSS,
      sku: XSS,
      status: 'failed',
      lastError: XSS,
      product: { name: XSS },
      createdAt: XSS,
    });
    const html = renderAdmin(
      makeAdmin({
        rows: [hostile, makeRow({ status: 'queued', lastError: XSS, attempts: 2 })],
        total: 2,
        search: XSS,
        events: [makeEvent({ eventId: XSS, sku: XSS, receivedAt: XSS })],
        page: 1,
      }),
    );
    assertNoRawPayload(html);
    assert.ok(html.includes('&lt;script&gt;alert(1)'));
    // The search box keeps the value, safely.
    assert.ok(html.includes(`value="${esc(XSS)}"`));
  });

  it('labels each status tile, links it to its filter, and marks the active one', () => {
    const html = renderAdmin(
      makeAdmin({
        status: 'failed',
        rows: [],
        total: 0,
        counts: { open: 12, queued: 3, sending: 1, notified: 40, failed: 2 },
      }),
    );
    for (const [status, label] of [
      ['open', 'Waiting'],
      ['queued', 'Queued'],
      ['sending', 'Sending'],
      ['notified', 'Notified'],
      ['failed', 'Failed'],
    ]) {
      assert.ok(html.includes(`href="/admin?status=${status}"`), status);
      assert.ok(html.includes(`>${label}</span>`), label);
    }
    assert.ok(/href="\/admin\?status=failed" aria-current="true"/.test(html));
    assert.equal((html.match(/aria-current=/g) ?? []).length, 1);
    assert.ok(/<option value="failed" selected>/.test(html));
  });

  it('offers Retry only for failed rows', () => {
    const rows = (['open', 'queued', 'sending', 'notified'] as const).map((status, i) =>
      makeRow({ id: `r${i}`, status }),
    );
    const none = renderAdmin(makeAdmin({ rows, total: rows.length }));
    assert.equal(none.includes('/retry'), false);

    const some = renderAdmin(
      makeAdmin({
        rows: [...rows, makeRow({ id: 'bad/id', status: 'failed', lastError: 'Provider said no' })],
        total: rows.length + 1,
      }),
    );
    assert.equal((some.match(/\/retry"/g) ?? []).length, 1);
    assert.ok(some.includes('method="post" action="/admin/requests/bad%2Fid/retry"'));
    assert.ok(some.includes('Provider said no'));
  });

  it('warns about possible delivery only when a failed send is ambiguous', () => {
    const note = 'May have been delivered';
    const ambiguous = makeRow({ status: 'failed', ambiguousSend: true, lastError: 'timeout' });
    assert.ok(renderAdmin(makeAdmin({ rows: [ambiguous] })).includes(note));
    const clear = makeRow({ status: 'failed', ambiguousSend: false, lastError: 'rejected' });
    assert.equal(renderAdmin(makeAdmin({ rows: [clear] })).includes(note), false);
    const notified = makeRow({ status: 'notified', ambiguousSend: true });
    assert.equal(renderAdmin(makeAdmin({ rows: [notified] })).includes(note), false);
  });

  it('shows the last error and attempts for a retrying queued row, without a Retry form', () => {
    const html = renderAdmin(
      makeAdmin({ rows: [makeRow({ status: 'queued', lastError: 'HTTP 503', attempts: 3 })] }),
    );
    assert.ok(html.includes('HTTP 503'));
    assert.ok(html.includes('3 attempts'));
    assert.equal(html.includes('/retry'), false);
  });

  it('labels table cells for the stacked layout and renders dates as UTC time elements', () => {
    const html = renderAdmin(
      makeAdmin({ rows: [makeRow({ notifiedAt: '2026-11-08T15:00:00.000Z' })] }),
    );
    for (const label of ['Product', 'Status', 'Requested', 'Notified', 'Attempts']) {
      assert.ok(html.includes(`data-label="${label}"`), label);
    }
    assert.ok(
      html.includes('<time datetime="2026-11-08T15:00:00.000Z">8 Nov 2026, 15:00 UTC</time>'),
    );
  });

  it('preserves encoded filters in pagination', () => {
    const search = 'a&b=c d"<é';
    const rows = Array.from({ length: 10 }, (_, i) => makeRow({ id: `r${i}` }));
    const html = renderAdmin(
      makeAdmin({ rows, total: 35, page: 2, pageSize: 10, search, status: 'failed' }),
    );
    const next = new URL(hrefOf(html, 'next'), 'http://x');
    assert.equal(next.pathname, '/admin');
    assert.equal(next.searchParams.get('q'), search);
    assert.equal(next.searchParams.get('status'), 'failed');
    assert.equal(next.searchParams.get('page'), '3');

    const prev = new URL(hrefOf(html, 'prev'), 'http://x');
    assert.equal(prev.searchParams.get('q'), search);
    assert.equal(prev.searchParams.get('status'), 'failed');
    assert.equal(prev.searchParams.get('page'), null);

    assert.ok(html.includes('11&ndash;20 of 35'));
    // The raw value must not appear in any URL attribute.
    assert.equal(html.includes('q=a&b'), false);
  });

  it('has no previous link on the first page and no next link on the last', () => {
    const first = renderAdmin(makeAdmin({ rows: [makeRow()], total: 1 }));
    assert.equal(first.includes('rel="prev"'), false);
    assert.equal(first.includes('rel="next"'), false);
    assert.ok(first.includes('1&ndash;1 of 1'));
  });

  it('tells "no requests yet" apart from "no matches"', () => {
    const fresh = renderAdmin(makeAdmin({ rows: [], total: 0 }));
    assert.ok(fresh.includes('No requests yet'));
    assert.equal(fresh.includes('class="summary"'), false);
    assert.equal(fresh.includes('No matches'), false);

    for (const over of [{ search: 'nobody' }, { status: 'failed' as const }]) {
      const none = renderAdmin(makeAdmin({ rows: [], total: 0, ...over }));
      assert.ok(none.includes('No matches'));
      assert.equal(none.includes('No requests yet'), false);
    }
  });

  it('handles a page past the end without claiming the list is empty', () => {
    const html = renderAdmin(makeAdmin({ rows: [], total: 30, page: 9, pageSize: 10 }));
    assert.equal(html.includes('No requests yet'), false);
    assert.equal(html.includes('No matches'), false);
    assert.ok(html.includes('page=3'));
  });

  it('labels webhook outcomes and marks phantom claims', () => {
    const html = renderAdmin(
      makeAdmin({
        events: [
          makeEvent({ eventId: 'e1', outcome: 'in_stock', verifiedQuantity: 4 }),
          makeEvent({ eventId: 'e2', outcome: 'out_of_stock', quantity: 0, verifiedQuantity: 0 }),
          makeEvent({ eventId: 'e3', outcome: 'skipped' }),
          makeEvent({ eventId: 'e4', outcome: 'pending' }),
        ],
      }),
    );
    assert.ok(html.includes('Confirmed in stock'));
    assert.ok(html.includes('Not in stock'));
    assert.ok(html.includes('Skipped: no one waiting'));
    assert.ok(html.includes('>Pending<'));
    assert.equal(html.includes('>Phantom claim<'), false);

    const phantom = renderAdmin(
      makeAdmin({
        events: [makeEvent({ outcome: 'out_of_stock', quantity: 7, verifiedQuantity: 0 })],
      }),
    );
    assert.ok(phantom.includes('>Phantom claim<'));
    assert.ok(phantom.includes('Not in stock'));
  });

  it('shows an empty state for webhooks', () => {
    assert.ok(renderAdmin(makeAdmin()).includes('No webhooks yet'));
  });
});
