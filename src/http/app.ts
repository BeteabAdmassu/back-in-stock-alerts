import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AppConfig, Clock, Logger, StockClient, Store } from '../contracts.ts';
import { adminRoutes } from './routes/admin.ts';
import { embedRoutes } from './routes/embed.ts';
import { healthRoutes } from './routes/health.ts';
import { requestRoutes } from './routes/requests.ts';
import { NON_PAGE_CSP, sendError, type Views } from './routes/shared.ts';
import { webhookRoutes } from './routes/webhooks.ts';

export type { Views } from './routes/shared.ts';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  stock: StockClient;
  clock: Clock;
  logger: Logger;
  views: Views;
  wake: { stockChecks(): void };
}

const BODY_LIMIT_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const BASELINE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // /embed and /admin replace this with their own. Only /embed may be framed.
  'Content-Security-Policy': NON_PAGE_CSP,
};

/** Maps Fastify's client errors to our codes. Messages are ours: its own can echo input. */
function clientError(error: FastifyError): { status: number; code: string; message: string } {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return { status: 413, code: 'payload_too_large', message: 'The request body is too large.' };
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        status: 415,
        code: 'unsupported_media_type',
        message: 'That content type is not supported here.',
      };
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return { status: 400, code: 'invalid_json', message: 'The request body is not valid JSON.' };
  }
  if (error instanceof SyntaxError) {
    return { status: 400, code: 'invalid_json', message: 'The request body is not valid JSON.' };
  }
  const status = error.statusCode ?? 500;
  return status >= 400 && status < 500
    ? { status, code: 'bad_request', message: 'The request could not be processed.' }
    : { status: 500, code: 'internal_error', message: 'Something went wrong. Please try again.' };
}

export function createApp(deps: AppDeps): FastifyInstance {
  const { config, store, stock, clock, logger, views, wake } = deps;

  const app = Fastify({
    logger: false,
    // Off unless configured: otherwise anyone could pick their own IP with X-Forwarded-For.
    trustProxy: (_address, hop) => hop < config.trustProxyHops,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    // A URL that cannot be decoded never reaches a hook, so it needs the baseline headers here.
    frameworkErrors: (_error, _request, reply) => {
      reply.headers(BASELINE_HEADERS);
      sendError(reply, 400, 'bad_request', 'The request could not be processed.');
    },
  }) as unknown as FastifyInstance;

  // Fastify parses text/plain by default. Here JSON is the only body the public routes take, and
  // text/plain is what a cross-site form can send without a preflight.
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (_request, reply) => {
    reply.headers(BASELINE_HEADERS);
  });

  // The route pattern only: raw URLs carry query strings, and those can carry emails.
  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? null,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const { status, code, message } = clientError(error);
    if (status === 500) {
      // Only the error's type: messages can carry input, addresses or provider responses.
      logger.error(
        {
          errorName: error.name,
          errorCode: error.code,
          method: request.method,
          route: request.routeOptions.url ?? null,
        },
        'Unhandled error',
      );
    }
    return sendError(reply, status, code, message);
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'not_found', 'Not found.'));

  healthRoutes(app, { store });
  embedRoutes(app, { stock, clock, logger, views });
  requestRoutes(app, { store, clock, wake });
  webhookRoutes(app, { store, webhookSecret: config.webhookSecret, wake });

  // A plugin, so its form parser and security headers stay encapsulated under /admin.
  app.register(
    async (scope) => {
      adminRoutes(scope, { password: config.adminPassword, store, clock, views });
    },
    { prefix: '/admin' },
  );

  return app;
}
