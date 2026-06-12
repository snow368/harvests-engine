/**
 * Quick test to diagnose download failures for Cheyenne/BigWasp/BlackClaw.
 * Run: npx tsx scripts/_test_download.ts
 */
import { chromium } from 'playwright';
import fs from 'fs';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';

async function main() {
  console.log('Launching Chrome...');
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--proxy-server=127.0.0.1:33210'],
  });
  const page = browser.pages()[0] || await browser.newPage();

  // Login
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  if (page.url().includes('login')) { console.log('NEED LOGIN!'); return; }
  console.log('Logged in!');

  const testUrls = [
    'https://www.instagram.com/cheyenne_tattooequipment/reel/DGp7Ht2Rgvf/',
    'https://www.instagram.com/bigwasp.official/reel/C8g6TihIkLB/',
    'https://www.instagram.com/blackclaw/p/DFJQoKDxBvJ/',
  ];

  for (const postUrl of testUrls) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Navigating to: ${postUrl}`);

    await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() =>
      page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
    );
    await page.waitForTimeout(3000);
    console.log(`Landed at: ${page.url()}`);

    // Try to get og:image URL
    const ogImg = await page.evaluate(() => {
      const m = document.querySelector('meta[property="og:image"]');
      return m?.getAttribute('content') || '';
    });
    console.log(`og:image: ${ogImg ? ogImg.slice(0,100) : '(none)'}`);

    // Try element screenshot (method 1)
    let saved = false;
    const imgEl = page.locator('img[src*="cdninstagram"]:not([width="32"]):not([width="44"])').first();
    const ic = await imgEl.count();
    if (ic > 0) {
      const box = await imgEl.boundingBox();
      console.log(`Element screenshot: count=${ic}, box=${JSON.stringify(box)}`);
      if (box && box.width > 100) {
        await imgEl.screenshot({ path: `data/hook_frames/test_el_${testUrls.indexOf(postUrl)}.jpg`, type: 'jpeg', quality: 90 });
        const s = fs.statSync(`data/hook_frames/test_el_${testUrls.indexOf(postUrl)}.jpg`).size;
        console.log(`  → saved ${s} bytes`);
        saved = s > 500;
      } else {
        console.log(`  → element too small or hidden`);
      }
    } else {
      console.log(`Element screenshot: no img[src*=cdninstagram] found`);
    }

    // Try fetch (method 2)
    if (ogImg) {
      const result = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, { credentials: 'include', referrer: 'https://www.instagram.com/' });
          if (!r.ok) return 'HTTP_' + r.status;
          const blob = await r.blob();
          return 'OK_' + blob.size + '_' + blob.type;
        } catch(e: any) { return 'ERR_' + (e.message || '').slice(0, 50); }
      }, ogImg);
      console.log(`Fetch result: ${result}`);
    }

    // Try page.goto + screenshot (method 3)
    if (ogImg) {
      try {
        await page.goto(ogImg, { waitUntil: 'load', timeout: 15000 });
        await page.waitForTimeout(2000);
        const pageUrl = page.url();
        console.log(`After goto CDN: ${pageUrl.slice(0,80)}`);

        // Check if page is an image or error
        const contentType = await page.evaluate(() => document.contentType || '');
        console.log(`Content type: ${contentType}`);

        await page.screenshot({ path: `data/hook_frames/test_goto_${testUrls.indexOf(postUrl)}.jpg`, type: 'jpeg', quality: 90 });
        const s = fs.statSync(`data/hook_frames/test_goto_${testUrls.indexOf(postUrl)}.jpg`).size;
        console.log(`Screenshot: ${s} bytes`);
        if (s > 500 && !saved) saved = true;
      } catch(e: any) { console.log(`Goto error: ${e.message?.slice(0,50)}`); }

      // Go back to IG for next test
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    console.log(`Result: ${saved ? 'SUCCESS' : 'FAILED'}`);
  }

  console.log('\nDone. Check data/hook_frames/test_*.jpg files.');
  // browser.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
