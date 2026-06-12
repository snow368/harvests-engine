/**
 * Forum Monitor — Browser-based forum scraper with AI semantic classification.
 *
 * Uses Playwright persistent context for JS-rendered XenForo/vBulletin forums.
 * Reddit is handled separately by reddit-monitor.ts.
 *
 * 用法: npx tsx scripts/forum-monitor.ts
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  type RawThread,
  classifyThreads,
  routeToDatabase,
  printClassificationSummary,
  loadSeenUrls,
  saveSeenUrls,
} from './intel-classifier';

const PROFILE_DIR = path.join(process.cwd(), 'data', 'browser_forum_monitor');
const SEEN_URLS = loadSeenUrls();
let newUrlsThisRun = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

// Forum list — only JS-rendered forums that need a real browser
// tattooing101 excluded: Cloudflare WAF 403, needs CloakBrowser stealth patches
// teachmetotattoo excluded: SSL cert broken, unmaintained
const FORUM_URLS = [
  { name: 'reinventingtattoo', url: 'https://www.reinventingthetattoo.com/forum', maxThreads: 20 },
  { name: 'lastsparrowtattoo', url: 'https://www.lastsparrowtattoo.com/forum/', maxThreads: 20 },
  { name: 'tattoonow', url: 'https://community.tattoonow.com/', maxThreads: 20 },
];

// ============ Scrapers ============

const scrapeForumListing = async (page: any, forumUrl: string, forumName: string, maxThreads: number) => {
  const threads: { title: string; url: string; author: string; date: string }[] = [];
  try {
    await page.goto(forumUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000); // JS rendering

    // Generic XenForo/vBulletin thread link extraction
    const extracted = await page.evaluate(() => {
      const results: { title: string; url: string; author: string; date: string }[] = [];
      const seen = new Set<string>();

      // XenForo structure
      document.querySelectorAll('a[href*="/threads/"], a[href*="/forum/"][href*="."]').forEach((a) => {
        const text = (a.textContent || '').trim();
        const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
        if (!href || seen.has(href)) return;
        if (text.length < 10 || text.length > 300) return;
        if (/^(Home|Forums|Members|What.s new|Log in|Register|Sign Up|New posts|Search|Mark read)/i.test(text)) return;
        seen.add(href);
        results.push({ title: text, url: href, author: '', date: '' });
      });

      // vBulletin fallback
      if (results.length === 0) {
        document.querySelectorAll('a[href*="showthread"], a[href*="showtopic"]').forEach((a) => {
          const text = (a.textContent || '').trim();
          const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
          if (!href || seen.has(href) || text.length < 10) return;
          seen.add(href);
          results.push({ title: text, url: href, author: '', date: '' });
        });
      }

      // Any link with an ID pattern (thread-123, post-456, t=789)
      if (results.length === 0) {
        document.querySelectorAll('a[href*="-"], a[href*="t="], a[href*="p="]').forEach((a) => {
          const text = (a.textContent || '').trim();
          const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
          if (!href || seen.has(href) || text.length < 8) return;
          seen.add(href);
          results.push({ title: text, url: href, author: '', date: '' });
        });
      }

      return results.slice(0, 60);
    });

    threads.push(...extracted.slice(0, maxThreads * 2));
  } catch (e: any) {
    console.error(`  [${forumName}] listing error: ${e.message}`);
  }
  return threads;
};

const scrapeThreadPage = async (page: any, threadUrl: string) => {
  try {
    await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);

    return await page.evaluate(() => {
      // XenForo
      const titleEl = document.querySelector('h1.p-title-value, .thread-title, h1[class*="title"]');
      const title = (titleEl?.textContent || document.title?.replace(/\|.*$/, '') || '').trim();

      // Main content — XenForo article/bbWrapper, vBulletin post content
      const contentEl = document.querySelector(
        'article.message-body, .bbWrapper, .message-content, .postbody, .content, div[class*="post"] div[class*="content"]'
      );
      const content = (contentEl?.textContent || '').trim().slice(0, 3000);

      // Author
      const authorEl = document.querySelector(
        '.username, a.username, .poster-name, a[itemprop="author"], .message-userDetails a, a[href*="member"]'
      );
      const author = (authorEl?.textContent || '').trim();

      // Date
      const dateEl = document.querySelector('time[datetime], .date, .post-date, .published, time');
      const date = dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || '';

      // Replies
      const replyEls = document.querySelectorAll(
        'article.message-body, .bbWrapper, .message-content, .postbody'
      );
      const replies: string[] = [];
      replyEls.forEach((el, i) => {
        if (i === 0) return; // skip first (main post)
        const text = (el.textContent || '').trim();
        if (text.length > 20) replies.push(text.slice(0, 1500));
      });

      return { title, content, author, date, replies };
    });
  } catch {
    return null;
  }
};

const isNoise = (text: string) => {
  const t = text.trim();
  if (!t || t.length < 40) return true;
  if (t.length < 80 && /^(Home|Forums|Members|Log in|Register|Sign Up|Privacy|Terms|Cookie|Search|Menu|Skip|New posts)/i.test(t)) return true;
  return false;
};

// ============ Main ============

const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Forum Monitor (AI-Powered)         ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Forums: ${FORUM_URLS.map(f => f.name).join(', ')}`);
  console.log(`  Cache: ${SEEN_URLS.size} seen URLs loaded\n`);

  ensureDir(PROFILE_DIR);
  const browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  });

  let allThreads: RawThread[] = [];
  let totalChecked = 0;

  try {
    const pages = browserContext.pages();
    const page = pages.length > 0 ? pages[0] : await browserContext.newPage();

    for (const forum of FORUM_URLS) {
      console.log(`\n--- ${forum.name} ---`);
      const listing = await scrapeForumListing(page, forum.url, forum.name, forum.maxThreads);
      console.log(`  Listing: ${listing.length} potential threads`);

      for (const item of listing) {
        if (SEEN_URLS.has(item.url)) continue;
        totalChecked++;

        const data = await scrapeThreadPage(page, item.url);
        if (!data) { await sleep(500); continue; }

        const titleText = data.title || item.title;
        if (isNoise(titleText) && isNoise(data.content)) {
          console.log(`  ⊘ noise: "${titleText.slice(0, 60)}"`);
          continue;
        }

        SEEN_URLS.add(item.url);
        newUrlsThisRun++;

        allThreads.push({
          forum: forum.name,
          title: titleText,
          content: data.content.slice(0, 2000),
          author: data.author || item.author,
          date: data.date || item.date || new Date().toISOString(),
          url: item.url,
          replies: data.replies || [],
        });

        console.log(`  ✓ "${titleText.slice(0, 70)}"`);
        await sleep(1000 + Math.random() * 1500);
      }

      await sleep(2000);
    }

    if (!allThreads.length) {
      console.log('\n⚠ No new threads to classify.');
      saveSeenUrls(SEEN_URLS);
      await browserContext.close();
      return;
    }

    console.log(`\n[ai] Classifying ${allThreads.length} threads (${newUrlsThisRun} new)...`);
    const classifications = await classifyThreads(allThreads);

    printClassificationSummary(allThreads, classifications);

    routeToDatabase(allThreads, classifications, 'forum');

    // Save full analysis
    const outDir = path.join(process.cwd(), 'data', 'forum_intel');
    ensureDir(outDir);
    const outFile = path.join(outDir, `forum_intel_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outFile, JSON.stringify({
      scrapedAt: new Date().toISOString(),
      source: 'playwright',
      threads: allThreads.map((t, i) => ({ ...t, classification: classifications[i] || null })),
    }, null, 2), 'utf8');
    console.log(`\n✅ Saved: ${outFile}`);

    saveSeenUrls(SEEN_URLS);
    console.log(`  Cache: ${SEEN_URLS.size} URLs | ${totalChecked} checked | ${newUrlsThisRun} new`);

  } finally {
    await browserContext.close().catch(() => {});
  }
};

main().catch((e) => {
  console.error('[forum-monitor] Fatal:', e?.message || e);
  process.exit(1);
});
