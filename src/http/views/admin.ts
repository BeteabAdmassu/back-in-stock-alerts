import {
  type AdminViewModel,
  REQUEST_STATUSES,
  type RequestRow,
  type RequestStatus,
  type WebhookEventRow,
} from '../../contracts.ts';
import { esc, formatNumber, htmlDocument, PRODUCT_NAME, timeTag } from './html.ts';

const STATUS_LABELS: Record<RequestStatus, string> = {
  open: 'Waiting',
  queued: 'Queued',
  sending: 'Sending',
  notified: 'Notified',
  failed: 'Failed',
};

// Below 1080px the tables stack into cards, because the columns get too narrow to read long before
// they overflow. Nothing on this page ever needs horizontal scrolling.
const CSS = `
body { background: var(--page); font-variant-numeric: tabular-nums; }
.wrap { max-width: 76rem; margin: 0 auto; padding: 0 1.25rem; }
.topbar { background: var(--surface); border-bottom: 1px solid var(--line); }
.topbar .wrap { display: flex; align-items: center; justify-content: space-between; gap: 1rem; min-height: 4rem; }
.brand { font-size: 1.0625rem; font-weight: 650; letter-spacing: -0.01em; }
.topbar form { margin: 0; }
main.wrap { padding-top: 2rem; padding-bottom: 4rem; }
h1 { font-size: 1.625rem; font-weight: 650; line-height: 1.2; letter-spacing: -0.02em; }
h2 { font-size: 1.125rem; font-weight: 650; line-height: 1.3; letter-spacing: -0.01em; }
.section-note { margin-top: 0.25rem; font-size: 0.875rem; color: var(--muted); max-width: 44rem; }

.tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.75rem; margin: 1.25rem 0 0; padding: 0; list-style: none; }
.tile {
  display: block;
  min-height: 44px;
  padding: 0.875rem 1rem;
  color: var(--ink);
  text-decoration: none;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: border-color 120ms ease;
}
.tile:hover { color: var(--ink); border-color: var(--line-strong); }
.tile:focus-visible { border-radius: var(--radius); }
.tile[aria-current] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.tile-label { display: block; font-size: 0.875rem; color: var(--muted); }
.tile[aria-current] .tile-label { color: var(--ink); font-weight: 600; }
.tile-count { display: block; margin-top: 0.125rem; font-size: 1.75rem; font-weight: 600; line-height: 1.2; letter-spacing: -0.02em; }
.tile-alert .tile-count { color: var(--bad-ink); }

.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.75rem; margin-top: 1.75rem; }
.filter-search { flex: 1 1 16rem; min-width: 0; }
.filter-status { flex: 0 1 11rem; min-width: 8rem; }
.filter-actions { display: flex; align-items: center; gap: 0.75rem; }
.clear { display: inline-flex; align-items: center; min-height: 44px; padding: 0 0.25rem; font-size: 0.9375rem; }

.summary { margin-top: 1.25rem; font-size: 0.875rem; color: var(--muted); }
.panel { margin-top: 0.5rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
table { width: 100%; border-collapse: collapse; }
thead th {
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--muted);
  text-align: left;
  white-space: nowrap;
  background: var(--surface-sunk);
  border-bottom: 1px solid var(--line);
}
tbody th, tbody td { padding: 0.75rem 1rem; font-size: 0.9375rem; font-weight: 400; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
tbody + tbody { border-top: 1px solid var(--line); }
.events tbody tr + tr { border-top: 1px solid var(--line); }
.num { text-align: right; }
thead th.num, tbody td.num { text-align: right; }
.cell-email { font-weight: 550; }
.cell-date { white-space: nowrap; color: var(--muted); font-size: 0.875rem; }
.product-name { display: block; font-size: 0.875rem; color: var(--muted); }
.nil { color: var(--muted); }

.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.125rem 0.5rem;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  border-radius: 999px;
}
.badge::before { content: ""; width: 0.4375rem; height: 0.4375rem; background: currentColor; border-radius: 50%; }
.badge-neutral { color: var(--neutral-ink); background: var(--neutral-bg); }
.badge-info { color: var(--info-ink); background: var(--info-bg); }
.badge-warn { color: var(--warn-ink); background: var(--warn-bg); }
.badge-good { color: var(--good-ink); background: var(--good-bg); }
.badge-bad { color: var(--bad-ink); background: var(--bad-bg); }
.badge-plain::before { display: none; }

.detail td { padding-top: 0; }
.detail-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.625rem 0.75rem;
  font-size: 0.875rem;
  background: var(--surface-sunk);
  border-radius: var(--radius-sm);
}
.detail-text { min-width: 0; }
.detail-error { color: var(--bad-ink); overflow-wrap: anywhere; }
.detail-retrying { color: var(--ink); overflow-wrap: anywhere; }
.detail-note { margin-top: 0.125rem; color: var(--muted); }
.detail-box form { flex: none; margin: 0; }

.empty { padding: 3rem 1.5rem; text-align: center; }
.empty h3 { font-size: 1.0625rem; font-weight: 650; }
.empty p { margin-top: 0.25rem; font-size: 0.9375rem; color: var(--muted); }

.pager { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 1rem; }
.pager-range { font-size: 0.875rem; color: var(--muted); text-align: center; }
.pager-off { color: var(--muted); border-color: var(--line); cursor: default; }
.pager-off:hover { color: var(--muted); background: transparent; border-color: var(--line); }

.webhooks { margin-top: 3rem; }
.outcome { display: flex; flex-wrap: wrap; gap: 0.25rem 0.375rem; }
.phantom-row { background: var(--warn-bg); background: color-mix(in srgb, var(--warn-bg) 40%, transparent); }

@media (max-width: 760px) {
  main.wrap { padding-top: 1.5rem; }
  .tiles { grid-template-columns: repeat(2, 1fr); }
  .tiles li:last-child { grid-column: 1 / -1; }
  .filter-search, .filter-status, .filter-actions { flex: 1 1 100%; }
  .filter-actions .button { flex: 1 1 auto; }
  .badge { white-space: normal; }
  .detail-box { flex-direction: column; align-items: stretch; gap: 0.625rem; }
  .detail-box .button { width: 100%; }
  .pager { flex-wrap: wrap; }
  .pager-range { order: -1; flex: 1 1 100%; }
  .pager .button { flex: 1 1 0; }
}
@media (max-width: 1080px) {
  .panel { background: transparent; border: 0; border-radius: 0; overflow: visible; }
  table, tbody, tr, th, td { display: block; width: 100%; }
  thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  tbody { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
  tbody + tbody { margin-top: 0.75rem; border-top: 1px solid var(--line); }
  .events tbody tr { padding: 0.25rem 0; }
  tbody th, tbody td { padding: 0.25rem 1rem; }
  tbody tr:first-child > :first-child { padding-top: 0.875rem; }
  tbody tr:last-child > :last-child { padding-bottom: 0.875rem; }
  tbody td[data-label] {
    display: grid;
    grid-template-columns: 6.75rem minmax(0, 1fr);
    gap: 0.5rem;
    align-items: baseline;
    text-align: left;
  }
  tbody td[data-label]::before { content: attr(data-label); font-size: 0.8125rem; color: var(--muted); }
  tbody td.num { text-align: left; }
  .cell-date { white-space: normal; }
  .detail td { padding-top: 0.5rem; }
  .panel.empty { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
}
`;

const adminUrl = (params: { q?: string; status?: RequestStatus | null; page?: number }): string => {
  const parts: string[] = [];
  if (params.q) parts.push(`q=${encodeURIComponent(params.q)}`);
  if (params.status) parts.push(`status=${encodeURIComponent(params.status)}`);
  if (params.page && params.page > 1) parts.push(`page=${params.page}`);
  return parts.length > 0 ? `/admin?${parts.join('&')}` : '/admin';
};

const STATUS_BADGES: Record<RequestStatus, string> = {
  open: 'neutral',
  queued: 'info',
  sending: 'info',
  notified: 'good',
  failed: 'bad',
};

const statusBadge = (status: RequestStatus): string =>
  `<span class="badge badge-${STATUS_BADGES[status]}">${STATUS_LABELS[status]}</span>`;

const tiles = (vm: AdminViewModel): string => {
  const items = REQUEST_STATUSES.map((status) => {
    const count = vm.counts[status] ?? 0;
    const classes = status === 'failed' && count > 0 ? 'tile tile-alert' : 'tile';
    const current = vm.status === status ? ' aria-current="true"' : '';
    // The counts are global, so a tile shows the whole status rather than narrowing a search.
    return `<li><a class="${classes}" href="${esc(adminUrl({ status }))}"${current}><span class="tile-label">${STATUS_LABELS[status]}</span><span class="tile-count">${esc(formatNumber(count))}</span></a></li>`;
  }).join('');
  return `<ul class="tiles">${items}</ul>`;
};

const filters = (vm: AdminViewModel): string => {
  const options = REQUEST_STATUSES.map(
    (status) =>
      `<option value="${status}"${vm.status === status ? ' selected' : ''}>${STATUS_LABELS[status]}</option>`,
  ).join('');
  const clear = vm.search || vm.status ? '<a class="clear" href="/admin">Clear</a>' : '';
  return `<form class="filters" method="get" action="/admin" role="search">
<div class="filter-search"><label for="q">Search email or SKU</label><input type="search" id="q" name="q" value="${esc(vm.search)}"></div>
<div class="filter-status"><label for="status">Status</label><select id="status" name="status"><option value="">All statuses</option>${options}</select></div>
<div class="filter-actions"><button class="button button-quiet" type="submit">Filter</button>${clear}</div>
</form>`;
};

const attemptsText = (attempts: number): string =>
  `${formatNumber(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}`;

const failedDetail = (row: RequestRow): string => {
  const error = row.lastError
    ? `<p class="detail-error">${esc(row.lastError)}</p>`
    : '<p class="detail-error">The email could not be sent.</p>';
  const ambiguous = row.ambiguousSend
    ? '<p class="detail-note">May have been delivered: an earlier attempt has no known outcome, so a retry could send a second email.</p>'
    : '';
  return `<div class="detail-box"><div class="detail-text">${error}${ambiguous}</div>
<form method="post" action="/admin/requests/${esc(encodeURIComponent(row.id))}/retry"><button class="button button-quiet" type="submit" aria-label="Retry email to ${esc(row.email)}">Retry</button></form></div>`;
};

const retryingDetail = (row: RequestRow): string => {
  const next = row.status === 'queued' && row.nextAttemptAt ? timeTag(row.nextAttemptAt) : null;
  return `<div class="detail-box"><div class="detail-text"><p class="detail-retrying">Retrying: ${esc(row.lastError)}</p>
<p class="detail-note">${esc(attemptsText(row.attempts))}${next ? ` so far, next try ${next}` : ' so far'}</p></div></div>`;
};

const detailFor = (row: RequestRow): string | null => {
  if (row.status === 'failed') return failedDetail(row);
  if ((row.status === 'queued' || row.status === 'sending') && row.lastError) {
    return retryingDetail(row);
  }
  return null;
};

// Each request is its own <tbody>, which keeps a failed row and its detail together as one card.
const requestRow = (row: RequestRow): string => {
  const name = row.product?.name
    ? `<span class="product-name">${esc(row.product.name)}</span>`
    : '';
  const detail = detailFor(row);
  return `<tbody>
<tr>
<th scope="row" class="cell-email">${esc(row.email)}</th>
<td data-label="Product"><span><span class="mono">${esc(row.sku)}</span>${name}</span></td>
<td data-label="Status"><span>${statusBadge(row.status)}</span></td>
<td data-label="Requested" class="cell-date"><span>${timeTag(row.createdAt)}</span></td>
<td data-label="Notified" class="cell-date"><span>${timeTag(row.notifiedAt)}</span></td>
<td data-label="Attempts" class="num"><span>${esc(formatNumber(row.attempts))}</span></td>
</tr>${detail ? `\n<tr class="detail"><td colspan="6">${detail}</td></tr>` : ''}
</tbody>`;
};

const requestsTable = (vm: AdminViewModel): string => {
  if (vm.rows.length === 0) return emptyState(vm);
  return `<div class="panel"><table>
<thead><tr><th scope="col">Email</th><th scope="col">Product</th><th scope="col">Status</th><th scope="col">Requested</th><th scope="col">Notified</th><th scope="col" class="num">Attempts</th></tr></thead>
${vm.rows.map(requestRow).join('\n')}
</table></div>`;
};

const emptyState = (vm: AdminViewModel): string => {
  const filtered = Boolean(vm.search || vm.status);
  if (vm.total > 0) {
    const last = Math.max(1, Math.ceil(vm.total / Math.max(1, vm.pageSize)));
    const href = adminUrl({ q: vm.search, status: vm.status, page: last });
    return `<div class="panel empty"><h3>This page is empty</h3><p>The list is shorter than this now. <a href="${esc(href)}">Go to the last page</a>.</p></div>`;
  }
  if (filtered) {
    return `<div class="panel empty"><h3>No matches</h3><p>Nothing fits this search and status. <a href="/admin">Clear the filters</a> to see every request.</p></div>`;
  }
  return `<div class="panel empty"><h3>No requests yet</h3><p>When a customer asks to hear about a sold-out item through the form, it shows up here.</p></div>`;
};

const pager = (vm: AdminViewModel): string => {
  if (vm.rows.length === 0) return '';
  const start = (vm.page - 1) * vm.pageSize + 1;
  const end = start + vm.rows.length - 1;
  const range = `${formatNumber(start)}&ndash;${formatNumber(end)} of ${formatNumber(vm.total)}`;
  const link = (rel: 'prev' | 'next', label: string, page: number, enabled: boolean): string =>
    enabled
      ? `<a class="button button-quiet" rel="${rel}" href="${esc(adminUrl({ q: vm.search, status: vm.status, page }))}">${label}</a>`
      : `<span class="button button-quiet pager-off" aria-disabled="true">${label}</span>`;
  return `<nav class="pager" aria-label="Pagination">
${link('prev', 'Previous', vm.page - 1, vm.page > 1)}
<span class="pager-range">${range}</span>
${link('next', 'Next', vm.page + 1, end < vm.total)}
</nav>`;
};

const quantity = (value: number | null): string =>
  value === null ? '<span class="nil">&mdash;</span>' : esc(formatNumber(value));

const outcomeBadge = (event: WebhookEventRow): string => {
  switch (event.outcome) {
    case 'in_stock':
      return '<span class="badge badge-good">Confirmed in stock</span>';
    case 'out_of_stock':
      return '<span class="badge badge-neutral">Not in stock</span>';
    case 'skipped':
      return '<span class="badge badge-neutral">Skipped: no one waiting</span>';
    case 'pending':
      return '<span class="badge badge-info">Pending</span>';
  }
};

const isPhantom = (event: WebhookEventRow): boolean =>
  event.outcome === 'out_of_stock' && event.quantity > 0;

const eventRow = (event: WebhookEventRow): string => {
  const phantom = isPhantom(event)
    ? '<span class="badge badge-warn badge-plain">Phantom claim</span>'
    : '';
  return `<tr${isPhantom(event) ? ' class="phantom-row"' : ''}>
<th scope="row" class="mono">${esc(event.eventId)}</th>
<td data-label="SKU"><span class="mono">${esc(event.sku)}</span></td>
<td data-label="Claimed" class="num"><span>${quantity(event.quantity)}</span></td>
<td data-label="Verified" class="num"><span>${quantity(event.verifiedQuantity)}</span></td>
<td data-label="Outcome"><span class="outcome">${outcomeBadge(event)}${phantom}</span></td>
<td data-label="Received" class="cell-date"><span>${timeTag(event.receivedAt)}</span></td>
</tr>`;
};

const webhooks = (vm: AdminViewModel): string => {
  const body =
    vm.events.length === 0
      ? '<div class="panel empty"><h3>No webhooks yet</h3><p>Stock events from the store appear here as they arrive.</p></div>'
      : `<div class="panel"><table class="events">
<thead><tr><th scope="col">Event</th><th scope="col">SKU</th><th scope="col" class="num">Claimed</th><th scope="col" class="num">Verified</th><th scope="col">Outcome</th><th scope="col">Received</th></tr></thead>
<tbody>
${vm.events.map(eventRow).join('\n')}
</tbody>
</table></div>`;
  return `<section class="webhooks" aria-labelledby="webhooks-title">
<h2 id="webhooks-title">Recent webhooks</h2>
<p class="section-note">A webhook only prompts a check. Quantities are verified against the stock API before anyone is emailed, and a phantom claim is a webhook that said in stock when the API disagreed.</p>
${body}
</section>`;
};

const summary = (vm: AdminViewModel): string => {
  if (vm.total === 0) return '';
  const noun = vm.total === 1 ? 'request' : 'requests';
  const verb = vm.total === 1 ? 'matches' : 'match';
  const tail = vm.search || vm.status ? ` ${verb} these filters` : ' in total';
  return `<p class="summary">${esc(formatNumber(vm.total))} ${noun}${tail}</p>`;
};

export const renderAdmin = (vm: AdminViewModel): string =>
  htmlDocument({
    title: `Requests · ${PRODUCT_NAME}`,
    nonce: vm.nonce,
    css: CSS,
    noindex: true,
    body: `<header class="topbar"><div class="wrap">
<span class="brand">${esc(PRODUCT_NAME)}</span>
<form method="post" action="/admin/logout"><button class="button button-quiet" type="submit">Sign out</button></form>
</div></header>
<main class="wrap">
<h1>Requests</h1>
${tiles(vm)}
${filters(vm)}
${summary(vm)}
${requestsTable(vm)}
${pager(vm)}
${webhooks(vm)}
</main>`,
  });
