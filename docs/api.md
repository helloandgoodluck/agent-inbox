# API reference

All bodies are JSON. Errors look like `{"error": "..."}` with a 4xx/5xx status. Missing or wrong auth returns 401.

## Bots (`Authorization: Bearer <BOT_TOKEN>`)

**`POST /api/items`** creates an item. Returns `201 {"item": {...}}`.

```json
{
  "bot": "deploy-bot",
  "title": "Approve the production deploy",
  "note": "Optional detail, up to 5000 chars",
  "links": ["https://github.com/you/repo/pull/12", { "url": "https://example.com", "label": "Logs" }],
  "type": "approval",
  "status": "waiting"
}
```

`bot` and `title` are required. `status` is `waiting` (default) or `done` for an FYI. Links must be http(s).

**Bot names** are matched without regard to case. Names listed in the optional `CANONICAL_BOTS` variable (comma-separated, e.g. `Deploy Bot,QA`) are always stored with that exact spelling, so with that list `"bot": "deploy bot"` is stored as `Deploy Bot`. Any other bot keeps the casing it was first seen with: if `Side-Project` posted first, a later `SIDE-PROJECT` is stored as `Side-Project`. `external_key` matching uses the stored name, so a re-post in another casing still updates the same item.

**Test data.** Send `"test": true`, or start the `title` with `[TEST]` (exactly that, in capitals), and the item is flagged `is_test: true`. Test items, and the events on them, are left out of every list (`GET /api/items`, `/api/events`, `/api/activity`, `/api/inbox/items`, `/api/inbox/events`) unless you add `?include_test=1`, and the page doesn't show them. Open the page as `/?include_test=1` to see them there. Once an item is flagged, it stays flagged. A re-post or PATCH can set the flag but can't clear it. `GET /api/items/:id` still returns a test item, and inbox actions on one are still forwarded. `test` must be a boolean. Activity entries work the same way, using `text` in place of `title`.

`type` is optional and says what kind of answer you need. It must be exactly one of these slugs, or `null`/missing for none. Anything else (including the display label) returns 400.

| `type` | Shown as |
| --- | --- |
| `approval` | Approval |
| `yes_no` | Yes/no |
| `reply` | Reply |
| `sign` | Sign |
| `due_today` | Due today |

Add `"external_key": "<your own id>"` (a non-empty string, up to 200 chars) to make the POST idempotent. Keys are unique per `bot`. If that `bot` + `external_key` already exists, the POST updates the item's `title`, `note`, `links` and `type` to the values sent (a missing `note`, `links` or `type` clears it), logs an `updated` event and returns `200` with the same `id`. `status` is only used when the item is created, so a re-post never reopens an item you closed. A re-post that changes nothing doesn't log an event or touch `updated_at`.

**`GET /api/items`** lists items so a bot can reconcile. Returns `200 {"items": [...]}`, newest `updated_at` first, at most 500. Each item has a `latest_event` field: its most recent event, or `null`.

| Query | Default | Meaning |
| --- | --- | --- |
| `view` | `waiting` | `waiting`, `snoozed`, `done`, `rejected` or `all`. Any other value returns 400. |
| `bot` | | Only items whose `bot` is this, in any casing. |
| `since` | | Only items with `updated_at` at or after this ISO 8601 date, e.g. `2026-10-27` or `2026-10-27T09:00:00Z`. An invalid date returns 400. |
| `include_test` | | `1` to include [test items](#bots-authorization-bearer-bot_token). |

**`PATCH /api/items/:id`** updates any of `title`, `note`, `links`, `type` and `test`, validated the same way as POST. `"note": null` clears the note and `"type": null` clears the type. Any other field (including `status`), or an empty body, returns 400. An unknown id returns 404. Returns `200 {"item": {...}}` and logs an `updated` event if anything changed.

**`POST /api/items/:id/done`** marks a waiting or snoozed item done. Optional body `{"note": "..."}`. On an item that's already done it's a no-op: `200` with the item, and no new event, so a bot can safely retry. On an item you rejected it's `409 {"error": "item is already rejected", "item": {...}}` and nothing changes: your decision stands.

**`GET /api/items/:id`** returns `{"item", "events"}`. Answers normally reach bots through the [forward webhook](#forward-webhook); this is a fallback for checking one item.

**`GET /api/events?since=<cursor>&limit=<n>`** lists your inbox actions (the same ones sent to the [forward webhook](#forward-webhook)) in ascending `event_id` order. Use it to catch up on anything the webhook missed. Start with no `since` (or `since=0`), then pass back `next_cursor` each time. `limit` is 1 to 100 (default 100). If nothing is new, you get `next_cursor` back unchanged, so you can resume from it next time.

```json
{
  "events": [
    {
      "event_id": 7, "item_id": "6f1c…", "bot": "deploy-bot", "title": "…", "external_key": null, "action": "reply",
      "note": null, "text": "Ship it", "until": null, "actor": "passkey", "at": "2026-10-27T09:00:00.000Z",
      "delivery": { "status": "delivered", "attempts": 1, "delivered_at": "…", "last_error": null }
    }
  ],
  "next_cursor": "7",
  "has_more": false
}
```

`delivery.status` is `pending` (not sent yet, or waiting to retry), `delivered`, or `failed` (gave up after 10 attempts). Bot actions such as `POST /api/items/:id/done` are not included.

Bots can't snooze, reject or delete items. There's no bot route for any of them, and the bot token gets 401 on the inbox routes below, even if `INBOX_SECRET` is set to the same value.

An item looks like:

```json
{
  "id": "6f1c…",
  "bot": "deploy-bot",
  "title": "Approve the production deploy",
  "status": "waiting",
  "type": "approval",
  "note": null,
  "links": [{ "url": "https://github.com/you/repo/pull/12" }],
  "snooze_until": null,
  "external_key": null,
  "is_test": false,
  "created_at": "2026-10-26T23:46:17.555Z",
  "updated_at": "2026-10-26T23:46:17.555Z"
}
```

## Activity (what bots are doing)

Items are things that need you. Activity is everything else a bot wants on the timeline: what it's working on, and what it finished.

**`POST /api/activity`** (`BOT_TOKEN`) logs an entry. Returns `201 {"activity": {...}}`.

```json
{
  "bot": "deploy-bot",
  "text": "Running the test suite",
  "status": "in_progress",
  "external_key": "ci-4812",
  "at": "2026-10-27T09:00:00Z"
}
```

`bot`, `text` (up to 500 chars) and `status` (`in_progress` or `finished`) are required. `at` is optional, an ISO 8601 time no more than a day ahead. Without it the entry is stamped now. `test` and a `[TEST]` prefix on `text` flag the entry as test data, as for items.

With an `external_key`, the POST is idempotent per `bot`: posting the same `bot` + `external_key` again updates that entry's `text`, `status` and `at`, and returns `200` with the same `id`. Post `in_progress` when you start and `finished` with the same key when you're done, and the entry moves from In progress to Finished. If you don't send `at`, it's restamped to now when the status changes and kept otherwise.

**`GET /api/activity?since=&bot=&include_test=`** lists entries, newest `at` first, at most 500. `since` (ISO 8601, compared with `at`), `bot` and `include_test` work like they do on `GET /api/items`. It accepts `BOT_TOKEN`, or inbox auth (the page uses it with your passkey session).

```json
{
  "activity": [
    {
      "id": "0b6e…", "bot": "deploy-bot", "text": "Tests passed", "status": "finished",
      "external_key": "ci-4812", "is_test": false, "at": "2026-10-27T09:04:10.000Z",
      "created_at": "2026-10-27T09:00:00.000Z", "updated_at": "2026-10-27T09:04:10.000Z"
    }
  ]
}
```

## Inbox (passkey session cookie, or `Authorization: Bearer <INBOX_SECRET>`)

The page uses these. You can too, with the inbox secret. The GET routes leave out test items unless you pass `include_test=1`, and `bot` matches in any casing.

- `GET /api/inbox/dashboard`: everything the page shows, as `{"since", "waiting", "snoozed", "done", "rejected", "activity", "events"}`, read in one D1 batch. It covers the last 7 days (`since`), and every list has a cap. `waiting` and `snoozed` are complete, up to 500 each. `done` and `rejected` are items closed in the window, at most 100 each. `activity` is the window's entries, at most 200, plus up to 50 `in_progress` entries of any age, newest `at` first. `events` is the window's timeline events (`created`, `done`, `rejected`, `reply`, `note`, `snoozed`), at most 200, newest first, each with the item's `bot`, `title` and `item_type`.
- `GET /api/inbox/items?view=waiting|done|snoozed|rejected|all`
- `GET /api/inbox/events?since=&bot=`: every event on every item since `since` (default: the last 14 days), newest first, at most 1000. Each has the item's `bot`, `title` and `item_type`.
- `POST /api/inbox/items/:id/done`: waiting or snoozed items only
- `POST /api/inbox/items/:id/reject`, optionally with `{"note": "why"}`: sets the status to `rejected`. Waiting or snoozed items only.
- `POST /api/inbox/items/:id/reply` with `{"text": "..."}`: your answer to the bot. Works on any item and never changes its status.
- `POST /api/inbox/items/:id/snooze` with `{"minutes": 60}` or `{"until": "2026-11-01T09:00:00Z"}` (up to a year): waiting items only
- `POST /api/inbox/items/:id/note` with `{"note": "..."}`: the older form of reply, kept for API users, with the same rules. The page uses `reply`.

Each action returns `{"item", "event", "forwarded"}`, where `forwarded` is `queued` (being sent in the background) or `skipped` (no webhook set, so it stays pending). A failed forward doesn't undo the action.

**Which actions apply.** Done and Reject close a waiting or snoozed item; a closed item (`done` or `rejected`) stays closed. Snooze applies only to a waiting item, so a snoozed one can't be re-snoozed until it wakes (a snooze that's already due counts as waiting). Anything else returns `409 {"error": "item is already done", "item": {...}}` with the item as it now stands, and records nothing: no event, no delivery, no webhook call. The check is part of the write, so two clicks racing on one item can't both land. Reply works on any item, closed ones included, as a note that leaves the status alone: telling a bot something after the fact is still useful context.

On the page, only waiting items get cards, and a card shows all four actions, which all apply to it. Closed items in the Done tab are a compact list without actions; to reply to one, use the `reply` route. If a card is stale (a bot closed the item since the page loaded), the click gets a 409, the page moves the card to where the item now is and says so, without reloading.

An item's `status` is `waiting`, `snoozed`, `done` or `rejected`. Snoozed items aren't in Waiting. They move back once `snooze_until` passes. This happens when the inbox is next loaded, so there's no cron to set up.

**D1 reads.** The page makes one request, `GET /api/inbox/dashboard`, when it opens and again when you tap the refresh button in the header. It never polls, and it doesn't reload when you switch back to the tab, so a page left open costs nothing. Done, Reject, Reply and Snooze update the page from the action's own response. Every dashboard query uses an index and stops at its cap, so a load reads about as many rows as it returns. To see the count, run `npx wrangler dev --var DEBUG_ROWS:1`: each load logs `dashboard rows_read=N` with a breakdown by query.

## Forward webhook

Each inbox action is saved as an event together with a pending delivery. If `FORWARD_WEBHOOK_URL` is set, it's POSTed right away (after the response, so clicks stay fast):

```json
{
  "event_id": 7,
  "item_id": "6f1c…",
  "bot": "deploy-bot",
  "title": "Approve the production deploy",
  "external_key": "deploy-1234",
  "action": "reply",
  "note": null,
  "text": "Ship it",
  "until": null,
  "actor": "passkey",
  "at": "2026-10-27T09:00:00.000Z"
}
```

`action` is one of:

| `action` | Set when | Extra field |
| --- | --- | --- |
| `done` | you clicked Done | |
| `rejected` | you clicked Reject | `note`: your reason, or `null` |
| `reply` | you sent a reply | `text`: your reply |
| `snoozed` | you snoozed it | `until`: the ISO time it wakes |
| `note` | a reply sent with the older `/note` route | `note`: your reply |

Fields that don't apply are `null`. (`text` was added along with `rejected` and `reply`. Older receivers that ignore unknown fields keep working.) `actor` is `passkey` or `inbox_secret`, depending on how you were signed in. Use `bot` to route it to the right bot. `title` is the item's current title. `external_key` is the one the bot posted the item with, or `null`.

**Retries.** Any 2xx response marks the event delivered. Anything else (or no answer within 5 s) is retried by a cron trigger that runs every minute, with exponential backoff: 1, 2, 4 … 256 minutes after each failed attempt. After 10 attempts (about 8.5 hours) it stops and the event shows as `failed` in `GET /api/events`. If `FORWARD_WEBHOOK_URL` is unset, events stay pending and aren't tried or counted. Once you set it, the cron sends the backlog, oldest first.

Delivery is at least once and usually in order, but a retry can arrive after a newer event. Deduplicate on `event_id`, and use `at` for ordering.

**Signature and sender key.** Two separate, optional secrets:

```
Authorization: Bearer <FORWARD_WEBHOOK_KEY>   (if set; for receivers that check a sender key)
X-Agent-Inbox-Signature: sha256=<hex HMAC-SHA256 of the raw request body, keyed with FORWARD_SIGNING_SECRET>   (if set)
```

The Bearer key travels with every request, so anyone who can read requests at the receiver has it. That's why it isn't the signing key: the signing secret is never sent, so only the inbox can produce a valid signature. Keep the two values different. If `FORWARD_SIGNING_SECRET` equals `FORWARD_WEBHOOK_KEY`, the Worker logs an error and sends no signature. Without `FORWARD_SIGNING_SECRET` there's no signature header; the Bearer header is still sent if `FORWARD_WEBHOOK_KEY` is set.

Upgrading from a version that signed with `FORWARD_WEBHOOK_KEY`: set `FORWARD_SIGNING_SECRET` to a new value (`openssl rand -hex 32`) and give the receiver that value to verify with. Until you do, requests arrive unsigned.

Verify the signature against the exact bytes you received, before parsing the JSON. In Node:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, key) {
  const want = "sha256=" + createHmac("sha256", key).update(rawBody).digest("hex");
  return typeof header === "string" && header.length === want.length &&
    timingSafeEqual(Buffer.from(header), Buffer.from(want));
}
// verify(raw, req.headers["x-agent-inbox-signature"], process.env.FORWARD_SIGNING_SECRET)
```

Or from a shell: `printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$FORWARD_SIGNING_SECRET"`.

## Limits and the bot token

There is one `BOT_TOKEN`, shared by every bot. Anything holding it can read every item, every reply you've sent any bot (`GET /api/events`), and every activity entry, and can edit or close any bot's items. It can't snooze, reject, reply or delete. Give it only to bots you'd trust with all of that.

To keep a leaked token from filling the database, the bot API refuses writes past these caps with `429` and stores nothing:

| Cap | Limit |
| --- | --- |
| New items, all bots together | 2000 per rolling 24 hours (re-posts with an existing `external_key` still update) |
| New activity entries, all bots together | 5000 per rolling 24 hours |
| Bot updates to one item (PATCH or re-post) | until the item has 1000 events |

If a token leaks, rotate it first (`npx wrangler secret put BOT_TOKEN`), then delete what it wrote. `events` is append-only, so the cleanup lifts that trigger and puts it back. Save this as `cleanup.sql`, set the bot name, and run `npx wrangler d1 execute agent-inbox --remote --file cleanup.sql`:

```sql
DROP TRIGGER events_no_delete;
DELETE FROM event_deliveries WHERE event_id IN (
  SELECT e.id FROM events e JOIN items i ON i.id = e.item_id WHERE i.bot = 'spam-bot');
DELETE FROM events WHERE item_id IN (SELECT id FROM items WHERE bot = 'spam-bot');
DELETE FROM items WHERE bot = 'spam-bot';
DELETE FROM activity WHERE bot = 'spam-bot';
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
```
