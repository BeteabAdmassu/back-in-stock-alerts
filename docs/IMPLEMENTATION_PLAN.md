# Implementation plan

The coordinator writes the contracts and schema, and later integrates the work. Each agent owns the
files listed, with its tests.

| # | Owner | Scope | Files |
| --- | --- | --- | --- |
| 0 | Coordinator | Docs, contracts, schema, tooling | `src/contracts.ts`, `src/db/schema.ts`, `docs/` |
| 1 | Database and reliability | `Store`, migrations, poller, backoff | `src/db/`, `src/workers/poller.ts`, `src/workers/backoff.ts` |
| 2 | Stock and webhook | Stock client, check worker, reconciler | `src/integrations/stock-client.ts`, `src/workers/stock-check-worker.ts`, `src/workers/reconciler.ts` |
| 3 | Email | Resend client, template, email worker | `src/integrations/email-client.ts`, `src/email/`, `src/workers/email-worker.ts` |
| 4 | Backend and API | Config, validation, routes, auth, entry point | `src/config.ts`, `src/domain/`, `src/http/` except views, `src/index.ts` |
| 5 | Frontend | Embed, login and admin views | `src/http/views/` |
| 6 | QA and review | Independent review, end-to-end tests | `test/e2e/` |
| 7 | Coordinator | Docker, harness verification, README, delivery | `Dockerfile`, `README.md` |

Step 1 runs first because the others test against the real `Store`. Steps 2 to 5 then run in
parallel, then 6. Step 7 includes running the app against the real test server through a tunnel.
