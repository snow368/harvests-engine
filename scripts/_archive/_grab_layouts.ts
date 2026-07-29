/** 抓 cartridge 品牌帖子用于排版分析 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// 只抓 product_showcase 和 macro 多的品牌
const BRANDS = ['kwadron', 'cheyenne_tattooequipment', 'tatsoul', 'stigmarotary', 'hildbrandt', 'bigwasp.official', 'cnctattoo', 'magicmoon_tattoo_supply'];

const OUT = 'F:/inkflow app/InkFlow_Project/inkflow_harvests/data/generated_samples/layout_refs';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.contexts()[0].newPage();

for (const brand of BRANDS) {
  const brandDir = path.join(OUT, brand);
  fs.mkdirSync(brandDir, { recursive: true });

  try {
    await page.goto(`https://www.instagram.com/${brand}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Scroll
    for (let s = 0; s < 5; s++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
    }

    // Click tiles and screenshot the post dialog
    const links = await page.$$('a[href*="/p/"]');
    let count = 0;
    for (let i = 0; i < Math.min(links.length, 50); i++) {
      try {
        await links[i].click();
        await page.waitForTimeout(2000);
        // Screenshot just the post content area
        const dialog = await page.$('div[role="dialog"]');
        if (dialog) {
          await dialog.screenshot({ path: path.join(brandDir, `post_${count}.png`), type: 'png' });
          count++;
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);
      } catch { await page.keyboard.press('Escape'); }
    }
    console.log(`${brand}: ${count} posts`);
  } catch (e) {
    console.log(`${brand}: FAIL`);
  }
}
console.log('DONE');
