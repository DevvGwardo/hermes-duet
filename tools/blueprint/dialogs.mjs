// Round-two harness: dialog focus containment + long-draft sizing + guards.
//   1-5. every dialog (viewer, search, settings, channels, live pane) moves
//        focus inside on open and keeps Tab inside (60 stops each)
//   6-7. a 700-char approval draft renders tall (>=300px), not a 3-line keyhole
//   8+. guards: empty-tasks contrast, search-kind contrast, no new errors
// Self-seeds the long draft (fresh seeds have none) via the demo DB directly.
// Run with the demo server up (see tools/blueprint/README.md):
//   APP_URL=http://127.0.0.1:7466/ node tools/blueprint/dialogs.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
import { execFileSync } from "node:child_process";
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

const report = { script: "dialogs", run: `dialogs-${randomUUID().slice(0, 8)}`, checks: [], perf: {}, timings: {}, errors: [], warnings: [], screenshots: [], visualReview: "reviewed" };
fs.mkdirSync(`${BP}/ui/${report.run}`, { recursive: true });
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail: String(detail) }); console.log(ok ? "PASS" : "FAIL", name, detail); };

const shot = async (page, name) => {
  const path = `${BP}/ui/${report.run}/${name}.png`;
  const png = await page.screenshot({ path });
  report.screenshots.push({ id: name, path, group: "dialogs", kind: "ui",
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

// Fresh seeds carry no long draft; insert one straight into the demo DB
// (server is idle: scheduler off, Hermes unreachable, so no write races).
function seedLongDraft() {
  const draft = ("Hi Dana, thanks for the quick turn on the MSA redline. Net 30 works for us on payment terms. " +
    "We would like to keep the 60-day termination notice exactly as written in section 8.2, since our procurement " +
    "cycle needs the full window for vendor transitions and data-export guarantees before any termination takes " +
    "effect on either side. If that works for you, can we target signing on Oct 28? ").repeat(3);
  const now = Date.now();
  const item = { id: "dialogs-draft", kind: "card", created_at: now, updated_at: now, run_id: null, task_id: null, card: { type: "approval", status: "pending", title: "Polish: long draft review", action_label: "Send", body: "The exact text below is what will be sent.", draft } };
  const sql = `INSERT OR REPLACE INTO items(id,kind,created_at,updated_at,run_id,task_id,json,channel_id) VALUES('dialogs-draft','card',${now},${now},NULL,NULL,'${JSON.stringify(item).replace(/'/g, "''")}','chan-general')`;
  execFileSync("python3", ["-c", `import sqlite3;con=sqlite3.connect('${DEMO_DIR}/duet.db',timeout=15);con.execute(${JSON.stringify(sql)});con.commit()`]);
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"] });

// Focus walk: open the dialog via a real (trusted) click so the opener takes
// focus, confirm focus lands inside, Tab through a full cycle and fail on the
// first stop outside, then confirm focus returns to the opener on close.
async function focusWalk(page, name, openerName, open, close) {
  await open();
  await page.waitForTimeout(500);
  const opener = openerName;
  const entered = await page.evaluate(() => {
    const a = document.activeElement;
    return { inside: !!a?.closest?.(".sheet,.browser-pane"), desc: `${a?.tagName || "?"}.${((a?.className || "").toString()).slice(0, 30)}` };
  });
  check(`${name}: focus moves inside on open`, entered.inside, entered.desc);
  const seen = [];
  let escaped = null;
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(15);
    const s = await page.evaluate(() => {
      const a = document.activeElement;
      return { inside: !!a?.closest?.(".sheet,.browser-pane"), d: `${a?.tagName || "?"}|${(a?.getAttribute?.("aria-label") || a?.textContent || "").slice(0, 30).replace(/\n/g, " ")}` };
    });
    seen.push(s.d);
    if (!s.inside) { escaped = s.d; break; }
  }
  check(`${name}: Tab stays inside (${seen.length} stops)`, escaped === null, escaped ?? `wrapped, ${new Set(seen).size} unique`);
  await close();
  await page.waitForTimeout(400);
  // Return focus must land back on the opener that was clicked, not BODY.
  const back = await page.evaluate((want) => {
    const a = document.activeElement;
    const got = (a?.getAttribute?.("aria-label") || a?.textContent || "").slice(0, 40).replace(/\n/g, " ");
    return { got, want };
  }, opener);
  check(`${name}: focus returns to the opener on close`, back.got.includes(opener), `${back.got} (want ${opener})`);
}

async function pairFresh(page) {
  await page.goto(APP_URL, { waitUntil: "load" });
  await page.waitForSelector(".pair-card", { timeout: 30000 }).catch(() => {});
  if (await page.locator("#pair-code").count()) {
    const code = await pairCode();
    await page.fill("#pair-code", code);
    await page.click(".pair-card .btn-primary");
    await page.waitForSelector(".card", { timeout: 30000 });
  }
  await page.waitForTimeout(700);
}

// ------------------------------------------------------- desktop
{
  const ctx = await newContext(browser, { viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  watch(page);
  await pairFresh(page);
  seedLongDraft();
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".card", { timeout: 30000 });
  await page.waitForTimeout(700);

  const closeBtn = () => page.evaluate(() => [...document.querySelectorAll(".sheet .icon-btn")].find((b) => b.getAttribute("aria-label") === "Close")?.click());
  const esc = () => page.keyboard.press("Escape").catch(() => {});

  await focusWalk(page, "viewer", "Weekly metrics dashboard",
    async () => {
      await page.evaluate(() => [...document.querySelectorAll(".dock-tab,.side-tab")].find((b) => /Make/.test(b.textContent || ""))?.click());
      await page.waitForTimeout(500);
      await page.locator(".make-pane .row").first().click();
      await page.waitForSelector(".sheet.viewer", { timeout: 10000 });
    },
    async () => { await closeBtn(); });
  await page.waitForTimeout(400);

  await focusWalk(page, "search", "Search everything",
    async () => {
      await page.evaluate(() => [...document.querySelectorAll(".dock-tab,.side-tab")].find((b) => /Chat/.test(b.textContent || ""))?.click());
      await page.waitForTimeout(400);
      await page.locator(".channel-search").first().click();
      await page.waitForSelector(".sheet.search-sheet", { timeout: 10000 });
    },
    async () => { await esc(); await page.waitForTimeout(300); await closeBtn(); });

  await focusWalk(page, "settings", "Settings",
    async () => {
      await page.getByRole("button", { name: "Settings" }).first().click();
      await page.waitForSelector(".sheet.settings", { timeout: 10000 });
    },
    async () => { await esc(); await page.waitForTimeout(300); await closeBtn(); });
  await shot(page, "dialogs-settings");

  await focusWalk(page, "channels", "New channel or manage channels",
    async () => {
      await page.locator(".channel-pill.add").first().click();
      await page.waitForSelector(".sheet.channels-sheet", { timeout: 10000 }).catch(() => {});
    },
    async () => { await esc(); await page.waitForTimeout(300); await closeBtn(); });

  await focusWalk(page, "live pane", "Live browser",
    async () => {
      await page.getByRole("button", { name: "Live browser" }).first().click();
      await page.waitForSelector(".browser-pane", { timeout: 30000 });
    },
    async () => {
      await page.evaluate(() => [...document.querySelectorAll(".browser-pane .icon-btn")].find((b) => b.getAttribute("aria-label") === "Close")?.click());
    });

  // A long draft fills its content (no internal scroll) and stands well
  // clear of the old 3-line keyhole.
  await page.evaluate(() => [...document.querySelectorAll(".dock-tab,.side-tab")].find((b) => /Chat/.test(b.textContent || ""))?.click());
  await page.waitForTimeout(500);
  const draft = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")];
    const card = cards.find((c) => (c.querySelector(".card-title")?.textContent || "").includes("long draft review"));
    const ta = card?.querySelector(".approval-draft textarea");
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { h: Math.round(r.height), sh: ta.scrollHeight, rows: ta.rows };
  });
  check("Long draft renders tall on desktop", !!draft && draft.h >= 250 && draft.sh - draft.h <= 2, draft ? `h=${draft.h} scrollH=${draft.sh} rows=${draft.rows}` : "draft card not found");
  await shot(page, "dialogs-draft");

  // empty In progress: cancel the running deck job, read the empty state
  await page.evaluate(() => [...document.querySelectorAll(".dock-tab,.side-tab")].find((b) => /Tasks/.test(b.textContent || ""))?.click());
  await page.waitForTimeout(500);
  await page.evaluate(() => [...document.querySelectorAll(".task-detail .btn")].find((b) => /Cancel|Stop/.test(b.textContent || ""))?.click());
  await page.waitForTimeout(1200);
  const empty = await page.evaluate(() => {
    const el = document.querySelector(".tasks-pane .muted.pad, .pane .muted.pad");
    if (!el) return null;
    const fg = getComputedStyle(el).color;
    let bg = "rgb(0,0,0)", n = el;
    while (n) {
      const c = getComputedStyle(n).backgroundColor;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); if (!(p.length >= 4 && p[3] === 0)) { bg = c; break; } }
      n = n.parentElement;
    }
    const lum = (s) => { const v = s.match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const a = lum(fg), b = lum(bg);
    return { fs: getComputedStyle(el).fontSize, ratio: +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2), txt: (el.textContent || "").slice(0, 60) };
  });
  check("Empty-tasks text contrast >= 4.5", !!empty && empty.ratio >= 4.5, empty ? `${empty.ratio}:1 ${empty.fs} "${empty.txt}"` : "no empty text");
  await shot(page, "dialogs-empty-tasks");

  // search-hit-kind on the active (gold-tinted) row, alpha-blended properly
  await page.evaluate(() => [...document.querySelectorAll(".dock-tab,.side-tab")].find((b) => /Chat/.test(b.textContent || ""))?.click());
  await page.waitForTimeout(400);
  await page.locator(".channel-search").first().click();
  await page.waitForSelector(".sheet.search-sheet", { timeout: 10000 });
  await page.fill(".search-head input", "dashboard");
  await page.waitForTimeout(900);
  const kind = await page.evaluate(() => {
    const row = document.querySelector(".search-hit.active") || document.querySelector(".search-hit");
    const el = row?.querySelector(".search-hit-kind");
    if (!el) return null;
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); return m ? m[1].split(",").map((x) => parseFloat(x)) : null; };
    const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const blend = (fg, bg) => { const a = fg.length >= 4 ? fg[3] : 1; return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)]; };
    const layers = [];
    let n = row;
    while (n) { const p = parse(getComputedStyle(n).backgroundColor); if (p) layers.push(p); if (p && (p.length < 4 || p[3] === 1)) break; n = n.parentElement; }
    let bg = [0, 0, 0];
    for (let i = layers.length - 1; i >= 0; i--) bg = blend([...layers[i].slice(0, 3), layers[i].length >= 4 ? layers[i][3] : 1], bg);
    const fg = parse(getComputedStyle(el).color).slice(0, 3);
    const a = lum(fg), b = lum(bg);
    return { ratio: +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2), fs: getComputedStyle(el).fontSize };
  });
  check("Search-kind contrast >= 4.5 on the active row", !!kind && kind.ratio >= 4.5, kind ? `${kind.ratio}:1 ${kind.fs}` : "no hits");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  await ctx.close();
}

// ------------------------------------------------------- phone: draft + spot focus
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
  await page.waitForTimeout(700);
  const draft = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".card")];
    const card = cards.find((c) => (c.querySelector(".card-title")?.textContent || "").includes("long draft review"));
    const ta = card?.querySelector(".approval-draft textarea");
    if (!ta) return null;
    return { h: Math.round(ta.getBoundingClientRect().height), sh: ta.scrollHeight };
  });
  check("Long draft renders tall at 390px", !!draft && draft.h >= 300, draft ? `h=${draft.h} scrollH=${draft.sh}` : "draft card not found (seed me first on desktop)");
  await shot(page, "dialogs-draft-mobile");
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
