import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { SESSION_COOKIE, sha256Hex } from "../src/passkeys";
import { SoftAuthenticator } from "./soft-authenticator";

const ORIGIN = "https://inbox.test";

let ipCounter = 0;

// Each call comes from a new client IP unless one is given, so the per-IP
// AUTH_LIMITER only comes into play in the test that's about it.
async function call(path: string, opts: { body?: unknown; cookie?: string; method?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": opts.ip ?? `10.0.${Math.floor(++ipCounter / 256)}.${ipCounter % 256}`,
  };
  if (opts.cookie) headers.Cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  const request = new Request(ORIGIN + path, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await worker.fetch(request, env, createExecutionContext());
  const setCookie = res.headers.get("Set-Cookie");
  const cookie = setCookie?.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`))?.[1];
  return { status: res.status, body: (await res.json()) as any, setCookie, cookie };
}

async function newToken(expiresInMs = 15 * 60 * 1000): Promise<string> {
  const token = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO enroll_tokens (token_hash, expires_at) VALUES (?, ?)")
    .bind(await sha256Hex(token), new Date(Date.now() + expiresInMs).toISOString())
    .run();
  return token;
}

async function enroll(token?: string) {
  token ??= await newToken();
  const auth = await SoftAuthenticator.create();
  const options = await call("/api/auth/register/options", { body: { token } });
  expect(options.status).toBe(200);
  const response = await auth.register(options.body, ORIGIN);
  const res = await call("/api/auth/register/verify", { body: { token, response } });
  expect(res.status).toBe(200);
  return { auth, token, cookie: res.cookie! };
}

async function loginResponse(auth: SoftAuthenticator, origin = ORIGIN) {
  const options = await call("/api/auth/login/options");
  expect(options.status).toBe(200);
  return auth.login(options.body, origin);
}

async function inboxStatus(cookie?: string) {
  return (await call("/api/inbox/items", { method: "GET", cookie })).status;
}

describe("enrollment", () => {
  it("registers a passkey with a setup link and signs in", async () => {
    const token = await newToken();
    const options = await call("/api/auth/register/options", { body: { token } });
    expect(options.status).toBe(200);
    expect(options.body.rp.id).toBe("inbox.test");
    expect(options.body.authenticatorSelection).toMatchObject({
      authenticatorAttachment: "platform",
      userVerification: "required",
    });

    const auth = await SoftAuthenticator.create();
    const res = await call("/api/auth/register/verify", {
      body: { token, response: await auth.register(options.body, ORIGIN) },
    });
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
    expect(await inboxStatus(res.cookie)).toBe(200);

    const stored = await env.DB.prepare("SELECT * FROM credentials WHERE id = ?").bind(auth.id).first();
    expect(stored).toMatchObject({ counter: 0, transports: '["internal"]' });
    const row = await env.DB.prepare("SELECT used_at FROM enroll_tokens WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first<{ used_at: string | null }>();
    expect(row?.used_at).not.toBeNull();
  });

  it("says whether any passkey is enrolled, for the sign-in hint", async () => {
    await env.DB.prepare("DELETE FROM credentials").run(); // storage is shared across this file's tests
    expect((await call("/api/auth/status", { method: "GET" })).body).toEqual({ passkeys: false });
    await enroll();
    expect((await call("/api/auth/status", { method: "GET" })).body).toEqual({ passkeys: true });
  });

  it("only stores the token's hash", async () => {
    const token = await newToken();
    const { results } = await env.DB.prepare("SELECT token_hash FROM enroll_tokens").all();
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it("rejects a setup link once it has been used", async () => {
    const { token } = await enroll();
    expect((await call("/api/auth/register/options", { body: { token } })).status).toBe(401);
  });

  it("lets only one of two in-flight registrations use a link", async () => {
    const token = await newToken();
    const [a, b] = [await SoftAuthenticator.create(), await SoftAuthenticator.create()];
    const optsA = await call("/api/auth/register/options", { body: { token } });
    const optsB = await call("/api/auth/register/options", { body: { token } });
    const resA = await call("/api/auth/register/verify", {
      body: { token, response: await a.register(optsA.body, ORIGIN) },
    });
    const resB = await call("/api/auth/register/verify", {
      body: { token, response: await b.register(optsB.body, ORIGIN) },
    });
    expect([resA.status, resB.status]).toEqual([200, 401]);
    expect(resB.cookie).toBeUndefined();
    expect(await env.DB.prepare("SELECT 1 FROM credentials WHERE id = ?").bind(b.id).first()).toBeNull();
  });

  it("rejects expired and unknown setup links", async () => {
    const expired = await newToken(-1000);
    expect((await call("/api/auth/register/options", { body: { token: expired } })).status).toBe(401);
    expect((await call("/api/auth/register/options", { body: { token: "nope" } })).status).toBe(401);
    expect((await call("/api/auth/register/options", { body: {} })).status).toBe(400);
  });

  it("rejects a link that expires between options and verify", async () => {
    const token = await newToken();
    const options = await call("/api/auth/register/options", { body: { token } });
    await env.DB.prepare("UPDATE enroll_tokens SET expires_at = ? WHERE token_hash = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), await sha256Hex(token))
      .run();
    const auth = await SoftAuthenticator.create();
    const res = await call("/api/auth/register/verify", {
      body: { token, response: await auth.register(options.body, ORIGIN) },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a registration from another origin and keeps the link usable", async () => {
    const token = await newToken();
    const options = await call("/api/auth/register/options", { body: { token } });
    const auth = await SoftAuthenticator.create();
    const res = await call("/api/auth/register/verify", {
      body: { token, response: await auth.register(options.body, "https://evil.test") },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("passkey verification failed");
    await enroll(token);
  });
});

describe("sign in", () => {
  it("signs in with a passkey and updates the counter", async () => {
    const { auth } = await enroll();
    const res = await call("/api/auth/login/verify", { body: { response: await loginResponse(auth) } });
    expect(res.status).toBe(200);
    expect(res.setCookie).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(await inboxStatus(res.cookie)).toBe(200);
    const row = await env.DB.prepare("SELECT counter FROM credentials WHERE id = ?")
      .bind(auth.id)
      .first<{ counter: number }>();
    expect(row?.counter).toBe(1);
  });

  it("rejects a tampered signature", async () => {
    const { auth } = await enroll();
    const response = await loginResponse(auth);
    const sig = isoBase64URL.toBuffer(response.response.signature);
    sig[sig.length - 1] ^= 1;
    response.response.signature = isoBase64URL.fromBuffer(sig);
    const res = await call("/api/auth/login/verify", { body: { response } });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("passkey verification failed");
    expect(res.setCookie).toBeNull();
  });

  it("rejects an assertion made for another origin", async () => {
    const { auth } = await enroll();
    const response = await loginResponse(auth, "https://evil.test");
    const res = await call("/api/auth/login/verify", { body: { response } });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("passkey verification failed");
  });

  it("rejects a passkey that isn't enrolled", async () => {
    await enroll();
    const stranger = await SoftAuthenticator.create();
    const response = await loginResponse(stranger);
    expect((await call("/api/auth/login/verify", { body: { response } })).status).toBe(401);
  });

  it("rejects a replayed assertion", async () => {
    const { auth } = await enroll();
    const response = await loginResponse(auth);
    expect((await call("/api/auth/login/verify", { body: { response } })).status).toBe(200);
    const replay = await call("/api/auth/login/verify", { body: { response } });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/challenge/);
  });

  it("rejects an expired challenge", async () => {
    const { auth } = await enroll();
    const response = await loginResponse(auth);
    await env.DB.prepare("UPDATE challenges SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await call("/api/auth/login/verify", { body: { response } })).status).toBe(401);
  });

  it("rejects a made-up challenge and malformed responses", async () => {
    const { auth } = await enroll();
    const response = await auth.login({ challenge: "bm90LWlzc3VlZA", rpId: "inbox.test" }, ORIGIN);
    expect((await call("/api/auth/login/verify", { body: { response } })).status).toBe(401);
    expect((await call("/api/auth/login/verify", { body: { response: {} } })).status).toBe(400);
    expect((await call("/api/auth/login/verify", { body: {} })).status).toBe(400);
  });
});

describe("session cookie", () => {
  it("rejects missing, unknown and expired sessions", async () => {
    expect(await inboxStatus()).toBe(401);
    expect(await inboxStatus("not-a-session")).toBe(401);
    const { cookie } = await enroll();
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), await sha256Hex(cookie))
      .run();
    expect(await inboxStatus(cookie)).toBe(401);
  });

  it("works without INBOX_SECRET, which then just means 401 for everyone else", async () => {
    const { cookie } = await enroll();
    const noSecret = { ...env, INBOX_SECRET: undefined };
    const get = (headers: Record<string, string>) =>
      worker.fetch(new Request(`${ORIGIN}/api/inbox/items`, { headers }), noSecret, createExecutionContext());
    expect((await get({ Cookie: `${SESSION_COOKIE}=${cookie}` })).status).toBe(200);
    expect((await get({})).status).toBe(401);
    expect((await get({ Authorization: "Bearer " })).status).toBe(401);
  });

  it("works for inbox actions but not the bot API", async () => {
    const { cookie } = await enroll();
    const created = await worker.fetch(
      new Request(`${ORIGIN}/api/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ bot: "b", title: "t" }),
      }),
      env,
      createExecutionContext(),
    );
    const { item } = (await created.json()) as any;
    expect((await call(`/api/inbox/items/${item.id}/done`, { cookie })).status).toBe(200);
    expect((await call(`/api/items/${item.id}`, { method: "GET", cookie })).status).toBe(401);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const { cookie } = await enroll();
    const res = await call("/api/auth/logout", { cookie });
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=; Path=/; Max-Age=0;`));
    expect(await inboxStatus(cookie)).toBe(401);
  });
});

describe("rate limit", () => {
  it("caps /api/auth/* per client IP and leaves other IPs alone", async () => {
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await call("/api/auth/login/options", { ip: "192.0.2.7" })).status);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    const limited = await call("/api/auth/login/options", { ip: "192.0.2.7" });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain("too many");
    expect((await call("/api/auth/login/options", { ip: "192.0.2.8" })).status).not.toBe(429);
  });
});
