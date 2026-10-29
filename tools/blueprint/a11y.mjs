// Blueprint accessibility pass: keyboard operability and measured contrast.
// Tab-walks from the top, names every stop, asserts a visible focus indicator,
// and computes WCAG contrast from computed colors (no eyeballing).
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/a11y.mjs
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
const DEMO_DIR = process.env.DEMO_DIR ?? join(os.tmpdir() + "/hermes-duet-demo");
const INTERNAL_PORT = process.env.DUET_INTERNAL_PORT ?? "7467";
for (const d of ["ui", "render", "mp4", "data"]) fs.mkdirSync(`${BP}/${d}`, { recursive: true });

const report = { script: "a11y", run: `a11y-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "pending" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };

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

// 1. "/" jumps to the composer from anywhere (wait for it; the first render
// can starve a frame).
await page.keyboard.press("/");
await page.waitForFunction(() => { const el = document.activeElement; return el?.tagName === "TEXTAREA" && !!el.closest?.(".composer"); }, null, { timeout: 8000 }).catch(() => {});
const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inComposer: !!document.activeElement?.closest?.(".composer") }));
check('"/" focuses the composer', focused.tag === "TEXTAREA" && focused.inComposer, JSON.stringify(focused));

// 2. Tab-walk: every stop reachable, named, and visible.
await page.evaluate(() => document.querySelector(".topbar .top-gear")?.focus());
const stops = [];
for (let i = 0; i < 16; i++) {
  await page.keyboard.press("Tab");
  await page.waitForTimeout(120);
  const s = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.title || "").trim().replace(/\s+/g, " ").slice(0, 48);
    const cs = getComputedStyle(el);
    return { tag: el.tagName, name, visible: r.width > 0 && r.height > 0,
      focusShown: cs.outlineWidth !== "0px" && cs.outlineStyle !== "none" || cs.boxShadow !== "none" };
  });
  if (!s) break;
  stops.push(s);
}
const unnamed = stops.filter((s) => !s.name);
const hidden = stops.filter((s) => !s.visible);
const noFocus = stops.filter((s) => !s.focusShown);
check("Tab order reaches interactive controls with names", stops.length >= 8 && unnamed.length === 0, `${stops.length} stops${unnamed.length ? " unnamed: " + JSON.stringify(unnamed) : ""}`);
check("Every stop is visible", hidden.length === 0, hidden.length ? JSON.stringify(hidden) : `${stops.length} visible`);
check("Every stop shows a focus indicator", noFocus.length === 0, noFocus.length ? JSON.stringify(noFocus.slice(0, 3)) : `${stops.length} with outline/shadow`);
const shot = `${BP}/ui/${report.run}/a11y-focus.png`;
const png = await page.screenshot({ path: shot });
report.screenshots.push({ id: "a11y-focus", path: shot, group: "a11y", kind: "ui",
  source: "browser-ui", timeMs: 0, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
  sha256: createHash("sha256").update(png).digest("sha256") });

// 3. Contrast, computed from real pixels' styles.
const pairs = await page.evaluate(() => {
  const lum = (rgb) => {
    const m = rgb.match(/[\d.]+/g).map(Number).slice(0, 3).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  };
  const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const bgOf = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor; if (!/^rgba\(0, 0, 0, 0\)/.test(c) && c !== "transparent") return c; n = n.parentElement; } return "rgb(0, 0, 0)"; };
  const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const fg = getComputedStyle(el).color; return { sel, fg, bg: bgOf(el), ratio: +ratio(fg, bgOf(el)).toFixed(2) }; };
  return [
    pick(".card-title"),          // primary text on card
    pick(".bubble"),              // assistant bubble text
    pick(".card .card-body"),     // card body copy
    pick(".status-text"),         // status pill
    pick(".card-meta"),           // timestamps (informational)
    pick(".msg-time"),            // message times (informational)
  ].filter(Boolean);
});
report.perf.contrast = Object.fromEntries(pairs.map((p) => [p.sel, p.ratio]));
for (const p of pairs.slice(0, 4)) check(`Contrast ≥ 4.5: ${p.sel}`, p.ratio >= 4.5, `${p.ratio}:1`);
const info = pairs.slice(4);
check("Secondary text contrast ≥ 4.5 too", info.every((p) => p.ratio >= 4.5), info.map((p) => `${p.sel}=${p.ratio}:1`).join(" "));

report.perf.stops = stops.length;
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
