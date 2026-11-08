import type { FastifyInstance } from 'fastify';
import type { Store } from '../../contracts.ts';
import { validateWebhookPayload } from '../../domain/validation.ts';
import { safeEqual } from '../auth.ts';
import { sendError } from './shared.ts';

export function webhookRoutes(
  app: FastifyInstance,
  deps: { store: Store; webhookSecret: string; wake: { stockChecks(): void } },
): void {
  const { store, webhookSecret, wake } = deps;

  app.post(
    '/webhooks/stock',
    {
      // onRequest runs before the body is read, so without the secret nothing about the body,
      // not even its size or whether it parses, gets an answer other than 401.
      onRequest: async (request, reply) => {
        const supplied = request.headers['x-webhook-secret'];
        if (typeof supplied !== 'string' || !safeEqual(supplied, webhookSecret)) {
          return sendError(reply, 401, 'unauthorized', 'Invalid webhook secret.');
        }
      },
    },
    async (request, reply) => {
      const input = validateWebhookPayload(request.body);
      if (!input.ok) {
        const { field, message } = input;
        return reply.code(400).send({ error: { code: 'invalid_request', field, message } });
      }

      // The ack below only happens after this commits, so an acknowledged event cannot be lost.
      const { inserted } = store.recordWebhookEvent(input.value);
      if (inserted) wake.stockChecks();
      return reply.code(200).send({ received: true, duplicate: !inserted });
    },
  );
}
