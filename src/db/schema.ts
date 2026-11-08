// Ordered, append-only migrations. Applied by src/db/database.ts inside a transaction, tracked with
// PRAGMA user_version. Never edit a shipped migration; add a new one.

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE requests (
    id               TEXT PRIMARY KEY,
    email            TEXT NOT NULL,
    sku              TEXT NOT NULL,
    sku_key          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'queued', 'sending', 'notified', 'failed')),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    product_json     TEXT,
    verified_at      TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    first_attempt_at TEXT,
    next_attempt_at  TEXT,
    lease_until      TEXT,
    send_in_flight   INTEGER NOT NULL DEFAULT 0 CHECK (send_in_flight IN (0, 1)),
    ambiguous_send   INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous_send IN (0, 1)),
    last_error       TEXT,
    provider_id      TEXT,
    notified_at      TEXT,
    CHECK ((status = 'notified') = (notified_at IS NOT NULL))
  ) STRICT;

  -- The guarantee behind "no duplicate open requests": concurrent inserts cannot both win.
  CREATE UNIQUE INDEX requests_one_open_per_customer_sku
    ON requests (email, sku_key)
    WHERE status IN ('open', 'queued', 'sending');

  CREATE INDEX requests_by_sku_status ON requests (sku_key, status);
  CREATE INDEX requests_due ON requests (status, next_attempt_at);
  CREATE INDEX requests_by_created ON requests (created_at DESC);

  -- The primary key is the guarantee behind webhook idempotency.
  CREATE TABLE webhook_events (
    event_id          TEXT PRIMARY KEY,
    sku               TEXT NOT NULL,
    sku_key           TEXT NOT NULL,
    quantity          INTEGER NOT NULL,
    received_at       TEXT NOT NULL,
    processed_at      TEXT,
    verified_quantity INTEGER,
    outcome           TEXT NOT NULL DEFAULT 'pending'
                      CHECK (outcome IN ('pending', 'in_stock', 'out_of_stock', 'skipped'))
  ) STRICT;

  CREATE INDEX webhook_events_pending ON webhook_events (sku_key, outcome);
  CREATE INDEX webhook_events_by_received ON webhook_events (received_at DESC);

  -- One durable, coalesced stock check per SKU.
  CREATE TABLE stock_checks (
    sku_key     TEXT PRIMARY KEY,
    query_sku   TEXT NOT NULL,
    generation  INTEGER NOT NULL DEFAULT 1,
    due_at      TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    lease_until TEXT,
    last_error  TEXT
  ) STRICT;

  CREATE INDEX stock_checks_due ON stock_checks (due_at);
  `,
];
