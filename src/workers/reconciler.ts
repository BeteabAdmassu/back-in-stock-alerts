import type { Clock, Logger, Store, Timings, Worker } from '../contracts.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReconcilerOptions {
  store: Store;
  clock: Clock;
  logger: Logger;
  timings: Timings;
  onEnqueued: () => void;
  retentionDays?: number;
}

// Only the error's type is logged: messages can carry data that does not belong in logs.
const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

export function createReconciler(options: ReconcilerOptions): Worker {
  const { store, clock, logger, timings, onEnqueued, retentionDays = 30 } = options;

  let timer: NodeJS.Timeout | null = null;

  function reconcile(): void {
    try {
      const enqueued = store.enqueueChecksForOpenSkus();
      if (enqueued > 0) {
        logger.info({ enqueued }, 'Reconciler enqueued stock checks');
        onEnqueued();
      }
    } catch (error) {
      logger.error({ errorName: errorName(error) }, 'Reconciler failed to enqueue stock checks');
    }
    // Separate from the above, so a failure there does not also stop retention, or the reverse.
    try {
      const purged = store.purgeWebhookEventsBefore(
        new Date(clock().getTime() - retentionDays * DAY_MS),
      );
      if (purged > 0) logger.info({ purged }, 'Reconciler purged old webhook events');
    } catch (error) {
      logger.error({ errorName: errorName(error) }, 'Reconciler failed to purge webhook events');
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(reconcile, timings.reconcileIntervalMs);
      timer.unref();
      reconcile();
    },

    wake() {
      if (timer) reconcile();
    },

    // Each run is synchronous, so nothing can be in flight here.
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
