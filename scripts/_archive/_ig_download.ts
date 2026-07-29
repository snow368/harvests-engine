import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

/**
 * IG Bulk Downloader — uses existing Chrome CDP session to download brand product images.
 *
 * Usage:
 *   npx tsx scripts/_ig_download.ts --handles=fkirons,bishoprotary,tatsoul,dragonhawk
 *
 * Requires: Chrome running with --remote-debugging-port=9222
 *           and logged into Instagram.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const CDP_WS = 'http://127.0.0.1:9222/json/version';
const FRAMES_DIR = 'data/hook_frames';
const SCROLLS = 30;           // number of scrolls per brand
const MAX_POSTS = 30;         // max posts to save per brand
const TIMEOUT = 15000;

interface PostInfo {
  shortcode: string;
  url: string;
  displayUrl: string | null;
  isVideo: boolean;
  likes: number | null;
  caption: string;
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function jitter(base: number, maxExtra: number): number {
  return base + Math.floor(Math.random() * maxExtra);
}

/**
 * Fetch JSON from Chrome's CDP endpoint to get WebSocket URL.
 */
async function getCDPWebSocketUrl(): Promise<string> {
  const resp = await fetch(CDP_WS);
  const data = await resp.json() as any;
  return data.webSocketDebuggerUrl;
}

async function main() {
  const handleFilter = process.argv.find(a => a.startsWith('--handles='))
    ?.split('=')[1]?.split(',') || [];

  if (handleFilter.length === 0) {
    console.error('Usage: --handles=handle1,handle2,...');
    process.exit(1);
  }

  // Connect to existing Chrome via CDP
  const wsUrl = await getCDPWebSocketUrl();
  console.log(`Connecting to Chrome CDP...`);
  const browser = await chromium.connectOverCDP(wsUrl);
  console.log('Connected!\n');

  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.setDefaultTimeout(TIMEOUT);

  // Check login status
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  const loginNeeded = await page.locator('input[name="username"]').isVisible().catch(() => true);
  if (loginNeeded) {
    console.log('⚠️  IG login page detected. Please log in within 60 seconds...');
    try {
      await page.waitForURL('**/instagram.com/**', { timeout: 60000 });
      await sleep(3000);
    } catch {
      console.error('Login timeout. Exiting.');
      await browser.close();
      process.exit(1);
    }
  }
  console.log('Logged in!\n');

  // Process each handle
  for (const handle of handleFilter) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  @${handle}`);
    console.log(`${'='.repeat(50)}`);

    const brandDir = path.join(FRAMES_DIR, handle);
    fs.mkdirSync(brandDir, { recursive: true });

    // Check existing files to skip
    const existingFiles = new Set(
      fs.readdirSync(brandDir).filter(f => f.endsWith('.jpg')).map(f => f.replace('.jpg', ''))
    );
    console.log(`  Existing images: ${existingFiles.size}`);

    // Navigate to profile
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Scroll and collect posts
    const allPosts: PostInfo[] = [];
    const seenShortcodes = new Set<string>();
    let noNewPostsCount = 0;

    for (let s = 0; s < SCROLLS; s++) {
      // Get current post links
      const links = await page.locator('a[href*="/p/"]').all().catch(() => []);
      for (const link of links) {
        const href = await link.getAttribute('href').catch(() => '');
        if (!href) continue;
        const match = href.match(/\/p\/([^/]+)/);
        if (!match || seenShortcodes.has(match[1])) continue;
        seenShortcodes.add(match[1]);

        // Try to get the image URL
        const img = link.locator('img').first();
        const imgUrl = await img.getAttribute('src').catch(() => null);

        allPosts.push({
          shortcode: match[1],
          url: `https://www.instagram.com/p/${match[1]}/`,
          displayUrl: imgUrl,
          isVideo: false,
          likes: null,
          caption: '',
        });
      }

      if (allPosts.length >= MAX_POSTS) break;

      // Scroll
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(jitter(1500, 2000));

      // Check if new posts were found
      if (allPosts.length > 0) noNewPostsCount = 0;
      else noNewPostsCount++;

      if (noNewPostsCount >= 5) {
        console.log(`  No new posts after ${noNewPostsCount} scrolls, stop scrolling`);
        break;
      }

      if ((s + 1) % 5 === 0) {
        console.log(`  Scrolled ${s + 1}/${SCROLLS}, collected ${allPosts.length} posts`);
      }
    }

    console.log(`  Collected ${allPosts.length} unique posts`);

    // Download images
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < Math.min(allPosts.length, MAX_POSTS); i++) {
      const post = allPosts[i];
      const frameKey = `rp${i}`;

      if (existingFiles.has(frameKey)) {
        skipped++;
        continue;
      }

      // Try direct image download first
      let imageUrl = post.displayUrl;

      // If no image URL from the feed, open the post page to get it
      if (!imageUrl) {
        try {
          await page.goto(post.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(1000);
          const postImg = page.locator('article img[alt], article img[src*="cdninstagram"]').first();
          imageUrl = await postImg.getAttribute('src').catch(() => null);
        } catch {
          // skip
        }
      }

      if (!imageUrl) {
        failed++;
        continue;
      }

      // Download via browser context (uses Chrome's proxy)
      const dest = path.join(brandDir, `${frameKey}.jpg`);
      try {
        const b64data = await page.evaluate(async (url) => {
          try {
            const resp = await fetch(url, { credentials: 'omit' });
            if (!resp.ok) return null;
            const blob = await resp.blob();
            if (blob.size < 1000) return null;
            return new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
          } catch { return null; }
        }, imageUrl);

        if (b64data) {
          const buffer = Buffer.from(b64data.split(',')[1], 'base64');
          fs.writeFileSync(dest, buffer);
          downloaded++;
          process.stdout.write('.');
        } else {
          failed++;
          process.stdout.write('x');
        }
      } catch {
        failed++;
        process.stdout.write('x');
      }

      // Brief delay between downloads
      if (i < Math.min(allPosts.length, MAX_POSTS) - 1) {
        await sleep(jitter(500, 1000));
      }
    }

    console.log(`\n  @${handle}: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
  }

  await browser.close();
  console.log('\nDone!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
