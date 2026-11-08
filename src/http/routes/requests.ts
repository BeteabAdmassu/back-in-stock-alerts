import type { FastifyInstance } from 'fastify';
import type { Store } from '../../contracts.ts';
import { validateRequestBody } from '../../domain/validation.ts';

export function requestRoutes(
  app: FastifyInstance,
  deps: { store: Store; wake: { stockChecks(): void } },
): void {
  const { store, wake } = deps;
  const path = '/api/requests';

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

    const { request: row, created } = store.createRequest(input.value);
    if (created) wake.stockChecks();

    return reply.code(created ? 201 : 200).send({
      id: row.id,
      email: row.email,
      sku: row.sku,
      status: row.status,
      duplicate: !created,
    });
  });
}
