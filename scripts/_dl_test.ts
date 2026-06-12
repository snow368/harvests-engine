import { chromium } from 'playwright';
import fs from 'fs';
import { execSync } from 'child_process';

async function main() {
  // Kill old bot chrome but handle permission errors gracefully
  try {
    const out = execSync(`wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv`, { encoding: 'utf8', timeout: 5000 });
    for (const l of out.split('\n')) {
      if (!l.includes('bot_publish_01_chrome_data')) continue;
      const pid = l.trim().split(',').pop()?.trim();
      if (pid && /^\d+$/.test(pid)) try { execSync(`taskkill /F /PID ${pid}`, { timeout: 2000 }); } catch {}
    }
  } catch {}
  await new Promise(r => setTimeout(r, 4000));

  console.log('Launching Chrome...');
  const browser = await chromium.launchPersistentContext(
    'F:/inkflow/bot_profiles/bot_publish_01_chrome_data',
    { headless: false, channel: 'chrome', viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--proxy-server=127.0.0.1:33210'] }
  );
  const page = browser.pages()[0] || await browser.newPage();

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  if (page.url().includes('login')) { console.log('NEED LOGIN'); return; }
  console.log('Logged in!');

  // Test 3 posts, one from each brand
  const posts = [
    { handle: 'cheyenne_tattooequipment', url: 'https://www.instagram.com/cheyenne_tattooequipment/p/DGl_3v9RgAo/' },
    { handle: 'bigwasp.official', url: 'https://www.instagram.com/bigwasp.official/p/DF1h_9bySrv/' },
    { handle: 'blackclaw', url: 'https://www.instagram.com/blackclaw/p/DFJQoKDxBvJ/' },
  ];

  for (const { handle, url } of posts) {
    console.log(`\n--- @${handle} ---`);
    console.log('Navigating to:', url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => page.goto(url, { waitUntil: 'load', timeout: 20000 }));
    await page.waitForTimeout(3000);
    console.log('Landed:', page.url().slice(0, 80));

    // Try element screenshot — log every img with bounding box
    const imgList = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('img'));
      return all.map((img, i) => ({
        i, src: (img.getAttribute('src') || '').slice(0, 60),
        w: img.naturalWidth, h: img.naturalHeight, complete: img.complete,
        alt: img.alt?.slice(0, 20) || '',
        classes: img.className?.slice(0, 30) || '',
      })).filter(x => x.w > 30);
    });
    console.log(`Images >30px: ${imgList.length}`);
    imgList.slice(0, 8).forEach(x => console.log(`  [${x.i}] ${x.w}x${x.h} ${x.complete} src=${x.src}`));

    // Try Playwright screenshot on the largest image
    let saved = false;
    for (const approach of ['xpath', 'css']) {
      if (saved) break;
      try {
        let el;
        if (approach === 'xpath') {
          // Find the largest visible content image
          const idx = imgList.findIndex(x => x.w > 200 && x.complete && !x.src.includes('profile'));
          if (idx < 0) continue;
          el = page.locator('img').nth(imgList[idx].i);
        } else {
          el = page.locator('div[role="dialog"] img[src*="cdn"], article img[src*="cdn"]').first();
        }
        const count = await el.count();
        if (count === 0) { console.log(`  ${approach}: no match`); continue; }
        const box = await el.boundingBox();
        console.log(`  ${approach}: count=${count} box=${JSON.stringify(box)}`);
        if (!box || box.width < 100) { console.log(`  ${approach}: too small`); continue; }
        const dest = `data/hook_frames/test_${handle}.jpg`;
        await el.screenshot({ path: dest, type: 'jpeg', quality: 90, timeout: 10000 });
        const size = fs.statSync(dest).size;
        console.log(`  ${approach}: saved ${size} bytes`);
        saved = size > 500;
      } catch (e: any) { console.log(`  ${approach}: ${e.message?.slice(0, 50)}`); }
    }

    console.log(`  Result: ${saved ? 'SUCCESS' : 'FAILED'}`);
  }
  console.log('\nDone. Check data/hook_frames/test_*.jpg');
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
