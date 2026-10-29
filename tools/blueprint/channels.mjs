// Blueprint channels pass: a second thread (#taxes) created through the real
// UI, a message posted in it, found again through search, jumped to.
// Needs channels to be fresh (seed has only #general): run after --reset,
// any time relative to sweep/live; approvals must run on the same seed after
// this (decisions are per-card, channels don't disturb them).
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/channels.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
import fs from "node:fs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const BP = resolve(process.env.BP_OUT ?? fileURLToPath(new URL("../../blueprint-out", import.meta.url)));
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:7466/";
const DEMO_DIR = process.env.DEMO_DIR ?? join(os.tmpdir(), "hermes-duet-demo");
const INTERNAL_PORT = process.env.DUET_INTERNAL_PORT ?? "7467";
for (const d of ["ui", "render", "mp4", "data"]) fs.mkdirSync(`${BP}/${d}`, { recursive: true });

const report = { script: "channels", run: `channels-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "pending" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };
const shot = async (page, name) => {
  const path = `${BP}/ui/${report.run}/${name}.png`;
  const png = await page.screenshot({ path });
  report.screenshots.push({ id: name, path, group: "channels", kind: "ui",
    source: "browser-ui", timeMs: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    sha256: createHash("sha256").update(png).digest("sha256") });
};

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) report.errors.push(`http ${r.status()} ${new URL(r.url()).pathname}`); });
await page.goto(APP_URL, { waitUntil: "load" });
await page.waitForSelector(".pair-card", { timeout: 30000 });
const token = fs.readFileSync(join(DEMO_DIR, "internal.token"), "utf8").trim();
const code = (await (await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).code;
await page.fill("#pair-code", code);
await page.click(".pair-card .btn-primary");
await page.waitForSelector(".card", { timeout: 30000 });

// Create #taxes through the channel sheet.
await page.locator('button.channel-pill.add').click();
await page.waitForSelector(".sheet.channels-sheet", { timeout: 10000 });
await page.fill('.channel-form input[aria-label="Channel name"]', "taxes");
await page.fill('.channel-form input[aria-label="Channel topic"]', "Deductions and receipts");
await page.waitForTimeout(400);
await shot(page, "channels-sheet");
await page.locator(".channel-form .btn-primary").click();
await page.waitForSelector(".channel-bar", { timeout: 15000 });
const barTopic = await page.locator(".channel-bar").innerText();
check("Channel sheet creates #taxes and the topic bar follows", /taxes/i.test(barTopic) && /deductions/i.test(barTopic), barTopic.replace(/\s+/g, " ").slice(0, 80));
// A busy project channel must not dethrone general: the strip keeps general first.
const firstPill = await page.locator(".channel-pill").first().innerText().catch(() => "");
check("General stays first in the strip", /general/i.test(firstPill), firstPill.replace(/\s+/g, " ").slice(0, 40));
await page.waitForTimeout(400);
await shot(page, "channels-taxes");

// Post in #taxes through the composer (queued while Hermes is down; the item lands either way).
const taxesNote = `Receipts to gather ${Date.now() % 100000}`;
await page.locator(".composer textarea").fill(taxesNote);
await page.locator('.composer button[aria-label="Send"], .composer button[aria-label="Start task"]').click();
await page.waitForFunction((t) => document.body.innerText.includes(t), taxesNote, { timeout: 15000 });
check("Message posted in #taxes appears in its thread", true, taxesNote);

// Find it again through search, jump to it.
await page.locator("button.channel-search").click();
await page.waitForSelector(".sheet.search-sheet", { timeout: 10000 });
await page.fill('.search-sheet input[aria-label="Search everything"]', "Receipts gather");
await page.waitForFunction(() => document.querySelectorAll(".search-hit").length > 0, null, { timeout: 15000 });
const hitCount = await page.locator(".search-hit").count();
check("Search finds the #taxes message", hitCount >= 1, `hits=${hitCount}`);
await page.locator(".search-hit").first().click();
await page.waitForTimeout(800);
const inView = await page.evaluate((t) => {
  const el = [...document.querySelectorAll(".msg, .card")].find((e) => (e.textContent ?? "").includes(t));
  if (!el) return "missing";
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight ? "visible" : "offscreen";
}, taxesNote);
check("Jump lands on the message", inView === "visible", inView);
await shot(page, "channels-jump");

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
