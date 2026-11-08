import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../contracts.ts';

export const SESSION_COOKIE = 'bis_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_VALUE = /^(\d{1,16})\.([0-9a-f]{64})$/;

const sha256 = (text: string): Buffer => createHash('sha256').update(text).digest();

/** Constant-time comparison that does not reveal the length of either string. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/** The password from an `Authorization: Basic` header. The username is ignored. */
export function basicPassword(header: string | undefined): string | null {
  const match = header === undefined ? null : /^basic\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}

export interface AdminAuth {
  checkPassword(candidate: string): boolean;
  hasValidSession(cookieHeader: string | undefined): boolean;
  /** A new cookie value, `<expiryMs>.<hmac>`. */
  issueSession(): string;
}

export function createAdminAuth(deps: { password: string; clock: Clock }): AdminAuth {
  const { password, clock } = deps;
  // scrypt, since an admin password is usually low-entropy and a captured cookie would otherwise
  // allow a fast offline guess. The key also changes with the password, ending old sessions.
  const key = scryptSync(password, 'back-in-stock/admin-session/v1', 32);
  const sign = (expiry: string): Buffer => createHmac('sha256', key).update(expiry).digest();

  function isValidValue(value: string): boolean {
    const match = SESSION_VALUE.exec(value);
    if (!match?.[1] || !match[2]) return false;
    const signatureMatches = timingSafeEqual(Buffer.from(match[2], 'hex'), sign(match[1]));
    return signatureMatches && Number(match[1]) > clock().getTime();
  }

  return {
    checkPassword: (candidate) => safeEqual(candidate, password),

    hasValidSession(cookieHeader) {
      if (!cookieHeader) return false;
      const prefix = `${SESSION_COOKIE}=`;
      return cookieHeader
        .split(';')
        .map((part) => part.trim())
        .some((part) => part.startsWith(prefix) && isValidValue(part.slice(prefix.length)));
    },

    issueSession() {
      const expiry = String(clock().getTime() + SESSION_TTL_MS);
      return `${expiry}.${sign(expiry).toString('hex')}`;
    },
  };
}

function cookieAttributes(maxAgeSeconds: number, secure: boolean): string {
  const attributes = `Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
  return secure ? `${attributes}; Secure` : attributes;
}

export const sessionCookie = (value: string, secure: boolean): string =>
  `${SESSION_COOKIE}=${value}; ${cookieAttributes(SESSION_TTL_MS / 1000, secure)}`;

export const clearedSessionCookie = (secure: boolean): string =>
  `${SESSION_COOKIE}=; ${cookieAttributes(0, secure)}`;

/** Only decides the cookie's Secure flag, so a spoofed value can do no more than disable it. */
export function isForwardedHttps(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/** True if the Origin's host equals the Host header, with default ports normalised away. */
export function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === new URL(`${parsed.protocol}//${host}`).host;
  } catch {
    return false; // Includes `Origin: null`, which is what sandboxed frames send.
  }
}

export interface IpThrottle {
  isBlocked(ip: string): boolean;
  /** Seconds until a blocked address may try again. */
  retryAfterSeconds(ip: string): number;
  record(ip: string): void;
  reset(ip: string): void;
}

export function createIpThrottle(deps: {
  clock: Clock;
  limit: number;
  windowMs: number;
  maxEntries: number;
}): IpThrottle {
  const { clock, limit, windowMs, maxEntries } = deps;
  // Map keeps insertion order, so the first key is always the oldest window.
  const entries = new Map<string, { count: number; resetAt: number }>();

  function live(ip: string): { count: number; resetAt: number } | null {
    const entry = entries.get(ip);
    if (!entry) return null;
    if (entry.resetAt > clock().getTime()) return entry;
    entries.delete(ip);
    return null;
  }

  function makeRoom(): void {
    const now = clock().getTime();
    for (const [ip, entry] of entries) {
      if (entries.size < maxEntries && entry.resetAt > now) return;
      if (entry.resetAt <= now || entries.size >= maxEntries) entries.delete(ip);
    }
  }

  return {
    isBlocked(ip) {
      const entry = live(ip);
      return entry !== null && entry.count >= limit;
    },

    retryAfterSeconds(ip) {
      const entry = live(ip);
      return entry ? Math.max(1, Math.ceil((entry.resetAt - clock().getTime()) / 1000)) : 0;
    },

    record(ip) {
      const entry = live(ip);
      if (entry) {
        entry.count += 1;
        return;
      }
      makeRoom();
      entries.set(ip, { count: 1, resetAt: clock().getTime() + windowMs });
    },

    reset(ip) {
      entries.delete(ip);
    },
  };
}
