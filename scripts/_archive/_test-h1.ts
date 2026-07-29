import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

/**
 * Test — 从 JSON script tag 提取 caption + comments
 */
import 'dotenv/config';
import { chromium } from 'playwright';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  await page.goto('https://www.instagram.com/kwadron/p/DYJiRiHgXes/', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await sleep(3000);

  const postData = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.includes('xdt_api__v1__media__shortcode__web_info')) {
        try {
          const parsed = JSON.parse(text);
          // Navigate the require wrapper
          const items = parsed?.require?.[0]?.[3]?.[0]?.__bbox?.require;
          if (!items) return { error: 'unexpected structure', raw: text.slice(0, 500) };

          // Find the RelayPrefetchedStreamCache entry
          for (const item of items) {
            if (item?.[0] === 'RelayPrefetchedStreamCache') {
              const result = item?.[3]?.[0]?.__bbox?.result;
              if (result) return result;
            }
          }

          // Fallback: search more broadly
          const str = JSON.stringify(parsed);
          const capMatch = str.match(/"text":"([^"]+)"/);
          return { error: 'structure mismatch', raw: text.slice(0, 1000) };
        } catch (e: any) {
          return { error: e.message, raw: text.slice(0, 500) };
        }
      }
    }
    return { error: 'no matching script tag found' };
  });

  console.log('Post data:', JSON.stringify(postData, null, 2).slice(0, 3000));

  // Try different approach: search for caption text directly
  const captionText = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (text.includes('xdt_api__v1__media__shortcode__web_info')) {
        try {
          const parsed = JSON.parse(text);
          const raw = JSON.stringify(parsed);
          // Find the caption text between "text":" and ","
          const match = raw.match(/"text":"(.*?)"(?:,"|})/);
          if (match) return match[1];
        } catch {}
      }
    }
    return null;
  });
  console.log('\nCaption from JSON:', captionText);

  await page.close();
  await browser.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
