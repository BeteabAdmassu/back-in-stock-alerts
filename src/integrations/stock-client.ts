import type { CatalogueItem, Logger, ProductInfo, StockClient, StockResult } from '../contracts.ts';

const MAX_NAME_LENGTH = 200;

export interface StockClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

type FetchOutcome =
  | { kind: 'body'; body: unknown }
  | { kind: 'not_found' }
  | { kind: 'error'; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function capName(name: string): string {
  // Cutting between the halves of a surrogate pair would leave invalid text in the email.
  return name.slice(0, MAX_NAME_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function sanitiseProduct(body: Record<string, unknown>): ProductInfo | null {
  const product: ProductInfo = {};
  if (typeof body.name === 'string' && body.name.trim() !== '') {
    product.name = capName(body.name.trim());
  }
  if (isCount(body.price)) product.price = body.price;
  if (typeof body.currency === 'string' && /^[A-Z]{3}$/.test(body.currency)) {
    product.currency = body.currency;
  }
  const image = httpsUrl(body.image);
  if (image !== null) product.image = image;
  return Object.keys(product).length > 0 ? product : null;
}

/** Null when the stock fields cannot be trusted, which must never be read as "out of stock". */
function readStock(body: Record<string, unknown>): { quantity: number; available: boolean } | null {
  const { quantity, in_stock: inStock } = body;
  if (!isCount(quantity)) return null;
  if (inStock !== undefined && typeof inStock !== 'boolean') return null;
  return {
    // Whole and safe to store; availability comes from the value the API actually sent.
    quantity: Math.min(Math.floor(quantity), Number.MAX_SAFE_INTEGER),
    available: quantity > 0 && inStock !== false,
  };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel(); // An unread body would hold its connection open.
  } catch {
    // The status has already decided the outcome.
  }
}

export function createStockClient(options: StockClientOptions): StockClient {
  const { apiKey, timeoutMs, logger, fetchImpl = fetch } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  function failure(error: string): { kind: 'error'; error: string } {
    // Errors are fixed strings, so neither a URL nor a response body can reach the logs or the DB.
    logger.warn({ integration: 'stock', error }, 'Stock API call failed');
    return { kind: 'error', error };
  }

  async function fetchJson(url: string): Promise<FetchOutcome> {
    let text: string;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        redirect: 'error', // Following one could hand the bearer token to another host.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) {
        await discardBody(response);
        return { kind: 'not_found' };
      }
      if (response.status !== 200) {
        await discardBody(response);
        return failure(`stock API returned ${response.status}`);
      }
      text = await response.text(); // Still under the timeout: a body can stall after the headers.
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return failure(timedOut ? 'stock API timed out' : 'stock API request failed');
    }
    try {
      return { kind: 'body', body: JSON.parse(text) as unknown };
    } catch {
      return failure('stock API returned invalid JSON');
    }
  }

  return {
    async getStock(sku): Promise<StockResult> {
      // URL parsing resolves these as path segments even when percent-encoded, so the request would
      // reach a different resource. Nothing can be learned about such a SKU: it is not "out of stock".
      if (sku === '' || sku === '.' || sku === '..') return failure('SKU cannot be addressed');

      const outcome = await fetchJson(`${baseUrl}/${encodeURIComponent(sku)}`);
      if (outcome.kind === 'error') return outcome;
      if (outcome.kind === 'not_found') {
        return { kind: 'ok', quantity: 0, available: false, product: null };
      }
      if (!isRecord(outcome.body)) return failure('stock API returned a malformed body');
      const stock = readStock(outcome.body);
      if (stock === null) return failure('stock API returned malformed stock fields');
      return { kind: 'ok', ...stock, product: sanitiseProduct(outcome.body) };
    },

    async getCatalogue(): Promise<CatalogueItem[]> {
      const outcome = await fetchJson(baseUrl);
      if (outcome.kind !== 'body') return [];
      const products = isRecord(outcome.body) ? outcome.body.products : undefined;
      if (!Array.isArray(products)) {
        failure('stock API returned a malformed catalogue');
        return [];
      }
      const items: CatalogueItem[] = [];
      for (const entry of products as unknown[]) {
        if (!isRecord(entry) || typeof entry.sku !== 'string') continue;
        const sku = entry.sku.trim();
        const stock = readStock(entry);
        if (sku === '' || stock === null) continue;
        items.push({ ...sanitiseProduct(entry), sku, available: stock.available });
      }
      return items;
    },
  };
}
