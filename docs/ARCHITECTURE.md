# Architecture

A single Node process with an embedded SQLite database. The brief requires `docker run` with six env
vars and nothing else, which rules out a separate database server. SQLite in WAL mode with
`synchronous=FULL` gives durable, serialised transactions, and running one process makes the
concurrency model easy to reason about.

```
 store iframe ─ GET /embed ─┐
 POST /api/requests ────────┼─► routes ───► Store (SQLite: requests, webhook_events, stock_checks)
 POST /webhooks/stock ──────┤                  ▲                 ▲
 GET /admin ────────────────┘                  │                 │
                             stock-check worker┘                 └ email worker
                                     │                                 │
                               Stock API (truth)            Resend-format email API
                                     ▲
                             reconciler (every 60s, and on startup)
```

HTTP handlers only validate and write durable intent. All network calls to the stock and email APIs
happen in workers, so webhook senders get a fast 2xx and no outcome depends on a request staying
alive.

## Layers

| Path | Responsibility | May import |
| --- | --- | --- |
| `src/contracts.ts` | Shared types and interfaces | nothing |
| `src/domain/` | Pure validation and normalisation | contracts |
| `src/db/` | Schema, migrations, `Store` | contracts |
| `src/integrations/` | Stock and email HTTP clients | contracts |
| `src/email/` | Email template (pure) | contracts |
| `src/workers/` | Poller, stock-check worker, email worker, reconciler | contracts, email |
| `src/http/` | Fastify app, routes, auth; `views/` are pure HTML functions | contracts, domain |
| `src/index.ts` | Composition root and signal handling | everything |

Modules receive their collaborators as arguments; only `index.ts` builds concrete ones.

## Request lifecycle

```
             stock verified                 claimed                provider accepted
   open ───────────────────► queued ───────────────────► sending ───────────────────► notified
    ▲                         ▲  ▲                         │ │
    │  sold out before send   │  └── retryable failure ────┘ │ permanent failure, or
    └── (only if not          │                              │ retry window exhausted
         ambiguous_send)      └──── admin retry ── failed ◄──┘
```

A new request can be made for the same customer and SKU once the previous one is `notified` or
`failed`, which is what supports future restock cycles. A repeat request within 24h of a notification
stays `open` until a sell-out is known, so repeating a POST while the item is still in stock sends
nothing. If the SKU is already known to have sold out since that notification, there is nothing to
hold back. A sell-out is known from an out-of-stock read or a `quantity: 0` webhook, and is recorded
per SKU in `sku_sellouts` even with nobody waiting. If none is seen within those 24h, the request is
treated normally. A failed send that may have been delivered counts as a notification here, because
the new request would use a new idempotency key.

## How each guarantee is met

**No duplicate open requests.** A partial unique index on `(email, sku_key)` covering `open`,
`queued` and `sending`. Emails are trimmed and lower-cased, SKUs are matched case-insensitively.

**Webhook idempotency.** `event_id` is the primary key, and the event insert and its stock-check
enqueue share a transaction. A retry or simultaneous duplicate loses at the constraint and gets a
2xx. The ack only happens after commit, so an acknowledged event cannot be lost.

**Not trusting the webhook.** Nothing is ever sent because of its `quantity`. Every event triggers a
check against the stock API, and only that check can queue an email. A valid `quantity: 0` event for
a product the API says is available still notifies, because the API is the authority. The one thing
`quantity: 0` does is count as a sell-out: it ends suppression and makes queued rows verify stock
again. Both can only lead to a stock API call first, and the sender holds the webhook secret. The
worst a false or delayed one can do is one extra email, to a customer who asked twice.

**Not trusting the network.** Stock failures are never read as "out of stock": the durable check is
retried with backoff. A reconciler re-checks every SKU with open requests each minute and on
startup, so a webhook that never arrived (including during downtime) still results in an email.

**Lost update while checking.** Enqueuing bumps `stock_checks.generation`. A check whose generation
moved on while it was in flight is released and run again rather than deleted, so a result read
before a restock cannot swallow the webhook that announced it. The opposite race is also covered: an
in-stock read that a recorded sell-out overtook queues nobody.

**Requests racing a restock.** `createRequest` enqueues a check in the same transaction. A customer
who signs up just after the restock webhook, or for an item already in stock, still gets the email.

**Once, not zero, not twice.**
1. A request row is a single email, so at most one send can be in progress per request.
2. Claiming is an atomic update setting a lease, so two workers cannot hold the same row.
3. `send_in_flight` is committed *before* the HTTP call (write-ahead) and cleared once the outcome
   is recorded. A row found with it set after a crash had an unknown outcome and gets the sticky
   `ambiguous_send` flag, as does a timeout. A later refusal never clears that flag, because it says
   nothing about the earlier attempt.
4. Every attempt uses `Idempotency-Key: back-in-stock/<request id>`, stable across retries and
   restarts, so a retry of a send that actually succeeded is deduplicated by the provider.
5. The snapshot and rendering are frozen once a send is attempted, because providers reject a reused
   key with a different payload.
6. Retries stop at 23h, inside the provider's 24h key window. Past that the row is `failed`, visible
   in admin, rather than risking a duplicate unattended.

**Stale restocks.** If stock was verified over 60s ago (a long retry, or a restart), or a sell-out has
been recorded since, the worker checks again before sending. If it sold out and no earlier attempt could have been delivered, the request
returns to `open` for the next restock. If the outcome of an earlier attempt is unknown, sending
continues, since the key makes it safe and the customer may already have the email. If the stock API
is down at this point, sending continues on the earlier verification.

**Restarts.** All state above is in SQLite. At startup, leases are released and the reconciler runs.
SIGTERM stops claiming, waits for in-flight calls and closes the database. SIGKILL is covered by the
write-ahead flag and the idempotency key.

## Email failure classification

| Result | Meaning | Action |
| --- | --- | --- |
| 2xx | Accepted | `notified` |
| 400, 422 and other 4xx not listed below | Will never succeed | `failed` |
| 408 | Timed out at the provider, may have been accepted | retry, `ambiguous_send` set |
| 425 | Too early | retry, definite refusal |
| 401, 403, 404, 405 | Probably a config or proxy problem an operator can fix | retry, definite refusal |
| 409, 429 | Concurrent key use or rate limit | retry, definite refusal, honour `Retry-After` |
| 502, 504 | A gateway may have forwarded it | retry, `ambiguous_send` set |
| Other 5xx | Refused | retry, definite refusal, honour `Retry-After` (capped at 1h) |
| Timeout, connection error | May have been accepted | retry, `ambiguous_send` stays set |

## Security

- Webhook secret and admin password are compared in constant time over SHA-256 digests.
- `/admin` accepts HTTP Basic (any username) or a signed, expiring, `HttpOnly`, `SameSite=Strict`
  session cookie from the login page. Admin POSTs also check `Origin`. Login failures are throttled.
- New sign-ups are limited per client IP, and reconciler re-checks run after any check a customer or
  webhook is waiting on, so junk SKUs can't delay real ones. Behind a proxy, `TRUST_PROXY` gives the
  throttles the real client IP. It stays off by default, because forwarded headers can otherwise be
  forged.
- `/embed` sets no `frame-ancestors`, so anyone can frame it; everything else is `frame-ancestors 'none'`. Pages use a
  per-response CSP nonce. `/embed` sets no cookies.
- All values in HTML are escaped. SKUs are limited to `[A-Za-z0-9._-]`, max 64 chars, and URL-encoded
  when calling the stock API. Bearer tokens are never sent across redirects.
- Logs contain request ids, never emails, secrets or query strings.
