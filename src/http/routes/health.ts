import type { FastifyInstance } from 'fastify';
import type { Store } from '../../contracts.ts';

export function healthRoutes(app: FastifyInstance, deps: { store: Store }): void {
  const { store } = deps;

  app.get('/', async (_request, reply) => reply.redirect('/embed'));

  app.get('/healthz', async (_request, reply) => {
    let healthy = false;
    try {
      healthy = store.ping();
    } catch {
      // Reported as unhealthy below.
    }
    return healthy
      ? reply.code(200).send({ status: 'ok' })
      : reply.code(503).send({ status: 'unavailable' });
  });
}
