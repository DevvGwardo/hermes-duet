#!/usr/bin/env bun
// Regenerates the README art in docs/brand/ from a demo instance (never your real thread).
//   bun scripts/brand/render.ts
// Needs Playwright browsers: `bunx playwright-core install chromium webkit` if they are missing.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, devices, webkit, type Browser, type BrowserContextOptions } from 'playwright-core';
import { DEMO_DIR, DEMO_INTERNAL_PORT, DEMO_PORT } from '../demo.ts';

const root = resolve(import.meta.dir, '../..');
const out = join(root, 'docs', 'brand');
const raw = join(out, '.raw');
mkdirSync(raw, { recursive: true });
const app = `http://127.0.0.1:${DEMO_PORT}`;

async function up() {
  try {
    return (await fetch(`${app}/api/state`)).status === 401;
  } catch {
    return false;
  }
}

const demo = Bun.spawn(['bun', join(root, 'scripts/demo.ts'), '--reset'], { stdout: 'ignore', stderr: 'inherit' });
for (let i = 0; i < 50 && !(await up()); i++) await Bun.sleep(200);
if (!(await up())) throw new Error('demo server did not start');

async function cookie() {
  const token = (await Bun.file(join(DEMO_DIR, 'internal.token')).text()).trim();
  const { code } = (await (await fetch(`http://127.0.0.1:${DEMO_INTERNAL_PORT}/internal/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json()) as any;
  const res = await fetch(`${app}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const [name, ...rest] = res.headers.get('set-cookie')!.split(';')[0].split('=');
  return [{ name, value: rest.join('='), domain: '127.0.0.1', path: '/' }];
}

async function page(browser: Browser, opts: BrowserContextOptions) {
  const ctx = await browser.newContext(opts);
  await ctx.addCookies(await cookie());
  await ctx.addInitScript(() => localStorage.setItem('duet.hideInstall', '1'));
  const p = await ctx.newPage();
  await p.goto(app);
  await p.waitForSelector('.thread .card');
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(700);
  return p;
}

const cr = await chromium.launch();
const wk = await webkit.launch();
try {
  // Raw screens from the demo app.
  const desk = await page(cr, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await desk.evaluate(() => (document.querySelector('.thread')!.scrollTop = 0));
  await desk.waitForTimeout(300);
  await desk.screenshot({ path: join(raw, 'desktop.png') });

  // Full-screen viewport: this is how the installed (home-screen) app looks, without Safari's toolbars.
  const phone = await page(wk, { ...devices['iPhone 15'], viewport: { width: 393, height: 852 } });
  await phone.evaluate(() => (document.querySelector('.thread')!.scrollTop = 0));
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: join(raw, 'phone-brief.png') });
  await phone.evaluate(() => {
    const card = [...document.querySelectorAll('.card-approval')].pop() as HTMLElement;
    card.scrollIntoView({ block: 'center' });
  });
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: join(raw, 'phone-approve.png') });
  await phone.click('.dock-tab:nth-child(2)');
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: join(raw, 'phone-tasks.png') });

  // Composed sheets.
  const sheets: [string, number, number][] = [
    ['banner', 1280, 640],
    ['desktop', 1600, 1110],
    ['phones', 1600, 1080],
    ['flow', 1600, 600],
  ];
  const ctx = await cr.newContext({ deviceScaleFactor: 1.5 });
  const p = await ctx.newPage();
  for (const [sheet, width, height] of sheets) {
    await p.setViewportSize({ width, height });
    await p.goto(`file://${join(root, 'scripts/brand/brand.html')}?sheet=${sheet}`);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    await p.screenshot({ path: join(out, `${sheet}.png`), clip: { x: 0, y: 0, width, height } });
    console.log(`docs/brand/${sheet}.png`);
  }
} finally {
  await cr.close();
  await wk.close();
  demo.kill();
}
