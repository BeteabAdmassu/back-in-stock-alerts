# Agent instructions

`BRIEF.md` is the source of truth for requirements. `docs/ARCHITECTURE.md` explains the design and
every guarantee. Read both before changing behaviour. `src/contracts.ts` is the shared interface.

## Commands

- `npm run check`: typecheck, lint and tests. Must pass before any commit.
- `npm run format`: apply formatting.
- `npm test`: Node's built-in test runner over `test/**/*.test.ts`.
- `node harness/server.js`: run the sandbox server locally (`DATA_DIR`, `PORT`).

## Conventions

- Node 24, TypeScript strict, ESM. Source runs directly through Node's type stripping, so use only
  erasable syntax (no `enum`, no parameter properties) and `.ts` import extensions.
- Factory functions taking collaborators, e.g. `createEmailWorker({ store, sender, clock })`. No
  classes unless state demands it, no singletons, and no `process.env` outside `src/config.ts`.
- Handle errors explicitly. Clients return result unions rather than throwing on expected failures.
- Keep dependencies minimal: Fastify is the only runtime dependency. Ask the coordinator first.

## Boundaries

- Only `src/http/` knows about HTTP requests and only `src/db/` contains SQL.
- HTTP handlers never call the stock or email API on the write path. They commit intent; workers act.
- Views are pure functions of a view model.
- Changing `src/contracts.ts` or a shipped migration needs coordinator sign-off.

## Rules that protect the guarantees

- Never treat a failed stock call as "out of stock", or let the webhook `quantity` cause an email.
  Its only effect is that `quantity: 0` records a sell-out. Only a stock API read can queue an email.
- Never send an email without the stable idempotency key, or change a payload once attempted.
- Never add a critical state that lives only in memory. Caches are fine for the catalogue.
- Never log emails, secrets, tokens or query strings.
- Uniqueness and idempotency belong in database constraints, not read-then-write checks.

## Testing

- Prefer real SQLite (temp file or `:memory:`) and real local HTTP servers over mocks. Inject `clock`
  for time. `harness/server.js` can run as a real subprocess.
- Cover failure paths, concurrency and restarts, not only success.
- Never report a test as passing without running it, and report real output.

## Git

- Focused commits, imperative subject lines. Never commit `.env`, data files or credentials.
- `master` stays working: build on a branch, review the full diff, then merge.
- Agents own the files they are assigned, and don't edit another agent's files concurrently.
- QA reviews independently: read the code and run it rather than trusting another agent's report.
