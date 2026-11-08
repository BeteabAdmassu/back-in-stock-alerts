import {
  type Clock,
  type EmailMessage,
  type EmailSender,
  idempotencyKeyFor,
  type Logger,
  type RequestRow,
  type SendResult,
  type StockClient,
  type Store,
  type Timings,
  type Worker,
} from '../contracts.ts';
import { renderBackInStockEmail } from '../email/template.ts';
import { emailBackoffMs } from './backoff.ts';
import { createPoller } from './poller.ts';

const CONCURRENCY = 4;

export interface EmailWorkerOptions {
  store: Store;
  stock: StockClient;
  sender: EmailSender;
  clock: Clock;
  logger: Logger;
  timings: Timings;
  /** e.g. https://shop.example/p/{sku}. Null means the email has no shop button. */
  productUrlTemplate: string | null;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

export function createEmailWorker(options: EmailWorkerOptions): Worker {
  const { store, stock, sender, clock, logger, timings, productUrlTemplate } = options;

  // A claim has to cover one re-verify and one send, each bounded by httpTimeoutMs. A shorter lease
  // would let another claim start while this attempt is still running.
  if (!(timings.leaseMs > 2 * timings.httpTimeoutMs)) {
    throw new RangeError('leaseMs must exceed twice httpTimeoutMs');
  }

  const log = (requestId: string, outcome: string, extra: object = {}): void => {
    logger.info({ worker: 'email', requestId, outcome, ...extra }, 'Email worker outcome');
  };

  const windowExhausted = (row: RequestRow): boolean => {
    if (!row.firstAttemptAt) return false;
    return clock().getTime() - Date.parse(row.firstAttemptAt) >= timings.emailGiveUpAfterMs;
  };

  const verificationIsFresh = (row: RequestRow): boolean => {
    if (!row.verifiedAt) return false;
    return clock().getTime() - Date.parse(row.verifiedAt) <= timings.stockFreshnessMs;
  };

  /** Returns false if the row went back to `open` and must not be sent. */
  async function confirmStillInStock(row: RequestRow): Promise<boolean> {
    if (verificationIsFresh(row)) return true;

    let result: Awaited<ReturnType<StockClient['getStock']>>;
    try {
      result = await stock.getStock(row.sku);
    } catch (error) {
      result = { kind: 'error', error: errorName(error) };
    }

    if (result.kind === 'error') {
      // Verified earlier, and a stock outage must not block delivery.
      log(row.id, 'reverify_unavailable');
      return true;
    }
    if (result.available) {
      store.touchVerified(row.id);
      return true;
    }
    if (store.holdForStock(row.id)) {
      log(row.id, 'held_sold_out');
      return false;
    }
    // Sold out, but an earlier attempt may have been delivered. The key makes sending again safe.
    log(row.id, 'sold_out_but_may_be_delivered');
    return true;
  }

  function render(row: RequestRow): EmailMessage {
    const productUrl =
      productUrlTemplate === null
        ? null
        : productUrlTemplate.replaceAll('{sku}', () => encodeURIComponent(row.sku));
    const { subject, html, text } = renderBackInStockEmail({
      sku: row.sku,
      product: row.product,
      productUrl,
    });
    return { to: row.email, subject, html, text };
  }

  async function send(row: RequestRow, message: EmailMessage): Promise<SendResult> {
    try {
      return await sender.send(message, { idempotencyKey: idempotencyKeyFor(row.id) });
    } catch (error) {
      // The message of an unknown error could quote the recipient, so only its type goes further.
      logger.error(
        { worker: 'email', requestId: row.id, errorName: errorName(error) },
        'Send threw',
      );
      return { kind: 'retryable', ambiguous: true, error: 'Unexpected error during send' };
    }
  }

  async function processRow(row: RequestRow): Promise<void> {
    if (windowExhausted(row)) {
      store.markEmailFailed(row.id, {
        error: 'Gave up: retry window exhausted',
        ambiguous: false,
      });
      log(row.id, 'gave_up');
      return;
    }

    if (!(await confirmStillInStock(row))) return;

    // Before beginSend, so a render failure can't leave a write-ahead marker for a send never made.
    let message: EmailMessage;
    try {
      message = render(row);
    } catch (error) {
      store.markEmailFailed(row.id, { error: 'Could not render the email', ambiguous: false });
      log(row.id, 'render_failed', { errorName: errorName(error) });
      return;
    }

    if (!store.beginSend(row.id)) {
      log(row.id, 'lease_lost');
      return;
    }
    // The claimed copy was read before beginSend counted this attempt.
    const attempts = row.attempts + 1;

    const result = await send(row, message);
    switch (result.kind) {
      case 'accepted':
        store.markEmailSent(row.id, result.providerId);
        log(row.id, 'sent', { attempts });
        return;
      case 'retryable': {
        const delayMs = Math.max(emailBackoffMs(attempts), result.retryAfterMs ?? 0);
        store.markEmailRetry(row.id, {
          error: result.error,
          nextAttemptAt: new Date(clock().getTime() + delayMs),
          ambiguous: result.ambiguous,
        });
        log(row.id, 'retry_scheduled', {
          attempts,
          delayMs,
          ambiguous: result.ambiguous,
          error: result.error,
        });
        return;
      }
      case 'rejected':
        store.markEmailFailed(row.id, { error: result.error, ambiguous: false });
        log(row.id, 'rejected', { attempts, error: result.error });
        return;
    }
  }

  return createPoller<RequestRow>({
    name: 'email',
    claim: (limit) => store.claimDueEmails(limit),
    process: processRow,
    concurrency: CONCURRENCY,
    intervalMs: timings.pollIntervalMs,
    logger,
  });
}
