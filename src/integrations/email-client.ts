import type { EmailMessage, EmailSender, SendResult } from '../contracts.ts';

export interface EmailClientOptions {
  /** No trailing slash needed; one is tolerated. */
  baseUrl: string;
  apiKey: string;
  from: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** A Retry-After beyond this is treated as this, so it can't use up the 23h retry window. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** The request may have reached the provider before this response was produced. */
const AMBIGUOUS_STATUSES = new Set([408, 502, 504]);

/**
 * Statuses where a response refuses this attempt but a later one could succeed. 404 and 405 say the
 * URL is wrong, not the message: a misconfigured base URL or a proxy blip, which an operator can fix.
 */
function isRetryableStatus(status: number): boolean {
  return [401, 403, 404, 405, 408, 409, 425, 429].includes(status) || status >= 500;
}

/** Statuses where ARCHITECTURE.md says to honour Retry-After. 401 and 403 are operator problems. */
function honoursRetryAfter(status: number): boolean {
  return [408, 409, 425, 429].includes(status) || status >= 500;
}

/** Accepts delta-seconds or an HTTP date. A date already past, or garbage, gives undefined. */
function parseRetryAfter(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const ms = at - Date.now();
  return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined;
}

/** The provider's error code, if it looks like one. Free text could quote the recipient. */
async function providerErrorName(response: Response): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(await response.text());
    const name = (body as { name?: unknown } | null)?.name;
    return typeof name === 'string' && /^[\w.-]{1,64}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** The status already decided the outcome, so a body that can't be read or parsed changes nothing. */
async function acceptedResult(response: Response): Promise<SendResult> {
  try {
    const body: unknown = JSON.parse(await response.text());
    const id = (body as { id?: unknown } | null)?.id;
    return { kind: 'accepted', providerId: typeof id === 'string' && id ? id : null };
  } catch {
    return { kind: 'accepted', providerId: null };
  }
}

async function refusedResult(response: Response): Promise<SendResult> {
  const { status } = response;
  const name = await providerErrorName(response);
  const error = name ? `HTTP ${status} ${name}` : `HTTP ${status}`;
  if (status >= 400 && status < 500 && !isRetryableStatus(status)) {
    return { kind: 'rejected', error };
  }
  if (isRetryableStatus(status)) {
    const retryAfterMs = honoursRetryAfter(status)
      ? parseRetryAfter(response.headers.get('retry-after'))
      : undefined;
    const ambiguous = AMBIGUOUS_STATUSES.has(status);
    return retryAfterMs === undefined
      ? { kind: 'retryable', ambiguous, error }
      : { kind: 'retryable', ambiguous, error, retryAfterMs };
  }
  // A 1xx or non-redirect 3xx is not a refusal we understand, so the send may have gone through.
  return { kind: 'retryable', ambiguous: true, error };
}

/** Only the kind of failure: messages from fetch can carry the URL. */
function describeTransportError(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'Request timed out';
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
    ? `Network error ${code}`
    : 'Network error';
}

/**
 * Sends through a Resend-format API and classifies the outcome as docs/ARCHITECTURE.md describes.
 * Errors hold a status and the provider's error code only, so they are safe to store and log.
 */
export function createEmailClient(options: EmailClientOptions): EmailSender {
  const { apiKey, from, timeoutMs, fetchImpl = fetch } = options;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/emails`;

  return {
    async send(message: EmailMessage, opts: { idempotencyKey: string }): Promise<SendResult> {
      const { to, subject, html, text } = message;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': opts.idempotencyKey,
          },
          body: JSON.stringify({ from, to: [to], subject, html, text }),
          // A redirect could carry the bearer token and the message somewhere unexpected.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { kind: 'retryable', ambiguous: true, error: describeTransportError(error) };
      }
      return response.ok ? acceptedResult(response) : refusedResult(response);
    },
  };
}
