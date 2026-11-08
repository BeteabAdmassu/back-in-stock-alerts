import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProductInfo } from '../src/contracts.ts';
import { renderBackInStockEmail } from '../src/email/template.ts';

const PRODUCT: ProductInfo = {
  name: 'Cedar & Smoke Candle, 200 g',
  price: 26,
  currency: 'GBP',
  image: 'https://cdn.example/candle.jpg',
};
const URL_ = 'https://shop.example/p/CNDL-200?ref=alert&x=1';

const full = () => renderBackInStockEmail({ sku: 'CNDL-200', product: PRODUCT, productUrl: URL_ });

test('the same input renders byte-identical output, whatever the time', async () => {
  const first = full();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = renderBackInStockEmail({
    sku: 'CNDL-200',
    product: { ...PRODUCT },
    productUrl: URL_,
  });
  assert.deepEqual(second, first);
});

test('the subject names the product, falls back to the SKU and has no line breaks', () => {
  assert.equal(full().subject, 'Back in stock: Cedar & Smoke Candle, 200 g');
  for (const product of [null, {}, { name: '   ' }]) {
    const { subject } = renderBackInStockEmail({ sku: 'ABC-1', product, productUrl: null });
    assert.equal(subject, 'Back in stock: ABC-1');
  }
  const { subject } = renderBackInStockEmail({
    sku: 'ABC-1',
    product: { name: 'Mug\r\nBcc: victim@example.com x' },
    productUrl: null,
  });
  assert.equal(subject, 'Back in stock: Mug Bcc: victim@example.com x');
});

test('a hostile product name or SKU cannot inject HTML', () => {
  const name = '"><script>alert(1)</script><img src=x onerror=alert(2)>\'&';
  const sku = '<b onmouseover="x">SKU</b>';
  const { html, text, subject } = renderBackInStockEmail({
    sku,
    product: {
      name,
      price: 5,
      currency: 'USD',
      image: 'https://cdn.example/a.jpg?"><script>alert(3)</script>',
    },
    productUrl: 'https://shop.example/p/"><script>alert(4)</script>',
  });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b onmouseover/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;b onmouseover=&quot;x&quot;&gt;SKU&lt;\/b&gt;/);
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.doesNotMatch(text, /<[^>]*>/);
  assert.doesNotMatch(subject, /[\r\n]/);
});

test('unsafe URLs are dropped rather than linked', () => {
  const { html, text } = renderBackInStockEmail({
    sku: 'A',
    product: { name: 'A thing', image: 'http://insecure.example/a.jpg' },
    productUrl: 'javascript:alert(1)',
  });
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /<img /);
  assert.doesNotMatch(html, /<a /);
  assert.doesNotMatch(text, /javascript:/);
  assert.match(html, /Head back to the store/);
});

test('the HTML is email-client grade and has phone CSS', () => {
  const { html } = full();
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /role="presentation"/);
  assert.match(html, /max-width:600px;table-layout:fixed/);
  assert.match(html, /@media \(max-width:480px\)/);
  assert.match(html, /\.cta-table\{width:100% !important\}/);
  assert.match(html, /@media \(prefers-color-scheme:dark\)/);
  assert.match(html, /display:none;max-height:0[^"]*">The item you asked about/);
  assert.match(html, /<h1[^>]*>It's back\.<\/h1>/);
  assert.match(html, /font-size:16px/);
  assert.doesNotMatch(html, /<script|<link|@import|url\(|gradient/i);

  // The style block holds only the two media queries.
  const css = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? '';
  const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').trim();
  assert.equal(topLevel, '');

  // Every table is presentational.
  const realHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of realHtml.match(/<table[^>]*>/g) ?? []) assert.match(tag, /role="presentation"/);
});

test('the image has alt text, explicit width and automatic height', () => {
  const { html } = full();
  const img = /<img [^>]*>/.exec(html)?.[0] ?? '';
  assert.match(img, /src="https:\/\/cdn\.example\/candle\.jpg"/);
  assert.match(img, /alt="Cedar &amp; Smoke Candle, 200 g"/);
  assert.match(img, / width="320"/);
  assert.match(img, /height:auto/);
});

test('the button only exists with a URL, is padded to 44px+ and goes full width on phones', () => {
  const withUrl = full();
  const anchor = /<a [^>]*>Shop now<\/a>/.exec(withUrl.html)?.[0] ?? '';
  assert.match(anchor, /href="https:\/\/shop\.example\/p\/CNDL-200\?ref=alert&amp;x=1"/);
  const padding = Number(/padding:(\d+)px/.exec(anchor)?.[1]);
  const lineHeight = Number(/line-height:(\d+)px/.exec(anchor)?.[1]);
  assert.ok(padding * 2 + lineHeight >= 44, 'tap target is at least 44px high');
  assert.doesNotMatch(withUrl.html, /Head back to the store/);
  assert.match(withUrl.text, /Shop now: https:\/\/shop\.example\/p\/CNDL-200\?ref=alert&x=1/);

  const withoutUrl = renderBackInStockEmail({
    sku: 'CNDL-200',
    product: PRODUCT,
    productUrl: null,
  });
  assert.doesNotMatch(withoutUrl.html, /<a /);
  assert.doesNotMatch(withoutUrl.html, /Shop now/);
  assert.match(withoutUrl.html, /Head back to the store to grab it before it sells out\./);
  assert.match(withoutUrl.text, /Head back to the store to grab it before it sells out\./);
  assert.doesNotMatch(withoutUrl.text, /Shop now/);
});

test('the price uses the currency, and is left out when absent or invalid', () => {
  assert.match(full().html, />£26\.00</);
  assert.match(full().text, /^£26\.00$/m);
  const bad: ProductInfo[] = [
    { name: 'A' },
    { name: 'A', price: 10 },
    { name: 'A', currency: 'GBP' },
    { name: 'A', price: 10, currency: 'not a currency' },
    { name: 'A', price: Number.NaN, currency: 'GBP' },
    { name: 'A', price: -1, currency: 'GBP' },
  ];
  for (const product of bad) {
    const { html, text } = renderBackInStockEmail({ sku: 'S', product, productUrl: null });
    assert.doesNotMatch(html, /£|10\.00|NaN/, JSON.stringify(product));
    assert.doesNotMatch(text, /£|10\.00|NaN/, JSON.stringify(product));
  }
});

test('live quantity is never shown, even if a caller passes it', () => {
  const product = { ...PRODUCT, quantity: 98765 } as ProductInfo;
  const { html, text, subject } = renderBackInStockEmail({
    sku: 'S',
    product,
    productUrl: null,
  });
  assert.doesNotMatch(html + text + subject, /98765/);
});

test('the footer explains the alert and invents no unsubscribe link', () => {
  const footer =
    "You asked us to let you know when this item came back. This is a one-time alert, so we won't email you about it again.";
  const { html, text } = full();
  assert.ok(html.includes(footer));
  assert.ok(text.includes(footer));
  assert.doesNotMatch(html + text, /unsubscribe/i);
});

test('the SKU appears in small type alongside a product name, and is not repeated without one', () => {
  const { html, text } = full();
  assert.match(html, /font-size:12px[^>]*>SKU: CNDL-200</);
  assert.match(text, /^SKU: CNDL-200$/m);

  const bare = renderBackInStockEmail({ sku: 'ABC-1', product: null, productUrl: null });
  assert.doesNotMatch(bare.html, /SKU: /);
  assert.match(bare.html, />ABC-1</);
  assert.doesNotMatch(bare.html, /<img /);
});

test('the text version is complete and has no HTML', () => {
  const { text } = full();
  for (const expected of [
    "It's back.",
    'Cedar & Smoke Candle, 200 g',
    '£26.00',
    'SKU: CNDL-200',
    'Shop now: ',
    'one-time alert',
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.doesNotMatch(text, /<[^>]*>|&amp;|&#/);
});
