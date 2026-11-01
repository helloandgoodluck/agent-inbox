// Opens the signed-in inbox of a LOCAL `wrangler dev` in headless Chrome.
// Shared by screenshot.mjs and page-check.mjs.
//
// Signing in needs a passkey, which headless Chrome doesn't have, so this
// mints a short-lived session straight into the local D1 (only its SHA-256 is
// stored, as for a real sign-in), hands the cookie to Chrome over the DevTools
// protocol, and deletes the session afterwards. There's no route or flag for
// this in the Worker, so it can't be used against a deployed inbox: it refuses
// --remote and any URL that isn't localhost.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { refuseRemote, runLocalSql, sqlString as q } from "./local-d1.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const COOKIE = "__Host-inbox-session";

// Runs fn(page) with the dashboard loaded at url, where page has
// evaluate(expression), waitFor(expression) and send(method, params).
export async function withInbox({ url, width = 1440, height = 900, scale = 1 }, fn) {
  refuseRemote();
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    console.error("Refusing a non-local URL: this only drives a local wrangler dev.");
    process.exit(2);
  }

  const sessionId = randomBytes(32).toString("base64url");
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  const created = new Date();
  runLocalSql(
    `INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (${q(sessionHash)}, ${q(created.toISOString())}, ${q(
      new Date(created.getTime() + 10 * 60_000).toISOString(),
    )});`,
  );

  const profile = mkdtempSync(join(tmpdir(), "agent-inbox-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  try {
    const port = await devtoolsPort(profile);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find((t) => t.type === "page");
    const cdp = await connect(target.webSocketDebuggerUrl);
    const page = {
      send: cdp.send,
      evaluate: (expression) => evaluate(cdp, expression),
      waitFor: (expression, ms) => waitFor(cdp, expression, ms),
    };

    await cdp.send("Network.enable");
    const set = await cdp.send("Network.setCookie", {
      name: COOKIE,
      value: sessionId,
      url,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    });
    if (!set.success) throw new Error("Chrome refused the session cookie");
    const mobile = width < 600;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
    if (mobile) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url });
    const ready = await page.waitFor("document.querySelector('#summary')?.textContent.length > 0");
    if (!ready) {
      const signedOut = await page.evaluate("!document.querySelector('#login').hidden");
      throw new Error(signedOut ? "the page showed sign-in: the session wasn't accepted" : "the dashboard never loaded");
    }
    try {
      return await fn(page);
    } finally {
      cdp.close();
    }
  } finally {
    chrome.kill();
    runLocalSql(`DELETE FROM sessions WHERE id_hash = ${q(sessionHash)};`);
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
}

// Chrome writes the port it picked to DevToolsActivePort in the profile.
async function devtoolsPort(dir) {
  const file = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const port = readFileSync(file, "utf8").split("\n")[0];
      if (port) return port;
    }
    await sleep(100);
  }
  throw new Error("Chrome didn't start its DevTools endpoint");
}

// A minimal DevTools protocol client over Node's built-in WebSocket.
function connect(wsUrl) {
  return new Promise((resolveConn, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onerror = () => reject(new Error("couldn't connect to Chrome"));
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.error) p.reject(new Error(`${p.method}: ${data.error.message}`));
      else p.resolve(data.result);
    };
    ws.onopen = () =>
      resolveConn({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            pending.set(++id, { resolve: res, reject: rej, method });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
  });
}

async function evaluate(cdp, expression) {
  const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.value;
}

async function waitFor(cdp, expression, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await evaluate(cdp, expression).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}
