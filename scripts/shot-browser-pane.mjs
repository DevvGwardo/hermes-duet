/** Screenshot the live browser pane in the duet app, as the phone would see it. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const [, , out, port = "7467", cookie = ""] = process.argv;
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--hide-scrollbars"],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
if (cookie) {
  const [name, value] = cookie.split("=");
  await ctx.addCookies([{ name, value, domain: "127.0.0.1", path: "/" }]);
}
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForTimeout(1200);
await page.click('button[aria-label="Live browser"]');

const drawn = await page
  .waitForFunction(() => {
    const c = document.querySelector(".browser-stage canvas");
    return !!c && c.width > 0 && c.height > 0;
  }, null, { timeout: 25000 })
  .then(() => true)
  .catch(() => false);

await page.waitForTimeout(1800);
const info = await page.evaluate(() => {
  const c = document.querySelector(".browser-stage canvas");
  const ctx2 = c?.getContext("2d");
  // sample the canvas so we can tell a real frame from a black rectangle
  const px = ctx2 && c.width ? ctx2.getImageData(0, 0, Math.min(c.width, 40), Math.min(c.height, 40)).data : null;
  let nonBlack = 0;
  if (px) for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 24) nonBlack++;
  return {
    canvas: c ? { w: c.width, h: c.height } : null,
    nonBlack,
    url: document.querySelector(".browser-url")?.textContent ?? "",
    overlay: document.querySelector(".browser-overlay")?.textContent ?? "",
  };
});
await page.screenshot({ path: out });
console.log(JSON.stringify({ drawn, ...info, errors: errors.slice(0, 4) }, null, 1));
await browser.close();