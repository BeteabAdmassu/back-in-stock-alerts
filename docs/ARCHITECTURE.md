# Architecture

A single Node process with an embedded SQLite database. The brief requires `docker run` with six env
vars and nothing else, which rules out a separate database server. SQLite in WAL mode with
`synchronous=FULL` gives durable, serialised transactions, and running one process makes the
concurrency model easy to reason about.

```
 store iframe ─ GET /embed ─┐
 POST /api/requests ────────┼─► services ─► Store (SQLite: requests, webhook_events, stock_checks)
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
| `src/workers/` | Poller, stock-check worker, email worker, reconciler | contracts |
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
`failed`, which is what supports future restock cycles.

## How each guarantee is met

**No duplicate open requests.** A partial unique index on `(email, sku_key)` covering `open`,
`queued` and `sending`. Emails are trimmed and lower-cased, SKUs are matched case-insensitively.

**Webhook idempotency.** `event_id` is the primary key, and the event insert and its stock-check
enqueue share a transaction. A retry or simultaneous duplicate loses at the constraint and gets a
2xx. The ack only happens after commit, so an acknowledged event cannot be lost.

**Not trusting the webhook.** Its `quantity` is stored for the audit trail and never read for a
decision. Every event only triggers a check against the stock API. A valid `quantity: 0` event for a
product the API says is available still notifies, because the API is the authority.

**Not trusting the network.** Stock failures are never read as "out of stock": the durable check is
retried with backoff. A reconciler re-checks every SKU with open requests each minute and on
startup, so a webhook that never arrived (including during downtime) still results in an email.

**Lost update while checking.** Enqueuing bumps `stock_checks.generation`. A check whose generation
moved on while it was in flight is released and run again rather than deleted, so a result read
before a restock cannot swallow the webhook that announced it.

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

**Stale restocks.** If stock was verified over 60s ago (a long retry, or a restart), the worker checks
again before sending. If it sold out and no earlier attempt could have been delivered, the request
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
| 400, 404, 405, 422 and other 4xx not listed below | Will never succeed | `failed` |
| 401, 403 | Probably a config problem an operator can fix | retry, definite refusal |
| 409, 429 | Concurrent key use or rate limit | retry, definite refusal, honour `Retry-After` |
| 5xx | Refused | retry, definite refusal, honour `Retry-After` |
| Timeout, connection error | May have been accepted | retry, `ambiguous_send` stays set |

## Security

- Webhook secret and admin password are compared in constant time over SHA-256 digests.
- `/admin` accepts HTTP Basic (any username) or a signed, expiring, `HttpOnly`, `SameSite=Strict`
  session cookie from the login page. Admin POSTs also check `Origin`. Login failures are throttled.
- `/embed` allows framing by anyone; everything else is `frame-ancestors 'none'`. Pages use a
  per-response CSP nonce. `/embed` sets no cookies.
- All values in HTML are escaped. SKUs are limited to `[A-Za-z0-9._-]`, max 64 chars, and URL-encoded
  when calling the stock API. Bearer tokens are never sent across redirects.
- Logs contain request ids, never emails, secrets or query strings.
