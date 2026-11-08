import type {
  Clock,
  Logger,
  StockCheckClaim,
  StockClient,
  StockResult,
  Store,
  Timings,
  Worker,
} from '../contracts.ts';
import { stockCheckBackoffMs } from './backoff.ts';
import { createPoller } from './poller.ts';

const CONCURRENCY = 4;

export interface StockCheckWorkerOptions {
  store: Store;
  stock: StockClient;
  clock: Clock;
  logger: Logger;
  timings: Timings;
  onQueued: () => void;
}

export function createStockCheckWorker(options: StockCheckWorkerOptions): Worker {
  const { store, stock, clock, logger, timings, onQueued } = options;

  async function fetchStock(sku: string): Promise<StockResult> {
    try {
      return await stock.getStock(sku);
    } catch {
      // The client's contract is not to throw, but if it did the check must still back off.
      return { kind: 'error', error: 'stock client failed unexpectedly' };
    }
  }

  /** In stock under any spelling wins. Otherwise a failure means we can't say it's out of stock. */
  async function fetchAcrossSpellings(claim: StockCheckClaim): Promise<StockResult> {
    const others = store.openSkuSpellings(claim.skuKey).filter((sku) => sku !== claim.querySku);
    let settled = await fetchStock(claim.querySku);
    if (settled.kind === 'ok' && settled.available) return settled;
    for (const sku of others) {
      const result = await fetchStock(sku);
      if (result.kind === 'ok' && result.available) return result;
      if (result.kind === 'error') settled = result;
    }
    return settled;
  }

  async function check(claim: StockCheckClaim): Promise<void> {
    if (!store.hasOpenRequests(claim.skuKey)) {
      store.completeStockCheck(claim, { kind: 'skipped' });
      return;
    }

    const result = await fetchAcrossSpellings(claim);

    if (result.kind === 'error') {
      const attempts = claim.attempts + 1;
      const dueAt = new Date(clock().getTime() + stockCheckBackoffMs(attempts));
      store.rescheduleStockCheck(claim, result.error, dueAt);
      logger.warn(
        { skuKey: claim.skuKey, attempts, error: result.error },
        'Stock check failed, will retry',
      );
      return;
    }

    if (!result.available) {
      store.completeStockCheck(claim, { kind: 'out_of_stock', quantity: result.quantity });
      return;
    }

    const { queued } = store.completeStockCheck(claim, {
      kind: 'in_stock',
      quantity: result.quantity,
      product: result.product,
    });
    if (queued > 0) onQueued();
  }

  // A check whose generation moved mid-flight is released as due now. No explicit wake is needed:
  // the poller starts a new pass as soon as an item finishes, and that pass claims it.
  return createPoller({
    name: 'stock-check',
    claim: (limit) => store.claimDueStockChecks(limit),
    process: check,
    concurrency: CONCURRENCY,
    intervalMs: timings.pollIntervalMs,
    logger,
  });
}
