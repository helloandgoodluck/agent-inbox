// Screenshots the signed-in inbox from a running LOCAL `wrangler dev`.
//
// Usage: node scripts/screenshot.mjs --out shot.png [--width 1440] [--height 900]
//          [--scale 1] [--url http://localhost:8787] [--open-first] [--click <selector>]
//          [--persist-to <dir>]
//   --open-first  expands the first Waiting card so its actions show
//   --click       clicks an element first, e.g. '#tabs [data-pane=timeline]'
//   --persist-to  the local state dir, if wrangler dev was started with one
//
// Signs in the way chrome.mjs describes: local only, refuses --remote.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withInbox } from "./chrome.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = opt("out");
const width = Number(opt("width", 1440));
const height = Number(opt("height", 900));
const scale = Number(opt("scale", 1));
const url = opt("url", "http://localhost:8787");
if (!out) {
  console.error("Usage: node scripts/screenshot.mjs --out shot.png [--width 1440] [--height 900] [--open-first]");
  process.exit(1);
}

await withInbox({ url, width, height, scale }, async (page) => {
  if (args.includes("--open-first")) await page.evaluate("document.querySelector('.ask .card-main')?.click()");
  const click = opt("click");
  if (click) await page.evaluate(`document.querySelector(${JSON.stringify(click)})?.click()`);
  await sleep(400); // let fonts settle and transitions finish

  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(out), Buffer.from(shot.data, "base64"));
  console.log(`Saved ${width}x${height}${scale === 1 ? "" : ` @${scale}x`} screenshot to ${resolve(out)}`);
});
