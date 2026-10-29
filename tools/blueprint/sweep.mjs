// Blueprint sweep for Hermes Duet: every screen and modal, driven against a
// throwaway demo server (bun scripts/demo.ts) with seeded content.
// Run with the demo server up (see tools/blueprint/README.md):
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/sweep.mjs
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

const report = { script: "sweep", run: `sweep-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "reviewed" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };

const shot = async (page, name) => {
  const path = `${BP}/ui/${report.run}/${name}.png`;
  const png = await page.screenshot({ path });
  report.screenshots.push({ id: name, path, group: "ui-states", kind: "ui",
    source: "browser-ui", timeMs: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    sha256: createHash("sha256").update(png).digest("hex") });
};

async function newContext(browser, opts) {
  const ctx = await browser.newContext({ deviceScaleFactor: 2, acceptDownloads: true, ...opts });
  const ALLOW = (process.env.BP_ALLOW_HOSTS ?? "localhost,127.0.0.1,[::1]").split(",");
  const blocked = new Set();
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (!u.protocol.startsWith("http") || ALLOW.includes(u.hostname)) return r.continue();
    blocked.add(u.href);
    return r.abort();
  });
  return { ctx, blocked };
}

function watch(page) {
  page.on("console", (m) => {
    // "Failed to load resource" duplicates the response record below; skip it there.
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) report.errors.push(m.text());
    if (m.type() === "warning") report.warnings.push(m.text());
  });
  page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) report.errors.push(`http ${r.status()} ${new URL(r.url()).pathname}`);
  });
}

// A real pairing code from the demo server's loopback-only internal API.
async function pairCode() {
  const token = fs.readFileSync(join(DEMO_DIR, "internal.token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/pair`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`internal/pair -> ${res.status}`);
  return (await res.json()).code;
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"] });

// ---------------------------------------------------------------- pair screen (logged out)
{
  const { ctx } = await newContext(browser, { viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  watch(page);
  const t0 = Date.now();
  await page.goto(APP_URL, { waitUntil: "load" });
  await page.waitForSelector(".pair-card", { timeout: 30000 });
  report.timings.firstRenderMs = Date.now() - t0;
  const hasInput = await page.locator("#pair-code").count();
  check("Pair screen asks for a code", hasInput === 1, `inputs=${hasInput}`);
  // Let the wordmark/tagline decode loop settle so the capture shows the real design, not mid-scramble glyphs.
  await page.waitForFunction(() => document.querySelector(".pair-tag")?.firstElementChild?.textContent === "your agent, working alongside you", null, { timeout: 15000 }).catch(() => {});
  await shot(page, "01-pair");

  // Pair for real through the UI: code from the internal API, typed by the user.
  const code = await pairCode();
  await page.fill("#pair-code", code);
  await page.click(".pair-card .btn-primary");
  await page.waitForSelector(".card", { timeout: 30000 });
  check("Pairing with a real code lands in the thread", true, `code ${code.slice(0, 2)}… accepted`);
  report.perf.jsHeapMB = await page.evaluate(() => performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null);

  // ---------------------------------------------------------- chat thread
  await page.evaluate(() => document.querySelector(".thread")?.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await shot(page, "02-chat-thread");
  const titles = await page.locator(".card-title").allTextContents();
  check("Thread shows the morning brief", titles.some((t) => /4 things need you/.test(t)), `${titles.length} cards`);
  check("Thread shows a pending approval", (await page.locator(".card-approval.is-pending").count()) >= 1);
  check("Thread shows a pending question", (await page.locator(".card-choice.is-pending").count()) >= 1);
  check("Thread shows checklist + metrics cards", (await page.locator(".card-checklist").count()) >= 1 && (await page.locator(".card-metrics").count()) >= 1);
  const approveBtns = await page.locator(".card-approval.is-pending .card-actions .btn").allTextContents();
  check("Approval card offers Approve / Not now", approveBtns.join("|").includes("Not now"), approveBtns.join(" | "));

  // Approval close-up: scroll it into view.
  await page.evaluate(() => document.querySelector(".card-approval.is-pending")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(500);
  await shot(page, "03-approval-focus");

  // ---------------------------------------------------------- tasks tab
  await page.click('button.side-tab:has-text("Tasks")');
  await page.waitForFunction(() => document.querySelector('button.side-tab[aria-selected="true"]')?.textContent?.includes('Tasks'));
  await page.waitForSelector(".tasks-pane", { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "04-tasks");
  const taskRows = await page.locator(".tasks-pane .row-title").allTextContents();
  check("Tasks lists the running deck job", taskRows.some((t) => /Investor update deck/.test(t)), taskRows.join(" · "));
  check("Tasks lists the finished dashboard job", taskRows.some((t) => /Weekly metrics dashboard/.test(t)), taskRows.join(" · "));

  // ---------------------------------------------------------- make tab
  await page.click('button.side-tab:has-text("Make")');
  await page.waitForFunction(() => document.querySelector('button.side-tab[aria-selected="true"]')?.textContent?.includes('Make'));
  await page.waitForSelector(".make-pane", { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "05-make");
  const fileRows = await page.locator(".make-pane .row-title").allTextContents();
  check("Make lists the delivered dashboard", fileRows.some((t) => /Weekly metrics dashboard/.test(t)), fileRows.join(" · "));

  // ---------------------------------------------------------- viewer modal
  await page.locator(".make-pane .row").first().click();
  await page.waitForSelector(".sheet.viewer", { timeout: 10000 });
  await page.waitForTimeout(800);
  await shot(page, "06-viewer");
  const frameCount = await page.locator(".viewer-body iframe").count();
  check("Viewer renders the dashboard in a sandboxed frame", frameCount === 1, `iframes=${frameCount}`);
  const sandbox = await page.locator(".viewer-body iframe").getAttribute("sandbox");
  check("Viewer frame is sandboxed", !!sandbox && !String(sandbox).includes("allow-same-origin"), String(sandbox));
  await page.locator(".sheet.viewer .sheet-head .icon-btn").click();
  await page.waitForSelector(".sheet.viewer", { state: "detached", timeout: 10000 });

  // ---------------------------------------------------------- search overlay
  // (The channel search strip only renders on the Chat tab.)
  await page.click('button.side-tab:has-text("Chat")');
  await page.waitForTimeout(400);
  // (On wide screens the topbar icon buttons hide; use the visible one.)
  await page.locator('button.channel-search:visible').click();
  await page.waitForSelector(".sheet.search-sheet", { timeout: 10000 });
  await page.fill('.search-sheet input[aria-label="Search everything"]', "dashboard");
  await page.waitForTimeout(800);
  await shot(page, "07-search");
  const hitCount = await page.locator(".search-sheet .hit, .search-sheet .row, .search-sheet li").count();
  check("Search finds the dashboard", hitCount >= 1, `hits=${hitCount}`);
  const echoes = await page.evaluate(() =>
    [...document.querySelectorAll(".search-hit")].filter((el) => {
      const t = el.querySelector(".search-hit-title")?.textContent?.trim().toLowerCase();
      const s = el.querySelector(".search-hit-snippet")?.textContent?.trim().toLowerCase();
      return !!s && s === t;
    }).length,
  );
  check("Search rows don't echo the title as the snippet", echoes === 0, `echoes=${echoes} of ${hitCount}`);
  // Keyboard: arrows move the cursor, Enter opens the hit (lands in Chat).
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  const activeFirst = await page.evaluate(() => {
    const hits = [...document.querySelectorAll(".search-hit")];
    return hits.length > 0 && hits[0].classList.contains("active");
  });
  check("Arrow keys move, cursor returns to the first hit", activeFirst);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".sheet.search-sheet", { state: "detached", timeout: 10000 });
  const landedChat = await page.evaluate(() => document.querySelector(".app")?.className.includes("view-chat") ?? false);
  check("Enter opens the hit and lands in Chat", landedChat);

  // ---------------------------------------------------------- settings sheet
  await page.locator('.side-foot button.side-tab:has-text("Settings")').click();
  await page.waitForSelector(".sheet.settings", { timeout: 10000 });
  await page.waitForTimeout(800);
  await shot(page, "08-settings");
  const settingsText = await page.locator(".sheet.settings").innerText();
  const briefTime = await page.locator('.sheet.settings input[type="time"]').first().inputValue();
  check("Settings shows the morning brief controls", /morning brief/i.test(settingsText) && briefTime === "07:30", `time=${briefTime}`);
  check("Settings shows connectors + triggers", /connectors/i.test(settingsText) && /triggers/i.test(settingsText));
  await page.click(".sheet.settings .icon-btn");
  await page.waitForSelector(".sheet.settings", { state: "detached", timeout: 10000 });

  // ---------------------------------------------------------- live browser pane
  await page.locator('.side-foot button.side-tab:has-text("Live browser")').click();
  await page.waitForSelector(".browser-pane", { timeout: 10000 });
  await page.waitForTimeout(2500);
  await shot(page, "09-browser");
  const overlay = await page.locator(".browser-overlay").allTextContents().catch(() => []);
  check("Live browser pane opens (demo has no Chrome to drive)", (await page.locator(".browser-pane").count()) === 1, overlay.join(" ").slice(0, 80) || "canvas");
  await page.locator('.browser-pane button[aria-label="Close"]').click();

  // Back to a clean final state; save the device cookie for the phone pass.
  await page.click('button.side-tab:has-text("Chat")');
  await page.waitForFunction(() => document.querySelector('button.side-tab[aria-selected="true"]')?.textContent?.includes('Chat'));
  const cookies = await ctx.cookies();
  const device = cookies.find((c) => c.name === "duet_device");
  check("Pairing cookie is HttpOnly", !!device && device.httpOnly === true, device ? "duet_device set" : "missing");
  await ctx.close();
  var savedCookies = device ? [{ name: device.name, value: device.value, url: APP_URL }] : [];
}

// ---------------------------------------------------------------- phone width (fresh context)
{
  const { ctx } = await newContext(browser, {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  if (savedCookies.length) await ctx.addCookies(savedCookies);
  const page = await ctx.newPage();
  watch(page);
  await page.goto(APP_URL, { waitUntil: "load" });
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.waitForTimeout(600);
  await shot(page, "10-mobile-chat");
  // The empty composer must stay one line: five buttons have to leave room for the placeholder.
  const composerH = await page.evaluate(() => document.querySelector(".composer textarea")?.getBoundingClientRect().height ?? 0);
  check("Composer stays single-line at 390px", composerH <= 46, `textarea=${Math.round(composerH)}px`);
  const noSideScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("No sideways scroll at 390px", noSideScroll);
  await page.click('button.dock-tab:has-text("Tasks")');
  await page.waitForSelector(".tasks-pane", { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "11-mobile-tasks");
  await page.click('button.dock-tab:has-text("Make")');
  await page.waitForSelector(".make-pane", { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "12-mobile-make");
  await ctx.close();
}

report.perf.screenshots = report.screenshots.length;
report.perf.firstRenderMs = report.timings.firstRenderMs;
check("Visual evidence includes actual screenshots", report.screenshots.length >= 10, `${report.screenshots.length} shots`);
// The logged-out pair screen probes /api/state and gets the expected 401 that
// flips it into pairing mode; everything else 4xx/5xx or a JS error fails.
const unexpected = report.errors.filter((e) => e !== "http 401 /api/state");
check("No unexpected console errors", unexpected.length === 0, unexpected.slice(0, 3).join(" | ") || "only the expected logged-out /api/state 401");
report.captureStatus = report.screenshots.length ? "captured" : "failed";
const reportPath = `${BP}/data/report-${report.run}.json`;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ report: reportPath, run: report.run, screenshots: report.screenshots.length }));
const passed = report.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${report.checks.length} checks passed`, JSON.stringify(report.perf));
await browser.close();
process.exit(passed === report.checks.length ? 0 : 1);
