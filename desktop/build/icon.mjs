// Draws build/icon.png — the app icon — from the glyph the pages use (app/icon.svg).
// Run it again only if the glyph changes: node desktop/build/icon.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const glyph = readFileSync(join(here, "..", "..", "app", "icon.svg"), "utf8").replace('stroke="#7c7c8a"', 'stroke="#ECEDF2"');
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
// the plate leaves the margin macOS icons keep around themselves
await page.setContent(`<body style="margin:0;background:transparent">
  <div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:186px;
    background:linear-gradient(160deg,#23252d,#0e0f12);display:flex;align-items:center;justify-content:center">
    <div style="width:470px;height:470px">${glyph}</div>
  </div></body>`);
await page.screenshot({ path: join(here, "icon.png"), omitBackground: true });
await browser.close();
