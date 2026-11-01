# Agent Inbox: setup guide for AI agents

You're an AI agent, and your human wants you to use their Agent Inbox. It's a
web page where they see everything their agents need from them, and answer
with one click. You post to it over HTTP. Their answers go out through a
webhook to whatever runs your bots (your orchestrator), which passes each
answer to the bot that asked. You don't check the inbox for answers.

Using Grok Bot? Follow [SETUP_FOR_GROK_BOT.md](../SETUP_FOR_GROK_BOT.md)
instead.

Follow this guide from top to bottom. Keep your messages to your human short
and plain. They don't need to know how the API works.

## 0. Can you do this?

You need to be able to make HTTPS POST requests with a custom
`Authorization` header and a JSON body. If you can't, stop and tell your
human: "I can't make web requests, so I can't use Agent Inbox."

## 1. Get what you need

- **Inbox URL**, e.g. `https://agent-inbox.example.workers.dev`. Ask your
  human for it.
- **Bot token**: the `BOT_TOKEN` set when the inbox was deployed. It belongs
  in a file only your human's account can read:

  ```sh
  mkdir -p ~/.config/agent-inbox && chmod 700 ~/.config/agent-inbox
  # your human saves the token in ~/.config/agent-inbox/bot-token, then:
  chmod 600 ~/.config/agent-inbox/bot-token
  ```

  Read it inline every time, as `$(cat ~/.config/agent-inbox/bot-token)`, as the
  examples below do. If you run somewhere that can't read that file, use
  your platform's secrets setting instead.

  **Never paste the token into a chat, and never ask your human to.** Don't
  echo it, log it, or put it in a title, note or link.

  One token is shared by all your bots, and names aren't checked.
- **Bot name**: the name your human sees on your cards, e.g. `Code Bot`. Use
  the same name every time, at most 64 characters. Your orchestrator uses it
  to route answers back to you.

If there's no inbox yet, go to step 2. Otherwise skip to step 3.

## 2. If there's no inbox yet

**If you can't run shell commands:** ask your human to click the
**Deploy to Cloudflare** button at
https://github.com/helloandgoodluck/agent-inbox and follow the setup steps
in that README. It takes about five minutes. Then come back to step 1.

**If you can run shell commands** (and have Node 22+), you can deploy it
yourself. Your human needs a free Cloudflare account and an API token
(see step 2 of [SETUP_FOR_GROK_BOT.md](../SETUP_FOR_GROK_BOT.md) for the
permissions), which you hold in the `CLOUDFLARE_API_TOKEN` environment
variable. Without one, `npx wrangler login` works too: your human approves
one browser login.

```sh
git clone https://github.com/helloandgoodluck/agent-inbox ~/src/agent-inbox
cd ~/src/agent-inbox && npm ci
npm run setup -- --remote
```

The script makes the bot token and inbox secret in `~/.config/agent-inbox/`
(mode 600), creates the database, deploys, sets the secrets, saves the
inbox address to `~/.config/agent-inbox/url`, and prints a one-time passkey
link. It's safe to rerun, and on a problem it prints what to do next. A
rerun makes no new link; add `--enroll` for one. Give your human the link:
it works once, expires in 15 minutes, and sets up Face ID or Touch ID
sign-in.

For answers to reach you, your human sets `FORWARD_WEBHOOK_URL` to their
orchestrator's address, and optionally `FORWARD_SIGNING_SECRET` (Grok Bot
webhook routines can't check it, so skip it there). See
[Forward webhook](api.md#forward-webhook). If they have no orchestrator,
read [No webhook?](#no-webhook) below.

## 3. Say hello

Post one test card, with your inbox URL in place of `$INBOX` and your bot
name in place of `Code Bot`:

```sh
curl -sS -X POST "$INBOX/api/items" \
  -H "Authorization: Bearer $(cat ~/.config/agent-inbox/bot-token)" \
  -H "Content-Type: application/json" \
  -d '{"bot":"Code Bot","title":"Connected! Click Done to clear this test card.","external_key":"hello"}'
```

You should get `201` and `{"item": {...}}`. Tell your human: "I sent a test
card to your inbox. If you can see it, click Done." Then stop. Don't wait
for the click or check whether it happened.

| You got | It means |
| --- | --- |
| `401` | Wrong token. Ask your human to check the token file. |
| `503 server not configured` | The inbox's secrets are missing or under 32 characters. Your human needs to set them. |
| Can't connect, or `404` | Wrong URL. It's the `*.workers.dev` address (or a custom domain), with no path. |

## 4. Use it

There are two kinds of post. Most of what you send should be **activity**.

### Updates go to activity

`POST /api/activity` puts a line on your human's timeline. It never asks
them anything. Use it for FYIs: you started something, handed it off, or
finished it.

```sh
curl -sS -X POST "$INBOX/api/activity" \
  -H "Authorization: Bearer $(cat ~/.config/agent-inbox/bot-token)" \
  -H "Content-Type: application/json" \
  -d '{"bot":"Code Bot","text":"Opened PR #12: fix the login redirect","status":"finished"}'
```

`text` is one line, up to 500 characters. `status` is `in_progress` or
`finished`. For a long task, post `in_progress` with an `external_key` when
you start, then the same key with `finished` when you're done. The entry
moves from In progress to Finished, with no duplicate.

### Asks go to items

`POST /api/items` puts a card in **Waiting on me**. Only post one when your
human has to act: decide, approve, answer, or sign.

| Field | Required | Notes |
| --- | --- | --- |
| `bot` | yes | Your bot name. |
| `title` | yes | One line, up to 500 characters. Make it a clear question or ask. |
| `type` | no | `approval`, `yes_no`, `reply`, `sign` or `due_today`. Exactly one of these, or leave it out. |
| `note` | no | Context, up to 5000 characters. |
| `links` | no | Up to 20 `https://` URLs, as strings or `{"url": "...", "label": "..."}`. |
| `external_key` | no | Your own id for this ask. Posting the same key again updates the card instead of making a duplicate. |

Use `external_key` whenever you might send the same ask twice, e.g. after a
retry or a restart. Keep the returned `item.id`.

### Answers come back through your orchestrator

Your human clicks **Done**, **Reject** (with an optional reason), **Reply**
(with text) or **Snooze**. Each click goes out through the webhook to your
orchestrator, which routes it to you by bot name. It looks like:

```json
{ "event_id": 7, "item_id": "6f1c…", "bot": "Code Bot", "title": "…",
  "external_key": "pr-42", "action": "reply", "text": "Ship it",
  "note": null, "until": null }
```

`action` is `done`, `rejected`, `reply` or `snoozed`. A reply's text is in
`text`; a reject's reason is in `note`. `external_key` is the one you
posted the card with, or `null`. What they mean for you:

- **Done** means "seen and handled." It is not permission to merge, deploy,
  spend or delete anything. If you need a go-ahead, ask for a **Reply** and
  act on what it says.
- **Rejected** means no. Drop it, and don't ask again in different words.
- **Reply** is your answer. Act on it.
- **Snoozed** means "later." Your human sees the card again when it wakes.
  Don't re-post it.

### Close an ask yourself

If an ask stops mattering (you found the answer, or the moment passed),
close it with `POST /api/items/<id>/done`. A `409` means your human already
rejected it, so drop it.

### No webhook?

If your human has no orchestrator, nothing pushes answers to you. Catch up
once when you resume work, not on a timer:
`GET /api/events?since=<cursor>` lists answers oldest first. Start without
`since`, act only on events where `bot` is your name, and save the
`next_cursor` it returns to resume from next time.

## 5. Good manners

- **Post at handoffs, finishes and decisions. Nothing else.** No posting on
  a timer, no heartbeats, no "still working", and nothing when nothing
  changed.
- **Don't poll.** Don't loop on the inbox waiting for a click. Answers come
  to you.
- **Ask only when you need a human.** Every card is an interruption. Batch
  small questions into one card, and put FYIs in activity.
- **One clear ask per card.** The question goes in the title, the context
  in the note.
- **Never send secrets** (passwords, tokens, keys) in a title, note or link.
- **Test without bothering anyone:** add `"test": true` to any item or
  activity and it stays hidden from the page. Or start the title or text
  with `[TEST]`. To see test items, open the page with `?include_test=1` on
  the end of its address.
- If you get `429`, you've hit a daily cap (2000 new items or 5000 activity
  entries a day, across all bots). Stop and tell your human.

## Remember this

Save something like this in your instructions, so you keep using the inbox
in future sessions:

> I post updates (handoffs, finishes) to my Agent Inbox at
> `$INBOX/api/activity`, and asks that need my human to
> `$INBOX/api/items`, as bot `Code Bot`, with the token from
> `~/.config/agent-inbox/bot-token`. I never paste the token anywhere. Answers come
> back through my orchestrator; Done means seen, not permission. I don't
> poll and don't post when nothing changed. Full guide:
> https://github.com/helloandgoodluck/agent-inbox/blob/main/docs/agent-setup.md

The full API reference is in [api.md](api.md).
