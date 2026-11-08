import type { FastifyInstance } from 'fastify';
import type { Clock, Store } from '../../contracts.ts';
import { validateRequestBody } from '../../domain/validation.ts';
import { createIpThrottle } from '../auth.ts';
import { sendError } from './shared.ts';

/**
 * Well above any real shopper, and high enough that a burst of customers from one network isn't
 * turned away. It limits how fast junk can arrive; store ordering protects real checks from what does.
 */
export const NEW_REQUESTS_PER_MINUTE = 600;

export function requestRoutes(
  app: FastifyInstance,
  deps: { store: Store; clock: Clock; wake: { stockChecks(): void } },
): void {
  const { store, clock, wake } = deps;
  const path = '/api/requests';
  // Counts only requests that were created, since a duplicate costs nothing. In memory: forgetting
  // it on restart is harmless, because it holds no state a customer depends on.
  const throttle = createIpThrottle({
    clock,
    limit: NEW_REQUESTS_PER_MINUTE,
    windowMs: 60 * 1000,
    maxEntries: 10_000,
  });

  // No credentials are ever allowed: the form runs on other people's stores and needs none. Set in
  // onRequest so that errors raised while parsing, such as 413 and 415, are readable as well.
  const allowAnyOrigin = async (
    _request: unknown,
    reply: { header(name: string, value: string): unknown },
  ): Promise<void> => {
    reply.header('Access-Control-Allow-Origin', '*');
  };

  app.options(path, { onRequest: allowAnyOrigin }, async (_request, reply) =>
    reply
      .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type')
      .header('Access-Control-Max-Age', '600')
      .code(204)
      .send(),
  );

  app.post(path, { onRequest: allowAnyOrigin }, async (request, reply) => {
    const input = validateRequestBody(request.body);
    if (!input.ok) {
      const { field, message } = input;
      return reply.code(400).send({ error: { code: 'invalid_request', field, message } });
    }

    // Someone already on the list adds nothing by asking again, so the limit doesn't apply to them.
    if (throttle.isBlocked(request.ip) && !store.findOpenRequest(input.value)) {
      reply.header('Retry-After', String(throttle.retryAfterSeconds(request.ip)));
      return sendError(
        reply,
        429,
        'too_many_requests',
        'Too many sign-ups from this connection. Please try again in a minute.',
      );
    }

    const { request: row, created } = store.createRequest(input.value);
    if (created) {
      throttle.record(request.ip);
      wake.stockChecks();
    }

    return reply.code(created ? 201 : 200).send({
      id: row.id,
      email: row.email,
      sku: row.sku,
      status: row.status,
      duplicate: !created,
    });
  });
}
