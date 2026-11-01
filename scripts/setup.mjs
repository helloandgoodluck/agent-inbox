// Sets up Agent Inbox: every step that needs no human. Safe to rerun; each
// step checks first and only changes what's missing.
//
// Usage:
//   npm run setup -- --remote [--webhook <url>] [--enroll]   deploy to Cloudflare
//   npm run setup -- --local [--persist-to <dir>] [--enroll] local dev database only
// Options: --config-dir <dir> (default ~/.config/agent-inbox).
//
// --remote signs in with CLOUDFLARE_API_TOKEN (or a `wrangler login`), makes
// the bot token and inbox secret files, finds or creates the D1 database,
// writes wrangler.local.jsonc, migrates, deploys, sets the Worker secrets,
// saves the workers.dev address to <config-dir>/url and checks it. The first
// run prints a passkey enroll link; later runs only make one with --enroll.
// --webhook also sets FORWARD_WEBHOOK_URL, plus FORWARD_WEBHOOK_KEY from the
// AGENT_INBOX_WEBHOOK_KEY env var.
//
// Secrets are never printed. They're written without a trailing newline and
// trimmed on read, so the stored token always matches the Bearer header.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

// Bot boxes install Node into ~/.local/node (guide: 'Install the tools'). Put
// it first on PATH so wrangler runs under it, and rerun this script under it
// if the Node that started us is too old.
const localBin = join(homedir(), ".local", "node", "bin");
const localNode = join(localBin, "node");
if (existsSync(localNode)) {
  const path = (process.env.PATH ?? "").split(delimiter);
  if (path[0] !== localBin) process.env.PATH = [localBin, ...path.filter((p) => p !== localBin)].join(delimiter);
  if (Number(process.versions.node.split(".")[0]) < 22 && process.execPath !== localNode) {
    const res = spawnSync(localNode, process.argv.slice(1), { stdio: "inherit" });
    process.exit(res.status ?? 1);
  }
}

const args = process.argv.slice(2);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const remote = args.includes("--remote");
if (remote === args.includes("--local")) {
  console.error("Usage: npm run setup -- --remote [--webhook <url>] [--enroll]");
  console.error("       npm run setup -- --local [--persist-to <dir>] [--enroll]");
  process.exit(1);
}
const dir = value("--config-dir") ?? join(homedir(), ".config", "agent-inbox");
const persistTo = value("--persist-to");
const webhook = value("--webhook");
const enroll = args.includes("--enroll");
const CONFIG = "wrangler.local.jsonc";
const DB_NAME = "agent-inbox";
const target = remote ? ["--remote", "-c", CONFIG] : ["--local", ...(persistTo ? ["--persist-to", persistTo] : [])];
const env = { ...process.env };

function ok(name, result) {
  console.log(`ok    ${name.padEnd(11)}${result}`);
}

function fail(name, why, next, output = "") {
  const tail = output.trim().split("\n").slice(-15).join("\n");
  if (tail) console.error(tail);
  console.error(`FAIL  ${name.padEnd(11)}${why}`);
  console.error(`Next: ${next}`);
  process.exit(1);
}

function wrangler(argv, input) {
  const res = spawnSync("npx", ["wrangler", ...argv], {
    encoding: "utf8",
    input,
    env,
    stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return { ok: res.status === 0, stdout: res.stdout ?? "", out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// Parses the JSON that a `--json` wrangler command printed, skipping any banner.
function json(stdout, open) {
  try {
    return JSON.parse(stdout.slice(stdout.indexOf(open)));
  } catch {
    return undefined;
  }
}

function query(sql) {
  const res = wrangler(["d1", "execute", "DB", ...target, "--json", "--command", sql]);
  const rows = res.ok ? json(res.stdout, "[")?.[0]?.results : undefined;
  if (!rows) fail("database", "query failed", "rerun setup; if it fails again, report the error above", res.out);
  return rows;
}

// Writes a file only if its content differs. Returns what happened.
function put(path, content, mode) {
  const old = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (old === content) {
    if (mode && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
    return "unchanged";
  }
  writeFileSync(path, content, mode ? { mode } : undefined);
  if (mode) chmodSync(path, mode);
  return old == null ? "made" : "updated";
}

// 1. Node
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  fail("node", `v${process.versions.node} is too old; wrangler needs 22+`, "install Node 22 (guide: 'Install the tools'), then rerun");
}
ok("node", `v${process.versions.node}`);

// 2. Secret files
mkdirSync(dir, { recursive: true, mode: 0o700 });
if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
function secret(name) {
  const path = join(dir, name);
  if (!existsSync(path)) {
    const fresh = randomBytes(32).toString("hex");
    put(path, fresh, 0o600);
    return { value: fresh, state: "made" };
  }
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32 || value.startsWith("change-me")) {
    fail("secrets", `${path} is too short or a placeholder`, `delete ${path} and rerun to make a new one (bots using the old one must reread it)`);
  }
  return { value, state: put(path, value, 0o600) === "unchanged" ? "kept" : "fixed" };
}
const botToken = secret("bot-token");
const inboxSecret = secret("inbox-secret");
ok("secrets", `bot-token ${botToken.state}, inbox-secret ${inboxSecret.state} (${dir}, mode 600)`);

let url = "http://localhost:8787";
if (remote) {
  // 3. Cloudflare sign-in
  const who = wrangler(["whoami", "--json"]);
  const info = json(who.stdout, "{");
  if (!who.ok || !info?.loggedIn) {
    fail(
      "cloudflare",
      "not signed in",
      env.CLOUDFLARE_API_TOKEN
        ? "CLOUDFLARE_API_TOKEN was refused; ask your human for a new token (guide: 'Get a Cloudflare API token'), then rerun"
        : "collect CLOUDFLARE_API_TOKEN with a secret-request card (guide: 'Get a Cloudflare API token'), then rerun",
      who.out,
    );
  }
  const accounts = info.accounts ?? [];
  if (!env.CLOUDFLARE_ACCOUNT_ID && accounts.length > 1) {
    fail(
      "cloudflare",
      `this sign-in sees ${accounts.length} accounts: ${accounts.map((a) => `${a.name} (${a.id})`).join(", ")}`,
      "ask your human which one to use, then rerun with CLOUDFLARE_ACCOUNT_ID=<its id> in front",
    );
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID && accounts.length === 1) env.CLOUDFLARE_ACCOUNT_ID = accounts[0].id;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const account = accounts.find((a) => a.id === accountId);
  ok("cloudflare", `signed in${account ? `, account ${account.name}` : ""}`);

  // 4. workers.dev subdomain. A brand-new account has none, and deploy can't
  // pick one without a prompt, so register a random one. Needs an API token.
  if (env.CLOUDFLARE_API_TOKEN && accountId) {
    const api = async (method, body) => {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
        method,
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
        body: body && JSON.stringify(body),
      }).catch(() => null);
      return { status: res?.status ?? 0, ...(res ? await res.json().catch(() => ({})) : {}) };
    };
    const got = await api("GET");
    if (got.success && got.result?.subdomain) {
      ok("subdomain", `${got.result.subdomain}.workers.dev`);
    } else if (got.status === 404 || got.errors?.some((e) => e.code === 10007)) {
      const made = await api("PUT", { subdomain: `inbox-${randomBytes(3).toString("hex")}` });
      if (!made.success) {
        fail(
          "subdomain",
          "this Cloudflare account has no workers.dev subdomain yet, and registering one failed",
          `ask your human to open https://dash.cloudflare.com/${accountId}/workers-and-pages and pick a workers.dev subdomain when asked (any name), then rerun`,
        );
      }
      ok("subdomain", `${made.result.subdomain}.workers.dev registered (new account; can be renamed in the dashboard)`);
    } else {
      ok("subdomain", `couldn't check (HTTP ${got.status || "error"}); deploy will tell`);
    }
  }

  // 5. D1 database
  const findDb = () => {
    const res = wrangler(["d1", "list", "--json"]);
    const list = res.ok ? json(res.stdout, "[") : undefined;
    if (!list) fail("database", "couldn't list D1 databases", "check the token has D1 Edit (guide: 'Get a Cloudflare API token'), then rerun", res.out);
    return list.find((d) => d.name === DB_NAME);
  };
  let db = findDb();
  let dbState = "found";
  if (!db) {
    const res = wrangler(["d1", "create", DB_NAME]);
    if (!res.ok) fail("database", `couldn't create ${DB_NAME}`, "check the token has D1 Edit (guide: 'Get a Cloudflare API token'), then rerun", res.out);
    db = findDb();
    dbState = "made";
    if (!db) fail("database", `created ${DB_NAME} but can't see it`, "rerun setup");
  }
  ok("database", `${DB_NAME} ${dbState}`);

  // 6. wrangler.local.jsonc: wrangler.jsonc plus the database_id. Gitignored.
  const base = readFileSync("wrangler.jsonc", "utf8");
  const anchor = `"database_name": "${DB_NAME}",`;
  if (!base.includes(anchor)) fail("config", `wrangler.jsonc has no ${anchor}`, "restore wrangler.jsonc with git checkout, then rerun");
  const have = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8").match(/"database_id":\s*"([^"]+)"/)?.[1] : undefined;
  if (have && have !== db.uuid) {
    fail("config", `${CONFIG} points at a different database`, `move ${CONFIG} aside if that database isn't in use, then rerun`);
  }
  const config =
    "// Made by `npm run setup` from wrangler.jsonc. Rerun setup rather than editing it.\n" +
    base.replace(anchor, `${anchor}\n      "database_id": "${db.uuid}",`);
  ok("config", `${CONFIG} ${put(CONFIG, config)}`);
}

// 7. Migrations
const mig = wrangler(["d1", "migrations", "apply", "DB", ...target]);
if (!mig.ok) fail("migrations", "apply failed", "rerun setup; if it fails again, report the error above", mig.out);
ok("migrations", /No migrations to apply/i.test(mig.out) ? "up to date" : "applied");

if (remote) {
  // 8. Deploy. Wrangler skips nothing here, but the same code makes the same Worker.
  const dep = wrangler(["deploy", "-c", CONFIG]);
  if (!dep.ok && /subdomain/i.test(dep.out)) {
    fail(
      "deploy",
      "this Cloudflare account has no workers.dev subdomain yet",
      "ask your human to open https://dash.cloudflare.com, go to Workers & Pages, and pick a workers.dev subdomain when asked, then rerun",
      dep.out,
    );
  }
  if (!dep.ok) fail("deploy", "wrangler deploy failed", "check the token has Workers Scripts Edit (guide: 'Get a Cloudflare API token'), then rerun", dep.out);
  const found = dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (!found) fail("deploy", "deployed, but no workers.dev address in the output", "report the output above", dep.out);
  url = found;
  ok("deploy", url);

  // 9. Worker secrets, in one request from stdin so nothing touches disk.
  const secrets = { BOT_TOKEN: botToken.value, INBOX_SECRET: inboxSecret.value };
  if (webhook) {
    const key = env.AGENT_INBOX_WEBHOOK_KEY?.trim();
    if (!/^https:\/\//.test(webhook)) fail("webhook", "--webhook must be an https:// URL", "rerun with the routine's webhook URL");
    if (!key) fail("webhook", "AGENT_INBOX_WEBHOOK_KEY is not set", "collect the routine's key with a secret-request card named AGENT_INBOX_WEBHOOK_KEY (guide: 'Send answers back to you'), then rerun");
    secrets.FORWARD_WEBHOOK_URL = webhook.trim();
    secrets.FORWARD_WEBHOOK_KEY = key;
  }
  const sec = wrangler(["secret", "bulk", "-c", CONFIG], JSON.stringify(secrets));
  if (!sec.ok) fail("secrets", "wrangler secret bulk failed", "rerun setup", sec.out);
  // Remember a hash of what was sent, so a rerun can say nothing changed.
  const sentFile = join(dir, "worker-secrets.sha256");
  const sent = existsSync(sentFile) ? json(readFileSync(sentFile, "utf8"), "{") : undefined;
  const hashes = { ...(sent?.url === url ? sent.hashes : {}) };
  const changed = [];
  const same = [];
  for (const [name, v] of Object.entries(secrets)) {
    const h = createHash("sha256").update(v).digest("hex");
    (hashes[name] === h ? same : changed).push(name);
    hashes[name] = h;
  }
  put(sentFile, JSON.stringify({ url, hashes }), 0o600);
  ok(
    "worker",
    [changed.length && `secrets set: ${changed.join(", ")}`, same.length && `secrets refreshed, unchanged: ${same.join(", ")}`]
      .filter(Boolean)
      .join("; "),
  );

  // 10. Save the address. Not a secret.
  ok("url", `${join(dir, "url")} ${put(join(dir, "url"), url)}`);

  // 11. Check the bot token works. Secrets take a few seconds to land, and a
  // new workers.dev subdomain about a minute to go live, so wait up to 2.
  const deadline = Date.now() + 120_000;
  let status = 0;
  for (let waiting = false; ; waiting = true) {
    const res = await fetch(`${url}/api/items?view=waiting`, {
      headers: { Authorization: `Bearer ${botToken.value}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    status = res?.status ?? 0;
    if (status === 200 || Date.now() > deadline) break;
    if (!waiting) console.log(`wait  ${"check".padEnd(11)}${url} isn't answering yet; a new address takes about a minute (waiting up to 2)`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (status !== 200) {
    const why = { 401: "the token was refused", 503: "a secret is missing or too short" }[status] ?? `HTTP ${status || "no answer"}`;
    fail("check", why, "wait a few minutes and rerun setup");
  }
  ok("check", "bot token accepted (200)");
}

// 12. Passkey enroll link. The first run makes one; after that only --enroll
// does, so a rerun doesn't hand out new links. Each link works once, for 15
// minutes, and making a new one doesn't cancel earlier ones.
const passkeys = query("SELECT count(*) AS n FROM credentials")[0].n;
const whereArgs = remote ? ["--remote"] : ["--local", ...(persistTo ? ["--persist-to", persistTo] : [])];
const rerun = `npm run setup -- ${whereArgs.join(" ")} --enroll`;
const linkFile = join(dir, remote ? "enroll-link" : "enroll-link.local");
const saved = existsSync(linkFile) ? readFileSync(linkFile, "utf8").trim() : "";
const savedToken = saved.startsWith(`${url}/enroll#`) ? saved.slice(`${url}/enroll#`.length) : "";
const minutesLeft = savedToken
  ? query(
      "SELECT CAST((julianday(expires_at) - julianday('now')) * 1440 AS INTEGER) AS m FROM enroll_tokens " +
        `WHERE token_hash = '${createHash("sha256").update(savedToken).digest("hex")}' ` +
        "AND used_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    )[0]?.m
  : undefined;
const live = minutesLeft != null;
const earlier = live
  ? `the earlier link still works for about ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}`
  : saved
    ? "the earlier link is used or expired"
    : "";
const linkShown = enroll || (passkeys === 0 && !saved);
if (linkShown) {
  const res = spawnSync("node", ["scripts/enroll-link.mjs", url, ...whereArgs], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const link = res.stdout.trim().split("\n").at(-1);
  if (res.status !== 0 || !link.startsWith(`${url}/enroll#`)) {
    fail("enroll", "couldn't make a link", "rerun setup", `${res.stdout}${res.stderr}`);
  }
  put(linkFile, link, 0o600);
  ok("enroll", `link made: works once, expires in 15 minutes${live ? `; ${earlier} too` : ""}`);
  console.log(`\n${link}\n`);
} else if (passkeys > 0) {
  ok(
    "enroll",
    `no new link: passkey already set up (${passkeys} registered)${earlier ? `; ${earlier}` : ""}. ` +
      `Ask your human to sign in; if they can't (new phone, lost passkey): ${rerun}`,
  );
} else {
  ok("enroll", `no new link: ${earlier}${live ? ` (${linkFile})` : `. For a new one: ${rerun}`}`);
}

console.log(
  !remote
    ? `Next: npx wrangler dev${persistTo ? ` --persist-to ${persistTo}` : ""}${linkShown ? ", then open the link above" : ""}.`
    : webhook
      ? "Next: guide steps 'Teach your bots to post', then 'Welcome tour'."
      : `Next: ${
          linkShown
            ? "send your human the link above (guide: 'Let your human open the inbox'), then "
            : passkeys > 0
              ? "tell your human a passkey is already set up and ask them to sign in (guide: 'Let your human open the inbox'), then "
              : ""
        }set up the webhook (guide: 'Send answers back to you').`,
);
