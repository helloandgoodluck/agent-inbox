import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { SESSION_COOKIE, sha256Hex } from "../src/passkeys";

const BOT = { Authorization: `Bearer ${env.BOT_TOKEN}` };
const INBOX = { Authorization: `Bearer ${env.INBOX_SECRET}` };
const HOOK_URL = "https://hooks.example.test/agent-inbox";

type Item = {
  id: string;
  bot: string;
  title: string;
  status: string;
  type: string | null;
  note: string | null;
  links: { url: string; label?: string }[];
  snooze_until: string | null;
  external_key: string | null;
  is_test: boolean;
  updated_at: string;
  latest_event: Event | null;
};
type Event = { item_id: string; type: string; payload: Record<string, unknown> };

async function call(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; env?: Partial<Env> } = {},
) {
  const request = new Request(`https://inbox.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, ...opts.env } as Env, ctx);
  await waitOnExecutionContext(ctx); // let the waitUntil forward finish
  return { status: res.status, body: (await res.json()) as any };
}

async function cron(extraEnv: Partial<Env> = {}) {
  await worker.scheduled(createScheduledController(), { ...env, ...extraEnv } as Env);
}

type Delivery = { attempts: number; next_attempt_at: string; delivered_at: string | null; last_error: string | null };
async function delivery(eventId: number) {
  return env.DB.prepare("SELECT * FROM event_deliveries WHERE event_id = ?").bind(eventId).first<Delivery>();
}

let counter = 0;
async function createItem(extra: Record<string, unknown> = {}): Promise<Item> {
  const res = await call("POST", "/api/items", {
    headers: BOT,
    body: { bot: `bot-${++counter}`, title: "Approve the PR", ...extra },
  });
  expect(res.status).toBe(201);
  return res.body.item;
}

async function events(id: string): Promise<Event[]> {
  const res = await call("GET", `/api/items/${id}`, { headers: BOT });
  return res.body.events;
}

async function list(view: string): Promise<Item[]> {
  const res = await call("GET", `/api/inbox/items?view=${view}`, { headers: INBOX });
  expect(res.status).toBe(200);
  return res.body.items;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("rejects bot requests with a missing or wrong token", async () => {
    const body = { bot: "x", title: "y" };
    expect((await call("POST", "/api/items", { body })).status).toBe(401);
    expect(
      (await call("POST", "/api/items", { body, headers: { Authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect((await call("POST", "/api/items", { body, headers: INBOX })).status).toBe(401);
  });

  it("rejects inbox requests with a missing or wrong secret", async () => {
    expect((await call("GET", "/api/inbox/items")).status).toBe(401);
    expect((await call("GET", "/api/inbox/items", { headers: BOT })).status).toBe(401);
    const item = await createItem();
    expect((await call("POST", `/api/inbox/items/${item.id}/done`, { headers: BOT })).status).toBe(
      401,
    );
  });

  it("refuses the bot token on every inbox route, so a bot can't snooze", async () => {
    const item = await createItem();
    for (const [action, body] of [
      ["snooze", { minutes: 60 }],
      ["done", undefined],
      ["note", { note: "x" }],
    ] as const) {
      const res = await call("POST", `/api/inbox/items/${item.id}/${action}`, { headers: BOT, body });
      expect(res.status).toBe(401);
    }
    expect((await call("GET", "/api/inbox/items?view=all", { headers: BOT })).status).toBe(401);
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created"]);
  });

  it("refuses the bot token on inbox routes even if INBOX_SECRET is set to the same value", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/inbox/items/${item.id}/snooze`, {
      headers: BOT,
      body: { minutes: 60 },
      env: { INBOX_SECRET: env.BOT_TOKEN },
    });
    expect(res.status).toBe(401);
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created"]);
  });

  it("has no bot route to snooze or delete", async () => {
    const item = await createItem();
    const tries: [string, string][] = [
      ["POST", `/api/items/${item.id}/snooze`],
      ["DELETE", `/api/items/${item.id}`],
      ["POST", `/api/items/${item.id}/delete`],
    ];
    for (const [method, path] of tries) {
      const res = await call(method, path, { headers: BOT, body: { minutes: 60 } });
      expect(res.status).toBe(404);
    }
    const after = await call("GET", `/api/items/${item.id}`, { headers: BOT });
    expect(after.body.item.status).toBe("waiting");
    expect(after.body.events.map((e: Event) => e.type)).toEqual(["created"]);
  });

  it("rejects everything when the secret is not configured", async () => {
    const res = await call("POST", "/api/items", {
      headers: { Authorization: "Bearer " },
      body: { bot: "x", title: "y" },
      env: { BOT_TOKEN: "" },
    });
    expect(res.status).toBe(503);
  });

  it("refuses short or placeholder secrets with a 503, even when the caller sends them", async () => {
    const body = { bot: "x", title: "y" };
    for (const weak of ["password", "a".repeat(31), "change-me-to-a-long-random-string-0123456789"]) {
      const bot = await call("POST", "/api/items", {
        headers: { Authorization: `Bearer ${weak}` },
        body,
        env: { BOT_TOKEN: weak },
      });
      expect(bot.status).toBe(503);
      expect(bot.body.error).toContain("BOT_TOKEN must be at least 32");
      const inbox = await call("GET", "/api/inbox/items", {
        headers: { Authorization: `Bearer ${weak}` },
        env: { INBOX_SECRET: weak },
      });
      expect(inbox.status).toBe(503);
      const activity = await call("GET", "/api/activity", {
        headers: { Authorization: `Bearer ${weak}` },
        env: { BOT_TOKEN: weak },
      });
      expect(activity.status).toBe(401);
    }
  });
});

describe("create and list", () => {
  it("creates an item, logs a created event, and lists it in waiting", async () => {
    const item = await createItem({
      note: "Needs a review before 5pm",
      links: ["https://github.com/o/r/pull/1", { url: "https://example.com", label: "Spec" }],
    });
    expect(item).toMatchObject({
      status: "waiting",
      note: "Needs a review before 5pm",
      links: [{ url: "https://github.com/o/r/pull/1" }, { url: "https://example.com/", label: "Spec" }],
    });
    expect((await list("waiting")).map((i) => i.id)).toContain(item.id);
    expect((await list("done")).map((i) => i.id)).not.toContain(item.id);
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created"]);
  });

  it("can create an already-done item (an FYI)", async () => {
    const item = await createItem({ status: "done" });
    expect((await list("done")).map((i) => i.id)).toContain(item.id);
  });

  it("validates input", async () => {
    expect((await call("POST", "/api/items", { headers: BOT, body: { bot: "x" } })).status).toBe(
      400,
    );
    const bad = await call("POST", "/api/items", {
      headers: BOT,
      body: { bot: "x", title: "y", links: ["javascript:alert(1)"] },
    });
    expect(bad.status).toBe(400);
  });

  it("lets a bot mark its item done", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/items/${item.id}/done`, {
      headers: BOT,
      body: { note: "merged" },
    });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("done");
    const evs = await events(item.id);
    expect(evs.map((e) => e.type)).toEqual(["created", "done"]);
    expect(evs[1].payload).toEqual({ source: "bot", note: "merged" });
  });

  it("returns 404 for unknown items", async () => {
    expect((await call("POST", "/api/inbox/items/nope/done", { headers: INBOX })).status).toBe(404);
  });
});

describe("bot list", () => {
  const botList = (query = "") => call("GET", `/api/items${query}`, { headers: BOT });

  it("requires BOT_TOKEN", async () => {
    expect((await call("GET", "/api/items")).status).toBe(401);
    expect((await call("GET", "/api/items", { headers: INBOX })).status).toBe(401);
  });

  it("defaults to waiting and filters by view and bot", async () => {
    const waiting = await createItem();
    const done = await createItem({ bot: waiting.bot, status: "done" });

    const res = await botList(`?bot=${waiting.bot}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: Item) => i.id)).toEqual([waiting.id]);

    const all = await botList(`?view=all&bot=${waiting.bot}`);
    expect(all.body.items.map((i: Item) => i.id).sort()).toEqual([waiting.id, done.id].sort());
    const doneOnly = await botList(`?view=done&bot=${waiting.bot}`);
    expect(doneOnly.body.items.map((i: Item) => i.id)).toEqual([done.id]);
    expect((await botList(`?view=all&bot=${waiting.bot}-nope`)).body.items).toEqual([]);
  });

  it("lists snoozed items under view=snoozed", async () => {
    const item = await createItem();
    await call("POST", `/api/inbox/items/${item.id}/snooze`, { headers: INBOX, body: { minutes: 60 } });
    const res = await botList(`?view=snoozed&bot=${item.bot}`);
    expect(res.body.items.map((i: Item) => i.id)).toEqual([item.id]);
  });

  it("returns the item fields and its latest event", async () => {
    const item = await createItem({ note: "n", links: ["https://example.com/a"], external_key: "k1" });
    let [listed] = (await botList(`?bot=${item.bot}`)).body.items as Item[];
    expect(listed).toMatchObject({
      id: item.id,
      bot: item.bot,
      title: item.title,
      note: "n",
      links: [{ url: "https://example.com/a" }],
      status: "waiting",
      external_key: "k1",
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(listed.latest_event).toMatchObject({ item_id: item.id, type: "created" });

    await call("POST", `/api/inbox/items/${item.id}/note`, { headers: INBOX, body: { note: "ok" } });
    [listed] = (await botList(`?bot=${item.bot}`)).body.items;
    expect(listed.latest_event).toMatchObject({ type: "note", payload: { source: "inbox", note: "ok" } });
  });

  it("latest_event is null for an item with no events", async () => {
    const now = new Date().toISOString();
    const bot = `bot-${++counter}`;
    await env.DB.prepare(
      "INSERT INTO items (id, bot, title, created_at, updated_at) VALUES (?, ?, 'x', ?, ?)",
    )
      .bind(crypto.randomUUID(), bot, now, now)
      .run();
    const [listed] = (await botList(`?bot=${bot}`)).body.items as Item[];
    expect(listed.latest_event).toBeNull();
  });

  it("filters by since (updated_at >= since)", async () => {
    const old = await createItem();
    const fresh = await createItem({ bot: old.bot });
    await env.DB.prepare("UPDATE items SET updated_at = ? WHERE id = ?")
      .bind("2026-01-01T00:00:00.000Z", old.id)
      .run();
    await env.DB.prepare("UPDATE items SET updated_at = ? WHERE id = ?")
      .bind("2026-02-01T00:00:00.000Z", fresh.id)
      .run();

    const ids = async (since: string) =>
      ((await botList(`?bot=${old.bot}&since=${encodeURIComponent(since)}`)).body.items as Item[]).map(
        (i) => i.id,
      );
    expect(await ids("2026-01-15")).toEqual([fresh.id]);
    expect(await ids("2026-02-01T00:00:00Z")).toEqual([fresh.id]); // inclusive
    // 2025-12-31T23:00Z: only right if the offset is normalized before comparing.
    expect((await ids("2026-01-01T01:00:00+02:00")).sort()).toEqual([old.id, fresh.id].sort());
  });

  it("rejects a bad view or since", async () => {
    expect((await botList("?view=nope")).status).toBe(400);
    expect((await botList("?since=yesterday")).status).toBe(400);
    expect((await botList("?since=2026-13-45")).status).toBe(400);
  });
});

describe("external_key", () => {
  const post = (body: Record<string, unknown>) => call("POST", "/api/items", { headers: BOT, body });

  it("re-posting the same bot + external_key returns 200 with the same id", async () => {
    const body = { bot: "billing-bot", title: "Review invoice", external_key: "inv-1" };
    const first = await post(body);
    expect(first.status).toBe(201);
    expect(first.body.item.external_key).toBe("inv-1");

    const again = await post(body);
    expect(again.status).toBe(200);
    expect(again.body.item.id).toBe(first.body.item.id);
    // Nothing changed, so nothing is logged.
    expect((await events(first.body.item.id)).map((e) => e.type)).toEqual(["created"]);
  });

  it("re-posting with new content updates title/note/links and logs an event", async () => {
    const first = await post({ bot: "billing-bot", title: "Old", note: "n1", external_key: "inv-2" });
    const res = await post({
      bot: "billing-bot",
      title: "New",
      links: ["https://example.com/inv/2"],
      external_key: "inv-2",
      status: "done",
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: first.body.item.id,
      title: "New",
      note: null,
      links: [{ url: "https://example.com/inv/2" }],
      status: "waiting",
    });
    const evs = await events(first.body.item.id);
    expect(evs.map((e) => e.type)).toEqual(["created", "updated"]);
    expect(evs[1].payload).toEqual({
      source: "bot",
      title: "New",
      note: null,
      links: [{ url: "https://example.com/inv/2" }],
    });
  });

  it("is scoped per bot, and items without a key never collide", async () => {
    const a = await post({ bot: "billing-bot", title: "x", external_key: "shared" });
    const b = await post({ bot: "other", title: "x", external_key: "shared" });
    expect(b.status).toBe(201);
    expect(b.body.item.id).not.toBe(a.body.item.id);
    const c = await post({ bot: "billing-bot", title: "x" });
    const d = await post({ bot: "billing-bot", title: "x" });
    expect([c.status, d.status]).toEqual([201, 201]);
    expect(c.body.item.external_key).toBeNull();
  });

  it("rejects an empty or non-string external_key", async () => {
    expect((await post({ bot: "billing-bot", title: "x", external_key: "" })).status).toBe(400);
    expect((await post({ bot: "billing-bot", title: "x", external_key: "  " })).status).toBe(400);
    expect((await post({ bot: "billing-bot", title: "x", external_key: 5 })).status).toBe(400);
  });
});

describe("bot patch", () => {
  const patch = (id: string, body: unknown, headers = BOT) =>
    call("PATCH", `/api/items/${id}`, { headers, body });

  it("updates title, note and links and logs an event", async () => {
    const item = await createItem({ note: "keep me" });
    const res = await patch(item.id, { title: "Renamed", links: ["https://example.com/x"] });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({
      id: item.id,
      title: "Renamed",
      note: "keep me",
      links: [{ url: "https://example.com/x" }],
      status: "waiting",
    });
    const evs = await events(item.id);
    expect(evs.map((e) => e.type)).toEqual(["created", "updated"]);
    expect(evs[1].payload).toEqual({
      source: "bot",
      title: "Renamed",
      links: [{ url: "https://example.com/x" }],
    });

    const cleared = await patch(item.id, { note: null });
    expect(cleared.body.item.note).toBeNull();
  });

  it("rejects any other field, including status and snooze", async () => {
    const item = await createItem();
    for (const body of [
      { status: "done" },
      { status: "snoozed" },
      { snooze_until: "2030-01-01T00:00:00Z" },
      { title: "ok", bot: "someone-else" },
      { external_key: "k" },
    ]) {
      expect((await patch(item.id, body)).status).toBe(400);
    }
    expect((await patch(item.id, {})).status).toBe(400);
    const after = await call("GET", `/api/items/${item.id}`, { headers: BOT });
    expect(after.body.item).toMatchObject({ title: item.title, status: "waiting", snooze_until: null });
  });

  it("validates fields like POST", async () => {
    const item = await createItem();
    expect((await patch(item.id, { title: "" })).status).toBe(400);
    expect((await patch(item.id, { title: null })).status).toBe(400);
    expect((await patch(item.id, { note: 5 })).status).toBe(400);
    expect((await patch(item.id, { links: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await patch(item.id, { title: "x".repeat(501) })).status).toBe(400);
  });

  it("returns 404 for an unknown id and 401 without BOT_TOKEN", async () => {
    expect((await patch("nope", { title: "x" })).status).toBe(404);
    const item = await createItem();
    expect((await patch(item.id, { title: "x" }, INBOX)).status).toBe(401);
  });
});

describe("inbox actions", () => {
  it("done writes an event and moves the item to done", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/inbox/items/${item.id}/done`, { headers: INBOX });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("done");
    expect(res.body.event).toMatchObject({ item_id: item.id, type: "done" });
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created", "done"]);
    expect((await list("done")).map((i) => i.id)).toContain(item.id);
    expect((await list("waiting")).map((i) => i.id)).not.toContain(item.id);
  });

  it("snooze writes an event and hides the item from waiting", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/inbox/items/${item.id}/snooze`, {
      headers: INBOX,
      body: { minutes: 60 },
    });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("snoozed");
    expect(Date.parse(res.body.item.snooze_until)).toBeGreaterThan(Date.now());
    const evs = await events(item.id);
    expect(evs.map((e) => e.type)).toEqual(["created", "snoozed"]);
    expect(evs[1].payload.until).toBe(res.body.item.snooze_until);
    expect((await list("waiting")).map((i) => i.id)).not.toContain(item.id);
    expect((await list("snoozed")).map((i) => i.id)).toContain(item.id);
  });

  it("rejects a snooze in the past", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/inbox/items/${item.id}/snooze`, {
      headers: INBOX,
      body: { until: "2001-01-01T00:00:00Z" },
    });
    expect(res.status).toBe(400);
  });

  it("note writes an event with the reply and keeps the item waiting", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/inbox/items/${item.id}/note`, {
      headers: INBOX,
      body: { note: "Ship it, but bump the version" },
    });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("waiting");
    const evs = await events(item.id);
    expect(evs.map((e) => e.type)).toEqual(["created", "note"]);
    expect(evs[1].payload).toEqual({
      source: "inbox",
      actor: "inbox_secret",
      note: "Ship it, but bump the version",
    });
    expect((await call("POST", `/api/inbox/items/${item.id}/note`, { headers: INBOX })).status).toBe(
      400,
    );
  });

  it("events are append-only", async () => {
    const item = await createItem();
    await expect(env.DB.prepare("DELETE FROM events WHERE item_id = ?").bind(item.id).run()).rejects
      .toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE events SET type = 'x' WHERE item_id = ?").bind(item.id).run(),
    ).rejects.toThrow(/append-only/);
  });
});

describe("forward webhook", () => {
  const hookEnv = { FORWARD_WEBHOOK_URL: HOOK_URL, FORWARD_WEBHOOK_KEY: "hook-key", FORWARD_SIGNING_SECRET: "sign-secret" };
  const act = (id: string, action: string, body?: unknown, extraEnv: Partial<Env> = hookEnv) =>
    call("POST", `/api/inbox/items/${id}/${action}`, { headers: INBOX, body, env: extraEnv });
  const mockHook = (status: number) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status }));
  // Other tests leave pending deliveries behind; settle them so a cron run
  // only touches the event under test.
  const settleOthers = (eventId: number) =>
    env.DB.prepare("UPDATE event_deliveries SET delivered_at = 'x' WHERE delivered_at IS NULL AND event_id != ?")
      .bind(eventId)
      .run();

  async function verify(key: string, body: string, header: string | null) {
    const hex = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
    if (!hex) return false;
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
      "verify",
    ]);
    const sig = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    return crypto.subtle.verify("HMAC", k, sig, enc.encode(body));
  }

  it("POSTs every inbox action right away, signed, and marks it delivered", async () => {
    const fetchSpy = mockHook(200);
    const item = await createItem();

    const ids: number[] = [];
    for (const [action, body] of [
      ["note", { note: "looks good" }],
      ["snooze", { minutes: 30 }],
      ["done", undefined],
    ] as const) {
      const res = await act(item.id, action, body);
      expect(res.status).toBe(200);
      expect(res.body.forwarded).toBe("queued");
      ids.push(res.body.event.id);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const sent = [];
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(url).toBe(HOOK_URL);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Webhook-Key")).toBeNull();
      expect(await verify("sign-secret", init?.body as string, headers.get("X-Agent-Inbox-Signature"))).toBe(true);
      expect(await verify("hook-key", init?.body as string, headers.get("X-Agent-Inbox-Signature"))).toBe(false);
      expect(headers.get("Authorization")).toBe("Bearer hook-key");
      sent.push(JSON.parse(init?.body as string));
    }
    expect(sent[0]).toEqual({
      event_id: ids[0],
      item_id: item.id,
      bot: item.bot,
      title: item.title,
      external_key: null,
      action: "note",
      note: "looks good",
      text: null,
      until: null,
      actor: "inbox_secret",
      at: expect.any(String),
    });
    expect(sent.map((p) => p.action)).toEqual(["note", "snoozed", "done"]);
    expect(sent[1].until).toEqual(expect.any(String));

    for (const id of ids) {
      expect(await delivery(id)).toMatchObject({ attempts: 1, delivered_at: expect.any(String), last_error: null });
    }
  });

  it("records a failure, then the cron retries with backoff and delivers", async () => {
    mockHook(500);
    const item = await createItem();
    const res = await act(item.id, "done");
    expect(res.status).toBe(200);
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created", "done"]);
    const id = res.body.event.id;
    const failed = await delivery(id);
    expect(failed).toMatchObject({ attempts: 1, delivered_at: null, last_error: "HTTP 500" });
    const wait = Date.parse(failed!.next_attempt_at) - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThanOrEqual(60_000);

    // Not due yet, so the cron leaves it alone.
    await settleOthers(id);
    vi.restoreAllMocks();
    const fetchSpy = mockHook(200);
    await cron(hookEnv);
    expect(fetchSpy).not.toHaveBeenCalled();

    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("UPDATE event_deliveries SET next_attempt_at = ? WHERE event_id = ?").bind(past, id).run();
    await cron(hookEnv);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).event_id).toBe(id);
    expect(await delivery(id)).toMatchObject({ attempts: 2, delivered_at: expect.any(String), last_error: null });

    await cron(hookEnv); // delivered, so never sent again
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("doubles the backoff each attempt and stops at the cap", async () => {
    mockHook(500);
    const item = await createItem();
    const id = (await act(item.id, "done")).body.event.id;
    await settleOthers(id);
    const past = new Date(Date.now() - 1000).toISOString();

    await env.DB.prepare("UPDATE event_deliveries SET next_attempt_at = ? WHERE event_id = ?").bind(past, id).run();
    await cron(hookEnv);
    const second = await delivery(id);
    expect(second!.attempts).toBe(2);
    expect(Date.parse(second!.next_attempt_at) - Date.now()).toBeGreaterThan(110_000);

    await env.DB.prepare("UPDATE event_deliveries SET attempts = 10, next_attempt_at = ? WHERE event_id = ?")
      .bind(past, id)
      .run();
    vi.restoreAllMocks();
    const fetchSpy = mockHook(200);
    await cron(hookEnv);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await delivery(id)).toMatchObject({ attempts: 10, delivered_at: null });
  });

  it("leaves events pending and untried when FORWARD_WEBHOOK_URL is unset", async () => {
    const fetchSpy = mockHook(200);
    const item = await createItem();
    const noUrl = { FORWARD_WEBHOOK_URL: undefined, FORWARD_WEBHOOK_KEY: "hook-key" };
    const res = await act(item.id, "done", undefined, noUrl);
    expect(res.status).toBe(200);
    expect(res.body.forwarded).toBe("skipped");
    const id = res.body.event.id;
    await settleOthers(id);
    await cron(noUrl);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await delivery(id)).toMatchObject({ attempts: 0, delivered_at: null, last_error: null });

    // Once a URL is set, the cron sends what was waiting.
    await cron(hookEnv);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await delivery(id)).toMatchObject({ attempts: 1, delivered_at: expect.any(String) });
  });

  it("doesn't forward bot actions", async () => {
    const fetchSpy = mockHook(200);
    const item = await createItem();
    await call("POST", `/api/items/${item.id}/done`, { headers: BOT, env: hookEnv });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Each case sends one done action and returns the request headers it went out with.
  async function sentHeaders(extraEnv: Partial<Env>) {
    const fetchSpy = mockHook(200);
    const item = await createItem();
    const res = await act(item.id, "done", undefined, { FORWARD_WEBHOOK_URL: HOOK_URL, ...extraEnv });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1];
    fetchSpy.mockRestore();
    return { headers: new Headers(init?.headers), body: init?.body as string };
  }

  it("signs with FORWARD_SIGNING_SECRET only, never with the Bearer key", async () => {
    const { headers, body } = await sentHeaders({ FORWARD_WEBHOOK_KEY: "hook-key", FORWARD_SIGNING_SECRET: "sign-secret" });
    const sig = headers.get("X-Agent-Inbox-Signature");
    expect(await verify("sign-secret", body, sig)).toBe(true);
    expect(await verify("hook-key", body, sig)).toBe(false);
    expect(headers.get("Authorization")).toBe("Bearer hook-key");
    expect([...headers.values()].join("\n")).not.toContain("sign-secret");
  });

  it("sends no signature header when FORWARD_SIGNING_SECRET is unset, Bearer still sent", async () => {
    for (const secret of [undefined, ""]) {
      const { headers } = await sentHeaders({ FORWARD_WEBHOOK_KEY: "hook-key", FORWARD_SIGNING_SECRET: secret });
      expect(headers.get("X-Agent-Inbox-Signature")).toBeNull();
      expect(headers.get("Authorization")).toBe("Bearer hook-key");
    }
  });

  it("signs without a Bearer token when only FORWARD_SIGNING_SECRET is set", async () => {
    const { headers, body } = await sentHeaders({ FORWARD_WEBHOOK_KEY: undefined, FORWARD_SIGNING_SECRET: "sign-secret" });
    expect(await verify("sign-secret", body, headers.get("X-Agent-Inbox-Signature"))).toBe(true);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("sends neither header when both are unset", async () => {
    const { headers } = await sentHeaders({ FORWARD_WEBHOOK_KEY: undefined, FORWARD_SIGNING_SECRET: undefined });
    expect(headers.get("X-Agent-Inbox-Signature")).toBeNull();
    expect(headers.get("Authorization")).toBeNull();
  });

  it("refuses to sign with a secret equal to the Bearer key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { headers } = await sentHeaders({ FORWARD_WEBHOOK_KEY: "same", FORWARD_SIGNING_SECRET: "same" });
    expect(headers.get("X-Agent-Inbox-Signature")).toBeNull();
    expect(headers.get("Authorization")).toBe("Bearer same");
    expect(errors.mock.calls.flat().join(" ")).toMatch(/FORWARD_SIGNING_SECRET equals FORWARD_WEBHOOK_KEY/);
  });
});

describe("events feed", () => {
  const feed = (query: string, headers: Record<string, string> = BOT) =>
    call("GET", `/api/events${query}`, { headers });

  it("requires BOT_TOKEN", async () => {
    expect((await feed("")).status).toBe(200);
    expect((await feed("", {})).status).toBe(401);
    expect((await feed("", { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await feed("", INBOX)).status).toBe(401);
  });

  it("pages inbox actions in id order with a cursor and delivery status", async () => {
    const item = await createItem();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    const first = await call("POST", `/api/inbox/items/${item.id}/note`, {
      headers: INBOX,
      body: { note: "one" },
      env: { FORWARD_WEBHOOK_URL: HOOK_URL },
    });
    const ids = [first.body.event.id];
    for (const note of ["two", "three", "four", "five"]) {
      ids.push((await call("POST", `/api/inbox/items/${item.id}/note`, { headers: INBOX, body: { note } })).body.event.id);
    }
    // Bot actions aren't in the feed: only what you did in the inbox.
    await call("POST", `/api/items/${item.id}/done`, { headers: BOT });

    const start = String(ids[0] - 1);
    const p1 = await feed(`?since=${start}&limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.events.map((e: any) => e.event_id)).toEqual(ids.slice(0, 2));
    expect(p1.body).toMatchObject({ next_cursor: String(ids[1]), has_more: true });
    expect(p1.body.events[0]).toMatchObject({
      item_id: item.id,
      bot: item.bot,
      title: item.title,
      action: "note",
      note: "one",
      actor: "inbox_secret",
      delivery: { status: "delivered", attempts: 1, delivered_at: expect.any(String), last_error: null },
    });
    expect(p1.body.events[1].delivery).toEqual({ status: "pending", attempts: 0, delivered_at: null, last_error: null });

    const p2 = await feed(`?since=${p1.body.next_cursor}&limit=2`);
    expect(p2.body.events.map((e: any) => e.event_id)).toEqual(ids.slice(2, 4));
    const p3 = await feed(`?since=${p2.body.next_cursor}&limit=2`);
    expect(p3.body.events.map((e: any) => e.note)).toEqual(["five"]);
    expect(p3.body.has_more).toBe(false);

    // Caught up: same cursor back, ready to resume from.
    const p4 = await feed(`?since=${p3.body.next_cursor}`);
    expect(p4.body).toEqual({ events: [], next_cursor: p3.body.next_cursor, has_more: false });

    await env.DB.prepare("UPDATE event_deliveries SET attempts = 10 WHERE event_id = ?").bind(ids[4]).run();
    const failed = await feed(`?since=${ids[3]}`);
    expect(failed.body.events[0].delivery.status).toBe("failed");
  });

  it("bounds the page size and validates the cursor", async () => {
    for (const q of ["?since=-1", "?since=abc", "?since=1.5", "?limit=0", "?limit=101", "?limit=x"]) {
      expect((await feed(q)).status).toBe(400);
    }
    expect((await feed("?limit=100")).status).toBe(200);
  });
});

describe("snooze expiry", () => {
  it("snoozed items reappear in waiting once snooze_until passes", async () => {
    const item = await createItem();
    await call("POST", `/api/inbox/items/${item.id}/snooze`, {
      headers: INBOX,
      body: { minutes: 5 },
    });
    expect((await list("waiting")).map((i) => i.id)).not.toContain(item.id);

    // Five minutes later: move the snooze into the past instead of sleeping.
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("UPDATE items SET snooze_until = ? WHERE id = ?").bind(past, item.id).run();

    const waiting = await list("waiting");
    const back = waiting.find((i) => i.id === item.id);
    expect(back).toMatchObject({ status: "waiting", snooze_until: null });
    expect((await list("snoozed")).map((i) => i.id)).not.toContain(item.id);
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created", "snoozed", "unsnoozed"]);
  });
});

describe("item type", () => {
  const TYPES = ["approval", "yes_no", "reply", "sign", "due_today"];

  it("accepts each type on create, records it, and defaults to null", async () => {
    for (const type of TYPES) {
      const item = await createItem({ type });
      expect(item.type).toBe(type);
      expect((await events(item.id))[0].payload).toMatchObject({ type });
    }
    expect((await createItem()).type).toBeNull();
    expect((await createItem({ type: null })).type).toBeNull();
  });

  it("rejects anything but the exact slugs", async () => {
    for (const type of ["Approval", "yes/no", "Yes/no", "due today", "", "urgent", 5, true]) {
      const res = await call("POST", "/api/items", { headers: BOT, body: { bot: "x", title: "y", type } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/type must be one of/);
    }
  });

  it("can be set, changed and cleared with PATCH", async () => {
    const item = await createItem();
    const patch = (body: unknown) => call("PATCH", `/api/items/${item.id}`, { headers: BOT, body });
    expect((await patch({ type: "sign" })).body.item.type).toBe("sign");
    expect((await patch({ type: "due_today" })).body.item.type).toBe("due_today");
    expect((await patch({ type: "Sign" })).status).toBe(400);
    expect((await patch({ type: null })).body.item.type).toBeNull();
    const evs = await events(item.id);
    expect(evs.map((e) => e.payload.type)).toEqual([undefined, "sign", "due_today", null]);
  });

  it("is updated by an external_key re-post like the other fields", async () => {
    const body = { bot: `bot-${++counter}`, title: "Sign the lease", external_key: "lease", type: "sign" };
    const first = await call("POST", "/api/items", { headers: BOT, body });
    const again = await call("POST", "/api/items", { headers: BOT, body: { ...body, type: "due_today" } });
    expect(again.status).toBe(200);
    expect(again.body.item).toMatchObject({ id: first.body.item.id, type: "due_today" });
  });
});

describe("reject", () => {
  it("sets status rejected, logs a rejected event and hides the item from waiting", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/inbox/items/${item.id}/reject`, {
      headers: INBOX,
      body: { note: "Not this quarter" },
    });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: "rejected", snooze_until: null });
    expect(res.body.event).toMatchObject({
      type: "rejected",
      payload: { source: "inbox", actor: "inbox_secret", note: "Not this quarter" },
    });
    expect((await list("waiting")).map((i) => i.id)).not.toContain(item.id);
    expect((await list("done")).map((i) => i.id)).not.toContain(item.id);
    expect((await list("rejected")).map((i) => i.id)).toContain(item.id);
  });

  it("works without a body, and clears a snooze", async () => {
    const item = await createItem();
    await call("POST", `/api/inbox/items/${item.id}/snooze`, { headers: INBOX, body: { minutes: 60 } });
    const res = await call("POST", `/api/inbox/items/${item.id}/reject`, { headers: INBOX });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: "rejected", snooze_until: null });
    expect(res.body.event.payload).toEqual({ source: "inbox", actor: "inbox_secret" });
  });

  it("is listed by the bot API under view=rejected", async () => {
    const item = await createItem();
    await call("POST", `/api/inbox/items/${item.id}/reject`, { headers: INBOX });
    const res = await call("GET", `/api/items?view=rejected&bot=${item.bot}`, { headers: BOT });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: Item) => i.id)).toEqual([item.id]);
    expect(res.body.items[0].latest_event).toMatchObject({ type: "rejected" });
    expect((await call("GET", `/api/items?bot=${item.bot}`, { headers: BOT })).body.items).toEqual([]);
  });

  it("returns 404 for an unknown item", async () => {
    expect((await call("POST", "/api/inbox/items/nope/reject", { headers: INBOX })).status).toBe(404);
  });
});

describe("reply", () => {
  it("logs a reply event with the text and keeps the item waiting", async () => {
    const item = await createItem();
    const res = await call("POST", `/api/inbox/items/${item.id}/reply`, {
      headers: INBOX,
      body: { text: "  Yes, go ahead  " },
    });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("waiting");
    expect(res.body.event).toMatchObject({
      type: "reply",
      payload: { source: "inbox", actor: "inbox_secret", text: "Yes, go ahead" },
    });
    expect((await list("waiting")).map((i) => i.id)).toContain(item.id);
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created", "reply"]);
  });

  it("requires non-empty text", async () => {
    const item = await createItem();
    for (const body of [undefined, {}, { text: "" }, { text: "   " }, { text: 5 }, { note: "x" }]) {
      const res = await call("POST", `/api/inbox/items/${item.id}/reply`, { headers: INBOX, body });
      expect(res.status).toBe(400);
    }
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created"]);
  });
});

describe("status guard", () => {
  const hookEnv = { FORWARD_WEBHOOK_URL: HOOK_URL, FORWARD_WEBHOOK_KEY: "hook-key" };
  const STATUSES = ["waiting", "snoozed", "done", "rejected"] as const;
  const BODIES: Record<string, unknown> = {
    done: undefined,
    reject: { note: "no" },
    snooze: { minutes: 60 },
    reply: { text: "thanks" },
    note: { note: "fyi" },
  };
  const act = (id: string, action: string) =>
    call("POST", `/api/inbox/items/${id}/${action}`, { headers: INBOX, body: BODIES[action], env: hookEnv });

  // A fresh item in the given status, set the way the page would.
  async function itemIn(status: (typeof STATUSES)[number]): Promise<Item> {
    const item = await createItem();
    const action = { waiting: null, snoozed: "snooze", done: "done", rejected: "reject" }[status];
    if (action) expect((await call("POST", `/api/inbox/items/${item.id}/${action}`, { headers: INBOX, body: BODIES[action] })).status).toBe(200);
    return item;
  }

  async function snapshot(id: string) {
    const row = await env.DB.prepare(
      `SELECT i.status, i.snooze_until, i.updated_at,
         (SELECT COUNT(*) FROM events WHERE item_id = i.id) AS events,
         (SELECT COUNT(*) FROM event_deliveries d JOIN events e ON e.id = d.event_id WHERE e.item_id = i.id) AS deliveries
       FROM items i WHERE i.id = ?`,
    )
      .bind(id)
      .first<{ status: string; snooze_until: string | null; updated_at: string; events: number; deliveries: number }>();
    return row!;
  }

  // Each action, from each status: the status it lands in, or 409.
  const EXPECTED: Record<string, Record<(typeof STATUSES)[number], string | 409>> = {
    done: { waiting: "done", snoozed: "done", done: 409, rejected: 409 },
    reject: { waiting: "rejected", snoozed: "rejected", done: 409, rejected: 409 },
    snooze: { waiting: "snoozed", snoozed: 409, done: 409, rejected: 409 },
    reply: { waiting: "waiting", snoozed: "snoozed", done: "done", rejected: "rejected" },
    note: { waiting: "waiting", snoozed: "snoozed", done: "done", rejected: "rejected" },
  };

  for (const [action, byStatus] of Object.entries(EXPECTED)) {
    for (const from of STATUSES) {
      const want = byStatus[from];
      if (want === 409) {
        it(`${action} on a ${from} item is a 409 that writes no event, no delivery and sends nothing`, async () => {
          const item = await itemIn(from);
          const before = await snapshot(item.id);
          const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
          const res = await act(item.id, action);
          expect(res.status).toBe(409);
          expect(res.body.error).toBe(`item is already ${from}`);
          expect(res.body.item).toMatchObject({ id: item.id, status: from });
          expect(await snapshot(item.id)).toEqual(before);
          expect(fetchSpy).not.toHaveBeenCalled();
        });
      } else {
        it(`${action} on a ${from} item moves it to ${want} and forwards one event`, async () => {
          const item = await itemIn(from);
          const before = await snapshot(item.id);
          const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
          const res = await act(item.id, action);
          expect(res.status).toBe(200);
          expect(res.body.item.status).toBe(want);
          const after = await snapshot(item.id);
          expect(after).toMatchObject({ status: want, events: before.events + 1, deliveries: before.deliveries + 1 });
          // Reply and note never touch status or the snooze.
          if (action === "reply" || action === "note") expect(after.snooze_until).toBe(before.snooze_until);
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(JSON.parse(fetchSpy.mock.calls[0][1]?.body as string).event_id).toBe(res.body.event.id);
        });
      }
    }
  }

  it("treats a snooze that's due as waiting, so it can be snoozed again", async () => {
    const item = await itemIn("snoozed");
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("UPDATE items SET snooze_until = ? WHERE id = ?").bind(past, item.id).run();
    const res = await call("POST", `/api/inbox/items/${item.id}/snooze`, { headers: INBOX, body: { minutes: 30 } });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe("snoozed");
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created", "snoozed", "unsnoozed", "snoozed"]);
  });

  it("lets only one of two racing clicks land", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    const item = await createItem();
    const results = await Promise.all([act(item.id, "done"), act(item.id, "reject")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await snapshot(item.id)).toMatchObject({ events: 2, deliveries: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  describe("bot POST /api/items/:id/done", () => {
    const botDone = (id: string) => call("POST", `/api/items/${id}/done`, { headers: BOT, body: { note: "merged" } });

    for (const from of ["waiting", "snoozed"] as const) {
      it(`marks a ${from} item done with an event, and forwards nothing`, async () => {
        const item = await itemIn(from);
        const before = await snapshot(item.id);
        const res = await botDone(item.id);
        expect(res.status).toBe(200);
        expect(res.body.item).toMatchObject({ status: "done", snooze_until: null });
        expect(await snapshot(item.id)).toMatchObject({ status: "done", events: before.events + 1, deliveries: before.deliveries });
      });
    }

    it("is an idempotent 200 on a done item: no new event", async () => {
      const item = await itemIn("done");
      const before = await snapshot(item.id);
      const res = await botDone(item.id);
      expect(res.status).toBe(200);
      expect(res.body.item.status).toBe("done");
      expect(await snapshot(item.id)).toEqual(before);
    });

    it("is a 409 on an item you rejected, and leaves it rejected", async () => {
      const item = await itemIn("rejected");
      const before = await snapshot(item.id);
      const res = await botDone(item.id);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "item is already rejected", item: { id: item.id, status: "rejected" } });
      expect(await snapshot(item.id)).toEqual(before);
    });

    it("still returns 404 for an unknown item", async () => {
      expect((await botDone("nope")).status).toBe(404);
    });
  });
});

describe("snooze and the waiting list", () => {
  it("a snoozed item is out of waiting, in view=snoozed for both APIs, and back when it wakes", async () => {
    const item = await createItem({ type: "approval" });
    await call("POST", `/api/inbox/items/${item.id}/snooze`, { headers: INBOX, body: { minutes: 30 } });
    expect((await list("waiting")).map((i) => i.id)).not.toContain(item.id);
    expect((await list("snoozed")).map((i) => i.id)).toContain(item.id);
    const botSnoozed = await call("GET", `/api/items?view=snoozed&bot=${item.bot}`, { headers: BOT });
    expect(botSnoozed.body.items.map((i: Item) => i.id)).toEqual([item.id]);

    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("UPDATE items SET snooze_until = ? WHERE id = ?").bind(past, item.id).run();
    expect((await list("waiting")).find((i) => i.id === item.id)).toMatchObject({ type: "approval" });
  });
});

describe("new actions and auth", () => {
  it("refuses the bot token and no auth on reject, reply and the timeline", async () => {
    const item = await createItem();
    for (const headers of [BOT, {}]) {
      for (const [action, body] of [
        ["reject", undefined],
        ["reply", { text: "x" }],
      ] as const) {
        const res = await call("POST", `/api/inbox/items/${item.id}/${action}`, { headers, body });
        expect(res.status).toBe(401);
      }
      expect((await call("GET", "/api/inbox/events", { headers })).status).toBe(401);
      expect((await call("GET", "/api/inbox/items?view=rejected", { headers })).status).toBe(401);
    }
    expect((await events(item.id)).map((e) => e.type)).toEqual(["created"]);
  });

  it("doesn't let a bot set rejected (or any status) through PATCH or POST", async () => {
    const item = await createItem();
    expect((await call("PATCH", `/api/items/${item.id}`, { headers: BOT, body: { status: "rejected" } })).status).toBe(400);
    const post = await call("POST", "/api/items", { headers: BOT, body: { bot: "x", title: "y", status: "rejected" } });
    expect(post.status).toBe(400);
    expect((await call("POST", `/api/items/${item.id}/reject`, { headers: BOT })).status).toBe(404);
  });
});

describe("forwarding rejected and reply", () => {
  const hookEnv = { FORWARD_WEBHOOK_URL: HOOK_URL, FORWARD_WEBHOOK_KEY: "hook-key", FORWARD_SIGNING_SECRET: "sign-secret" };

  it("forwards both right away with action, note and text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    const item = await createItem();
    const reply = await call("POST", `/api/inbox/items/${item.id}/reply`, {
      headers: INBOX,
      body: { text: "Which branch?" },
      env: hookEnv,
    });
    const reject = await call("POST", `/api/inbox/items/${item.id}/reject`, {
      headers: INBOX,
      body: { note: "Too risky" },
      env: hookEnv,
    });
    expect([reply.body.forwarded, reject.body.forwarded]).toEqual(["queued", "queued"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const sent = fetchSpy.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(sent[0]).toMatchObject({ event_id: reply.body.event.id, action: "reply", text: "Which branch?", note: null });
    expect(sent[1]).toMatchObject({ event_id: reject.body.event.id, action: "rejected", note: "Too risky", text: null });
    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init?.headers).get("X-Agent-Inbox-Signature")).toMatch(/^sha256=[0-9a-f]{64}$/);
    }
    expect(await delivery(reply.body.event.id)).toMatchObject({ delivered_at: expect.any(String) });
    expect(await delivery(reject.body.event.id)).toMatchObject({ delivered_at: expect.any(String) });
  });

  it("includes the item's external_key in the forwarded payload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    const item = await createItem({ external_key: "welcome-reply" });
    await call("POST", `/api/inbox/items/${item.id}/reply`, { headers: INBOX, body: { text: "hi" }, env: hookEnv });
    const sent = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(sent).toMatchObject({ external_key: "welcome-reply", action: "reply", text: "hi" });
    const listed = await call("GET", `/api/events?since=${sent.event_id - 1}`, { headers: BOT });
    expect(listed.body.events[0]).toMatchObject({ event_id: sent.event_id, external_key: "welcome-reply" });
  });

  it("retries them from the cron and lists them in GET /api/events", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 503 }));
    const item = await createItem();
    const reply = await call("POST", `/api/inbox/items/${item.id}/reply`, { headers: INBOX, body: { text: "hm" }, env: hookEnv });
    const reject = await call("POST", `/api/inbox/items/${item.id}/reject`, { headers: INBOX, env: hookEnv });
    const ids = [reply.body.event.id, reject.body.event.id];
    for (const id of ids) expect(await delivery(id)).toMatchObject({ attempts: 1, last_error: "HTTP 503" });

    await env.DB.prepare(
      "UPDATE event_deliveries SET delivered_at = 'x' WHERE delivered_at IS NULL AND event_id NOT IN (?, ?)",
    )
      .bind(...ids)
      .run();
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare("UPDATE event_deliveries SET next_attempt_at = ? WHERE event_id IN (?, ?)")
      .bind(past, ...ids)
      .run();
    vi.restoreAllMocks();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    await cron(hookEnv);
    expect(fetchSpy.mock.calls.map(([, init]) => JSON.parse(init?.body as string).action)).toEqual(["reply", "rejected"]);
    for (const id of ids) expect(await delivery(id)).toMatchObject({ attempts: 2, delivered_at: expect.any(String) });

    const feed = await call("GET", `/api/events?since=${ids[0] - 1}&limit=2`, { headers: BOT });
    expect(feed.body.events.map((e: any) => [e.action, e.text])).toEqual([
      ["reply", "hm"],
      ["rejected", null],
    ]);
  });
});

describe("timeline events", () => {
  it("lists recent events across items with bot, title and item type, newest first", async () => {
    const item = await createItem({ type: "yes_no" });
    await call("POST", `/api/inbox/items/${item.id}/reply`, { headers: INBOX, body: { text: "yes" } });
    const res = await call("GET", `/api/inbox/events?bot=${item.bot}`, { headers: INBOX });
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: any) => e.type)).toEqual(["reply", "created"]);
    expect(res.body.events[0]).toMatchObject({
      item_id: item.id,
      bot: item.bot,
      title: item.title,
      item_type: "yes_no",
      payload: { text: "yes" },
    });
  });

  it("filters by since and validates it", async () => {
    const item = await createItem();
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await call("GET", `/api/inbox/events?bot=${item.bot}&since=${future}`, { headers: INBOX })).body.events).toEqual([]);
    expect((await call("GET", "/api/inbox/events?since=nope", { headers: INBOX })).status).toBe(400);
  });
});

describe("activity", () => {
  const post = (body: unknown, headers: Record<string, string> = BOT) =>
    call("POST", "/api/activity", { headers, body });
  const get = (query = "", headers: Record<string, string> = BOT) =>
    call("GET", `/api/activity${query}`, { headers });

  it("creates an entry (201) and returns it", async () => {
    const bot = `bot-${++counter}`;
    const res = await post({ bot, text: "Mowed the front lawn", status: "finished", at: "2026-10-26T15:00:00+01:00" });
    expect(res.status).toBe(201);
    expect(res.body.activity).toMatchObject({
      id: expect.any(String),
      bot,
      text: "Mowed the front lawn",
      status: "finished",
      external_key: null,
      at: "2026-10-26T14:00:00.000Z",
    });
    // No key: every post is a new entry.
    expect((await post({ bot, text: "Mowed the front lawn", status: "finished" })).status).toBe(201);
  });

  it("is idempotent on bot + external_key and moves in_progress to finished", async () => {
    const bot = `bot-${++counter}`;
    const first = await post({ bot, text: "Scanning trends", status: "in_progress", external_key: "scan-1" });
    expect(first.status).toBe(201);

    const same = await post({ bot, text: "Scanning trends", status: "in_progress", external_key: "scan-1" });
    expect(same.status).toBe(200);
    expect(same.body.activity).toEqual(first.body.activity);

    await env.DB.prepare("UPDATE activity SET at = ? WHERE id = ?")
      .bind("2026-01-01T00:00:00.000Z", first.body.activity.id)
      .run();
    const done = await post({ bot, text: "Found 4 trends", status: "finished", external_key: "scan-1" });
    expect(done.status).toBe(200);
    expect(done.body.activity).toMatchObject({ id: first.body.activity.id, text: "Found 4 trends", status: "finished" });
    expect(Date.now() - Date.parse(done.body.activity.at)).toBeLessThan(60_000); // restamped on status change

    const listed = (await get(`?bot=${bot}`)).body.activity;
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("finished");

    // Same key under another bot is a different entry.
    expect((await post({ bot: `${bot}-b`, text: "x", status: "finished", external_key: "scan-1" })).status).toBe(201);
  });

  it("keeps at on an update with the same status unless one is sent", async () => {
    const bot = `bot-${++counter}`;
    const at = "2026-10-20T10:00:00.000Z";
    await post({ bot, text: "v1", status: "in_progress", external_key: "k", at });
    const v2 = await post({ bot, text: "v2", status: "in_progress", external_key: "k" });
    expect(v2.body.activity).toMatchObject({ text: "v2", at });
    const v3 = await post({ bot, text: "v3", status: "finished", external_key: "k", at: "2026-10-21T10:00:00Z" });
    expect(v3.body.activity.at).toBe("2026-10-21T10:00:00.000Z");
  });

  it("validates input", async () => {
    const ok = { bot: "x", text: "y", status: "finished" };
    for (const body of [
      { ...ok, bot: undefined },
      { ...ok, text: "" },
      { ...ok, text: "x".repeat(501) },
      { ...ok, status: undefined },
      { ...ok, status: "done" },
      { ...ok, at: "yesterday" },
      { ...ok, at: 5 },
      { ...ok, at: new Date(Date.now() + 2 * 86_400_000).toISOString() },
      { ...ok, external_key: "" },
      { ...ok, external_key: 7 },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  it("filters GET by since and bot, newest first", async () => {
    const bot = `bot-${++counter}`;
    for (const [text, at] of [
      ["old", "2026-10-01T00:00:00Z"],
      ["mid", "2026-10-10T00:00:00Z"],
      ["new", "2026-10-20T00:00:00Z"],
    ]) {
      await post({ bot, text, status: "finished", at });
    }
    await post({ bot: `${bot}-other`, text: "other", status: "finished", at: "2026-10-20T00:00:00Z" });
    const texts = async (q: string) => (await get(q)).body.activity.map((a: any) => a.text);
    expect(await texts(`?bot=${bot}`)).toEqual(["new", "mid", "old"]);
    expect(await texts(`?bot=${bot}&since=2026-10-10`)).toEqual(["new", "mid"]);
    expect(await texts(`?since=2026-10-20T00:00:00Z&bot=${bot}-other`)).toEqual(["other"]);
    expect((await get("?since=nope")).status).toBe(400);
  });

  it("POST needs BOT_TOKEN; GET takes BOT_TOKEN or inbox auth", async () => {
    const body = { bot: "x", text: "y", status: "finished" };
    expect((await post(body, {})).status).toBe(401);
    expect((await post(body, { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(body, INBOX)).status).toBe(401);

    expect((await get("", {})).status).toBe(401);
    expect((await get("", { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await get("", BOT)).status).toBe(200);
    expect((await get("", INBOX)).status).toBe(200);
  });

  it("accepts a passkey session for GET but not for POST", async () => {
    const id = "test-session-id";
    const now = new Date();
    await env.DB.prepare("INSERT OR REPLACE INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(id), now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
      .run();
    const cookie = { Cookie: `${SESSION_COOKIE}=${id}` };
    expect((await get("", cookie)).status).toBe(200);
    expect((await call("GET", "/api/inbox/events", { headers: cookie })).status).toBe(200);
    expect((await post({ bot: "x", text: "y", status: "finished" }, cookie)).status).toBe(401);
  });
});

describe("test data", () => {
  const postActivity = (body: Record<string, unknown>) => call("POST", "/api/activity", { headers: BOT, body });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it("flags items and activity whose title/text starts with [TEST], exactly", async () => {
    expect((await createItem({ title: "[TEST] deploy dry run" })).is_test).toBe(true);
    expect((await createItem({ title: "  [TEST] padded" })).is_test).toBe(true); // trimmed first
    expect((await createItem({ title: "[test] lower case" })).is_test).toBe(false);
    expect((await createItem({ title: "Run the [TEST] suite" })).is_test).toBe(false);
    const bot = `bot-${++counter}`;
    expect((await postActivity({ bot, text: "[TEST] ping", status: "finished" })).body.activity.is_test).toBe(true);
    expect((await postActivity({ bot, text: "real work", status: "finished" })).body.activity.is_test).toBe(false);
  });

  it("flags anything sent with test: true, and validates test", async () => {
    expect((await createItem({ title: "Looks real", test: true })).is_test).toBe(true);
    expect((await createItem({ title: "Looks real", test: false })).is_test).toBe(false);
    const bot = `bot-${++counter}`;
    const a = await postActivity({ bot, text: "Looks real", status: "in_progress", test: true });
    expect(a.body.activity.is_test).toBe(true);
    for (const test of ["yes", 1, "true"]) {
      expect((await call("POST", "/api/items", { headers: BOT, body: { bot, title: "x", test } })).status).toBe(400);
      expect((await postActivity({ bot, text: "x", status: "finished", test })).status).toBe(400);
    }
  });

  it("keeps the flag on through re-posts and PATCH, which can also set it", async () => {
    const bot = `bot-${++counter}`;
    const first = await call("POST", "/api/items", { headers: BOT, body: { bot, title: "[TEST] a", external_key: "t1" } });
    const again = await call("POST", "/api/items", { headers: BOT, body: { bot, title: "renamed", external_key: "t1" } });
    expect(again.body.item).toMatchObject({ id: first.body.item.id, title: "renamed", is_test: true });

    const item = await createItem();
    const patched = await call("PATCH", `/api/items/${item.id}`, { headers: BOT, body: { test: true } });
    expect(patched.status).toBe(200);
    expect(patched.body.item.is_test).toBe(true);
    expect((await events(item.id)).at(-1)!.payload).toEqual({ source: "bot", test: true });
    const viaTitle = await createItem();
    const p2 = await call("PATCH", `/api/items/${viaTitle.id}`, { headers: BOT, body: { title: "[TEST] now" } });
    expect(p2.body.item.is_test).toBe(true);

    const k = await postActivity({ bot, text: "[TEST] start", status: "in_progress", external_key: "a1" });
    const done = await postActivity({ bot, text: "finished it", status: "finished", external_key: "a1" });
    expect(done.body.activity).toMatchObject({ id: k.body.activity.id, is_test: true });
  });

  it("hides test items from every item list unless include_test=1", async () => {
    const real = await createItem();
    const test = await createItem({ bot: real.bot, title: "[TEST] x" });
    const doneTest = await createItem({ bot: real.bot, title: "y", test: true, status: "done" });

    const bot = async (q: string) => ids((await call("GET", `/api/items?bot=${real.bot}${q}`, { headers: BOT })).body.items);
    expect(await bot("")).toEqual([real.id]);
    expect((await bot("&include_test=1")).sort()).toEqual([real.id, test.id].sort());
    expect(await bot("&view=done")).toEqual([]);
    expect(await bot("&view=done&include_test=true")).toEqual([doneTest.id]);

    for (const view of ["waiting", "all"]) {
      const inbox = async (q: string) =>
        ids((await call("GET", `/api/inbox/items?view=${view}${q}`, { headers: INBOX })).body.items);
      expect(await inbox("")).toContain(real.id);
      expect(await inbox("")).not.toContain(test.id);
      expect(await inbox("&include_test=1")).toContain(test.id);
    }
    // A direct read by id still works.
    expect((await call("GET", `/api/items/${test.id}`, { headers: BOT })).body.item.is_test).toBe(true);
  });

  it("hides test activity unless include_test=1, for the bot token and the inbox", async () => {
    const bot = `bot-${++counter}`;
    const real = (await postActivity({ bot, text: "real", status: "in_progress" })).body.activity;
    const test = (await postActivity({ bot, text: "[TEST] fake", status: "in_progress" })).body.activity;
    for (const headers of [BOT, INBOX]) {
      const get = async (q: string) => ids((await call("GET", `/api/activity?bot=${bot}${q}`, { headers })).body.activity);
      expect(await get("")).toEqual([real.id]);
      expect((await get("&include_test=1")).sort()).toEqual([real.id, test.id].sort());
    }
  });

  it("hides events on test items from the timeline and the event feed, via the item", async () => {
    const real = await createItem();
    const test = await createItem({ bot: real.bot, title: "[TEST] y" });
    const realReply = (await call("POST", `/api/inbox/items/${real.id}/reply`, { headers: INBOX, body: { text: "a" } })).body.event;
    const testReply = (await call("POST", `/api/inbox/items/${test.id}/reply`, { headers: INBOX, body: { text: "b" } })).body.event;

    const timeline = async (q: string) =>
      (await call("GET", `/api/inbox/events?bot=${real.bot}${q}`, { headers: INBOX })).body.events.map((e: any) => e.item_id);
    expect(new Set(await timeline(""))).toEqual(new Set([real.id]));
    expect(new Set(await timeline("&include_test=1"))).toEqual(new Set([real.id, test.id]));

    const since = realReply.id - 1;
    const feed = async (q: string) => (await call("GET", `/api/events?since=${since}${q}`, { headers: BOT })).body;
    const hidden = await feed("");
    expect(hidden.events.map((e: any) => e.event_id)).toEqual([realReply.id]);
    expect(hidden.next_cursor).toBe(String(realReply.id));
    // Resuming from there moves on past the hidden one without returning it.
    const shown = await feed("&include_test=1");
    expect(shown.events.map((e: any) => e.event_id)).toEqual([realReply.id, testReply.id]);
    const after = await call("GET", `/api/events?since=${realReply.id}`, { headers: BOT });
    expect(after.body.events).toEqual([]);
  });

  it("still forwards inbox actions on test items to the webhook", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 200 }));
    const item = await createItem({ test: true });
    const res = await call("POST", `/api/inbox/items/${item.id}/done`, {
      headers: INBOX,
      env: { FORWARD_WEBHOOK_URL: HOOK_URL },
    });
    expect(res.body.forwarded).toBe("queued");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("bot names", () => {
  const postActivity = (body: Record<string, unknown>) => call("POST", "/api/activity", { headers: BOT, body });

  it("stores bots listed in CANONICAL_BOTS under their listed name, whatever the casing", async () => {
    const canon = { CANONICAL_BOTS: "Deploy Bot, mail helper ,,QA" };
    for (const [sent, stored] of [
      ["deploy bot", "Deploy Bot"],
      ["DEPLOY BOT", "Deploy Bot"],
      ["Mail Helper", "mail helper"],
      ["qa", "QA"],
    ]) {
      const item = await call("POST", "/api/items", { headers: BOT, body: { bot: sent, title: "x" }, env: canon });
      expect(item.body.item.bot).toBe(stored);
      const act = await call("POST", "/api/activity", {
        headers: BOT,
        body: { bot: sent, text: "x", status: "finished" },
        env: canon,
      });
      expect(act.body.activity.bot).toBe(stored);
    }
  });

  it("keeps an unknown bot's first-seen casing, across items and activity", async () => {
    const name = `Side-Project-${++counter}`;
    expect((await postActivity({ bot: name, text: "x", status: "finished" })).body.activity.bot).toBe(name);
    expect((await createItem({ bot: name.toUpperCase() })).bot).toBe(name);
    expect((await createItem({ bot: name.toLowerCase() })).bot).toBe(name);
    expect((await postActivity({ bot: name.toLowerCase(), text: "y", status: "finished" })).body.activity.bot).toBe(name);
    // Not merged with names that only look alike.
    expect((await createItem({ bot: `${name}s` })).bot).toBe(`${name}s`);
  });

  it("matches external_key re-posts across casings", async () => {
    const key = `k-${++counter}`;
    const name = `Re-Post-${counter}`;
    const first = await call("POST", "/api/items", { headers: BOT, body: { bot: name, title: "a", external_key: key } });
    const again = await call("POST", "/api/items", {
      headers: BOT,
      body: { bot: name.toUpperCase(), title: "b", external_key: key },
    });
    expect(again.status).toBe(200);
    expect(again.body.item).toMatchObject({ id: first.body.item.id, bot: name, title: "b" });
    const a1 = await postActivity({ bot: name.toLowerCase(), text: "go", status: "in_progress", external_key: key });
    const a2 = await postActivity({ bot: name.toUpperCase(), text: "back", status: "finished", external_key: key });
    expect(a2.status).toBe(200);
    expect(a2.body.activity).toMatchObject({ id: a1.body.activity.id, bot: name, status: "finished" });
  });

  it("matches ?bot= case-insensitively on items, activity and the timeline", async () => {
    const name = `Case-Bot-${++counter}`;
    const item = await createItem({ bot: name });
    await call("POST", `/api/inbox/items/${item.id}/reply`, { headers: INBOX, body: { text: "ok" } });
    const act = (await postActivity({ bot: name, text: "x", status: "finished" })).body.activity;
    for (const q of [name, name.toLowerCase(), name.toUpperCase()]) {
      const items = (await call("GET", `/api/items?bot=${q}`, { headers: BOT })).body.items;
      expect(items.map((i: Item) => i.id)).toEqual([item.id]);
      const activity = (await call("GET", `/api/activity?bot=${q}`, { headers: BOT })).body.activity;
      expect(activity.map((a: any) => a.id)).toEqual([act.id]);
      const tl = (await call("GET", `/api/inbox/events?bot=${q}`, { headers: INBOX })).body.events;
      expect(tl.map((e: any) => e.type)).toEqual(["reply", "created"]);
    }
  });
});

describe("dashboard", () => {
  type Dashboard = {
    since: string;
    waiting: Item[];
    snoozed: Item[];
    done: Item[];
    rejected: Item[];
    activity: { id: string; bot: string; text: string; status: string; at: string; is_test: boolean }[];
    events: (Event & { id: number; bot: string; title: string; at: string })[];
  };
  const load = async (query = "", headers: Record<string, string> = INBOX) => {
    const res = await call("GET", `/api/inbox/dashboard${query}`, { headers });
    expect(res.status).toBe(200);
    return res.body as Dashboard;
  };
  const ids = (rows: { id: string | number }[]) => rows.map((r) => r.id);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const postActivity = (body: Record<string, unknown>) => call("POST", "/api/activity", { headers: BOT, body });
  // n rows from a recursive CTE, so the cap tests insert in one statement each.
  const series = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})`;

  it("takes the inbox secret or a passkey session, never the bot token", async () => {
    expect((await call("GET", "/api/inbox/dashboard")).status).toBe(401);
    expect((await call("GET", "/api/inbox/dashboard", { headers: BOT })).status).toBe(401);
    expect((await call("GET", "/api/inbox/dashboard", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    const id = "dashboard-session-id";
    const now = new Date();
    await env.DB.prepare("INSERT OR REPLACE INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(id), now.toISOString(), new Date(now.getTime() + 60_000).toISOString())
      .run();
    await load("", { Cookie: `${SESSION_COOKIE}=${id}` });
  });

  it("returns every list the page shows, from one request", async () => {
    const waiting = await createItem({ type: "approval" });
    const snoozed = await createItem();
    const done = await createItem();
    const rejected = await createItem();
    await call("POST", `/api/inbox/items/${snoozed.id}/snooze`, { headers: INBOX, body: { minutes: 60 } });
    await call("POST", `/api/inbox/items/${done.id}/done`, { headers: INBOX });
    await call("POST", `/api/inbox/items/${rejected.id}/reject`, { headers: INBOX, body: { note: "no" } });
    await call("POST", `/api/inbox/items/${waiting.id}/reply`, { headers: INBOX, body: { text: "on it" } });
    await call("PATCH", `/api/items/${waiting.id}`, { headers: BOT, body: { note: "edited" } });
    const act = (await postActivity({ bot: waiting.bot, text: "Working", status: "in_progress" })).body.activity;

    const d = await load();
    const window = Date.now() - Date.parse(d.since);
    expect(Math.abs(window - 7 * 86_400_000)).toBeLessThan(60_000);
    expect(ids(d.waiting)).toContain(waiting.id);
    expect(ids(d.waiting)).not.toContain(snoozed.id);
    expect(d.waiting.find((i) => i.id === waiting.id)).toMatchObject({ type: "approval", note: "edited", is_test: false });
    expect(ids(d.snoozed)).toContain(snoozed.id);
    expect(ids(d.done)).toContain(done.id);
    expect(ids(d.rejected)).toContain(rejected.id);
    expect(d.activity.find((a) => a.id === act.id)).toMatchObject({ status: "in_progress", is_test: false });
    // Timeline events carry bot, title and item type; edits are left out.
    const mine = d.events.filter((e) => e.item_id === waiting.id);
    expect(mine.map((e) => e.type)).toEqual(["reply", "created"]);
    expect(mine[0]).toMatchObject({ bot: waiting.bot, title: waiting.title, item_type: "approval", payload: { text: "on it" } });
    expect(d.events.find((e) => e.item_id === rejected.id && e.type === "rejected")?.payload).toMatchObject({ note: "no" });
  });

  it("wakes snoozed items that are due before listing", async () => {
    const item = await createItem();
    await call("POST", `/api/inbox/items/${item.id}/snooze`, { headers: INBOX, body: { minutes: 60 } });
    await env.DB.prepare("UPDATE items SET snooze_until = ? WHERE id = ?").bind(daysAgo(0.01), item.id).run();
    const d = await load();
    expect(ids(d.waiting)).toContain(item.id);
    expect(ids(d.snoozed)).not.toContain(item.id);
  });

  it("keeps to the last 7 days, except waiting, snoozed and running work", async () => {
    const bot = `bot-${++counter}`;
    const oldWaiting = await createItem({ bot });
    const oldDone = await createItem({ bot });
    const recentDone = await createItem({ bot });
    await call("POST", `/api/inbox/items/${oldDone.id}/done`, { headers: INBOX });
    await call("POST", `/api/inbox/items/${recentDone.id}/done`, { headers: INBOX });
    await env.DB.prepare("UPDATE items SET created_at = ?, updated_at = ? WHERE id IN (?, ?)")
      .bind(daysAgo(30), daysAgo(8), oldWaiting.id, oldDone.id)
      .run();
    // events are append-only, so an old one is inserted already backdated.
    await env.DB.prepare(`INSERT INTO events (item_id, type, payload, at) VALUES (?, 'reply', json_object('text', 'ancient'), ?)`)
      .bind(oldWaiting.id, daysAgo(8))
      .run();
    await call("POST", `/api/inbox/items/${oldWaiting.id}/reply`, { headers: INBOX, body: { text: "fresh" } });
    const oldFinished = (await postActivity({ bot, text: "old finished", status: "finished", at: daysAgo(8) })).body.activity;
    const oldRunning = (await postActivity({ bot, text: "long job", status: "in_progress", at: daysAgo(10) })).body.activity;
    const newFinished = (await postActivity({ bot, text: "new finished", status: "finished", at: daysAgo(6.9) })).body.activity;

    const d = await load();
    expect(ids(d.waiting)).toContain(oldWaiting.id);
    expect(ids(d.done)).toContain(recentDone.id);
    expect(ids(d.done)).not.toContain(oldDone.id);
    const acts = ids(d.activity);
    expect(acts).toContain(oldRunning.id);
    expect(acts).toContain(newFinished.id);
    expect(acts).not.toContain(oldFinished.id);
    const texts = d.events.filter((e) => e.item_id === oldWaiting.id).map((e) => e.payload.text);
    expect(texts).toContain("fresh");
    expect(texts).not.toContain("ancient");
    // Activity comes back newest first, each entry once.
    expect(new Set(acts).size).toBe(acts.length);
    const ats = d.activity.map((a) => a.at);
    expect(ats).toEqual([...ats].sort().reverse());
  });

  it("hides test rows and their events unless include_test=1", async () => {
    const bot = `bot-${++counter}`;
    const real = await createItem({ bot });
    const testItem = await createItem({ bot, title: "[TEST] dry run" });
    const testDone = await createItem({ bot, test: true });
    await call("POST", `/api/inbox/items/${testDone.id}/done`, { headers: INBOX });
    await call("POST", `/api/inbox/items/${testItem.id}/reply`, { headers: INBOX, body: { text: "test reply" } });
    const testAct = (await postActivity({ bot, text: "[TEST] ping", status: "in_progress" })).body.activity;
    const realAct = (await postActivity({ bot, text: "real", status: "finished" })).body.activity;
    const testIds: string[] = [testItem.id, testDone.id];

    const hidden = await load();
    expect(ids(hidden.waiting)).toContain(real.id);
    for (const list of [hidden.waiting, hidden.done]) {
      expect(list.some((i) => testIds.includes(i.id))).toBe(false);
    }
    expect(ids(hidden.activity)).toContain(realAct.id);
    expect(ids(hidden.activity)).not.toContain(testAct.id);
    expect(hidden.events.some((e) => testIds.includes(e.item_id))).toBe(false);

    const all = await load("?include_test=1");
    expect(ids(all.waiting)).toContain(testItem.id);
    expect(ids(all.done)).toContain(testDone.id);
    expect(all.activity.find((a) => a.id === testAct.id)?.is_test).toBe(true);
    expect(all.events.some((e) => e.item_id === testItem.id && e.payload.text === "test reply")).toBe(true);
  });

  // Keep this last: its future-dated rows fill every cap, crowding out rows
  // that tests after it would look for.
  it("caps events and activity at 200, done and rejected at 100 each, running at 50", async () => {
    const bot = `cap-bot-${++counter}`;
    const item = await createItem({ bot });
    const soon = new Date(Date.now() + 60_000).toISOString(); // newer than anything else in the database
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO events (item_id, type, payload, at) ${series(210)} SELECT ?, 'reply', '{}', ? FROM n`).bind(
        item.id,
        soon,
      ),
      env.DB.prepare(
        `INSERT INTO activity (id, bot, text, status, at, created_at, updated_at)
         ${series(210)} SELECT ? || '-a' || i, ?, 'x', 'finished', ?, ?, ? FROM n`,
      ).bind(bot, bot, soon, soon, soon),
      env.DB.prepare(
        `INSERT INTO activity (id, bot, text, status, at, created_at, updated_at)
         ${series(60)} SELECT ? || '-r' || i, ?, 'x', 'in_progress', ?, ?, ? FROM n`,
      ).bind(bot, bot, daysAgo(40), soon, soon),
      ...(["done", "rejected"] as const).map((status) =>
        env.DB.prepare(
          `INSERT INTO items (id, bot, title, status, created_at, updated_at)
           ${series(105)} SELECT ? || '-' || ? || i, ?, 'x', ?, ?, ? FROM n`,
        ).bind(bot, status, bot, status, soon, soon),
      ),
    ]);

    const d = await load();
    expect(d.events).toHaveLength(200);
    expect(d.events.every((e) => e.item_id === item.id)).toBe(true);
    expect(d.done).toHaveLength(100);
    expect(d.rejected).toHaveLength(100);
    expect(d.done.every((i) => i.bot === bot)).toBe(true);
    expect(d.activity.filter((a) => a.bot === bot && a.status === "finished")).toHaveLength(200);
    const running = d.activity.filter((a) => a.status === "in_progress");
    expect(running.length).toBeGreaterThan(0);
    expect(running.length).toBeLessThanOrEqual(50);
  });
});

describe("write caps", () => {
  // Fills the 24-hour window with rows written straight to D1, checks the cap,
  // then removes them so later tests start under it again.
  async function withFullWindow(table: "items" | "activity", count: number, check: () => Promise<void>) {
    const now = new Date().toISOString();
    const insert =
      table === "items"
        ? `INSERT INTO items (id, bot, title, is_test, created_at, updated_at)
           SELECT 'cap-' || n, 'cap-bot', 'filler', 1, ?1, ?1 FROM seq`
        : `INSERT INTO activity (id, bot, text, status, is_test, at, created_at, updated_at)
           SELECT 'cap-' || n, 'cap-bot', 'filler', 'finished', 1, ?1, ?1, ?1 FROM seq`;
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?2) ${insert}`,
    )
      .bind(now, count)
      .run();
    try {
      await check();
    } finally {
      await env.DB.prepare(`DELETE FROM ${table} WHERE id LIKE 'cap-%'`).run();
    }
  }

  it("refuses new items past 2000 in 24 hours, but still updates existing ones", async () => {
    const key = `cap-key-${++counter}`;
    const existing = await call("POST", "/api/items", { headers: BOT, body: { bot: "capper", title: "a", external_key: key } });
    expect(existing.status).toBe(201);
    await withFullWindow("items", 2000, async () => {
      const res = await call("POST", "/api/items", { headers: BOT, body: { bot: "capper", title: "one more" } });
      expect(res.status).toBe(429);
      const repost = await call("POST", "/api/items", { headers: BOT, body: { bot: "capper", title: "b", external_key: key } });
      expect(repost.status).toBe(200);
    });
    expect((await call("POST", "/api/items", { headers: BOT, body: { bot: "capper", title: "after" } })).status).toBe(201);
  });

  it("refuses new activity entries past 5000 in 24 hours", async () => {
    await withFullWindow("activity", 5000, async () => {
      const res = await call("POST", "/api/activity", { headers: BOT, body: { bot: "capper", text: "x", status: "finished" } });
      expect(res.status).toBe(429);
    });
  });

  it("refuses bot updates to an item that already has 1000 events", async () => {
    const item = await createItem();
    await env.DB.prepare(
      `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 999)
       INSERT INTO events (item_id, type, payload, at) SELECT ?, 'updated', '{}', ? FROM seq`,
    )
      .bind(item.id, new Date().toISOString())
      .run();
    const res = await call("PATCH", `/api/items/${item.id}`, { headers: BOT, body: { title: "again" } });
    expect(res.status).toBe(429);
    expect((await call("GET", `/api/items/${item.id}`, { headers: BOT })).body.item.title).toBe(item.title);
  });
});
