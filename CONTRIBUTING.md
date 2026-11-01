# Contributing

Issues and pull requests are welcome. For anything security-related, see [SECURITY.md](SECURITY.md) instead.

## Setup

Needs Node 22+.

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in BOT_TOKEN and INBOX_SECRET (openssl rand -hex 32)
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

## Before you open a PR

```sh
npm run typecheck
npm test          # vitest inside the Workers runtime
npm run smoke     # optional: against a running npm run dev
```

CI runs the first two on every PR.

- Add or update tests for behavior changes. `test/inbox.test.ts` covers the API, `test/passkeys.test.ts` sign-in.
- Update the docs when the API, a secret or a migration changes: `docs/api.md`, `docs/self-hosting.md`, and `docs/agent-setup.md` if it changes what agents do.

## Migrations

- Never edit a migration that has shipped. D1 records applied migrations by filename and won't rerun them, so an edit silently splits installs. Add a new numbered file instead.
- Migrations must work on an empty database (the Deploy button runs them all at once) and on one with years of rows.
- `events` is append-only: triggers block updates and deletes. Keep it that way.
- Describe each new migration in the Data section of `docs/development.md`.

## Deploying your own copy

`wrangler.jsonc` deliberately has no `database_id`. To deploy from a clone without committing yours, copy it to `wrangler.local.jsonc` (gitignored), add the id there, and use `npx wrangler deploy -c wrangler.local.jsonc` (and `-c` on `wrangler d1 migrations apply` too).
