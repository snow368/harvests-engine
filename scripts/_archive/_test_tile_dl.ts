/**
 * Test tile-click + dialog screenshot for Cheyenne/BigWasp/BlackClaw
 * Run: npx tsx scripts/_test_tile_dl.ts
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';
const OUT_DIR = 'data/hook_frames';

async function main() {
  console.log('Launching Chrome...');
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--proxy-server=127.0.0.1:33210'],
  });
  const page = browser.pages()[0] || await browser.newPage();

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('login')) { console.log('NEED LOGIN!'); return; }
  console.log('Logged in!');

  const testAccounts = [
    { handle: 'cheyenne_tattooequipment', index: 0 },
    { handle: 'bigwasp.official', index: 0 },
    { handle: 'blackclaw', index: 0 },
  ];

  for (const [i, acct] of testAccounts.entries()) {
    console.log(`\n--- @${acct.handle} ---`);
    await page.goto(`https://www.instagram.com/${acct.handle}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);

    const tileSel = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
    let tileCount = await page.locator(tileSel).count();

    // Scroll until we have at least the first tile
    let scrolls = 0;
    while (tileCount < 1 && scrolls < 10) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(1500);
      tileCount = await page.locator(tileSel).count();
      scrolls++;
    }
    console.log(`Tiles found: ${tileCount}`);

    if (tileCount < 1) { console.log('No tiles!'); continue; }

    const tile = page.locator(tileSel).first();
    await tile.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await tile.hover().catch(() => {});
    await page.waitForTimeout(800);
    await tile.click({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // Try element screenshot (dialog image)
    const selectors = [
      'div[role="dialog"] video[poster]',
      'div[role="dialog"] img[src*="cdn"]:not([width="32"]):not([width="44"])',
      'div[role="dialog"] img:not([width="44"])',
      'div[role="dialog"] video',
      'article video[poster]',
    ];

    let saved = false;
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) === 0) continue;
      await el.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      const box = await el.boundingBox();
      console.log(`  sel="${sel.slice(0,50)}": count=1 box=${JSON.stringify(box)}`);
      if (!box || box.width < 100) continue;
      const dest = path.join(OUT_DIR, `test_tile_${i}.jpg`);
      await el.screenshot({ path: dest, type: 'jpeg', quality: 90, timeout: 10000 });
      const s = fs.statSync(dest).size;
      console.log(`    → saved ${s} bytes`);
      if (s > 500) { saved = true; break; }
    }

    if (!saved) {
      // Fallback: screenshot dialog
      const dialog = page.locator('div[role="dialog"]').first();
      if (await dialog.count() > 0) {
        const box = await dialog.boundingBox();
        if (box && box.width > 200) {
          const dest = path.join(OUT_DIR, `test_tile_${i}.jpg`);
          await page.screenshot({ path: dest, type: 'jpeg', quality: 85, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
          const s = fs.statSync(dest).size;
          console.log(`  dialog fallback: saved ${s} bytes`);
          saved = s > 500;
        }
      }
    }

    // Close dialog
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);

    console.log(`Result: ${saved ? 'SUCCESS' : 'FAILED'}`);
  }

  console.log('\nDone. Check data/hook_frames/test_tile_*.jpg files.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
