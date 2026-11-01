// Bindings and secrets. Secrets are set with `wrangler secret put` (or
// `.dev.vars` locally) and are only ever read server-side.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AUTH_LIMITER?: RateLimit; // per-IP cap on /api/auth/*; skipped if the binding is missing
    BOT_TOKEN: string;
    INBOX_SECRET?: string; // optional fallback to passkey sign-in
    FORWARD_WEBHOOK_URL?: string;
    FORWARD_WEBHOOK_KEY?: string; // sent as the Bearer token to FORWARD_WEBHOOK_URL
    FORWARD_SIGNING_SECRET?: string; // HMAC key for X-Agent-Inbox-Signature; never sent
    CANONICAL_BOTS?: string; // optional, comma-separated: bot names stored with exactly this spelling
    DEBUG_ROWS?: string; // local only: logs rows read per dashboard load
  }
}

interface Env extends Cloudflare.Env {}
