// Passkey (WebAuthn) sign-in for the inbox page.
//
//   POST /api/auth/register/options  { token }            options for navigator.credentials.create
//   POST /api/auth/register/verify   { token, response }  stores the passkey and signs in
//   POST /api/auth/login/options                          options for navigator.credentials.get
//   POST /api/auth/login/verify      { response }         signs in
//   POST /api/auth/logout
//   GET  /api/auth/status                                 { passkeys: boolean }, whether any is enrolled
//
// Registering needs a one-time enroll token from scripts/enroll-link.mjs. Signing
// in sets an HttpOnly session cookie that the inbox API accepts instead of
// INBOX_SECRET. The RP ID and origin come from the request URL, so the same code
// works on workers.dev and on localhost.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { HttpError, json, nowIso, readJson } from "./http";

export const SESSION_COOKIE = "__Host-inbox-session";
const SESSION_TTL_S = 30 * 24 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Single user, so every passkey belongs to the same WebAuthn user handle.
const USER_ID = new Uint8Array(new TextEncoder().encode("agent-inbox-owner"));

type CredentialRow = { id: string; public_key: string; counter: number; transports: string };
type ChallengeRow = { challenge: string; kind: string; token_hash: string | null; expires_at: string };

export async function authRoute(request: Request, env: Env, pathname: string) {
  if (request.method === "GET" && pathname === "/api/auth/status") {
    // Lets the sign-in page hint at a setup link when nothing is enrolled yet.
    // Login options already reveal this (409), so it leaks nothing new.
    return json({ passkeys: (await env.DB.prepare("SELECT 1 FROM credentials LIMIT 1").first()) !== null });
  }
  if (request.method !== "POST") return null;
  switch (pathname) {
    case "/api/auth/register/options":
      return registerOptions(request, env);
    case "/api/auth/register/verify":
      return registerVerify(request, env);
    case "/api/auth/login/options":
      return loginOptions(request, env);
    case "/api/auth/login/verify":
      return loginVerify(request, env);
    case "/api/auth/logout":
      return logout(request, env);
  }
  return null;
}

export async function hasSession(request: Request, env: Env): Promise<boolean> {
  const id = readCookie(request, SESSION_COOKIE);
  if (!id) return false;
  const row = await env.DB.prepare("SELECT 1 FROM sessions WHERE id_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(id), nowIso())
    .first();
  return row !== null;
}

// --- registration -------------------------------------------------------

async function registerOptions(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const tokenHash = await checkEnrollToken(env, body.token);
  const { results } = await env.DB.prepare("SELECT id, transports FROM credentials").all<CredentialRow>();
  const options = await generateRegistrationOptions({
    rpName: "Agent Inbox",
    rpID: new URL(request.url).hostname,
    userName: "owner",
    userDisplayName: "Agent Inbox owner",
    userID: USER_ID,
    excludeCredentials: results.map((c) => ({ id: c.id, transports: JSON.parse(c.transports) })),
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "required",
      userVerification: "required",
    },
  });
  await saveChallenge(env, options.challenge, "register", tokenHash);
  return json(options);
}

async function registerVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const tokenHash = await checkEnrollToken(env, body.token);
  const response = passkeyResponse<RegistrationResponseJSON>(body.response);
  const challenge = await takeChallenge(env, response, "register");
  if (challenge.token_hash !== tokenHash) throw new HttpError(401, "challenge was issued for another link");

  const { origin, hostname } = new URL(request.url);
  const result = await verified(() =>
    verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: hostname,
      requireUserVerification: true,
    }),
  );
  if (!result.verified) throw new HttpError(401, "passkey verification failed");

  // Spend the token. The WHERE clause makes a racing second request lose.
  const now = nowIso();
  const spent = await env.DB.prepare(
    "UPDATE enroll_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(now, tokenHash, now)
    .run();
  if (spent.meta.changes !== 1) throw new HttpError(401, "enroll link is invalid, expired or already used");

  const { credential } = result.registrationInfo;
  await env.DB.prepare(
    "INSERT INTO credentials (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      credential.id,
      isoBase64URL.fromBuffer(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      now,
    )
    .run();
  return signIn(env);
}

// Returns the token's hash if it's unused and unexpired. Doesn't spend it.
async function checkEnrollToken(env: Env, token: unknown): Promise<string> {
  if (typeof token !== "string" || !token) throw new HttpError(400, "token is required");
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT 1 FROM enroll_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
  )
    .bind(hash, nowIso())
    .first();
  if (!row) throw new HttpError(401, "enroll link is invalid, expired or already used");
  return hash;
}

// --- sign in / out ------------------------------------------------------

async function loginOptions(request: Request, env: Env): Promise<Response> {
  if (!(await env.DB.prepare("SELECT 1 FROM credentials LIMIT 1").first())) {
    throw new HttpError(409, "no passkey enrolled yet; run scripts/enroll-link.mjs");
  }
  // No allowCredentials: the browser offers whichever passkey it has for this site.
  const options = await generateAuthenticationOptions({
    rpID: new URL(request.url).hostname,
    userVerification: "required",
  });
  await saveChallenge(env, options.challenge, "login", null);
  return json(options);
}

async function loginVerify(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const response = passkeyResponse<AuthenticationResponseJSON>(body.response);
  const challenge = await takeChallenge(env, response, "login");
  const cred = await env.DB.prepare("SELECT * FROM credentials WHERE id = ?")
    .bind(response.id)
    .first<CredentialRow>();
  if (!cred) throw new HttpError(401, "unknown passkey");

  const { origin, hostname } = new URL(request.url);
  const result = await verified(() =>
    verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: hostname,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: isoBase64URL.toBuffer(cred.public_key),
        counter: cred.counter,
        transports: JSON.parse(cred.transports),
      },
    }),
  );
  if (!result.verified) throw new HttpError(401, "passkey verification failed");

  await env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
    .bind(result.authenticationInfo.newCounter, nowIso(), cred.id)
    .run();
  return signIn(env);
}

async function signIn(env: Env): Promise<Response> {
  const id = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()),
    env.DB.prepare("INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)").bind(
      await sha256Hex(id),
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_S * 1000).toISOString(),
    ),
  ]);
  return withCookie(json({ ok: true }), id, SESSION_TTL_S);
}

async function logout(request: Request, env: Env): Promise<Response> {
  const id = readCookie(request, SESSION_COOKIE);
  if (id) {
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(id)).run();
  }
  return withCookie(json({ ok: true }), "", 0);
}

// --- challenges ---------------------------------------------------------

async function saveChallenge(env: Env, challenge: string, kind: string, tokenHash: string | null) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(new Date(now).toISOString()),
    env.DB.prepare(
      "INSERT INTO challenges (challenge, kind, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(challenge, kind, tokenHash, new Date(now + CHALLENGE_TTL_MS).toISOString()),
  ]);
}

// Finds the challenge the browser signed and deletes it, so it can't be used
// twice. The verifier then checks the signature over it.
async function takeChallenge(
  env: Env,
  response: { response: { clientDataJSON: string } },
  kind: string,
): Promise<ChallengeRow> {
  let challenge: unknown;
  try {
    challenge = JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON)).challenge;
  } catch {
    // handled below
  }
  if (typeof challenge !== "string") throw new HttpError(400, "invalid passkey response");
  const row = await env.DB.prepare("DELETE FROM challenges WHERE challenge = ? AND kind = ? RETURNING *")
    .bind(challenge, kind)
    .first<ChallengeRow>();
  if (!row || row.expires_at <= nowIso()) throw new HttpError(401, "challenge expired or already used");
  return row;
}

// --- helpers ------------------------------------------------------------

function passkeyResponse<T extends { id: string; response: { clientDataJSON: string } }>(
  value: unknown,
): T {
  const r = value as T | undefined;
  if (typeof r?.id !== "string" || typeof r.response?.clientDataJSON !== "string") {
    throw new HttpError(400, "response must be a passkey credential");
  }
  return r;
}

// The verifiers throw on most bad input; treat that the same as verified: false.
async function verified<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn("passkey verification failed:", (err as Error).message);
    throw new HttpError(401, "passkey verification failed");
  }
}

function withCookie(res: Response, value: string, maxAge: number): Response {
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
  );
  return res;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || null;
  }
  return null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
