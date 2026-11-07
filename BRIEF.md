# Back-in-Stock Alerts: build challenge

Customers ask to be emailed when a sold-out item comes back. Build it, ship it, make it look good.
Use AI tools as much as you like. We expect this to take under an hour.

**Test server:** https://harness-production-e601.up.railway.app (invite code `stock-e11d21`)
Sign up there to get your keys, stock controls, a webhook sender and an inbox that catches your emails.

## Must have

- **`GET /embed`**: email + SKU form. It will live in an iframe on someone else's store.
- **`POST /api/requests`**: `{ email, sku }` as JSON. No duplicate open requests.
- **`POST /webhooks/stock`**: we send `{ event_id, sku, quantity, ... }` with an `X-Webhook-Secret` header.
- **`GET /admin`**: the requests, behind a password. Their status, and when each was notified.
- **The email**: HTML, looks good on a phone, sent in the Resend API format.

## Things we'll poke at

- Don't trust the webhook, and don't trust the network.
- Real webhook senders retry. Sometimes they send the same thing twice at once.
- Customers should hear from you once, not zero times and not twice.
- It has to survive a restart.

## Your env

```
STOCK_API_URL      GET {url}/{sku} → { quantity, in_stock }   (Bearer STOCK_API_KEY)
STOCK_API_KEY
RESEND_API_KEY
RESEND_BASE_URL    send email here, not api.resend.com
WEBHOOK_SECRET
```

## Where you have freedom

Stack, host, database, design, copy, and the customer's experience after they hit submit.
We care about the form, the admin page and the email looking like a real product, not a demo.

## Send us

- **A GitHub repo with a working `Dockerfile`**: `docker build` + `docker run` with the env vars above, and nothing else, must bring it up on `$PORT`. (A public image URL such as `ghcr.io/...` also works.)
- **A live URL** where it's already running from that same container
- A short README: env vars, how to run it, and how you stop customers getting duplicate or missed emails
- Which AI tools you used, and how long it took

No real customer data or production credentials.
