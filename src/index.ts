// agent-inbox: one inbox for everything your bots are waiting on you for.
//
// Bot API (Authorization: Bearer BOT_TOKEN)
//   POST /api/items              create an item, or update it if bot + external_key exists
//   GET  /api/items?view=&bot=&since=   list items, each with its latest_event
//   GET  /api/items/:id          read an item and its events
//   PATCH /api/items/:id         update title, note, links, type and/or test
//   POST /api/items/:id/done     mark an item done (a no-op 200 if it already is,
//                                409 if you rejected it)
//   GET  /api/events?since=&limit=   forwarded inbox actions, oldest first, with delivery status
//   POST /api/activity           log what a bot is doing (in_progress) or did (finished)
//   GET  /api/activity?since=&bot=   activity entries, newest first (the inbox may read it too)
//
// Bot names are canonicalized on write (canonicalBot) and ?bot= matches any
// casing. Rows posted with test: true or a "[TEST]" title/text are flagged
// is_test and left out of every list route unless it gets ?include_test=1.
//
// Inbox API, used by the page in public/. Accepts the passkey session cookie
// (see passkeys.ts) or, as a fallback, Authorization: Bearer INBOX_SECRET.
//   GET  /api/inbox/dashboard            everything the page shows, in one D1 batch
//   GET  /api/inbox/items?view=waiting|done|snoozed|rejected|all
//   GET  /api/inbox/events?since=&bot=   recent events on every item, for the timeline
//   POST /api/inbox/items/:id/done
//   POST /api/inbox/items/:id/reject   { note? }
//   POST /api/inbox/items/:id/reply    { text }
//   POST /api/inbox/items/:id/snooze   { minutes } or { until }
//   POST /api/inbox/items/:id/note     { note }   (older form of reply, kept for API users)
//
// Done and reject apply to waiting or snoozed items, snooze to waiting ones;
// anything else is a 409 that records nothing (see TRANSITIONS). Reply and note
// work on any item and never change its status.
//
// Every inbox action writes an event and a pending delivery in one batch. If
// FORWARD_WEBHOOK_URL is set it is POSTed there right away (with
// FORWARD_WEBHOOK_KEY as a Bearer token and an HMAC signature keyed with
// FORWARD_SIGNING_SECRET), and a cron every minute retries failures with backoff.

import { HttpError, json, nowIso, readJson } from "./http";
import { authRoute, hasSession } from "./passkeys";

type Status = "waiting" | "done" | "snoozed" | "rejected";
type Link = { url: string; label?: string };

// What kind of answer an item needs. Stored as these slugs; the page shows
// them as Approval, Yes/no, Reply, Sign and Due today.
const ITEM_TYPES = ["approval", "yes_no", "reply", "sign", "due_today"] as const;
type ItemType = (typeof ITEM_TYPES)[number];

const VIEWS = ["waiting", "done", "snoozed", "rejected", "all"];

// The statuses each status change may start from. A closed item (done or
// rejected) stays closed, and a snoozed one can't be snoozed again until it
// wakes. Snoozes that are due are woken in the same batch, so they count as waiting.
const TRANSITIONS = {
  done: ["waiting", "snoozed"],
  rejected: ["waiting", "snoozed"],
  snoozed: ["waiting"],
} satisfies Record<string, Status[]>;
type Transition = keyof typeof TRANSITIONS;

type ItemRow = {
  id: string;
  bot: string;
  title: string;
  status: Status;
  type: ItemType | null;
  note: string | null;
  links: string;
  snooze_until: string | null;
  external_key: string | null;
  is_test: number;
  created_at: string;
  updated_at: string;
};

type ActivityStatus = "in_progress" | "finished";

type ActivityRow = {
  id: string;
  bot: string;
  text: string;
  status: ActivityStatus;
  external_key: string | null;
  is_test: number;
  at: string;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: number;
  item_id: string;
  type: string;
  payload: string;
  at: string;
};

const LIMITS = { bot: 64, title: 500, note: 5000, links: 20, url: 2000, label: 200, externalKey: 200 };
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;
const FORWARD_TIMEOUT_MS = 5000;
const FORWARD_MAX_ATTEMPTS = 10; // retries back off 1, 2, 4 … 256 min, ~8.5 h in all; also in migrations/0009
const FORWARD_BACKOFF_MS = 60_000;
const RETRY_BATCH = 15; // keeps a cron run under the free plan's 50 subrequests
const EVENTS_PAGE = 100;
const TIMELINE_DAYS = 14; // default window for GET /api/inbox/events
const TIMELINE_LIMIT = 1000;
const LIST_LIMIT = 500;
// GET /api/inbox/dashboard: a 7-day window, and caps so a load reads a bounded
// number of rows however long the inbox has been running.
const DASHBOARD_DAYS = 7;
const DASHBOARD_LIMITS = { events: 200, activity: 200, running: 50, closed: 100 };
// The event types the page's timeline shows; edits and wake-ups are noise there.
const TIMELINE_TYPES = ["created", "done", "rejected", "reply", "note", "snoozed"];
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000; // how far ahead an activity `at` may be
// Ceilings on what the bot token can write, so a leaked token can't fill D1.
// New items and activity entries count across all bots over the last 24
// hours; events count per item (a PATCH loop would otherwise grow one item
// forever). Past a cap the write is a 429 and nothing is stored.
const WRITE_CAPS = { itemsPerDay: 2000, activityPerDay: 5000, eventsPerItem: 1000 };
const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_PREFIX = "[TEST]";


type Actor = "passkey" | "inbox_secret";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error("unhandled error", err);
      return json({ error: "internal error" }, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await retryDeliveries(env);
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  const method = request.method;
  // Test rows are left out of every list unless asked for.
  const includeTest = ["1", "true"].includes(searchParams.get("include_test") ?? "");
  let m: RegExpMatchArray | null;

  if (pathname === "/api/items" && method === "POST") {
    await requireAuth(request, env.BOT_TOKEN, "BOT_TOKEN");
    return createItem(env, await readJson(request));
  }
  if (pathname === "/api/items" && method === "GET") {
    await requireAuth(request, env.BOT_TOKEN, "BOT_TOKEN");
    return listItems(env, searchParams.get("view") ?? "waiting", {
      bot: searchParams.get("bot"),
      since: searchParams.get("since"),
      includeTest,
      latest: true,
    });
  }
  if ((m = pathname.match(/^\/api\/items\/([^/]+)$/)) && method === "GET") {
    await requireAuth(request, env.BOT_TOKEN, "BOT_TOKEN");
    return getItem(env, m[1]);
  }
  if ((m = pathname.match(/^\/api\/items\/([^/]+)$/)) && method === "PATCH") {
    await requireAuth(request, env.BOT_TOKEN, "BOT_TOKEN");
    return patchItem(env, m[1], await readJson(request));
  }
  if ((m = pathname.match(/^\/api\/items\/([^/]+)\/done$/)) && method === "POST") {
    await requireAuth(request, env.BOT_TOKEN, "BOT_TOKEN");
    const body = await readJson(request, true);
    const note = optionalString(body.note, "note", LIMITS.note);
    const { item, event } = await changeStatus(env, m[1], "done", { source: "bot", ...(note ? { note } : {}) });
    // A bot retrying /done gets the item back unchanged; an item you rejected stays rejected.
    if (!event && item.status !== "done") return conflict(item);
    return json({ item: toItem(item) });
  }
  if (pathname === "/api/events" && method === "GET") {
    await requireAuth(request, env.BOT_TOKEN, "BOT_TOKEN");
    return listEvents(env, searchParams.get("since"), searchParams.get("limit"), includeTest);
  }
  if (pathname === "/api/activity" && method === "POST") {
    await requireAuth(request, env.BOT_TOKEN, "BOT_TOKEN");
    return postActivity(env, await readJson(request));
  }
  if (pathname === "/api/activity" && method === "GET") {
    await requireBotOrInbox(request, env);
    return listActivity(env, searchParams.get("since"), searchParams.get("bot"), includeTest);
  }

  if (pathname === "/api/inbox/dashboard" && method === "GET") {
    await requireInbox(request, env);
    return dashboard(env, includeTest);
  }
  if (pathname === "/api/inbox/items" && method === "GET") {
    await requireInbox(request, env);
    return listItems(env, searchParams.get("view") ?? "waiting", { includeTest });
  }
  if (pathname === "/api/inbox/events" && method === "GET") {
    await requireInbox(request, env);
    return listTimelineEvents(env, searchParams.get("since"), searchParams.get("bot"), includeTest);
  }
  if (
    (m = pathname.match(/^\/api\/inbox\/items\/([^/]+)\/(done|reject|reply|snooze|note)$/)) &&
    method === "POST"
  ) {
    const actor = await requireInbox(request, env);
    const body = await readJson(request, true);
    return inboxAction(env, ctx, m[1], m[2] as InboxAction, body, actor);
  }

  if (pathname.startsWith("/api/auth/")) {
    await limitAuth(request, env);
    const res = await authRoute(request, env, pathname);
    if (res) return res;
  }

  if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
  return new Response("Not found", { status: 404 });
}

// --- auth ---------------------------------------------------------------

// Secrets are compared online with no lockout, so a short or placeholder value
// is refused outright rather than left for someone to guess.
const MIN_SECRET_LENGTH = 32;

function weakSecret(secret: string): boolean {
  return secret.length < MIN_SECRET_LENGTH || secret.toLowerCase().startsWith("change-me");
}

async function requireAuth(request: Request, secret: string | undefined, name: string) {
  if (!secret) {
    console.error(`${name} is not set; rejecting request`);
    throw new HttpError(503, `server not configured: ${name} is not set`);
  }
  if (weakSecret(secret)) {
    console.error(`${name} is too weak; rejecting request`);
    throw new HttpError(
      503,
      `server not configured: ${name} must be at least ${MIN_SECRET_LENGTH} random characters (try openssl rand -hex 32)`,
    );
  }
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !(await safeEqual(token, secret))) throw new HttpError(401, "unauthorized");
}

// A passkey session cookie, or the INBOX_SECRET bearer token as a fallback.
// INBOX_SECRET is optional once a passkey is set up, so its absence is a 401
// (the page then offers passkey sign-in) rather than a 503. Returns which one
// was used, recorded as the actor on inbox events.
async function requireInbox(request: Request, env: Env): Promise<Actor> {
  if (await hasSession(request, env)) return "passkey";
  if (!env.INBOX_SECRET) throw new HttpError(401, "unauthorized");
  // Bots must never get inbox actions such as snooze, so a shared value is refused.
  if (env.INBOX_SECRET === env.BOT_TOKEN) {
    console.error("INBOX_SECRET equals BOT_TOKEN; refusing it, use a passkey or a different value");
    throw new HttpError(401, "unauthorized");
  }
  await requireAuth(request, env.INBOX_SECRET, "INBOX_SECRET");
  return "inbox_secret";
}

// Read-only routes shared by bots and the page: BOT_TOKEN, else inbox auth.
async function requireBotOrInbox(request: Request, env: Env) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token && env.BOT_TOKEN && !weakSecret(env.BOT_TOKEN) && (await safeEqual(token, env.BOT_TOKEN))) return;
  await requireInbox(request, env);
}

// The passkey routes take no auth and write challenges to D1, so each client
// IP gets a fixed number of calls a minute (AUTH_LIMITER in wrangler.jsonc).
async function limitAuth(request: Request, env: Env) {
  if (!env.AUTH_LIMITER) return;
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.AUTH_LIMITER.limit({ key });
  if (!success) throw new HttpError(429, "too many sign-in requests; try again in a minute");
}

// Hash both sides first so the comparison is constant-time regardless of length.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// --- handlers -----------------------------------------------------------

async function createItem(env: Env, body: Record<string, unknown>): Promise<Response> {
  const title = requiredString(body.title, "title", LIMITS.title);
  const note = optionalString(body.note, "note", LIMITS.note);
  const links = parseLinks(body.links);
  const type = parseType(body.type);
  const isTest = parseTest(body.test, title);
  const status = body.status ?? "waiting";
  if (status !== "waiting" && status !== "done") {
    throw new HttpError(400, "status must be 'waiting' or 'done'");
  }
  const externalKey = optionalString(body.external_key, "external_key", LIMITS.externalKey);
  if (body.external_key != null && !externalKey) {
    throw new HttpError(400, "external_key must be a non-empty string");
  }
  const bot = await canonicalBot(env, requiredString(body.bot, "bot", LIMITS.bot));

  // Re-posting the same bot + external_key updates that item instead. status
  // only applies on create, so a re-post never reopens an item you closed.
  if (externalKey) {
    const existing = await env.DB.prepare("SELECT * FROM items WHERE bot = ? AND external_key = ?")
      .bind(bot, externalKey)
      .first<ItemRow>();
    if (existing) {
      return json({ item: toItem(await updateFields(env, existing, { title, note, links, type, isTest })) });
    }
  }

  await checkDailyCap(env, "items", WRITE_CAPS.itemsPerDay);
  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO items (id, bot, title, status, type, note, links, external_key, is_test, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, bot, title, status, type, note, JSON.stringify(links), externalKey, isTest ? 1 : 0, now, now),
      insertEvent(env, id, "created", { bot, title, status, ...(type ? { type } : {}) }, now),
    ]);
  } catch (err) {
    // A concurrent POST with the same external_key won the insert; update it instead.
    if (externalKey && String(err).includes("UNIQUE constraint failed")) return createItem(env, body);
    throw err;
  }
  return json({ item: toItem(await loadItem(env, id)) }, 201);
}

// Sets whichever of title/note/links/type differ from the row and logs an
// "updated" event with the new values. Unchanged input is a no-op, so a bot
// can re-sync without bumping updated_at or burying your replies in events.
// The test flag only ever turns on: an item once marked test stays test.
async function updateFields(
  env: Env,
  row: ItemRow,
  changes: { title?: string; note?: string | null; links?: Link[]; type?: ItemType | null; isTest?: boolean },
): Promise<ItemRow> {
  const next = {
    title: changes.title ?? row.title,
    note: changes.note === undefined ? row.note : changes.note,
    links: changes.links === undefined ? row.links : JSON.stringify(changes.links),
    type: changes.type === undefined ? row.type : changes.type,
    is_test: row.is_test || changes.isTest || changes.title?.startsWith(TEST_PREFIX) ? 1 : 0,
  };
  const changed: Record<string, unknown> = {};
  if (next.title !== row.title) changed.title = next.title;
  if (next.note !== row.note) changed.note = next.note;
  if (next.links !== row.links) changed.links = changes.links;
  if (next.type !== row.type) changed.type = next.type;
  if (next.is_test !== row.is_test) changed.test = true;
  if (Object.keys(changed).length === 0) return row;

  const { n } = (await env.DB.prepare(
    "SELECT count(*) AS n FROM (SELECT 1 FROM events WHERE item_id = ? LIMIT ?)",
  )
    .bind(row.id, WRITE_CAPS.eventsPerItem)
    .first<{ n: number }>())!;
  if (n >= WRITE_CAPS.eventsPerItem) {
    throw new HttpError(429, `item has ${WRITE_CAPS.eventsPerItem} events; it can't be updated again`);
  }

  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE items SET title = ?, note = ?, links = ?, type = ?, is_test = ?, updated_at = ? WHERE id = ?",
    ).bind(next.title, next.note, next.links, next.type, next.is_test, now, row.id),
    insertEvent(env, row.id, "updated", { source: "bot", ...changed }, now),
  ]);
  return loadItem(env, row.id);
}

// Bots may edit only what they wrote. Status changes go through /done, and
// snoozing is yours alone, so any other field is a 400.
async function patchItem(env: Env, id: string, body: Record<string, unknown>): Promise<Response> {
  const keys = Object.keys(body);
  const other = keys.find((k) => !["title", "note", "links", "type", "test"].includes(k));
  if (other) throw new HttpError(400, `${other} can't be changed; only title, note, links, type and test`);
  if (keys.length === 0) throw new HttpError(400, "send at least one of title, note, links, type, test");
  const changes = {
    ...("title" in body ? { title: requiredString(body.title, "title", LIMITS.title) } : {}),
    ...("note" in body ? { note: optionalString(body.note, "note", LIMITS.note) } : {}),
    ...("links" in body ? { links: parseLinks(body.links) } : {}),
    ...("type" in body ? { type: parseType(body.type) } : {}),
    ...("test" in body ? { isTest: parseTest(body.test, "") } : {}),
  };
  const item = await updateFields(env, await loadItem(env, id), changes);
  return json({ item: toItem(item) });
}

async function getItem(env: Env, id: string): Promise<Response> {
  const item = await loadItem(env, id);
  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE item_id = ? ORDER BY id",
  )
    .bind(id)
    .all<EventRow>();
  return json({ item: toItem(item), events: results.map(toEvent) });
}

// The bot list adds bot/since filters and each item's latest_event.
async function listItems(
  env: Env,
  view: string,
  opts: { bot?: string | null; since?: string | null; includeTest: boolean; latest?: boolean },
): Promise<Response> {
  if (!VIEWS.includes(view)) {
    throw new HttpError(400, "view must be waiting, done, snoozed, rejected or all");
  }
  const since = parseSince(opts.since ?? null);
  await wakeSnoozed(env);

  const where: string[] = [];
  const params: string[] = [];
  if (view !== "all") {
    where.push("status = ?");
    params.push(view);
  }
  if (opts.bot) {
    where.push("bot = ? COLLATE NOCASE");
    params.push(opts.bot);
  }
  if (since) {
    where.push("updated_at >= ?");
    params.push(since);
  }
  if (!opts.includeTest) where.push("is_test = 0");
  const latest = opts.latest
    ? `, (SELECT json_object('id', id, 'item_id', item_id, 'type', type, 'payload', payload, 'at', at)
         FROM events WHERE item_id = items.id ORDER BY id DESC LIMIT 1) AS latest_event`
    : "";
  const { results } = await env.DB.prepare(
    `SELECT *${latest} FROM items ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY updated_at DESC LIMIT ${LIST_LIMIT}`,
  )
    .bind(...params)
    .all<ItemRow & { latest_event?: string | null }>();
  if (!opts.latest) return json({ items: results.map(toItem) });
  return json({
    items: results.map(({ latest_event, ...row }) => ({
      ...toItem(row),
      latest_event: latest_event ? toEvent(JSON.parse(latest_event) as EventRow) : null,
    })),
  });
}

// The cursor is an event id, so pages are stable and new events only ever
// appear after it. An empty page returns the same cursor to resume from.
// Events on test items are skipped (the cursor moves past them all the same),
// though they're still forwarded to the webhook.
async function listEvents(env: Env, sinceParam: string | null, limitParam: string | null, includeTest: boolean) {
  const since = sinceParam == null ? 0 : Number(sinceParam);
  if (!/^\d+$/.test(sinceParam ?? "0") || !Number.isSafeInteger(since)) {
    throw new HttpError(400, "since must be a cursor from next_cursor (a non-negative integer)");
  }
  const limit = limitParam == null ? EVENTS_PAGE : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_PAGE) {
    throw new HttpError(400, `limit must be 1 to ${EVENTS_PAGE}`);
  }
  const { results } = await env.DB.prepare(
    `${DELIVERY_SELECT} WHERE d.event_id > ? ${includeTest ? "" : "AND i.is_test = 0"} ORDER BY d.event_id LIMIT ?`,
  )
    .bind(since, limit + 1)
    .all<DeliveryRow>();
  const page = results.slice(0, limit);
  return json({
    events: page.map((row) => ({
      ...toForwarded(row),
      delivery: {
        status: row.delivered_at ? "delivered" : row.attempts >= FORWARD_MAX_ATTEMPTS ? "failed" : "pending",
        attempts: row.attempts,
        delivered_at: row.delivered_at,
        last_error: row.last_error,
      },
    })),
    next_cursor: String(page.length ? page[page.length - 1].id : since),
    has_more: results.length > limit,
  });
}

// Every event from the last TIMELINE_DAYS (or since `since`), newest first,
// with its item's bot, title and type, for the page's timeline.
async function listTimelineEvents(env: Env, sinceParam: string | null, bot: string | null, includeTest: boolean) {
  const since = parseSince(sinceParam) ?? new Date(Date.now() - TIMELINE_DAYS * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT e.*, i.bot, i.title, i.type AS item_type FROM events e JOIN items i ON i.id = e.item_id
     WHERE e.at >= ? ${bot ? "AND i.bot = ? COLLATE NOCASE" : ""} ${includeTest ? "" : "AND i.is_test = 0"}
     ORDER BY e.id DESC LIMIT ${TIMELINE_LIMIT}`,
  )
    .bind(...(bot ? [since, bot] : [since]))
    .all<EventRow & { bot: string; title: string; item_type: ItemType | null }>();
  return json({ events: results.map(toEvent) });
}

// Everything the page shows, in one batch: one round trip and one
// transaction, with snoozed items woken first so the lists agree. Every read
// is indexed and capped (DASHBOARD_LIMITS). Running activity is fetched apart
// from the window so a long job still shows, however long ago it started.
// With DEBUG_ROWS set, logs how many rows D1 read for each statement.
async function dashboard(env: Env, includeTest: boolean): Promise<Response> {
  const since = new Date(Date.now() - DASHBOARD_DAYS * 86_400_000).toISOString();
  const real = includeTest ? "" : "AND is_test = 0";
  const items = (status: Status, recent: boolean, limit: number) =>
    env.DB.prepare(
      `SELECT * FROM items WHERE status = ? ${recent ? "AND updated_at >= ?" : ""} ${real}
       ORDER BY updated_at DESC LIMIT ${limit}`,
    ).bind(...(recent ? [status, since] : [status]));
  const [wakeEvents, wakeItems] = wakeSnoozedStatements(env);
  const statements = {
    wake_events: wakeEvents,
    wake_items: wakeItems,
    waiting: items("waiting", false, LIST_LIMIT),
    snoozed: items("snoozed", false, LIST_LIMIT),
    done: items("done", true, DASHBOARD_LIMITS.closed),
    rejected: items("rejected", true, DASHBOARD_LIMITS.closed),
    activity: env.DB.prepare(
      `SELECT * FROM activity WHERE at >= ? ${real} ORDER BY at DESC LIMIT ${DASHBOARD_LIMITS.activity}`,
    ).bind(since),
    running: env.DB.prepare(
      `SELECT * FROM activity WHERE status = 'in_progress' ${real} ORDER BY at DESC LIMIT ${DASHBOARD_LIMITS.running}`,
    ),
    events: env.DB.prepare(
      `SELECT e.*, i.bot, i.title, i.type AS item_type FROM events e JOIN items i ON i.id = e.item_id
       WHERE e.at >= ? AND e.type IN (${TIMELINE_TYPES.map(() => "?").join(", ")}) ${includeTest ? "" : "AND i.is_test = 0"}
       ORDER BY e.at DESC, e.id DESC LIMIT ${DASHBOARD_LIMITS.events}`,
    ).bind(since, ...TIMELINE_TYPES),
  };
  const names = Object.keys(statements) as (keyof typeof statements)[];
  const results = await env.DB.batch<Record<string, unknown>>(names.map((n) => statements[n]));
  const rows = Object.fromEntries(names.map((n, i) => [n, results[i].results])) as Record<
    keyof typeof statements,
    unknown[]
  >;

  if (env.DEBUG_ROWS) {
    const perQuery = Object.fromEntries(names.map((n, i) => [n, results[i].meta.rows_read]));
    const total = results.reduce((sum, r) => sum + (r.meta.rows_read ?? 0), 0);
    console.log(`dashboard rows_read=${total} ${JSON.stringify(perQuery)}`);
  }

  // A running entry in the window comes back from both activity queries.
  const activity = new Map<string, ActivityRow>();
  for (const row of [...rows.running, ...rows.activity] as ActivityRow[]) activity.set(row.id, row);
  const list = (key: "waiting" | "snoozed" | "done" | "rejected") => (rows[key] as ItemRow[]).map(toItem);
  return json({
    since,
    waiting: list("waiting"),
    snoozed: list("snoozed"),
    done: list("done"),
    rejected: list("rejected"),
    activity: [...activity.values()].sort((a, b) => b.at.localeCompare(a.at)).map(toActivity),
    events: (rows.events as EventRow[]).map(toEvent),
  });
}

type InboxAction = "done" | "reject" | "reply" | "snooze" | "note";

// The event and its pending delivery are written in the same batch, so an
// action is never recorded without something to forward it. Done, reject and
// snooze are status changes (see TRANSITIONS); reply and note only add an
// event, on an item of any status, since a reply after the fact is still
// useful context for the bot.
async function inboxAction(
  env: Env,
  ctx: ExecutionContext,
  id: string,
  action: InboxAction,
  body: Record<string, unknown>,
  actor: Actor,
): Promise<Response> {
  let item: ItemRow;
  let event: EventRow | null;

  if (action === "done" || action === "reject" || action === "snooze") {
    let status: Transition;
    let payload: Record<string, unknown>;
    let until: string | null = null;
    if (action === "snooze") {
      until = snoozeUntil(body);
      [status, payload] = ["snoozed", { source: "inbox", actor, until }];
    } else if (action === "reject") {
      const note = optionalString(body.note, "note", LIMITS.note);
      [status, payload] = ["rejected", { source: "inbox", actor, ...(note ? { note } : {}) }];
    } else {
      [status, payload] = ["done", { source: "inbox", actor }];
    }
    ({ item, event } = await changeStatus(env, id, status, payload, { forward: true, until }));
    if (!event) return conflict(item);
  } else {
    const payload =
      action === "reply"
        ? { source: "inbox", actor, text: requiredString(body.text, "text", LIMITS.note) }
        : { source: "inbox", actor, note: requiredString(body.note, "note", LIMITS.note) };
    await loadItem(env, id);
    const now = nowIso();
    const [, ev] = await env.DB.batch<EventRow>([
      env.DB.prepare("UPDATE items SET updated_at = ? WHERE id = ?").bind(now, id),
      insertEvent(env, id, action, payload, now),
      insertDelivery(env, now),
    ]);
    item = await loadItem(env, id);
    event = ev.results[0];
  }

  // Unset URL: the delivery stays pending, untried, until one is configured.
  const forwarded = env.FORWARD_WEBHOOK_URL?.trim() ? "queued" : "skipped";
  if (forwarded === "queued") ctx.waitUntil(deliverEvent(env, event.id));
  return json({ item: toItem(item), event: toEvent(event), forwarded });
}

// Moves an item to `status` if TRANSITIONS allows it from where the item is
// now. The check is part of the write: in one batch, due snoozes are woken,
// then the event, its delivery (with `forward`) and the update each apply only
// if the item is in an allowed status. So two racing clicks can't both land,
// and a refused change writes nothing. Returns the item as it now stands, and
// event null if the change was refused.
async function changeStatus(
  env: Env,
  id: string,
  status: Transition,
  payload: Record<string, unknown>,
  opts: { forward?: boolean; until?: string | null } = {},
): Promise<{ item: ItemRow; event: EventRow | null }> {
  await loadItem(env, id);
  const from = TRANSITIONS[status];
  const allowed = `status IN (${from.map(() => "?").join(", ")})`;
  const now = nowIso();
  const results = await env.DB.batch<EventRow>([
    ...wakeSnoozedStatements(env),
    env.DB.prepare(
      `INSERT INTO events (item_id, type, payload, at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND ${allowed})
       RETURNING *`,
    ).bind(id, status, JSON.stringify(payload), now, id, ...from),
    // changes() is the event insert's row count, so no event means no delivery.
    ...(opts.forward
      ? [
          env.DB.prepare(
            "INSERT INTO event_deliveries (event_id, next_attempt_at) SELECT last_insert_rowid(), ? WHERE changes() = 1",
          ).bind(now),
        ]
      : []),
    env.DB.prepare(
      `UPDATE items SET status = ?, snooze_until = ?, updated_at = ? WHERE id = ? AND ${allowed}`,
    ).bind(status, opts.until ?? null, now, id, ...from),
  ]);
  return { item: await loadItem(env, id), event: results[2].results[0] ?? null };
}

// A refused status change. The body carries the item as it now stands, so the
// page can redraw a stale card without loading everything again.
function conflict(item: ItemRow): Response {
  return json({ error: `item is already ${item.status}`, item: toItem(item) }, 409);
}

// Snoozed items whose time has passed go back to waiting. Run lazily on read,
// so there's no cron to configure.
async function wakeSnoozed(env: Env) {
  await env.DB.batch(wakeSnoozedStatements(env));
}

function wakeSnoozedStatements(env: Env): [D1PreparedStatement, D1PreparedStatement] {
  const now = nowIso();
  return [
    env.DB.prepare(
      `INSERT INTO events (item_id, type, payload, at)
       SELECT id, 'unsnoozed', json_object('until', snooze_until), ?
       FROM items WHERE status = 'snoozed' AND snooze_until <= ?`,
    ).bind(now, now),
    env.DB.prepare(
      `UPDATE items SET status = 'waiting', snooze_until = NULL, updated_at = ?
       WHERE status = 'snoozed' AND snooze_until <= ?`,
    ).bind(now, now),
  ];
}

// --- activity -----------------------------------------------------------

// Re-posting the same bot + external_key updates that entry (200) instead of
// adding one (201), so a bot can post in_progress when it starts and finished
// when it's done. Without `at`, an entry is stamped now when it's created and
// again whenever its status changes.
async function postActivity(env: Env, body: Record<string, unknown>): Promise<Response> {
  const text = requiredString(body.text, "text", LIMITS.title);
  const status = body.status;
  if (status !== "in_progress" && status !== "finished") {
    throw new HttpError(400, "status must be 'in_progress' or 'finished'");
  }
  const at = parseAt(body.at);
  const externalKey = optionalString(body.external_key, "external_key", LIMITS.externalKey);
  if (body.external_key != null && !externalKey) {
    throw new HttpError(400, "external_key must be a non-empty string");
  }
  const isTest = parseTest(body.test, text);
  const bot = await canonicalBot(env, requiredString(body.bot, "bot", LIMITS.bot));
  const now = nowIso();

  if (externalKey) {
    const existing = await env.DB.prepare("SELECT * FROM activity WHERE bot = ? AND external_key = ?")
      .bind(bot, externalKey)
      .first<ActivityRow>();
    if (existing) {
      const nextAt = at ?? (status !== existing.status ? now : existing.at);
      const nextTest = existing.is_test || isTest ? 1 : 0; // like items, only ever turns on
      if (text === existing.text && status === existing.status && nextAt === existing.at && nextTest === existing.is_test) {
        return json({ activity: toActivity(existing) });
      }
      await env.DB.prepare("UPDATE activity SET text = ?, status = ?, at = ?, is_test = ?, updated_at = ? WHERE id = ?")
        .bind(text, status, nextAt, nextTest, now, existing.id)
        .run();
      return json({ activity: toActivity(await loadActivity(env, existing.id)) });
    }
  }

  await checkDailyCap(env, "activity", WRITE_CAPS.activityPerDay);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO activity (id, bot, text, status, external_key, is_test, at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, bot, text, status, externalKey, isTest ? 1 : 0, at ?? now, now, now)
      .run();
  } catch (err) {
    // A concurrent POST with the same external_key won the insert; update it instead.
    if (externalKey && String(err).includes("UNIQUE constraint failed")) return postActivity(env, body);
    throw err;
  }
  return json({ activity: toActivity(await loadActivity(env, id)) }, 201);
}

async function listActivity(env: Env, sinceParam: string | null, bot: string | null, includeTest: boolean) {
  const since = parseSince(sinceParam);
  const where: string[] = [];
  const params: string[] = [];
  if (since) {
    where.push("at >= ?");
    params.push(since);
  }
  if (bot) {
    where.push("bot = ? COLLATE NOCASE");
    params.push(bot);
  }
  if (!includeTest) where.push("is_test = 0");
  const { results } = await env.DB.prepare(
    `SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY at DESC, created_at DESC LIMIT ${LIST_LIMIT}`,
  )
    .bind(...params)
    .all<ActivityRow>();
  return json({ activity: results.map(toActivity) });
}

// A bot listed in CANONICAL_BOTS (comma-separated, optional) gets its listed
// name. Any other bot gets the casing of the earliest row stored under any
// casing of its name, else the name as sent.
async function canonicalBot(env: Env, name: string): Promise<string> {
  const key = name.toLowerCase();
  const listed = (env.CANONICAL_BOTS ?? "")
    .split(",")
    .map((n) => n.trim())
    .find((n) => n && n.toLowerCase() === key);
  if (listed) return listed;
  const row = await env.DB.prepare(
    `SELECT bot FROM (
       SELECT bot, created_at FROM items WHERE bot = ? COLLATE NOCASE
       UNION ALL SELECT bot, created_at FROM activity WHERE bot = ? COLLATE NOCASE
     ) ORDER BY created_at, bot LIMIT 1`,
  )
    .bind(name, name)
    .first<{ bot: string }>();
  return row?.bot ?? name;
}

// Counts rows created in the last 24 hours, stopping at the cap so a full
// window reads at most `cap` index entries (items_created, activity_created).
async function checkDailyCap(env: Env, table: "items" | "activity", cap: number) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const { n } = (await env.DB.prepare(
    `SELECT count(*) AS n FROM (SELECT 1 FROM ${table} WHERE created_at >= ? LIMIT ?)`,
  )
    .bind(since, cap)
    .first<{ n: number }>())!;
  if (n >= cap) {
    const what = table === "items" ? "items" : "activity entries";
    throw new HttpError(429, `${cap} ${what} were created in the last 24 hours; try again later`);
  }
}

async function loadActivity(env: Env, id: string): Promise<ActivityRow> {
  const row = await env.DB.prepare("SELECT * FROM activity WHERE id = ?").bind(id).first<ActivityRow>();
  if (!row) throw new HttpError(404, "activity not found");
  return row;
}

// --- forwarding ---------------------------------------------------------

type DeliveryRow = EventRow & {
  bot: string;
  title: string;
  external_key: string | null;
  attempts: number;
  delivered_at: string | null;
  last_error: string | null;
};

const DELIVERY_SELECT = `SELECT e.*, i.bot, i.title, i.external_key, d.attempts, d.delivered_at, d.last_error
  FROM event_deliveries d JOIN events e ON e.id = d.event_id JOIN items i ON i.id = e.item_id`;

// What the webhook receives, and what GET /api/events lists.
function toForwarded(row: DeliveryRow) {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    event_id: row.id,
    item_id: row.item_id,
    bot: row.bot,
    title: row.title,
    external_key: row.external_key ?? null,
    action: row.type,
    note: (payload.note as string | undefined) ?? null,
    text: (payload.text as string | undefined) ?? null,
    until: (payload.until as string | undefined) ?? null,
    actor: (payload.actor as string | undefined) ?? null,
    at: row.at,
  };
}

async function deliverEvent(env: Env, eventId: number) {
  const row = await env.DB.prepare(`${DELIVERY_SELECT} WHERE d.event_id = ?`)
    .bind(eventId)
    .first<DeliveryRow>();
  if (row) await attempt(env, row);
}

// Run by the cron trigger: retries due, undelivered events oldest first. The
// attempts cap is inlined, not bound, so SQLite can use the partial index
// event_deliveries_due (migrations/0009), which leaves out failed deliveries.
async function retryDeliveries(env: Env) {
  if (!env.FORWARD_WEBHOOK_URL?.trim()) return;
  const { results } = await env.DB.prepare(
    `${DELIVERY_SELECT} WHERE d.delivered_at IS NULL AND d.attempts < ${FORWARD_MAX_ATTEMPTS}
       AND d.next_attempt_at <= ?
     ORDER BY d.event_id LIMIT ?`,
  )
    .bind(nowIso(), RETRY_BATCH)
    .all<DeliveryRow>();
  for (const row of results) await attempt(env, row);
}

// Claims the delivery before sending: bumps attempts and pushes
// next_attempt_at out by the backoff, only if attempts is unchanged. So the
// immediate send and a cron run can't both send it, and a crash mid-send just
// leaves it for the next retry.
async function attempt(env: Env, row: DeliveryRow) {
  const url = env.FORWARD_WEBHOOK_URL?.trim();
  if (!url || row.delivered_at || row.attempts >= FORWARD_MAX_ATTEMPTS) return;
  const now = Date.now();
  const next = new Date(now + FORWARD_BACKOFF_MS * 2 ** row.attempts).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE event_deliveries SET attempts = attempts + 1, next_attempt_at = ?
     WHERE event_id = ? AND attempts = ? AND delivered_at IS NULL AND next_attempt_at <= ?`,
  )
    .bind(next, row.id, row.attempts, new Date(now).toISOString())
    .run();
  if (claim.meta.changes !== 1) return;

  const error = await send(env, url, JSON.stringify(toForwarded(row)));
  await env.DB.prepare(
    "UPDATE event_deliveries SET delivered_at = ?, last_error = ? WHERE event_id = ?",
  )
    .bind(error ? null : nowIso(), error, row.id)
    .run();
}

// Returns null on a 2xx, else a short error for last_error. The Bearer key is
// sent to the receiver, so it must never also be the signing key: whoever
// holds it could then sign forged bodies. A signing secret equal to the key is
// refused and the request goes unsigned.
async function send(env: Env, url: string, body: string): Promise<string | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = env.FORWARD_WEBHOOK_KEY;
  const secret = env.FORWARD_SIGNING_SECRET;
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (secret && secret === key) {
    console.error("FORWARD_SIGNING_SECRET equals FORWARD_WEBHOOK_KEY; sending unsigned, set a different value");
  } else if (secret) {
    headers["X-Agent-Inbox-Signature"] = `sha256=${await hmacHex(secret, body)}`;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    if (res.ok) return null;
    console.error(`forward webhook returned ${res.status}`);
    return `HTTP ${res.status}`;
  } catch (err) {
    console.error("forward webhook failed", err);
    return String(err).slice(0, 200);
  }
}

async function hmacHex(key: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- db helpers ---------------------------------------------------------

function insertEvent(env: Env, itemId: string, type: string, payload: unknown, at: string) {
  return env.DB.prepare(
    "INSERT INTO events (item_id, type, payload, at) VALUES (?, ?, ?, ?) RETURNING *",
  ).bind(itemId, type, JSON.stringify(payload), at);
}

// Must follow insertEvent in the same batch: it takes that event's id.
function insertDelivery(env: Env, at: string) {
  return env.DB.prepare(
    "INSERT INTO event_deliveries (event_id, next_attempt_at) VALUES (last_insert_rowid(), ?)",
  ).bind(at);
}

async function loadItem(env: Env, id: string): Promise<ItemRow> {
  const row = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>();
  if (!row) throw new HttpError(404, "item not found");
  return row;
}

function toItem(row: ItemRow) {
  return { ...row, links: JSON.parse(row.links) as Link[], is_test: Boolean(row.is_test) };
}

function toActivity(row: ActivityRow) {
  return { ...row, is_test: Boolean(row.is_test) };
}

function toEvent(row: EventRow) {
  return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

// --- input helpers ------------------------------------------------------

function requiredString(value: unknown, name: string, max: number): string {
  const s = optionalString(value, name, max);
  if (!s) throw new HttpError(400, `${name} is required`);
  return s;
}

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
  const s = value.trim();
  if (s.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  return s || null;
}

// Links accept "https://..." strings or { url, label } objects. Only http(s)
// URLs are allowed so the page never renders a javascript: link.
function parseLinks(value: unknown): Link[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "links must be an array");
  if (value.length > LIMITS.links) throw new HttpError(400, `at most ${LIMITS.links} links`);
  return value.map((entry) => {
    const raw = typeof entry === "string" ? { url: entry } : entry;
    if (!raw || typeof raw !== "object") throw new HttpError(400, "invalid link");
    const url = requiredString((raw as Link).url, "link url", LIMITS.url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, `invalid link url: ${url}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new HttpError(400, "link urls must be http or https");
    }
    const label = optionalString((raw as Link).label, "link label", LIMITS.label);
    return label ? { url: parsed.href, label } : { url: parsed.href };
  });
}

function parseType(value: unknown): ItemType | null {
  if (value === undefined || value === null) return null;
  if (!ITEM_TYPES.includes(value as ItemType)) {
    throw new HttpError(400, `type must be one of ${ITEM_TYPES.join(", ")}`);
  }
  return value as ItemType;
}

// A row is test data if the body says test: true or its (trimmed) title/text
// starts with "[TEST]", case and all.
function parseTest(value: unknown, text: string): boolean {
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    throw new HttpError(400, "test must be true or false");
  }
  return value === true || text.startsWith(TEST_PREFIX);
}

// A since query parameter, normalized to the stored format so it compares as text.
function parseSince(value: string | null): string | null {
  if (value == null) return null;
  const ms = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new HttpError(400, "since must be an ISO 8601 date");
  return new Date(ms).toISOString();
}

function parseAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new HttpError(400, "at must be an ISO 8601 date");
  if (ms - Date.now() > MAX_FUTURE_MS) throw new HttpError(400, "at can't be more than a day ahead");
  return new Date(ms).toISOString();
}

function snoozeUntil(body: Record<string, unknown>): string {
  let ms: number;
  if (typeof body.minutes === "number" && Number.isFinite(body.minutes)) {
    ms = Date.now() + body.minutes * 60_000;
  } else if (typeof body.until === "string") {
    ms = Date.parse(body.until);
    if (Number.isNaN(ms)) throw new HttpError(400, "until must be an ISO 8601 date");
  } else {
    throw new HttpError(400, "snooze needs minutes (number) or until (ISO 8601 date)");
  }
  const delta = ms - Date.now();
  if (delta <= 0) throw new HttpError(400, "snooze time must be in the future");
  if (delta > MAX_SNOOZE_MS) throw new HttpError(400, "snooze at most a year");
  return new Date(ms).toISOString();
}
