import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

/** CDP 抓图 — 适配 IG 新结构 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const HANDLES = ['stigmarotary','revolution_tattoo','vipertattoo','hildbrandt'];
const FRAMES_DIR = 'F:/inkflow app/InkFlow_Project/inkflow_harvests/data/hook_frames';
const TARGET = 20;

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 1800 });

for (const handle of HANDLES) {
  const dir = path.join(FRAMES_DIR, handle);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
  if (existing >= TARGET) { console.log(`SKIP ${handle}`); continue; }

  try {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Scroll to load posts
    for (let s = 0; s < 8; s++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }

    // Get all post links (IG new structure: no article tags)
    let count = existing;
    let attempts = 0;
    while (count < TARGET && attempts < 40) {
      const links = await page.$$('a[href*="/p/"]');
      if (count - existing >= links.length) break;
      attempts++;
      try {
        await links[count - existing].click();
        await page.waitForTimeout(2000);

        // Screenshot the dialog
        const dialog = await page.$('div[role="dialog"]');
        if (dialog) {
          await dialog.screenshot({ path: path.join(dir, `rp${count}.jpg`), type: 'jpeg', quality: 85 });
          count++;
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      } catch { await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
    }
    console.log(`${handle}: ${count - existing} new (${count} total)`);
  } catch(e) { console.log(`${handle}: FAIL`); }
}
console.log('DONE');
