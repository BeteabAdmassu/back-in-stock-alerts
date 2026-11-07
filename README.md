# Back-in-Stock challenge: test server

The challenge brief is in **[BRIEF.md](BRIEF.md)**.

This is the sandbox server candidates build against. It provides:

- **Mock stock API**: `GET /api/stock/:sku` with `Authorization: Bearer <key>` returns `{ sku, name, price, image, quantity, in_stock }`. `GET /api/stock` lists the catalogue. Unknown SKUs return quantity 0.
- **Simulated store**: once your app URL is saved, simulated customers call `POST /api/requests` on your app, and products restock and sell out, which sends webhooks to `/webhooks/stock`. Some webhooks are delivered twice, and some claim a restock that the stock API doesn't confirm.
- **Mock Resend API**: `POST /emails` (and `/emails/batch`) in Resend's request and response format. Emails land in your dashboard inbox. `Idempotency-Key` is honoured.
- **Dashboard** (`/c/<token>` after sign-up): your env vars, set stock, fire webhooks at your app, make the next N emails fail with HTTP 500, view sent emails, and see your app's stock API calls.

## Run locally

```
node harness/server.js   # http://localhost:3000, Node 18+
```

Env: `PORT`, `PUBLIC_URL`, `DATA_DIR`, `INVITE_CODE` (optional), `ADMIN_PASSWORD` (enables `/admin`), `SIM_INTERVAL_SECONDS` (default 30).
No dependencies. State is kept in `DATA_DIR/db.json`.
