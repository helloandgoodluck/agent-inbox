// Fills the LOCAL dev database with realistic demo data: six bots, a few days
// of activity, items of every type, and some done, rejected and snoozed.
// Times are relative to now, so re-seed (with --reset) before a screenshot.
//
// Usage: node scripts/seed-demo.mjs [--reset] [--persist-to <dir>]
//   --reset       deletes the local D1 state (.wrangler/state, or --persist-to) first
//                 and re-applies migrations
//
// Local only: it refuses --remote and has no way to reach a deployed database.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_STATE, migrateLocal, queryLocal, refuseRemote, runLocalSql, sqlString as q } from "./local-d1.mjs";

refuseRemote();
const LOCAL_D1 = join(LOCAL_STATE, "v3/d1");

if (process.argv.includes("--reset") && existsSync(LOCAL_D1)) {
  rmSync(LOCAL_D1, { recursive: true, force: true });
  console.log("Deleted the local D1 state.");
}
migrateLocal();
if (queryLocal("SELECT count(*) AS n FROM items WHERE id LIKE 'demo-%'")[0].n > 0) {
  console.error("Demo data is already there. Run with --reset to start over.");
  process.exit(1);
}

const now = Date.now();
const minsAgo = (m) => new Date(now - m * 60_000).toISOString();
// A local clock time n days ago.
const dayAt = (n, hhmm) => {
  const d = new Date(now - n * 86_400_000);
  const [h, m] = hhmm.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

const sql = [];
let n = 0;

// One item and its events. history lists [action, at, extra] in order:
// done, rejected, reply and snooze are yours (forwarded, so they get a
// delivered row); bot_done is the bot closing it.
function item(bot, type, title, { note = null, links = [], at, history = [], fyi = false }) {
  const id = `demo-${++n}`;
  let status = fyi ? "done" : "waiting";
  let snoozeUntil = null;
  let updated = at;
  const events = [["created", at, { bot, title, status, ...(type ? { type } : {}) }, false]];
  for (const [action, when, extra = {}] of history) {
    const source = action === "bot_done" ? "bot" : "inbox";
    const type_ = { bot_done: "done", snooze: "snoozed" }[action] ?? action;
    const payload = source === "bot" ? { source, ...extra } : { source, actor: "passkey", ...extra };
    events.push([type_, when, payload, source === "inbox"]);
    if (type_ === "done") status = "done";
    if (type_ === "rejected") status = "rejected";
    if (type_ === "snoozed") [status, snoozeUntil] = ["snoozed", extra.until];
    updated = when;
  }
  sql.push(
    `INSERT INTO items (id, bot, title, status, type, note, links, snooze_until, created_at, updated_at)
     VALUES (${[id, bot, title, status, type, note, JSON.stringify(links.map((url) => ({ url }))), snoozeUntil, at, updated].map(q).join(", ")});`,
  );
  for (const [type_, when, payload, forwarded] of events) {
    sql.push(`INSERT INTO events (item_id, type, payload, at) VALUES (${[id, type_, JSON.stringify(payload), when].map(q).join(", ")});`);
    if (forwarded) {
      sql.push(
        `INSERT INTO event_deliveries (event_id, attempts, next_attempt_at, delivered_at) VALUES (last_insert_rowid(), 1, ${q(when)}, ${q(when)});`,
      );
    }
  }
}

function activity(bot, text, status, at, key = null) {
  sql.push(
    `INSERT INTO activity (id, bot, text, status, external_key, at, created_at, updated_at)
     VALUES (${[`demo-a${++n}`, bot, text, status, key, at, at, at].map(q).join(", ")});`,
  );
}

// --- waiting on you -------------------------------------------------------

item("Code Bot", "approval", "Ship agent-inbox v0.4 to production", {
  note: "All 82 tests green, smoke test passed on staging. +1,240 −310 across 9 files.",
  links: ["https://github.com/you/your-repo/pull/6"],
  at: minsAgo(9),
});
item("Yard Bot", "due_today", "Confirm the fertilizer drop-off window, 2–4pm", {
  note: "Green Acres can also do Thursday morning if today doesn't work.",
  at: minsAgo(47),
});
item("Errand Bot", "yes_no", "Book Nopa for Friday 7:30pm, table for four?", {
  note: "They're holding it until 9pm tonight.",
  at: minsAgo(95),
});
item("Money Bot", "sign", "Sign the renewed home insurance policy", {
  note: "Premium is down 6% from last year. Same coverage.",
  links: ["https://example.com/docusign/renewal-2027"],
  at: minsAgo(160),
});
item("Errand Bot", "approval", "Approve $186 for the Costco run", {
  note: "List attached. Mostly the usual, plus the patio chairs you saved.",
  at: minsAgo(205),
});
item("Design Bot", "reply", "Which hero image for the launch thread: dark dashboard or phone mockup?", {
  at: minsAgo(290),
});
item("Code Bot", "yes_no", "Turn on the cron retry in production too?", {
  note: "Runs every minute, 15 deliveries per run, stays under the free plan limits.",
  at: minsAgo(415),
});
item("Social Bot", "approval", "Boost the “agents need an inbox” post for $40?", {
  note: "It's at 3.1× your median engagement after 6 hours.",
  at: dayAt(1, "16:20"),
});

// Snoozed: out of Waiting until tomorrow morning.
const tomorrow9 = new Date(now + 86_400_000);
tomorrow9.setHours(9, 0, 0, 0);
item("Money Bot", "approval", "Cancel 3 unused subscriptions ($41/mo)?", {
  at: dayAt(1, "09:10"),
  history: [["snooze", dayAt(1, "09:40"), { until: tomorrow9.toISOString() }]],
});

// --- done, rejected, replied ----------------------------------------------

item("Code Bot", "approval", "Merge the passkey session fix", {
  at: minsAgo(210),
  history: [["done", minsAgo(198)]],
});
item("Errand Bot", "yes_no", "Pick up the dry cleaning on the way back?", {
  at: minsAgo(330),
  history: [
    ["reply", minsAgo(322), { text: "Yes, and grab oat milk" }],
    ["done", minsAgo(320)],
  ],
});
item("Social Bot", "approval", "Quote-post the Workers launch thread", {
  at: dayAt(1, "11:05"),
  history: [["rejected", dayAt(1, "11:30"), { note: "Not our angle" }]],
});
item("Money Bot", "due_today", "Pay the water bill ($84.20)", {
  at: dayAt(1, "08:02"),
  history: [["done", dayAt(1, "08:15")]],
});
item("Design Bot", "reply", "Headline for the README: “One inbox for your bots”?", {
  at: dayAt(2, "14:40"),
  history: [
    ["reply", dayAt(2, "15:02"), { text: "Make it “everything your bots are waiting on you for”" }],
    ["done", dayAt(2, "15:03")],
  ],
});
item("Yard Bot", "yes_no", "Skip watering, 80% chance of rain tonight?", {
  at: dayAt(2, "06:30"),
  history: [["done", dayAt(2, "07:12")]],
});
item("Errand Bot", "approval", "Reorder printer ink ($62)", {
  at: dayAt(3, "10:12"),
  history: [["rejected", dayAt(3, "12:40"), { note: "Still have a spare" }]],
});
item("Code Bot", "sign", "Accept the Cloudflare D1 terms update", {
  at: dayAt(3, "09:00"),
  history: [["done", dayAt(3, "09:20")]],
});
item("Money Bot", null, "Paid the electricity bill ($112.40)", { at: dayAt(4, "08:45"), fyi: true });
item("Social Bot", "approval", "Reply to the big thread on solo AI ops", {
  at: dayAt(4, "13:00"),
  history: [["done", dayAt(4, "13:42")]],
});

// --- activity -------------------------------------------------------------

activity("Social Bot", "Scanning 1,200 posts tagged #buildinpublic", "in_progress", minsAgo(6), "scan-1027");
activity("Code Bot", "Refactoring the webhook retry loop", "in_progress", minsAgo(22), "pr-61");
activity("Yard Bot", "Mowing the back lawn, 64% done", "in_progress", minsAgo(38), "mow-back");

activity("Code Bot", "Opened PR #6: desktop redesign", "finished", minsAgo(12));
activity("Design Bot", "Rendered 4 hero image options for the launch", "finished", minsAgo(52));
activity("Yard Bot", "Mowed the front lawn", "finished", minsAgo(75));
activity("Errand Bot", "Ordered groceries for Thursday delivery", "finished", minsAgo(118));
activity("Money Bot", "Reconciled October card statements", "finished", minsAgo(141));
activity("Code Bot", "Ran 82 tests, all green", "finished", minsAgo(176));
activity("Social Bot", "Drafted 3 replies for trending threads", "finished", minsAgo(240));
activity("Money Bot", "Filed 11 receipts to the tax folder", "finished", minsAgo(305));
activity("Design Bot", "Wrote alt text for 9 screenshots", "finished", minsAgo(380));
activity("Errand Bot", "Renewed the library books online", "finished", minsAgo(460));

activity("Code Bot", "Fixed flaky passkey test on CI", "finished", dayAt(1, "19:40"));
activity("Social Bot", "Weekly trends digest: 5 topics worth a post", "finished", dayAt(1, "17:05"));
activity("Yard Bot", "Trimmed the hedges along the driveway", "finished", dayAt(1, "15:30"));
activity("Design Bot", "Cropped launch images for X and LinkedIn", "finished", dayAt(1, "14:10"));
activity("Money Bot", "Moved $500 to savings", "finished", dayAt(1, "10:00"));
activity("Errand Bot", "Returned the Amazon package", "finished", dayAt(1, "12:25"));

activity("Code Bot", "Released v0.3 with event forwarding", "finished", dayAt(2, "18:20"));
activity("Money Bot", "Booked the dentist for Nov 12", "finished", dayAt(2, "11:45"));
activity("Yard Bot", "Checked soil moisture: 31%", "finished", dayAt(2, "07:00"));
activity("Design Bot", "Drafted the launch thread, 7 posts", "finished", dayAt(2, "16:15"));
activity("Social Bot", "Found 4 accounts worth following", "finished", dayAt(2, "13:10"));

activity("Errand Bot", "Picked up the prescription", "finished", dayAt(3, "16:50"));
activity("Code Bot", "Upgraded wrangler and vitest", "finished", dayAt(3, "10:30"));
activity("Yard Bot", "Aerated the front lawn", "finished", dayAt(3, "08:15"));
activity("Money Bot", "Paid the contractor invoice", "finished", dayAt(3, "14:05"));

activity("Design Bot", "Designed the agent-inbox logo mark", "finished", dayAt(4, "15:30"));
activity("Code Bot", "Added desktop columns", "finished", dayAt(4, "11:20"));
activity("Social Bot", "Tracked launch mentions: 38 so far", "finished", dayAt(4, "17:45"));
activity("Errand Bot", "Scheduled the car service for Saturday", "finished", dayAt(4, "09:30"));

runLocalSql(sql.join("\n"));
console.log(`Seeded ${sql.filter((s) => s.startsWith("INSERT INTO items")).length} items and ${
  sql.filter((s) => s.startsWith("INSERT INTO activity")).length
} activity entries into the local database.`);
