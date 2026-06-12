/**
 * Data Bot — 纯数据采集，不互动不养号
 * 职责：访问 IG 主页 + 抽样帖子 → 提取深度数据 → 回传 Server
 * 是 bot1-100 的前置条件
 *
 * 用法：npx ts-node scripts/data-bot.ts
 */
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';

// ========== 读 .env ==========
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx > 0) {
      const k = t.slice(0, idx).trim();
      const v = t.slice(idx + 1).trim();
      if (k && v && !process.env[k]) process.env[k] = v;
    }
  }
}

// ========== 配置 ==========
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const BOT_ID = process.env.DATA_BOT_ID || 'data_bot_01';
const BOT_API_KEY = (process.env.BOT_API_KEY || '').trim();
const INSTAGRAM_BASE = 'https://www.instagram.com';
const PROFILE_DIR = path.resolve(process.env.BOT_PROFILE_DIR || './data/bot_profiles/data_bot');
const HEADLESS = process.env.DATA_BOT_HEADLESS !== 'false'; // 默认 headless

// 速度配置（数据 bot 可比养号 bot 快）
const POLL_INTERVAL_SEC = Number(process.env.DATA_BOT_POLL_INTERVAL || 15);
const PROFILE_SCROLL_PAUSE_MS = Number(process.env.DATA_BOT_SCROLL_PAUSE || 800);
const POST_GAP_MS = Number(process.env.DATA_BOT_POST_GAP || 1200);
const POSTS_TO_SAMPLE = Math.min(5, Math.max(2, Number(process.env.DATA_BOT_POST_SAMPLE || 3)));
const MAX_RETRIES = 2;

// ========== 类型 ==========
interface DeepScanTask {
  id: string;
  artistIds: string[];
  state?: string;
  status: string;
}

interface ProfileData {
  id: string;
  url: string;
  followers: number;
  following: number;
  posts: number;
  bio: string;
  title: string;
  category: string;
  externalUrl: string;
  email: string;
  isPrivate: boolean;
  isVerified: boolean;
  postsSample: PostSample[];
  error?: string;
}

interface PostSample {
  url: string;
  likeCount: number;
  commentCount: number;
  ageDays: number;
  isReel: boolean;
  caption: string;
  postType: string;
  hashtags: string[];
  videoViewCount: number;
}

// ========== 工具 ==========
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, range = 0.3) => Math.floor(base * (1 + (Math.random() - 0.5) * range * 2));

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function parseCompactNumber(text: string): number {
  const cleaned = text.replace(/[^\d.kKmM]/g, '').trim();
  if (!cleaned) return 0;
  const num = parseFloat(cleaned.replace(/[kKmM]/g, ''));
  if (isNaN(num)) return 0;
  if (/[mM]/.test(cleaned)) return Math.round(num * 1_000_000);
  if (/[kK]/.test(cleaned)) return Math.round(num * 1_000);
  return Math.round(num);
}

function toAgeDays(dateStr?: string | null): number {
  if (!dateStr) return 999;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 999;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function extractEmail(text: string): string {
  const matches = text.match(EMAIL_REGEX) || [];
  return matches[0] || '';
}

function detectPostType(caption: string): string {
  const t = caption.toLowerCase();
  if (/healed|months old|years? old|aged|settled/.test(t)) return 'healed';
  if (/wip|in progress|session|outline|lining/.test(t)) return 'wip';
  if (/flash|available|pre-drawn/.test(t)) return 'flash';
  if (/before|after|cover|transformation/.test(t)) return 'before_after';
  return 'fresh';
}

// ========== HTTP ==========
const postJson = async (endpoint: string, body: Record<string, any>) => {
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(BOT_API_KEY ? { 'x-bot-key': BOT_API_KEY } : {}) },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
};

const getJson = async (endpoint: string) => {
  const resp = await fetch(`${API_BASE}${endpoint}`, {
    headers: { ...(BOT_API_KEY ? { 'x-bot-key': BOT_API_KEY } : {}) },
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
};

// ========== 拉取任务 ==========
const fetchBatch = async (): Promise<DeepScanTask | null> => {
  try {
    const data = await postJson('/api/deep-scan/next/data-bot', {
      botId: BOT_ID,
      batchSize: 5, // 每次拿 5 个
    });
    if (data?.artistIds?.length > 0) return data as DeepScanTask;
    return null;
  } catch {
    return null;
  }
};

// ========== 回传结果 ==========
const reportResults = async (taskId: string, profiles: ProfileData[]) => {
  const successIds = profiles.filter((p) => !p.error).map((p) => p.id);
  const failedItems = profiles
    .filter((p) => p.error)
    .map((p) => ({ id: p.id, reason: p.error || 'unknown' }));

  return postJson(`/api/deep-scan/report/${taskId}`, {
    botId: BOT_ID,
    successIds,
    failedItems,
    profiles: profiles.filter((p) => !p.error),
  });
};

// ========== IG 操作 ==========
const navigateToProfile = async (page: Page, handle: string): Promise<{ ok: boolean; isPrivate: boolean }> => {
  await page.goto(`${INSTAGRAM_BASE}/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(jitter(2000));

  // 检测私密账号
  const privateText = await page.locator('text=This Account is Private').count().catch(() => 0);
  if (privateText > 0) return { ok: false, isPrivate: true };

  // 检测无效页面
  const notFound = await page.locator('text=Page Not Found, text=Sorry, this page').count().catch(() => 0);
  if (notFound > 0) return { ok: false, isPrivate: false };

  return { ok: true, isPrivate: false };
};

const extractProfileStats = async (page: Page): Promise<Partial<ProfileData>> => {
  // 获取 header 区域的统计数字
  const headerText = await page.locator('header section').first().innerText().catch(() => '');
  const numberPattern = /(\d[\d,.]*[kKmM]?)\s*(posts?|followers?|following)/gi;

  const stats: Record<string, number> = { posts: 0, followers: 0, following: 0 };
  let m: RegExpExecArray | null;
  while ((m = numberPattern.exec(headerText)) !== null) {
    const num = parseCompactNumber(m[1]);
    const key = m[2].toLowerCase().replace(/s$/, '');
    if (key === 'post') stats.posts = num;
    else if (key === 'follower') stats.followers = num;
    else if (key === 'following') stats.following = num;
  }

  // Bio
  const bioSpans = await page.locator('header section span').allTextContents().catch(() => [] as string[]);
  const bioLines = bioSpans.filter((s) => s.length > 3 && !/\d[\d,.]*/.test(s) && !/posts|followers|following/i.test(s));
  const bio = bioLines.join('\n').slice(0, 500);

  // Title
  const title = await page.locator('header section h1, header section h2').first().innerText().catch(() => '');

  // Category
  const category = await page.locator('header section span').filter({ hasText: /artist|shop|studio|tattoo|piercing|service/i }).first().innerText().catch(() => '');

  // External URL
  const externalUrl = await page.locator('header section a[href*="http"]').first().getAttribute('href').catch(() => '');

  // Is Verified
  const verifiedEl = await page.locator('svg[aria-label="Verified"]').count().catch(() => 0);

  return {
    ...stats,
    bio,
    title,
    category,
    externalUrl: externalUrl || '',
    isVerified: verifiedEl > 0,
    email: extractEmail(`${title}\n${bio}\n${externalUrl}`),
  };
};

const samplePosts = async (page: Page): Promise<PostSample[]> => {
  const samples: PostSample[] = [];
  const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"]');
  const total = await tiles.count().catch(() => 0);
  const count = Math.min(POSTS_TO_SAMPLE, total);

  for (let i = 0; i < count; i++) {
    try {
      await tiles.nth(i).scrollIntoViewIfNeeded();
      await sleep(jitter(POST_GAP_MS, 0.5));
      await tiles.nth(i).click({ timeout: 8000 });
      await sleep(jitter(1500));

      const url = page.url();
      const dialogText = await page.locator('div[role="dialog"]').first().innerText().catch(() => '');

      const likesMatch = dialogText.match(/(\d[\d,.]*)\s+likes?\b/i);
      const commentsMatch = dialogText.match(/view all\s+(\d[\d,.]*)\s+comments?\b/i);
      const timeEl = await page.locator('time').first().getAttribute('datetime').catch(() => null);

      const captionParts = await page.locator('article ul li span, div[role="dialog"] ul li span')
        .allTextContents()
        .catch(() => [] as string[]);
      const caption = captionParts.join(' ').slice(0, 300);

      // Extract hashtags from caption
      const hashtagRegex = /#([a-zA-Z0-9_]{2,})/g;
      const hashtags: string[] = [];
      let hMatch: RegExpExecArray | null;
      while ((hMatch = hashtagRegex.exec(caption)) !== null) {
        hashtags.push(hMatch[1].toLowerCase());
      }

      // Extract video view count for Reels
      let videoViewCount = 0;
      if (/\/reel\//i.test(url)) {
        const viewMatch = dialogText.match(/(\d[\d,.]*)\s*views?\b/i);
        videoViewCount = viewMatch?.[1] ? parseCompactNumber(viewMatch[1]) : 0;
      }

      samples.push({
        url,
        likeCount: likesMatch?.[1] ? parseCompactNumber(likesMatch[1]) : 0,
        commentCount: commentsMatch?.[1] ? parseCompactNumber(commentsMatch[1]) : 0,
        ageDays: Math.floor(toAgeDays(timeEl)),
        isReel: /\/reel\//i.test(url),
        caption,
        postType: detectPostType(caption),
        hashtags,
        videoViewCount,
      });

      // 关闭弹窗
      const closeBtn = page.locator('svg[aria-label="Close"]').first();
      if ((await closeBtn.count()) > 0) await closeBtn.click({ timeout: 4000 });
      else await page.keyboard.press('Escape');
      await sleep(jitter(800));
    } catch {
      // 弹窗已关或帖子打不开
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(jitter(500));
    }
  }
  return samples;
};

const scrollProfile = async (page: Page) => {
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 600);
    await sleep(PROFILE_SCROLL_PAUSE_MS);
  }
  await sleep(jitter(1000));
};

// ========== 处理单个店铺 ==========
const processArtist = async (page: Page, artistId: string, igHandle: string): Promise<ProfileData> => {
  const base: ProfileData = {
    id: artistId,
    url: '',
    followers: 0, following: 0, posts: 0,
    bio: '', title: '', category: '', externalUrl: '', email: '',
    isPrivate: false, isVerified: false,
    postsSample: [],
  };

  const { ok, isPrivate } = await navigateToProfile(page, igHandle);
  if (!ok) {
    base.error = isPrivate ? 'private_account' : 'invalid_profile';
    base.isPrivate = isPrivate;
    return base;
  }

  base.url = page.url();
  base.isPrivate = isPrivate;

  // 滚动加载帖子
  await scrollProfile(page);

  // 提取主页数据
  const profileData = await extractProfileStats(page);
  Object.assign(base, profileData);

  // 抽样帖子
  base.postsSample = await samplePosts(page);

  return base;
};

// ========== 浏览器管理 ==========
let context: BrowserContext | null = null;
let page: Page | null = null;

const ensureBrowser = async () => {
  if (page) {
    try { await page.evaluate('1+1'); return; } catch {}
  }
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  page = context.pages()[0] || (await context.newPage());
  console.log(`[data-bot] Browser ready (headless=${HEADLESS})`);
};

// ========== 主循环 ==========
const main = async () => {
  console.log(`[data-bot] Starting | ID: ${BOT_ID} | API: ${API_BASE}`);
  await ensureBrowser();

  // 注册
  try {
    await postJson('/api/bot/register', {
      botId: BOT_ID,
      accountIds: [],
      host: process.env.HOSTNAME || 'data-bot',
      version: '0.1.0-data',
      meta: { role: 'data', profileDir: PROFILE_DIR },
    });
  } catch {}

  let totalProcessed = 0;

  while (true) {
    try {
      await ensureBrowser();
      if (!page) continue;

      const task = await fetchBatch();
      if (!task || !task.artistIds?.length) {
        console.log(`[data-bot] No tasks, sleeping ${POLL_INTERVAL_SEC}s... (total: ${totalProcessed})`);
        await sleep(POLL_INTERVAL_SEC * 1000);
        continue;
      }

      console.log(`[data-bot] Batch: ${task.artistIds.length} artists (task: ${task.id})`);
      const profiles: ProfileData[] = [];

      for (const artistId of task.artistIds) {
        // 从 DB 获取 artist 的 IG handle（通过 server API）
        let igHandle = '';
        try {
          const info = await getJson(`/api/artists/${artistId}/social`);
          igHandle = info?.igHandle || '';
        } catch {
          profiles.push({ id: artistId, error: 'fetch_info_failed' } as any);
          continue;
        }

        if (!igHandle) {
          profiles.push({ id: artistId, error: 'no_ig_handle' } as any);
          continue;
        }

        console.log(`  [${profiles.length + 1}/${task.artistIds.length}] @${igHandle}`);
        const profile = await processArtist(page!, artistId, igHandle);
        profiles.push(profile);
        totalProcessed++;
        await sleep(jitter(2000));
      }

      await reportResults(task.id, profiles);
      const ok = profiles.filter((p) => !p.error).length;
      const fail = profiles.filter((p) => p.error).length;
      console.log(`[data-bot] Reported: ${ok} ok, ${fail} fail (total: ${totalProcessed})`);
    } catch (e: any) {
      console.error(`[data-bot] Loop error: ${e.message?.slice(0, 200)}`);
      await sleep(10000);
    }
  }
};

main().catch((e) => {
  console.error('[data-bot] Fatal:', e);
  process.exit(1);
});
