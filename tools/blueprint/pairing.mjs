// Blueprint pairing-failures pass: the gate around the whole app. Wrong codes,
// reused codes and cookie-less state changes must all be refused, with words a
// person can act on. The brute-force lockout (8 wrong guesses) is deliberately
// NOT tripped: it would poison the shared demo seed for the runs after this one.
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/pairing.mjs
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

const report = { script: "pairing", run: `pairing-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "pending" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
await page.goto(APP_URL, { waitUntil: "load" });
await page.waitForSelector(".pair-card", { timeout: 30000 });

// 1. A wrong code, through the real form.
await page.fill("#pair-code", "AAAA-0000");
await page.click(".pair-card .btn-primary");
await page.waitForSelector(".pair-card .error", { timeout: 10000 });
const errText = await page.locator(".pair-card .error").innerText();
check("Wrong code is refused with words, not a blank shake", /didn.t work|expir/i.test(errText), errText.slice(0, 60));
const shot = `${BP}/ui/${report.run}/pairing-error.png`;
const png = await page.screenshot({ path: shot });
report.screenshots.push({ id: "pairing-error", path: shot, group: "pairing", kind: "ui",
  source: "browser-ui", timeMs: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
  sha256: createHash("sha256").update(png).digest("sha256") });

// 2. A real code works once, then is dead (single use).
// 2. A real code works once, then is dead (single use). Plain fetch: no cookie
// jar, so each response status speaks for itself (page.request would share the
// context's cookies and contaminate the anonymous checks below).
const post = (p, data) => fetch(`${APP_URL}api/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const token = fs.readFileSync(join(DEMO_DIR, "internal.token"), "utf8").trim();
const code = (await (await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).code;
const first = await post("pair", { code });
check("Fresh code redeems (200)", first.status === 200, `status=${first.status}`);
const second = await post("pair", { code });
check("Same code is dead on reuse (401)", second.status === 401, `status=${second.status}`);

// 3. Cookie-less state changes stay out.
const anon = await post("messages", { text: "hello from nobody" });
check("Message without a device cookie is refused (401)", anon.status === 401, `status=${anon.status}`);
const anonAct = await post("cards/demo0001/act", { action: "approve" });
check("Card action without a device cookie is refused (401)", anonAct.status === 401, `status=${anonAct.status}`);
const health = await fetch(`${APP_URL}api/health`);
check("Health stays public (liveness needs no pairing)", health.status === 200, `status=${health.status}`);

report.perf.screenshots = report.screenshots.length;
check("No page errors during the refusal paths", report.errors.length === 0, report.errors.slice(0, 3).join(" | ") || "clean");
report.captureStatus = report.screenshots.length ? "captured" : "failed";
const reportPath = `${BP}/data/report-${report.run}.json`;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ report: reportPath, run: report.run, screenshots: report.screenshots.length }));
const passed = report.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${report.checks.length} checks passed`, JSON.stringify(report.perf));
await browser.close();
process.exit(passed === report.checks.length ? 0 : 1);
