// Runs SQL against the LOCAL dev D1 (.wrangler/state) only. Shared by the
// local-dev scripts (seed-demo, screenshot), which must never touch a deployed
// database: any --remote argument is refused before wrangler is called.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `--persist-to <dir>` targets a dev server started with the same flag, so a
// check can run against a scratch database instead of .wrangler/state.
const persistAt = process.argv.indexOf("--persist-to");
const LOCAL = ["--local", ...(persistAt >= 0 ? ["--persist-to", process.argv[persistAt + 1]] : [])];
export const LOCAL_STATE = persistAt >= 0 ? process.argv[persistAt + 1] : ".wrangler/state";

export function refuseRemote(args = process.argv.slice(2)) {
  if (args.some((a) => a === "--remote" || a.startsWith("--remote="))) {
    console.error("Refusing --remote: this script only ever writes to the local dev database.");
    process.exit(2);
  }
}

export function sqlString(value) {
  return value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

// Returns the rows of one read-only query.
export function queryLocal(sql) {
  const res = spawnSync("npx", ["wrangler", "d1", "execute", "DB", ...LOCAL, "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (res.status !== 0) throw new Error("wrangler d1 execute --local failed");
  return JSON.parse(res.stdout)[0].results;
}

export function migrateLocal() {
  const res = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", ...LOCAL], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (res.status !== 0) throw new Error("wrangler d1 migrations apply --local failed");
}

// Runs the statements from a temp file so nothing (such as a session hash)
// shows up in the process list or the terminal.
export function runLocalSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "agent-inbox-"));
  const file = join(dir, "local.sql");
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    const res = spawnSync("npx", ["wrangler", "d1", "execute", "DB", ...LOCAL, "--file", file], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (res.status !== 0) throw new Error("wrangler d1 execute --local failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
