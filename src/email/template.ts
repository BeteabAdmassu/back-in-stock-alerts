import type { ProductInfo } from '../contracts.ts';

export interface BackInStockEmailInput {
  sku: string;
  product: ProductInfo | null;
  /** Only http(s) URLs are linked. Anything else is treated as no URL. */
  productUrl: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Retries reuse the idempotency key and providers reject a key reused with a different payload, so
// this module must stay deterministic: no clock, no ids and no default locale. PRICE_LOCALE is
// fixed because the host's default locale could differ between a send and its retry.
const PRICE_LOCALE = 'en-US';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const PREHEADER = 'The item you asked about is available again.';
const NO_URL_LINE = 'Head back to the store to grab it before it sells out.';
const FOOTER =
  "You asked us to let you know when this item came back. This is a one-time alert, so we won't email you about it again.";

const STYLE = `@media (max-width:480px){
.outer{padding:12px 12px 24px !important}
.card{padding:32px 20px !important}
.hero{width:100% !important}
.heading{font-size:30px !important}
.cta-table{width:100% !important}
.cta{display:block !important;padding-left:16px !important;padding-right:16px !important}
}
@media (prefers-color-scheme:dark){
.page{background-color:#18181b !important}
.card{background-color:#27272a !important;border-color:#3f3f46 !important}
.strong{color:#fafafa !important}
.body-text{color:#d4d4d8 !important}
.muted{color:#a1a1aa !important}
.cta-cell{background-color:#fafafa !important}
.cta{color:#18181b !important}
}`;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    return ch === '"' ? '&quot;' : '&#39;';
  });

/** One line: control characters and line separators become spaces, which also blocks CR/LF. */
const singleLine = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : '';

/** The plain text part is not escaped, so angle brackets go rather than pass as markup. */
const plain = (value: string): string => value.replace(/[<>]/g, '').trim();

function formatPrice(product: ProductInfo | null): string | null {
  const price = product?.price;
  const currency = product?.currency;
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  if (typeof currency !== 'string' || !currency) return null;
  try {
    return new Intl.NumberFormat(PRICE_LOCALE, { style: 'currency', currency }).format(price);
  } catch {
    return null; // Not a currency Intl recognises.
  }
}

function safeUrl(value: unknown, protocols: readonly string[]): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return protocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function imageBlock(src: string, alt: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;margin:0 0 24px 0;">
<tr><td align="center">
<img class="hero" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="320" style="display:block;width:320px;max-width:100%;height:auto;margin:0 auto;border:0;border-radius:8px;font-family:${FONT};font-size:16px;line-height:24px;color:#52525b;overflow-wrap:anywhere;word-break:break-word;">
</td></tr>
</table>`;
}

// 14px + 20px + 14px gives a 48px tap target. On phones the table goes full width.
function buttonBlock(href: string): string {
  return `<table role="presentation" class="cta-table" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 0 auto;">
<tr><td class="cta-cell" align="center" bgcolor="#18181b" style="background-color:#18181b;border-radius:8px;">
<a class="cta" href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 40px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Shop now</a>
</td></tr>
</table>`;
}

export function renderBackInStockEmail(input: BackInStockEmailInput): RenderedEmail {
  const sku = singleLine(input.sku);
  const productName = singleLine(input.product?.name);
  const name = productName || sku || 'your item';
  const price = formatPrice(input.product);
  const image = safeUrl(input.product?.image, ['https:']);
  const productUrl = safeUrl(input.productUrl, ['https:', 'http:']);
  // Without a product name, the SKU is already shown as the name.
  const skuLine = productName && sku ? `SKU: ${sku}` : null;

  const subject = `Back in stock: ${name}`;

  const html = `<!DOCTYPE html>
<html lang="en" style="color-scheme:light dark;">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>
${STYLE}
</style>
</head>
<body class="page" style="margin:0;padding:0;background-color:#f4f4f5;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:transparent;mso-hide:all;">${PREHEADER}</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5" style="width:100%;table-layout:fixed;background-color:#f4f4f5;">
<tr><td class="outer" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;table-layout:fixed;">
<tr><td class="card" align="center" bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:40px 32px;text-align:center;overflow-wrap:anywhere;word-break:break-word;">
<h1 class="heading strong" style="margin:0 0 24px 0;font-family:${FONT};font-size:32px;line-height:38px;font-weight:700;letter-spacing:-0.5px;color:#18181b;">It's back.</h1>
${image ? imageBlock(image, name) : ''}<p class="strong" style="margin:0;font-family:${FONT};font-size:18px;line-height:26px;font-weight:600;color:#18181b;overflow-wrap:anywhere;">${escapeHtml(name)}</p>
${price ? `<p class="body-text" style="margin:4px 0 0 0;font-family:${FONT};font-size:16px;line-height:24px;color:#3f3f46;">${escapeHtml(price)}</p>\n` : ''}${
  productUrl
    ? buttonBlock(productUrl)
    : `<p class="body-text" style="margin:20px 0 0 0;font-family:${FONT};font-size:16px;line-height:24px;color:#3f3f46;">${NO_URL_LINE}</p>`
}
${skuLine ? `<p class="muted" style="margin:24px 0 0 0;font-family:${FONT};font-size:12px;line-height:16px;color:#63636b;overflow-wrap:anywhere;">${escapeHtml(skuLine)}</p>\n` : ''}</td></tr>
<tr><td style="padding:20px 16px 0 16px;text-align:center;">
<p class="muted" style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;color:#63636b;">${FOOTER}</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;

  const textLines = [
    "It's back.",
    '',
    plain(name),
    ...(price ? [plain(price)] : []),
    ...(skuLine ? [plain(skuLine)] : []),
    '',
    productUrl ? `Shop now: ${productUrl}` : NO_URL_LINE,
    '',
    '--',
    FOOTER,
    '',
  ];

  return { subject, html, text: textLines.join('\n') };
}
