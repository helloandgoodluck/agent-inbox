// Make a one-time link for registering a passkey on the inbox.
// Usage: node scripts/enroll-link.mjs <base-url> [--remote | --local [--persist-to <dir>]]
//
// Generates a random token and stores only its SHA-256 in D1, valid for 15
// minutes and for one registration. Without --remote/--local it just prints
// the SQL so you can run it yourself. Open the printed URL on the phone.
// --remote uses wrangler.local.jsonc when it exists (`npm run setup` makes
// it), since that's where the database_id is, the same config deploy uses.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const target = args.includes("--remote") ? "--remote" : args.includes("--local") ? "--local" : null;
if (!base || !/^https?:\/\//.test(base)) {
  console.error("Usage: node scripts/enroll-link.mjs <base-url> [--remote | --local [--persist-to <dir>]]");
  console.error("Example: node scripts/enroll-link.mjs https://agent-inbox.you.workers.dev --remote");
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const sql =
  "INSERT INTO enroll_tokens (token_hash, expires_at) " +
  `VALUES ('${hash}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes'));`;

const persistAt = args.indexOf("--persist-to");
const extra =
  target === "--remote" && existsSync("wrangler.local.jsonc")
    ? ["-c", "wrangler.local.jsonc"]
    : target === "--local" && persistAt >= 0
      ? ["--persist-to", args[persistAt + 1]]
      : [];

if (target) {
  const res = spawnSync("npx", ["wrangler", "d1", "execute", "DB", target, ...extra, "--command", sql], {
    stdio: ["inherit", "ignore", "inherit"],
  });
  if (res.status !== 0) {
    console.error("wrangler d1 execute failed; no link was created");
    process.exit(res.status ?? 1);
  }
} else {
  console.log("Run this against the DB, e.g. with `npx wrangler d1 execute DB --remote --command \"...\"`:\n");
  console.log(`${sql}\n`);
}

console.log("Enrollment link (single use, expires in 15 minutes):\n");
console.log(`${base.replace(/\/+$/, "")}/enroll#${token}`);
