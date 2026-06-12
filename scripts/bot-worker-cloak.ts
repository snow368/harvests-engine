/* eslint-disable no-console */
// CloakBrowser test version — stealth Chromium with 49 C++ source-level patches
// Usage: npm run bot:cloak:test
import 'dotenv/config';
import { launch as cloakLaunch } from 'cloakbrowser';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateSupplyComment } from './supply-bot';
import { detectPostType } from './tattoo-voice';
import { getBotProfile, getDailySpeedFactor, printProfile } from './bot-profile.js';

type CommandPayload = {
  id: string;
  artistId?: string;
  artistHandle?: string;
  [key: string]: any;
};
type BrowseSummary = {
  totalMedia: number;
  opened: number;
  desiredOpenCount: number;
};
type LikeActionSummary = {
  attempted: number;
  liked: number;
  skippedCooldown: boolean;
  likedUrls: string[];
};
type CommentActionSummary = {
  attempted: number;
  posted: number;
  skipped: boolean;
  reason?: string;
  text?: string;
  postUrl?: string;
};
type FollowActionSummary = {
  attempted: number;
  followed: number;
  skipped: boolean;
  reason?: string;
};
type ProfileFacts = {
  url: string;
  title: string;
  statTexts: string[];
  postCount?: number;
  followers?: number;
  following?: number;
  bio: string;
  profileAddress?: string;
  externalUrl?: string;
  email?: string;
  emails?: string[];
  categoryLabel?: string;
  sampleCaption?: string;
  imageAltHints?: string[];
  categorySignals?: {
    textPositiveHits: string[];
    textNegativeHits: string[];
    imagePositiveHits: string[];
    imageNegativeHits: string[];
  };
  nonTattooSuspect?: boolean;
  igUserId?: string;
};

const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const BOT_ID = process.env.BOT_ID || `bot_${Math.random().toString(36).slice(2, 8)}`;
const BOT_PROFILE = getBotProfile(BOT_ID);
const BOT_HOST = process.env.BOT_HOST || process.env.HOSTNAME || 'local-dev';
const BOT_VERSION = process.env.BOT_VERSION || '0.2.0-real';
const ACCOUNT_IDS = (process.env.BOT_ACCOUNT_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
const BOT_API_KEY = (process.env.BOT_API_KEY || '').trim();
const POLL_INTERVAL_MS = Math.max(1500, Number(process.env.BOT_POLL_INTERVAL_MS || 4000));
const POLL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BOT_POLL_LIMIT || 1)));
const HEARTBEAT_INTERVAL_MS = Math.max(5000, Number(process.env.BOT_HEARTBEAT_INTERVAL_MS || 15000));
const IG_BASE = (process.env.INSTAGRAM_BASE || 'https://www.instagram.com').replace(/\/+$/, '');
const PROFILE_DIR = process.env.BOT_PROFILE_DIR || `./data/bot_profiles/${BOT_ID}`;
const HEADLESS = String(process.env.BOT_HEADLESS || 'false').toLowerCase() === 'true';
const BOT_CDP_URL = (process.env.BOT_CDP_URL || '').trim();
const BOT_LAUNCH_MODE = (process.env.BOT_LAUNCH_MODE || 'cdp').trim().toLowerCase(); // cdp | persistent
const BOT_EXEC_MODE = (process.env.BOT_EXEC_MODE || 'browse_only').trim().toLowerCase();
const BOT_HUMAN_BREAK_MIN_MS = Math.max(60_000, Number(process.env.BOT_HUMAN_BREAK_MIN_MS) || Math.min(BOT_PROFILE.risk.breakMinMs, BOT_PROFILE.risk.breakMaxMs));
const BOT_HUMAN_BREAK_MAX_MS = Math.max(BOT_HUMAN_BREAK_MIN_MS, Number(process.env.BOT_HUMAN_BREAK_MAX_MS) || BOT_PROFILE.risk.breakMaxMs);
// env overrides profile; otherwise use per-bot profile value (deterministic from bot ID hash)
const BOT_BREAK_EVERY_N = Number(process.env.BOT_BREAK_EVERY_N) || (BOT_PROFILE as any).risk?.breakEveryN || 8;
const BOT_SPEED_FACTOR = Number(process.env.BOT_SPEED_FACTOR) || getDailySpeedFactor(BOT_PROFILE);
const BOT_VARIANCE = Number(process.env.BOT_VARIANCE) || (BOT_PROFILE as any).browsing?.variance || 0.2;
const BOT_BROWSE_ORDER = (process.env.BOT_BROWSE_ORDER || (BOT_PROFILE as any).browsing?.browseOrder || 'newest').trim().toLowerCase();
const BOT_MIN_VISIBLE_TILES = Number(process.env.BOT_MIN_VISIBLE_TILES) || BOT_PROFILE.browsing.minVisibleTiles;
const BOT_TASK_TYPE = (process.env.BOT_TASK_TYPE || '').trim(); // ig_outreach | reddit_scrape | supply_analysis — empty = all

// ─── Content Publish (auto-post) env vars ───
const BOT_CONTENT_PUBLISH_ENABLED = String(process.env.BOT_CONTENT_PUBLISH_ENABLED || 'false').toLowerCase() === 'true';
const POST_IMAGE_DIR = (process.env.POST_IMAGE_DIR || './output/peach_ink_cup').trim();
const BOT_PUBLISH_MAX_PER_DAY = Math.max(1, Number(process.env.BOT_PUBLISH_MAX_PER_DAY || 1));
const BOT_PUBLISH_POLL_INTERVAL_MS = Math.max(5000, Number(process.env.BOT_PUBLISH_POLL_INTERVAL_MS || 30000));
const BOT_PUBLISH_TYPING_SPEED_MIN_MS = Math.max(10, Number(process.env.BOT_PUBLISH_TYPING_SPEED_MIN_MS || 30));
const BOT_PUBLISH_TYPING_SPEED_MAX_MS = Math.max(BOT_PUBLISH_TYPING_SPEED_MIN_MS, Number(process.env.BOT_PUBLISH_TYPING_SPEED_MAX_MS || 80));
const BOT_PUBLISH_TYPING_CHINESE_MIN_MS = Math.max(100, Number(process.env.BOT_PUBLISH_TYPING_CHINESE_MIN_MS || 150));
const BOT_PUBLISH_TYPING_CHINESE_MAX_MS = Math.max(BOT_PUBLISH_TYPING_CHINESE_MIN_MS, Number(process.env.BOT_PUBLISH_TYPING_CHINESE_MAX_MS || 300));
const BOT_PUBLISH_TYPING_LONG_PAUSE_PROB = Math.min(1, Number(process.env.BOT_PUBLISH_TYPING_LONG_PAUSE_PROB || 0.3));
const BOT_PUBLISH_TYPING_LONG_PAUSE_MIN_MS = Math.max(500, Number(process.env.BOT_PUBLISH_TYPING_LONG_PAUSE_MIN_MS || 500));
const BOT_PUBLISH_TYPING_LONG_PAUSE_MAX_MS = Math.max(BOT_PUBLISH_TYPING_LONG_PAUSE_MIN_MS, Number(process.env.BOT_PUBLISH_TYPING_LONG_PAUSE_MAX_MS || 2000));
const BOT_PUBLISH_TYPING_FINAL_PAUSE_MIN_MS = Math.max(300, Number(process.env.BOT_PUBLISH_TYPING_FINAL_PAUSE_MIN_MS || 300));
const BOT_PUBLISH_TYPING_FINAL_PAUSE_MAX_MS = Math.max(BOT_PUBLISH_TYPING_FINAL_PAUSE_MIN_MS, Number(process.env.BOT_PUBLISH_TYPING_FINAL_PAUSE_MAX_MS || 1200));
const DEFAULT_BEHAVIOR_LOG = path.resolve(process.cwd(), 'data', 'bot_logs', `${BOT_ID}.jsonl`);
const BOT_BEHAVIOR_LOG = (process.env.BOT_BEHAVIOR_LOG || DEFAULT_BEHAVIOR_LOG).trim();
const BOT_PROXY_SERVER = (process.env.BOT_PROXY_SERVER || '').trim();
const BOT_PROXY_USERNAME = (process.env.BOT_PROXY_USERNAME || '').trim();
const BOT_PROXY_PASSWORD = (process.env.BOT_PROXY_PASSWORD || '').trim();
const BOT_NON_TATTOO_MODE = (process.env.BOT_NON_TATTOO_MODE || 'review_only').trim().toLowerCase(); // review_only | fail
const BOT_LIKE_MIN_PER_VISIT = Math.max(0, Math.min(5, Number(process.env.BOT_LIKE_MIN_PER_VISIT || 1)));
const BOT_LIKE_MAX_PER_VISIT = Math.max(BOT_LIKE_MIN_PER_VISIT, Math.min(8, Number(process.env.BOT_LIKE_MAX_PER_VISIT || 3)));
const BOT_LIKE_INTERVAL_MIN_SEC = Math.max(10, Number(process.env.BOT_LIKE_INTERVAL_MIN_SEC || 40));
const BOT_LIKE_INTERVAL_MAX_SEC = Math.max(BOT_LIKE_INTERVAL_MIN_SEC, Number(process.env.BOT_LIKE_INTERVAL_MAX_SEC || 120));
const BOT_LIKE_COOLDOWN_MIN_HOURS = Math.max(4, Number(process.env.BOT_LIKE_COOLDOWN_MIN_HOURS || 24));
const BOT_LIKE_COOLDOWN_MAX_HOURS = Math.max(BOT_LIKE_COOLDOWN_MIN_HOURS, Number(process.env.BOT_LIKE_COOLDOWN_MAX_HOURS || 72));
const BOT_SKIP_OLD_POST_DAYS = Math.max(30, Number(process.env.BOT_SKIP_OLD_POST_DAYS || 180));
const BOT_PREFER_RECENT_DAYS = Math.max(7, Number(process.env.BOT_PREFER_RECENT_DAYS || 30));
const BOT_COMMENT_ENABLED = String(process.env.BOT_COMMENT_ENABLED || 'false').toLowerCase() === 'true';
const BOT_COMMENT_CHANCE = Math.max(0, Math.min(1, Number(process.env.BOT_COMMENT_CHANCE || 0.2)));
const BOT_COMMENT_DAILY_MAX = Math.max(0, Math.min(20, Number(process.env.BOT_COMMENT_DAILY_MAX || 2)));
const BOT_COMMENT_HANDLE_COOLDOWN_HOURS = Math.max(24, Number(process.env.BOT_COMMENT_HANDLE_COOLDOWN_HOURS || 72));
const BOT_COMMENT_REVIEW_MODE = String(process.env.BOT_COMMENT_REVIEW_MODE || 'true').toLowerCase() === 'true'; // save comment for review, don't post
const COMMENT_REVIEW_DIR = path.resolve(process.cwd(), 'data', 'comment_review');
if (BOT_COMMENT_REVIEW_MODE && !fs.existsSync(COMMENT_REVIEW_DIR)) fs.mkdirSync(COMMENT_REVIEW_DIR, { recursive: true });
const BOT_FOLLOW_ENABLED = String(process.env.BOT_FOLLOW_ENABLED || 'false').toLowerCase() === 'true';
const BOT_FOLLOW_DAILY_MIN = Math.max(0, Math.min(30, Number(process.env.BOT_FOLLOW_DAILY_MIN || 2)));
const BOT_FOLLOW_DAILY_MAX = Math.max(BOT_FOLLOW_DAILY_MIN, Math.min(50, Number(process.env.BOT_FOLLOW_DAILY_MAX || 6)));
const BOT_FOLLOW_MIN_TOUCHES = Math.max(1, Number(process.env.BOT_FOLLOW_MIN_TOUCHES || 2)); // must have >= N visits before follow
const BOT_DAILY_BROWSE_TARGET_NEW = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_NEW || 25));
const BOT_DAILY_BROWSE_TARGET_TRANSITION = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_TRANSITION || 50));
const BOT_DAILY_BROWSE_TARGET_STABLE = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_STABLE || 80));

// ─── Explore / Hashtag / Save scoring thresholds (per-bot overridable via env) ───
const BOT_EXPLORE_VIEW_MIN = Math.max(1, Number(process.env.BOT_EXPLORE_VIEW_MIN || 3));
const BOT_EXPLORE_VIEW_MAX = Math.max(BOT_EXPLORE_VIEW_MIN, Number(process.env.BOT_EXPLORE_VIEW_MAX || 8));
const BOT_EXPLORE_LIKE_SCORE_MIN = Number(process.env.BOT_EXPLORE_LIKE_SCORE_MIN || 3);
const BOT_HASHTAG_VIEW_MIN = Math.max(1, Number(process.env.BOT_HASHTAG_VIEW_MIN || 3));
const BOT_HASHTAG_VIEW_MAX = Math.max(BOT_HASHTAG_VIEW_MIN, Number(process.env.BOT_HASHTAG_VIEW_MAX || 7));
const BOT_HASHTAG_LIKE_SCORE_MIN = Number(process.env.BOT_HASHTAG_LIKE_SCORE_MIN || 3);
const BOT_SAVE_SCORE_MIN = Number(process.env.BOT_SAVE_SCORE_MIN || 5);
const BOT_SAVE_CHANCE = Math.max(0, Math.min(1, Number(process.env.BOT_SAVE_CHANCE || 0.15)));

const POSITIVE_KEYWORDS = [
  'tattoo', 'tattooing', 'tattoo studio', 'tattoo shop', 'tattoo parlor', 'tattoo parlour',
  'ink', 'inked', 'blackwork', 'fineline', 'fine line', 'realism', 'traditional', 'neo traditional',
  'irezumi', 'flash', 'custom tattoo', 'coverup', 'cover up', 'piercing', 'body piercing', 'body art'
];
const NEGATIVE_KEYWORDS = [
  'optical', 'vision', 'eyewear', 'eye exam',
  'dental', 'dentist', 'orthodontic', 'clinic', 'medical spa',
  'law', 'attorney', 'legal services',
  'real estate', 'mortgage', 'insurance',
  'hvac', 'plumbing', 'electrician', 'roofing',
  'church', 'ministry', 'school', 'academy',
  'bakery', 'cafe', 'coffee', 'restaurant', 'catering'
];
const PROMO_KEYWORDS = [
  'giveaway', 'sale', 'promo', 'promotion', 'discount', 'deal', 'offer'
];
const BUSINESS_CTA_KEYWORDS = [
  'book now', 'book', 'booking', 'appointments', 'appointment', 'dm to book', 'consultation', 'consult'
];
const STYLE_KEYWORDS = [
  'fine line', 'fineline', 'blackwork', 'realism', 'traditional', 'neo traditional',
  'color', 'anime', 'microrealism', 'ornamental', 'japanese', 'irezumi',
  'geometric', 'dotwork', 'watercolor', 'illustrative', 'tribal', 'trash polka',
  'new school', 'american traditional', 'black and grey', 'surrealism',
];

const keywordHits = (text: string, keywords: string[]) => {
  const lower = String(text || '').toLowerCase();
  return keywords.filter((k) => lower.includes(k));
};
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const normalizeForMatch = (text: string) =>
  String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const parseCompactNumber = (text: string) => {
  const cleaned = String(text || '').trim().toLowerCase().replace(/,/g, '');
  // Handle Chinese 万 (10,000) and 亿 (100,000,000)
  const wanM = cleaned.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wanM) return Math.round(Number(wanM[1]) * 10000);
  const yiM = cleaned.match(/(\d+(?:\.\d+)?)\s*亿/);
  if (yiM) return Math.round(Number(yiM[1]) * 100000000);
  const m = cleaned.match(/(\d+(?:\.\d+)?)([km])?/i);
  if (!m) return 0;
  const base = Number(m[1] || 0);
  const unit = String(m[2] || '').toLowerCase();
  if (unit === 'k') return Math.round(base * 1000);
  if (unit === 'm') return Math.round(base * 1000000);
  return Math.round(base);
};

const parseFirstNumberLike = (text: string) => {
  const m = String(text || '').match(/(\d[\d,\.]*\s*[kKmM]?)/);
  return m?.[1] ? parseCompactNumber(m[1]) : 0;
};

const extractPostKey = (urlOrHref: string) => {
  const m = String(urlOrHref || '').match(/\/(?:p|reel)\/([^\/\?\#]+)/i);
  return m?.[1] ? String(m[1]).toLowerCase() : '';
};
const normalizeHandle = (v: string) => String(v || '').replace(/^@/, '').trim().toLowerCase();
const profileHandleFromUrl = (u: string) => {
  try {
    const p = new URL(u).pathname.split('/').filter(Boolean);
    return p[0] ? normalizeHandle(p[0]) : '';
  } catch {
    return '';
  }
};

let running = true;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let browserLaunchBootstrapUntil = 0;
let lockFilePath = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const hashString = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};
const BOT_BIAS = (hashString(BOT_ID) % 17) / 100; // 0.00 ~ 0.16, stable per bot
const scaleDelay = (v: number) => Math.max(150, Math.floor(v * BOT_SPEED_FACTOR * (1 + BOT_BIAS)));
const jitter = (min: number, max: number) => {
  const base = Math.floor(Math.random() * (max - min + 1)) + min;
  const swing = 1 + ((Math.random() * 2 - 1) * BOT_VARIANCE); // [1-var, 1+var]
  return scaleDelay(base * swing);
};
// Human break: pause for a random period to mimic natural behavior.
let breakUntil = 0;
const humanBreak = async () => {
  const now = Date.now();
  if (now < breakUntil) {
    const remaining = breakUntil - now;
    console.log(`[bot-cloak] human break: ${Math.round(remaining / 1000)}s remaining...`);
    await sleep(Math.min(remaining, 60000)); // sleep up to 1 min at a time
    return humanBreak(); // recurse if still in break
  }
};

// Schedule next break after N profiles (with jitter).
let profilesSinceBreak = 0;
const maybeScheduleBreak = async () => {
  profilesSinceBreak++;
  const threshold = BOT_BREAK_EVERY_N + Math.floor(Math.random() * 3) - 1; // jitter ±1
  if (profilesSinceBreak >= threshold) {
    const breakDuration = jitter(BOT_HUMAN_BREAK_MIN_MS, BOT_HUMAN_BREAK_MAX_MS);
    breakUntil = Date.now() + breakDuration;
    profilesSinceBreak = 0;
    logBehavior('human_break_start', { breakMs: breakDuration, breakUntil: new Date(breakUntil).toISOString() });
    console.log(`[bot-cloak] taking a ${Math.round(breakDuration / 1000)}s human break...`);
    // Do some idle scrolling to simulate a person browsing casually.
    try {
      if (page) {
        for (let i = 0; i < 3 + Math.floor(Math.random() * 4); i++) {
          await page.mouse.wheel(0, jitter(60, 300));
          await sleep(jitter(2000, 7000));
        }
      }
    } catch {}
  }
};

// Human-like mouse movement: gently move cursor to a random point in the viewport.
const humanMouseMove = async () => {
  if (!page || Math.random() > 0.4) return; // only ~60% chance
  try {
    const vp = page.viewportSize() || { width: BOT_PROFILE.viewport.width, height: BOT_PROFILE.viewport.height };
    const x = Math.floor(Math.random() * vp.width * 0.8);
    const y = Math.floor(Math.random() * vp.height * 0.6);
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 5) + 3 });
  } catch {}
};

// Random hover: briefly hover over a random article element to simulate reading interest.
const humanHover = async () => {
  if (!page || Math.random() > 0.3) return; // ~30% chance
  try {
    const articles = page.locator('article');
    const count = Math.min(await articles.count(), 20);
    if (count > 0) {
      const idx = Math.floor(Math.random() * count);
      await articles.nth(idx).hover({ timeout: 3000 }).catch(() => {});
      await sleep(jitter(400, 1800));
    }
  } catch {}
};

const STATE_DIR = path.resolve('./data/bot_state');
const LIKE_STATE_FILE = path.join(STATE_DIR, `${BOT_ID}_like_state.json`);
type LikeState = {
  byHandle: Record<string, { lastLikedAt?: number; nextEligibleAt?: number }>;
  touches?: Record<string, number>;
  touchesByDay?: Record<string, number>;
  firstTouchAt?: Record<string, number>;
  likes?: {
    byDay?: Record<string, number>;
    dayCap?: { key: string; cap: number };
  };
  follows?: {
    byDay?: Record<string, number>;
    byHandle?: Record<string, { followedAt?: number }>;
    dayCap?: { key: string; cap: number };
  };
  comments?: {
    byDay?: Record<string, number>;
    byHandle?: Record<string, { lastCommentAt?: number }>;
    recentText?: Array<{ ts: number; hash: number }>;
  };
};
const loadLikeState = (): LikeState => {
  try {
    if (!fs.existsSync(LIKE_STATE_FILE)) return { byHandle: {} };
    const raw = fs.readFileSync(LIKE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.byHandle ? parsed : { byHandle: {} };
  } catch {
    return { byHandle: {} };
  }
};
const saveLikeState = (state: LikeState) => {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LIKE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
};
const likeState = loadLikeState();
if (!likeState.touches) likeState.touches = {};
if (!likeState.touchesByDay) likeState.touchesByDay = {};
if (!likeState.firstTouchAt) likeState.firstTouchAt = {};
if (!likeState.likes) likeState.likes = { byDay: {} };
if (!likeState.likes.byDay) likeState.likes.byDay = {};
if (!likeState.follows) likeState.follows = { byDay: {}, byHandle: {} };
if (!likeState.follows.byDay) likeState.follows.byDay = {};
if (!likeState.follows.byHandle) likeState.follows.byHandle = {};
if (!likeState.comments) likeState.comments = { byDay: {}, byHandle: {}, recentText: [] };
if (!likeState.comments.byDay) likeState.comments.byDay = {};
if (!likeState.comments.byHandle) likeState.comments.byHandle = {};
if (!likeState.comments.recentText) likeState.comments.recentText = [];

const ensureBehaviorLogDir = () => {
  const p = path.resolve(BOT_BEHAVIOR_LOG);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
};

const BEHAVIOR_LOG_FILE = ensureBehaviorLogDir();

const ensureSingleInstance = () => {
  const lockDir = path.resolve('./data/bot_state');
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  lockFilePath = path.join(lockDir, `${BOT_ID}.cloak.lock`);
  const pid = process.pid;
  if (fs.existsSync(lockFilePath)) {
    const raw = fs.readFileSync(lockFilePath, 'utf8').trim();
    const oldPid = Number(raw);
    if (Number.isFinite(oldPid) && oldPid > 0) {
      try {
        process.kill(oldPid, 0); // process exists
        // If we can signal 0 successfully, another instance is alive.
        throw new Error(`bot_lock_exists_pid_${oldPid}`);
      } catch (e: any) {
        const msg = String(e?.message || '');
        if (msg.startsWith('bot_lock_exists_pid_')) throw e;
        // stale lock: continue
      }
    }
  }
  fs.writeFileSync(lockFilePath, String(pid), 'utf8');
};

const releaseSingleInstance = () => {
  try {
    if (lockFilePath && fs.existsSync(lockFilePath)) fs.unlinkSync(lockFilePath);
  } catch {}
};

const pickUsableInstagramPage = (ctx: BrowserContext): Page | null => {
  const pages = ctx.pages();
  for (const p of pages) {
    try {
      const u = String(p.url() || '');
      if (u.includes('instagram.com')) return p;
    } catch {}
  }
  for (const p of pages) {
    try {
      if (!p.isClosed()) return p;
    } catch {}
  }
  return null;
};

const closeExtraPages = async (ctx: BrowserContext, keep: Page | null) => {
  const pages = ctx.pages();
  if (pages.length <= 1) return;
  for (const p of pages) {
    if (keep && p === keep) continue;
    try { await p.close({ runBeforeUnload: false }); } catch {}
  }
};

const attachPageGuard = (ctx: BrowserContext) => {
  ctx.on('page', async (p: Page) => {
    try {
      // Let page initialize URL first
      await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      const all = ctx.pages();
      const keep = page && !page.isClosed() ? page : pickUsableInstagramPage(ctx);
      if (keep && p !== keep) {
        const u = String(p.url() || '');
        // During launch bootstrap, avoid killing fresh about:blank tabs too early.
        if (Date.now() < browserLaunchBootstrapUntil && (!u || u === 'about:blank')) return;
        const shouldClose = all.length > 1 || !u.includes('instagram.com');
        if (shouldClose) {
          logBehavior('extra_page_closed', { url: u || 'about:blank' });
          await p.close({ runBeforeUnload: false }).catch(() => {});
        }
      }
    } catch {}
  });
};

const logBehavior = (event: string, data: Record<string, any> = {}) => {
  try {
    const row = {
      ts: new Date().toISOString(),
      botId: BOT_ID,
      event,
      ...data
    };
    fs.appendFileSync(BEHAVIOR_LOG_FILE, JSON.stringify(row) + '\n', 'utf8');
  } catch {}
};

const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BOT_API_KEY) headers['x-bot-key'] = BOT_API_KEY;
  return headers;
};

const postJson = async (path: string, body: Record<string, any>) => {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`);
  return payload;
};

const getJson = async (path: string) => {
  const resp = await fetch(`${API_BASE}${path}`, { headers: buildHeaders() });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`);
  return payload;
};

const registerBot = async () => {
  await postJson('/api/bot/register', {
    botId: BOT_ID,
    accountIds: ACCOUNT_IDS,
    host: BOT_HOST,
    version: BOT_VERSION,
    meta: { mode: 'playwright-real', profileDir: PROFILE_DIR }
  });
};

const heartbeatBot = async () => {
  await postJson('/api/bot/heartbeat', {
    botId: BOT_ID,
    accountIds: ACCOUNT_IDS,
    host: BOT_HOST,
    version: BOT_VERSION
  });
};

const reportCommand = async (commandId: string, status: 'done' | 'failed', reason?: string) => {
  const payload: Record<string, any> = { botId: BOT_ID, commandId, status };
  if (reason) payload.reason = reason;
  await postJson('/api/automation/report', payload);
};

let launching: Promise<void> | null = null;
let lastLaunchTime = 0;

const ensureBrowser = async () => {
  if (context) {
    try {
      const reusable = pickUsableInstagramPage(context);
      if (reusable) {
        page = reusable;
        await closeExtraPages(context, page);
        const url = String(page.url() || '');
        if (!url || !url.includes('instagram.com')) {
          await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
        await page.bringToFront().catch(() => {});
        return;
      }
      // Keep existing context; recover by creating a fresh page inside it.
      const recovered = await (context as any).newPage();
      page = recovered;
      await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await closeExtraPages(context, page);
      await page.bringToFront().catch(() => {});
      return;
    } catch {}
    try { await context.close(); } catch {}
    context = null as any;
    page = null as any;
  }
  // Enforce launch cooldown
  const now = Date.now();
  const cooldownMs = 30000;
  if (now - lastLaunchTime < cooldownMs) {
    throw new Error(`browser launch cooldown (${Math.round((cooldownMs - (now - lastLaunchTime)) / 1000)}s remaining)`);
  }
  // Wait for an in-progress launch
  if (launching) {
    console.log('[bot-cloak] waiting for browser launch in progress...');
    await launching;
    return;
  }

  lastLaunchTime = Date.now();

  launching = (async () => {
    // CDP mode: connect to Desktop 2 Chrome (temporary, set BOT_CDP_URL to enable)
    // Persistent fallback: Playwright chromium.launchPersistentContext
    if (BOT_CDP_URL) {
      const cdpUrl = BOT_CDP_URL;
      console.log('[bot-cloak] connecting to Chrome via CDP:', cdpUrl);
      let browser: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          browser = await chromium.connectOverCDP(cdpUrl, { timeout: 20000 });
          break;
        } catch (e: any) {
          console.log(`[bot-cloak] CDP attempt ${attempt + 1}/3 failed:`, e.message?.slice(0, 100));
          if (attempt < 2) await sleep(3000 + attempt * 2000);
        }
      }
      if (!browser) throw new Error('CDP connect failed after 3 attempts');
      context = browser.contexts()[0];
      // Close stale pages that may lack Playwright script injection (fixes __name is not defined)
      for (const p of context.pages()) await p.close().catch(() => {});
      page = await context.newPage();
      await page.goto(IG_BASE, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await sleep(jitter(2000, 4000));
      console.log('[bot-cloak] CDP connected, new page at:', page.url().slice(0, 80));
      return;
    }

    // Playwright Chromium with persistent context (session survives restarts)
    // NOT CloakBrowser — chromium.launchPersistentContext keeps cookies across launches
    const profilePath = path.resolve(process.cwd(), PROFILE_DIR);
    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
    const userDataDir = path.join('F:/inkflow/bot_profiles', `${BOT_ID}_chrome_data`);

    const proxyConfig: { server: string; username?: string; password?: string } | undefined =
      BOT_PROXY_SERVER ? {
        server: BOT_PROXY_SERVER,
        ...(BOT_PROXY_USERNAME ? { username: BOT_PROXY_USERNAME } : {}),
        ...(BOT_PROXY_PASSWORD ? { password: BOT_PROXY_PASSWORD } : {}),
      } : undefined;

    const vp = BOT_PROFILE.viewport;
    const launchArgs: string[] = [];
    if (!HEADLESS) launchArgs.push(`--window-size=${vp.width},${vp.height}`);
    launchArgs.push('--disable-blink-features=AutomationControlled');

    console.log('[bot-cloak] launching Playwright Chromium (persistent)...');
    browserLaunchBootstrapUntil = Date.now() + 10000;
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: HEADLESS,
      channel: 'chrome', // use system Chrome, not bundled Chromium
      viewport: { width: vp.width, height: vp.height, deviceScaleFactor: 2 },
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
      args: launchArgs,
    }) as any;
    attachPageGuard(context as any);

    const existingPages = (context as any).pages?.() || [];
    page = pickUsableInstagramPage(context as any);
    if (!page && existingPages.length > 0) {
      page = existingPages[0];
    }
    if (!page) page = await (context as any).newPage();
    await closeExtraPages(context as any, page);

    if (!page.url() || !page.url().includes('instagram.com')) {
      await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.bringToFront().catch(() => {});
    const humanize = !(process.env.BOT_HUMANIZE === 'false');
    console.log(`[bot-cloak] launched Playwright Chromium persistent (humanize=${humanize ? 'on' : 'off'})`);
  })();

  try {
    await launching;
  } catch (e: any) {
    console.error('[bot-cloak] launch failed:', e?.message?.slice(0, 150));
    context = null as any;
    page = null as any;
    throw e;
  } finally {
    launching = null;
  }
};

const reportObservation = async (command: CommandPayload, summary: BrowseSummary, profileFacts?: Record<string, any>) => {
  const payload: Record<string, any> = {
    botId: BOT_ID,
    commandId: command.id,
    artistId: command.artistId || null,
    artistHandle: command.artistHandle || null,
    mode: (profileFacts && profileFacts.mode) || BOT_EXEC_MODE,
    summary,
    profileFacts: profileFacts || {}
  };
  await postJson('/api/bot/observe', payload);
};

const ensureExecMode = (mode: string) => {
  if (mode !== 'browse_only' && mode !== 'browse_like') {
    throw new Error(`invalid_exec_mode_${mode}`);
  }
};

const ensureBrowserLegacyLaunchDisabled = () => {
  // Persistent Chromium: only launchPersistentContext is used. No CDP, no legacy paths.
  return;
};

const openProfile = async (handle: string) => {
  if (!page) throw new Error('page_not_initialized');
  const cleanHandle = handle.replace(/^@/, '');
  const url = `${IG_BASE}/${cleanHandle}/`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Fetch profile data from IG's internal API.
  // CloakBrowser shares the IG session, so a fetch() from page context
  // includes auth cookies and returns exact stats — no DOM/OCR needed.
  let profileApiData: any = null;
  try {
    const apiUrl = `${IG_BASE}/api/v1/users/web_profile_info/?username=${cleanHandle}`;
    profileApiData = await page.evaluate(async (url) => {
      // Try fetch with IG-required headers first
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: {
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        if (res.ok) return await res.json();
      } catch {}
      // Fallback: XMLHttpRequest (older IG API compat)
      try {
        const xhr = await new Promise<any>((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open('GET', url, true);
          x.withCredentials = true;
          x.setRequestHeader('X-IG-App-ID', '936619743392459');
          x.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          x.onload = () => {
            if (x.status === 200) {
              try { resolve(JSON.parse(x.responseText)); } catch { resolve(null); }
            } else {
              resolve(null);
            }
          };
          x.onerror = () => resolve(null);
          x.send();
        });
        return xhr;
      } catch {
        return null;
      }
    }, apiUrl);
  } catch {}
  logBehavior('profile_api_fetch', { handle: cleanHandle, found: !!profileApiData });
  (page as any)._inkflow_profileApi = profileApiData;

  // Check if this account follows us back (self-learning feedback)
  const prevFollow = likeState.follows?.byHandle?.[cleanHandle];
  if (prevFollow?.followedAt && !prevFollow.followBackDetected) {
    try {
      const followsYou = await page.locator('text="Follows you"').first().isVisible({ timeout: 2000 }).catch(() => false);
      if (followsYou) {
        (likeState.follows!.byHandle![cleanHandle] as any).followBackDetected = true;
        (likeState.follows!.byHandle![cleanHandle] as any).followBackDetectedAt = Date.now();
        saveLikeState(likeState);
        logBehavior('follow_back_detected', { handle: cleanHandle });
        // Report to server
        postJson('/api/bot/follow-back-report', {
          targetHandle: cleanHandle,
          didFollowBack: true
        }).catch(() => {});
        // Create DM marketing task for follow-up outreach
        // Category will be refined server-side from profile data
        postJson('/api/automation/create-marketing-task', {
          targetHandle: cleanHandle,
          targetName: (profileApiData?.data?.user?.full_name || cleanHandle),
          botId: BOT_ID,
          category: 'industry_talk',
          direction: 'auto_detected',
          leadScore: 0,
          touchCount: likeState.touches?.[cleanHandle] || 0
        }).catch(() => {});
      }
    } catch {}
  }

  const dwell = jitter(1500, 3200);
  await page.waitForTimeout(dwell);
  logBehavior('open_profile', { handle, dwellMs: dwell });
  logBehavior('open_profile_done', { handle, currentUrl: page.url() });
};

type RelationshipEntry = {
  username: string;
  fullName: string;
  profilePicUrl: string;
  isPrivate: boolean;
  isVerified: boolean;
};

type RelationshipData = {
  sourceHandle: string;
  sourceIgUserId: string;
  followers: RelationshipEntry[];
  following: RelationshipEntry[];
};

const scrapeFollowerGraph = async (
  handle: string,
  igUserId: string,
  maxCount: number = 50
): Promise<RelationshipData | null> => {
  if (!page) return null;
  const cleanHandle = handle.replace(/^@/, '');
  const MAX_PER_PAGE = Math.min(maxCount, 100);

  const fetchFromPage = async (url: string): Promise<any> => {
    return page.evaluate(async (u) => {
      // Try fetch first
      try {
        const res = await fetch(u, {
          credentials: 'include',
          headers: {
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest',
          },
        });
        if (res.ok) return await res.json();
      } catch {}
      // Fallback to XHR
      try {
        const xhr = await new Promise<any>((resolve) => {
          const x = new XMLHttpRequest();
          x.open('GET', u, true);
          x.withCredentials = true;
          x.setRequestHeader('X-IG-App-ID', '936619743392459');
          x.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          x.onload = () => {
            if (x.status === 200) {
              try { resolve(JSON.parse(x.responseText)); } catch { resolve(null); }
            } else { resolve(null); }
          };
          x.onerror = () => resolve(null);
          x.send();
        });
        return xhr;
      } catch { return null; }
    }, url);
  };

  const mapUsers = (json: any): RelationshipEntry[] => {
    const users = json?.users;
    if (!users || !Array.isArray(users)) return [];
    return users.slice(0, maxCount).map((u: any) => ({
      username: String(u.username || ''),
      fullName: String(u.full_name || '').slice(0, 200),
      profilePicUrl: String(u.profile_pic_url || ''),
      isPrivate: u.is_private === true,
      isVerified: u.is_verified === true,
    }));
  };

  let followers: RelationshipEntry[] = [];
  let following: RelationshipEntry[] = [];

  try {
    const followersUrl = `${IG_BASE}/api/v1/friendships/${igUserId}/followers/?count=${MAX_PER_PAGE}&search_surface=follow_list_page`;
    const followersJson = await fetchFromPage(followersUrl);
    followers = mapUsers(followersJson);
  } catch {}

  try {
    const followingUrl = `${IG_BASE}/api/v1/friendships/${igUserId}/following/?count=${MAX_PER_PAGE}`;
    const followingJson = await fetchFromPage(followingUrl);
    following = mapUsers(followingJson);
  } catch {}

  logBehavior('relationship_graph_scraped', {
    handle: cleanHandle,
    igUserId,
    followerCount: followers.length,
    followingCount: following.length,
  });

  return { sourceHandle: cleanHandle, sourceIgUserId: igUserId, followers, following };
};

const isInvalidProfilePage = async () => {
  if (!page) return false;
  const url = page.url().toLowerCase();
  // IG login wall → need re-auth
  if (url.includes('/accounts/login')) return true;
  // IG error/block pages via URL patterns
  if (url.includes('/challenge/') || url.includes('/account_recovery/')) return true;

  // Multi-language "page not available" detection patterns
  const INVALID_PATTERNS = [
    // English
    "sorry, this page isn't available",
    "the link you followed may be broken",
    "page not found",
    "user not found",
    "couldn't find this account",
    "no posts yet",
    // Spanish
    "lo sentimos, esta página no está disponible",
    "página no encontrada",
    "usuario no encontrado",
    // Portuguese
    "desculpe, esta página não está disponível",
    "página não encontrada",
    // French
    "cette page n'est pas disponible",
    "page introuvable",
    // German
    "diese seite ist leider nicht verfügbar",
    "seite nicht gefunden",
    // Italian
    "questa pagina non è disponibile",
    "pagina non trovata",
    // Chinese
    "页面不可用",
    "找不到此页面",
    // Japanese
    "このページはご利用いただけません",
    // Korean
    "페이지를 사용할 수 없습니다",
    // Arabic
    "عذرًا، هذه الصفحة غير متاحة",
    // Russian
    "страница недоступна",
  ];

  // Check page title first (faster, less likely to timeout)
  try {
    const title = (await page.title()).toLowerCase();
    for (const pat of INVALID_PATTERNS) {
      if (title.includes(pat)) return true;
    }
  } catch {}

  // Check body text
  try {
    const bodyText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).toLowerCase();
    for (const pat of INVALID_PATTERNS) {
      if (bodyText.includes(pat)) return true;
    }
    // Generic low-content signal: error pages usually have very little text
    if (bodyText.length < 50 && (
      bodyText.includes('instagram') || bodyText.includes('log in') || bodyText.includes('sign up')
    )) {
      return true;
    }
  } catch {}

  return false;
};

// Detect and escape Instagram follow-suggestions / explore-people trap page.
const escapeFollowTrap = async () => {
  if (!page) return;
  const url = page.url().toLowerCase();
  const isTrapUrl = url.includes('/explore/people/') || url.includes('/explore/');
  if (!isTrapUrl) return;
  logBehavior('follow_trap_detected', { url: page.url() });
  await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(jitter(2000, 3500));
  logBehavior('follow_trap_escaped', { landedUrl: page.url() });
};

// =====================================================================
// NEW: Browse Explore / 发现页 — 模拟人类"刷 feed"行为
// =====================================================================

const browseExplore = async (): Promise<{ viewed: number; liked: number }> => {
  if (!page) return { viewed: 0, liked: 0 };
  try {
    // Navigate to explore page — intentionally NOT escaping this time
    await page.goto(`${IG_BASE}/explore/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(3000, 6000)); // let explore feed fully load

    // Scroll through explore page
    await humanMouseMove();
    const scrollRounds = randInt(3, 7);
    for (let i = 0; i < scrollRounds; i++) {
      const wheel = jitter(350, 800);
      const pause = jitter(800, 2000);
      await page.mouse.wheel(0, wheel);
      await page.waitForTimeout(pause);
      await humanHover();
    }

    // Wait for tiles to appear
    await page.waitForTimeout(jitter(2000, 4000));
    const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]');
    const total = await tiles.count();
    if (total === 0) {
      logBehavior('explore_no_tiles');
      await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return { viewed: 0, liked: 0 };
    }

    // View 3-8 posts from explore (random subset, don't check all)
    const viewCount = Math.min(randInt(3, 8), total);
    let viewed = 0;
    let liked = 0;
    const viewedIndices = new Set<number>();

    for (let v = 0; v < viewCount; v++) {
      // Pick a random unseen tile
      let idx: number;
      let attempts = 0;
      do {
        idx = randInt(0, Math.min(total - 1, 30)); // cap at first 30 tiles
        attempts++;
      } while (viewedIndices.has(idx) && attempts < 10);

      if (viewedIndices.has(idx)) continue;
      viewedIndices.add(idx);

      try {
        // Scroll tile into view
        await tiles.nth(idx).scrollIntoViewIfNeeded();
        await page.waitForTimeout(jitter(600, 1400));
        await tiles.nth(idx).click({ timeout: 10000 });
        await page.waitForTimeout(jitter(1500, 3500));

        // Read post meta for like decision
        const postKey = extractPostKey(page.url());
        if (postKey) viewed++;
        logBehavior('explore_viewed', { viewIndex: viewed, postKey });

        // Decide to like (15-30% chance, less aggressive than profile)
        if (Math.random() < 0.22) {
          try {
            const likeBtn = page.locator('a[aria-label="Like"] a, span[aria-label="Like"] button, div[role="button"] svg[aria-label="Like"], a[aria-label="Like"] svg').first();
            if ((await likeBtn.count()) > 0) {
              await likeBtn.click({ timeout: 5000 });
              liked++;
              logBehavior('explore_like', { viewIndex: viewed, postKey });
            }
          } catch {
            // Like button selector may vary; silently skip
          }
          await page.waitForTimeout(jitter(800, 2000));
        }

        // Close modal
        await closeModal().catch(() => {});
        await page.waitForTimeout(jitter(800, 2000));
      } catch {
        await closeModal().catch(() => {});
        await page.waitForTimeout(jitter(500, 1500));
      }
    }

    // Return home after browsing
    await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(2000, 3500));
    logBehavior('explore_done', { viewed, liked, totalTiles: total });
    return { viewed, liked };
  } catch (err: any) {
    logBehavior('explore_error', { error: String(err?.message || err) });
    // Try to return home
    try { await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    return { viewed: 0, liked: 0 };
  }
};

// =====================================================================
// NEW: Browse Following/Follower list — 抽样浏览
// =====================================================================

const browseFollowerFollowing = async (handle: string, mode: 'following' | 'followers'): Promise<{ viewed: number }> => {
  if (!page) return { viewed: 0 };
  try {
    // Navigate to the user's profile first
    await openProfile(handle).catch(() => {});
    await page.waitForTimeout(jitter(1500, 3000));

    // Find the Following/Followers link
    const linkSelector = mode === 'following'
      ? `a[href*="/${handle}/following/"]`
      : `a[href*="/${handle}/followers/"]`;
    const link = page.locator(linkSelector).first();

    if ((await link.count()) === 0) {
      logBehavior('browse_rel_link_not_found', { handle, mode });
      return { viewed: 0 };
    }

    await link.click({ timeout: 8000 });
    await page.waitForTimeout(jitter(3000, 5000)); // list page takes time to load

    // Scroll through the list — but only view a few profiles
    await humanMouseMove();
    const scrollRounds = randInt(2, 4);
    for (let i = 0; i < scrollRounds; i++) {
      const wheel = jitter(200, 500);
      const pause = jitter(600, 1500);
      await page.mouse.wheel(0, wheel);
      await page.waitForTimeout(pause);
    }
    await page.waitForTimeout(jitter(1500, 3000));

    // Click on 2-5 random profiles to view their grid
    const profileTiles = page.locator('a[role="button"], article a[href*="/p/"], a[href*="/p/"]');
    const totalTiles = await profileTiles.count();
    const viewCount = Math.min(randInt(2, 5), Math.max(1, totalTiles));
    let viewed = 0;

    for (let v = 0; v < viewCount; v++) {
      // Pick a random tile (skip first row which might be header)
      const startIdx = Math.max(1, totalTiles - 20); // avoid header tiles
      if (startIdx <= 0) break;
      const idx = randInt(startIdx, Math.min(totalTiles - 1, startIdx + 15));

      try {
        // Click tile to see post grid
        await profileTiles.nth(idx).scrollIntoViewIfNeeded();
        await profileTiles.nth(idx).click({ timeout: 8000 });
        await page.waitForTimeout(jitter(1200, 2500));

        // Scroll the grid briefly
        const gridScroll = randInt(1, 3);
        for (let s = 0; s < gridScroll; s++) {
          await page.mouse.wheel(0, jitter(200, 500));
          await page.waitForTimeout(jitter(400, 1000));
        }

        viewed++;
        logBehavior('browse_rel_profile_viewed', { handle, mode, viewIndex: viewed });

        // Close by pressing Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(jitter(800, 1800));
      } catch {
        // Some tiles may not be posts, skip
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(jitter(400, 1200));
      }
    }

    // Go back to IG home (not necessarily the profile)
    await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(2000, 3500));
    logBehavior('browse_rel_done', { handle, mode, viewed });
    return { viewed };
  } catch (err: any) {
    logBehavior('browse_rel_error', { handle, mode, error: String(err?.message || err) });
    try { await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    return { viewed: 0 };
  }
};

// =====================================================================
// NEW: Browse hashtag search results — 浏览 hashtag 搜索结果
// =====================================================================

const browseHashtagSearch = async (hashtag: string): Promise<{ viewed: number; liked: number }> => {
  if (!page) return { viewed: 0, liked: 0 };
  try {
    // Search for hashtag — use IG's search bar on the explore/home page
    await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(2000, 4000));

    // Click search icon (top nav magnifying glass)
    const searchBtn = page.locator('a[href="/explore/"], svg[aria-label="Search"], button[aria-label="Search"]').first();
    if ((await searchBtn.count()) === 0) {
      // Try direct hashtag URL as fallback
      await page.goto(`${IG_BASE}/explore/tags/${hashtag.replace(/^#/, '')}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(jitter(3000, 5000));
    } else {
      await searchBtn.click({ timeout: 5000 });
      await page.waitForTimeout(jitter(1500, 3000));

      // Type hashtag slowly
      const hashtagText = hashtag.replace(/^#/, '');
      const searchInput = page.locator('input[type="text"], input[role="combobox"]').first();
      if ((await searchInput.count()) > 0) {
        await searchInput.click({ timeout: 5000 });
        for (const char of hashtagText) {
          await page.keyboard.type(char, { delay: jitter(80, 200) });
        }
        await page.waitForTimeout(jitter(1500, 3000));

        // Click the hashtag result or press Enter
        const hashtagResult = page.locator('a[href*="/explore/tags/"]').first();
        if ((await hashtagResult.count()) > 0) {
          await hashtagResult.click({ timeout: 5000 });
        } else {
          await page.keyboard.press('Enter');
        }
        await page.waitForTimeout(jitter(2000, 4000));
      }
    }

    // Scroll through hashtag results
    await humanMouseMove();
    const scrollRounds = randInt(3, 6);
    for (let i = 0; i < scrollRounds; i++) {
      const wheel = jitter(300, 700);
      const pause = jitter(800, 1800);
      await page.mouse.wheel(0, wheel);
      await page.waitForTimeout(pause);
      await humanHover();
    }
    await page.waitForTimeout(jitter(2000, 4000));

    // View and optionally like 3-7 posts
    const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]');
    const total = await tiles.count();
    if (total === 0) {
      logBehavior('hashtag_no_tiles', { hashtag });
      return { viewed: 0, liked: 0 };
    }

    const viewCount = Math.min(randInt(3, 7), total);
    let viewed = 0;
    let liked = 0;

    for (let v = 0; v < viewCount; v++) {
      const idx = randInt(0, Math.min(total - 1, 30));
      try {
        await tiles.nth(idx).scrollIntoViewIfNeeded();
        await tiles.nth(idx).click({ timeout: 10000 });
        await page.waitForTimeout(jitter(1500, 3500));

        viewed++;
        logBehavior('hashtag_viewed', { hashtag, viewIndex: viewed });

        // Like chance: slightly higher than explore (25-35%)
        if (Math.random() < 0.3) {
          try {
            const likeBtn = page.locator('a[aria-label="Like"] a, span[aria-label="Like"] button, div[role="button"] svg[aria-label="Like"]').first();
            if ((await likeBtn.count()) > 0) {
              await likeBtn.click({ timeout: 5000 });
              liked++;
              logBehavior('hashtag_like', { hashtag, viewIndex: viewed });
            }
          } catch {}
          await page.waitForTimeout(jitter(600, 1500));
        }

        await closeModal().catch(() => {});
        await page.waitForTimeout(jitter(800, 2000));
      } catch {
        await closeModal().catch(() => {});
        await page.waitForTimeout(jitter(500, 1500));
      }
    }

    await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(2000, 3500));
    logBehavior('hashtag_done', { hashtag, viewed, liked });
    return { viewed, liked };
  } catch (err: any) {
    logBehavior('hashtag_error', { hashtag, error: String(err?.message || err) });
    try { await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    return { viewed: 0, liked: 0 };
  }
};

// =====================================================================
// NEW: Save/Bookmark action — 偶尔收藏帖子
// =====================================================================

const trySaveBookmark = async (): Promise<{ saved: boolean; postUrl?: string }> => {
  if (!page) return { saved: false };
  try {
    // Open a random post to save (from current page)
    const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]');
    const total = await tiles.count();
    if (total === 0) return { saved: false };

    const idx = randInt(0, Math.min(total - 1, 20));
    await tiles.nth(idx).scrollIntoViewIfNeeded();
    await tiles.nth(idx).click({ timeout: 10000 });
    await page.waitForTimeout(jitter(1500, 3000));

    // Look for the bookmark/save button (usually in the more options menu)
    const saveAttempted = await trySaveFromModal();

    await closeModal().catch(() => {});
    await page.waitForTimeout(jitter(800, 1800));

    if (saveAttempted) {
      return { saved: true, postUrl: page.url() };
    }
    return { saved: false };
  } catch (err: any) {
    logBehavior('save_error', { error: String(err?.message || err) });
    return { saved: false };
  }
};

/** Try to save the currently open post modal */
const trySaveFromModal = async (): Promise<boolean> => {
  if (!page) return false;
  try {
    // Option 1: Bookmark icon directly on the modal (top right)
    const bookmarkBtns = page.locator('a[aria-label="Save post"], button[aria-label="Save post"], a[aria-label="Save"] svg, button[aria-label="Save"] svg');
    if ((await bookmarkBtns.count()) > 0) {
      await bookmarkBtns.first().click({ timeout: 5000 });
      logBehavior('save_via_direct_btn');
      return true;
    }

    // Option 2: More options menu (three dots) -> Save
    const moreBtn = page.locator('button[aria-label="More options"], div[role="button"] svg[aria-label="More options"], a[aria-label="More options"] svg').first();
    if ((await moreBtn.count()) > 0) {
      await moreBtn.click({ timeout: 5000 });
      await page.waitForTimeout(jitter(800, 2000));

      // Click "Save" in the menu
      const saveInMenu = page.locator('button:has-text("Save"), div[role="menuitem"]:has-text("Save"), a:has-text("Save"), div[role="button"]:has-text("Save")').first();
      if ((await saveInMenu.count()) > 0) {
        await saveInMenu.click({ timeout: 5000 });
        logBehavior('save_via_more_menu');
        return true;
      }
    }

    // Option 3: Right-click or long-press context menu (mobile style)
    const tileCenter = page.locator('article').first();
    if ((await tileCenter.count()) > 0) {
      await tileCenter.first().hover();
      await page.mouse.move(0, 0, { steps: 10 });
      // Sometimes a save option appears
      await page.waitForTimeout(jitter(500, 1000));
    }

    return false;
  } catch {
    return false;
  }
};

const waitForProfileGridReady = async () => {
  if (!page) throw new Error('page_not_initialized');
  // Wait until profile container is visible.
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 });

  // Wait for post/reel tiles to appear. Retry with gentle scroll if lazy-loaded.
  let ready = false;
  for (let i = 0; i < 3; i++) {
    const mediaCount = await page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]').count();
    if (mediaCount > 0) {
      ready = true;
      break;
    }
    await page.waitForTimeout(jitter(1200, 2600));
    await page.mouse.wheel(0, jitter(120, 280)); // tiny nudge to trigger lazy load
  }

  if (!ready) {
    // Continue anyway, but leave a strong signal in logs.
    logBehavior('grid_ready_timeout', { reason: 'no_media_tile_found' });
  } else {
    // Give UI time to fully paint thumbnails/text.
    await page.waitForTimeout(jitter(1800, 3600));
    logBehavior('grid_ready', { ok: true });
  }
};

const waitForMinVisibleTiles = async () => {
  if (!page) throw new Error('page_not_initialized');
  const tileSelector = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const visibleCount = await page.locator(`${tileSelector}:visible`).count();
    if (visibleCount >= BOT_MIN_VISIBLE_TILES) {
      logBehavior('visible_tiles_ready', { visibleCount, minRequired: BOT_MIN_VISIBLE_TILES, attempt });
      return;
    }
    logBehavior('visible_tiles_wait', { visibleCount, minRequired: BOT_MIN_VISIBLE_TILES, attempt });
    await page.waitForTimeout(jitter(1000, 2200));
    await page.mouse.wheel(0, jitter(80, 220));
  }
  const finalVisible = await page.locator(`${tileSelector}:visible`).count();
  logBehavior('visible_tiles_timeout', { visibleCount: finalVisible, minRequired: BOT_MIN_VISIBLE_TILES });
};

const browseProfileDeep = async (): Promise<BrowseSummary> => {
  if (!page) throw new Error('page_not_initialized');
  const expectedHandle = profileHandleFromUrl(page.url());
  await waitForProfileGridReady();
  await waitForMinVisibleTiles();

  // Gentle profile scroll to simulate reading bio/grid.
  await humanMouseMove();
  const scrollRounds = randInt(3, 6);
  for (let i = 0; i < scrollRounds; i++) {
    const wheel = jitter(350, 900);
    const pause = jitter(800, 2200);
    await page.mouse.wheel(0, wheel);
    await page.waitForTimeout(pause);
    await humanHover();
    logBehavior('profile_scroll', { wheelPx: wheel, pauseMs: pause });
  }

  // Open media posts/reels with retries. Dynamic amount based on profile content size.
  const mediaLocator = page.locator('a[href*="/p/"], a[href*="/reel/"]');
  let totalMedia = await mediaLocator.count();
  if (totalMedia === 0) {
    await page.waitForTimeout(jitter(1200, 2800));
    // One extra scroll and retry in case grid loads late.
    await page.mouse.wheel(0, jitter(450, 1000));
    await page.waitForTimeout(jitter(1000, 2400));
    totalMedia = await mediaLocator.count();
  }
  logBehavior('media_candidates', { totalMedia });

  let minOpen = 1;
  let maxOpen = 3;
  if (totalMedia > 12 && totalMedia <= 60) {
    minOpen = 2;
    maxOpen = 5;
  } else if (totalMedia > 60) {
    minOpen = 3;
    maxOpen = 8;
  }

  // Session-depth randomness: mostly normal, sometimes light, sometimes deep.
  const r = Math.random();
  let desiredOpenCount = randInt(minOpen, maxOpen);
  if (r < 0.2) {
    desiredOpenCount = Math.max(1, desiredOpenCount - 1); // light session
  } else if (r > 0.9) {
    desiredOpenCount = Math.min(maxOpen + 2, desiredOpenCount + 2); // deep session
  }
  desiredOpenCount = Math.min(desiredOpenCount, Math.max(1, totalMedia));

  const candidateCount = Math.min(totalMedia, 18);
  const candidates: Array<{ idx: number; score: number; tattooHits: number; negativeHits: number; isReel: boolean; postKey: string }> = [];
  const candidateByIdx = new Map<number, { idx: number; score: number; tattooHits: number; negativeHits: number; isReel: boolean; postKey: string }>();
  const seenCandidateKeys = new Set<string>();
  for (let idx = 0; idx < candidateCount; idx++) {
    try {
      const tile = mediaLocator.nth(idx);
      const href = String((await tile.getAttribute('href').catch(() => '')) || '');
      const postKey = extractPostKey(href) || `idx_${idx}`;
      if (seenCandidateKeys.has(postKey)) continue;
      seenCandidateKeys.add(postKey);
      const alt = String((await tile.locator('img[alt]').first().getAttribute('alt').catch(() => '')) || '');
      const aria = String((await tile.getAttribute('aria-label').catch(() => '')) || '');
      const blob = normalizeForMatch(`${href} ${alt} ${aria}`);
      const tattooHits = keywordHits(blob, POSITIVE_KEYWORDS).length;
      const negativeHits = keywordHits(blob, NEGATIVE_KEYWORDS).length;
      const promoHits = keywordHits(blob, PROMO_KEYWORDS).length;
      const isReel = /\/reel\//i.test(href);

      let score = 0;
      score += tattooHits * 3;
      score -= negativeHits * 4;
      score -= promoHits * 3;
      if (idx < 3) score += 2; // likely pinned/featured zone
      if (isReel) score -= 1; // reels轻降权，避免过多蹭热视频
      score += Math.random() * 1.5; // 同分时随机化，避免固定模式

      const row = { idx, score, tattooHits, negativeHits, isReel, postKey };
      candidates.push(row);
      candidateByIdx.set(idx, row);
    } catch {
      const row = { idx, score: Math.random(), tattooHits: 0, negativeHits: 0, isReel: false, postKey: `idx_${idx}` };
      candidates.push(row);
      candidateByIdx.set(idx, row);
    }
  }

  // 按分排序后，从高分池随机抽样，避免顺序点击。
  candidates.sort((a, b) => b.score - a.score);
  let selectionPool = candidates;
  if (BOT_BROWSE_ORDER === 'newest') {
    selectionPool = [...candidates].sort((a, b) => a.idx - b.idx);
  } else {
    const poolSize = Math.max(desiredOpenCount, Math.ceil(candidates.length * 0.65));
    selectionPool = candidates.slice(0, Math.min(candidates.length, poolSize));
  }
  const chosen: number[] = [];
  const used = new Set<number>();
  while (chosen.length < desiredOpenCount && used.size < selectionPool.length) {
    const pick = selectionPool[randInt(0, selectionPool.length - 1)];
    if (!pick || used.has(pick.idx)) continue;
    used.add(pick.idx);
    chosen.push(pick.idx);
  }
  if (chosen.length < desiredOpenCount) {
    const fallback = candidates.map((c) => c.idx).filter((idx) => !used.has(idx));
    fallback.sort(() => Math.random() - 0.5);
    for (const idx of fallback) {
      if (chosen.length >= desiredOpenCount) break;
      chosen.push(idx);
    }
  }
  logBehavior('browse_selection', {
    totalMedia,
    candidateCount,
    desiredOpenCount,
    selected: chosen,
    topScores: candidates.slice(0, 8).map((c) => ({ idx: c.idx, score: Number(c.score.toFixed(2)), tattooHits: c.tattooHits, negativeHits: c.negativeHits, isReel: c.isReel }))
  });

  let opened = 0;
  const openedPostKeys = new Set<string>();
  for (let i = 0; i < chosen.length && opened < desiredOpenCount; i++) {
    const idx = chosen[i];
    const c = candidateByIdx.get(idx);
    if (c?.postKey && openedPostKeys.has(c.postKey)) continue;
    try {
      await mediaLocator.nth(idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(900, 2200)); // allow tile to fully render in viewport
      await humanMouseMove();
      await mediaLocator.nth(idx).click({ timeout: 12000 });
    } catch {
      // Try JS click fallback
      try {
        await mediaLocator.nth(idx).evaluate((el: any) => el.click());
      } catch {
        continue;
      }
    }
    const meta = await readModalMeta('', expectedHandle);
    const ownerOk = meta?.isOwnerPost !== false;
    const tattooSignal = Number((c?.tattooHits || 0) + (meta?.positive || 0) + (meta?.styleBoost || 0));
    const modalPostKey = String(meta?.postKey || c?.postKey || '');
    if (modalPostKey && openedPostKeys.has(modalPostKey)) {
      await closeModal().catch(() => {});
      continue;
    }
    if (!ownerOk) {
      logBehavior('browse_skip_non_owner_post', { postIndex: idx, ownerHandle: meta?.ownerHandle || '', expectedHandle });
      await closeModal().catch(() => {});
      continue;
    }
    if (tattooSignal <= 0) {
      logBehavior('browse_skip_low_tattoo_signal', { postIndex: idx, ownerHandle: meta?.ownerHandle || '', expectedHandle, tattooSignal });
      await closeModal().catch(() => {});
      continue;
    }
    opened += 1;
    if (modalPostKey) openedPostKeys.add(modalPostKey);
    const watch = jitter(2500, 7000);
    await page.waitForTimeout(watch); // watch image/video
    logBehavior('open_post', { postIndex: idx, watchMs: watch, postKey: modalPostKey || c?.postKey || '', ownerHandle: meta?.ownerHandle || '', tattooSignal });

    const nextBtn = page.locator('button[aria-label="Next"], button[aria-label="下一步"]').first();
    if (await nextBtn.count()) {
      // Occasionally browse one more media item in modal.
      if (Math.random() < 0.35) {
        let movedNext = false;
        try {
          await nextBtn.click({ timeout: 2500 });
          movedNext = true;
        } catch {
          try {
            await nextBtn.evaluate((el: any) => el.click());
            movedNext = true;
          } catch {
            try {
              await page.keyboard.press('ArrowRight');
              movedNext = true;
            } catch {}
          }
        }
        if (movedNext) {
          const nextWatch = jitter(1800, 4500);
          await page.waitForTimeout(nextWatch);
          const nextKey = extractPostKey(page.url());
          if (nextKey) openedPostKeys.add(nextKey);
          logBehavior('next_post', { watchMs: nextWatch });
        } else {
          logBehavior('next_post_skip', { reason: 'click_intercepted' });
        }
      }
    }

    const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="鍏抽棴"]').first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click({ timeout: 5000 });
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(jitter(900, 2200));
  }
  const summary = { totalMedia, opened, desiredOpenCount };
  logBehavior('media_opened_total', summary);
  return summary;
};

const captureProfileFacts = async () => {
  if (!page) throw new Error('page_not_initialized');
  const url = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {}

  let statTexts: string[] = [];
  try {
    const statsLocator = page.locator('header section ul li span, header ul li span');
    const count = Math.min(await statsLocator.count(), 8);
    const vals: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = (await statsLocator.nth(i).innerText().catch(() => '')).trim();
      if (t) vals.push(t);
    }
    statTexts = vals;
  } catch {}

  let bio = '';
  try {
    const bioCandidates = [
      'header section h1',
      'header section div.-vDIg span',
      'header section div.x78zum5 span'
    ];
    for (const sel of bioCandidates) {
      const t = (await page.locator(sel).first().innerText().catch(() => '')).trim();
      if (t) {
        bio = t;
        break;
      }
    }
  } catch {}

  const facts: ProfileFacts = {
    url,
    title,
    statTexts,
    bio: bio.slice(0, 600)
  };

  // Parse post/follower/following counts from profile.
  try {
    // Strategy 0: Extract from HTML-embedded JSON (IG's own data, 100% accurate).
    const htmlData = (page as any)._inkflow_profileApi;
    if (htmlData) {
      const findUser = (obj: any): any => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.edge_followed_by?.count && obj.username) return obj;
        // Recurse into common wrapper paths
        for (const k of ['user', 'graphql', 'entry_data', 'ProfilePage', 'props', 'data']) {
          if (obj[k]) {
            const found = findUser(obj[k]);
            if (found) return found;
          }
        }
        // Scan first-level array values
        for (const v of Object.values(obj)) {
          if (Array.isArray(v)) {
            for (const item of v) {
              const found = findUser(item);
              if (found) return found;
            }
          }
        }
        return null;
      };
      const user = findUser(htmlData);
      if (user) {
        facts.followers = user.edge_followed_by?.count || user.follower_count || 0;
        facts.following = user.edge_follow?.count || user.following_count || 0;
        facts.postCount = user.edge_owner_to_timeline_media?.count || user.media_count || 0;
        facts.igUserId = String(user.id || user.pk || '');
        (facts as any)._apiSource = 'html_json';
        logBehavior('profile_html_json', { handle: profileHandleFromUrl(page.url()), followers: facts.followers, following: facts.following, postCount: facts.postCount });
      }
    }

    // Strategy 1: DOM locators as fallback (if API interception missed).
    if (!facts.followers || !facts.following) {
      try {
        const followerLoc = page.locator('a[href*="/followers/"]').first();
        const followingLoc = page.locator('a[href*="/following/"]').first();
        if (!facts.followers) {
          const ft = (await followerLoc.innerText({ timeout: 3000 }).catch(() => '')).trim();
          if (ft) facts.followers = parseCompactNumber(ft);
        }
        if (!facts.following) {
          const gt = (await followingLoc.innerText({ timeout: 3000 }).catch(() => '')).trim();
          if (gt) facts.following = parseCompactNumber(gt);
        }
      } catch {}
    }

    // Strategy 2: parse statTexts from header <li> elements.
    for (const t of statTexts) {
      if (!facts.postCount) {
        const m = t.match(/([\d,.]+\s*[kKmM万]?)\s*(?:posts|post|publicaciones|beiträge|帖\s*子|發\s*佈|条|帖)/i);
        if (m) facts.postCount = parseCompactNumber(m[1]);
      }
      if (!facts.followers) {
        const m = t.match(/([\d,.]+\s*[kKmM万]?)\s*(?:followers|follower|seguidores|粉\s*丝|粉\s*絲|位|fans|abonnenten|粉)/i);
        if (m) facts.followers = parseCompactNumber(m[1]);
      }
      if (!facts.following) {
        const m = t.match(/([\d,.]+\s*[kKmM万]?)\s*(?:following|seguidos|关\s*注|追\s*蹤|追\s*踪|abonniert|关)/i);
        if (m) facts.following = parseCompactNumber(m[1]);
      }
    }

  } catch {}

  // Profile category label signal (e.g. "Tattoo & Piercing Shop")
  let categoryLabel = '';
  try {
    const candidates = [
      'header section div[role="button"] span',
      'header section span',
      'header section h2'
    ];
    for (const sel of candidates) {
      const loc = page.locator(sel);
      const c = Math.min(await loc.count(), 12);
      for (let i = 0; i < c; i++) {
        const t = (await loc.nth(i).innerText().catch(() => '')).trim();
        if (!t) continue;
        const lower = t.toLowerCase();
        if (lower.includes('shop') || lower.includes('studio') || lower.includes('tattoo') || lower.includes('piercing')) {
          categoryLabel = t;
          break;
        }
      }
      if (categoryLabel) break;
    }
  } catch {}
  facts.categoryLabel = categoryLabel;

  // External URL from profile.
  try {
    const href = (await page.locator('header a[href^="http"]').first().getAttribute('href').catch(() => '')) || '';
    if (href && /^https?:\/\//i.test(href)) facts.externalUrl = href.trim();
  } catch {}

  // Optional address/location line from profile text.
  try {
    const text = normalizeForMatch(`${facts.bio} ${facts.categoryLabel || ''}`);
    const addrMatch = String(text).match(/\b\d{2,6}\s+[^,]{2,40},?\s+[a-z\s]{2,30}\b/i);
    if (addrMatch?.[0]) facts.profileAddress = addrMatch[0].slice(0, 120);
  } catch {}

  // Non-alt text signal: open first post and capture short caption/hashtags.
  let sampleCaption = '';
  try {
    const firstMedia = page.locator('article a[href*="/p/"], article a[href*="/reel/"]').first();
    if (await firstMedia.count()) {
      await humanMouseMove();
      await firstMedia.click({ timeout: 7000 });
      await page.waitForTimeout(jitter(1200, 2400));
      const captionLoc = page.locator('article ul li span, div[role="dialog"] ul li span');
      const cc = Math.min(await captionLoc.count(), 6);
      const chunks: string[] = [];
      for (let i = 0; i < cc; i++) {
        const t = (await captionLoc.nth(i).innerText().catch(() => '')).trim();
        if (t) chunks.push(t);
      }
      sampleCaption = chunks.join(' ').slice(0, 360);
      const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="关闭"]').first();
      if ((await closeBtn.count()) > 0) await closeBtn.click({ timeout: 4000 });
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(jitter(700, 1400));
    }
  } catch {}
  facts.sampleCaption = sampleCaption;

  // Email signal from profile text and sample caption.
  const emailSource = `${title}\n${bio}\n${categoryLabel}\n${sampleCaption}`;
  const emailMatches = Array.from(new Set((emailSource.match(EMAIL_REGEX) || []).map((x) => x.trim().toLowerCase())));
  if (emailMatches.length > 0) {
    facts.emails = emailMatches.slice(0, 5);
    facts.email = facts.emails[0];
  }

  // Lightweight image signal: Instagram often exposes semantic hints in img alt text.
  let imageAltHints: string[] = [];
  try {
    const imgLocator = page.locator('article img[alt], main img[alt]');
    const count = Math.min(await imgLocator.count(), 8);
    const alts: string[] = [];
    for (let i = 0; i < count; i++) {
      const alt = (await imgLocator.nth(i).getAttribute('alt').catch(() => '') || '').trim();
      if (alt) alts.push(alt.slice(0, 160));
    }
    imageAltHints = alts;
  } catch {}
  facts.imageAltHints = imageAltHints;

  const textBlob = normalizeForMatch(`${facts.title} ${facts.bio} ${facts.categoryLabel || ''} ${facts.sampleCaption || ''} ${(facts.statTexts || []).join(' ')}`);
  const imageBlob = normalizeForMatch(imageAltHints.join(' '));
  const handleBlob = normalizeForMatch(url);
  const textPositiveHits = keywordHits(textBlob, POSITIVE_KEYWORDS);
  const textNegativeHits = keywordHits(textBlob, NEGATIVE_KEYWORDS);
  const imagePositiveHits = keywordHits(imageBlob, POSITIVE_KEYWORDS);
  const imageNegativeHits = keywordHits(imageBlob, NEGATIVE_KEYWORDS);

  // Handle-based detection: catch "visionexpress", "opticaleyes", "hairbysara" etc.
  const handlePositiveHits = keywordHits(handleBlob, POSITIVE_KEYWORDS);
  const handleNegativeHits = keywordHits(handleBlob, NEGATIVE_KEYWORDS);
  const allNegativeHits = [...new Set([...textNegativeHits, ...imageNegativeHits, ...handleNegativeHits])];
  const allPositiveHits = [...new Set([...textPositiveHits, ...imagePositiveHits, ...handlePositiveHits])];

  facts.categorySignals = {
    textPositiveHits, textNegativeHits,
    imagePositiveHits, imageNegativeHits,
    handlePositiveHits, handleNegativeHits
  };

  const positiveScore = allPositiveHits.length;
  const negativeScore = allNegativeHits.length;
  const strongNegative = negativeScore >= 2;
  const handleLooksTattoo = /\b(tattoo|ink|irezumi|piercing|needle)\b/.test(handleBlob);
  // Flag non-tattoo if: handle has clear negative signal (e.g. "vision", "optical")
  // OR text has strong negative signals with no positives
  facts.nonTattooSuspect =
    (handleNegativeHits.length > 0 && positiveScore === 0) ||  // handle says "vision", "hair", etc. with no positive counter
    (negativeScore >= 2 && positiveScore === 0 && !handleLooksTattoo);

  logBehavior('profile_facts', {
    statTexts: facts?.statTexts || [],
    postCount: Number(facts?.postCount || 0),
    followers: Number(facts?.followers || 0),
    following: Number(facts?.following || 0),
    categoryLabel: facts.categoryLabel || '',
    externalUrl: facts.externalUrl || '',
    _dbgBodyTop: (facts as any)._dbgBodyTop || '',
    _dbgBodyHtml: (facts as any)._dbgBodyHtml || '',
    _dbgAnchor: (facts as any)._dbgAnchor || {},
    _dbgGlobalAnchors: (facts as any)._dbgGlobalAnchors || {},
    profileAddress: facts.profileAddress || '',
    email: facts.email || '',
    textPositiveHits,
    textNegativeHits,
    imagePositiveHits,
    imageNegativeHits,
    handleLooksTattoo,
    strongNegative
  });
  return facts;
};

const getPrimaryStyle = (facts?: ProfileFacts) => {
  const text = normalizeForMatch(`${facts?.bio || ''} ${facts?.sampleCaption || ''} ${facts?.categoryLabel || ''}`);
  for (const style of STYLE_KEYWORDS) {
    if (text.includes(style)) return style;
  }
  return '';
};

const toAgeDays = (iso?: string) => {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
};

const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const pruneRecentCommentHashes = () => {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  likeState.comments!.recentText = (likeState.comments!.recentText || []).filter((x) => x.ts >= cutoff);
};

const shouldTryComment = (handle: string, likeSummary?: LikeActionSummary) => {
  if (!BOT_COMMENT_ENABLED) return { ok: false, reason: 'comment_disabled' };

  // No more "like first" or "first touch window" — comment when a good post is found.
  // Chance roll keeps volume human-scale.
  if (Math.random() > BOT_COMMENT_CHANCE) return { ok: false, reason: 'comment_chance_skip' };

  const key = todayKey();
  const byDay = likeState.comments!.byDay || {};
  const dayCount = Number(byDay[key] || 0);
  if (dayCount >= BOT_COMMENT_DAILY_MAX) return { ok: false, reason: 'comment_daily_limit' };
  const h = likeState.comments!.byHandle?.[handle];
  if (h?.lastCommentAt) {
    const nextAt = h.lastCommentAt + BOT_COMMENT_HANDLE_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (Date.now() < nextAt) return { ok: false, reason: 'comment_handle_cooldown' };
  }
  return { ok: true };
};

const getFollowDayCap = (command?: CommandPayload) => {
  const key = todayKey();
  const stage = String(command?.accountStage || '').toLowerCase();

  // 根据账号阶段调整日上限
  let minCap = BOT_FOLLOW_DAILY_MIN;
  let maxCap = BOT_FOLLOW_DAILY_MAX;
  if (stage === 'new') { minCap = 0; maxCap = 0; }               // D1-D2: 禁止关注
  else if (stage === 'transition') { minCap = 0; maxCap = 1; }    // D3-D4: 最多1次/天
  // stable: 正常配额 (2-6)

  if (!likeState.follows!.dayCap || likeState.follows!.dayCap.key !== key) {
    likeState.follows!.dayCap = { key, cap: minCap === maxCap ? minCap : randInt(minCap, maxCap) };
    saveLikeState(likeState);
  }
  return likeState.follows!.dayCap.cap;
};

const BOT_FOLLOW_MIN_LEAD_SCORE = Math.max(30, Number(process.env.BOT_FOLLOW_MIN_LEAD_SCORE || 50));
const BOT_FOLLOW_MIN_POSTS = Math.max(6, Number(process.env.BOT_FOLLOW_MIN_POSTS || 9));
const BOT_FOLLOW_POST_COOLDOWN_HOURS = Math.max(12, Number(process.env.BOT_FOLLOW_POST_COOLDOWN_HOURS || 48));

const shouldTryFollow = (handle: string, likeSummary: LikeActionSummary, command?: CommandPayload, facts?: ProfileFacts) => {
  // [1] 总开关
  if (!BOT_FOLLOW_ENABLED) return { ok: false, reason: 'follow_disabled' };

  // [2] 仅高优先级
  const priority = String(command?.followPriority || '').toLowerCase();
  if (priority && priority !== 'high') return { ok: false, reason: `follow_priority_${priority}` };

  // [3] 触达次数（至少访问过N次）
  const touchCount = likeState.touches?.[handle] || 0;
  if (touchCount < BOT_FOLLOW_MIN_TOUCHES) return { ok: false, reason: `follow_need_more_touches_${touchCount}_lt_${BOT_FOLLOW_MIN_TOUCHES}` };

  // [4] 本站已点赞
  if ((likeSummary.liked || 0) <= 0) return { ok: false, reason: 'follow_need_like_first' };

  // [5] 未关注过（不去重）
  if (likeState.follows!.byHandle?.[handle]?.followedAt) return { ok: false, reason: 'already_followed' };

  // [6] 日上限
  const dayKey = todayKey();
  const current = Number(likeState.follows!.byDay?.[dayKey] || 0);
  const cap = getFollowDayCap(command);
  if (cap <= 0) {
    // 新号阶段禁止
    return { ok: false, reason: `follow_stage_blocked_${String(command?.accountStage || '')}` };
  }
  if (current >= cap) return { ok: false, reason: `follow_daily_cap_${current}_of_${cap}` };

  // [7] 账号阶段（已在 getFollowDayCap 中通过 cap=0 实现）
  // 不再单独判断，统一由日上限控制

  // [8] leadScore 阈值
  const leadScore = Number(command?.leadScore || 0);
  if (leadScore < BOT_FOLLOW_MIN_LEAD_SCORE) return { ok: false, reason: `follow_lead_score_${leadScore}_lt_${BOT_FOLLOW_MIN_LEAD_SCORE}` };

  // [9] 内容质量：帖子数 >= N（排除空号/废弃号）
  const postCount = Number(facts?.postCount || 0);
  if (postCount < BOT_FOLLOW_MIN_POSTS) return { ok: false, reason: `follow_low_content_${postCount}_posts_lt_${BOT_FOLLOW_MIN_POSTS}` };

  // [10] 非纹身排除
  if (facts?.nonTattooSuspect) return { ok: false, reason: 'follow_non_tattoo' };

  // [11] 必须有 followers 数据（确认 IG 账号有效）
  const followerCount = Number(facts?.followers || 0);
  if (followerCount <= 0) return { ok: false, reason: 'follow_no_follower_data' };

  // [13] 关注后冷却：刚关注完 48h 不在该号互动（避免 look-back pattern）
  const lastFollowedAt = likeState.follows!.byHandle?.[handle]?.followedAt;
  if (lastFollowedAt) {
    const hoursSinceFollow = (Date.now() - lastFollowedAt) / (60 * 60 * 1000);
    if (hoursSinceFollow < BOT_FOLLOW_POST_COOLDOWN_HOURS) return { ok: false, reason: `follow_cooldown_${Math.round(hoursSinceFollow)}h_lt_${BOT_FOLLOW_POST_COOLDOWN_HOURS}h` };
  }

  return { ok: true };
};

const tryFollowOnProfile = async (handle: string, likeSummary: LikeActionSummary, command?: CommandPayload): Promise<FollowActionSummary> => {
  if (!page) return { attempted: 0, followed: 0, skipped: true, reason: 'no_page' };
  const gate = shouldTryFollow(handle, likeSummary, command);
  if (!gate.ok) return { attempted: 0, followed: 0, skipped: true, reason: gate.reason };

  // Make sure we're at profile top before finding follow button.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(jitter(1000, 2200));

  const followBtn = page.locator('button').filter({ hasText: /^Follow$/i }).first();
  if ((await followBtn.count()) === 0) {
    return { attempted: 1, followed: 0, skipped: true, reason: 'follow_button_not_found' };
  }
  await followBtn.click({ timeout: 6000 });
  await page.waitForTimeout(jitter(1200, 2400));

  const dayKey = todayKey();
  likeState.follows!.byDay![dayKey] = Number(likeState.follows!.byDay![dayKey] || 0) + 1;
  likeState.follows!.byHandle![handle] = { followedAt: Date.now() };
  saveLikeState(likeState);
  logBehavior('follow_done', { handle, dayCount: likeState.follows!.byDay![dayKey], dayCap: getFollowDayCap() });
  return { attempted: 1, followed: 1, skipped: false };
};

const buildCommentText = async (facts?: ProfileFacts, postMeta?: any): Promise<string> => {
  // 品牌口吻评论（DeepSeek 实时生成）
  const commentStyle = postMeta?.postStyle
    || getPrimaryStyle(facts)
    || '';
  const styleConf = postMeta?.styleConfidence || 'low';

  try {
    const result = await Promise.race([
      generateSupplyComment({
        artistHandle: facts?.title?.replace(/[\(\)@]/g, '').trim(),
        postCaption: facts?.sampleCaption?.slice(0, 300) || postMeta?.caption?.slice(0, 300),
        postCategory: commentStyle,
      }),
      new Promise<{ text: string }>((_, reject) =>
        setTimeout(() => reject(new Error('comment_gen_timeout')), 8000)
      ),
    ]);
    return result.text;
  } catch {
    // Fallback: 模板库（按风格分层，保证不阻塞）
    const fallbacks = {
      professional: [
        'Love the shading on this piece.',
        'Clean linework, really nice result.',
        'The composition here is on point.',
        'Such solid work, great execution.',
        'Incredible detail on this one.',
        'The contrast in this is beautiful.',
        'Really like the depth here.',
        'Super clean. Great placement too.',
        'The blackwork here is super tight.',
        'Great saturation throughout.',
        'Really consistent line weight here.',
        'Those gradients are blended beautifully.',
      ],
      casual: [
        'This is so clean!',
        'Wow, this turned out amazing.',
        'Straight fire as always.',
        'This is really well done.',
        'Such a cool piece.',
        'Love how this came together.',
        'This is beautiful work.',
        'Absolutely love this style.',
        'So good! The tones are perfect.',
        'This hits different, really nice.',
      ],
      question: [
        'Love this! How long did this session take?',
        'The detail here is insane. What needle config did you use?',
        'Beautiful work. Is this healed or fresh in the photo?',
        'This is so clean. Do you design these yourself?',
        'Love the tones. What ink brand do you prefer for this style?',
      ],
      detail_focused: [
        'Those fine lines in the background are so precise.',
        'The stipple shading here is perfectly executed.',
        'That color packing is seriously impressive.',
        'Really love how you handled the negative space.',
        'The texture work in the hair/fur is next level.',
        'That whip shading gradient is super smooth.',
        'The dot work detail is crazy good on this.',
        'Crisp outlines and perfect fill, this is solid.',
      ],
      short_praise: [
        'So clean!',
        'Beautiful work!',
        'Love this!',
        'Amazing piece!',
        'Incredible detail!',
        'Super clean!',
        'Fire!',
        'Really nice!',
      ],
    };
    // Flatten all categories and pick one
    const allFallbacks = Object.values(fallbacks).flat();
    return allFallbacks[randInt(0, allFallbacks.length - 1)];
  }
};

const tryPostCommentOnOpenModal = async (text: string) => {
  if (!page) return false;
  const textarea = page.locator('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i], textarea').first();
  if ((await textarea.count()) === 0) return false;
  await textarea.click({ timeout: 4000 });
  await page.waitForTimeout(jitter(400, 1000));

  const tp = BOT_PROFILE.typing;
  const chars = text.split('');
  const useDistractedTyping = Math.random() < 0.3;

  if (!useDistractedTyping) {
    // Mode A (70%): steady typing at per-bot speed
    for (let i = 0; i < chars.length; i++) {
      // Random mid-type pause (thinking/distracted)
      if (Math.random() < tp.pauseChance) {
        await page.waitForTimeout(jitter(tp.pauseMs, 500));
      }
      // Random typo + backspace
      if (Math.random() < tp.mistakeChance) {
        const nearbyKeys = 'asdfghjklqwertyuiopzxcvbnm,.';
        const wrongChar = nearbyKeys[Math.floor(Math.random() * nearbyKeys.length)];
        await textarea.press(wrongChar);
        await page.waitForTimeout(jitter(tp.backspaceMs, 50));
        await textarea.press('Backspace');
        await page.waitForTimeout(jitter(tp.backspaceMs, 50));
      }
      await textarea.press(chars[i]);
      await page.waitForTimeout(jitter(tp.baseSpeedMs, tp.varianceMs));
      if (i > 0 && i % 12 === 0) await page.waitForTimeout(jitter(300, 900));
    }
  } else {
    // Mode B (30%): chunked typing with per-bot speed
    let i = 0;
    while (i < chars.length) {
      const chunkSize = randInt(3, 8);
      const end = Math.min(i + chunkSize, chars.length);
      for (let j = i; j < end; j++) {
        if (Math.random() < tp.pauseChance) {
          await page.waitForTimeout(jitter(tp.pauseMs, 300));
        }
        await textarea.press(chars[j]);
        await page.waitForTimeout(jitter(tp.baseSpeedMs, tp.varianceMs));
      }
      i = end;
      if (i >= chars.length) break;

      // Distraction: scroll, pause, or typo-correction
      const distraction = Math.random();
      if (distraction < 0.4) {
        await page.mouse.wheel(0, randInt(-80, 80));
        await page.waitForTimeout(jitter(600, 1500));
      } else if (distraction < 0.7) {
        await page.waitForTimeout(jitter(800, 2500));
      } else {
        for (let k = 0; k < randInt(1, 3); k++) {
          await textarea.press('Backspace');
          await page.waitForTimeout(jitter(tp.backspaceMs, 100));
        }
      }
    }
  }

  await page.waitForTimeout(jitter(500, 1500));
  await textarea.press('Enter');
  await page.waitForTimeout(jitter(1500, 3000));
  return true;
};

const tryCommentWithStrategy = async (handle: string, facts?: ProfileFacts, likeSummary?: LikeActionSummary): Promise<CommentActionSummary> => {
  if (!page) throw new Error('page_not_initialized');
  const gate = shouldTryComment(handle, likeSummary);
  if (!gate.ok) return { attempted: 0, posted: 0, skipped: true, reason: gate.reason };

  const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]');
  const total = await tiles.count();
  const candidateCount = Math.min(total, 8);
  const primaryStyle = getPrimaryStyle(facts);
  const ranked: { idx: number; score: number; meta: any }[] = [];
  for (let idx = 0; idx < candidateCount; idx++) {
    try {
      await tiles.nth(idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(600, 1400));
      await tiles.nth(idx).click({ timeout: 8000 });
      await page.waitForTimeout(jitter(900, 1800));
      const meta = await readModalMeta(primaryStyle, '', facts?.followers);
      const pinnedLikelyBoost = idx < 3 ? 3 : 0;
      const boostedScore = Number(meta.score || 0) + pinnedLikelyBoost;
      ranked.push({ idx, score: boostedScore, meta: { ...meta, pinnedLikelyBoost } });
      await closeModal();
    } catch {
      await closeModal().catch(() => {});
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  const chosen = ranked.find((r) => r.score >= 3 && (r.meta.ageDays ?? 9999) <= 60 && (r.meta.promo ?? 0) === 0);
  if (!chosen) return { attempted: 1, posted: 0, skipped: true, reason: 'no_comment_candidate' };

  const text = await buildCommentText(facts, { ...chosen.meta, caption: facts?.sampleCaption });
  pruneRecentCommentHashes();
  const textHash = hashString(normalizeForMatch(text));
  const dup = (likeState.comments!.recentText || []).some((x) => x.hash === textHash);
  if (dup) return { attempted: 1, posted: 0, skipped: true, reason: 'comment_dup' };

  // Review mode: open post, screenshot, save comment for manual review
  if (BOT_COMMENT_REVIEW_MODE) {
    try {
      await tiles.nth(chosen.idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(900, 1800));
      await tiles.nth(chosen.idx).click({ timeout: 10000 });
      await page.waitForTimeout(jitter(1200, 2600));
      const postUrl = page.url();
      const reviewId = `comment_${Date.now()}_${handle}`;
      const screenshotPath = path.join(COMMENT_REVIEW_DIR, `${reviewId}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      const metaPath = path.join(COMMENT_REVIEW_DIR, `${reviewId}.json`);
      fs.writeFileSync(metaPath, JSON.stringify({
        handle,
        postUrl,
        text,
        score: chosen.score,
        postMeta: { ...chosen.meta, caption: facts?.sampleCaption },
        profileFacts: { categoryLabel: facts?.categoryLabel, bio: facts?.bio },
        reviewed: false,
        approved: false,
        createdAt: new Date().toISOString(),
      }, null, 2));
      await closeModal();
      logBehavior('comment_review_saved', { handle, postUrl, reviewId, screenshotPath, text });
      console.log(`[bot-cloak] REVIEW: comment saved → ${reviewId}`);
      console.log(`[bot-cloak]   Handle: @${handle}`);
      console.log(`[bot-cloak]   Post: ${postUrl}`);
      console.log(`[bot-cloak]   Comment: "${text}"`);
      console.log(`[bot-cloak]   Screenshot: ${screenshotPath}`);
      return { attempted: 1, posted: 0, skipped: true, reason: 'review_mode', text, postUrl };
    } catch {
      await closeModal().catch(() => {});
      return { attempted: 1, posted: 0, skipped: true, reason: 'review_screenshot_failed' };
    }
  }

  try {
    await tiles.nth(chosen.idx).scrollIntoViewIfNeeded();
    await page.waitForTimeout(jitter(900, 1800));
    await tiles.nth(chosen.idx).click({ timeout: 10000 });
    await page.waitForTimeout(jitter(1200, 2600));
    const ok = await tryPostCommentOnOpenModal(text);
    const postUrl = page.url();
    await closeModal();
    if (!ok) return { attempted: 1, posted: 0, skipped: true, reason: 'comment_box_not_found' };

    const key = todayKey();
    likeState.comments!.byDay![key] = Number(likeState.comments!.byDay![key] || 0) + 1;
    likeState.comments!.byHandle![handle] = { lastCommentAt: Date.now() };
    likeState.comments!.recentText!.push({ ts: Date.now(), hash: textHash });
    pruneRecentCommentHashes();
    saveLikeState(likeState);
    logBehavior('comment_posted', {
      handle,
      postUrl,
      text,
      score: chosen.score,
      likeCount: Number(chosen.meta.likeCount || 0),
      commentCount: Number(chosen.meta.commentCount || 0),
      cta: Number(chosen.meta.cta || 0),
      pinnedLikelyBoost: Number(chosen.meta.pinnedLikelyBoost || 0)
    });
    return { attempted: 1, posted: 1, skipped: false, text, postUrl };
  } catch {
    await closeModal().catch(() => {});
    return { attempted: 1, posted: 0, skipped: true, reason: 'comment_post_failed' };
  }
};

const readModalMeta = async (primaryStyle: string, expectedHandle = '', followerCount = 0) => {
  if (!page) return { score: -999, reason: 'no_page' };
  const url = page.url();
  const postKey = extractPostKey(url);
  let ownerHandle = '';
  try {
    const hrefs = await page.locator('div[role="dialog"] header a[href^="/"]').evaluateAll((els) =>
      (els as HTMLAnchorElement[]).map((e) => e.getAttribute('href') || '')
    );
    for (const h of hrefs) {
      const m = String(h || '').match(/^\/([^\/\?\#]+)\/?$/);
      if (m?.[1]) {
        ownerHandle = normalizeHandle(m[1]);
        if (ownerHandle) break;
      }
    }
  } catch {}
  const expected = normalizeHandle(expectedHandle);
  const isOwnerPost = expected ? ownerHandle === expected : true;
  const caption = (await page.locator('article ul li span, div[role="dialog"] ul li span').allInnerTexts().catch(() => [] as string[]))
    .join(' ')
    .slice(0, 1200);
  const altHints = (await page.locator('div[role="dialog"] img[alt], article img[alt]').all()
    .then(async (els) => Promise.all(els.slice(0, 4).map(async (el) => ((await el.getAttribute('alt')) || '').slice(0, 200))))
    .catch(() => [] as string[]))
    .join(' ');
  const dt = await page.locator('time').first().getAttribute('datetime').catch(() => null);
  const rawDialogText = (await page.locator('div[role="dialog"]').first().innerText().catch(() => '')) || '';
  const dialogText = normalizeForMatch(rawDialogText);

  // Like + Comment count extraction.
  // IG 2026 UI: dialog textContent concatenates "Save221 likes" without spaces.
  // The counts ARE present in individual <span> elements. Extract from spans.
  const countExtract = await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return { likeCount: 0, commentCount: 0, debugInfo: 'no_dialog' };

    const parseCount = (raw: string) => {
      const cleaned = raw.replace(/,/g, '').trim().toLowerCase();
      if (!cleaned) return 0;
      if (cleaned.endsWith('k')) return Math.round(parseFloat(cleaned) * 1000);
      if (cleaned.endsWith('m')) return Math.round(parseFloat(cleaned) * 1000000);
      return parseInt(cleaned, 10) || 0;
    };

    let likeCount = 0;
    let commentCount = 0;

    // Strategy 1: Scan spans for "N likes" (preferred), fall back to "N others"
    const spans = dialog.querySelectorAll('span');
    // Pass 1: prefer "likes" — IG puts "115 likes" in its own span
    for (const span of spans) {
      const txt = (span.textContent || '').trim();
      if (!txt) continue;
      const m = txt.match(/^([\d,\.]+[kKmM]?)\s*likes?$/i);
      if (m) { likeCount = parseCount(m[1]); break; }
    }
    // Pass 2: fall back to "N others" only if no "likes" span found
    if (likeCount === 0) {
      for (const span of spans) {
        const txt = (span.textContent || '').trim();
        if (!txt) continue;
        const m = txt.match(/^([\d,\.]+[kKmM]?)\s*others?$/i);
        if (m) { likeCount = parseCount(m[1]); break; }
      }
    }

    // Strategy 2: liked_by link text (fallback)
    if (likeCount === 0) {
      const likeLink = dialog.querySelector('a[href*="/liked_by/"]');
      if (likeLink) {
        const linkText = (likeLink.textContent || '').replace(/\s+/g, ' ').trim();
        const m = linkText.match(/([\d,\.]+[kKmM]?)/);
        if (m) likeCount = parseCount(m[1]);
      }
    }

    // Strategy 3: Full dialog text for "and N others" pattern (fallback)
    if (likeCount === 0) {
      const text = (dialog.textContent || '').replace(/\s+/g, ' ').toLowerCase();
      const m = text.match(/and\s+([\d,\.]+[kKmM]?)\s+others?/);
      if (m) likeCount = parseCount(m[1]);
    }

    // Comment count: search spans for "N comments" text
    for (const span of spans) {
      const txt = (span.textContent || '').trim();
      if (!txt) continue;
      const m = txt.match(/(?:view\s+(?:all\s+)?)?([\d,\.]+[kKmM]?)\s*comments?/i);
      if (m) { commentCount = parseCount(m[1]); break; }
    }

    // Comment count fallback: search buttons/links mentioning replies or comments
    if (commentCount === 0) {
      const candidates = dialog.querySelectorAll('a, button, [role="button"]');
      for (const el of candidates) {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!txt) continue;
        // "View replies (1)", "View all 23 comments", "23 comments"
        if (/repl(?:y|ies)|comments?/i.test(txt)) {
          const m = txt.match(/([\d,\.]+[kKmM]?)/);
          if (m) { commentCount = parseCount(m[1]); break; }
        }
      }
    }

    const debugSample = (dialog.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { likeCount, commentCount, debugSample, dialogLen: (dialog.textContent || '').length };
  });

  const likeCount = countExtract.likeCount;
  const commentCount = countExtract.commentCount;

  // Debug: deep DOM scan when counts are 0 — find ALL like/comment elements
  if (likeCount === 0 || commentCount === 0) {
    const deepScan = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return { allLinks: 'no_dialog' };
      // Find all links in the dialog
      const links = Array.from(dialog.querySelectorAll('a')).map(a => ({
        href: a.getAttribute('href') || '',
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        aria: (a.getAttribute('aria-label') || '').slice(0, 80),
      })).filter(l => l.text || l.aria);
      // Find all buttons
      const buttons = Array.from(dialog.querySelectorAll('button')).map(b => ({
        aria: (b.getAttribute('aria-label') || '').slice(0, 100),
        text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        type: b.getAttribute('type') || '',
      })).filter(b => b.aria || b.text);
      // Find ALL spans with numbers
      const spans = Array.from(dialog.querySelectorAll('span')).map(s => s.textContent?.trim() || '').filter(t => /\d/.test(t)).slice(0, 15);
      return { links: links.slice(0, 10), buttons: buttons.slice(0, 10), spans };
    });
    logBehavior('count_extract_debug', {
      likeCount, commentCount,
      sample: countExtract.debugSample,
      dialogLen: countExtract.dialogLen,
      links: deepScan.links,
      buttons: deepScan.buttons,
      spans: deepScan.spans,
    });
  }
  const ageDays = toAgeDays(dt || undefined);
  const blob = normalizeForMatch(`${caption} ${altHints}`);
  const positive = keywordHits(blob, POSITIVE_KEYWORDS).length;
  const promo = keywordHits(blob, PROMO_KEYWORDS).length;
  const cta = keywordHits(blob, BUSINESS_CTA_KEYWORDS).length;

  // Style detection from THIS post (not profile): alt text is IG's own AI description.
  // alt-confirmed = caption + alt BOTH mention the style → high confidence.
  const captionStyles = keywordHits(normalizeForMatch(caption), STYLE_KEYWORDS);
  const altStyles = keywordHits(normalizeForMatch(altHints), STYLE_KEYWORDS);
  const altConfirmedStyles = captionStyles.filter((s) => altStyles.includes(s));
  const postStyle = altConfirmedStyles[0] || captionStyles[0] || altStyles[0] || '';
  const styleConfidence = altConfirmedStyles.length > 0 ? 'high' :
    (captionStyles.length > 0 && altStyles.length > 0) ? 'medium' : 'low';

  const styleBoost = postStyle ? (styleConfidence === 'high' ? 3 : styleConfidence === 'medium' ? 2 : 1) : 0;
  const isReel = /\/reel\//i.test(url);
  let score = 0;
  if (ageDays <= BOT_PREFER_RECENT_DAYS) score += 4;
  else if (ageDays <= BOT_SKIP_OLD_POST_DAYS) score += 2;
  else score -= 8;
  score += positive * 2;
  score += styleBoost * 2;
  score += cta * 2;
  // Engagement-aware like scoring: absolute count OR engagement rate
  const engagementRate = followerCount > 0 ? likeCount / followerCount : 0;
  if (followerCount > 0 && engagementRate > 0) {
    // Relative: high-engagement posts for this account size
    if (engagementRate >= 0.15) score += 4;
    else if (engagementRate >= 0.07) score += 3;
    else if (engagementRate >= 0.03) score += 2;
    else score += 1;
  } else {
    // Fallback to absolute thresholds when followerCount unknown
    if (likeCount >= 500) score += 3;
    else if (likeCount >= 150) score += 2;
    else if (likeCount >= 60) score += 1;
  }
  if (commentCount >= 20) score += 2;
  else if (commentCount >= 8) score += 1;
  score -= promo * 5;
  if (isReel) score -= 2;
  // Post-type scoring: prefer content posts, deprioritize ads/booking
  const postType = detectPostType(caption, altHints ? [altHints] : []);
  if (postType === 'healed') score += 2;
  else if (postType === 'before_after') score += 2;
  else if (postType === 'wip') score += 1;
  else if (postType === 'booking') score -= 3;
  else if (postType === 'flash') score -= 4;
  return { url, postKey, ownerHandle, isOwnerPost, dt, ageDays, score, positive, promo, cta, styleBoost, isReel, likeCount, commentCount, postType, postStyle, styleConfidence };
};

const closeModal = async () => {
  if (!page) return;
  const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="关闭"]').first();
  if ((await closeBtn.count()) > 0) {
    await closeBtn.click({ timeout: 5000 }).catch(async () => page?.keyboard.press('Escape'));
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(jitter(600, 1400));
};

const getDayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

const getLikePolicy = (command?: CommandPayload) => {
  const wp = command?.protocol?.warmupPolicy || {};
  const perVisitMin = Math.max(0, Math.min(5, Number(wp.likePerVisitMin || BOT_LIKE_MIN_PER_VISIT)));
  const perVisitMax = Math.max(perVisitMin, Math.min(8, Number(wp.likePerVisitMax || BOT_LIKE_MAX_PER_VISIT)));
  const gapMin = Math.max(10, Number(wp.likeGapSecMin || BOT_LIKE_INTERVAL_MIN_SEC));
  const gapMax = Math.max(gapMin, Number(wp.likeGapSecMax || BOT_LIKE_INTERVAL_MAX_SEC));
  const cooldownMin = Math.max(4, Number(wp.revisitCooldownHoursMin || BOT_LIKE_COOLDOWN_MIN_HOURS));
  const cooldownMax = Math.max(cooldownMin, Number(wp.revisitCooldownHoursMax || BOT_LIKE_COOLDOWN_MAX_HOURS));
  const dailyMin = Math.max(1, Number(wp.dailyLikeMin || 6));
  const dailyMax = Math.max(dailyMin, Number(wp.dailyLikeMax || 20));
  const likeRatio = Math.max(0, Math.min(1, Number(wp.likeRatio || 0.2)));
  return {
    perVisitMin,
    perVisitMax,
    gapMin,
    gapMax,
    cooldownMin,
    cooldownMax,
    dailyMin,
    dailyMax,
    likeRatio
  };
};

const getSingleHandleLikeCap = (command?: CommandPayload) => {
  const ageDays = Number(command?.accountAgeDays || 0);
  const stage = String(command?.accountStage || '').toLowerCase();
  if ((Number.isFinite(ageDays) && ageDays > 0 && ageDays < 30) || stage === 'new' || stage === 'transition') return 1;
  return 2;
};

const getDefaultDailyBrowseTarget = (command?: CommandPayload) => {
  const stage = String(command?.accountStage || '').toLowerCase();
  if (stage === 'new') return BOT_DAILY_BROWSE_TARGET_NEW;
  if (stage === 'transition') return BOT_DAILY_BROWSE_TARGET_TRANSITION;
  return BOT_DAILY_BROWSE_TARGET_STABLE;
};

const getDailyLikeCap = (command?: CommandPayload) => {
  const policy = getLikePolicy(command);
  const wp = command?.protocol?.warmupPolicy || {};
  const dayKey = getDayKey();
  const capState = likeState.likes!.dayCap;
  if (!capState || capState.key !== dayKey) {
    const configuredDailyBrowseTarget = Math.max(1, Number(wp.dailyBrowseTarget || 0)) || getDefaultDailyBrowseTarget(command);
    const touchedToday = Number(likeState.touchesByDay?.[dayKey] || 0);
    const expectedBrowse = Math.max(configuredDailyBrowseTarget, touchedToday);
    const dynamicByRatio = Math.round(expectedBrowse * policy.likeRatio);
    const baseCap = Math.max(policy.dailyMin, Math.min(policy.dailyMax, dynamicByRatio));
    const jitteredCap = Math.max(policy.dailyMin, Math.min(policy.dailyMax, baseCap + randInt(-1, 1)));
    likeState.likes!.dayCap = { key: dayKey, cap: jitteredCap };
    saveLikeState(likeState);
  }
  return Number(likeState.likes!.dayCap!.cap || policy.dailyMax);
};

const tryLikeWithStrategy = async (handle: string, facts?: ProfileFacts, command?: CommandPayload): Promise<LikeActionSummary> => {
  if (!page) throw new Error('page_not_initialized');
  const policy = getLikePolicy(command);
  const dayKey = getDayKey();
  const dayCount = Number(likeState.likes?.byDay?.[dayKey] || 0);
  const dayCap = getDailyLikeCap(command);
  if (dayCount >= dayCap) {
    logBehavior('like_skip_daily_limit', { handle, dayKey, dayCount, dayCap });
    return { attempted: 0, liked: 0, skippedCooldown: true, likedUrls: [] };
  }

  const state = likeState.byHandle[handle] || {};
  if (state.nextEligibleAt && Date.now() < state.nextEligibleAt) {
    logBehavior('like_skip_cooldown', { handle, nextEligibleAt: state.nextEligibleAt });
    return { attempted: 0, liked: 0, skippedCooldown: true, likedUrls: [] };
  }

  const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]');
  const total = await tiles.count();
  const candidateCount = Math.min(total, 12);
  const candidates: { idx: number; score: number; meta: any }[] = [];
  const primaryStyle = getPrimaryStyle(facts);
  for (let idx = 0; idx < candidateCount; idx++) {
    try {
      await tiles.nth(idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(700, 1600));
      await tiles.nth(idx).click({ timeout: 10000 });
      await page.waitForTimeout(jitter(1000, 2200));
      const meta = await readModalMeta(primaryStyle, '', facts?.followers);
      // "主推帖"加权：优先前3个（常见置顶区）+ 互动高 + 有业务CTA
      const pinnedLikelyBoost = idx < 3 ? 3 : 0;
      const boostedScore = Number(meta.score || 0) + pinnedLikelyBoost;
      candidates.push({ idx, score: boostedScore, meta: { ...meta, pinnedLikelyBoost } });
      await closeModal();
    } catch {
      await closeModal().catch(() => {});
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const desiredLikes = randInt(policy.perVisitMin, policy.perVisitMax);
  const singleHandleCap = getSingleHandleLikeCap(command);
  const remainingDayQuota = Math.max(0, dayCap - dayCount);
  const maxLikes = Math.min(desiredLikes, candidates.length, remainingDayQuota, singleHandleCap);
  let liked = 0;
  const likedUrls: string[] = [];
  logBehavior('like_policy_applied', {
    handle,
    desiredLikes,
    maxLikes,
    singleHandleCap,
    dayCount,
    dayCap,
    accountAgeDays: Number(command?.accountAgeDays || 0) || null,
    accountStage: String(command?.accountStage || '') || null
  });

  for (const c of candidates) {
    if (liked >= maxLikes) break;
    if (c.score < 1) continue;
    try {
      await tiles.nth(c.idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(900, 2000));
      await tiles.nth(c.idx).click({ timeout: 10000 });
      await page.waitForTimeout(jitter(1200, 2400));
      // Multi-strategy like button (IG renders different DOM per browser/viewport)
      let likedThis = false;
      for (const sel of [
        'svg[aria-label="Like"]',
        'svg[aria-label="Like" i]',
        'div[role="button"] svg[aria-label="Like"]',
        'span svg[aria-label="Like"]',
      ]) {
        try {
          const b = page.locator(sel).first();
          if ((await b.count()) > 0) { await b.click({ timeout: 5000 }); likedThis = true; break; }
        } catch {}
      }
      if (!likedThis) {
        try {
          const btn = page.locator('div[role="button"]').filter({ has: page.locator('svg') }).first();
          if ((await btn.count()) > 0) { await btn.click({ timeout: 5000 }); likedThis = true; }
        } catch {}
      }
      if (!likedThis) {
        try {
          const sectionBtn = page.locator('section').locator('svg[aria-label*="Like" i]').first();
          if ((await sectionBtn.count()) > 0) { await sectionBtn.click({ timeout: 5000 }); likedThis = true; }
        } catch {}
      }
      if (likedThis) {
        liked += 1;
        likedUrls.push(page.url());
        logBehavior('like_post', {
          handle,
          idx: c.idx,
          score: c.score,
          url: page.url(),
          ageDays: Math.floor(c.meta.ageDays || 0),
          likeCount: Number(c.meta.likeCount || 0),
          commentCount: Number(c.meta.commentCount || 0),
          cta: Number(c.meta.cta || 0),
          pinnedLikelyBoost: Number(c.meta.pinnedLikelyBoost || 0)
        });
      } else {
        logBehavior('like_miss', { handle, idx: c.idx, url: page.url() });
      }
      await page.waitForTimeout(jitter(1200, 2600));
      await closeModal();
      if (liked < maxLikes) {
        const gapSec = randInt(policy.gapMin, policy.gapMax);
        logBehavior('like_gap_wait', { handle, gapSec });
        await sleep(gapSec * 1000);
      }
    } catch {
      await closeModal().catch(() => {});
    }
  }

  const cooldownHours = randInt(Math.floor(policy.cooldownMin), Math.floor(policy.cooldownMax));
  likeState.byHandle[handle] = {
    lastLikedAt: Date.now(),
    nextEligibleAt: Date.now() + cooldownHours * 60 * 60 * 1000
  };
  likeState.likes!.byDay![dayKey] = dayCount + liked;
  saveLikeState(likeState);
  logBehavior('like_session_done', {
    handle,
    liked,
    attempted: maxLikes,
    cooldownHours,
    dayCountAfter: Number(likeState.likes!.byDay![dayKey] || 0),
    dayCap
  });
  return { attempted: maxLikes, liked, skippedCooldown: false, likedUrls };
};

// ============ Comment Scraping for Supply Accounts ============

const DEEPSEEK_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const POSTS_TO_ANALYZE = 5;

type ScrapedComment = {
  username: string;
  text: string;
  likes: number;
};

const scrapePostComments = async (): Promise<ScrapedComment[]> => {
  if (!page) return [];
  const comments: ScrapedComment[] = [];
  try {
    // Try to expand comments section
    const viewAllBtn = page.locator('button:has-text("View all"), span:has-text("View all")').first();
    if (await viewAllBtn.count()) {
      await viewAllBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(jitter(1500, 3000));
    }
    // Scroll comments area to load more
    const commentItems = page.locator('ul[class*="x78zum5"] li, div[role="dialog"] ul li');
    const count = Math.min(await commentItems.count(), 20);
    const seen = new Set<string>();
    for (let i = 0; i < count && comments.length < 10; i++) {
      try {
        const el = commentItems.nth(i);
        const text = (await el.innerText().catch(() => '')).trim();
        if (!text || text.length < 3 || seen.has(text.slice(0, 50))) continue;
        seen.add(text.slice(0, 50));
        // Extract username from the first line (IG format: "username text...")
        const lines = text.split('\n').filter(Boolean);
        const username = lines[0]?.replace(/^@/, '').trim() || 'unknown';
        const commentText = lines.slice(1).join(' ').trim() || lines[0]?.trim() || '';
        // Extract likes from comment (e.g. "12 likes")
        const likesMatch = text.match(/(\d+)\s*likes?/i);
        const likes = likesMatch ? Number(likesMatch[1]) : 0;
        if (commentText.length >= 3) {
          comments.push({ username, text: commentText.slice(0, 500), likes });
        }
      } catch { continue; }
    }
  } catch {}
  logBehavior('comments_scraped', { count: comments.length });
  return comments;
};

const analyzeCommentsSentiment = async (comments: ScrapedComment[], brandHandle: string): Promise<any[]> => {
  if (!comments.length || !DEEPSEEK_KEY) return [];
  const commentTexts = comments.map((c, i) => `[${i}] @${c.username}: ${c.text}`).join('\n');
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'user',
          content: `You are analyzing Instagram comments on a ${brandHandle} post. ${brandHandle} is a tattoo supply brand selling products (machines, needles, ink, aftercare, etc).

For EACH comment, classify into EXACTLY ONE sentiment:

- "positive" — praise, love the product, "best ___", satisfied customer
- "neutral" — general question, @mention, emoji-only, off-topic, spam
- "negative_product" — complains about PRODUCT quality/performance/durability/design (e.g., "this machine broke after 2 weeks", "ink fades too fast", "needles are dull", "worse than Cheyenne")
- "negative_service" — complains about shipping/delivery/customer-service/stock (e.g., "took 3 weeks to arrive", "no response from support")
- "negative_pricing" — complains ONLY about price, not quality (e.g., "too expensive", "overpriced")

CRITICAL RULES:
- "negative_product" ONLY if the complaint is about the PRODUCT itself (quality, build, performance, durability, design, compatibility). NOT about shipping or service.
- A comment mentioning price AND quality ("expensive but worth it", "overpriced junk") → classify by the DOMINANT complaint. If "expensive but worth it" → positive. If "overpriced junk" → negative_product.
- If a comment mentions a specific product name or category (e.g., "Bishop wand", "cartridges", "Dynamic ink"), extract it as product_mentioned.
- Comparison to competitor ("FK Irons is better") → negative_product.

Return a flat JSON array. For EVERY comment (all ${comments.length} of them), include an entry:
[
  {
    "index": 0,
    "sentiment": "negative_product",
    "confidence": "high|medium|low",
    "product_mentioned": "Bishop Wand",
    "product_category": "machine",
    "themes": ["durability", "build_quality"],
    "summary": "Machine stopped working after 2 weeks of use, disappointed with build quality"
  },
  ...
]

Comments:\n${commentTexts}`
        }],
        temperature: 0.1, max_tokens: 2000,
      }),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    const raw = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
    try { return JSON.parse(raw); } catch { return []; }
  } catch { return []; }
};

// ============ Reddit Intel Scrape ============

const CLASSIFICATION_PROMPT = `You are a competitive intelligence analyst specializing in the tattoo supply industry. Your job is to read Reddit posts by tattoo artists and extract actionable product intelligence.

CRITICAL RULES:
1. SEMANTIC understanding only — never keyword-match. Read the post like a human tattoo artist would.
2. Artists use slang: "my pen" = tattoo machine, "spits ink" = needle/ink issue, "bogs down" = underpowered motor, "cord gets in the way" = wants wireless.
3. WISHLIST + FEATURE_REQUESTS are highest-value. Distinguish: wishlist_items = new product gap, feature_requests = specific feature missing in existing product.
4. Distinguish TECHNIQUE from PRODUCT. "How do I shade better" with no equipment = technique. "My Bishop packs color better than Dragonhawk" = product comparison.
5. Be specific in pain_points/praise_points — not "bad quality" but "motor overheats after 2 hours".
6. Extract brands even misspelled: "FK" = FK Irons, "dhawk" = Dragonhawk, "Chey" = Cheyenne.
7. Infer artist_skill_level: beginners ask about "starter kits"/"first machine", pros discuss nuanced performance.
8. Infer purchase_intent: "thinking about buying" = researching, "which one should I get" = ready_to_buy, "just got my new X" = just_bought.
9. For comparisons, comparison_verdict should state which brand won and WHY in one sentence.
10. price_sensitivity: mention of budget/"cheap"/"worth the money" = budget_conscious; "money no object" = premium_only.
11. Mark purely social/art-sharing posts as is_product_related: false.`;

const executeRedditScrape = async (command: CommandPayload) => {
  const commandId = command.id;
  const subreddit = String(command.subreddit || 'tattoo').trim();
  const postsPerSub = Number(command.postsPerSub || 10);
  console.log(`[bot-cloak] reddit_scrape ${commandId} -> r/${subreddit}`);

  ensureBrowserLegacyLaunchDisabled();
  await ensureBrowser();
  if (!page) throw new Error('browser page not available');

  const rawPosts: any[] = [];
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

  try {
    // Strategy 1: Use Reddit's JSON API (no auth needed, less likely blocked)
    const jsonUrl = `https://www.reddit.com/r/${subreddit}/new.json?limit=${Math.min(postsPerSub * 3, 75)}&raw_json=1`;
    console.log(`[bot-cloak] trying JSON API: ${jsonUrl}`);

    // Warm-up: browse to reddit homepage first to set cookies
    await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(jitter(3000, 6000));

    // Inject fetch with proper headers for JSON API access
    const jsonData = await page.evaluate(async ({ url, ua }) => {
      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': ua,
            'Accept': 'application/json',
          },
        });
        if (!resp.ok) return { error: `HTTP ${resp.status}`, data: null };
        return { error: null, data: await resp.json() };
      } catch (e: any) {
        return { error: e.message, data: null };
      }
    }, { url: jsonUrl, ua: userAgent });

    if (jsonData.error) {
      console.warn(`[bot-cloak] JSON API failed: ${jsonData.error}, falling back to browser DOM`);
      // Fallback: scrape via DOM on old.reddit.com
      const oldUrl = `https://old.reddit.com/r/${subreddit}/new/`;
      await page.goto(oldUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(jitter(3000, 5000));

      // Scroll naturally
      for (let s = 0; s < 3; s++) {
        await page.evaluate(() => window.scrollBy(0, 600 + Math.random() * 400));
        await sleep(jitter(1500, 3000));
      }

      const entries = await page.evaluate(() => {
        const items: any[] = [];
        document.querySelectorAll('#siteTable .thing, .link').forEach((row: any) => {
          const titleEl = row.querySelector('a.title, a[data-event-action="title"]');
          const title = titleEl?.textContent?.trim() || '';
          const permalink = titleEl?.getAttribute('href') || row.getAttribute('data-permalink') || '';
          const authorEl = row.querySelector('a.author, a[href*="/user/"]');
          const author = authorEl?.textContent?.trim() || '';
          const score = parseInt(row.getAttribute('data-score') || row.querySelector('.score')?.textContent || '0', 10) || 0;
          const numComments = parseInt(row.getAttribute('data-comments-count') || row.querySelector('.comments')?.textContent || '0', 10) || 0;
          const timeEl = row.querySelector('time');
          const datetime = timeEl?.getAttribute('datetime') || '';
          if (title) items.push({ title, permalink, author, score, numComments, datetime });
        });
        return items;
      });

      // Visit each post for content
      for (const entry of entries.slice(0, postsPerSub)) {
        if (!entry.permalink) continue;
        const postUrl = entry.permalink.startsWith('http') ? entry.permalink : `https://old.reddit.com${entry.permalink}`;
        try {
          await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(jitter(1500, 3000));
          const postContent = await page.evaluate(() => {
            const el = document.querySelector('.usertext-body .md, .expando .md, [data-test-id="post-content"]');
            return (el?.textContent || '').trim().slice(0, 2000);
          });
          if (entry.title || postContent) {
            rawPosts.push({
              forum: `reddit_r/${subreddit}`,
              title: entry.title,
              content: postContent,
              author: entry.author,
              date: entry.datetime || new Date().toISOString(),
              url: postUrl,
              score: entry.score,
              numComments: entry.numComments,
            });
          }
          await sleep(jitter(800, 2000));
        } catch (err: any) {
          console.warn(`[bot-cloak] reddit post fetch error: ${err.message}`);
        }
      }
    } else {
      // JSON API succeeded — extract posts from JSON
      const children = jsonData.data?.data?.children || [];
      console.log(`[bot-cloak] JSON API returned ${children.length} posts`);

      for (const child of children.slice(0, postsPerSub)) {
        const d = child.data;
        if (!d) continue;
        const selftext = (d.selftext || '').trim();
        const title = (d.title || '').trim();
        if (!title && !selftext) continue;

        rawPosts.push({
          forum: `reddit_r/${subreddit}`,
          title,
          content: selftext.slice(0, 2000),
          author: d.author || '',
          date: new Date(d.created_utc * 1000).toISOString(),
          url: `https://www.reddit.com${d.permalink || ''}`,
          score: d.score || 0,
          numComments: d.num_comments || 0,
        });
      }
    }
  } catch (err: any) {
    console.error(`[bot-cloak] reddit scrape error: ${err.message}`);
  }

  console.log(`[bot-cloak] scraped ${rawPosts.length} posts from r/${subreddit}`);

  if (rawPosts.length === 0) {
    console.log('[bot-cloak] no posts scraped, skipping classification');
    return;
  }

  // AI Classification via DeepSeek
  if (DEEPSEEK_KEY) {
    console.log(`[bot-cloak] classifying ${rawPosts.length} Reddit posts via DeepSeek...`);
    const classifications: any[] = [];

    for (let i = 0; i < rawPosts.length; i += 10) {
      const batch = rawPosts.slice(i, i + 10);
      const batchText = batch.map((p, j) =>
        `[${i + j}] Platform: ${p.forum} | Author: ${p.author} | Date: ${p.date}\nTitle: ${p.title}\nContent: ${p.content?.slice(0, 800) || ''}`
      ).join('\n---\n');

      try {
        const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: CLASSIFICATION_PROMPT },
              { role: 'user', content: `Analyze these ${batch.length} Reddit posts. Return ONLY a JSON array.\nSchema per post:\n{\n  "index": <number>,\n  "is_product_related": <boolean>,\n  "product_category": "machine" | "needle" | "ink" | "aftercare" | "power_supply" | "other_accessory" | "none",\n  "discussion_type": "review" | "problem" | "comparison" | "recommendation" | "wishlist" | "technique" | "off_topic",\n  "mentioned_brands": <string[]>,\n  "mentioned_products": <string[]>,\n  "sentiment": "positive" | "negative" | "neutral" | "mixed",\n  "pain_points": <string[]>,\n  "praise_points": <string[]>,\n  "wishlist_items": <string[]>,\n  "feature_requests": <string[]>,\n  "key_insight": <string>,\n  "confidence": "high" | "medium" | "low",\n  "artist_skill_level": "beginner" | "intermediate" | "professional" | "unknown",\n  "usage_context": "lining" | "shading" | "color_packing" | "cover_up" | "all_around" | "unknown",\n  "purchase_intent": "browsing" | "researching" | "ready_to_buy" | "just_bought" | "not_applicable",\n  "comparison_verdict": <string or null>,\n  "price_sensitivity": "budget_conscious" | "mid_range" | "premium_only" | "not_discussed"\n}\n\nPosts:\n${batchText}` },
            ],
            temperature: 0.1, max_tokens: 3000,
          }),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const raw = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) classifications.push(...parsed);
          } catch { console.warn('[bot-cloak] reddit classify JSON parse failed'); }
        }
      } catch (err: any) {
        console.warn(`[bot-cloak] reddit classify error: ${err.message}`);
      }
      await sleep(1500);
    }

    console.log(`[bot-cloak] classified ${classifications.length} results`);

    // Upload to server
    try {
      const uploadResp = await fetch(`${API_BASE}/api/intel/reddit/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-key': BOT_API_KEY || 'dev_master',
        },
        body: JSON.stringify({ threads: rawPosts, classifications }),
      });
      const uploadResult = await uploadResp.json();
      console.log(`[bot-cloak] ingested: ${JSON.stringify(uploadResult)}`);
    } catch (err: any) {
      console.error(`[bot-cloak] reddit ingest error: ${err.message}`);
    }
  } else {
    console.log('[bot-cloak] no DeepSeek key, uploading raw posts only');
    // Upload raw posts without classification
    try {
      await fetch(`${API_BASE}/api/intel/reddit/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-key': BOT_API_KEY || 'dev_master',
        },
        body: JSON.stringify({ threads: rawPosts, classifications: [] }),
      });
    } catch (err: any) {
      console.error(`[bot-cloak] reddit raw ingest error: ${err.message}`);
    }
  }
};

// ============ Command Execution ============

const executeSupplyAnalysis = async (command: CommandPayload) => {
  const handle = String(command.artistHandle || '').replace(/^@/, '').trim();
  if (!handle) throw new Error('missing_artist_handle');
  console.log(`[bot-cloak] supply analysis: @${handle}`);
  logBehavior('task_start', { commandId: command.id, handle, mode: 'supply_analysis' });

  await ensureBrowser();
  if (!page) throw new Error('page_not_initialized');

  const profileUrl = `${IG_BASE}/${handle}/`;
  // Wait for any pending navigation to settle, then navigate with retry
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await sleep(jitter(2000, 4000));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(profileUrl, { waitUntil: 'load', timeout: 60000 });
      break;
    } catch (e: any) {
      const msg = String(e.message || '');
      if (attempt < 2 && (msg.includes('ABORTED') || msg.includes('interrupted') || msg.includes('Timeout'))) {
        console.log(`  nav retry ${attempt + 1}:`, msg.slice(0, 80));
        // Don't navigate to about:blank — it's visible and looks bot-like
        // Instead, wait for current page to settle
        await sleep(jitter(5000, 10000));
        continue;
      }
      throw e;
    }
  }
  await sleep(jitter(2000, 3000));

  // IG API for stats
  let followerCount = 0, postCount = 0, bio = '', isBusiness = false;
  try {
    const apiUrl = `${IG_BASE}/api/v1/users/web_profile_info/?username=${handle}`;
    const apiData: any = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'include', headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' } });
      if (res.ok) return res.json();
      return null;
    }, apiUrl);
    const user = apiData?.data?.user;
    if (user) {
      followerCount = user.edge_followed_by?.count || user.follower_count || 0;
      postCount = user.edge_owner_to_timeline_media?.count || user.media_count || 0;
      bio = String(user.biography || '').slice(0, 500);
      isBusiness = !!user.is_business_account;
    }
  } catch { /* no API */ }
  console.log(`  followers: ${followerCount.toLocaleString()}, posts: ${postCount}`);

  // ── Phase 1: Human-like profile browsing, then collect post links ──
  // Mimic browseProfileDeep(): scroll bio area, look at grid slowly, then collect tiles
  await humanMouseMove();
  const scrollRounds = randInt(3, 6);
  for (let i = 0; i < scrollRounds; i++) {
    const wheelPx = jitter(350, 900);
    const pauseMs = jitter(800, 2200);
    await page.mouse.wheel(0, wheelPx);
    await sleep(pauseMs);
    await humanHover();
    logBehavior('profile_scroll', { wheelPx, pauseMs });
  }

  await waitForProfileGridReady();
  await waitForMinVisibleTiles();

  const mediaLocator = page.locator('a[href*="/p/"], a[href*="/reel/"]');
  let totalMedia = await mediaLocator.count();
  if (totalMedia === 0) {
    await sleep(jitter(1200, 2800));
    await page.mouse.wheel(0, jitter(450, 1000));
    await sleep(jitter(1000, 2400));
    totalMedia = await mediaLocator.count();
  }
  logBehavior('media_candidates', { totalMedia });

  // Re-check for invalid/deleted profile page now that page is fully loaded
  if (totalMedia === 0 && await isInvalidProfilePage()) {
    logBehavior('invalid_profile_detected_late', { commandId, handle, url: page?.url() || '' });
    try {
      await reportObservation(command, { totalMedia: 0, opened: 0, desiredOpenCount: 0 }, {
        url: page?.url() || '', title: 'invalid_profile', bio: '',
        statTexts: [], nonTattooSuspect: true, invalidProfile: true
      });
    } catch {}
    logBehavior('task_done', { commandId, handle, mode: execMode, reviewOnly: true, invalidProfile: true });
    return '';
  }

  // Slowly scan through grid tiles, one by one — like a human studying thumbnails
  const TARGET_POSTS = 30;
  const seenKeys = new Set<string>();
  const uniquePostLinks: string[] = [];
  const tileIndices: number[] = []; // map post -> grid index for Phase 2 click

  for (let idx = 0; idx < Math.min(totalMedia, 40); idx++) {
    if (uniquePostLinks.length >= TARGET_POSTS) break;

    // Scroll to make this tile visible
    try { await mediaLocator.nth(idx).scrollIntoViewIfNeeded(); } catch {}
    await sleep(jitter(600, 1800)); // human studies each thumbnail briefly

    try {
      const href = (await mediaLocator.nth(idx).getAttribute('href').catch(() => '')) || '';
      const postKey = extractPostKey(href);

      // Skip /c/ (comment permalink) and duplicates
      if (!postKey || /\/c\//i.test(href) || seenKeys.has(postKey)) continue;
      seenKeys.add(postKey);

      const fullUrl = href.startsWith('http') ? href : `${IG_BASE}${href}`;
      uniquePostLinks.push(fullUrl);
      tileIndices.push(idx);

      logBehavior('post_link_found', { idx, postKey, isReel: /\/reel\//i.test(href) });
    } catch { /* skip */ }
  }
  logBehavior('post_links_collected', { count: uniquePostLinks.length, uniquePostKeys: seenKeys.size });

  // ── Phase 2: Open each post via click modal (same as browseProfileDeep) ──
  // Human-like: stay on profile, click tile → modal opens → watch → read → scroll comments → close
  const postData: any[] = [];
  const openedPostKeys = new Set<string>();

  for (let i = 0; i < tileIndices.length && postData.length < TARGET_POSTS; i++) {
    const gridIdx = tileIndices[i];
    const postUrl = uniquePostLinks[i];
    const postKey = extractPostKey(postUrl);
    logBehavior('post_iter_start', { index: i, gridIdx, postKey: postKey || 'null' });
    if (!postKey || openedPostKeys.has(postKey)) { logBehavior('post_iter_skip', { index: i, reason: !postKey ? 'no_key' : 'duplicate' }); continue; }

    try {
      // Scroll tile into view, pause like a human finding it
      logBehavior('post_scroll_into_view', { index: i, gridIdx });
      await mediaLocator.nth(gridIdx).scrollIntoViewIfNeeded();
      await sleep(jitter(1200, 2800));
      await humanMouseMove();

      // Click to open modal (same as browseProfileDeep line 1061)
      logBehavior('post_click_start', { index: i, gridIdx });
      let clickOk = false;
      try {
        await mediaLocator.nth(gridIdx).click({ timeout: 12000 });
        clickOk = true;
      } catch {
        try {
          await mediaLocator.nth(gridIdx).evaluate((el: any) => el.click());
          clickOk = true;
        } catch {}
      }
      if (!clickOk) {
        console.log(`  post[${i}] click failed, gridIdx=${gridIdx}`);
        logBehavior('post_click_failed', { index: i, gridIdx, postKey });
        continue;
      }
      logBehavior('post_click_done', { index: i });

      // Wait for modal to appear — give IG enough time to render
      const modalWaitMs = jitter(2000, 5000);
      logBehavior('post_modal_wait', { index: i, waitMs: modalWaitMs });
      await sleep(modalWaitMs);

      // Use the bot's own readModalMeta — it handles reel detection,
      // caption/likes/comments, content type (healed/wip/booking/flash),
      // style detection, keyword scoring
      logBehavior('post_read_meta_start', { index: i });
      const meta = await readModalMeta('', handle);
      logBehavior('post_read_meta_done', { index: i, hasMeta: !!meta });
      const modalPostKey = meta?.postKey || postKey;
      if (!meta) {
        console.log(`  post[${i}] readModalMeta null, gridIdx=${gridIdx}`);
        logBehavior('post_modal_read_failed', { index: i, gridIdx, expectedKey: postKey });
        await closeModal().catch(() => {});
        await sleep(jitter(1000, 2000));
        continue;
      }
      // Use the modal's actual postKey — IG sometimes rewrites URLs
      if (openedPostKeys.has(modalPostKey)) {
        console.log(`  post[${i}] already opened: ${modalPostKey}`);
        await closeModal().catch(() => {});
        await sleep(jitter(1000, 2000));
        continue;
      }

      openedPostKeys.add(modalPostKey);

      // Human viewing time — same as browseProfileDeep line 1090
      const watchMs = jitter(3000, 8000);
      await sleep(watchMs);
      logBehavior('open_post', { postIndex: i, watchMs, postKey: modalPostKey, ownerHandle: meta.ownerHandle });

      // Scroll through carousel if available (35% chance, same as browseProfileDeep)
      const nextBtn = page.locator('button[aria-label="Next"], button[aria-label="下一步"]').first();
      if (await nextBtn.count()) {
        if (Math.random() < 0.35) {
          try { await nextBtn.click({ timeout: 2500 }); await sleep(jitter(1800, 4500)); } catch {}
        }
      }

      // Scroll down slowly to read caption
      logBehavior('post_caption_scroll_start', { index: i });
      for (let sc = 0; sc < 3; sc++) {
        await page.mouse.wheel(0, jitter(80, 250)).catch(() => {});
        await sleep(jitter(1500, 3500));
      }
      logBehavior('post_caption_scroll_done', { index: i });

      // Build post data from readModalMeta + extra fields
      logBehavior('post_extrameta_start', { index: i });
      const extraMeta: any = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return null;
        const dialogText = dialog.textContent || '';
        const caption = dialogText.slice(0, 2500);
        const hashtags = (caption.match(/#[a-zA-Z0-9_]+/g) || []).map((h: string) => h.toLowerCase());
        const productHints = (caption.match(/(?:new|launch|drop|release|introducing|now available|coming soon|pre[- ]?order|limited edition)/gi) || []);
        const urlsInCaption = (caption.match(/https?:\/\/[^\s]+/g) || []);
        const isCarousel = !!dialog.querySelector('button[aria-label="Next"], button[aria-label="下一步"]');
        const timeEl = dialog.querySelector('time');
        const approxDate = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent || '') : '';
        return { caption, hashtags, productHints: productHints.length, urlsInCaption, isCarousel, approxDate };
      });
      logBehavior('post_extrameta_done', { index: i, hasCaption: !!(extraMeta?.caption) });

      postData.push({
        index: i,
        postUrl,
        postKey: modalPostKey,
        isReel: meta.isReel,
        likeCount: meta.likeCount,
        commentCount: meta.commentCount,
        postType: meta.postType,        // from detectPostType: healed/wip/before_after/booking/flash
        postStyle: meta.postStyle,      // detected tattoo style
        ageDays: meta.ageDays,
        caption: extraMeta?.caption?.slice(0, 2000) || '',
        hashtags: extraMeta?.hashtags || [],
        productHints: extraMeta?.productHints || 0,
        urlsInCaption: extraMeta?.urlsInCaption || [],
        isCarousel: extraMeta?.isCarousel || false,
        approxDate: extraMeta?.approxDate || '',
      });
      logBehavior('post_scraped', {
        index: i, postKey,
        likeCount: meta.likeCount, commentCount: meta.commentCount,
        isReel: meta.isReel, postType: meta.postType, postStyle: meta.postStyle,
        hashtagsCount: extraMeta?.hashtags?.length || 0,
        productHints: extraMeta?.productHints || 0,
      });

      // ── Phase 3 (inline): Scroll comments in the open modal ──
      if (meta.commentCount > 0) {
        for (let sc = 0; sc < 5; sc++) {
          await page.mouse.wheel(0, jitter(200, 500)).catch(() => {});
          await sleep(jitter(1200, 2500));
        }
        const comments = await scrapePostComments();
        if (comments.length > 0) {
          const sentiment = await analyzeCommentsSentiment(comments, handle);
          if (sentiment.length > 0) {
            postData[postData.length - 1].commentSentiment = sentiment;
            logBehavior('comments_analyzed', { postIdx: i, commentCount: comments.length, sentimentCount: sentiment.length });
          }
        }
      }

      // Close modal (same as browseProfileDeep lines 1125-1131)
      logBehavior('post_close_modal', { index: i });
      await closeModal();
      logBehavior('post_modal_closed', { index: i });
      // Human gap between posts: 10-20s — simulate reading, thinking, scrolling grid
      const postGapMs = jitter(10000, 20000);
      logBehavior('post_gap_start', { index: i, gapMs: postGapMs });
      await sleep(postGapMs);
      logBehavior('post_gap_end', { index: i });

    } catch (e: any) {
      console.log(`  post[${i}] err:`, String(e?.message || e || 'unknown').slice(0, 100));
      await closeModal().catch(() => {});
      continue;
    }
  }

  console.log(`  scraped ${postData.length}/${TARGET_POSTS} posts`);

  // ── Phase 4: DeepSeek — launch playbook analysis ──
  let contentAnalysis: any = null;
  if (postData.length > 0 && DEEPSEEK_KEY) {
    const postFeed = postData.map((p: any, i: number) =>
      `[Post ${i + 1}] type=${p.isReel ? 'reel' : p.isCarousel ? 'carousel' : 'image'} | likes=${p.likeCount} | comments=${p.commentCount} | date=${p.approxDate || 'recent'}\n${p.caption.slice(0, 500)}`
    ).join('\n---\n');

    // Build comment sentiment summary
    let sentimentSummary = '';
    const postsWithSentiment = postData.filter((p: any) => p.commentSentiment?.length > 0);
    if (postsWithSentiment.length > 0) {
      sentimentSummary = postsWithSentiment.map((p: any) =>
        `[Post ${p.index + 1}] sentiment: ${JSON.stringify(p.commentSentiment.slice(0, 5))}`
      ).join('\n');
    }

    // ── Web search: gather external intel about the brand (multiple angles) ──
    let webIntel = '';
    try {
      const allSnippets: string[] = [];
      // Multi-angle search: web + Reddit
      const queries = [
        `${handle} tattoo machine drop release`,
        `${handle} tattoo review new`,
        `${handle} tattoo convention booth`,
        `${handle} artist ambassador sponsored`,
        `${handle} press release announces`,
        `${handle} founder interview`,
        `site:reddit.com ${handle} tattoo review`,
        `site:reddit.com ${handle} tattoo machine`,
        `${handle} available shopify amazon`,
        `${handle} sold out restock`,
      ];
      for (const q of queries.slice(0, 6)) {
        if (allSnippets.length >= 15) break;
        const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
        const resp = await fetch(searchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' },
        }).catch(() => null);
        if (!resp || !resp.ok) continue;
        const html = await resp.text();
        // Extract result snippets
        const snippetRegex = /<td class="result-snippet"[^>]*>(.*?)<\/td>/gi;
        let match;
        while ((match = snippetRegex.exec(html)) !== null && allSnippets.length < 15) {
          const text = match[1].replace(/<[^>]+>/g, '').trim();
          if (text.length > 30 && !allSnippets.includes(text)) allSnippets.push(text);
        }
        // Fallback: plain text paragraphs
        if (allSnippets.length === 0) {
          const textOnly = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
          const lines = textOnly.split(/[.!?]/).filter((l: string) => l.trim().length > 40);
          for (const l of lines) { if (!allSnippets.includes(l.trim())) allSnippets.push(l.trim()); }
        }
      }
      if (allSnippets.length > 0) {
        webIntel = allSnippets.slice(0, 15).map((s, i) => `[Web ${i + 1}] ${s}`).join('\n');
        console.log(`  web intel: ${allSnippets.length} snippets from web`);
      }
    } catch { /* web search unavailable */ }

    const brandContext = command.competitorNotes || '';
    const accountType = command.accountType || 'supply_brand';
    const source = command.competitorSource || '';
    const safeBio = String(bio || '').replace(/["\\]/g, '').slice(0, 200);

    const prompt = `You analyze how tattoo supply brands market and launch products on Instagram. Study competitor @${handle} (tattoo ${accountType === 'supply_distributor' ? 'distributor' : 'equipment/ink/aftercare brand'}) and reconstruct their INSTAGRAM-NATIVE product launch playbook.

CONTEXT:
- Brand: ${brandContext || handle}
- Category: ${source} (e.g. machines, needles, ink, aftercare, general supply)
- Bio: "${safeBio}"
- IG Followers: ${followerCount.toLocaleString()}, Total Posts: ${postCount}
${webIntel ? '- WEB INTEL:\n' + webIntel + '\n' : ''}

Tattoo supply brands launch differently from SaaS/3C brands. They use:
- Artist demos & collabs — the artist IS the marketing channel
- Trade show drops — debut at conventions, then IG rollout
- Drop culture — limited editions, pre-order windows, "now shipping"

Analyze these ${postData.length} recent IG posts.
FIRST: Group posts by product (same name/hashtag/timing).

${postFeed}
${sentimentSummary ? 'COMMENT SENTIMENT:\n' + sentimentSummary + '\n' : ''}

Return ONLY valid JSON, no markdown, no extra text.

{
  "brandProfile": {
    "followerCount": ${followerCount},
    "postCount": ${postCount},
    "bio": "${safeBio}",
    "postingCadence": "how often they post",
    "contentMix": "reel vs carousel vs image %",
    "brandVoice": "educational, hype, luxury, artist-first"
  },
  "products": [
    {
      "productName": "name from captions",
      "productType": "machine|needle|ink|aftercare|accessory|general_brand",
      "priceTier": "budget|mid|premium|luxury|unknown",
      "targetUser": "beginner|experienced|shop_owner|all",
      "keySellingPoints": ["features repeated across posts"],
      "postCount": 5,
      "launchTimeline": [
        {
          "phase": "teaser|reveal|artist_demo|social_proof|availability|sustain",
          "timing": "2 weeks pre-launch",
          "postIndices": [1, 3],
          "contentFormats": ["reel"],
          "purpose": "what phase achieves",
          "hookExamples": ["actual hooks"],
          "hashtagThemes": ["#hashtags used"],
          "inferredTactic": "artist collab, countdown, unboxing, etc."
        }
      ],
      "narrativeArc": "product story arc across phases",
      "scarcitySignals": "limited edition, pre-order, exclusive",
      "ctaPatterns": "link in bio, DM, shop now",
      "artistActivation": "how artists used in this launch"
    }
  ],
  "historicalTrends": {
    "postingFrequencyTrend": "increasing|declining|steady",
    "contentFormatShift": "more reels recently?",
    "engagementTrend": "likes/comments over time",
    "seasonalPatterns": "convention spikes?"
  },
  "hashtagStrategy": {
    "brandedHashtags": ["#brand"],
    "communityHashtags": ["#tattooartist"],
    "avgHashtagsPerPost": 0,
    "strategy": "caption vs first comment?"
  },
  "engagementAnalysis": {
    "avgLikes": 0,
    "avgComments": 0,
    "bestFormat": "which format gets most engagement",
    "commentThemes": "what commenters ask/say"
  },
  "competitiveIntel": {
    "whatTheyExcelAt": ["strengths"],
    "whatTheyreMissing": ["gaps to exploit"],
    "stealTheseIdeas": ["actionable tactics to copy"],
    "differentiator": "what makes them unique"
  }
}

RULES:
- Base EVERYTHING on real captions and data. No inventing.
- Unknown products → group as "general_brand".
- Single-post products: still list them, note limited data.
- Cite ACTUAL hooks, hashtags, words from captions.
- Audience = tattoo artists — their language, buying signals.
- Prioritize ACTIONABLE takeaways over description.`;

    try {
      const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 4000 }),
      });
      if (resp.ok) {
        const data: any = await resp.json();
        const raw = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
        try { contentAnalysis = JSON.parse(raw); } catch { contentAnalysis = { rawResponse: raw }; }
      }
    } catch { /* DeepSeek unavailable */ }
    if (contentAnalysis) console.log('  launch playbook analysis: done');
  }

  // ── Phase 5: Report observation ──
  try {
    await reportObservation(command, {
      totalMedia: postCount,
      opened: postData.length,
      desiredOpenCount: TARGET_POSTS,
    }, {
      url: profileUrl,
      bio,
      followerCount,
      postCount,
      isBusiness,
      accountType: command.accountType,
      mode: 'supply_competitive_intel',
      postInventory: postData.map((p: any) => ({
        index: p.index,
        postUrl: p.postUrl,
        likeCount: p.likeCount,
        commentCount: p.commentCount,
        isReel: p.isReel,
        isCarousel: p.isCarousel,
        approxDate: p.approxDate,
        hashtags: p.hashtags,
        productHints: p.productHints,
        captionPreview: p.caption.slice(0, 300),
      })),
      products: contentAnalysis?.products || null,
	      historicalTrends: contentAnalysis?.historicalTrends || null,
	      hashtagStrategy: contentAnalysis?.hashtagStrategy || null,
      engagementAnalysis: contentAnalysis?.engagementAnalysis || null,
      competitiveIntel: contentAnalysis?.competitiveIntel || null,
      brandProfile: contentAnalysis?.brandProfile || null,
      rawAnalysis: contentAnalysis,
      competitorSource: command?.competitorSource || null,
      competitorNotes: command?.competitorNotes || null,
    });
    logBehavior('observation_reported', {
      commandId: command.id,
      handle,
      mode: 'supply_competitive_intel',
      posts: postData.length,
      hasProducts: !!contentAnalysis?.products?.length,
	      productCount: contentAnalysis?.products?.length || 0,
    });
  } catch (err: any) {
    logBehavior('observation_report_failed', { commandId: command.id, reason: String(err?.message || 'report_failed') });
  }

  logBehavior('task_done', { commandId: command.id, handle, mode: 'supply_analysis' });
  console.log(`[bot-cloak] supply done: @${handle} (${postData.length} posts, products=${contentAnalysis?.products?.length || 0})`);
};

const executeCommand = async (command: CommandPayload) => {
  const commandId = command.id;
  // Route non-IG tasks
  const taskType = String(command.taskType || '').trim();
  if (taskType === 'reddit_scrape') {
    await executeRedditScrape(command);
    return;
  }
  // Supply analysis: skip IG outreach flow, use CDP-connected Chrome directly
  const isSupply = String(command?.accountType || '').startsWith('supply');
  if (isSupply || taskType === 'supply_analysis') {
    await executeSupplyAnalysis(command);
    return;
  }
  const handle = String(command.artistHandle || '').replace(/^@/, '').trim();
  if (!handle) throw new Error('missing_artist_handle');
  const taskModeRaw = String(command?.suggestedExecMode || '').trim().toLowerCase();
  const execMode = (taskModeRaw === 'browse_only' || taskModeRaw === 'browse_like') ? taskModeRaw : BOT_EXEC_MODE;
  console.log(`[bot-cloak] execute ${commandId} -> @${handle}`);
  logBehavior('task_start', { commandId, handle, mode: execMode, suggestedExecMode: taskModeRaw || null });
  likeState.touches![handle] = Number(likeState.touches![handle] || 0) + 1;
  const dayKey = getDayKey();
  likeState.touchesByDay![dayKey] = Number(likeState.touchesByDay![dayKey] || 0) + 1;
  if (!likeState.firstTouchAt![handle]) likeState.firstTouchAt![handle] = Date.now();
  saveLikeState(likeState);

  ensureExecMode(execMode);
  ensureBrowserLegacyLaunchDisabled();
  await ensureBrowser();
  logBehavior('ensure_browser_done', { commandId, handle });
  await escapeFollowTrap();        // escape if previous task left us on explore/people
  await openProfile(handle);
  await escapeFollowTrap();        // escape if profile nav landed on follow suggestions
  await sleep(jitter(2000, 4000)); // let error pages fully render before checking
  if (await isInvalidProfilePage()) {
    logBehavior('invalid_profile', { commandId, handle, url: page?.url() || '' });
    try {
      await reportObservation(command, { totalMedia: 0, opened: 0, desiredOpenCount: 0 }, {
        url: page?.url() || '',
        title: 'invalid_profile',
        bio: '',
        statTexts: [],
        nonTattooSuspect: true,
        invalidProfile: true
      });
      logBehavior('observation_reported', { commandId, handle, invalidProfile: true });
    } catch (err: any) {
      logBehavior('observation_report_failed', { commandId, reason: String(err?.message || 'report_failed') });
    }
    logBehavior('task_done', { commandId, handle, mode: execMode, reviewOnly: true, invalidProfile: true });
    return;
  }
  const profileFacts = await captureProfileFacts();

  // --- Relationship graph scraping (sampled) ---
  const REL_SCRAPE_MIN_FOLLOWERS = Number(process.env.BOT_RELATIONSHIP_SCRAPE_MIN_FOLLOWERS) || 200;
  const REL_SCRAPE_MAX_COUNT = Number(process.env.BOT_RELATIONSHIP_SCRAPE_MAX_COUNT) || 50;
  let relationshipData: RelationshipData | null = null;
  if (
    profileFacts.igUserId &&
    (profileFacts.followers || 0) >= REL_SCRAPE_MIN_FOLLOWERS
  ) {
    try {
      await sleep(jitter(800, 2200));
      relationshipData = await scrapeFollowerGraph(handle, profileFacts.igUserId, REL_SCRAPE_MAX_COUNT);
    } catch {}
  }

  if (profileFacts?.nonTattooSuspect) {
    logBehavior('non_tattoo_profile', { commandId, handle, title: profileFacts.title, bio: profileFacts.bio });
    try {
      await reportObservation(command, { totalMedia: 0, opened: 0, desiredOpenCount: 0 }, {
        ...profileFacts,
        nonTattooSuspect: true,
        relationships: relationshipData
      });
      logBehavior('observation_reported', { commandId, handle, nonTattooSuspect: true });
    } catch (err: any) {
      logBehavior('observation_report_failed', { commandId, reason: String(err?.message || 'report_failed') });
    }
    if (BOT_NON_TATTOO_MODE === 'fail') {
      throw new Error('non_tattoo_profile');
    }
    logBehavior('task_review_only', { commandId, handle, reason: 'non_tattoo_suspect' });
    logBehavior('task_done', { commandId, handle, mode: execMode, reviewOnly: true });
    return;
  }
  let summary: BrowseSummary = { totalMedia: 0, opened: 0, desiredOpenCount: 0 };
  let likeSummary: LikeActionSummary = { attempted: 0, liked: 0, skippedCooldown: false, likedUrls: [] };
  let commentSummary: CommentActionSummary = { attempted: 0, posted: 0, skipped: true, reason: 'not_run' };
  let followSummary: FollowActionSummary = { attempted: 0, followed: 0, skipped: true, reason: 'not_run' };
  if (execMode === 'browse_like') {
    summary = await browseProfileDeep();
    await sleep(jitter(1200, 2600));
    likeSummary = await tryLikeWithStrategy(handle, profileFacts, command);
    if (likeSummary.liked > 0) {
      await sleep(jitter(1400, 2600));
      commentSummary = await tryCommentWithStrategy(handle, profileFacts, likeSummary);
      await sleep(jitter(1200, 2400));
      followSummary = await tryFollowOnProfile(handle, likeSummary, command);
    } else {
      commentSummary = { attempted: 0, posted: 0, skipped: true, reason: 'no_like_this_visit' };
      followSummary = { attempted: 0, followed: 0, skipped: true, reason: 'no_like_this_visit' };
    }
    await sleep(jitter(1600, 4200));
  } else if (execMode === 'browse_explore') {
    // New mode: browse IG explore + optional follow/save actions
    // Step 1: Browse explore page (刷 feed)
    const exploreResult = await browseExplore();
    logBehavior('exec_mode_explore_explore_done', { viewed: exploreResult.viewed, liked: exploreResult.liked });
    await sleep(jitter(2000, 5000));

    // Step 2: Browse hashtag search results (if hashtag is specified in command)
    const hashtag = String(command?.hashtag || '').trim();
    if (hashtag) {
      const hashtagResult = await browseHashtagSearch(hashtag);
      logBehavior('exec_mode_explore_hashtag_done', { hashtag, viewed: hashtagResult.viewed, liked: hashtagResult.liked });
      await sleep(jitter(2000, 4000));
    }

    // Step 3: Browse following/followers list of target (sampled, not every profile)
    // Only do this for high-priority targets (followPriority: 'high')
    const followPriority = String(command?.followPriority || '').toLowerCase();
    if (followPriority === 'high' || followPriority === 'follow') {
      // Browse following list (see who they follow)
      await sleep(jitter(1500, 3000));
      const relResult = await browseFollowerFollowing(handle, 'following');
      logBehavior('exec_mode_explore_rel_done', { handle, mode: 'following', viewed: relResult.viewed });
      await sleep(jitter(2000, 4000));

      // Occasionally browse followers too (30% chance)
      if (Math.random() < 0.3) {
        const follResult = await browseFollowerFollowing(handle, 'followers');
        logBehavior('exec_mode_explore_rel_done', { handle, mode: 'followers', viewed: follResult.viewed });
        await sleep(jitter(2000, 4000));
      }
    }

    // Step 4: Optional save/bookmark (15% chance)
    if (Math.random() < 0.15) {
      const saveResult = await trySaveBookmark();
      if (saveResult.saved) {
        logBehavior('exec_mode_explore_save_done', { postUrl: saveResult.postUrl });
      }
    }
  } else {
    summary = await browseProfileDeep();
    await sleep(jitter(1200, 2600));
  }
  try {
    await reportObservation(command, summary, {
      ...profileFacts,
      likeSummary,
      commentSummary,
      followSummary,
      relationships: relationshipData,
      touches: likeState.touches![handle] || 0,
      leadScore: Number(command?.leadScore || 0),
      followPriority: String(command?.followPriority || '')
    });
    logBehavior('observation_reported', { commandId, handle });
  } catch (err: any) {
    logBehavior('observation_report_failed', { commandId, reason: String(err?.message || 'report_failed') });
  }
  logBehavior('task_done', { commandId, handle, mode: execMode });
};

// =====================================================================
// DM Marketing Execution — send Instagram DMs from marketing_tasks
// =====================================================================

const executeDmTask = async (task: any): Promise<boolean> => {
  if (!page) throw new Error('page_not_initialized');
  const targetHandle = String(task.target_handle || '').replace(/^@/, '').trim();
  let scriptContent = '';
  try {
    const parsed = typeof task.script_content === 'string' ? JSON.parse(task.script_content) : task.script_content;
    scriptContent = parsed?.template || parsed?.content || task.script_content;
  } catch {
    scriptContent = String(task.script_content || '');
  }
  if (!targetHandle || !scriptContent) return false;

  logBehavior('dm_start', { targetHandle, taskId: task.id });
  try {
    // Step 1: Navigate to DM new message
    await page.goto(`${IG_BASE}/direct/new/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(2000, 4000));

    // Step 2: Type target handle in search
    const searchInput = page.locator('input[type="text"]').first();
    await searchInput.waitFor({ timeout: 10000 }).catch(() => {});
    await searchInput.fill('');
    // Type slowly like a human
    for (const char of targetHandle) {
      await page.keyboard.type(char, { delay: jitter(60, 180) });
    }
    await page.waitForTimeout(jitter(1500, 3000));

    // Step 3: Click the matching user result
    const userResult = page.locator(`[role="button"]:has-text("${targetHandle}")`).first();
    const clicked = await userResult.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!clicked) {
      // Try alternative selector
      const altResult = page.locator(`a[href="/${targetHandle}/"]`).first();
      await altResult.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(jitter(1000, 2500));

    // Step 4: Click "Chat" or "Next" button
    const chatBtn = page.locator('button:has-text("Chat"), button:has-text("Next"), div[role="button"]:has-text("Chat")').first();
    await chatBtn.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(jitter(2000, 3500));

    // Step 5: Type message with human-like typing
    const msgArea = page.locator('div[role="textbox"], textarea, div[contenteditable="true"]').first();
    await msgArea.waitFor({ timeout: 10000 }).catch(() => {});
    await msgArea.click();
    await page.waitForTimeout(jitter(500, 1200));
    // Type word by word with pauses
    const words = scriptContent.split(/(\s+)/);
    for (const word of words) {
      await page.keyboard.type(word, { delay: jitter(40, 120) });
      if (Math.random() < 0.15) await page.waitForTimeout(jitter(300, 800)); // occasional mid-msg pause
    }
    await page.waitForTimeout(jitter(800, 2000));

    // Step 6: Send
    const sendBtn = page.locator('button:has-text("Send"), button[type="submit"], div[role="button"]:has-text("Send")').first();
    const sent = await sendBtn.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!sent) {
      // Fallback: press Enter
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(jitter(2000, 4000));

    logBehavior('dm_sent', { targetHandle, taskId: task.id });
    return true;
  } catch (err: any) {
    logBehavior('dm_failed', { targetHandle, taskId: task.id, error: String(err?.message || '') });
    return false;
  }
};

/** Check for and execute a pending DM marketing task */
const tryExecuteDmTask = async (): Promise<boolean> => {
  try {
    const data = await getJson(`/api/marketing/tasks/poll?botId=${encodeURIComponent(BOT_ID)}&limit=1`);
    const tasks: any[] = Array.isArray(data?.tasks) ? data.tasks : [];
    if (!tasks.length) return false;
    const task = tasks[0];
    logBehavior('dm_task_acquired', { taskId: task.id, targetHandle: task.target_handle });
    const success = await executeDmTask(task);
    await postJson('/api/marketing/tasks/report', {
      taskId: task.id,
      status: success ? 'sent' : 'failed',
      botId: BOT_ID
    }).catch(() => {});
    return success;
  } catch (err: any) {
    logBehavior('dm_poll_error', { error: String(err?.message || '') });
    return false;
  }
};

// =====================================================================
// DM Auto-Reply — check incoming DMs, classify intent, auto-respond
// =====================================================================

const classifyIntent = (text: string): { intent: string; category: string } => {
  const lower = String(text || '').toLowerCase();
  if (/how much|\$|price|cost|多少钱|报价|价格/i.test(lower))
    return { intent: 'pricing', category: 'product_intro' };
  if (/what brand|which (product|machine|ink)|推荐|suggest|型号/i.test(lower))
    return { intent: 'product_inquiry', category: 'product_intro' };
  if (/collab|合作|partner|wholesale|批发|代理/i.test(lower))
    return { intent: 'collaboration', category: 'collaboration' };
  if (/buy|purchase|want|interested|order|下单|想买|需要/i.test(lower))
    return { intent: 'purchase', category: 'after_sales' };
  if (/thanks|thank you|nice|great|awesome/i.test(lower))
    return { intent: 'casual_chat', category: 'industry_talk' };
  return { intent: 'casual_chat', category: 'industry_talk' };
};

const pickAutoReply = async (targetHandle: string, intent: string, category: string): Promise<string> => {
  try {
    const data = await postJson('/api/marketing/scripts/select', {
      category,
      intent,
      targetHandle,
      profileFacts: {}  // bot doesn't have profile facts at this point
    });
    const content = data?.selected?.content;
    if (content) return content;
    // Fallback: use category-appropriate template
    const fallbacks: Record<string, string> = {
      product_intro: `Thanks @${targetHandle}! Check our website for more details on our tattoo supplies.`,
      collaboration: `Thanks @${targetHandle}! We'd love to explore collaboration opportunities.`,
      industry_talk: `Thanks @${targetHandle}! Always great to connect with fellow industry pros.`,
      after_sales: `Thanks @${targetHandle}! We're glad you're happy with our products.`,
    };
    return fallbacks[category] || `Thanks @${targetHandle}! We'd love to help. Feel free to ask any questions.`;
  } catch {
    return `Thanks @${targetHandle}! We'd love to help. Feel free to ask any questions.`;
  }
};

const checkDmReplies = async (): Promise<number> => {
  if (!page) return 0;
  let handled = 0;
  try {
    // Only check replies when no pending DM tasks
    const data = await getJson(`/api/marketing/tasks/poll?botId=${encodeURIComponent(BOT_ID)}&limit=1`);
    if ((data?.tasks || []).length > 0) return 0;

    await page.goto(`${IG_BASE}/direct/inbox/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(3000, 5000));

    const threads = page.locator('a[href*="/direct/t/"]');
    const count = await threads.count();
    if (count === 0) return 0;

    const checkLimit = Math.min(count, 3);
    for (let i = 0; i < checkLimit; i++) {
      try {
        await threads.nth(i).click();
        await page.waitForTimeout(jitter(2000, 4000));

        const msgSpan = page.locator('[role="row"] div[dir="auto"] span').last();
        const latestText = await msgSpan.textContent().catch(() => '');
        if (!latestText) continue;

        const { intent, category } = classifyIntent(latestText);

        const reply = await pickAutoReply('', intent, category);
        const input = page.locator('div[role="textbox"]').first();
        await input.click();
        await page.waitForTimeout(jitter(500, 1200));
        for (const char of reply) {
          await page.keyboard.type(char, { delay: jitter(30, 90) });
          if (Math.random() < 0.1) await page.waitForTimeout(jitter(200, 600));
        }
        await page.waitForTimeout(jitter(800, 1800));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(jitter(1500, 3000));
        handled++;
        logBehavior('dm_reply_sent', { intent, category });
      } catch (err: any) {
        logBehavior('dm_reply_error', { i, err: String(err?.message || '') });
      }
    }
  } catch (err: any) {
    logBehavior('dm_check_error', { err: String(err?.message || '') });
  }
  return handled;
};

// =====================================================================
// Comment Auto-Reply (互动反哺) — reply to comments on our own posts
// =====================================================================

const checkOwnPostComments = async (): Promise<number> => {
  if (!page) return 0;
  let replied = 0;
  try {
    const ourAccount = ACCOUNT_IDS[0] || BOT_ID.replace('bot_', '');
    await page.goto(`${IG_BASE}/${ourAccount}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(2000, 4000));

    // Get recent posts
    const posts = page.locator('a[href*="/p/"], a[href*="/reel/"]');
    const postCount = await posts.count();
    if (postCount === 0) return 0;

    // Check the 3 most recent posts
    const checkPosts = Math.min(postCount, 3);
    for (let p = 0; p < checkPosts; p++) {
      try {
        await posts.nth(p).click();
        await page.waitForTimeout(jitter(2000, 3500));

        // Look for existing comments section
        const commentsSection = page.locator('ul[role="presentation"] li, article div[role="button"]').filter({ hasText: /^[^@]/ });
        const commentCount = await commentsSection.count();

        if (commentCount > 0) {
          // Get the first un-replied comment (skip if it's our own reply)
          for (let c = 0; c < Math.min(commentCount, 5); c++) {
            try {
              const commentText = await commentsSection.nth(c).textContent().catch(() => '');
              if (!commentText) continue;
              // Skip if it's the post caption or our own account name
              if (commentText.includes(ourAccount) || commentText.length > 500) continue;

              // Report inbound engagement: someone commented on our post
              try {
                const commenterLink = commentsSection.nth(c).locator('a[href^="/"]').first();
                const href = await commenterLink.getAttribute('href').catch(() => '');
                if (href && !href.includes(ourAccount)) {
                  const handle = href.replace(/^\//, '').replace(/\/$/, '');
                  postJson('/api/bot/inbound-engagement', {
                    handle, engagementType: 'comment', postUrl: page.url(), botId: BOT_ID
                  }).catch(() => {});
                }
              } catch {}

              // Generate reply: compliment-match + simple engagement
              const replyPool = [
                'Thanks so much! 🔥',
                'Appreciate it! 🙏',
                'Glad you like it!',
                'Thank you! More coming soon.',
                'Thanks for the support!',
              ];
              const reply = replyPool[Math.floor(Math.random() * replyPool.length)];
              if (!reply) continue;

              // Type and post reply
              const replyInput = page.locator('textarea[placeholder*="comment"], div[role="textbox"]').first();
              if (await replyInput.isVisible().catch(() => false)) {
                await replyInput.click();
                await page.waitForTimeout(jitter(400, 1000));
                for (const char of reply) {
                  await page.keyboard.type(char, { delay: jitter(40, 100) });
                }
                await page.waitForTimeout(jitter(600, 1400));
                await page.keyboard.press('Enter');
                await page.waitForTimeout(jitter(1000, 2000));
                replied++;
                logBehavior('comment_reply_sent', { reply });
              }
              break; // Only reply to the first valid comment
            } catch {}
          }
        }

        // Close modal
        await page.keyboard.press('Escape');
        await page.waitForTimeout(jitter(800, 1800));
      } catch {}
    }
  } catch (err: any) {
    logBehavior('comment_check_error', { err: String(err?.message || '') });
  }
  return replied;
};

// =====================================================================
// Content Publish (自动发帖) — 模拟人工操作发帖到 IG
// =====================================================================

// ─── Bot Work Schedule (自主管理，基于 ID hash 生成作息表) ───

// 生成 bot 每天的作息表：2-4 个工作段，总时长 8-12 小时
function generateDailyWorkSchedule(botId: string): [number, number][] {
  const hash = hashBot(botId);
  
  // 工作段数：2-4
  const segmentCount = 2 + (hash % 3);
  
  // 每段时长：1.5 - 3 小时
  const segmentBase = 90 + (hash % 90); // 90-179 分钟
  
  const segments: [number, number][] = [];
  let lastEnd = 420 + (hash % 180); // 首日从 7:00-10:00 开始
  
  const totalDay = 1380; // 23:00 = 一天结束
  
  for (let i = 0; i < segmentCount; i++) {
    // 段间休息：1.5 - 5 小时
    const restGap = 90 + ((hash * (i + 1)) % 210);
    const start = Math.min(totalDay - 60, lastEnd + restGap);
    const duration = segmentBase + (hash * (i + 1) % 60) - 30; // 60-150 分钟
    
    const end = Math.min(totalDay, start + Math.max(60, duration));
    segments.push([start, end]);
    lastEnd = end;
  }
  
  return segments;
}

// 获取当前 UTC+8 的时间（分钟数，从午夜算起）
// 实际使用 bot 所在时区
function getMinutesInLocalTimezone(timezone: string): number {
  const now = new Date();
  const localStr = now.toLocaleString('en-US', { timeZone: timezone });
  const localDate = new Date(localStr);
  return localDate.getHours() * 60 + localDate.getMinutes();
}

// 检查 bot 当前是否在工作
let _workScheduleCache: [number, number][] | null = null;
let _workScheduleDate = '';

function isBotWorking(botId: string): boolean {
  const today = new Date().toDateString();
  if (_workScheduleDate !== today) {
    // 新的一天，重新生成作息表
    _workScheduleCache = generateDailyWorkSchedule(botId);
    _workScheduleDate = today;
  }
  
  const tz = detectTimezone(); // 这里需要能访问 _cachedTimezone
  const mins = getMinutesInLocalTimezone(tz);
  
  for (const [start, end] of _workScheduleCache || []) {
    if (mins >= start && mins < end) return true;
  }
  return false;
}

// Bot 今日是否已下班（超过总工作时间或到了晚上）
let _botTodayWorked = false;
let _botLastWorkEnd = 0;

function hasBotFinishedToday(botId: string): boolean {
  const schedule = _workScheduleCache || generateDailyWorkSchedule(botId);
  if (schedule.length === 0) return true;
  
  const lastSegment = schedule[schedule.length - 1];
  const now = getMinutesInLocalTimezone(_cachedTimezone || 'UTC');
  
  // 过了最后一个工作段的 30 分钟后，视为今日完成
  if (now > lastSegment[1] + 30) {
    return true;
  }
  
  // 也检查是否已经跑够了任务
  if (_botTodayWorked && _botLastWorkEnd > 0) {
    // 最后一个工作段已经过了
    return now > _botLastWorkEnd + 60;
  }
  
  return false;
}

// 关闭浏览器：模拟人类下线
async function logoutAndCloseBrowser(page: Page, context: any): Promise<void> {
  console.log('[publish] logging out and closing browser (simulating human offline)');
  try {
    // 尝试登出 IG
    try {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(jitter(2000, 4000));
      
      // 找下拉菜单/设置
      const menuBtn = page.locator('div[role="button"]:has-text("Menu"), svg[aria-label="Menu"], button[aria-label="Menu"]').first();
      if (await menuBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await menuBtn.click();
        await sleep(jitter(1000, 2000));
        
        // 找登出按钮
        const logoutBtn = page.locator('div[role="menuitem"]:has-text("Log out"), div[role="menuitem"]:has-text("log out"), button:has-text("Log out")').first();
        if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await logoutBtn.click();
          await sleep(jitter(3000, 6000));
          console.log('[publish] logged out of IG');
        }
      }
    } catch {}
    
    // 关闭浏览器上下文
    if (context) {
      await context.close();
      console.log('[publish] browser context closed (human offline)');
    }
  } catch (err: any) {
    console.log(`[publish] logout/close error (non-critical): ${err?.message || err}`);
    // 即使登出失败也要关闭浏览器
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

// ── Active hours window check ──

const ACTIVE_WINDOWS: Record<string, [number, number][]> = {
  'Asia/Shanghai':    [[8, 11], [19, 22]],
  'Asia/Hong_Kong':   [[8, 11], [19, 22]],
  'Asia/Singapore':   [[10, 12], [19, 21]],
  'Asia/Seoul':       [[9, 11], [19, 22]],
  'Asia/Tokyo':       [[9, 11], [19, 22]],
  'Australia/Sydney': [[9, 11], [19, 21]],
  'America/New_York': [[8, 10], [18, 21]],
  'America/Chicago':  [[9, 11], [18, 21]],
  'America/Los_Angeles': [[9, 11], [19, 22]],
  'Europe/London':    [[9, 12], [18, 20]],
  'Europe/Paris':     [[9, 12], [18, 21]],
  'Europe/Berlin':    [[9, 12], [18, 21]],
};

function isInActiveWindow(timezone: string): boolean {
  const windows = ACTIVE_WINDOWS[timezone] || [[9, 17]];
  const userDate = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const hour = userDate.getHours();
  for (const [start, end] of windows) {
    if (hour >= start && hour < end) return true;
  }
  return false;
}

// ── Count posts published today (UTC day boundary for simplicity) ──

async function countPublishedToday(botId: string): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const countRes: any = await postJson('/api/content/pipeline/count-today', { botId, dayStart: todayStart.getTime() });
  return countRes?.count ?? 0;
}

// ── Pick up a pending publish task ──

async function claimPendingTask(): Promise<any | null> {
  // Get pending task for this bot
  const res: any = await getJson(`/api/content/pipeline/bot-queue?limit=1&status=pending&botId=${encodeURIComponent(BOT_ID)}`);
  const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
  if (tasks.length === 0) return null;
  return tasks[0];
}

// ── Helper: random delay ──

function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Helper: check if char is Chinese ──

function isChineseChar(c: string): boolean {
  const code = c.charCodeAt(0);
  return (code >= 0x4e00 && code <= 0x9fff) ||
         (code >= 0x3400 && code <= 0x4dbf) ||
         (code >= 0xf900 && code <= 0xfaff) ||
         (code >= 0x20000 && code <= 0x2a6df);
}

// ── Helper: simulate human typing (not paste!) ──

async function simulateTyping(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea[placeholder*="Write a caption"], textarea[placeholder*="write a caption"], div[contenteditable="true"], [contenteditable="true"]');

  // Find the right textarea — try all selectors
  let target: any = null;
  for (const locator of [
    page.locator('textarea[placeholder*="Write a caption"]'),
    page.locator('textarea[placeholder*="write a caption"]'),
    page.locator('div[contenteditable="true"]'),
    page.locator('[contenteditable="true"]'),
  ]) {
    try {
      if (await locator.first().isVisible({ timeout: 3000 })) {
        target = locator.first();
        break;
      }
    } catch { /* try next */ }
  }

  if (!target) {
    console.log('[publish] Could not find caption textarea, skipping typing');
    return;
  }

  // Click into textarea to focus
  await target.click();
  await sleep(jitter(300, 800));

  // Clear any existing text
  await page.keyboard.press('Control+a');
  await sleep(jitter(100, 200));
  await page.keyboard.press('Backspace');
  await sleep(jitter(200, 400));

  // Type character by character with human-like rhythm
  for (const char of text) {
    if (char === ' ') {
      await sleep(jitter(80, 150));
      await page.keyboard.press('Space');
    } else if (char === '\n') {
      await sleep(jitter(200, 400));
      await page.keyboard.press('Enter');
    } else if (isChineseChar(char)) {
      // Chinese: longer pauses (thinking time)
      await sleep(jitter(BOT_PUBLISH_TYPING_CHINESE_MIN_MS, BOT_PUBLISH_TYPING_CHINESE_MAX_MS));
      await page.keyboard.type(char);
    } else {
      // Latin characters: normal speed
      await sleep(jitter(BOT_PUBLISH_TYPING_SPEED_MIN_MS, BOT_PUBLISH_TYPING_SPEED_MAX_MS));
      await page.keyboard.type(char);
    }

    // Random long pause: simulate thinking
    if (Math.random() < BOT_PUBLISH_TYPING_LONG_PAUSE_PROB) {
      await sleep(jitter(BOT_PUBLISH_TYPING_LONG_PAUSE_MIN_MS, BOT_PUBLISH_TYPING_LONG_PAUSE_MAX_MS));
    }
  }

  // Final pause before publishing
  await sleep(jitter(BOT_PUBLISH_TYPING_FINAL_PAUSE_MIN_MS, BOT_PUBLISH_TYPING_FINAL_PAUSE_MAX_MS));

  console.log(`[publish] typed ${text.length} chars with human rhythm`);
  logBehavior('typing_complete', { charCount: text.length });
}

// ── Helper: upload image via IG upload button ──

async function uploadImage(page: Page, imagePath: string): Promise<boolean> {
  try {
    // Wait for the page to be ready
    await sleep(jitter(2000, 4000));

    // Click the "+" button to start creating a post
    console.log('[publish] looking for "+" create button...');
    const createBtn = page.locator('svg[aria-label="New post"], [aria-label="New post"], div[role="button"]:has-text("+"), a[href*="/create/"]');
    const createCount = await createBtn.count();
    
    if (createCount > 0) {
      await createBtn.first().click();
      await sleep(jitter(1500, 3000));
    } else {
      // Try navigating to create page directly
      console.log('[publish] + button not found, navigating to create page...');
      await page.goto('https://www.instagram.com/create/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(jitter(2000, 4000));
    }

    // Find the file input — IG uses hidden <input type="file">
    // We'll use Playwright's page.setInputFiles to directly set the file input
    // This is more reliable than simulating file picker dialog
    
    // Method 1: Find the drop zone or "Select from computer" button
    const selectBtn = page.locator('div[role="button"]:has-text("Select from computer"), div[role="button"]:has-text("select from computer"), label:has-text("Select from computer"), label:has-text("select from computer")');
    if (await selectBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('[publish] found "Select from computer" button');
      await selectBtn.first().click();
      await sleep(jitter(1000, 2000));
    }

    // Method 2: Use setInputFiles on the file input (most reliable)
    const fileInput = page.locator('input[type="file"]').first();
    const fileCount = await fileInput.count();
    
    if (fileCount > 0 && await fileInput.isVisible({ timeout: 1000 }).catch(() => true)) {
      const absPath = path.isAbsolute(imagePath) ? imagePath : path.join(POST_IMAGE_DIR, imagePath);
      console.log(`[publish] uploading image: ${absPath}`);
      
      // Check if file exists
      if (!fs.existsSync(absPath)) {
        console.log(`[publish] ✗ Image file not found: ${absPath}`);
        return false;
      }
      
      await fileInput.setInputFiles(absPath);
      console.log(`[publish] ✓ Image uploaded to IG`);
      await sleep(jitter(3000, 6000)); // Wait for preview to load
      
      return true;
    }

    // Method 3: If we can't find file input, try JS injection
    console.log('[publish] trying JS injection to set file input...');
    try {
      const absPath = path.isAbsolute(imagePath) ? imagePath : path.join(POST_IMAGE_DIR, imagePath);
      if (!fs.existsSync(absPath)) {
        console.log(`[publish] ✗ Image file not found: ${absPath}`);
        return false;
      }
      await page.evaluate((p: string) => {
        const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
        if (input) {
          const dataTransfer = new DataTransfer();
          // Note: We can't actually send real files via JS injection from Playwright
          // This is a fallback — setInputFiles should work
        }
      }, absPath);
      // Actually use setInputFiles
      await fileInput.setInputFiles(absPath);
      await sleep(jitter(3000, 6000));
      return true;
    } catch (err: any) {
      console.log(`[publish] JS injection failed: ${err?.message || err}`);
      return false;
    }

  } catch (err: any) {
    console.log(`[publish] upload error: ${err?.message || err}`);
    return false;
  }
}

// ── Helper: post the task via the content API ──

async function reportPublishResult(taskId: string, status: string, postUrl?: string, errorReason?: string) {
  try {
    await postJson('/api/content/pipeline/result', {
      taskId,
      status,
      postUrl: postUrl || null,
      errorReason: errorReason || null,
      botId: BOT_ID,
    });
    console.log(`[publish] result reported: ${status} for task ${taskId}`);
  } catch (err: any) {
    console.log(`[publish] result report failed: ${err?.message || err}`);
  }
}

// ── MAIN: Execute a content publish task ──

async function executeContentPublish(page: Page, task: any): Promise<boolean> {
  console.log('[publish] === START publish task ===');
  
  const taskId = task.id;
  const payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
  const caption = payload.caption || '';
  const hashtag = payload.hashtag || '';
  const imageRelPath = payload.image_path || '';
  
  if (!imageRelPath) {
    console.log('[publish] ✗ No image_path in task payload');
    return false;
  }

  // 1. Upload image
  const uploadOk = await uploadImage(page, imageRelPath);
  if (!uploadOk) {
    console.log('[publish] ✗ Image upload failed');
    await reportPublishResult(taskId, 'failed', null, 'image_upload_failed');
    return false;
  }

  // 2. Type caption (simulate human typing)
  if (caption) {
    console.log(`[publish] typing caption (${caption.length} chars)...`);
    await simulateTyping(page, caption);
  }

  // 3. Type hashtag line
  if (hashtag) {
    console.log(`[publish] typing hashtags (${hashtag.length} chars)...`);
    // Add a newline before hashtags
    await page.keyboard.press('Enter');
    await sleep(jitter(200, 500));
    await simulateTyping(page, hashtag);
  }

  // 4. Click "Share" / "发布" button
  await sleep(jitter(2000, 4000));
  console.log('[publish] looking for share button...');
  
  const shareBtn = page.locator('div[role="button"]:has-text("Share"), div[role="button"]:has-text("share"), button:has-text("Share"), button:has-text("share"), div[role="button"]:has-text("发布"), div[role="button"]:has-text("发布"), [type="submit"]');
  const shareCount = await shareBtn.count();
  
  if (shareCount > 0) {
    // Move mouse toward the button (human-like)
    const box = await shareBtn.first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(jitter(500, 1500)); // pause over button before clicking
    }
    await shareBtn.first().click();
    console.log('[publish] ✓ Share button clicked');
  } else {
    // Try pressing Enter as fallback
    console.log('[publish] Share button not found, trying Enter key');
    await page.keyboard.press('Enter');
  }

  // 5. Wait for confirmation
  await sleep(jitter(5000, 10000));
  
  // Check if publish succeeded
  const success = !page.url().includes('/create/') && 
                  !page.url().includes('/create');
  
  if (success) {
    const postUrl = page.url();
    console.log(`[publish] ✓ Post published: ${postUrl}`);
    await reportPublishResult(taskId, 'done', postUrl);
    logBehavior('publish_done', { taskId, postUrl });
    return true;
  } else {
    console.log('[publish] ✗ Publish may have failed — still on create page');
    await reportPublishResult(taskId, 'failed', null, 'still_on_create_page');
    return false;
  }
}

// ── Check and execute publish tasks ──

let _publishTimezone = '';
let _publishCheckedToday = false;
let _todayPublishedCount = 0;

async function checkAndPublish(page: Page): Promise<boolean> {
  if (!BOT_CONTENT_PUBLISH_ENABLED) return false;
  if (_publishCheckedToday && _todayPublishedCount >= BOT_PUBLISH_MAX_PER_DAY) return false;

  // Detect timezone
  if (!_publishTimezone) {
    _publishTimezone = await detectTimezone();
  }

  // Check if in active window
  if (!isInActiveWindow(_publishTimezone)) {
    return false; // Not in active hours, skip
  }

  // Check today's publish count (only if we haven't checked yet)
  if (!_publishCheckedToday) {
    _todayPublishedCount = await countPublishedToday(BOT_ID);
    _publishCheckedToday = true;
  }

  if (_todayPublishedCount >= BOT_PUBLISH_MAX_PER_DAY) {
    return false; // Already published today
  }

  // Try to claim a pending task
  const task = await claimPendingTask();
  if (!task) return false;

  console.log(`[publish] claimed task: ${task.id}`);
  
  try {
    // Lock the task via claim API
    const claimRes: any = await postJson('/api/content/pipeline/claim', { taskId: task.id, botId: BOT_ID });
    if (!claimRes?.ok) {
      console.log(`[publish] ✗ claim failed: ${claimRes?.error}`);
      return false;
    }
    
    // Execute the publish
    const ok = await executeContentPublish(page, task);
    
    if (ok) {
      _todayPublishedCount++;
      if (_todayPublishedCount >= BOT_PUBLISH_MAX_PER_DAY) {
        console.log(`[publish] reached daily limit (${BOT_PUBLISH_MAX_PER_DAY})`);
      }
    }
    
    return ok;
  } catch (err: any) {
    console.log(`[publish] task execution error: ${err?.message || err}`);
    await reportPublishResult(task.id, 'failed', null, String(err?.message || 'execution_error'));
    return false;
  }
}

// ── Reset daily counters at midnight ──

let _lastResetDate = new Date().toDateString();

function maybeResetDailyCounters() {
  const today = new Date().toDateString();
  if (today !== _lastResetDate) {
    _lastResetDate = today;
    _publishCheckedToday = false;
    _todayPublishedCount = 0;
    _publishTimezone = ''; // Refresh timezone
    console.log('[publish] daily counters reset');
  }
}


const pollLoop = async () => {
  // ── Health check before starting tasks ──
  try {
    const health = await checkAccountHealth();
    if (!await handleHealthResult(health)) {
      console.log('[poll] account health check failed — skipping poll loop');
      return;
    }
  } catch (err: any) {
    console.error('[poll] health check error:', err?.message?.slice(0, 200));
  }

  // Load profile for this bot — risk/archetype drive rest intervals
  let botProfile: ReturnType<typeof getBotProfile> | null = null;
  const loadProfile = () => { botProfile = getBotProfile(BOT_ID); console.log(`[bot-cloak] profile: ${botProfile.archetype} (risk=${botProfile.riskProfile})`); };
  loadProfile();

  let consecutiveBrowserFails = 0;
  let tasksSinceLastDm = 0;
  let tasksSinceLastLearn = 0;
  const DM_CHECK_INTERVAL = 3; // check for DM tasks every N browse tasks
  const LEARN_INTERVAL = 20;   // run behavior analysis every N tasks
  while (running) {
    try {
      const taskTypeParam = BOT_TASK_TYPE ? `&taskType=${encodeURIComponent(BOT_TASK_TYPE)}` : '';
      const data = await getJson(`/api/automation/poll?botId=${encodeURIComponent(BOT_ID)}&limit=${POLL_LIMIT}${taskTypeParam}`);
      const commands: CommandPayload[] = Array.isArray(data?.commands) ? data.commands : [];
      if (!commands.length) {
        consecutiveBrowserFails = 0;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // Only process ONE command per poll cycle to avoid navigation races
      const cmd = commands[0];
      if (running) {
        await humanBreak(); // wait if currently in a break period
        try {
          await executeCommand(cmd);
          await reportCommand(cmd.id, 'done');
          console.log(`[bot-cloak] done ${cmd.id}`);
          consecutiveBrowserFails = 0;
          tasksSinceLastDm++;
          tasksSinceLastLearn++;

          // Every DM_CHECK_INTERVAL tasks, try to send a DM instead of just resting
          if (tasksSinceLastDm >= DM_CHECK_INTERVAL) {
            tasksSinceLastDm = 0;
            console.log(`[bot-cloak] checking for DM marketing tasks...`);
            await maybeScheduleBreak();
            await sleep(jitter(6000, 12000)); // shorter rest before DM
            try {
              const dmDone = await tryExecuteDmTask();
              if (dmDone) {
                console.log(`[bot-cloak] DM task executed, resting afterwards`);
                await sleep(jitter(15000, 30000)); // longer rest after DM
              } else {
                // No pending DM tasks — check for DM replies instead
                const replied = await checkDmReplies();
                if (replied > 0) {
                  console.log(`[bot-cloak] handled ${replied} DM replies`);
                  await sleep(jitter(10000, 20000));
                } else {
                  // Also check own post comments for engagement
                  const commentReplies = await checkOwnPostComments();
                  if (commentReplies > 0) {
                    console.log(`[bot-cloak] replied to ${commentReplies} comments`);
                    await sleep(jitter(8000, 15000));
                  } else {
                    await sleep(jitter(8000, 15000));
                  }
                }
              }
            } catch (err: any) {
              console.error(`[bot-cloak] DM check error:`, err?.message || err);
              await sleep(jitter(12000, 25000));
            }
          } else {
            await maybeScheduleBreak();
            await sleep(jitter(12000, 25000)); // long gap between tasks to avoid IG detection
          }

          // ── Content Publish check (independent of browse tasks) ──
          maybeResetDailyCounters();
          const publishTask = await checkAndPublish(page);
          if (publishTask) {
            console.log(`[bot-cloak] publish task executed, resting afterwards`);
            await sleep(jitter(15000, 30000));
          }

          // Periodic behavior learning analysis
          if (tasksSinceLastLearn >= LEARN_INTERVAL) {
            tasksSinceLastLearn = 0;
            postJson('/api/bot/learn/analyze', { botId: BOT_ID }).catch(() => {});
          }
        } catch (err: any) {
          const reason = String(err?.message || 'worker_exception');
          console.error(`[bot-cloak] failed ${cmd?.id || 'unknown'}:`, reason);
          logBehavior('task_failed', { commandId: cmd?.id || null, reason });
          if (cmd?.id) {
            try { await reportCommand(cmd.id, 'failed', reason); } catch {}
          }
          // Browser death: back off before next command
          if (reason.includes('browser has been closed') || reason.includes('Target page')) {
            consecutiveBrowserFails++;
            const backoffMs = Math.min(300000, consecutiveBrowserFails * 15000);
            console.log(`[bot-cloak] browser error, backoff ${Math.round(backoffMs / 1000)}s`);
            await sleep(backoffMs);
          }
        }
      }
    } catch (err: any) {
      const reason = String(err?.message || '');
      console.error('[bot-cloak] poll error:', reason);
      if (reason.includes('launchPersistentContext') || reason.includes('browser has been closed')) {
        consecutiveBrowserFails++;
        const backoffMs = Math.min(600000, consecutiveBrowserFails * 30000);
        console.log(`[bot-cloak] browser poll error, backoff ${Math.round(backoffMs / 1000)}s`);
        await sleep(backoffMs);
      } else {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }
};

const heartbeatLoop = async () => {
  while (running) {
    try {
      await heartbeatBot();
      await sleep(HEARTBEAT_INTERVAL_MS);
    } catch (err: any) {
      console.error('[bot-cloak] heartbeat error:', err?.message || err);
      await sleep(Math.min(HEARTBEAT_INTERVAL_MS, 5000));
    }
  }
};

const shutdown = async (signal: string) => {
  console.log(`[bot-cloak] shutdown on ${signal}`);
  running = false;
  try {
    if (context) await (context as any).close?.();
  } catch {}
  releaseSingleInstance();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

const main = async () => {
  ensureSingleInstance();
  console.log(`[bot-cloak] pid=${process.pid}`);
  printProfile(BOT_PROFILE);
  console.log('[bot-cloak] starting CloakBrowser with config:', {
    API_BASE, BOT_ID, BOT_HOST, BOT_VERSION, ACCOUNT_IDS, POLL_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, PROFILE_DIR, HEADLESS,
    browser: 'CloakBrowser (stealth Chromium, 49 C++ patches)',
    humanize: !(process.env.BOT_HUMANIZE === 'false'),
    pollLimit: POLL_LIMIT,
    minVisibleTiles: BOT_MIN_VISIBLE_TILES,
    execMode: BOT_EXEC_MODE,
    speedFactor: BOT_SPEED_FACTOR,
    variance: BOT_VARIANCE,
    browseOrder: BOT_BROWSE_ORDER,
    behaviorLog: BEHAVIOR_LOG_FILE,
    proxyEnabled: Boolean(BOT_PROXY_SERVER),
    proxyServer: BOT_PROXY_SERVER || null,
    commentEnabled: BOT_COMMENT_ENABLED,
  });
  // Fetch learned profile adjustments from server
  try {
    const profileData = await getJson(`/api/bot/profile/${encodeURIComponent(BOT_ID)}`);
    const merged = profileData?.profile;
    if (merged?._meta?.adjusted) {
      console.log(`[bot-cloak] learned adjustments:`, merged._meta.adjustments);
      // Override strategy-related env vars if needed
      if (merged.strategies?.browseDepth === 'surface' || merged.strategies?.browseDepth === 'light') {
        process.env.BOT_MIN_VISIBLE_TILES = '3';
      }
      if (merged.strategies?.riskProfile === 'ultra_cautious' || merged.strategies?.riskProfile === 'cautious') {
        process.env.BOT_BREAK_EVERY_N = '2';
      }
    }
  } catch {}
  // 评论生成由 buildCommentText 按需调用 supply-bot
  await registerBot();
  await ensureBrowser();
};

// ────────────────────────────────────────────────────────────
// Account Health Check — detect banned/suspended/deactivated accounts
//
// Called after ensureBrowser() succeeds, before any task execution.
// Three detection signals:
//   1. Redirect to login/challenge page (login wall)
//   2. Page title/body contains ban/suspension keywords
//   3. Follower count suddenly dropped to 0 (compared to last check)
//
// On detection: reports to server, logs, skips all tasks for this bot.
// ────────────────────────────────────────────────────────────

// Persistent store for last known follower counts (survives across browser restarts)
const HEALTH_STATE_FILE = path.resolve(process.cwd(), 'data', 'health_state.json');

interface HealthState {
  lastCheckAt: number;
  lastStatus: 'unknown' | 'healthy' | 'banned' | 'suspended' | 'deactivated' | 'challenge';
  lastFollowers?: number;
  consecutiveFailures: number;
  lastError?: string;
}

function loadHealthState(): HealthState {
  try {
    const raw = fs.readFileSync(HEALTH_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      lastCheckAt: parsed.lastCheckAt || 0,
      lastStatus: parsed.lastStatus || 'unknown',
      lastFollowers: parsed.lastFollowers,
      consecutiveFailures: parsed.consecutiveFailures || 0,
      lastError: parsed.lastError,
    };
  } catch {
    return { lastCheckAt: 0, lastStatus: 'unknown', consecutiveFailures: 0 };
  }
}

function saveHealthState(state: HealthState): void {
  try {
    fs.writeFileSync(HEALTH_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

const BAN_PATTERNS = [
  // IG standardized error messages (English - all language versions have same HTML structure)
  "sorry, this page isn't available",
  "the link you followed may be broken",
  "page not found",
  "user not found",
  "couldn't find this account",
  "this content is no longer available",
  "account suspended",
  "account deactivated",
  "account disabled",
  "access restricted",
];

/**
 * Health check: visit own profile and look for ban signals.
 * Returns { status: 'healthy' | 'banned' | 'challenge' | 'error', error?: string, followers?: number }
 */
async function checkAccountHealth(): Promise<{
  status: 'healthy' | 'banned' | 'challenge' | 'error';
  error?: string;
  followers?: number;
  url?: string;
}> {
  if (!page || ACCOUNT_IDS.length === 0) {
    return { status: 'error', error: 'no page or account' };
  }

  // Use the primary account (first in list)
  const primaryAccount = ACCOUNT_IDS[0];
  const profileUrl = `${IG_BASE}/${primaryAccount}/`;

  try {
    // Navigate to own profile
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(jitter(2000, 4000)); // let page fully load

    const currentUrl = page.url().toLowerCase();

    // Signal 1: Redirected to login/challenge
    if (currentUrl.includes('/accounts/login')) {
      return { status: 'challenge', url: currentUrl };
    }
    if (currentUrl.includes('/challenge/') || currentUrl.includes('/account_recovery/')) {
      return { status: 'challenge', url: currentUrl };
    }

    // Signal 2: Ban/suspension keywords in page title + body
    let pageText = '';
    try { pageText = (await page.title()).toLowerCase(); } catch {}

    try {
      const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      pageText += ' ' + body.toLowerCase();
    } catch {}

    for (const pat of BAN_PATTERNS) {
      if (pageText.includes(pat)) {
        return { status: 'banned', url: currentUrl };
      }
    }

    // Signal 3: Extract follower count for anomaly detection
    const followerTexts = pageText.match(/\d[\d,. ]*\s*(followers?|follow)?/gi) || [];
    let followers = 0;
    // Try to find follower count from profile stats
    // Common patterns: "1.2K followers", "12,345 followers", "1.2k FOLLOWS"
    const followerPatterns = [
      /(\d[\d,. ]*k?)\s*followers?\s*$/mi,
      /(\d[\d,. ]*k?)\s*follows?\s*$/mi,
    ];
    for (const textNode of followerTexts) {
      const m = textNode.match(/(\d[\d,.]*k?)/i);
      if (m) {
        const val = parseCompactNumber(m[1]);
        if (val > followers) followers = val;
      }
    }

    // Also try IG's meta description for follower count
    try {
      const metaFollowers = await page.evaluate(() => {
        const el = document.querySelector('meta[name="description"]');
        if (!el) return 0;
        const m = String(el.getAttribute('content') || '').match(/(\d[\d,. ]*k?)\s*followers?/i);
        return m ? parseCompactNumber(m[1]) : 0;
      });
      if (metaFollowers > followers) followers = metaFollowers;
    } catch {}

    // Signal 4: Follower count anomaly (0 or sudden >80% drop)
    const state = loadHealthState();
    if (state.lastStatus === 'healthy' && state.lastFollowers && state.lastFollowers > 0) {
      if (followers === 0) {
        console.log(`[health] ⚠ Follower count dropped to 0 (was ${state.lastFollowers}). Account may be suspended.`);
        return { status: 'banned', followers, url: currentUrl };
      }
      const dropRatio = 1 - (followers / state.lastFollowers);
      if (dropRatio > 0.8) {
        console.log(`[health] ⚠ Follower count dropped ${Math.round(dropRatio * 100)}% (${state.lastFollowers} → ${followers}). Account may be restricted.`);
        // Don't immediately mark as banned on first drop — one more check
      }
    }

    return { status: 'healthy', followers, url: currentUrl };

  } catch (err: any) {
    return { status: 'error', error: err.message?.slice(0, 200) };
  }
}

/**
 * Handle health check results:
 * - healthy: save state, continue
 * - banned/challenge: report to server, skip all tasks
 * - error: log, allow retry next cycle
 */
async function handleHealthResult(result: {
  status: 'healthy' | 'banned' | 'challenge' | 'error';
  error?: string;
  followers?: number;
  url?: string;
}): Promise<boolean> {
  // Returns true if account is healthy and can continue tasks

  const state = loadHealthState();

  if (result.status === 'healthy') {
    state.lastStatus = 'healthy';
    state.lastFollowers = result.followers;
    state.consecutiveFailures = 0;
    state.lastCheckAt = Date.now();
    saveHealthState(state);
    console.log(`[health] ✓ ${ACCOUNT_IDS[0]} is healthy${result.followers ? ` (${result.followers} followers)` : ''}`);
    return true;
  }

  if (result.status === 'banned') {
    state.lastStatus = 'banned';
    state.consecutiveFailures++;
    state.lastCheckAt = Date.now();
    state.lastError = result.url || 'banned detected';
    saveHealthState(state);

    console.log(`[health] ⛔ Account ${ACCOUNT_IDS[0]} BAN DETECTED! (URL: ${result.url || 'N/A'})`);
    console.log(`[health] → This bot will skip all tasks. Manual intervention required.`);
    console.log(`[health] → Update bot_registry.json with new proxy, new IG account, new fingerprint.`);

    // Report to server for centralized monitoring
    try {
      await postJson('/api/bot/health-report', {
        botId: BOT_ID,
        accountIds: ACCOUNT_IDS,
        status: 'banned',
        url: result.url || '',
        consecutiveFailures: state.consecutiveFailures,
        timestamp: Date.now(),
      });
    } catch { /* best effort */ }

    return false;
  }

  if (result.status === 'challenge') {
    state.lastStatus = 'challenge';
    state.consecutiveFailures++;
    state.lastCheckAt = Date.now();
    state.lastError = result.url || 'challenge page';
    saveHealthState(state);

    console.log(`[health] ⚠ Account ${ACCOUNT_IDS[0]} in CHALLENGE (URL: ${result.url || 'N/A'})`);
    console.log(`[health] → May need re-authentication. Skipping tasks.`);

    try {
      await postJson('/api/bot/health-report', {
        botId: BOT_ID,
        accountIds: ACCOUNT_IDS,
        status: 'challenge',
        url: result.url || '',
        consecutiveFailures: state.consecutiveFailures,
        timestamp: Date.now(),
      });
    } catch { /* best effort */ }

    return false;
  }

  // Error (network issue, timeout, etc.) — allow retry
  state.lastStatus = result.error ? 'error' : state.lastStatus;
  state.lastCheckAt = Date.now();
  state.lastError = result.error || 'unknown';
  saveHealthState(state);

  console.log(`[health] ⚠ Health check error: ${result.error || 'unknown'}`);
  return true; // Allow retry next cycle
}

export { main };

// When run directly (not imported by a wrapper), auto-start
const entryFile = process.argv[1]?.replace(/\\/g, '/');
if (entryFile?.includes('bot-worker-cloak')) {
  main().catch((err) => {
    console.error('[bot-cloak] fatal:', err);
    process.exit(1);
  });
}
