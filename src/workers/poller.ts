import type { Logger, Worker } from '../contracts.ts';

export interface PollerOptions<T> {
  /** Used in log lines. */
  name: string;
  /** Claims at most `limit` items. Synchronous, like the Store. */
  claim: (limit: number) => T[];
  process: (item: T) => Promise<void>;
  concurrency: number;
  intervalMs: number;
  logger: Logger;
}

// Only the error's type is logged: messages can carry URLs, addresses or provider responses.
function describeError(error: unknown): { errorName: string; errorCode?: unknown } {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as { code?: unknown }).code;
  return code === undefined
    ? { errorName: error.name }
    : { errorName: error.name, errorCode: code };
}

export function createPoller<T>(options: PollerOptions<T>): Worker {
  const { name, claim, process: processItem, concurrency, intervalMs, logger } = options;
  if (!(concurrency >= 1)) throw new RangeError('concurrency must be at least 1');
  if (!(intervalMs > 0)) throw new RangeError('intervalMs must be positive');

  const inFlight = new Set<Promise<void>>();
  let running = false;
  let interval: NodeJS.Timeout | null = null;
  let passScheduled = false;

  async function runItem(item: T): Promise<void> {
    try {
      await processItem(item);
    } catch (error) {
      logger.error({ worker: name, ...describeError(error) }, 'Worker failed to process an item');
    }
  }

  function launch(item: T): void {
    const task: Promise<void> = runItem(item).finally(() => {
      inFlight.delete(task);
      schedulePass(); // A slot is free, so look for more work now rather than at the next poll.
    });
    inFlight.add(task);
  }

  function pass(): void {
    if (!running) return;
    const free = concurrency - inFlight.size;
    if (free <= 0) return; // Each finishing item schedules a new pass, so nothing is missed.
    let items: T[];
    try {
      items = claim(free);
    } catch (error) {
      logger.error({ worker: name, ...describeError(error) }, 'Worker failed to claim work');
      return;
    }
    for (const item of items) launch(item);
  }

  // A pass runs synchronously, so a wake during one (or several at once) lands on this flag and
  // produces exactly one further pass, outside the caller's stack.
  function schedulePass(): void {
    if (!running || passScheduled) return;
    passScheduled = true;
    setImmediate(() => {
      passScheduled = false;
      pass();
    }).unref();
  }

  return {
    start() {
      if (running) return;
      running = true;
      interval = setInterval(pass, intervalMs);
      interval.unref();
      schedulePass();
    },

    wake() {
      schedulePass();
    },

    async stop() {
      running = false;
      if (interval) clearInterval(interval);
      interval = null;
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}
