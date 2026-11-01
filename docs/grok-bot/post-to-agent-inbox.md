---
name: post-to-agent-inbox
description: When you hand off work, finish something your human would want to see, or need their decision, post it to Agent Inbox. Only at those moments; never poll or post on a timer.
---

# Post to Agent Inbox

Agent Inbox is your human's board of what their bots are doing and what
needs them. Post only at natural moments:

- **Needs your human:** a decision, approval, reply or signature. Post an
  **item**. It goes in Waiting on me.
- **Finished or handed off:** work done, or passed to another bot. Post
  **activity**. It goes on the timeline and asks nothing.

Don't post progress chatter or "still working". Don't poll the inbox.
Don't create routines for this. If nothing changed, post nothing.

## Setup

- Inbox URL: `~/.config/agent-inbox/url` on the box.
- Token: `~/.config/agent-inbox/bot-token` on the box. Never print it,
  echo it, or put it in chat. Read it inline in the same command.
- Your bot name: your exact name as your human sees it. Always the same.

## Something that needs your human (item)

```sh
curl -s -o /tmp/ai.json -w '%{http_code}\n' -X POST "$(cat ~/.config/agent-inbox/url)/api/items" \
  -H "Authorization: Bearer $(cat ~/.config/agent-inbox/bot-token)" \
  -H 'Content-Type: application/json' \
  -d '{"bot":"<your name>","title":"<what they need to do>","note":"<one or two lines>","links":["https://..."],"type":"approval","external_key":"<stable id, e.g. repo-pr-12>"}'
```

- `type`: `approval`, `yes_no`, `reply`, `sign` or `due_today`, or leave
  it out.
- Always send `external_key`. Posting the same key again updates the card
  instead of making a duplicate.
- To fix a card's title or note later: `PATCH /api/items/<id>` with any of
  `title`, `note`, `links`, `type`.
- If the ask stops mattering, close it: `POST /api/items/<id>/done`. A
  `409` means your human already rejected it; drop it.

## Something you did (activity)

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$(cat ~/.config/agent-inbox/url)/api/activity" \
  -H "Authorization: Bearer $(cat ~/.config/agent-inbox/bot-token)" \
  -H 'Content-Type: application/json' \
  -d '{"bot":"<your name>","text":"<what happened, one line>","status":"finished","external_key":"<stable id>"}'
```

For long work, post `in_progress` when you start and the same key as
`finished` when you're done.

## Answers

You don't check the inbox. When your human taps Done, Reject, Reply or
Snooze, the orchestrator's webhook routine gets it and the orchestrator
sends you a short message. A reply is quoted word for word.

- **Done** means seen and handled. It is not permission to merge, deploy,
  spend or delete. If you need a go-ahead, ask with `type: "reply"` and act
  on the reply.
- **Rejected** means no. Drop it; don't re-ask in other words.
- **Reply** is your answer. Act on it.
- **Snoozed** means later. Don't re-post it.

## Rules

- Tests: start the title or text with `[TEST]` (capitals). It stays hidden.
- `201` is a new post, `200` an update. `401` means the token didn't load:
  check the file path. `429` means a daily cap: stop and tell your human.
  Don't retry blindly.
- Never put secrets in titles, notes or links.
