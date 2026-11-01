// Checks, in headless Chrome, that the dashboard builds its Timeline and its
// In progress / Finished panel from activity merged with item events: posts a
// few entries through the bot API, then reads the rendered page.
//
// Usage: node scripts/page-check.mjs [--url http://localhost:8787] [--persist-to <dir>]
//
// It writes to the database (a "Page Check" bot, plus a [TEST] entry that
// must stay hidden), so point it at a scratch dev server, e.g.
//   npx wrangler d1 migrations apply DB --local --persist-to .wrangler/state.check
//   npx wrangler dev --persist-to .wrangler/state.check
//   node scripts/page-check.mjs --persist-to .wrangler/state.check
// BOT_TOKEN comes from the environment or .dev.vars. Local only, like screenshot.mjs.
import { existsSync, readFileSync } from "node:fs";
import { withInbox } from "./chrome.mjs";

const args = process.argv.slice(2);
const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:8787";
const vars = existsSync(".dev.vars")
  ? Object.fromEntries(
      readFileSync(".dev.vars", "utf8")
        .split("\n")
        .filter((l) => /^\w+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    )
  : {};
const BOT_TOKEN = process.env.BOT_TOKEN ?? vars.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Set BOT_TOKEN (env or .dev.vars)");
  process.exit(1);
}

let failed = 0;
let passed = 0;
function assert(ok, label) {
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
}

async function post(path, body) {
  const res = await fetch(new URL(path, url), {
    method: "POST",
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const BOT = "Page Check";
const run = Date.now().toString(36);
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
// Yesterday at noon local time, so it's on the Yesterday tab in any timezone.
const yesterday = new Date(now - 86_400_000);
yesterday.setHours(12, 0, 0, 0);

const text = {
  running: `Page check ${run}: running`,
  finished: `Page check ${run}: finished`,
  old: `Page check ${run}: yesterday`,
  ask: `Page check ${run}: approve?`,
  hidden: `[TEST] page check ${run}`,
};
// Lower-case bot name on purpose: the page should still see one "Page Check".
await post("/api/activity", { bot: BOT, text: text.running, status: "in_progress", at: iso(3 * 60_000) });
await post("/api/activity", { bot: "page check", text: text.finished, status: "finished", at: iso(60_000) });
await post("/api/activity", { bot: BOT, text: text.old, status: "finished", at: yesterday.toISOString() });
await post("/api/items", { bot: BOT, title: text.ask, type: "approval" });
await post("/api/activity", { bot: BOT, text: text.hidden, status: "in_progress" });
console.log(`Page check against ${url} at ${new Date().toISOString()}, run ${run}\n`);

const has = (sel, s) => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? "").includes(${JSON.stringify(s)})`;
const click = (sel) => `document.querySelector(${JSON.stringify(sel)}).click()`;

await withInbox({ url }, async (page) => {
  const ev = page.evaluate;

  console.log("== All days, all bots");
  assert(await ev(has("#activity-list", text.running)), "in_progress activity is on the In progress tab");
  assert(!(await ev(has("#activity-list", text.finished))), "finished activity isn't on the In progress tab");
  for (const k of ["running", "finished", "old", "ask"]) {
    assert(await ev(has("#timeline", k === "ask" ? `Asked: ${text.ask}` : text[k])), `timeline has the ${k} entry`);
  }
  assert(
    await ev(`[...document.querySelectorAll("#timeline .tl-entry")].some((li) =>
      li.textContent.includes(${JSON.stringify(text.running)}) && li.querySelector(".tag.running"))`),
    "the running entry is tagged Running",
  );
  const times = await ev(`[...document.querySelectorAll("#timeline .tl-time")].map((t) => t.dateTime)`);
  assert(
    times.length > 0 && times.every((t, i) => i === 0 || times[i - 1] >= t),
    `timeline is newest first across activity and events (${times.length} entries)`,
  );
  assert(!(await ev(has("body", text.hidden))), "[TEST] activity is nowhere on the page");
  const botNames = await ev(`[...document.querySelector("#bot-filter").options].map((o) => o.value)`);
  assert(botNames.filter((b) => b.toLowerCase() === "page check").length === 1, "one Page Check in the bot filter");

  await ev(click('#activity-tabs [data-tab="finished"]'));
  assert(await ev(has("#activity-list", text.finished)), "finished activity is on the Finished tab");
  assert(await ev(has("#activity-list", text.old)), "All shows yesterday's finished entry too");

  console.log("\n== Date tabs");
  await ev(click(`#date-tabs [data-day]:nth-child(2)`)); // Today
  assert(await ev(has("#timeline", text.finished)), "Today: timeline has today's entry");
  assert(!(await ev(has("#timeline", text.old))), "Today: timeline leaves out yesterday's entry");
  assert(!(await ev(has("#activity-list", text.old))), "Today: Finished leaves out yesterday's entry");
  await ev(click(`#date-tabs [data-day]:nth-child(3)`)); // Yesterday
  assert(await ev(has("#timeline", text.old)), "Yesterday: timeline has yesterday's entry");
  assert(!(await ev(has("#timeline", text.finished))), "Yesterday: timeline leaves out today's entry");
  assert(await ev(has("#activity-list", text.old)), "Yesterday: Finished has yesterday's entry");
  await ev(click('#activity-tabs [data-tab="in_progress"]'));
  assert(await ev(has("#activity-list", text.running)), "In progress ignores the date tab (it's running now)");
  await ev(click(`#date-tabs [data-day="all"]`));

  console.log("\n== Bot filter");
  const pick = (bot) =>
    ev(`(() => { const s = document.querySelector("#bot-filter"); s.value = ${JSON.stringify(bot)};
      s.dispatchEvent(new Event("change")); return s.value; })()`);
  assert((await pick(BOT)) === BOT, "Page Check can be picked");
  const bots = await ev(`[...document.querySelectorAll("#timeline .tl-text .bot")].map((b) => b.textContent)`);
  assert(bots.length >= 4 && bots.every((b) => b === BOT), `timeline shows only Page Check (${bots.length} entries)`);
  assert(await ev(has("#activity-list", text.running)), "In progress still has the entry");
  const other = botNames.find((b) => b && b !== BOT);
  if (other) {
    await pick(other);
    assert(!(await ev(has("#timeline", run))), `filtered to ${other}: no Page Check entries in the timeline`);
    assert(!(await ev(has("#activity-list", run))), `filtered to ${other}: none in In progress`);
  }
});

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nAll ${passed} page checks passed`);
process.exit(failed ? 1 : 0);
