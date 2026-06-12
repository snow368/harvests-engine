/**
 * Forum Intelligence Pipeline — Playwright-based forum scraper + AI classifier.
 *
 * All remaining tattoo forums use client-side rendering (XenForo/Discourse/NodeBB).
 * Plain HTTP fetch no longer works — this pipeline uses Playwright for JS rendering.
 *
 * 用法: npx tsx scripts/forum-intel-pipeline.ts
 *
 * ENV:
 *   FORUM_SOURCE=lastsparrowtattoo  (可选: 指定单个论坛)
 *   FORUM_MAX_THREADS=30            (每个论坛最多处理线程数)
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

const FORUM_SOURCE = (process.env.FORUM_SOURCE || '').trim();
const MAX_THREADS = Number(process.env.FORUM_MAX_THREADS || 30);

const SEEN_URLS = loadSeenUrls();
let newUrlsThisRun = 0;

const PROFILE_DIR = path.join(process.cwd(), 'data', 'browser_forum_pipeline');
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Forum registry — all require JS rendering
// tattooing101 excluded: Cloudflare WAF 403, needs CloakBrowser (future bot-worker task)
const FORUM_REGISTRY: Record<string, { name: string; listingUrl: string; platform: 'xenforo' | 'discourse' | 'vbulletin' | 'generic' }> = {
  reinventingtattoo: {
    name: 'reinventingtattoo',
    listingUrl: 'https://www.reinventingthetattoo.com/forum',
    platform: 'generic',
  },
  lastsparrowtattoo: {
    name: 'lastsparrowtattoo',
    listingUrl: 'https://www.lastsparrowtattoo.com/forum/',
    platform: 'xenforo',
  },
  tattoonow: {
    name: 'tattoonow',
    listingUrl: 'https://community.tattoonow.com/',
    platform: 'discourse',
  },
};

// ============ Generic JS-rendered scraper ============

const scrapeListing = async (page: any, url: string): Promise<{ title: string; url: string }[]> => {
  const items: { title: string; url: string }[] = [];
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000); // wait for JS rendering

    const extracted = await page.evaluate(() => {
      const results: { title: string; url: string }[] = [];
      const seen = new Set<string>();

      // Discourse
      document.querySelectorAll('a[href*="/t/"], a.topic-link, a.title[href]').forEach((a) => {
        const text = (a.textContent || '').trim();
        const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
        if (!href || seen.has(href) || text.length < 10 || text.length > 300) return;
        seen.add(href);
        results.push({ title: text, url: href });
      });

      // XenForo
      if (results.length < 5) {
        document.querySelectorAll('a[href*="/threads/"], a[data-preview-url]').forEach((a) => {
          const text = (a.textContent || '').trim();
          const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
          if (!href || seen.has(href) || text.length < 10) return;
          seen.add(href);
          results.push({ title: text, url: href });
        });
      }

      // Fallback: any substantial link
      if (results.length < 3) {
        document.querySelectorAll('a[href]').forEach((a) => {
          const text = (a.textContent || '').trim();
          const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
          if (!href || seen.has(href) || text.length < 15 || text.length > 300) return;
          if (/^(Home|Forums|Members|Log ?in|Sign ?Up|Register|Privacy|Terms|Cookie|Skip|Menu|Search)/i.test(text)) return;
          seen.add(href);
          results.push({ title: text, url: href });
        });
      }

      return results.slice(0, 60);
    });

    items.push(...extracted);
  } catch (e: any) {
    console.warn(`  Listing error: ${e.message}`);
  }
  return items;
};

const scrapeThread = async (page: any, url: string): Promise<{ title: string; content: string; author: string; date: string; replies: string[] } | null> => {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2500);

    return await page.evaluate(() => {
      // XenForo
      const titleEl = document.querySelector('h1.p-title-value, h1[class*="title"], .thread-title');
      const title = (titleEl?.textContent || document.title?.replace(/\|.*$/, '').trim() || '').trim();

      // Content — try multiple selectors
      const contentEl = document.querySelector(
        'article.message-body, .bbWrapper, .message-content, .postbody, .cooked, .post .content, div[class*="post"] div[class*="content"], .topic-body'
      );
      const content = (contentEl?.textContent || document.body.textContent || '').trim().slice(0, 3000);

      // Author
      const authorEl = document.querySelector(
        '.username, a.username, .poster-name, a[itemprop="author"], .message-userDetails a, a[href*="member"], a[href*="user"]'
      );
      const author = (authorEl?.textContent || '').trim();

      // Date
      const dateEl = document.querySelector('time[datetime], .date, .post-date, .published, time, .relative-date');
      const date = dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || '';

      // Replies
      const replyEls = document.querySelectorAll(
        'article.message-body, .bbWrapper, .message-content, .postbody, .cooked, .topic-body .post'
      );
      const replies: string[] = [];
      replyEls.forEach((el, i) => {
        if (i === 0) return;
        const text = (el.textContent || '').trim();
        if (text.length > 20) replies.push(text.slice(0, 1500));
      });

      return { title, content, author, date, replies };
    });
  } catch {
    return null;
  }
};

const isNoise = (title: string, content: string) => {
  const t = title.trim();
  const c = content.trim();
  if (!t || !c) return true;
  if (t.length < 12 && c.length < 80) return true;
  if (/^(Home|Forums|Members|Log in|Register|Sign Up|Privacy|Terms|Cookie|Search|Menu|Skip|New posts|Categories|Latest)$/i.test(t)) return true;
  return false;
};

// ============ Main ============

const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Forum Intelligence Pipeline         ║');
  console.log('║  (Playwright JS-Rendering Mode)      ║');
  console.log('╚══════════════════════════════════════╝');

  const forums = FORUM_SOURCE ? { [FORUM_SOURCE]: FORUM_REGISTRY[FORUM_SOURCE] } : FORUM_REGISTRY;
  const forumKeys = Object.keys(forums).filter(k => forums[k]);
  if (!forumKeys.length) {
    console.log('  No valid forums configured. Exiting.');
    process.exit(0);
  }

  console.log(`  Forums: ${forumKeys.join(', ')} | Max threads: ${MAX_THREADS}`);
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

    for (const key of forumKeys) {
      const cfg = forums[key];
      if (!cfg) continue;

      console.log(`[${cfg.name}] Scraping ${cfg.listingUrl} (${cfg.platform})...`);
      const listing = await scrapeListing(page, cfg.listingUrl);
      console.log(`  → ${listing.length} potential threads found`);

      for (const item of listing.slice(0, MAX_THREADS)) {
        if (SEEN_URLS.has(item.url)) continue;
        totalChecked++;

        const data = await scrapeThread(page, item.url);
        if (!data) { await sleep(500); continue; }

        if (isNoise(data.title, data.content)) {
          console.log(`  ⊘ noise: "${data.title.slice(0, 60)}"`);
          continue;
        }

        SEEN_URLS.add(item.url);
        newUrlsThisRun++;

        allThreads.push({
          forum: cfg.name,
          title: data.title,
          content: data.content.slice(0, 2000),
          author: data.author,
          date: data.date || new Date().toISOString(),
          url: item.url,
          replies: data.replies,
        });

        console.log(`  ✓ "${data.title.slice(0, 70)}"`);
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

    // Save full analysis to disk
    const outDir = path.join(process.cwd(), 'data', 'forum_intel');
    ensureDir(outDir);
    const outFile = path.join(outDir, `forum_intel_${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(outFile, JSON.stringify({
      scrapedAt: new Date().toISOString(),
      source: 'playwright',
      forums: forumKeys,
      threads: allThreads.map((t, i) => ({ ...t, classification: classifications[i] || null })),
    }, null, 2), 'utf8');
    console.log(`\n✅ Saved: ${outFile}`);

    saveSeenUrls(SEEN_URLS);
    console.log(`  Cache: ${SEEN_URLS.size} URLs | ${totalChecked} checked | ${newUrlsThisRun} new`);

  } finally {
    await browserContext.close().catch(() => {});
  }
};

main().catch(e => {
  console.error('[forum-intel-pipeline] Fatal:', e?.message || e);
  process.exit(1);
});
