// Shared helpers for the HTML views. Everything here is pure, and every page goes through `esc`.
// The pages run under a nonce-based CSP, so all CSS lives in <style nonce> blocks and no markup here
// may use style attributes or inline event handlers.

/** The name the service shows to people. */
export const PRODUCT_NAME = 'Back in Stock';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escapes a value for HTML text and quoted attribute contexts alike. */
export const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"'`]/g, (ch) => ESCAPES[ch] ?? ch);

/**
 * JSON that is safe inside a <script> element: no sequence in it can close the element, open an HTML
 * comment or break a JavaScript string.
 */
export const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** Returns null when there is nothing sensible to show. Never throws on a bad currency code. */
export const formatPrice = (price: number | undefined, currency?: string): string | null => {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(price);
    } catch {
      return `${price.toFixed(2)} ${currency}`;
    }
  }
  return price.toFixed(2);
};

export const formatNumber = (value: number): string => new Intl.NumberFormat('en-US').format(value);

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "8 Nov 2026, 14:03 UTC". Null when the input does not parse. */
export const formatDateUtc = (iso: string): string | null => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${DATE_FORMAT.format(date)} UTC`;
};

/** A <time> element for a stored timestamp, or a dash when there is none. */
export const timeTag = (iso: string | null | undefined): string => {
  if (!iso) return '<span class="nil">&mdash;</span>';
  const text = formatDateUtc(iso);
  if (text === null) return esc(iso);
  return `<time datetime="${esc(iso)}">${esc(text)}</time>`;
};

export const isHttpsUrl = (url: string | undefined): url is string =>
  typeof url === 'string' && /^https:\/\//i.test(url);

/**
 * Design tokens and the reset shared by every page. Colour pairs are chosen for at least 4.5:1, and
 * the accent is used only for primary actions, links and focus rings.
 */
export const BASE_CSS = `
:root {
  color-scheme: light dark;
  --font: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --page: #f6f5f1;
  --surface: #ffffff;
  --surface-sunk: #f1f0eb;
  --ink: #1b1d1c;
  --muted: #5d625f;
  --line: #dfddd6;
  --line-strong: #8a8e8a;
  --accent: #14594a;
  --accent-hover: #0e4539;
  --on-accent: #ffffff;
  --neutral-bg: #eceae4;
  --neutral-ink: #3f4341;
  --info-bg: #e2ecf6;
  --info-ink: #1d4a73;
  --warn-bg: #f8ecd0;
  --warn-ink: #6b4a06;
  --good-bg: #dcefe5;
  --good-ink: #125239;
  --bad-bg: #f9e3e0;
  --bad-ink: #93261b;
  --radius: 12px;
  --radius-sm: 8px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #111413;
    --surface: #1a1e1c;
    --surface-sunk: #151917;
    --ink: #eef0ee;
    --muted: #a6aeaa;
    --line: #2e3431;
    --line-strong: #7a837f;
    --accent: #84d9bd;
    --accent-hover: #a3e6cf;
    --on-accent: #06251c;
    --neutral-bg: #2b302e;
    --neutral-ink: #d5dad7;
    --info-bg: #1b3145;
    --info-ink: #b4d6f4;
    --warn-bg: #3c2f12;
    --warn-ink: #f0d492;
    --good-bg: #16362a;
    --good-ink: #a6e6cb;
    --bad-bg: #431d19;
    --bad-ink: #f8bdb5;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--font);
  font-size: 1rem;
  line-height: 1.5;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p { margin: 0; }
a { color: var(--accent); text-underline-offset: 0.18em; }
a:hover { color: var(--accent-hover); }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
label { display: block; font-size: 0.875rem; font-weight: 600; margin-bottom: 0.3rem; }
input, select, button { font: inherit; color: inherit; margin: 0; }
input, select {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
}
input::placeholder { color: var(--muted); opacity: 1; }
input:focus-visible, select:focus-visible {
  outline-offset: 0;
  border-color: var(--accent);
  border-radius: var(--radius-sm);
}
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0.5rem 1.1rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  color: var(--on-accent);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  transition: background-color 120ms ease, border-color 120ms ease;
}
.button:hover { color: var(--on-accent); background: var(--accent-hover); border-color: var(--accent-hover); }
.button:focus-visible { border-radius: var(--radius-sm); }
.button-quiet { color: var(--ink); background: transparent; border-color: var(--line-strong); }
.button-quiet:hover { color: var(--ink); background: var(--surface-sunk); border-color: var(--line-strong); }
.mono { font-family: var(--mono); font-size: 0.9em; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; }
}
`;

/** A full HTML document. `css` and `body` are trusted: anything dynamic must already be escaped. */
export const htmlDocument = (input: {
  title: string;
  nonce: string;
  css: string;
  body: string;
  noindex?: boolean;
}): string => {
  const robots = input.noindex ? '<meta name="robots" content="noindex">\n' : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${robots}<title>${esc(input.title)}</title>
<link rel="icon" href="data:,">
<style nonce="${esc(input.nonce)}">${BASE_CSS}${input.css}</style>
</head>
<body>
${input.body}
</body>
</html>
`;
};
