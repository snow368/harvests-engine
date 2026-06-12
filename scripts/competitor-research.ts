/**
 * Competitor Research — 竞对深度分析
 *
 * 用 Playwright Persistent Context 实际抓取竞对 IG 数据，
 * 分析三个方面：
 *   1. 互动率 — 什么内容类型/文案/时间互动最高
 *   2. 关注度 — 什么策略吸引注意力（hashtag/Reel/合作）
 *   3. 粉丝数 — 粉丝规模 + 增长模式
 *
 * 输出：行动建议（不是报告）
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import type { Page } from 'playwright';

// ============ Config ============

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const STATE_DIR = path.join(process.env.BOT_STATE_DIR || './data/bot_state', 'competitor_research');
const CACHE_FILE = path.join(STATE_DIR, 'profiles_cache.json');

const BOT_PROXY = (process.env.BOT_PROXY || '').trim();
const BOT_PROFILE_DIR = (process.env.BOT_PROFILE_DIR || 'D:/Crawler_Chrome_Profile').trim();
const BOT_CDP_URL = (process.env.BOT_CDP_URL || '').trim(); // Optional: use existing Chrome

const SCRAPE_POSTS_PER_PROFILE = Number(process.env.COMPETITOR_SCRAPE_POSTS || 20);
const SCRAPE_DELAY_MS = Number(process.env.COMPETITOR_SCRAPE_DELAY_MS || 5000);

interface CompetitorPost {
  shortcode: string;
  postUrl: string;
  type: 'image' | 'video' | 'carousel';
  caption: string;
  hashtags: string[];
  likeCount: number;
  commentCount: number;
  timestamp: string;
  engagementRate: number; // (likes+comments)/followers
}

interface CompetitorProfile {
  handle: string;
  scrapedAt: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
  bio: string;
  isVerified: boolean;
  posts: CompetitorPost[];
}

// ============ Helpers ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };
const extractHashtags = (text: string): string[] => {
  const m = text.match(/#[a-zA-Z0-9_]+/g);
  return m ? [...new Set(m.map((h) => h.toLowerCase().replace(/^#/, '')))] : [];
};

const parseCount = (text: string): number => {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').trim();
  if (cleaned.endsWith('K') || cleaned.endsWith('k')) return Math.round(parseFloat(cleaned) * 1000);
  if (cleaned.endsWith('M') || cleaned.endsWith('m')) return Math.round(parseFloat(cleaned) * 1_000_000);
  return parseInt(cleaned, 10) || 0;
};

const callDeepSeek = async (systemPrompt: string, userPrompt: string, maxTokens = 600): Promise<string> => {
  if (!DEEPSEEK_API_KEY) return '';
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.5, max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) throw new Error(`DeepSeek ${resp.status}`);
    const data: any = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch { return ''; }
};

// ============ IG Scraping (Playwright Persistent Context) ============

const launchBrowser = async (): Promise<{ context: BrowserContext; page: Page }> => {
  if (BOT_CDP_URL) {
    const browser = await chromium.connectOverCDP(BOT_CDP_URL);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    return { context, page };
  }

  ensureDir(BOT_PROFILE_DIR);

  const context = await chromium.launchPersistentContext(BOT_PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(BOT_PROXY ? { proxy: { server: BOT_PROXY } } : {}),
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = context.pages()[0] || await context.newPage();
  return { context, page };
};

const scrapeProfile = async (page: Page, handle: string): Promise<CompetitorProfile> => {
  const profile: CompetitorProfile = {
    handle,
    scrapedAt: new Date().toISOString(),
    followerCount: 0,
    followingCount: 0,
    postCount: 0,
    bio: '',
    isVerified: false,
    posts: [],
  };

  try {
    // Navigate to profile
    await page.goto(`https://www.instagram.com/${handle}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(3000);

    // Extract profile header data
    const headerData: any = await page.evaluate(() => {
      const followerEls = document.querySelectorAll('a[href*="followers"] span, header a span');
      let followers = '';
      for (const el of followerEls) {
        const t = el.getAttribute('title') || (el.textContent || '').trim();
        if (/\d/.test(t)) { followers = t; break; }
      }
      const bioEl = document.querySelector('header h1');
      const bioSpan = bioEl?.parentElement?.querySelector('span');
      return {
        followers,
        bio: (bioSpan?.textContent || '').trim(),
        verified: !!(document.querySelector('svg[aria-label="Verified"], span[title="Verified"]')),
      };
    });

    profile.followerCount = parseCount(headerData.followers);
    profile.bio = headerData.bio.slice(0, 500);
    profile.isVerified = headerData.verified;

    // Try to get following/post counts from header
    const counts: string[] = await page.evaluate(() => {
      const links = document.querySelectorAll('header a[role="link"]');
      const result: string[] = [];
      links.forEach(function(l) { var t = (l.textContent || '').trim(); if (/\d/.test(t)) result.push(t); });
      return result;
    });
    if (counts.length >= 2) {
      profile.postCount = parseCount(counts[0]);
      profile.followingCount = parseCount(counts[1]);
      if (counts.length >= 3 && !profile.followerCount) {
        profile.followerCount = parseCount(counts[2]);
      }
    }

    // Scroll to load posts and collect shortcodes
    const shortcodes = new Set<string>();
    const maxScrolls = Math.ceil(SCRAPE_POSTS_PER_PROFILE / 4); // ~4 posts per scroll

    for (let i = 0; i < maxScrolls; i++) {
      const newCodes: string[] = await page.evaluate(() => {
        const links = document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]');
        return Array.from(links).map(function(a) {
          var href = a.getAttribute('href') || '';
          var m = href.match(/\/(p|reel)\/([a-zA-Z0-9_-]+)/);
          return m ? m[2] : '';
        }).filter(Boolean);
      });
      for (const code of newCodes) shortcodes.add(code);
      if (shortcodes.size >= SCRAPE_POSTS_PER_PROFILE) break;

      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(1500);
    }

    // Scrape each post
    const codesArr = Array.from(shortcodes).slice(0, SCRAPE_POSTS_PER_PROFILE);
    for (const shortcode of codesArr) {
      try {
        const postData = await scrapePost(page, shortcode, profile.followerCount);
        if (postData) profile.posts.push(postData);
        await sleep(1500 + Math.random() * 2000);
      } catch { /* skip failed posts */ }
    }

  } catch (e: any) {
    console.error(`[scrape] Error on @${handle}: ${e.message}`);
  }

  return profile;
};

const scrapePost = async (page: Page, shortcode: string, followerCount: number): Promise<CompetitorPost | null> => {
  try {
    await page.goto(`https://www.instagram.com/p/${shortcode}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await sleep(2000);

    const data: any = await page.evaluate(() => {
      const timeEl = document.querySelector('time');
      const timestamp = timeEl ? (timeEl.getAttribute('datetime') || '') : '';

      const allText = document.body ? (document.body.innerText || '') : '';
      const likeMatch = allText.match(/([\d,]+)\s*likes?/i);
      const likes = likeMatch ? likeMatch[1].replace(/,/g, '') : '0';

      const isVideo = !!document.querySelector('video');
      const hasCarousel = !!document.querySelector('article[role="presentation"] button[aria-label="Next"]');

      const captionEls = document.querySelectorAll('h1, article span');
      let caption = '';
      for (var i = 0; i < captionEls.length; i++) {
        var el = captionEls[i];
        var t = (el.textContent || '').trim();
        if (t.length > 10 && t.indexOf('verified') === -1 && t.indexOf('Follow') !== 0) {
          caption = t;
          break;
        }
      }

      return {
        likes: parseInt(likes, 10) || 0,
        timestamp: timestamp,
        caption: caption,
        isVideo: isVideo,
        hasCarousel: hasCarousel,
      };
    });

    const commentMatches = data.caption.match(/(\d[\d,]*)\s*(?:comment|reply)/i);
    const comments = commentMatches ? parseInt(commentMatches[1].replace(/,/g, ''), 10) : 0;

    const type = data.isVideo ? 'video' : data.hasCarousel ? 'carousel' : 'image';
    const engRate = followerCount > 0
      ? (data.likes + comments * 2) / followerCount
      : 0;

    return {
      shortcode,
      postUrl: `https://www.instagram.com/p/${shortcode}/`,
      type,
      caption: data.caption.slice(0, 1000),
      hashtags: extractHashtags(data.caption),
      likeCount: data.likes,
      commentCount: comments,
      timestamp: data.timestamp,
      engagementRate: Math.round(engRate * 10000) / 100, // as percentage
    };
  } catch {
    return null;
  }
};

// ============ Get Competitor List ============

const getCompetitorHandles = async (): Promise<string[]> => {
  // From env var
  const envList = process.env.COMPETITOR_HANDLES || '';
  if (envList) return envList.split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean);

  // From server API
  try {
    const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
    const resp = await fetch(`${API_BASE}/api/content/competitors`);
    if (resp.ok) {
      const data = await resp.json();
      const handles = (data?.rows || []).map((r: any) => r.handle || '').filter(Boolean);
      if (handles.length > 0) return handles;
    }
  } catch {}

  // Defaults
  return [
    'bishoprotary', 'cheyenne_tattooequipment', 'fkironsofficial',
    'kwadron', 'worldfamousink', 'inkjecta', 'davincitattoomachines', 'tatsoul',
  ];
};

// ============ Analysis ============

const analyzeCompetitors = (profiles: CompetitorProfile[]): string => {
  if (profiles.length === 0) return '';

  const allPosts = profiles.flatMap((p) => p.posts);
  if (allPosts.length === 0) return '';

  // 1. Engagement: which content type gets highest engagement?
  const typeEng = new Map<string, { total: number; count: number }>();
  for (const p of allPosts) {
    const t = p.type;
    const entry = typeEng.get(t) || { total: 0, count: 0 };
    entry.total += p.engagementRate;
    entry.count += 1;
    typeEng.set(t, entry);
  }
  const typeAvgEng = Array.from(typeEng.entries())
    .map(([t, v]) => ({ type: t, avgEng: v.count > 0 ? v.total / v.count : 0 }))
    .sort((a, b) => b.avgEng - a.avgEng);

  // 2. Top posts by engagement
  const topPosts = [...allPosts]
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, 5);

  // 3. Hashtag effectiveness
  const hashtagEng = new Map<string, { total: number; count: number }>();
  for (const p of allPosts) {
    for (const h of p.hashtags) {
      const entry = hashtagEng.get(h) || { total: 0, count: 0 };
      entry.total += p.engagementRate;
      entry.count += 1;
      hashtagEng.set(h, entry);
    }
  }
  const topHashtags = Array.from(hashtagEng.entries())
    .filter(([, v]) => v.count >= 2)
    .map(([tag, v]) => ({ tag, avgEng: v.total / v.count, count: v.count }))
    .sort((a, b) => b.avgEng - a.avgEng)
    .slice(0, 10);

  // 4. Follower distribution
  const followers = profiles
    .map((p) => ({ handle: p.handle, followers: p.followerCount }))
    .sort((a, b) => b.followers - a.followers);

  // 5. Posting frequency analysis
  const recentPosts = allPosts.filter((p) => {
    const ts = new Date(p.timestamp).getTime();
    const now = Date.now();
    return !isNaN(ts) && (now - ts) < 60 * 24 * 3600 * 1000; // last 60 days
  });

  const dataForAI = JSON.stringify({
    profiles: profiles.map((p) => ({
      handle: p.handle,
      followers: p.followerCount,
      posts: p.postCount,
      bio: p.bio.slice(0, 200),
      recentPosts: p.posts.length,
    })),
    engagementByType: typeAvgEng,
    top5Posts: topPosts.map((p) => ({
      type: p.type,
      likes: p.likeCount,
      comments: p.commentCount,
      engRate: p.engagementRate + '%',
      caption: p.caption.slice(0, 150),
      hashtags: p.hashtags,
    })),
    topHashtags: topHashtags.map((h) => `#${h.tag}(${h.count}次, 平均互动${h.avgEng.toFixed(1)}%)`),
    followerRanking: followers,
    totalRecentPosts: recentPosts.length,
  });

  return dataForAI;
};

// ============ Load / Save Cache ============

const loadCache = (): CompetitorProfile[] => {
  try {
    if (!fs.existsSync(CACHE_FILE)) return [];
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch { return []; }
};

const saveCache = (profiles: CompetitorProfile[]) => {
  ensureDir(STATE_DIR);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(profiles, null, 2), 'utf8');
};

// ============ Main ============

const run = async (handles?: string[]) => {
  const competitors = handles && handles.length > 0 ? handles : await getCompetitorHandles();
  console.log(`[competitor-research] 分析 ${competitors.length} 个竞对:\n  ${competitors.join(', ')}\n`);

  // Check cache first — skip if scraped within last 24h
  const cache = loadCache();
  const cacheByHandle = new Map(cache.map((p) => [p.handle, p]));
  const needsScrape = competitors.filter((h) => {
    const c = cacheByHandle.get(h);
    if (!c) return true;
    const age = Date.now() - new Date(c.scrapedAt).getTime();
    return age > 24 * 3600 * 1000;
  });

  let allProfiles: CompetitorProfile[] = competitors
    .map((h) => cacheByHandle.get(h))
    .filter(Boolean) as CompetitorProfile[];

  // Scrape if needed
  if (needsScrape.length > 0) {
    console.log(`需要抓取 ${needsScrape.length} 个: ${needsScrape.join(', ')}`);
    if (process.env.COMPETITOR_NO_SCRAPE === '1') {
      console.log('COMPETITOR_NO_SCRAPE=1，跳过抓取，仅用缓存数据');
    } else {
      let context: BrowserContext | null = null;
      try {
        const browser = await launchBrowser();
        context = browser.context;

        // Login-first: navigate to IG homepage, auto-detect login success
        if (args.includes('--login-first')) {
          console.log('\n🔐 请在浏览器中登录 Instagram...');
          await browser.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          console.log('   等待登录完成（自动检测）...');
          // Wait up to 2 minutes for login — check if feed appears
          for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const url = browser.page.url();
            const loggedIn = url.includes('instagram.com') && !url.includes('/accounts/') && !url.includes('/login');
            if (loggedIn && i > 5) {
              console.log('   ✓ 检测到登录成功，开始抓取...\n');
              break;
            }
            if (i % 10 === 0) process.stdout.write('.');
          }
        }

        for (const handle of needsScrape) {
          console.log(`抓取 @${handle}...`);
          const profile = await scrapeProfile(browser.page, handle);
          if (profile.posts.length > 0) {
            // Update cache
            const idx = allProfiles.findIndex((p) => p.handle === handle);
            if (idx >= 0) allProfiles[idx] = profile;
            else allProfiles.push(profile);
            saveCache(allProfiles);
            console.log(`  → ${profile.followerCount.toLocaleString()} 粉丝, ${profile.posts.length} 条帖子, 互动率 ${profile.posts.length > 0 ? (profile.posts.reduce((s, p) => s + p.engagementRate, 0) / profile.posts.length).toFixed(1) : '?'}%`);
          } else {
            console.log(`  → 未抓取到帖子（可能被限流或账号不存在）`);
          }
          await sleep(SCRAPE_DELAY_MS);
        }
      } catch (e: any) {
        console.error(`[scrape] 浏览器错误: ${e.message}`);
      } finally {
        if (context) await context.close().catch(() => {});
      }
    }
  } else {
    console.log('所有数据在24h缓存内，跳过抓取');
  }

  // Filter to only profiles with posts
  const profilesWithData = allProfiles.filter((p) => p.posts.length > 0);
  if (profilesWithData.length === 0) {
    console.log('没有可用数据。用法：');
    console.log('  npx ts-node scripts/competitor-research.ts --handles bishoprotary,cheyenne_tattooequipment');
    console.log('  或设置 COMPETITOR_HANDLES 环境变量');
    return;
  }

  // Analyze
  const analysisData = analyzeCompetitors(profilesWithData);

  // AI-powered recommendations
  if (DEEPSEEK_API_KEY && analysisData) {
    const aiRecs = await callDeepSeek(
      `You are a competitive strategist. Analyze competitor data and give CONCRETE actions WE should take.
Focus on 3 areas:
1. 互动率 (engagement rate) — what drives the most likes/comments?
2. 关注度 (visibility) — what gets the most attention? (hashtags, reels, collaborations?)
3. 涨粉 (follower growth) — what strategy do large-follower accounts use?

Output format: 3 sections, each with 2-3 bullet points.
Use imperative tone: "做X", "多发Y", "用Z".
Be specific with numbers and examples.`,
      `Competitor data:\n${analysisData.slice(0, 4000)}`,
      700
    );

    console.log('\n========================================');
    console.log('📋 竞对分析 — 我们该怎么做');
    console.log('========================================\n');
    console.log(aiRecs || '(AI分析不可用)');
  }

  // Quick stats
  const sorted = [...profilesWithData].sort((a, b) => b.followerCount - a.followerCount);
  console.log('\n--- 粉丝规模 ---');
  for (const p of sorted) console.log(`  @${p.handle}: ${p.followerCount.toLocaleString()} 粉丝`);

  const allPosts = profilesWithData.flatMap((p) => p.posts);
  const typeCounts: Record<string, number> = {};
  for (const p of allPosts) {
    typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
  }
  console.log('\n--- 内容类型分布 ---');
  for (const [t, c] of Object.entries(typeCounts)) {
    console.log(`  ${t}: ${c} 条 (${Math.round(c / allPosts.length * 100)}%)`);
  }

  const topEngPosts = [...allPosts]
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, 3);
  console.log('\n--- 最高互动帖子 ---');
  for (const p of topEngPosts) {
    console.log(`  ${p.shortcode}: ${p.likeCount}赞 ${p.commentCount}评 (${p.engagementRate}%) — ${p.type}`);
    console.log(`    ${p.caption.slice(0, 100)}`);
  }

  console.log(`\n缓存已更新: ${CACHE_FILE}`);
};

// ============ CLI ============

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
competitor-research.ts — 竞对深度分析

用法:
  npx ts-node scripts/competitor-research.ts --handles h1,h2,h3
  npx ts-node scripts/competitor-research.ts                    (用默认列表/环境变量)
  npx ts-node scripts/competitor-research.ts --cache-only        (仅用缓存，不抓取)
  npx ts-node scripts/competitor-research.ts --login-first        (先打开IG首页，手动登录后再抓取)

环境变量:
  COMPETITOR_HANDLES=handle1,handle2    竞对列表
  COMPETITOR_NO_SCRAPE=1                跳过抓取，仅分析缓存
  COMPETITOR_SCRAPE_POSTS=20            每个竞对抓取帖子数
  BOT_PROXY=socks5://...                代理
  BOT_PROFILE_DIR=./data/bot_profiles   Chrome profile 目录
  DEEPSEEK_API_KEY=sk-...               AI分析
`);
  process.exit(0);
}

if (args.includes('--cache-only')) {
  process.env.COMPETITOR_NO_SCRAPE = '1';
}

const handlesIdx = args.indexOf('--handles');
const handles = handlesIdx >= 0
  ? args[handlesIdx + 1]?.split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean) || []
  : [];

run(handles).catch((e) => { console.error(e); process.exit(1); });
