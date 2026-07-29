/** Debug: check dialog text for reel views */
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

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('login')) {
    console.log('Login required. Login, then press Enter.');
    await new Promise<void>(r => { process.stdin.once('data', () => r()); });
    await page.waitForTimeout(3000);
  }

  // Go to an account with reels
  await page.goto('https://www.instagram.com/madrabbit/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Scroll
  for (let s = 0; s < 20; s++) {
    try { await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5)); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  // Find reel links (contain /reel/)
  const reelSelector = 'a[href*="/reel/"]';
  const reelCount = await page.locator(reelSelector).count().catch(() => 0);
  console.log(`Found ${reelCount} reel links`);

  // Click first reel
  if (reelCount > 0) {
    await page.locator(reelSelector).first().click({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const dump = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return { error: 'no dialog' };
      const text = (dialog as HTMLElement).innerText || '';

      // Check for video
      const video = dialog.querySelector('video');

      // Dump all text
      const lines = text.split('\n').filter(Boolean);

      // Check for numbers with context
      const numberLines = lines.filter(l => /\d+/.test(l));

      return {
        isVideo: !!video,
        rawText: text.slice(0, 3000),
        lines: lines.slice(0, 30),
        numberLines: numberLines.slice(0, 20),
        hasPlayText: /[播放view]/.test(text),
        videoUrl: video ? (video as HTMLVideoElement).src?.slice(0, 100) || (video.querySelector('source')?.src?.slice(0, 100) || '') : '',
      };
    });

    console.log('\n=== DIALOG DUMP ===');
    console.log('isVideo:', dump.isVideo);
    console.log('hasPlayText:', dump.hasPlayText);
    console.log('\n--- All lines ---');
    for (const [i, l] of dump.lines.entries()) {
      console.log(`  ${i}: "${l}"`);
    }
    console.log('\n--- Lines with numbers ---');
    for (const l of dump.numberLines) {
      console.log(`  "${l}"`);
    }
    console.log('\n--- Video URL ---');
    console.log(dump.videoUrl);
    console.log('\n--- Raw text (first 500) ---');
    console.log(dump.rawText.slice(0, 500));
  }

  await browser.close();
}

main().catch(e => { console.error('Fatal:', e); });
