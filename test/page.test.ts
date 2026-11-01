// The page must stay cheap on D1: one request per load, and no reloading on
// its own. These read public/app.js as text, since it runs in a browser.
import { describe, expect, it } from "vitest";
import app from "../public/app.js?raw";
import html from "../public/index.html?raw";

describe("page loading", () => {
  it("never polls or reloads on its own", () => {
    expect(app).not.toMatch(/setInterval|requestAnimationFrame|visibilitychange|focus["']\s*,/);
    // setTimeout only for toasts and the refresh button's minimum spin, never to call load().
    for (const [line] of app.matchAll(/^.*setTimeout.*$/gm)) expect(line).not.toMatch(/load\(/);
  });

  it("reads everything from GET /api/inbox/dashboard, and from nothing else", () => {
    const gets = [...app.matchAll(/api\("GET",\s*[`"]([^`"]+)/g)].map((m) => m[1]);
    expect(gets).toEqual(["/api/inbox/dashboard"]);
    expect(app).not.toMatch(/\/api\/inbox\/items\?|\/api\/activity|\/api\/inbox\/events/);
  });

  it("loads on start and on the refresh button, and after an action updates locally", () => {
    const calls = [...app.matchAll(/\bload\(([^)]*)\)/g)].map((m) => m[0]);
    // The definition, showInbox() and the refresh button.
    expect(calls).toEqual(["load({ spin = false } = {})", "load()", "load({ spin: true })"]);
    expect(app).toMatch(/\$\("#refresh"\)\.addEventListener\("click", \(\) => load\(\{ spin: true \}\)\)/);
    expect(html).toMatch(/<button id="refresh"[^>]*aria-label="Refresh"/);
  });
});

describe("page actions", () => {
  it("puts action buttons only on waiting cards", () => {
    // renderAsk builds the card with Done/Reject/Reply/Snooze; only the waiting list uses it.
    expect([...app.matchAll(/renderAsk\b/g)].length).toBe(2);
    expect(app).toMatch(/function renderWaiting\(list, snoozed\)[\s\S]*?list\.map\(renderAsk\)/);
    expect(app).toMatch(/renderWaiting\(waiting, /);
  });

  it("handles a 409 by moving the card from the response, without reloading", () => {
    expect(app).toMatch(/err\.status === 409 && err\.data\?\.item[\s\S]*?applyAction\(err\.data\.item\)/);
  });
});
