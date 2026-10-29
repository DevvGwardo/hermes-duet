// Blueprint recovery pass: Hermes unreachable, and the app server itself
// restarting under an open phone. Hermes is pointed at a dead port
// (DUET_HERMES_URL=http://127.0.0.1:9) so 'down' is deterministic; the demo
// server is stopped and started mid-run (data kept, no --reset) to prove the
// thread resyncs without duplicating cards.
// The demo must be running with the dead Hermes URL; this script restarts it.
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/recovery.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { execSync } = require("node:child_process");
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
const SKILL = `${os.homedir()}/.agents/skills/blueprint`;
for (const d of ["ui", "render", "mp4", "data"]) fs.mkdirSync(`${BP}/${d}`, { recursive: true });

const report = { script: "recovery", run: `recovery-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "pending" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };
const shot = async (page, name) => {
  const path = `${BP}/ui/${report.run}/${name}.png`;
  const png = await page.screenshot({ path });
  report.screenshots.push({ id: name, path, group: "recovery", kind: "ui",
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
await page.goto(APP_URL, { waitUntil: "load" });
await page.waitForSelector(".pair-card", { timeout: 30000 });
const token = fs.readFileSync(join(DEMO_DIR, "internal.token"), "utf8").trim();
const code = (await (await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).code;
await page.fill("#pair-code", code);
await page.click(".pair-card .btn-primary");
await page.waitForSelector(".card", { timeout: 30000 });

// Part A: Hermes is unreachable -> the app says so instead of spinning.
const offline = await page.waitForFunction(
  () => [...document.querySelectorAll(".status-text, .status-title")].some((el) => /offline|unreachable|reconnecting/i.test(el.textContent ?? "")),
  null, { timeout: 45000 }).then(() => true).catch(() => false);
const offlineText = await page.evaluate(() => [...document.querySelectorAll(".status-text, .status-title")].map((el) => el.textContent?.trim()).filter(Boolean).join(" / "));
check("Hermes-down surfaces as a status, not a spinner", offline, offlineText.slice(0, 80));
await page.waitForTimeout(400);
await shot(page, "recovery-offline");

// Part B: the server restarts under the open phone.
const before = await page.evaluate(() => [...document.querySelectorAll('[id^="item-"]')].map((el) => el.id).sort());
execSync(`python3 "${SKILL}/scripts/devserver.py" stop --url ${APP_URL}`, { stdio: "ignore" });
const reconnecting = await page.waitForFunction(
  () => [...document.querySelectorAll(".status-text, .status-title")].some((el) => /reconnecting/i.test(el.textContent ?? "")),
  null, { timeout: 30000 }).then(() => true).catch(() => false);
check("Dropped connection shows Reconnecting", reconnecting);
await page.waitForTimeout(400);
await shot(page, "recovery-reconnecting");
execSync(
  `python3 "${SKILL}/scripts/devserver.py" start --url ${APP_URL} --expect "Hermes Duet" --cwd /Users/devgwardo/hermes-duet -- ` +
  `env DUET_CHROME_PORT=9334 "DUET_CHROME_PROFILE=/Users/devgwardo/hermes-duet/blueprint-out/chrome-profile" DUET_HERMES_URL=http://127.0.0.1:9 bun scripts/demo.ts`,
  { stdio: "ignore" },
);
await page.waitForFunction(() => [...document.querySelectorAll(".card")].length > 0, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const after = await page.evaluate(() => [...document.querySelectorAll('[id^="item-"]')].map((el) => el.id).sort());
const dupes = after.length - new Set(after).size;
const kept = before.filter((id) => after.includes(id));
// Cards legitimately arrive mid-outage (a queued turn failing posts its retry
// card); resync must keep everything and duplicate nothing.
check("Thread resyncs without duplicating cards", dupes === 0 && kept.length === before.length, `before=${before.length} after=${after.length} dupes=${dupes}`);
await shot(page, "recovery-resynced");

report.perf.screenshots = report.screenshots.length;
check("No page errors across the outage", report.errors.length === 0, report.errors.slice(0, 3).join(" | ") || "clean");
report.captureStatus = report.screenshots.length ? "captured" : "failed";
const reportPath = `${BP}/data/report-${report.run}.json`;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ report: reportPath, run: report.run, screenshots: report.screenshots.length }));
const passed = report.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${report.checks.length} checks passed`, JSON.stringify(report.perf));
await browser.close();
process.exit(passed === report.checks.length ? 0 : 1);
