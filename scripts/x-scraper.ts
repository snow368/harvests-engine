/**
 * X Scraper — 自动抓取行业 KOL 的 X/Twitter 内容，分类入库
 *
 * 用法:
 *   npx tsx scripts/x-scraper.ts                    # 全量跑
 *   npx tsx scripts/x-scraper.ts --dry-run          # 试跑不存
 *   npx tsx scripts/x-scraper.ts --category b2b     # 只跑指定分类
 *
 * 流程:
 *   1. 读 KOL 配置 → 按分类分组
 *   2. Chrome headless 打开每个 KOL 主页
 *   3. 提取最新推文/长文
 *   4. AI 分类 + 打分
 *   5. 去重 → 写入知识库
 *
 * ENV:
 *   X_SCRAPER_HEADLESS=true       (默认 true，false 可见窗口调试)
 *   X_SCRAPER_MAX_PER_KOL=10      (每个 KOL 最多抓几条)
 *   X_SCRAPER_DAYS_BACK=7         (抓几天内的内容)
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
const KNOWLEDGE_BASE = 'F:/SEO_Project/docs/knowledge_base';
const X_BASE = 'https://x.com';
const HEADLESS = String(process.env.X_SCRAPER_HEADLESS || 'true').toLowerCase() !== 'false';
const MAX_PER_KOL = Math.max(1, Math.min(200, Number(process.env.X_SCRAPER_MAX_PER_KOL || 50)));
const DAYS_BACK = Math.max(1, Math.min(365, Number(process.env.X_SCRAPER_DAYS_BACK || 30)));
const HISTORICAL = process.argv.includes('--historical') || String(process.env.X_SCRAPER_HISTORICAL || 'false').toLowerCase() === 'true';
const SCROLL_TIMEOUT_MS = Number(process.env.X_SCRAPER_SCROLL_TIMEOUT || 120000); // 每个 KOL 最多滚 2 分钟
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_FILTER = (() => {
  const idx = process.argv.indexOf('--category');
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1].toLowerCase();
  return '';
})();

// ============ KOL Registry ============
interface KolConfig {
  handle: string;
  name: string;
  category: string;
  tags: string[];
  priority: number;
  source: string;
  added_at: string;
}

interface KolRegistry {
  _meta: { last_updated: string; total: number };
  kols: KolConfig[];
  _candidates: Array<{ handle: string; category: string; mentioned_by: string[]; score: number; discovered_at: string }>;
  _blacklist: string[];
}

const KOL_REGISTRY_PATH = path.join(process.cwd(), 'data', 'x_kol_registry.json');

function loadKols(): KolConfig[] {
  try {
    const raw = JSON.parse(fs.readFileSync(KOL_REGISTRY_PATH, 'utf-8')) as KolRegistry;
    return Array.isArray(raw.kols) ? raw.kols : [];
  } catch { return []; }
}

function saveCandidates(candidates: KolRegistry['_candidates']) {
  try {
    const raw = JSON.parse(fs.readFileSync(KOL_REGISTRY_PATH, 'utf-8')) as KolRegistry;
    raw._candidates = candidates;
    raw._meta.last_updated = new Date().toISOString().slice(0, 10);
    raw._meta.total = raw.kols.length;
    fs.writeFileSync(KOL_REGISTRY_PATH, JSON.stringify(raw, null, 2), 'utf-8');
  } catch {}
}

function loadCandidates(): KolRegistry['_candidates'] {
  try {
    const raw = JSON.parse(fs.readFileSync(KOL_REGISTRY_PATH, 'utf-8')) as KolRegistry;
    return Array.isArray(raw._candidates) ? raw._candidates : [];
  } catch { return []; }
}

function loadBlacklist(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(KOL_REGISTRY_PATH, 'utf-8')) as KolRegistry;
    return new Set(Array.isArray(raw._blacklist) ? raw._blacklist.map(h => h.toLowerCase()) : []);
  } catch { return new Set(); }
}

// ============ Pipeline Mapping ============
function getPipeline(category: string): string {
  const map: Record<string, string> = {
    b2b: 'pipeline_b2b',
    saas: 'pipeline_saas',
    b2c: 'pipeline_b2c',
    generic: 'pipeline_generic',
    seo: 'pipeline_generic',
    ig_tattoo: 'pipeline_generic',
  };
  return map[category] || 'pipeline_generic';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============ Chrome Headless ============
let browser: any = null;
let context: any = null;
let page: any = null;

async function ensureBrowser() {
  if (page) {
    try { await page.evaluate(() => document.title); return; } catch {}
  }
  const useChrome = String(process.env.X_SCRAPER_CHROME || '').toLowerCase() === 'true';
  browser = await chromium.launch({
    headless: HEADLESS,
    ...(useChrome ? { channel: 'chrome' } : {}),
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  });
  page = await context.newPage();
}

// ============ Fetch KOL Posts ============
interface Post {
  handle: string;
  text: string;
  url: string;
  timestamp: string;
  isArticle: boolean;
}

async function fetchKolPosts(handle: string): Promise<Post[]> {
  const url = `${X_BASE}/${handle}`;
  console.log(`  Fetching @${handle}...`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Dismiss login popup if it appears
    try {
      const dismissBtn = page.locator('a[href="/explore"], div[role="button"]').filter({ hasText: /not now|skip|maybe later/i }).first();
      if ((await dismissBtn.count()) > 0) await dismissBtn.click({ timeout: 3000 });
    } catch {}

    // Try to get articleBody from JSON-LD (for pinned X articles)
    const posts: Post[] = [];
    const articleBody = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '');
          if (data?.articleBody) return data.articleBody;
        } catch {}
      }
      return null;
    }).catch(() => null);

    if (articleBody && typeof articleBody === 'string' && articleBody.length > 100) {
      posts.push({
        handle,
        text: articleBody.slice(0, 5000),
        url: page.url(),
        timestamp: new Date().toISOString(),
        isArticle: true,
      });
    }

    // Extract tweets from current DOM
    const extractTweets = async (): Promise<Post[]> => {
      return await page.evaluate((baseUrl, h) => {
        const newPosts: Array<{ text: string; url: string; timestamp: string }> = [];
        // Try multiple selectors — X changes their DOM frequently
        const selectors = [
          'article div[lang]',
          'article [data-testid="tweetText"]',
          'article div[dir="auto"]',
        ];
        for (const sel of selectors) {
          const nodes = document.querySelectorAll(sel);
          if (nodes.length > 0) {
            for (const n of nodes) {
              const text = (n as HTMLElement).innerText?.trim();
              if (text && text.length > 30) {
                newPosts.push({ text: text.slice(0, 3000), url: baseUrl, timestamp: new Date().toISOString() });
              }
            }
            break; // first matching selector wins
          }
        }
        return newPosts;
      }, `${X_BASE}/${handle}`, handle);
    };

    // Initial extract
    let initialTweets = await extractTweets();
    for (const t of initialTweets) {
      if (!posts.some(p => p.text.includes(t.text.slice(0, 60)))) {
        posts.push({ ...t, handle, isArticle: false });
      }
    }

    // ─── Historical scrolling ───
    if (HISTORICAL) {
      const cutoffDate = Date.now() - DAYS_BACK * 86400000;
      const seenTexts = new Set(posts.map(p => p.text.slice(0, 80)));
      let noNewCount = 0;
      const startTime = Date.now();

      while (posts.length < MAX_PER_KOL && (Date.now() - startTime) < SCROLL_TIMEOUT_MS) {
        // Scroll down — slow and human-like
        const scrollPx = 300 + Math.floor(Math.random() * 600);
        await page.evaluate((px) => window.scrollBy(0, px), scrollPx);
        // 看完内容再滚 — 读帖子的时间
        await page.waitForTimeout(4000 + Math.random() * 6000);

        // Occasionally pause longer (simulate reading an interesting post)
        if (Math.random() < 0.15) {
          const readTime = 12000 + Math.random() * 20000;
          console.log(`    → Reading pause: ${Math.round(readTime / 1000)}s`);
          await page.waitForTimeout(readTime);
        }

        // Occasionally scroll up a bit (like real browsing behavior)
        if (Math.random() < 0.2) {
          await page.evaluate(() => window.scrollBy(0, -(100 + Math.random() * 300)));
          await page.waitForTimeout(2000 + Math.random() * 3000);
        }

        // Check for login wall
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
        if (bodyText.includes('Sign in') && bodyText.includes('see what')) {
          console.log(`    → Hit login wall, stopping scroll`);
          break;
        }

        // Extract new tweets
        const newTweets = await extractTweets();
        let addedThisRound = 0;

        for (const t of newTweets) {
          const key = t.text.slice(0, 80);
          if (seenTexts.has(key)) continue;
          seenTexts.add(key);

          // Check age by rough indicators (timestamps like "12h", "Jan 12")
          // If the tweet text has date references, we can check them; otherwise just collect
          posts.push({ ...t, handle, isArticle: false });
          addedThisRound++;
        }

        if (addedThisRound === 0) {
          noNewCount++;
          if (noNewCount >= 8) {
            console.log(`    → No new posts after ${noNewCount} scrolls, stopping`);
            break;
          }
        } else {
          noNewCount = 0;
        }

        if (posts.length % 20 === 0) {
          console.log(`    → ${posts.length} posts collected so far...`);
        }
      }
    }

    console.log(`    → ${posts.length} posts found${HISTORICAL ? ` (historical scroll)` : ''}`);
    return posts.slice(0, MAX_PER_KOL);

  } catch (e: any) {
    console.warn(`    ✗ Error: ${e?.message?.slice(0, 100)}`);
    return [];
  }
}

// ============ AI Classification ============
async function classifyPost(post: Post, kol: KolConfig): Promise<{ title: string; summary: string; tags: string[]; quality: number } | null> {
  const text = post.text;
  if (!text || text.length < 50) return null;

  // Simple classification:
  // 1. Generate a title from first line
  const firstLine = text.split('\n')[0].replace(/[^\w\s一-鿿]/g, '').trim();
  const title = firstLine.length > 10 ? firstLine.slice(0, 80) : `${kol.name} 分享`;

  // 2. Summary = first 200 chars
  const summary = text.replace(/\s+/g, ' ').trim().slice(0, 200);

  // 3. Tags
  const tags = [...kol.tags];
  if (text.includes('?' ) || text.includes('how to') || text.includes('how I')) tags.push('tutorial');
  if (text.match(/\d+%/)) tags.push('data');
  if (text.match(/case study|example|real world/i)) tags.push('casestudy');
  if (text.match(/tool|software|platform|app/i)) tags.push('tools');

  // 4. Quality score (rough estimate based on length and substance)
  let quality = 3;
  if (text.length > 500) quality = 4;
  if (text.length > 1000) quality = 5;
  if (post.isArticle) quality = 5;
  if (text.length < 100) quality = 1;

  return { title, summary, tags, quality };
}

// ============ Save to Knowledge Base ============
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

function saveToKnowledgeBase(post: Post, kol: KolConfig, classified: { title: string; summary: string; tags: string[]; quality: number }) {
  const pipeline = getPipeline(kol.category);
  const dir = path.join(KNOWLEDGE_BASE, pipeline);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const slug = slugify(classified.title);
  const filename = `${kol.handle.toLowerCase()}_${slug}_${dateStr}.md`;
  const filepath = path.join(dir, filename);

  if (fs.existsSync(filepath)) {
    console.log(`    → SKIP: already exists (${filename})`);
    return false;
  }

  const content = `# ${classified.title}

**来源:** [@${kol.handle}](${X_BASE}/${kol.handle})
**分类:** ${kol.category}
**标签:** ${classified.tags.map(t => '#' + t).join(' ')}
**质量评分:** ${classified.quality}/5
**抓取日期:** ${dateStr}

---

${post.text}

---

**摘要:** ${classified.summary}
`;

  fs.writeFileSync(filepath, content, 'utf-8');
  console.log(`    ✅ Saved: ${filename}`);
  return true;
}

// ============ Dedup Check ============
function isDuplicate(text: string): boolean {
  // Check if similar content already exists in knowledge base
  const shortHash = text.slice(0, 100).replace(/\s+/g, ' ').trim();
  // Simple check: scan recently added files for overlapping text
  const recentDirs = ['pipeline_generic', 'pipeline_b2b_saas', 'pipeline_b2c', 'pipeline_saas', 'pipeline_b2b'];
  for (const dir of recentDirs) {
    const fullDir = path.join(KNOWLEDGE_BASE, dir);
    if (!fs.existsSync(fullDir)) continue;
    const files = fs.readdirSync(fullDir).sort().slice(-50); // check last 50 files
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      try {
        const content = fs.readFileSync(path.join(fullDir, f), 'utf-8');
        if (content.includes(shortHash.slice(0, 60))) return true;
      } catch {}
    }
  }
  return false;
}

// ============ Main ============
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  X.com Scraper v1                       ║');
  console.log(`║  Date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`║  Headless: ${HEADLESS}`);
  console.log(`║  Max per KOL: ${MAX_PER_KOL}`);
  console.log(`║  Days back: ${DAYS_BACK}`);
  console.log(`║  Dry run: ${DRY_RUN}`);
  if (CATEGORY_FILTER) console.log(`║  Category filter: ${CATEGORY_FILTER}`);
  console.log('╚══════════════════════════════════════════╝');

  // Load KOLs from registry
  let kols = loadKols();
  const blacklist = loadBlacklist();
  kols = kols.filter(k => !blacklist.has(k.handle.toLowerCase()));

  if (CATEGORY_FILTER) {
    kols = kols.filter(k => k.category === CATEGORY_FILTER);
    console.log(`\nFiltered to category "${CATEGORY_FILTER}": ${kols.length} KOLs`);
  }
  console.log(`Total KOLs: ${kols.length}\n`);

  await ensureBrowser();

  let totalSaved = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < kols.length; i++) {
    const kol = kols[i];
    console.log(`\n[${i + 1}/${kols.length}] @${kol.handle} (${kol.category})`);

    const posts = await fetchKolPosts(kol.handle);
    if (posts.length === 0) { totalErrors++; continue; }

    for (const post of posts) {
      const classified = await classifyPost(post, kol);
      if (!classified || classified.quality < 2) {
        totalSkipped++;
        continue;
      }

      if (isDuplicate(post.text)) {
        console.log(`    → SKIP: duplicate content`);
        totalSkipped++;
        continue;
      }

      if (!DRY_RUN) {
        const saved = saveToKnowledgeBase(post, kol, classified);
        if (saved) totalSaved++;
        else totalSkipped++;
      } else {
        console.log(`    [DRY RUN] Would save: ${classified.title.slice(0, 60)}`);
        totalSaved++;
      }
    }

    // ─── Discovery: extract mentioned handles ───
    if (posts.length > 0) {
      const mentionedHandles = new Set<string>();
      const handleRegex = /@([a-zA-Z0-9_]+)/g;
      for (const post of posts) {
        let m;
        while ((m = handleRegex.exec(post.text)) !== null) {
          const h = m[1].toLowerCase();
          // Filter out noise: short handles, known KOLs, common words
          if (h.length < 3 || h.length > 25) continue;
          if (blacklist.has(h)) continue;
          if (kols.some(k => k.handle.toLowerCase() === h)) continue;
          if (/^[0-9_]+$/.test(h)) continue;
          if (['instagram', 'facebook', 'youtube', 'google', 'twitter', 'x'].includes(h)) continue;
          mentionedHandles.add(h);
        }
      }

      if (mentionedHandles.size > 0) {
        let candidates = loadCandidates();
        for (const h of mentionedHandles) {
          const existing = candidates.find(c => c.handle === h);
          if (existing) {
            existing.score += 1;
            if (!existing.mentioned_by.includes(kol.handle)) {
              existing.mentioned_by.push(kol.handle);
            }
          } else {
            candidates.push({
              handle: h,
              category: kol.category,
              mentioned_by: [kol.handle],
              score: 1,
              discovered_at: new Date().toISOString(),
            });
          }
        }
        // Sort by score desc, keep top 100
        candidates.sort((a, b) => b.score - a.score);
        candidates = candidates.slice(0, 100);
        saveCandidates(candidates);
        // Auto-promote candidates with score >= 3
        const promoted = candidates.filter(ca => ca.score >= 3 && !kols.some(k => k.handle === ca.handle));
        if (promoted.length > 0) {
          const registry = JSON.parse(fs.readFileSync(KOL_REGISTRY_PATH, 'utf-8'));
          for (const p of promoted) {
            registry.kols.push({
              handle: p.handle,
              name: p.handle,
              category: p.category || 'generic',
              tags: [],
              priority: 3,
              source: 'auto_discover',
              added_at: new Date().toISOString().slice(0, 10),
            });
            console.log(`    ★ Auto-promoted @${p.handle} to KOL (${p.score} mentions)`);
          }
          registry._candidates = candidates.filter(ca => ca.score < 3);
          registry._meta.last_updated = new Date().toISOString().slice(0, 10);
          registry._meta.total = registry.kols.length;
          fs.writeFileSync(KOL_REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
        }
        console.log(`    → Discovered ${mentionedHandles.size} new candidate handles (total candidates: ${candidates.length})`);
      }
    }

    // Delay between KOLs to avoid rate limiting
    const delay = 5000 + Math.random() * 10000;
    console.log(`    → Waiting ${Math.round(delay / 1000)}s before next KOL...`);
    await sleep(delay);
  }

  // Cleanup
  if (browser) await browser.close();

  console.log(`\n══════════════════════════════════════════`);
  console.log(`  Done!`);
  console.log(`  Saved: ${totalSaved}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Errors: ${totalErrors}`);

  // Write summary to log file for monitoring
  const LOG_PATH = path.join(process.cwd(), 'data', 'x_scraper_log.jsonl');
  const logEntry = JSON.stringify({
    ts: new Date().toISOString(),
    kols: kols.length,
    saved: totalSaved,
    skipped: totalSkipped,
    errors: totalErrors,
    candidates: loadCandidates().length,
  });
  fs.appendFileSync(LOG_PATH, logEntry + '\n', 'utf-8');
  console.log(`  Log: data/x_scraper_log.jsonl`);

  // Show top candidates discovered
  const candidates = loadCandidates().filter(c => c.score >= 2).sort((a, b) => b.score - a.score);
  if (candidates.length > 0) {
    console.log(`\n  ── New KOL Candidates (mentioned ${HISTORICAL ? '≥2' : '≥1'} times) ──`);
    candidates.slice(0, 15).forEach((c, i) => {
      console.log(`  ${i + 1}. @${c.handle} (score: ${c.score}, by: ${c.mentioned_by.join(', ')})`);
    });
    if (candidates.length > 15) console.log(`  ... and ${candidates.length - 15} more`);
    console.log(`\n  Review candidates in: data/x_kol_registry.json → _candidates`);
    console.log(`  To promote: move from _candidates to kols[]`);
    console.log(`  To ignore: add to _blacklist`);
  }
  console.log(`══════════════════════════════════════════`);
}

const LOOP_INTERVAL = 6 * 60 * 60 * 1000; // 每6小时
if (process.argv.includes('--loop')) {
  console.log(`\n[X-Scraper] Loop mode: every ${LOOP_INTERVAL / 3600000}h\n`);
  const runLoop = async () => {
    try { await main(); } catch (e: any) { console.error('[x-scraper] loop error:', e?.message); }
    if (browser) await browser.close().catch(() => {});
    browser = null; context = null; page = null;
    setTimeout(runLoop, LOOP_INTERVAL);
  };
  runLoop();
} else {
  main().catch(e => {
    console.error('[x-scraper] fatal:', e?.message || e);
    if (browser) browser.close().catch(() => {});
    process.exit(1);
  });
}
