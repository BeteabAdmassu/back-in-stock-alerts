import type { CatalogueItem, EmbedViewModel, ProductInfo } from '../../contracts.ts';
import { esc, formatPrice, htmlDocument, isHttpsUrl, PRODUCT_NAME, safeJson } from './html.ts';

// The page sits in an iframe on someone else's store. The document stays transparent and never asks
// for viewport height; the card paints its own surface, so it reads on any host background. The small
// padding on .shell keeps the card's border and focus rings from being clipped by the frame.
// The colour scheme is declared on the card, not the root: a browser paints an opaque canvas behind
// a frame whose root scheme differs from the host's, and most stores declare none at all.
const CSS = `
:root { color-scheme: normal; }
html, body { background: transparent; }
.shell { padding: 2px; }
.card {
  color-scheme: light dark;
  max-width: 28rem;
  margin: 0 auto;
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.product { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.875rem; }
.product img {
  flex: none;
  display: block;
  width: 56px;
  height: 56px;
  object-fit: cover;
  background: var(--surface-sunk);
  border-radius: var(--radius-sm);
}
.product-text { min-width: 0; }
.product-name { font-size: 0.9375rem; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.product-price { font-size: 0.875rem; color: var(--muted); font-variant-numeric: tabular-nums; }
h1, .done-title {
  font-size: 1.125rem;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.lede { margin-top: 0.25rem; font-size: 0.875rem; color: var(--muted); }
form { margin-top: 0.875rem; }
.field + .field { margin-top: 0.75rem; }
input[readonly] { color: var(--muted); background: var(--surface-sunk); border-color: var(--line); }
input[aria-invalid="true"] { border-color: var(--bad-ink); }
.hint, .field-error { margin-top: 0.3rem; font-size: 0.8125rem; line-height: 1.4; overflow-wrap: anywhere; }
.hint { color: var(--muted); }
.field-error { color: var(--bad-ink); font-weight: 500; }
.form-error {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  color: var(--bad-ink);
  background: var(--bad-bg);
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}
.submit { position: relative; width: 100%; margin-top: 0.875rem; }
.submit:disabled { cursor: progress; }
/* The label keeps its box while loading, so the button cannot change size under the pointer. */
.submit.is-loading .submit-label { visibility: hidden; }
.spinner {
  display: none;
  position: absolute;
  top: 50%;
  left: 50%;
  width: 1.125rem;
  height: 1.125rem;
  margin: -0.5625rem 0 0 -0.5625rem;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}
.submit.is-loading .spinner { display: block; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .spinner { border-right-color: currentColor; animation: breathe 1600ms ease-in-out infinite; }
}
.done-title:focus, .done-title:focus-visible { outline: none; }
.done-email { margin-top: 0.25rem; font-size: 0.9375rem; font-weight: 600; overflow-wrap: anywhere; }
.done-note { margin-top: 0.25rem; font-size: 0.875rem; color: var(--muted); }
.again {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  margin: 0.25rem 0 -0.5rem;
  padding: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 0.18em;
  cursor: pointer;
  background: none;
  border: 0;
}
.again:hover { color: var(--accent-hover); }
.noscript { margin-top: 0.75rem; font-size: 0.875rem; }
`;

/** Without script the form cannot post JSON, so it is replaced by an honest message. */
const noscript = (nonce: string): string =>
  `<noscript><style nonce="${esc(nonce)}">#bis-form { display: none; }</style>
<p class="noscript">This form needs JavaScript to send your request. Please turn it on and reload the page.</p></noscript>`;

// Static: nothing is interpolated into this script. Server data is only ever assigned to textContent.
const SCRIPT = `
(function () {
  'use strict';
  var TIMEOUT_MS = 15000;
  var $ = function (id) { return document.getElementById(id); };
  var form = $('bis-form');
  var email = $('email');
  var sku = $('sku');
  var submit = $('bis-submit');
  var submitLabel = $('bis-submit-label');
  var intro = $('bis-intro');
  var formError = $('bis-form-error');
  var hint = $('sku-hint');
  var progress = $('bis-progress');
  var done = $('bis-done');
  var doneTitle = $('bis-done-title');
  var doneEmail = $('bis-done-email');
  var doneNote = $('bis-done-note');
  var again = $('bis-again');
  var fixedSku = sku.readOnly;
  var busy = false;
  var catalogue = new Map();

  try {
    JSON.parse($('bis-catalogue').textContent).forEach(function (item) {
      catalogue.set(String(item.sku).toUpperCase(), item);
    });
  } catch (e) { /* Suggestions are optional. */ }

  // Script takes over validation, so errors appear inline rather than as bubbles a small frame clips.
  form.noValidate = true;

  function known() { return catalogue.get(sku.value.trim().toUpperCase()); }

  function describe(input) {
    var ids = [];
    var extra = input === sku && !hint.hidden ? hint.id : null;
    var error = $(input.id + '-error');
    if (extra) ids.push(extra);
    if (error && !error.hidden) ids.push(error.id);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
  }

  function showHint() {
    var item = known();
    var text = '';
    if (item) {
      var prefix = fixedSku || !item.name ? '' : item.name;
      if (item.available) text = (prefix ? prefix + '. ' : '') + "In stock now: we'll email you right away";
      else text = prefix ? prefix + ': sold out' : 'Sold out';
    }
    hint.textContent = text;
    hint.hidden = !text;
    describe(sku);
  }

  function setFieldError(input, message) {
    var error = $(input.id + '-error');
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    describe(input);
  }

  function clearFieldError(input) {
    var error = $(input.id + '-error');
    error.textContent = '';
    error.hidden = true;
    input.removeAttribute('aria-invalid');
    describe(input);
  }

  function clearErrors() {
    clearFieldError(email);
    clearFieldError(sku);
    formError.textContent = '';
    formError.hidden = true;
  }

  function setBusy(on) {
    busy = on;
    submit.disabled = on;
    submit.classList.toggle('is-loading', on);
    if (on) form.setAttribute('aria-busy', 'true');
    else form.removeAttribute('aria-busy');
    progress.textContent = on ? 'Sending your request' : '';
  }

  function fail(message) {
    setBusy(false);
    submitLabel.textContent = 'Try again';
    formError.textContent = message;
    formError.hidden = false;
    submit.focus();
  }

  function succeed(data, typedEmail) {
    var item = known();
    setBusy(false);
    form.hidden = true;
    intro.hidden = true;
    doneTitle.textContent = data.duplicate ? "You're already on the list" : "You're on the list";
    doneEmail.textContent = typeof data.email === 'string' ? data.email : typedEmail;
    doneNote.textContent = item && item.available
      ? "It's in stock now, so expect one email shortly. No marketing."
      : "We'll send one email when it's back. No marketing.";
    done.hidden = false;
    doneTitle.focus();
  }

  function validate(emailValue, skuValue) {
    var first = null;
    if (!emailValue) { setFieldError(email, 'Enter your email address.'); first = email; }
    else if (!email.validity.valid) { setFieldError(email, 'That email address doesn\\u2019t look right.'); first = email; }
    if (!skuValue) { setFieldError(sku, 'Enter the product SKU.'); first = first || sku; }
    if (first) first.focus();
    return !first;
  }

  async function send() {
    if (busy) return;
    clearErrors();
    var emailValue = email.value.trim();
    var skuValue = sku.value.trim();
    if (!validate(emailValue, skuValue)) return;
    setBusy(true);

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    try {
      var res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: emailValue, sku: skuValue }),
        signal: controller.signal,
      });
      var data = await res.json().catch(function () { return null; });
      if ((res.status === 200 || res.status === 201) && data && typeof data === 'object') {
        succeed(data, emailValue);
        return;
      }
      var problem = res.status === 400 && data && data.error ? data.error : null;
      if (problem && (problem.field === 'email' || problem.field === 'sku')) {
        var input = problem.field === 'email' ? email : sku;
        setBusy(false);
        setFieldError(input, String(problem.message || 'Please check this field.'));
        input.focus();
      } else if (problem && problem.message) {
        fail(String(problem.message));
      } else {
        fail('Something went wrong on our side. Your details are still here, so please try again.');
      }
    } catch (e) {
      fail(e && e.name === 'AbortError'
        ? 'That took too long. Your details are still here, so please try again.'
        : 'We couldn\\u2019t reach the server. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    send();
  });
  email.addEventListener('input', function () { clearFieldError(email); });
  sku.addEventListener('input', function () { clearFieldError(sku); showHint(); });

  if (again) {
    again.addEventListener('click', function () {
      done.hidden = true;
      form.hidden = false;
      intro.hidden = false;
      sku.value = '';
      submitLabel.textContent = 'Notify me';
      clearErrors();
      showHint();
      sku.focus();
    });
  }

  var image = document.querySelector('.product img');
  if (image) image.addEventListener('error', function () { image.hidden = true; });

  showHint();

  // Lets the host page fit the iframe to the content. Carries only a number.
  if (window.parent !== window) {
    var last = -1;
    var postHeight = function () {
      var height = Math.ceil(document.body.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      try {
        window.parent.postMessage({ type: 'back-in-stock:resize', height: height }, '*');
      } catch (e) { /* Nothing to do without a parent that listens. */ }
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(postHeight).observe(document.body);
    window.addEventListener('load', postHeight);
    postHeight();
  }
})();
`;

const productBlock = (product: ProductInfo | null): string => {
  if (!product) return '';
  const price = formatPrice(product.price, product.currency);
  if (!product.name && !price && !isHttpsUrl(product.image)) return '';
  const image = isHttpsUrl(product.image)
    ? `<img src="${esc(product.image)}" alt="" width="56" height="56" decoding="async" referrerpolicy="no-referrer">`
    : '';
  const name = product.name ? `<p class="product-name">${esc(product.name)}</p>` : '';
  const priceLine = price ? `<p class="product-price">${esc(price)}</p>` : '';
  return `<div class="product">${image}<div class="product-text">${name}${priceLine}</div></div>`;
};

const datalist = (catalogue: CatalogueItem[]): string => {
  if (catalogue.length === 0) return '';
  const options = catalogue
    .map((item) => {
      const label = [item.name, item.available ? null : 'sold out'].filter(Boolean).join(' · ');
      return `<option value="${esc(item.sku)}">${esc(label)}</option>`;
    })
    .join('');
  return `<datalist id="sku-options">${options}</datalist>`;
};

const skuInput = (vm: EmbedViewModel): string => {
  const common =
    'type="text" name="sku" id="sku" required autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"';
  if (vm.sku !== null && vm.sku !== '') {
    return `<input ${common} value="${esc(vm.sku)}" readonly>`;
  }
  const hasOptions = vm.catalogue.length > 0;
  const list = hasOptions ? ' list="sku-options"' : '';
  const placeholder = hasOptions ? 'Type or pick a SKU' : 'e.g. ABC-123';
  return `<input ${common}${list} placeholder="${placeholder}" enterkeyhint="send">${datalist(vm.catalogue)}`;
};

export const renderEmbed = (vm: EmbedViewModel): string => {
  const fixedSku = vm.sku !== null && vm.sku !== '';
  const wanted = fixedSku ? vm.sku?.toUpperCase() : null;
  // The stock API may not have answered in time; the catalogue can still name the product.
  const product =
    vm.product ??
    (wanted ? (vm.catalogue.find((item) => item.sku.toUpperCase() === wanted) ?? null) : null);
  // Only what the hint needs, and never a price or image the page does not use.
  const suggestions = vm.catalogue.map(({ sku, name, available }) => ({ sku, name, available }));

  return htmlDocument({
    title: `Get an email when it's back · ${PRODUCT_NAME}`,
    nonce: vm.nonce,
    css: CSS,
    body: `<div class="shell">
<main class="card">
${productBlock(product)}
<div id="bis-intro">
<h1>Get an email when it's back</h1>
<p class="lede">Leave your email and we'll send you one message when ${fixedSku ? 'this item' : 'the item'} is available again.</p>
${noscript(vm.nonce)}
</div>
<form id="bis-form" method="post" action="/api/requests">
<div class="field">
<label for="email">Email</label>
<input type="email" name="email" id="email" autocomplete="email" required placeholder="you@example.com" enterkeyhint="send">
<p class="field-error" id="email-error" hidden></p>
</div>
<div class="field">
<label for="sku">Product SKU</label>
${skuInput(vm)}
<p class="hint" id="sku-hint" aria-live="polite" hidden></p>
<p class="field-error" id="sku-error" hidden></p>
</div>
<p class="form-error" id="bis-form-error" role="alert" hidden></p>
<button class="button submit" id="bis-submit" type="submit"><span class="submit-label" id="bis-submit-label">Notify me</span><span class="spinner" aria-hidden="true"></span></button>
<p class="sr-only" id="bis-progress" role="status"></p>
</form>
<div role="status" aria-live="polite">
<div id="bis-done" hidden>
<h1 class="done-title" id="bis-done-title" tabindex="-1"></h1>
<p class="done-email" id="bis-done-email"></p>
<p class="done-note" id="bis-done-note"></p>
${fixedSku ? '' : '<button class="again" id="bis-again" type="button">Add another</button>'}
</div>
</div>
</main>
</div>
<script type="application/json" id="bis-catalogue" nonce="${esc(vm.nonce)}">${safeJson(suggestions)}</script>
<script nonce="${esc(vm.nonce)}">${SCRIPT}</script>`,
  });
};
