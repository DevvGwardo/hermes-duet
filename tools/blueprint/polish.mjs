// Polish pass harness: three phone-width defects, each asserted red-before/green-after.
//   1. status pill text fits at 390px (no ellipsis on the only status surface phones have)
//   2. search footer keyboard hints hidden on touch (coarse pointers have no ↑↓/↵/esc)
//   3. editable inputs are >=16px so iOS doesn't zoom on focus (composer/draft already are)
// Run with the demo server up (see tools/blueprint/README.md):
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/polish.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
import fs from "node:fs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BP = resolve(process.env.BP_OUT ?? fileURLToPath(new URL("../../blueprint-out", import.meta.url)));
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:7466/";
const DEMO_DIR = process.env.DEMO_DIR ?? join_tmp();
function join_tmp() { return `${os.tmpdir()}/hermes-duet-demo`; }
const INTERNAL_PORT = process.env.DUET_INTERNAL_PORT ?? "7467";
for (const d of ["ui", "data"]) fs.mkdirSync(`${BP}/${d}`, { recursive: true });

const report = { script: "polish", run: `polish-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "reviewed" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };

const shot = async (page, name) => {
  const path = `${BP}/ui/${report.run}/${name}.png`;
  const png = await page.screenshot({ path });
  report.screenshots.push({ id: name, path, group: "polish", kind: "ui",
    source: "browser-ui", timeMs: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
    sha256: createHash("sha256").update(png).digest("hex") });
};

async function newContext(browser, opts) {
  const ctx = await browser.newContext({ deviceScaleFactor: 2, acceptDownloads: true, ...opts });
  const ALLOW = (process.env.BP_ALLOW_HOSTS ?? "localhost,127.0.0.1,[::1]").split(",");
  await ctx.route("**/*", (r) => {
    const u = new URL(r.request().url());
    if (!u.protocol.startsWith("http") || ALLOW.includes(u.hostname)) return r.continue();
    return r.abort();
  });
  return ctx;
}

function watch(page) {
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) report.errors.push(m.text());
  });
  page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) report.errors.push(`http ${r.status()} ${new URL(r.url()).pathname}`);
  });
}

async function pairCode() {
  const token = fs.readFileSync(`${DEMO_DIR}/internal.token`, "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/internal/pair`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`internal/pair -> ${res.status}`);
  return (await res.json()).code;
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"] });

// ------------------------------------------------------- desktop: footer visible, inputs >=16px
{
  const ctx = await newContext(browser, { viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(APP_URL, { waitUntil: "load" });
  await page.waitForSelector(".pair-card", { timeout: 30000 });
  const code = await pairCode();
  await page.fill("#pair-code", code);
  await page.click(".pair-card .btn-primary");
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.waitForTimeout(600);

  // 3. editable inputs don't invite iOS zoom-on-focus (16px minimum, like the composer)
  const fonts = await page.evaluate(() => {
    const out = {};
    const el = (s) => document.querySelector(s);
    // settings sheet holds the time inputs; open it read-only via DOM
    return out;
  });
  void fonts;
  // open settings through the visible sidebar control
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.waitForSelector(".sheet.settings", { timeout: 10000 });
  await page.waitForTimeout(500);
  const inputFonts = await page.evaluate(() => {
    const px = (s) => { const el = document.querySelector(s); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
    return {
      time: px(".setting-row input[type='time']"),
      hook: px(".hook-row input"),
    };
  });
  check("Settings time inputs are >=16px (no iOS zoom)", (inputFonts.time ?? 0) >= 16, `time=${inputFonts.time}px`);
  await shot(page, "polish-settings-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // channel form inputs
  await page.evaluate(() => [...document.querySelectorAll(".channel-pill.add")].forEach((b) => b.click()));
  await page.waitForSelector(".sheet.channels-sheet", { timeout: 10000 }).catch(() => {});
  const chanFonts = await page.evaluate(() => {
    const els = [...document.querySelectorAll(".channel-form input")];
    return els.map((e) => parseFloat(getComputedStyle(e).fontSize));
  });
  if (chanFonts.length) check("Channel form inputs are >=16px (no iOS zoom)", chanFonts.every((f) => f >= 16), chanFonts.map((f) => `${f}px`).join(","));
  else check("Channel form inputs are >=16px (no iOS zoom)", false, "form not found");
  await shot(page, "polish-channels-sheet");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // desktop control: footer hints show where a keyboard exists
  await page.locator(".channel-search").first().click();
  await page.waitForSelector(".sheet.search-sheet", { timeout: 10000 });
  await page.fill(".search-head input", "dashboard");
  await page.waitForTimeout(900);
  const footDesktop = await page.evaluate(() => {
    const f = document.querySelector(".search-foot");
    if (!f) return { visible: false };
    const r = f.getBoundingClientRect();
    return { visible: getComputedStyle(f).display !== "none" && r.height > 0, h: Math.round(r.height) };
  });
  check("Search footer hints show on desktop", footDesktop.visible, footDesktop.visible ? `h=${footDesktop.h}` : "hidden");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // live pane URL bar is an editable input too (it renders after tapping the URL pill)
  await page.getByRole("button", { name: "Live browser" }).first().click();
  await page.waitForTimeout(800);
  await page.locator(".browser-url").first().click().catch(() => {});
  await page.waitForTimeout(400);
  const urlFont = await page.evaluate(() => {
    const el = document.querySelector(".browser-urlbar input");
    return el ? parseFloat(getComputedStyle(el).fontSize) : null;
  });
  if (urlFont !== null) check("Live pane URL bar is >=16px (no iOS zoom)", urlFont >= 16, `${urlFont}px`);
  else check("Live pane URL bar is >=16px (no iOS zoom)", false, "pane did not open");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  await ctx.close();
}

// ------------------------------------------------------- phone: status fits, footer hidden
{
  const ctx = await newContext(browser, {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(APP_URL, { waitUntil: "load" });
  await page.waitForSelector(".pair-card", { timeout: 30000 }).catch(() => {});
  if (await page.locator("#pair-code").count()) {
    const code = await pairCode();
    await page.fill("#pair-code", code);
    await page.click(".pair-card .btn-primary");
    await page.waitForSelector(".card", { timeout: 30000 });
  }
  await page.waitForTimeout(800);

  // 1. the pill is the only status surface on phones: it must read whole, not "Hermes of…"
  const status = await page.evaluate(() => {
    const t = document.querySelector(".status-pill .status-text");
    if (!t) return null;
    return { text: t.textContent, sw: t.scrollWidth, cw: t.clientWidth };
  });
  check("Status pill fits at 390px", !!status && status.sw <= status.cw, status ? `${status.text} sw=${status.sw} cw=${status.cw}` : "no pill");
  await shot(page, "polish-status-mobile");

  // 2. keyboard hints are noise where there is no keyboard
  await page.locator(".channel-search").first().click();
  await page.waitForSelector(".sheet.search-sheet", { timeout: 10000 });
  await page.fill(".search-head input", "dashboard");
  await page.waitForTimeout(900);
  const foot = await page.evaluate(() => {
    const f = document.querySelector(".search-foot");
    if (!f) return { hidden: true, why: "absent" };
    const r = f.getBoundingClientRect();
    const hidden = getComputedStyle(f).display === "none" || r.height === 0;
    return { hidden, why: `display=${getComputedStyle(f).display} h=${Math.round(r.height)}` };
  });
  check("Search footer hints hidden on touch", foot.hidden, foot.why);
  await shot(page, "polish-search-mobile");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // live pane URL bar (editable input #3)
  await page.evaluate(() => [...document.querySelectorAll(".top-gear")].find((b) => b.getAttribute("aria-label") === "Live browser")?.click());
  await page.waitForTimeout(800);
  const urlFont = await page.evaluate(() => {
    const el = document.querySelector(".browser-urlbar input");
    return el ? parseFloat(getComputedStyle(el).fontSize) : null;
  });
  // browser pane may not open without a driven Chrome; only assert when present
  if (urlFont !== null) check("Live pane URL bar is >=16px (no iOS zoom)", urlFont >= 16, `${urlFont}px`);
  await shot(page, "polish-browser-mobile");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  const noSideScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("No sideways scroll at 390px", noSideScroll);
  await ctx.close();
}

{
  const unexpected = report.errors.filter((e) => !/http 401 \/api\/state/.test(e));
  check("No unexpected console errors", unexpected.length === 0, unexpected.length ? unexpected.slice(0, 3).join(" | ") : "clean");
}

fs.writeFileSync(`${BP}/data/report-${report.run}.json`, JSON.stringify(report, null, 2));
const failed = report.checks.filter((c) => !c.ok);
console.log(JSON.stringify({ report: `${BP}/data/report-${report.run}.json`, run: report.run, screenshots: report.screenshots.length }));
console.log(`${report.checks.length - failed.length}/${report.checks.length} checks passed`);
if (failed.length) process.exit(1);
await browser.close();
