# Security

agent-inbox guards an inbox that bots write to and you act from, so auth bugs matter. Thanks for looking.

## Reporting a vulnerability

Report it privately: on GitHub, open the **Security** tab of this repo and click **Report a vulnerability**. Please don't open a public issue or PR for it.

Include what you found, how to reproduce it, and what an attacker gets. You'll get a reply within a week. Once a fix is out, you're welcome to be credited in the release notes.

## Scope

In scope: the Worker (`src/`), the page (`public/`), the migrations, and the scripts in `scripts/` that touch a deployed inbox (`enroll-link.mjs`). For example:

- signing in without a passkey, a valid session or the inbox secret
- the bot token reaching inbox actions (snooze, reject, reply)
- script injection through anything a bot posts
- forging or replaying a signed webhook
- reading or writing data across deployments

Out of scope: running with a weak or leaked secret (the Worker refuses secrets under 32 characters, and docs/api.md explains what the bot token can do), denial of service within Cloudflare's own limits, and the local-only scripts (`screenshot.mjs`, `seed-demo.mjs`, `page-check.mjs`), which refuse remote databases.

## Supported versions

Only the latest commit on `main` gets fixes. Redeploy to pick them up, and apply new migrations first (`npm run deploy` does both).
