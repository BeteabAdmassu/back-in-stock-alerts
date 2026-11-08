import type { FastifyInstance } from 'fastify';
import type { CatalogueItem, Clock, Logger, ProductInfo, StockClient } from '../../contracts.ts';
import { validateSku } from '../../domain/validation.ts';
import { embedCsp, HTML_TYPE, newNonce, type Views } from './shared.ts';

const CATALOGUE_TTL_MS = 60_000;
/** After a failed refresh, how long before another is tried. Pages should not wait on every load. */
const CATALOGUE_RETRY_MS = 10_000;
const CATALOGUE_WAIT_MS = 1_500;

export interface CatalogueCache {
  /** Never rejects, and resolves within CATALOGUE_WAIT_MS with the best data available. */
  get(): Promise<CatalogueItem[]>;
}

export function createCatalogueCache(deps: {
  stock: StockClient;
  clock: Clock;
  logger: Logger;
}): CatalogueCache {
  const { stock, clock, logger } = deps;
  let items: CatalogueItem[] = [];
  let freshUntil = 0;
  let inFlight: Promise<void> | null = null;

  async function load(): Promise<void> {
    let next: CatalogueItem[] = [];
    try {
      next = await stock.getCatalogue();
    } catch (error) {
      logger.warn(
        { errorName: error instanceof Error ? error.name : typeof error },
        'Catalogue refresh failed',
      );
    }
    // getCatalogue returns [] on failure, so an empty answer cannot replace what we already have.
    if (next.length > 0) {
      items = next;
      freshUntil = clock().getTime() + CATALOGUE_TTL_MS;
    } else {
      freshUntil = clock().getTime() + CATALOGUE_RETRY_MS;
    }
  }

  function refresh(): Promise<void> {
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async get() {
      if (clock().getTime() < freshUntil) return items;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CATALOGUE_WAIT_MS);
      });
      await Promise.race([refresh(), deadline]);
      clearTimeout(timer);
      return items;
    },
  };
}

function productFor(sku: string | null, catalogue: CatalogueItem[]): ProductInfo | null {
  if (sku === null) return null;
  const key = sku.toUpperCase();
  const item = catalogue.find((entry) => entry.sku.toUpperCase() === key);
  if (!item) return null;
  const { sku: _sku, available: _available, ...product } = item;
  return product;
}

export function embedRoutes(
  app: FastifyInstance,
  deps: { stock: StockClient; clock: Clock; logger: Logger; views: Views },
): void {
  const { views } = deps;
  const cache = createCatalogueCache(deps);

  app.get<{ Querystring: { sku?: unknown } }>('/embed', async (request, reply) => {
    const parsed = validateSku(request.query.sku);
    const sku = parsed.ok ? parsed.value : null;
    const catalogue = await cache.get();
    const nonce = newNonce();
    return reply
      .header('Content-Security-Policy', embedCsp(nonce))
      .header('Cache-Control', 'no-transform') // A CDN's injected scripts would break under the CSP.
      .type(HTML_TYPE)
      .send(views.renderEmbed({ sku, product: productFor(sku, catalogue), catalogue, nonce }));
  });
}
