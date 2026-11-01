# Set up Agent Inbox: instructions for a Grok Bot orchestrator

> [!NOTE]
> This guide has been run end to end on a brand-new Cloudflare account. A
> few edge cases are still open; see [Not yet verified](#not-yet-verified)
> at the end.

This guide is meant to be run by an orchestrator bot in your human's Grok
Bot app, possibly one they added from a shareable bot template. That's
you. You set up Agent Inbox, and afterwards you stay on to triage it: your
human's taps come back to you, and you pass each one to the bot it's for.

Do the steps below in order, on your own computer: the shared Linux box
all their bots use. Your human uses the Grok Bot app, often on a phone.
Don't ask them to run commands or install anything. Every step can be run
again safely.

Your human does five things, each its own short ask, and nothing else:

1. Make a Cloudflare API token (step 2).
2. Tap the passkey link, or sign in if they already have a passkey (step 4).
3. Send the webhook routine's URL and key (step 5).
4. Pick which bots post to the inbox (step 6).
5. Try two welcome cards in their new inbox (step 7).

Keep your messages to them short.

**Secrets rule.** Never print, echo, log or paste a token, key or secret,
and never ask your human to paste one into chat. Collect secrets with a
secret-request card; the value lands in your environment under the card's
name. The setup script keeps the inbox's own secrets in
`~/.config/agent-inbox/` (mode 600) and never prints them.

## 1. Install the tools

```sh
node --version   # need v22 or newer
git --version
```

If Node is missing or older than 22, install it for your user, no root
needed. Don't use nvm: these boxes set `NPM_CONFIG_PREFIX`, which nvm
refuses, and a fresh home has no profile file for it to hook into. Instead,
unpack the current Node 22 build from nodejs.org into `~/.local/node`:

```sh
case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
base=https://nodejs.org/dist/latest-v22.x
file=$(curl -fsSL "$base/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-$arch\.tar\.gz" | head -1)
mkdir -p ~/.local/node /tmp/node-dl
curl -fsSL -o "/tmp/node-dl/$file" "$base/$file"
(cd /tmp/node-dl && curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | sha256sum -c -)
tar -xzf "/tmp/node-dl/$file" -C ~/.local/node --strip-components=1
export PATH="$HOME/.local/node/bin:$PATH"
node --version
```

Each new shell needs that `export PATH=...` line again before `node` or
`npm` work. The setup script finds `~/.local/node` by itself once it's
running. Then get the code. It lands in `~/src/agent-inbox`, and every
command below runs there:

```sh
mkdir -p ~/src
[ -d ~/src/agent-inbox ] || git clone https://github.com/helloandgoodluck/agent-inbox ~/src/agent-inbox
cd ~/src/agent-inbox && git pull --ff-only && npm ci
```

Check: `npm ci` exits 0.

## 2. Get a Cloudflare API token (your human)

Send your human this, then a secret-request card named
`CLOUDFLARE_API_TOKEN`:

> I need a Cloudflare token to set up your inbox. If you don't have a
> Cloudflare account, make a free one at https://dash.cloudflare.com/sign-up
> and confirm the email Cloudflare sends (a new account can't make tokens
> until then). Then open this link, tap **Continue to summary**, then
> **Create Token**, and paste the token into the card I'm sending. Not in
> chat.
>
> https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Agent%20Inbox

The link prefills a token named "Agent Inbox" with three account
permissions: **Workers Scripts: Edit**, **D1: Edit** and **Account
Settings: Read**. Those three cover setup. If the link doesn't prefill,
they can add them by hand under **Create Custom Token**.

Wrangler reads `CLOUDFLARE_API_TOKEN` from the environment by itself. Don't
copy it to a file or put it in front of commands.

Fallback, only if a token can't be made: `npx wrangler login` signs in
through a browser on the box instead, and the script works with that too.

## 3. Run the setup script

```sh
cd ~/src/agent-inbox
npm run setup -- --remote
```

It makes the bot token and inbox secret, finds or creates the D1 database,
registers a `workers.dev` subdomain if the account is brand new, migrates,
deploys, sets the Worker's secrets, saves the inbox address to
`~/.config/agent-inbox/url`, checks that the bot token works, and prints a
one-time passkey link. A new `workers.dev` address takes about a minute to
go live, so the check may print a `wait` line and keep trying for up to two
minutes. Each other line starts with `ok`. On a problem it stops at a
`FAIL` line followed by `Next:`, which says what to do; then run it again.

A rerun changes nothing it already did: secrets show as `kept` or
`refreshed, unchanged`, and it makes no new passkey link (it says whether
the earlier one still works). Add `--enroll` for a new link.

There is one bot token, `~/.config/agent-inbox/bot-token`, shared by all
your bots. The inbox trusts the `bot` name each post sends, so any bot with
the token can post as any name, read every item, and close any item.

If the token sees more than one Cloudflare account, the script stops and
lists each as `name (id)`. Ask your human which, then rerun with
`CLOUDFLARE_ACCOUNT_ID=<id>` in front.

**Already deployed with the Deploy button?** Run the script anyway. It
finds the database named `agent-inbox` and replaces the button's
`BOT_TOKEN` with its own. This hasn't been tried on a button deploy yet.
If the script prints `database agent-inbox made` rather than `found`, it
didn't find the button's database and set up a new, empty one: tell your
human before going on.

## 4. Let your human open the inbox (your human)

Make this its own message, with only the link the script printed:

> Open this on your phone and tap **Create passkey**. It expires in 15
> minutes. Say "done" when you're in. `<link>`

Then wait for their "done". The link opens the inbox once the passkey is
made. Passkeys are tied to the address, so they should always use that
`workers.dev` URL. If the link expired or was used, run
`npm run setup -- --remote --enroll` for a new one and send just that. The
same command adds another device later.

**No link printed?** If the `enroll` line says `passkey already set up`,
there's no link to send. Tell your human instead:

> Your inbox already has a passkey. Open `<inbox URL>` and tap **Sign
> in with passkey**. Say "done" when you're in, or tell me if it doesn't work.

If they can't sign in (new phone, lost passkey), run
`npm run setup -- --remote --enroll` and send the new link as above.

Once they say done, post one real finished entry so the inbox isn't empty,
with your own bot name filled in:

```sh
cd ~/src/agent-inbox
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$(cat ~/.config/agent-inbox/url)/api/activity" \
  -H "Authorization: Bearer $(cat ~/.config/agent-inbox/bot-token)" \
  -H 'Content-Type: application/json' \
  -d '{"bot":"<your bot name>","text":"Agent Inbox is set up","status":"finished","external_key":"setup-done"}'
```

Expect `201` (`200` on a rerun).

## 5. Send answers back to you (your human)

Your human's Done, Reject, Reply and Snooze taps go out through the inbox's
webhook to a webhook routine on you.

1. Create the routine from
   [docs/grok-bot/orchestrator-routine.md](docs/grok-bot/orchestrator-routine.md).
   Fill in the bot names in its prompt from your own teammate list, right
   now, including yourself. If the app shows a confirm card, wait for your
   human.
2. The create result doesn't include the links to the routine's
   **Webhook URL** and **key** fields; they show up in your routine status
   on your next turn. So once it's made, tell your human just "One sec,
   grabbing the links." and end your turn.
3. On your next turn, take the two direct links from your routine status
   and send them in one message. The URL they may paste in chat; for the
   key, send a secret-request card named `AGENT_INBOX_WEBHOOK_KEY`, not
   chat. Don't ask them to hunt for the fields in the Routines tab.
4. Run the script again with the URL:

```sh
cd ~/src/agent-inbox
npm run setup -- --remote --webhook '<webhook URL>'
```

It reads the key from `AGENT_INBOX_WEBHOOK_KEY` and sets
`FORWARD_WEBHOOK_URL` and `FORWARD_WEBHOOK_KEY` on the Worker. The inbox
sends each tap as JSON with `Authorization: Bearer <key>` and retries
anything that isn't `2xx` for about 8.5 hours. Don't set
`FORWARD_SIGNING_SECRET`: the routine can't check it. A later rerun without
`--webhook` keeps these settings.

When your human adds a bot later, update the routine's prompt with its
name, or its taps reach you as an unknown bot.

## 6. Teach your bots to post (your human)

First, ask your human which bots should post. List their other bots from
your teammate list in a multi-select widget, all checked by default:

> Which of your bots should check in through the inbox?

If they have no other bots, skip the question.

Save [docs/grok-bot/post-to-agent-inbox.md](docs/grok-bot/post-to-agent-inbox.md)
as a skill named `post-to-agent-inbox`. Skills are one library shared by
all your human's bots, so once is enough. Your bots read the same files on
this box, so the skill must use the paths setup wrote:
`~/.config/agent-inbox/url` and `~/.config/agent-inbox/bot-token`.

Then send each bot your human chose, and no others, one message: "There's
a new skill, `post-to-agent-inbox`. Follow it when you hand off, finish, or need a
decision. Your inbox name is `<exact bot name>`."

Don't create any routine that posts on a timer.

## 7. Welcome tour (your human)

Two real cards show your human how answers travel. Post them as the first
bot your human chose in step 6 (any of them works). If they chose none or
have none, post them as yourself and handle the taps directly; the routine
covers that case.

```sh
cd ~/src/agent-inbox
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$(cat ~/.config/agent-inbox/url)/api/items" \
  -H "Authorization: Bearer $(cat ~/.config/agent-inbox/bot-token)" \
  -H 'Content-Type: application/json' \
  -d '{"bot":"<bot name>","type":"reply","external_key":"welcome-reply","title":"Welcome to your inbox. Tap Reply and say hi","note":"Your reply goes straight to <bot name>, which answers you in chat to show it got it."}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$(cat ~/.config/agent-inbox/url)/api/items" \
  -H "Authorization: Bearer $(cat ~/.config/agent-inbox/bot-token)" \
  -H 'Content-Type: application/json' \
  -d '{"bot":"<bot name>","type":"approval","external_key":"welcome-done","title":"Tap Done to clear this","note":"The card leaves your inbox and <bot name> hears it is done. Done means seen, not a go-ahead."}'
```

Expect `201` twice (`200` on a rerun, which never reopens a card your
human already cleared). Then send:

> Your inbox has two welcome cards. Tap **Reply** on the first and say hi,
> then tap **Done** on the second. Reject and Snooze work on any card too;
> try them anytime.

Each tap wakes your webhook routine once, and it hands off to you. Pass it
to the bot, wake it, and pass on its one line to your human, such as "Got
your reply: hi" or "Got it, that one's done." If you posted the cards as
yourself, just say that line.

If a tap doesn't arrive within a few minutes, check
`GET $(cat ~/.config/agent-inbox/url)/api/events` (with the bot token) for
that event's delivery status, and tell your human what you see.

## 8. You're all set

Once both taps have come back, send your human one message, in your own
words, along these lines:

> You're all set. Your inbox lives at `<inbox URL>`. Add it to your home
> screen so it's one tap away. From now on your bots check in there
> instead of pinging you, and whatever you tap goes straight back to the
> bot that asked.

## Verified

- The token link prefills, and its three permissions cover setup (step 2).
- Registering a `workers.dev` subdomain through the API works on a
  brand-new account (step 3).
- Creating a routine doesn't return its webhook URL or key, so your human
  sends them (step 5).
- The routine accepts `Authorization: Bearer` alone.
- Done, Reply, Reject and Snooze arrive end to end through the routine.

## Not yet verified

- Whether secret-request values are still in the environment in later
  sessions. Fallback: if one is gone when you rerun the script, ask your
  human for it again.
- Running the script on an inbox made with the Deploy button (step 3).
  Fallback: watch the `database` line, as step 3 describes.
- Whether the routine answers `2xx` within the inbox's 5-second timeout.
  Fallback: a slow answer only means the inbox retries, and the
  `event_id` check stops a tap being relayed twice.
