/** Debug: check bot Chrome's network + dialog image URLs */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';

function killBotChrome() {
  try {
    const out = execSync(`wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv`, { encoding: 'utf8', timeout: 8000 });
    for (const l of out.split('\n')) {
      if (!l.includes('bot_publish_01_chrome_data')) continue;
      const pid = l.trim().split(',').pop()?.trim();
      if (pid && /^\d+$/.test(pid)) try { execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 3000 }); } catch {}
    }
  } catch {}
}

async function main() {
  killBotChrome();
  await new Promise(r => setTimeout(r, 6000));
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const p = path.join(PROFILE_DIR, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  page.setDefaultTimeout(15000);

  // Login
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('login')) {
    console.log('Login required. Press Enter.');
    await new Promise<void>(r => { process.stdin.once('data', () => r()); });
    await page.waitForTimeout(3000);
  }
  console.log('Logged in.\n');

  // TEST 1: Can the browser reach Gemini API?
  console.log('=== TEST 1: Browser Gemini API access ===');
  const geminiTest = await page.evaluate(async () => {
    const results: any[] = [];

    // Test Google
    try {
      const r = await fetch('https://www.google.com', { mode: 'no-cors' });
      results.push({ test: 'google.com', status: r.status, ok: r.ok });
    } catch (e: any) { results.push({ test: 'google.com', error: e.message }); }

    // Test Gemini API with XHR
    results.push(await new Promise(resolve => {
      const x = new XMLHttpRequest();
      x.open('POST', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-001:generateContent?key=REDACTED');
      x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = 10000;
      x.onload = () => resolve({ test: 'gemini-xhr', status: x.status, text: x.responseText?.slice(0, 100) });
      x.onerror = () => resolve({ test: 'gemini-xhr', error: 'network_fail' });
      x.ontimeout = () => resolve({ test: 'gemini-xhr', error: 'timeout' });
      x.send(JSON.stringify({ contents: [{ parts: [{ text: 'say ok' }] }] }));
    }));

    // Test fetch to Gemini
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-001:generateContent?key=REDACTED', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'say ok' }] }] }),
      });
      const t = await r.text();
      results.push({ test: 'gemini-fetch', status: r.status, text: t.slice(0, 100) });
    } catch (e: any) { results.push({ test: 'gemini-fetch', error: e.message }); }

    return results;
  });

  for (const r of geminiTest) {
    console.log(`  ${r.test}: ${r.error || r.status + ' ' + (r.text || '')}`);
  }

  // TEST 2: Dialog image URL
  console.log('\n=== TEST 2: Dialog image URLs ===');
  await page.goto('https://www.instagram.com/madrabbit/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Scroll
  for (let s = 0; s < 10; s++) {
    try { await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5)); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  const sel = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
  const tiles = page.locator(sel);
  const count = Math.min(5, await tiles.count().catch(() => 0));

  for (let i = 0; i < count; i++) {
    try {
      await tiles.nth(i).click({ timeout: 10000 });
      await page.waitForTimeout(2000);

      const dump = await page.evaluate(() => {
        const d = document.querySelector('div[role="dialog"]');
        if (!d) return { error: 'no dialog' };

        // All images in dialog
        const allImgs = d.querySelectorAll('img');
        const imgInfo: any[] = [];
        for (const img of allImgs) {
          imgInfo.push({
            alt: (img as HTMLImageElement).alt?.slice(0, 50),
            src: (img as HTMLImageElement).src?.slice(0, 150),
            width: (img as HTMLImageElement).width,
            height: (img as HTMLImageElement).height,
            classes: img.className?.slice(0, 50),
          });
        }

        // Video
        const video = d.querySelector('video');
        const videoSrc = video ? ((video as HTMLVideoElement).src || video.querySelector('source')?.src || '') : '';

        return {
          images: imgInfo,
          videoSrc: videoSrc.slice(0, 150),
          isVideo: !!video,
        };
      });

      console.log(`\n  Tile ${i}:`);
      if (dump.error) { console.log(`    ${dump.error}`); continue; }
      console.log(`    isVideo: ${dump.isVideo}`);
      console.log(`    videoSrc: ${dump.videoSrc}`);
      for (const [j, img] of dump.images.entries()) {
        console.log(`    img[${j}]: alt="${img.alt}" src="${img.src}"`);
      }

      // Close
      try { await page.locator('svg[aria-label="Close"], svg[aria-label="关闭"]').first().click({ timeout: 5000 }); }
      catch { await page.keyboard.press('Escape'); }
      await page.waitForTimeout(1000);
    } catch (e: any) { console.log(`  Tile ${i}: error ${e.message?.slice(0, 60)}`); }
  }

  await browser.close();
}

main().catch(e => console.error('Fatal:', e));
