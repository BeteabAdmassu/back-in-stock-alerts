import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Clock, REQUEST_STATUSES, type RequestStatus, type Store } from '../../contracts.ts';
import {
  basicPassword,
  clearedSessionCookie,
  createAdminAuth,
  createLoginThrottle,
  isForwardedHttps,
  originMatchesHost,
  sessionCookie,
} from '../auth.ts';
import { adminCsp, HTML_TYPE, newNonce, sendError, type Views } from './shared.ts';

const PAGE_SIZE = 50;
const RECENT_EVENTS = 20;
const MAX_SEARCH_LENGTH = 200;
const MAX_PAGE = 1_000_000_000; // Keeps the offset well inside what SQLite can bind.

const parsePage = (input: unknown): number => {
  if (typeof input !== 'string' || !/^[1-9]\d{0,9}$/.test(input)) return 1;
  const page = Number(input);
  return page <= MAX_PAGE ? page : 1;
};

const parseStatus = (input: unknown): RequestStatus | null =>
  REQUEST_STATUSES.find((status) => status === input) ?? null;

interface AdminQuery {
  q?: unknown;
  status?: unknown;
  page?: unknown;
}

export function adminRoutes(
  scope: FastifyInstance,
  deps: { password: string; store: Store; clock: Clock; views: Views },
): void {
  const { password, store, clock, views } = deps;
  const auth = createAdminAuth({ password, clock });
  const throttle = createLoginThrottle({
    clock,
    maxFailures: 10,
    windowMs: 5 * 60 * 1000,
    maxEntries: 10_000,
  });
  const nonces = new WeakMap<FastifyRequest, string>();
  const nonceOf = (request: FastifyRequest): string => nonces.get(request) ?? '';

  const isSecure = (request: FastifyRequest): boolean =>
    isForwardedHttps(request.headers['x-forwarded-proto']);

  const sendLogin = (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    error: string | null,
  ): FastifyReply =>
    reply
      .code(status)
      .type(HTML_TYPE)
      .send(views.renderLogin({ error, nonce: nonceOf(request) }));

  const TOO_MANY = 'Too many failed attempts. Please wait a few minutes and try again.';

  const sendThrottled = (request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    reply.header('Retry-After', String(throttle.retryAfterSeconds(request.ip)));
    return wantsHtml(request)
      ? sendLogin(request, reply, 429, TOO_MANY)
      : sendError(reply, 429, 'too_many_attempts', TOO_MANY);
  };

  const wantsHtml = (request: FastifyRequest): boolean =>
    (request.headers.accept ?? '').toLowerCase().includes('text/html');

  // Browsers get our login page. WWW-Authenticate would replace it with a native dialog.
  const sendUnauthenticated = (request: FastifyRequest, reply: FastifyReply): FastifyReply =>
    wantsHtml(request)
      ? sendLogin(request, reply, 401, null)
      : sendError(
          reply.header('WWW-Authenticate', 'Basic realm="admin"'),
          401,
          'unauthorized',
          'Authentication required.',
        );

  // In onRequest, so an unauthenticated caller learns nothing from how its body is parsed.
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (auth.hasValidSession(request.headers.cookie)) return;
    const candidate = basicPassword(request.headers.authorization);
    if (candidate === null) return sendUnauthenticated(request, reply);
    // Basic shares the throttle, or it would be a way around the limit on the login form.
    if (throttle.isBlocked(request.ip)) return sendThrottled(request, reply);
    if (auth.checkPassword(candidate)) return;
    throttle.recordFailure(request.ip);
    return sendUnauthenticated(request, reply);
  };

  // Scoped to this plugin: nothing outside /admin may accept a form post.
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, new URLSearchParams(body as string));
    },
  );

  scope.addHook('onRequest', async (request, reply) => {
    const nonce = newNonce();
    nonces.set(request, nonce);
    reply
      .header('Cache-Control', 'no-store, no-transform') // Proxies must not rewrite these pages.
      .header('Content-Security-Policy', adminCsp(nonce))
      .header('X-Frame-Options', 'DENY')
      // With no-referrer, browsers send `Origin: null` on form POSTs, which the check below rejects.
      .header('Referrer-Policy', 'same-origin');

    const { origin } = request.headers;
    if (
      request.method === 'POST' &&
      origin !== undefined &&
      !originMatchesHost(origin, request.headers.host)
    ) {
      return sendError(reply, 403, 'forbidden', 'Cross-origin requests are not allowed.');
    }
  });

  scope.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'not_found', 'Not found.'));

  scope.get<{ Querystring: AdminQuery }>(
    '/',
    { onRequest: requireAuth },
    async (request, reply) => {
      const { q, status: rawStatus, page: rawPage } = request.query;
      const search = typeof q === 'string' ? q.trim().slice(0, MAX_SEARCH_LENGTH) : '';
      const status = parseStatus(rawStatus);
      const page = parsePage(rawPage);
      const { rows, total } = store.listRequests({
        search: search === '' ? undefined : search,
        status: status ?? undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      return reply.type(HTML_TYPE).send(
        views.renderAdmin({
          rows,
          total,
          counts: store.statusCounts(),
          search,
          status,
          page,
          pageSize: PAGE_SIZE,
          events: store.listRecentWebhookEvents(RECENT_EVENTS),
          nonce: nonceOf(request),
        }),
      );
    },
  );

  // Reached by reloading the address a failed login left in the location bar.
  scope.get('/login', async (_request, reply) => reply.redirect('/admin', 303));

  scope.post('/login', async (request, reply) => {
    if (throttle.isBlocked(request.ip)) return sendThrottled(request, reply);
    const candidate = request.body instanceof URLSearchParams ? request.body.get('password') : null;
    if (candidate === null || !auth.checkPassword(candidate)) {
      throttle.recordFailure(request.ip);
      return sendLogin(request, reply, 401, 'That password is not correct.');
    }
    throttle.reset(request.ip);
    return reply
      .header('Set-Cookie', sessionCookie(auth.issueSession(), isSecure(request)))
      .redirect('/admin', 303);
  });

  scope.post('/logout', async (request, reply) =>
    reply.header('Set-Cookie', clearedSessionCookie(isSecure(request))).redirect('/admin', 303),
  );

  scope.post<{ Params: { id: string } }>(
    '/requests/:id/retry',
    { onRequest: requireAuth },
    async (request, reply) => {
      // Not failed, or unknown: nothing to retry, and the list shows the row's actual state.
      store.retryFailed(request.params.id);
      return reply.redirect('/admin', 303);
    },
  );
}
