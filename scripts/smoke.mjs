// Smoke-test a running agent-inbox (default: local `wrangler dev`).
// Usage: node scripts/smoke.mjs [base-url]
// Reads BOT_TOKEN / INBOX_SECRET / FORWARD_WEBHOOK_* / FORWARD_SIGNING_SECRET from
// the environment, else from .dev.vars. If FORWARD_WEBHOOK_URL points at
// 127.0.0.1 or localhost, it starts a receiver there and checks that each
// forwarded action arrives with the right signature and Bearer headers.
// Tokens are only ever sent as headers, never printed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const vars = existsSync(".dev.vars")
  ? Object.fromEntries(
      readFileSync(".dev.vars", "utf8")
        .split("\n")
        .filter((l) => /^\w+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    )
  : {};
const env = (name) => process.env[name] ?? vars[name];
const BOT_TOKEN = env("BOT_TOKEN");
const INBOX_SECRET = env("INBOX_SECRET");
const HOOK_URL = env("FORWARD_WEBHOOK_URL");
const HOOK_KEY = env("FORWARD_WEBHOOK_KEY");
const SIGNING_SECRET = env("FORWARD_SIGNING_SECRET");
if (!BOT_TOKEN || !INBOX_SECRET) {
  console.error("Set BOT_TOKEN and INBOX_SECRET (env or .dev.vars)");
  process.exit(1);
}

let failed = 0;
let passed = 0;
function assert(ok, label) {
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
}

async function check(label, method, path, { token, body, expect = 200 } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const ok = res.status === expect;
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${method} ${path} -> ${res.status} (want ${expect}) ${label}`);
  console.log(`     ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// --- local webhook receiver ----------------------------------------------

const received = [];
let server;
if (HOOK_URL && ["127.0.0.1", "localhost"].includes(new URL(HOOK_URL).hostname)) {
  const { port, pathname } = new URL(HOOK_URL);
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      // Signed with FORWARD_SIGNING_SECRET if it's set (and differs from the
      // key), else no signature header at all. The Bearer key is separate.
      const header = req.headers["x-agent-inbox-signature"];
      const signs = SIGNING_SECRET && SIGNING_SECRET !== HOOK_KEY;
      const want = signs ? `sha256=${createHmac("sha256", SIGNING_SECRET).update(raw).digest("hex")}` : null;
      const signed = want
        ? typeof header === "string" && header.length === want.length && timingSafeEqual(Buffer.from(header), Buffer.from(want))
        : header === undefined;
      const bearer = req.headers.authorization === (HOOK_KEY ? `Bearer ${HOOK_KEY}` : undefined);
      received.push({ path: req.url, signed, bearer, body: JSON.parse(raw) });
      res.writeHead(req.url === pathname ? 200 : 404).end();
    });
  });
  await new Promise((r) => server.listen(Number(port), "127.0.0.1", r));
  console.log(`Webhook receiver listening on ${HOOK_URL}`);
}

console.log(`Smoke test against ${base} at ${new Date().toISOString()}\n`);

// --- page and auth --------------------------------------------------------

console.log("== Page and auth");
const page = await check("inbox page", "GET", "/");
assert(typeof page === "string" && page.includes("<title>Agent Inbox</title>"), "page has <title>Agent Inbox</title>");
await check("page script", "GET", "/app.js");
await check("no auth", "POST", "/api/items", { body: { bot: "smoke", title: "x" }, expect: 401 });
await check("bot token refused on inbox list", "GET", "/api/inbox/items", { token: BOT_TOKEN, expect: 401 });

// --- item types -----------------------------------------------------------

console.log("\n== Item types");
const run = Date.now().toString(36);
const created = await check("bot creates an approval item", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", title: "Smoke test: approve deploy", type: "approval", links: ["https://example.com/pr/1"] },
  expect: 201,
});
const id = created.item.id;
assert(created.item.type === "approval", "item.type is approval");
for (const type of ["yes_no", "reply", "sign", "due_today"]) {
  const r = await check(`type ${type}`, "POST", "/api/items", {
    token: BOT_TOKEN,
    body: { bot: "smoke-bot", title: `type ${type}`, type, external_key: `type-${type}-${run}` },
    expect: 201,
  });
  assert(r.item?.type === type, `stored as ${type}`);
}
await check("label form is refused", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", title: "x", type: "Yes/no" },
  expect: 400,
});
await check("unknown type is refused", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", title: "x", type: "urgent" },
  expect: 400,
});
const patched = await check("PATCH type", "PATCH", `/api/items/${id}`, { token: BOT_TOKEN, body: { type: "sign" } });
assert(patched.item?.type === "sign", "PATCH changed type to sign");
await check("PATCH bad type", "PATCH", `/api/items/${id}`, { token: BOT_TOKEN, body: { type: "Sign" }, expect: 400 });
await check("PATCH can't set status rejected", "PATCH", `/api/items/${id}`, {
  token: BOT_TOKEN,
  body: { status: "rejected" },
  expect: 400,
});

// --- reply, reject, snooze, done -----------------------------------------

console.log("\n== Card actions: Reply, Reject, Snooze, Done");
await check("bot token can't reply", "POST", `/api/inbox/items/${id}/reply`, {
  token: BOT_TOKEN,
  body: { text: "x" },
  expect: 401,
});
await check("bot token can't reject", "POST", `/api/inbox/items/${id}/reject`, { token: BOT_TOKEN, expect: 401 });
const reply = await check("reply", "POST", `/api/inbox/items/${id}/reply`, {
  token: INBOX_SECRET,
  body: { text: "looks good, ship it" },
});
assert(reply.event?.type === "reply" && reply.event.payload.text === "looks good, ship it", "reply event carries the text");
assert(reply.item?.status === "waiting", "reply keeps the item waiting");
await check("reply needs text", "POST", `/api/inbox/items/${id}/reply`, { token: INBOX_SECRET, body: {}, expect: 400 });
await check("older note route still works", "POST", `/api/inbox/items/${id}/note`, {
  token: INBOX_SECRET,
  body: { note: "and bump the version" },
});
await check("snooze", "POST", `/api/inbox/items/${id}/snooze`, { token: INBOX_SECRET, body: { minutes: 60 } });
const waitingNow = await check("waiting list", "GET", "/api/inbox/items?view=waiting", { token: INBOX_SECRET });
assert(!waitingNow.items.some((i) => i.id === id), "snoozed item is not in waiting");
const snoozedNow = await check("view=snoozed (inbox)", "GET", "/api/inbox/items?view=snoozed", { token: INBOX_SECRET });
assert(snoozedNow.items.some((i) => i.id === id), "snoozed item is in view=snoozed");
const botSnoozed = await check("view=snoozed (bot)", "GET", "/api/items?view=snoozed&bot=smoke-bot", { token: BOT_TOKEN });
assert(botSnoozed.items.some((i) => i.id === id), "bot list view=snoozed has it");
await check("done", "POST", `/api/inbox/items/${id}/done`, { token: INBOX_SECRET });

console.log("\n== Status guard");
const again = await check("done again", "POST", `/api/inbox/items/${id}/done`, { token: INBOX_SECRET, expect: 409 });
assert(again.error === "item is already done" && again.item?.status === "done", "409 says it's already done, with the item");
await check("reject a done item", "POST", `/api/inbox/items/${id}/reject`, { token: INBOX_SECRET, expect: 409 });
await check("snooze a done item", "POST", `/api/inbox/items/${id}/snooze`, { token: INBOX_SECRET, body: { minutes: 5 }, expect: 409 });
const botAgain = await check("bot marks a done item done (idempotent)", "POST", `/api/items/${id}/done`, { token: BOT_TOKEN });
assert(botAgain.item?.status === "done", "bot re-done returns the item, still done");
const lateReply = await check("reply on a done item", "POST", `/api/inbox/items/${id}/reply`, {
  token: INBOX_SECRET,
  body: { text: "thanks, all good" },
});
assert(lateReply.item?.status === "done" && lateReply.event?.type === "reply", "late reply is a note; item stays done");

const rej = await check("bot creates a second item", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", title: "Smoke test: buy more ink?", type: "yes_no" },
  expect: 201,
});
const rejected = await check("reject", "POST", `/api/inbox/items/${rej.item.id}/reject`, {
  token: INBOX_SECRET,
  body: { note: "we have spares" },
});
assert(rejected.item?.status === "rejected" && rejected.event?.type === "rejected", "status rejected + rejected event");
await check("done on a rejected item", "POST", `/api/inbox/items/${rej.item.id}/done`, { token: INBOX_SECRET, expect: 409 });
await check("bot done on a rejected item", "POST", `/api/items/${rej.item.id}/done`, { token: BOT_TOKEN, expect: 409 });
const inboxRejected = await check("view=rejected (inbox)", "GET", "/api/inbox/items?view=rejected", { token: INBOX_SECRET });
assert(inboxRejected.items.some((i) => i.id === rej.item.id), "inbox view=rejected has it");
const botRejected = await check("view=rejected (bot)", "GET", "/api/items?view=rejected&bot=smoke-bot", { token: BOT_TOKEN });
assert(botRejected.items.some((i) => i.id === rej.item.id), "bot view=rejected has it");
const botWaiting = await check("view=waiting (bot)", "GET", "/api/items?bot=smoke-bot", { token: BOT_TOKEN });
assert(!botWaiting.items.some((i) => i.id === rej.item.id), "rejected item is not waiting");

const detail = await check("event log", "GET", `/api/items/${id}`, { token: BOT_TOKEN });
const types = detail.events.map((e) => e.type).join(",");
assert(types === "created,updated,reply,note,snoozed,done,reply", `event log: ${types}`);

// --- activity -------------------------------------------------------------

console.log("\n== Activity");
const key = `smoke-${run}`;
await check("activity needs BOT_TOKEN to post", "POST", "/api/activity", {
  token: INBOX_SECRET,
  body: { bot: "smoke-bot", text: "x", status: "finished" },
  expect: 401,
});
await check("bad status", "POST", "/api/activity", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", text: "x", status: "done" },
  expect: 400,
});
const started = await check("in_progress (new)", "POST", "/api/activity", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", text: "Running the smoke test", status: "in_progress", external_key: key },
  expect: 201,
});
await check("same post again", "POST", "/api/activity", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", text: "Running the smoke test", status: "in_progress", external_key: key },
  expect: 200,
});
const finished = await check("finished (update)", "POST", "/api/activity", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", text: "Smoke test passed", status: "finished", external_key: key },
  expect: 200,
});
assert(finished.activity?.id === started.activity?.id && finished.activity.status === "finished", "same entry moved to finished");
await check("explicit at", "POST", "/api/activity", {
  token: BOT_TOKEN,
  body: { bot: "smoke-bot", text: "Backfilled entry", status: "finished", at: "2026-01-02T03:04:05Z" },
  expect: 201,
});
const byBot = await check("GET with bot token, bot filter", "GET", "/api/activity?bot=smoke-bot", { token: BOT_TOKEN });
assert(byBot.activity.every((a) => a.bot === "smoke-bot") && byBot.activity.some((a) => a.id === started.activity.id), "bot filter");
const recent = await check("GET since filter", "GET", "/api/activity?bot=smoke-bot&since=2026-01-03", { token: BOT_TOKEN });
assert(!recent.activity.some((a) => a.text === "Backfilled entry"), "since filter drops the older entry");
await check("GET with inbox secret", "GET", "/api/activity?bot=smoke-bot", { token: INBOX_SECRET });
await check("GET without auth", "GET", "/api/activity", { expect: 401 });
await check("bad since", "GET", "/api/activity?since=yesterday", { token: BOT_TOKEN, expect: 400 });

console.log("\n== Timeline feed");
const tl = await check("inbox events", "GET", "/api/inbox/events?bot=smoke-bot", { token: INBOX_SECRET });
assert(tl.events.some((e) => e.type === "rejected") && tl.events.some((e) => e.type === "reply"), "timeline has reply and rejected");
await check("bot token refused", "GET", "/api/inbox/events", { token: BOT_TOKEN, expect: 401 });

// --- test data and bot names ---------------------------------------------

console.log("\n== Test data");
const tbot = `smoke-test-${run}`;
const byPrefix = await check("[TEST] title", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: tbot, title: "[TEST] smoke prefix" },
  expect: 201,
});
const byFlag = await check("test: true", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: tbot, title: "Smoke flagged", test: true },
  expect: 201,
});
const realItem = await check("ordinary item", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: tbot, title: "Smoke real" },
  expect: 201,
});
assert(byPrefix.item.is_test && byFlag.item.is_test && !realItem.item.is_test, "is_test set by prefix and by test: true only");
await check("test must be boolean", "POST", "/api/items", { token: BOT_TOKEN, body: { bot: tbot, title: "x", test: "yes" }, expect: 400 });
const testAct = await check("[TEST] activity", "POST", "/api/activity", {
  token: BOT_TOKEN,
  body: { bot: tbot, text: "[TEST] smoke activity", status: "in_progress" },
  expect: 201,
});
assert(testAct.activity.is_test === true, "activity is_test by prefix");
const testReply = await check("reply on a test item", "POST", `/api/inbox/items/${byFlag.item.id}/reply`, {
  token: INBOX_SECRET,
  body: { text: "smoke test reply" },
});
const ids = (list) => list.map((x) => x.id);
const testIds = [byPrefix.item.id, byFlag.item.id];
const botItems = await check("bot list hides test items", "GET", `/api/items?bot=${tbot}`, { token: BOT_TOKEN });
assert(ids(botItems.items).join() === realItem.item.id, "GET /api/items: only the real item");
const botItemsAll = await check("bot list include_test=1", "GET", `/api/items?bot=${tbot}&include_test=1`, { token: BOT_TOKEN });
assert(testIds.every((i) => ids(botItemsAll.items).includes(i)), "GET /api/items?include_test=1: test items too");
const inboxItems = await check("inbox list hides test items", "GET", "/api/inbox/items?view=all", { token: INBOX_SECRET });
assert(!testIds.some((i) => ids(inboxItems.items).includes(i)), "GET /api/inbox/items: no test items");
const inboxAll = await check("inbox list include_test=1", "GET", "/api/inbox/items?view=all&include_test=1", { token: INBOX_SECRET });
assert(testIds.every((i) => ids(inboxAll.items).includes(i)), "GET /api/inbox/items?include_test=1: test items too");
const acts = await check("activity hides test entries", "GET", `/api/activity?bot=${tbot}`, { token: BOT_TOKEN });
assert(acts.activity.length === 0, "GET /api/activity: no test entries");
const actsAll = await check("activity include_test=1", "GET", `/api/activity?bot=${tbot}&include_test=1`, { token: INBOX_SECRET });
assert(ids(actsAll.activity).includes(testAct.activity.id), "GET /api/activity?include_test=1: test entry too");
const tlHidden = await check("timeline hides test items' events", "GET", `/api/inbox/events?bot=${tbot}`, { token: INBOX_SECRET });
assert(tlHidden.events.every((e) => e.item_id === realItem.item.id), "GET /api/inbox/events: only the real item's events");
const tlAll = await check("timeline include_test=1", "GET", `/api/inbox/events?bot=${tbot}&include_test=1`, { token: INBOX_SECRET });
assert(tlAll.events.some((e) => e.id === testReply.event.id), "GET /api/inbox/events?include_test=1: the test reply");
const feedHidden = await check("event feed hides it", "GET", `/api/events?since=${testReply.event.id - 1}`, { token: BOT_TOKEN });
assert(!feedHidden.events.some((e) => e.event_id === testReply.event.id), "GET /api/events: no test reply");
const feedAll = await check("event feed include_test=1", "GET", `/api/events?since=${testReply.event.id - 1}&include_test=1`, {
  token: BOT_TOKEN,
});
assert(feedAll.events.some((e) => e.event_id === testReply.event.id), "GET /api/events?include_test=1: the test reply");

console.log("\n== Bot names");
const ubot = `Smoke-Canon-${run}`;
await check("unknown bot, first post", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: ubot, title: "first casing", test: true },
  expect: 201,
});
const second = await check("unknown bot, other casing", "POST", "/api/items", {
  token: BOT_TOKEN,
  body: { bot: ubot.toUpperCase(), title: "second casing", test: true },
  expect: 201,
});
assert(second.item.bot === ubot, `${ubot.toUpperCase()} stored as ${second.item.bot}`);
const ci = await check("?bot= any casing", "GET", `/api/items?bot=${ubot.toLowerCase()}&include_test=1`, { token: BOT_TOKEN });
assert(ci.items.length === 2 && ci.items.every((i) => i.bot === ubot), "?bot= lower case finds both under one name");

// --- dashboard ------------------------------------------------------------

console.log("\n== Dashboard (the page's one request)");
await check("no auth", "GET", "/api/inbox/dashboard", { expect: 401 });
await check("bot token refused", "GET", "/api/inbox/dashboard", { token: BOT_TOKEN, expect: 401 });
const dash = await check("dashboard", "GET", "/api/inbox/dashboard", { token: INBOX_SECRET });
const lists = ["waiting", "snoozed", "done", "rejected", "activity", "events"];
assert(lists.every((k) => Array.isArray(dash[k])), `has ${lists.join(", ")}`);
console.log(`     sizes: ${lists.map((k) => `${k}=${dash[k].length}`).join(" ")} since=${dash.since}`);
assert(dash.done.some((i) => i.id === id) && dash.rejected.some((i) => i.id === rej.item.id), "done and rejected have the smoke items");
assert(dash.waiting.some((i) => i.id === realItem.item.id), "waiting has the ordinary item");
assert(dash.events.some((e) => e.id === reply.event.id && e.bot === "smoke-bot"), "events have the smoke reply, with its bot");
assert(dash.activity.some((a) => a.id === started.activity.id), "activity has the smoke entry");
assert(dash.events.every((e) => e.at >= dash.since) && !dash.events.some((e) => e.type === "updated"), "events: last 7 days, no edits");
assert(
  dash.events.length <= 200 && dash.done.length <= 100 && dash.rejected.length <= 100 && dash.activity.length <= 250,
  "within the caps",
);
assert(!testIds.some((i) => ids(dash.waiting).includes(i)) && !ids(dash.activity).includes(testAct.activity.id), "test rows hidden");
assert(!dash.events.some((e) => e.id === testReply.event.id), "test item's events hidden");
const dashAll = await check("dashboard include_test=1", "GET", "/api/inbox/dashboard?include_test=1", { token: INBOX_SECRET });
assert(testIds.every((i) => ids(dashAll.waiting).includes(i)), "include_test=1: test items");
assert(ids(dashAll.activity).includes(testAct.activity.id) && dashAll.events.some((e) => e.id === testReply.event.id), "include_test=1: test activity and events");

// --- forwarding -----------------------------------------------------------

console.log("\n== Forwarding");
const feed = await check("GET /api/events", "GET", `/api/events?since=${reply.event.id - 1}`, { token: BOT_TOKEN });
const actions = feed.events.filter((e) => e.item_id === id || e.item_id === rej.item.id).map((e) => e.action);
assert(actions.join(",") === "reply,note,snoozed,done,reply,rejected", `forwarded actions: ${actions.join(",")}`);
const fwdReply = feed.events.find((e) => e.action === "reply" && e.item_id === id);
assert(fwdReply?.text === "looks good, ship it", "forwarded reply has text");
if (server) {
  await sleep(500); // deliveries are sent after the response
  const mine = received.filter((r) => r.body.item_id === id || r.body.item_id === rej.item.id);
  console.log(`     received: ${JSON.stringify(mine.map((r) => ({ action: r.body.action, text: r.body.text, note: r.body.note, signed: r.signed, bearer: r.bearer })))}`);
  const how = `${SIGNING_SECRET ? "signed with FORWARD_SIGNING_SECRET" : "unsigned"}, ${HOOK_KEY ? "Bearer FORWARD_WEBHOOK_KEY" : "no Bearer"}`;
  assert(mine.length === 6, `webhook got 6 events (the 409s sent nothing): ${mine.length}`);
  assert(mine.every((r) => r.signed && r.bearer), `every request ${how}`);
  assert(mine.some((r) => r.body.action === "reply" && r.body.text === "looks good, ship it"), "webhook got the reply");
  assert(mine.some((r) => r.body.action === "rejected" && r.body.note === "we have spares"), "webhook got the rejected");
  const after = await check("delivery status", "GET", `/api/events?since=${reply.event.id - 1}`, { token: BOT_TOKEN });
  const ours = after.events.filter((e) => e.item_id === id || e.item_id === rej.item.id);
  assert(ours.every((e) => e.delivery.status === "delivered"), "all delivered");
  server.close();
} else {
  console.log("SKIP webhook receiver (FORWARD_WEBHOOK_URL is not local)");
}

console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nAll ${passed} smoke checks passed`);
process.exit(failed ? 1 : 0);
