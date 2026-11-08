import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import type { AppConfig, Logger } from './contracts.ts';
import { openDatabase } from './db/database.ts';
import { createStore } from './db/store.ts';
import { createApp } from './http/app.ts';
import { renderAdmin } from './http/views/admin.ts';
import { renderEmbed } from './http/views/embed.ts';
import { renderLogin } from './http/views/login.ts';
import { createEmailClient } from './integrations/email-client.ts';
import { createStockClient } from './integrations/stock-client.ts';
import { createEmailWorker } from './workers/email-worker.ts';
import { createReconciler } from './workers/reconciler.ts';
import { createStockCheckWorker } from './workers/stock-check-worker.ts';

const WORKER_STOP_CAP_MS = 15_000;
const HTTP_CLOSE_CAP_MS = 5_000;

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function createJsonLogger(level: string): Logger {
  const threshold = LEVELS[level.toLowerCase()] ?? 1;
  const write = (name: 'info' | 'warn' | 'error', obj: object, msg?: string): void => {
    if ((LEVELS[name] ?? 1) < threshold) return;
    const line = { ...obj, time: new Date().toISOString(), level: name, msg };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
  return {
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
  };
}

// Only the type: messages can carry URLs, addresses or provider responses.
function describeError(error: unknown): { errorName: string; errorCode?: unknown } {
  if (!(error instanceof Error)) return { errorName: typeof error };
  return { errorName: error.name, errorCode: (error as { code?: unknown }).code };
}

/** Resolves to true if the work finished within the cap. Never rejects. */
async function withinCap(work: Promise<unknown>, capMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), capMs);
  });
  const finished = work.then(
    () => true,
    () => true,
  );
  const result = await Promise.race([finished, cap]);
  clearTimeout(timer);
  return result;
}

async function main(config: AppConfig, logger: Logger): Promise<void> {
  const clock = () => new Date();
  const { timings } = config;

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(join(config.dataDir, 'back-in-stock.db'));
  const store = createStore({ db, clock, leaseMs: timings.leaseMs });
  logger.info(store.recoverAfterRestart(), 'Recovered after restart');

  const stock = createStockClient({
    baseUrl: config.stockApiUrl,
    apiKey: config.stockApiKey,
    timeoutMs: timings.httpTimeoutMs,
    logger,
  });
  const sender = createEmailClient({
    baseUrl: config.resendBaseUrl,
    apiKey: config.resendApiKey,
    from: config.emailFrom,
    timeoutMs: timings.httpTimeoutMs,
  });
  const emailWorker = createEmailWorker({
    store,
    stock,
    sender,
    clock,
    logger,
    timings,
    productUrlTemplate: config.productUrlTemplate,
  });
  const stockWorker = createStockCheckWorker({
    store,
    stock,
    clock,
    logger,
    timings,
    onQueued: () => emailWorker.wake(),
  });
  const reconciler = createReconciler({
    store,
    clock,
    logger,
    timings,
    onEnqueued: () => stockWorker.wake(),
  });
  const workers = [reconciler, stockWorker, emailWorker];

  const app = createApp({
    config,
    store,
    stock,
    clock,
    logger,
    views: { renderEmbed, renderLogin, renderAdmin },
    wake: { stockChecks: () => stockWorker.wake() },
  });

  let shuttingDown = false;

  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) {
      logger.warn({ reason }, 'Second signal, exiting immediately');
      process.exit(exitCode === 0 ? 1 : exitCode);
    }
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down');

    // Each step is capped, and later steps still run: closing the database cleanly matters more
    // than waiting on a slow client. SIGKILL is covered by the write-ahead send marker.
    if (!(await withinCap(app.close(), HTTP_CLOSE_CAP_MS))) {
      logger.warn({}, 'HTTP server did not close in time');
      app.server.closeAllConnections();
    }
    const stopped = Promise.all(workers.map((worker) => worker.stop()));
    if (!(await withinCap(stopped, WORKER_STOP_CAP_MS))) {
      logger.warn({}, 'Workers did not stop in time');
    }
    store.close();
    logger.info({}, 'Stopped');
    process.exit(exitCode);
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal, 0));
  }
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      logger.error({ event, ...describeError(error) }, 'Uncaught error');
      // All state is durable, so the safe response to an unknown state is to stop and be restarted.
      if (!shuttingDown) void shutdown(event, 1);
    });
  }

  await app.listen({ host: '0.0.0.0', port: config.port });
  logger.info({ port: config.port }, 'Listening');
  for (const worker of workers) worker.start();
}

let config: AppConfig;
try {
  config = loadConfig();
} catch (error) {
  // loadConfig's messages name variables and never include values.
  console.error(error instanceof Error ? error.message : 'Invalid configuration.');
  process.exit(1);
}

const logger = createJsonLogger(config.logLevel);
main(config, logger).catch((error: unknown) => {
  logger.error(describeError(error), 'Failed to start');
  process.exit(1);
});
