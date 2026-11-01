# Self-hosting

The [README](../README.md) covers the quick path: the Deploy button. This
page has the details: every setting, a manual deploy, and passkeys.

## Secrets

| Name | Required | What it's for |
| --- | --- | --- |
| `BOT_TOKEN` | yes | Bots send it as `Authorization: Bearer <BOT_TOKEN>`. |
| `INBOX_SECRET` | no | Fallback to [passkey sign-in](#sign-in-with-a-passkey): type it into the inbox page. Use a different value from `BOT_TOKEN`. |
| `FORWARD_WEBHOOK_URL` | no | Every Done / Reject / Reply / Snooze click is POSTed here. If unset, clicks are still logged and wait as pending until you set it. |
| `FORWARD_WEBHOOK_KEY` | no | Sent to the webhook as `Authorization: Bearer <key>`, for receivers that check a sender key. The receiver sees it. |
| `FORWARD_SIGNING_SECRET` | no | Signs each webhook body ([HMAC-SHA256](api.md#forward-webhook)). Never sent. Grok Bot webhook routines can't check it, so skip it there. Use a different value from `FORWARD_WEBHOOK_KEY`; if they match, requests go unsigned. |
| `CANONICAL_BOTS` | no | Comma-separated bot names to always store with exactly that spelling. See [bot names](api.md#bots-authorization-bearer-bot_token). Not a secret; set it as a plain variable if you prefer. |

Secrets stay in the Worker. If you use the inbox secret, the page keeps it in your browser's localStorage.

Generate each value with `openssl rand -hex 32`. `BOT_TOKEN` and `INBOX_SECRET` must be at least 32 characters and can't start with `change-me`: the Worker refuses anything weaker with `503 server not configured`, since it compares them with no lockout.

## Manual setup

Needs Node 22+ and a Cloudflare account. `npm run setup -- --remote` does all of this for you, with a token in `CLOUDFLARE_API_TOKEN` or after `wrangler login`. By hand:

```sh
git clone https://github.com/helloandgoodluck/agent-inbox && cd agent-inbox
npm install
npx wrangler login
npx wrangler d1 create agent-inbox
# copy the printed database_id into the DB entry in wrangler.jsonc
npm run deploy   # applies D1 migrations remotely, then deploys
npx wrangler secret put BOT_TOKEN
npx wrangler secret put INBOX_SECRET
```

Set the two optional webhook secrets the same way if you want forwarding. Your inbox is at the `*.workers.dev` URL that `deploy` prints.

## Sign in with a passkey

The inbox page signs in with a passkey (Face ID, Touch ID or device PIN). To add one, make a one-time setup link and open it on the device:

```sh
npm run enroll-link -- https://agent-inbox.you.workers.dev --remote
```

This stores only the SHA-256 of a random token in D1. The token expires after 15 minutes and works for one registration. The script prints a `…/enroll#<token>` link. Open it on your phone, tap **Create passkey**, and you're signed in. After that, use **Sign in with passkey** on the inbox page. Sessions last 30 days in an HttpOnly cookie. **Sign out** ends the session. The sign-in routes (`/api/auth/*`) allow 20 requests a minute per client IP, set by the `AUTH_LIMITER` rate limit in `wrangler.jsonc`; more gets `429`.

Without `--remote`, the script prints the SQL for you to run yourself. Use `--local` and `http://localhost:8787` with `npm run dev`. Passkeys are tied to the hostname, so each host (workers.dev, a custom domain, localhost) needs its own.
