# Development

## Local dev

```sh
cp .dev.vars.example .dev.vars        # then edit the values
npm run db:migrate:local              # wrangler d1 migrations apply DB --local
npm run dev                           # wrangler dev, http://localhost:8787
npm run smoke                         # optional: hits the running dev server
npm test                              # vitest, runs inside the Workers runtime
```

Local D1 data lives in `.wrangler/`. Delete that folder to start fresh.

For a full-looking dashboard, `npm run seed:demo -- --reset` wipes the local database and fills it with six demo bots and a few days of activity. Times are relative to now. To screenshot it while `npm run dev` is running:

```sh
npm run screenshot -- --out desktop.png                          # 1440x900
npm run screenshot -- --out phone.png --width 390 --height 844
```

`npm run check:page` drives the same headless Chrome to check the page itself. It posts a few activity entries and an item, then confirms that in-progress work shows on the In progress tab, that the Timeline merges activity with item events newest first, that the date tabs and bot filter apply, and that `[TEST]` entries stay hidden. It writes to the database, so run it against a scratch one:

```sh
npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state.check
npx wrangler dev --persist-to .wrangler/state.check
npm run check:page -- --persist-to .wrangler/state.check
```

`seed:demo` and `screenshot` take `--persist-to` too.

Headless Chrome can't use a passkey, so the screenshot script writes a 10-minute session straight into the local D1, hands Chrome the cookie over the DevTools protocol, and deletes the session afterwards. Both scripts only touch the local database: they refuse `--remote`, and the screenshot script refuses any URL that isn't localhost. Nothing in the Worker supports this, so it can't sign anyone in to a deployed inbox.
## Data

Two tables, created by `migrations/0001_init.sql`:

- `items`: one row per item, with its current status.
- `events`: append-only log of everything that happened to an item (`created`, `updated`, `done`, `rejected`, `reply`, `snoozed`, `unsnoozed`, `note`). Triggers block updates and deletes.

`migrations/0002_passkeys.sql` adds `credentials`, `enroll_tokens`, `challenges` and `sessions` for passkey sign-in. Tokens and session ids are stored only as SHA-256 hashes.

`migrations/0003_external_key.sql` adds `items.external_key`, with a unique index on (`bot`, `external_key`) for rows that have one.

`migrations/0004_event_deliveries.sql` adds `event_deliveries`, which holds webhook delivery state for each inbox action: `attempts`, `next_attempt_at`, `delivered_at` and `last_error`. It's a separate table so `events` stays append-only. Inbox events also record `actor` in their payload.

`migrations/0005_types_rejected_activity.sql` rebuilds `items` (SQLite can't alter a CHECK constraint in place) to allow the `rejected` status and add the nullable `type` column, and adds `activity`, with a unique index on (`bot`, `external_key`) for entries that have one.

`migrations/0006_test_flag_bot_names.sql` adds `is_test` to `items` and `activity` and flags existing rows whose title or text starts with `[TEST]`. It also merges bot names that differ only in case: each bot gets the casing it was first seen with. It never deletes rows, and it doesn't change `events`, which are append-only. A `created` event's payload keeps the bot name it was written with, while the timeline and webhook read the item's current name. If two rows end up with the same `bot` and `external_key`, the one updated most recently keeps the key. Each other row's key gets the suffix `#merged:<old bot name>:<row id>`. To find those rows:

```sql
SELECT * FROM items    WHERE external_key LIKE '%#merged:%';
SELECT * FROM activity WHERE external_key LIKE '%#merged:%';
```

`migrations/0007_activity_status_at.sql` adds an index on `activity` (`status`, `at`), so the dashboard's read of running work doesn't scan the whole table. It only adds an index.

`migrations/0008_write_caps.sql` adds indexes on `items.created_at` and `activity.created_at` for the [daily write caps](api.md#limits-and-the-bot-token). It only adds indexes.

`migrations/0009_deliveries_due_live.sql` narrows the retry index on `event_deliveries` to deliveries that can still be retried, so failed ones (10 attempts) aren't read by the cron every minute. It only changes an index.
