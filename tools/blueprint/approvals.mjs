// Blueprint approvals pass: the two pending cards in the seed get decided through
// the real UI — approve the Dana draft, answer the Thursday question — and the
// harness asserts the decided state, the rail badge count, and screenshots both.
// Needs a FRESH seed (decisions are one-way): restart the demo with --reset,
// run sweep.mjs first (it never taps), then this.
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/approvals.mjs
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
const DEMO_DIR = process.env.DEMO_DIR ?? join(os.tmpdir(), "hermes-duet-demo");
const INTERNAL_PORT = process.env.DUET_INTERNAL_PORT ?? "7467";
for (const d of ["ui", "render", "mp4", "data"]) fs.mkdirSync(`${BP}/${d}`, { recursive: true });

const report = { script: "approvals", run: `approvals-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "pending" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };

const shot = async (page, name) => {
  const path = `${BP}/ui/${report.run}/${name}.png`;
  const png = await page.screenshot({ path });
  report.screenshots.push({ id: name, path, group: "approvals", kind: "ui",
    source: "browser-ui", timeMs: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    sha256: createHash("sha256").update(png).digest("sha256") });
};

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
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

const token = fs.readFileSync(join(DEMO_DIR, "internal.token"), "utf8").trim();
const code = (await (await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/pair`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json()).code;
await page.goto(APP_URL, { waitUntil: "load" });
await page.waitForSelector(".pair-card", { timeout: 30000 });
await page.fill("#pair-code", code);
await page.click(".pair-card .btn-primary");
await page.waitForSelector(".card", { timeout: 30000 });

const pendingApprovals = await page.locator(".card-approval.is-pending").count();
const pendingChoices = await page.locator(".card-choice.is-pending").count();
check("Seed holds a pending approval and a pending question", pendingApprovals >= 1 && pendingChoices >= 1, `approvals=${pendingApprovals} choices=${pendingChoices}`);
const badgeBefore = await page.locator(".side-nav .side-tab .count").allTextContents();
check("Rail badge counts what needs you", badgeBefore.join(",").includes("2"), `badges=${badgeBefore.join(",") || "none"}`);
await page.evaluate(() => document.querySelector(".card-approval.is-pending")?.scrollIntoView({ block: "center" }));
await page.waitForTimeout(500);
await shot(page, "approvals-before");

// Approve the Dana draft through the UI.
await page.locator(".card-approval.is-pending .card-actions .btn-primary").first().click();
await page.waitForSelector(".card-approval .decision", { timeout: 15000 });
const approvalDecision = await page.locator(".card-approval .decision").first().innerText();
check("Approval decides and says what happened", /sent|approved/i.test(approvalDecision), approvalDecision.slice(0, 60));
await page.waitForTimeout(400);

// Answer the Thursday question with its first chip.
await page.locator(".card-choice.is-pending .card-actions .btn-primary").first().click();
await page.waitForSelector(".card-choice .decision", { timeout: 15000 });
const choiceDecision = await page.locator(".card-choice .decision").first().innerText();
check("Choice decides and names the chosen answer", /yes, move it/i.test(choiceDecision), choiceDecision.slice(0, 60));

await page.waitForTimeout(600);
const stillPending = await page.locator(".card.is-pending").count();
check("Nothing stays pending", stillPending === 0, `pending=${stillPending}`);
// The Chat badge (needs-you) must clear; the Tasks badge stays at 1 because the
// investor deck job is still running in the background — that is correct.
const chatBadge = await page.locator('.side-nav .side-tab >> nth=0 >> .count').count();
const taskBadge = await page.locator('.side-nav .side-tab >> nth=1 >> .count').allTextContents();
check("Needs-you badge clears, running-task badge stays", chatBadge === 0 && taskBadge.join(",") === "1", `chat=${chatBadge} tasks=${taskBadge.join(",") || "none"}`);
await page.evaluate(() => document.querySelector(".thread")?.scrollTo(0, 0));
await page.waitForTimeout(400);
await shot(page, "approvals-after");

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
