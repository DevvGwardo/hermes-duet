// Blueprint live-browser pass: the demo server owns a real headed Chrome (its own
// debug port + throwaway profile via env), and this script drives it end to end
// through the phone UI: open pane -> frames flow -> navigate to a local fixture
// through the URL bar -> tap the fixture -> frames show the effect.
// Run with the demo server up (see tools/blueprint/README.md):
//   APP_URL=http://127.0.0.1:7466/ FIXTURE_URL=http://127.0.0.1:7499/tap.html node tools/blueprint/live.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
import fs from "node:fs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// NOTE: don't name anything `URL` here: `new URL(...)` below needs the global.
const BP = resolve(process.env.BP_OUT ?? fileURLToPath(new URL("../../blueprint-out", import.meta.url)));
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:7466/";
const FIXTURE_URL = process.env.FIXTURE_URL ?? "http://127.0.0.1:7499/tap.html";
const DEMO_DIR = process.env.DEMO_DIR ?? join(os.tmpdir(), "hermes-duet-demo");
const INTERNAL_PORT = process.env.DUET_INTERNAL_PORT ?? "7467";
for (const d of ["ui", "render", "mp4", "data"]) fs.mkdirSync(`${BP}/${d}`, { recursive: true });

const report = { script: "live", run: `live-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "pending" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };

const shot = async (page, name) => {
  const path = `${BP}/ui/${report.run}/${name}.png`;
  const png = await page.screenshot({ path });
  report.screenshots.push({ id: name, path, group: "live-browser", kind: "ui",
    source: "browser-ui", timeMs: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    sha256: createHash("sha256").update(png).digest("hex") });
};

const t0 = Date.now();
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, acceptDownloads: true });
const ALLOW = (process.env.BP_ALLOW_HOSTS ?? "localhost,127.0.0.1,[::1]").split(",");
await ctx.route("**/*", (r) => {
  const u = new URL(r.request().url());
  if (!u.protocol.startsWith("http") || ALLOW.includes(u.hostname)) return r.continue();
  return r.abort();
});
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) report.errors.push(m.text()); });
page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) report.errors.push(`http ${r.status()} ${new URL(r.url()).pathname}`); });

// Hermetic driven-Chrome state: close every leftover page target (restarts and
// earlier runs leave tabs behind; open() would otherwise screencast tabs[0],
// which may be a dead about:blank that never paints). The pane then starts
// from a single fresh tab, exactly like a first launch.
{
  const CHROME_PORT = process.env.DUET_CHROME_PORT ?? "9334";
  const list = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`).catch(() => null))?.json().catch(() => []) ?? [];
  for (const t of list) {
    if (t.type === "page") await fetch(`http://127.0.0.1:${CHROME_PORT}/json/close/${t.id}`).catch(() => {});
  }
  let left = [];
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    left = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`).catch(() => null))?.json().catch(() => []) ?? [];
    if (left.filter((t) => t.type === "page").length === 0) break;
  }
  check("Driven Chrome starts with no leftover tabs", left.filter((t) => t.type === "page").length === 0, `${left.filter((t) => t.type === "page").length} left`);
}

// Pair through the real UI.
const token = fs.readFileSync(join(DEMO_DIR, "internal.token"), "utf8").trim();
const code = (await (await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).code;
await page.goto(APP_URL, { waitUntil: "load" });
await page.waitForSelector(".pair-card", { timeout: 30000 });
await page.fill("#pair-code", code);
await page.click(".pair-card .btn-primary");
await page.waitForSelector(".card", { timeout: 30000 });

// Open the live pane: the server launches its Chrome on first open.
await page.locator('.side-foot button.side-tab:has-text("Live browser")').click();
await page.waitForSelector(".browser-pane", { timeout: 30000 });
check("Live pane toolbar renders", (await page.locator(".browser-bar").count()) === 1);
// Wait for real frames: sample the canvas until it is not black.
const framed = await page.waitForFunction(() => {
  const c = document.querySelector(".browser-stage canvas");
  if (!c || !c.width) return false;
  const d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 120), Math.min(c.height, 120)).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 36) lit++;
  return lit / (d.length / 4) > 0.5;
}, null, { timeout: 60000 }).then(() => true).catch(() => false);
check("Non-black frames flow from the driven Chrome", framed);
report.timings.firstFrameMs = Date.now() - t0;
await page.waitForTimeout(1500);
await shot(page, "live-01-blank");

// Navigate through the pane's own URL bar, like a thumb would.
await page.locator(".browser-pane .browser-url").click();
await page.waitForSelector(".browser-urlbar input", { timeout: 10000 });
await page.fill(".browser-urlbar input", FIXTURE_URL);
await page.locator(".browser-urlbar button").click();
await page.waitForFunction((u) => (document.querySelector(".browser-pane .browser-url")?.textContent ?? "").includes(u), new URL(FIXTURE_URL).host, { timeout: 30000 });
check("URL-bar navigation lands on the fixture", true, new URL(FIXTURE_URL).host);
await page.waitForFunction(() => {
  const c = document.querySelector(".browser-stage canvas");
  if (!c || !c.width) return false;
  const d = c.getContext("2d").getImageData(0, 0, Math.min(c.width, 120), Math.min(c.height, 120)).data;
  let warm = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] > 150 && d[i + 2] < 120) warm++;
  return warm / (d.length / 4) > 0.4;
}, null, { timeout: 30000 }).then(() => true).catch(() => false);
await page.waitForTimeout(1200);
await shot(page, "live-02-fixture");

// Snapshot pixels, tap the center of the stage (the fixture button covers it),
// and measure the repaint in-page: the fixture flips gold -> green + TAP ME -> TAPPED.
const diff = await (async () => {
  const rect = await page.evaluate(() => {
    const c = document.querySelector(".browser-stage canvas");
    const r = c.getBoundingClientRect();
    // Snapshot the pixels before the tap so the repaint can be measured in-page.
    (window).__before = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y); // real CDP pointer events, through the pane's gesture path
  await page.waitForTimeout(1800);
  return page.evaluate(() => {
    const c = document.querySelector(".browser-stage canvas");
    const after = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    const before = window.__before;
    delete window.__before;
    let sum = 0, n = 0;
    for (let i = 0; i < after.data.length; i += 16) { sum += Math.abs(after.data[i] - before.data[i]) + Math.abs(after.data[i + 1] - before.data[i + 1]) + Math.abs(after.data[i + 2] - before.data[i + 2]); n += 3; }
    return sum / n;
  });
})().catch((e) => `eval failed: ${String(e?.message ?? e)}`);
check("A tap through the pane repaints the driven page", typeof diff === "number" && diff > 8, `mean abs diff=${typeof diff === "number" ? diff.toFixed(1) : diff}`);
await page.waitForTimeout(400);
await shot(page, "live-03-tapped");
report.perf.tapRepaintDiff = typeof diff === "number" ? +diff.toFixed(1) : -1;

report.perf.screenshots = report.screenshots.length;
const unexpected = report.errors.filter((e) => e !== "http 401 /api/state");
check("No unexpected console errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | ") || "clean");
report.captureStatus = report.screenshots.length ? "captured" : "failed";
const reportPath = `${BP}/data/report-${report.run}.json`;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ report: reportPath, run: report.run, screenshots: report.screenshots.length }));
const passed = report.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${report.checks.length} checks passed`, JSON.stringify(report.perf));
await browser.close();
process.exit(passed === report.checks.length ? 0 : 1);
