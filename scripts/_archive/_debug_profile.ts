/**
 * Debug: 看 IG profile 页面结构
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';

// Kill bot Chrome
try {
  const out = execSync(`wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv`, { encoding: 'utf8', timeout: 8000 });
  for (const l of out.split('\n')) {
    if (!l.includes('bot_publish_01_chrome_data')) continue;
    const pid = l.trim().split(',').pop()?.trim();
    if (pid && /^\d+$/.test(pid)) try { execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 3000 }); } catch {}
  }
} catch {}
setTimeout(async () => {
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

  // Login check
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('login')) {
    console.log('Login required. Login, then press Enter.');
    await new Promise<void>(r => { process.stdin.once('data', () => r()); });
    await page.waitForTimeout(3000);
  }

  // Go to kwadron
  await page.goto('https://www.instagram.com/kwadron/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Dump key elements
  const dump = await page.evaluate(() => {
    const result: any = {};

    // Page URL
    result.url = window.location.href;

    // Body text (first 2000 chars)
    result.bodyText = (document.body.innerText || '').slice(0, 2000);

    // All <a> elements in header (first 20)
    const links = document.querySelectorAll('header a, section a');
    result.followLinks = [];
    for (const a of links) {
      const href = (a as HTMLAnchorElement).href;
      const text = a.textContent?.trim() || '';
      if (href.includes('follow') || text.includes('follow') || /\d+/.test(text)) {
        result.followLinks.push({ href, text, tag: a.tagName });
      }
    }

    // All <span> elements with digits (first 30)
    const spans = document.querySelectorAll('span');
    result.numSpans = [];
    for (const s of spans) {
      const t = s.textContent?.trim() || '';
      if (/\d+/.test(t) && t.length < 30) {
        result.numSpans.push(t);
        if (result.numSpans.length >= 30) break;
      }
    }

    // All elements with title attribute containing numbers
    result.titled = [];
    const all = document.querySelectorAll<HTMLElement>('[title]');
    for (const el of all) {
      const t = el.getAttribute('title') || '';
      if (/\d+/.test(t)) result.titled.push({ title: t, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 50) });
    }

    // h1/h2 content
    result.h1 = document.querySelector('h1')?.textContent?.trim() || '';
    result.h2 = document.querySelector('h2')?.textContent?.trim() || '';

    // meta tags
    const og = document.querySelector('meta[property="og:description"]');
    result.ogDescription = og?.getAttribute('content') || '';

    // First 10 post URLs
    const postLinks = document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]');
    result.postUrls = [...new Set([...postLinks].map(a => a.href))].slice(0, 10);

    return result;
  });

  console.log('\n=== DUMP ===');
  console.log('URL:', dump.url);
  console.log('\n--- Body text (first 2000) ---');
  console.log(dump.bodyText);
  console.log('\n--- Follow links ---');
  for (const l of dump.followLinks) console.log(`  ${l.tag}: href="${l.href}" text="${l.text}"`);
  console.log('\n--- Number spans ---');
  for (const s of dump.numSpans) console.log(`  "${s}"`);
  console.log('\n--- Titled elements ---');
  for (const t of dump.titled) console.log(`  [${t.tag}] title="${t.title}" text="${t.text}"`);
  console.log('\n--- h1:', dump.h1, '---');
  console.log('--- h2:', dump.h2, '---');
  console.log('--- og:description:', dump.ogDescription, '---');
  console.log('\n--- Post URLs (first 10) ---');
  for (const u of dump.postUrls) console.log(' ', u);

  await browser.close();
}, 6000);
