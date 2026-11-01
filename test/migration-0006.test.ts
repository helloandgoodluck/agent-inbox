// Runs migrations/0006 against rows written before it, in a database of
// its own: the [TEST] backfill, the bot name merge and its collision rule.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const { TEST_MIGRATIONS, MIGRATION_DB: db } = env as unknown as {
  TEST_MIGRATIONS: D1Migration[];
  MIGRATION_DB: D1Database;
};

type Row = { id: string; bot: string; external_key: string | null; is_test: number };

// id, bot, title/text, external_key, created_at, updated_at
const ITEMS: [string, string, string, string | null, string, string][] = [
  // 'deploy bot' is seen first, so every casing becomes that. Two rows share
  // k1: the newer (i-b) keeps the key.
  ["i-a", "deploy bot", "[TEST] old deploy", "k1", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
  ["i-b", "Deploy Bot", "real deploy", "k1", "2026-10-02T00:00:00Z", "2026-10-02T00:00:00Z"],
  // Here the row that already has the first-seen name is the older one, so it gives up k2.
  ["i-c", "DEPLOY BOT", "newer upper", "k2", "2026-10-03T00:00:00Z", "2026-10-05T00:00:00Z"],
  ["i-d", "deploy bot", "older canonical", "k2", "2026-10-03T00:00:00Z", "2026-10-04T00:00:00Z"],
  ["i-e", "Deploy Bot", "no key", null, "2026-10-06T00:00:00Z", "2026-10-06T00:00:00Z"],
  // First seen in activity as 'zed bot' (see ACTIVITY).
  ["i-f", "Zed Bot", "zed item", "z1", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"],
  // Seen only in items: the earliest casing wins.
  ["i-g", "myBot", "first", null, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"],
  ["i-h", "MYBOT", "second", null, "2026-09-05T00:00:00Z", "2026-09-05T00:00:00Z"],
  ["i-i", "watcher", "Not [TEST] at the start", null, "2026-09-05T00:00:00Z", "2026-09-05T00:00:00Z"],
];
const ACTIVITY: [string, string, string, string | null, string, string][] = [
  ["a-a", "zed bot", "earliest", null, "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z"],
  // Same created_at: the name that sorts first wins ('Scanner' before 'scanner').
  ["a-b", "scanner", "newer", "scan", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"],
  ["a-c", "Scanner", "older", "scan", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
  ["a-d", "Pinger", "[TEST] ping", null, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
  // Same updated_at: the higher id wins, so the result doesn't depend on row order.
  ["a-e", "helper", "tie 1", "tie", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
  ["a-f", "HELPER", "tie 2", "tie", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"],
];

async function rows(table: "items" | "activity") {
  const { results } = await db.prepare(`SELECT id, bot, external_key, is_test FROM ${table}`).all<Row>();
  return Object.fromEntries(results.map((r) => [r.id, r]));
}

beforeAll(async () => {
  const before = TEST_MIGRATIONS.filter((m) => m.name < "0006");
  expect(before.map((m) => m.name)).toHaveLength(5);
  await applyD1Migrations(db, before);

  const stmts = [];
  for (const [id, bot, title, key, created, updated] of ITEMS) {
    stmts.push(
      db.prepare(
        "INSERT INTO items (id, bot, title, external_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, bot, title, key, created, updated),
      db.prepare("INSERT INTO events (item_id, type, payload, at) VALUES (?, 'created', ?, ?)").bind(
        id,
        JSON.stringify({ bot, title }),
        created,
      ),
    );
  }
  for (const [id, bot, text, key, created, updated] of ACTIVITY) {
    stmts.push(
      db.prepare(
        `INSERT INTO activity (id, bot, text, status, external_key, at, created_at, updated_at)
         VALUES (?, ?, ?, 'finished', ?, ?, ?, ?)`,
      ).bind(id, bot, text, key, created, created, updated),
    );
  }
  await db.batch(stmts);

  await applyD1Migrations(db, TEST_MIGRATIONS);
});

describe("migration 0006", () => {
  it("deletes nothing", async () => {
    const count = async (t: string) => (await db.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
    expect(await count("items")).toBe(ITEMS.length);
    expect(await count("activity")).toBe(ACTIVITY.length);
    expect(await count("events")).toBe(ITEMS.length);
  });

  it("backfills is_test from a leading [TEST] only", async () => {
    const items = await rows("items");
    expect(Object.values(items).filter((r) => r.is_test).map((r) => r.id)).toEqual(["i-a"]);
    const activity = await rows("activity");
    expect(Object.values(activity).filter((r) => r.is_test).map((r) => r.id)).toEqual(["a-d"]);
  });

  it("merges every bot to the casing it was first seen with", async () => {
    const items = await rows("items");
    const activity = await rows("activity");
    expect(["i-a", "i-b", "i-c", "i-d", "i-e"].map((id) => items[id].bot)).toEqual(Array(5).fill("deploy bot"));
    expect(items["i-f"].bot).toBe("zed bot"); // seen in activity first
    expect(activity["a-a"].bot).toBe("zed bot");
    expect([items["i-g"].bot, items["i-h"].bot]).toEqual(["myBot", "myBot"]);
    expect(items["i-i"].bot).toBe("watcher");
    expect([activity["a-b"].bot, activity["a-c"].bot]).toEqual(["Scanner", "Scanner"]);
    expect(activity["a-d"].bot).toBe("Pinger");
    expect([activity["a-e"].bot, activity["a-f"].bot]).toEqual(["HELPER", "HELPER"]);
  });

  it("on a key collision keeps the newer row's key and suffixes the other's", async () => {
    const items = await rows("items");
    const activity = await rows("activity");
    expect(items["i-b"].external_key).toBe("k1");
    expect(items["i-a"].external_key).toBe("k1#merged:deploy bot:i-a");
    expect(items["i-c"].external_key).toBe("k2");
    expect(items["i-d"].external_key).toBe("k2#merged:deploy bot:i-d");
    expect(items["i-f"].external_key).toBe("z1");
    expect(activity["a-b"].external_key).toBe("scan");
    expect(activity["a-c"].external_key).toBe("scan#merged:Scanner:a-c");
    expect(activity["a-f"].external_key).toBe("tie");
    expect(activity["a-e"].external_key).toBe("tie#merged:helper:a-e");

    // The query in docs/development.md finds every row that lost its key.
    const { results } = await db
      .prepare(
        `SELECT id FROM items WHERE external_key LIKE '%#merged:%'
         UNION ALL SELECT id FROM activity WHERE external_key LIKE '%#merged:%' ORDER BY id`,
      )
      .all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["a-c", "a-e", "i-a", "i-d"]);
  });

  it("leaves events as they were, still attached, and drops its helper tables", async () => {
    const { results } = await db
      .prepare("SELECT e.item_id, e.payload, i.bot FROM events e JOIN items i ON i.id = e.item_id WHERE e.item_id = 'i-c'")
      .all<{ item_id: string; payload: string; bot: string }>();
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].payload).bot).toBe("DEPLOY BOT"); // history isn't rewritten
    expect(results[0].bot).toBe("deploy bot");

    const { results: tables } = await db
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('_known_bots', '_bot_names', '_merge_losers')")
      .all();
    expect(tables).toEqual([]);
  });

  it("keeps the unique (bot, external_key) indexes working", async () => {
    await expect(
      db
        .prepare("INSERT INTO items (id, bot, title, external_key, created_at, updated_at) VALUES ('x', 'deploy bot', 't', 'k1', '', '')")
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });
});
