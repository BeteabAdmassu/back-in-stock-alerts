# Back-in-Stock Alerts

Customers ask to be emailed when a sold-out item returns. This service gives a store an embeddable
sign-up form, takes stock webhooks without trusting them, and emails each customer once. It also has a
password-protected admin page showing every request and when it was notified.

**Live:** <https://back-in-stock.b7labs.tech/embed> (admin at
<https://back-in-stock.b7labs.tech/admin>, password protected)

The challenge brief is in [BRIEF.md](BRIEF.md). The full design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

```sh
docker build -t back-in-stock-alerts .
docker run -p 3000:3000 \
  -e STOCK_API_URL -e STOCK_API_KEY -e RESEND_API_KEY -e RESEND_BASE_URL \
  -e WEBHOOK_SECRET -e ADMIN_PASSWORD \
  back-in-stock-alerts
```

Then open <http://localhost:3000/embed> and <http://localhost:3000/admin>. The app listens on `$PORT`
(default 3000).

State lives in SQLite under `/data`, which survives `docker restart`. To keep it when the container
is replaced, add a named volume: `-v back-in-stock-data:/data`.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `STOCK_API_URL` | yes | Stock API base: `GET {url}/{sku}` and `GET {url}` |
| `STOCK_API_KEY` | yes | Bearer token for the stock API |
| `RESEND_API_KEY` | yes | Bearer token for the email API |
| `RESEND_BASE_URL` | yes | Email API base; the app posts to `{url}/emails` |
| `WEBHOOK_SECRET` | yes | Expected `X-Webhook-Secret` value |
| `ADMIN_PASSWORD` | yes | Protects `/admin` |
| `PORT` | no | Listen port, default 3000 |
| `DATA_DIR` | no | Database directory, `/data` in Docker, otherwise `./data` |
| `EMAIL_FROM` | no | Sender, default `Back in Stock <onboarding@resend.dev>` |
| `PRODUCT_URL_TEMPLATE` | no | e.g. `https://shop.example/p/{sku}`. Adds a "Shop now" button to the email |
| `LOG_LEVEL` | no | Default `info` |
| `TRUST_PROXY` | no | Number of reverse proxies in front of the app, so throttles see real client IPs. Default 0 |

### Local development

Requires Node 24.

```sh
npm install
cp .env.example .env    # then fill it in
npm run dev
npm run check           # typecheck, lint, tests
```

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /embed` | The form, safe to frame anywhere. `?sku=ABC-1` fixes the SKU and shows the product |
| `POST /api/requests` | `{ email, sku }`. 201 when created, 200 with `duplicate: true` if already open, 400 if invalid, 429 past 600 new requests a minute from one IP |
| `POST /webhooks/stock` | `{ event_id, sku, quantity }` with `X-Webhook-Secret`. 200 once durably stored, 401 for a bad secret, 400 for a bad payload |
| `GET /admin` | Requests, status, notified time, search, filters and recent webhooks. Log in on the page, or use HTTP Basic with any username |
| `GET /healthz` | Liveness and database check |

Embedding, with optional auto-resize:

```html
<iframe id="bis" src="https://your-app.example/embed?sku=ABC-1" title="Back in stock alert"
  width="100%" height="320" frameborder="0"></iframe>
<script>
  addEventListener('message', (e) => {
    if (e.data?.type === 'back-in-stock:resize') {
      document.getElementById('bis').height = e.data.height;
    }
  });
</script>
```

## How customers get one email, not zero and not two

HTTP handlers only validate and commit intent to SQLite. Background workers make every call to the
stock and email APIs, and all their state is in the database.

**Never two**
- A partial unique index allows one open request per customer and SKU, however many arrive at once.
- `event_id` is a primary key, so a retried or simultaneous duplicate webhook does nothing further.
- Each request is one row and one email. Claiming it for sending is atomic and held under a lease.
- Every send carries `Idempotency-Key: back-in-stock/<request id>`, unchanged across retries and
  restarts. The app commits a "send in flight" marker before each HTTP call. If it dies mid-send, it
  knows the outcome is unknown and retries with the same key, and the provider deduplicates.
- Retries stop after 23 hours, inside the provider's 24-hour key window. Past that the request shows
  as `failed` in admin rather than risking a duplicate unattended.

**Never zero**
- A webhook is acknowledged only after it is committed, along with a durable stock check.
- A failed stock call is never read as "out of stock". The check retries with backoff.
- Email failures retry with backoff, honouring `Retry-After`.
- A reconciler re-checks every SKU with open requests each minute and at startup, so a webhook that
  never arrived, or arrived during downtime, still leads to an email.
- A new sign-up triggers its own stock check, so someone who signs up just after a restock, or for an
  item already in stock, is still emailed.
- A check that was running when a new webhook arrived runs again, so a stale result can't swallow a
  restock.

**Not misled**
- A webhook's `quantity` can never cause an email. Only the stock API is believed, so a phantom
  restock sends nothing.
- Stock is re-checked before sending if the last check is over 60 seconds old, or a sell-out has been
  reported since. If the item sold out and no earlier attempt could have been delivered, the request
  goes back to waiting for the next restock.

After a request is notified, the customer can ask again for the next restock. Repeating the request
while the item is still in stock sends nothing further: the new request waits until a sell-out is
known, or 24 hours, whichever comes first. Sell-outs are recorded per SKU even with nobody waiting,
from an out-of-stock read or a `quantity: 0` webhook, so someone asking again after a new restock is
emailed straight away.

## Known limitations

- **One instance.** SQLite means a single process, which is what `docker run` with no database
  server requires. Scaling out would mean moving to Postgres; the `Store` interface is the seam.
- **The data needs a disk that outlives the container.** A replaced container without a named volume
  starts empty.
- **Delivery means the provider accepted the email.** Bounces and later delivery failures aren't
  tracked, as the brief's API has no webhook for them.
- **Very long outages.** If email keeps failing for 23 hours the request becomes `failed`. Admin can
  retry it, which could duplicate if an earlier attempt was secretly delivered; the page warns when
  that is possible. If the customer asks again after such a failure, the new request waits for a
  sell-out or 24 hours, since the first email may have arrived.
- **A false `quantity: 0` webhook.** It can't send anything to someone waiting for the first time. But
  if a customer already emailed asks again while the item is in stock, a false or late sell-out from
  a sender with the secret leads to a second email. The alternative was missing real restocks.
- **Changing config during a retry.** Altering `EMAIL_FROM` or `PRODUCT_URL_TEMPLATE`, or deploying a
  new template while a send is being retried, changes the payload under the same key, which a
  provider may refuse.
- **Everyone waiting is notified.** A restock of 3 units still emails all 50 people waiting.
- **Sign-up abuse.** New requests are limited to 600 a minute per IP, and there is no confirmation
  step, so someone could sign up another person's address, or use many IPs. Harm to the address is
  limited to one email per product, per restock or per 24 hours. Requests for SKUs that never restock
  stay open and get re-checked every minute; these re-checks run behind real customers' checks, but a
  sustained flood would slow the catch-up for missed webhooks and load the stock API.
- **Set `TRUST_PROXY` behind a proxy.** Throttles work per client IP, and forwarded headers are only
  believed when it is set. Without it all visitors share the proxy's IP, so anyone's repeated bad
  guesses can lock everyone out of password login, for as long as they keep guessing. Existing
  sessions keep working.
- **Sign-out doesn't revoke the session.** Sessions are signed, stateless cookies, so a cookie copied
  before signing out stays valid until it expires, up to 12 hours later.
- **A duplicate request reveals that someone is waiting.** `POST /api/requests` tells an anonymous
  caller an address already has an open request for that SKU. The form needs this to say "You're
  already on the list", so it is a deliberate trade-off.
- **A sell-out nobody reports.** If an item sells out with no request open and no `quantity: 0`
  webhook, nothing records it, so a customer asking again after the restock waits up to 24 hours.
- **Embed theme.** The form follows the visitor's OS light or dark setting, so a dark-mode visitor
  sees a dark card on a light store. There is no option yet to pin it to the store's theme.
- **Default email has no link.** Without `PRODUCT_URL_TEMPLATE` the email has no "Shop now" button and
  asks the customer to head back to the store. The stock API has no product URLs, and taking one from
  the sign-up request would let anyone put a phishing link in an email.
- **Node's `node:sqlite`** is newer than the established native drivers. It was chosen to avoid
  native builds, and it sits behind the `Store` interface if it ever needs replacing.

## Technology

Node 24, TypeScript in strict mode, Fastify, built-in `node:sqlite`, plain server-rendered HTML with
a little vanilla JavaScript. Fastify is the only runtime dependency.

## Testing

```sh
npm test    # unit and integration tests: real SQLite, real local HTTP servers, the real harness
```

`test/e2e/harness.e2e.mjs` runs scenarios against a running container and a real harness, including
SIGKILL restarts. Set `APP_URL`, `DASHBOARD_URL`, `WEBHOOK_SECRET`, `ADMIN_PASSWORD` and
`APP_CONTAINER`, plus `HARNESS_CONTAINER` to include the outage scenario.

`test/e2e/browser.e2e.mjs` drives login, Retry, Sign out and the embed in real headless Chrome,
including inside a cross-origin iframe.

To run the test server yourself: `node harness/server.js`, or `docker build -t bis-harness harness`.
The original harness notes:

- **Mock stock API**: `GET /api/stock/:sku` with `Authorization: Bearer <key>`. Unknown SKUs return
  quantity 0.
- **Simulated store**: once your app URL is saved, it sends customer requests and webhooks, some
  delivered twice and some claiming restocks the stock API doesn't confirm.
- **Mock Resend API**: `POST /emails`, honouring `Idempotency-Key`.
- **Dashboard** (`/c/<token>` after sign-up): env vars, set stock, fire webhooks, inject email
  failures, and view sent emails.
- **Env**: `PORT`, `PUBLIC_URL`, `DATA_DIR`, `INVITE_CODE`, `ADMIN_PASSWORD`, `SIM_INTERVAL_SECONDS`.
