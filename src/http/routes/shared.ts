import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { AdminViewModel, EmbedViewModel, LoginViewModel } from '../../contracts.ts';

/** Injected so that only the composition root imports the real templates. */
export interface Views {
  renderEmbed(model: EmbedViewModel): string;
  renderLogin(model: LoginViewModel): string;
  renderAdmin(model: AdminViewModel): string;
}

export const HTML_TYPE = 'text/html; charset=utf-8';

export const newNonce = (): string => randomBytes(16).toString('base64');

const pagePolicy = (nonce: string, frameAncestors: string): string =>
  [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    'img-src https: data:',
    "form-action 'self'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');

export const embedCsp = (nonce: string): string => pagePolicy(nonce, '*');
export const adminCsp = (nonce: string): string => pagePolicy(nonce, "'none'");
/** For everything that is not a page, such as JSON and redirects. */
export const NON_PAGE_CSP = "default-src 'none'; frame-ancestors 'none'";

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}
