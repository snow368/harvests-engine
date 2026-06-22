/* eslint-disable no-console */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorker } from 'tesseract.js';
import { generateComment, getFromPool, refillPool, clearRecentHistory } from './comment-generator';
import { detectPostType } from './tattoo-voice';


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
};

const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const BOT_ID = process.env.BOT_ID || `bot_${Math.random().toString(36).slice(2, 8)}`;
const BOT_HOST = process.env.BOT_HOST || process.env.HOSTNAME || 'local-dev';
const BOT_VERSION = process.env.BOT_VERSION || '0.2.0-real';
const ACCOUNT_IDS = (process.env.BOT_ACCOUNT_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
const BOT_API_KEY = (process.env.BOT_API_KEY || '').trim();
const BOT_API_TOKEN = (process.env.BOT_API_TOKEN || 'vps-bot-secret-2024').trim();
const POLL_INTERVAL_MS = Math.max(1500, Number(process.env.BOT_POLL_INTERVAL_MS || 4000));
const POLL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BOT_POLL_LIMIT || 1)));
const HEARTBEAT_INTERVAL_MS = Math.max(5000, Number(process.env.BOT_HEARTBEAT_INTERVAL_MS || 15000));
const IG_BASE = (process.env.INSTAGRAM_BASE || 'https://www.instagram.com').replace(/\/+$/, '');
const PROFILE_DIR = process.env.BOT_PROFILE_DIR || `./data/bot_profiles/${BOT_ID}`;
const HEADLESS = String(process.env.BOT_HEADLESS || 'false').toLowerCase() === 'true';
const BOT_CDP_URL = (process.env.BOT_CDP_URL || '').trim();
const BOT_LAUNCH_MODE = (process.env.BOT_LAUNCH_MODE || 'cdp').trim().toLowerCase(); // cdp | persistent
const BOT_EXEC_MODE = (process.env.BOT_EXEC_MODE || 'browse_only').trim().toLowerCase(); // browse_only | browse_like
const BOT_HUMAN_BREAK_MIN_MS = Math.max(60_000, Number(process.env.BOT_HUMAN_BREAK_MIN_MS || 5 * 60_000)); // min break 5 min
const BOT_HUMAN_BREAK_MAX_MS = Math.max(BOT_HUMAN_BREAK_MIN_MS, Number(process.env.BOT_HUMAN_BREAK_MAX_MS || 15 * 60_000)); // max break 15 min
const BOT_BREAK_EVERY_N = Math.max(2, Math.min(10, Number(process.env.BOT_BREAK_EVERY_N || 4))); // break every ~4 profiles
const HUMAN_MIMICRY_ENABLED = String(process.env.HUMAN_MIMICRY_ENABLED || 'true').toLowerCase() === 'true';
const BOT_SPEED_FACTOR = Math.max(0.8, Number(process.env.BOT_SPEED_FACTOR || 1.0)); // 1.0 baseline, higher = slower
const BOT_VARIANCE = Math.min(0.8, Math.max(0, Number(process.env.BOT_VARIANCE || 0.25))); // per-bot elastic variance
const BOT_BROWSE_ORDER = (process.env.BOT_BROWSE_ORDER || 'random').trim().toLowerCase(); // random | newest | mixed
const BOT_MIN_VISIBLE_TILES = Math.max(2, Math.min(12, Number(process.env.BOT_MIN_VISIBLE_TILES || 6)));
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
const BOT_FOLLOW_ENABLED = String(process.env.BOT_FOLLOW_ENABLED || 'false').toLowerCase() === 'true';
const BOT_FOLLOW_DAILY_MIN = Math.max(0, Math.min(30, Number(process.env.BOT_FOLLOW_DAILY_MIN || 2)));
const BOT_FOLLOW_DAILY_MAX = Math.max(BOT_FOLLOW_DAILY_MIN, Math.min(50, Number(process.env.BOT_FOLLOW_DAILY_MAX || 6)));
const BOT_FOLLOW_MIN_TOUCHES = Math.max(1, Number(process.env.BOT_FOLLOW_MIN_TOUCHES || 2)); // must have >= N visits before follow
const BOT_DAILY_BROWSE_TARGET_NEW = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_NEW || 25));
const BOT_DAILY_BROWSE_TARGET_TRANSITION = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_TRANSITION || 50));
const BOT_DAILY_BROWSE_TARGET_STABLE = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_STABLE || 80));

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
// Cloud behavior log buffer — flushed during heartbeat
const behaviorBuffer: Record<string, any>[] = [];
const FLUSH_AT = 20; // flush every 20 events

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
let lastAccountStage = 'stable';
let lastIndustry: string | undefined = 'tattoo'; // default: tattoo industry

// Rest-time noise sites — navigated in the SAME IG tab, not new tabs.
const NOISE_SITES = ['https://www.cnn.com', 'https://www.oregonlive.com', 'https://www.youtube.com'];

const humanBreak = async () => {
  const now = Date.now();
  if (now < breakUntil) {
    const remaining = breakUntil - now;
    console.log(`[bot-real] human break: ${Math.round(remaining / 1000)}s remaining (stage=${lastAccountStage})...`);
    // Navigate the existing IG tab to a noise site during rest, then back to IG.
    if (page && remaining > 30_000) {
      const prevUrl = IG_BASE;
      const noiseUrl = NOISE_SITES[Math.floor(Math.random() * NOISE_SITES.length)];
      try {
        await page.goto(noiseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // Idle on the noise site for a bit.
        await sleep(Math.min(remaining * 0.6, 60000));
      } catch {}
      // Back to IG before next task.
      try {
        await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {}
    }
    // Fallback sleep if any time remains.
    const left = breakUntil - Date.now();
    if (left > 0) await sleep(left);
  }
};

// Schedule next break — frequency & duration depend on account stage.
let profilesSinceBreak = 0;
const getBreakThreshold = (stage) => {
  const s = String(stage || '').toLowerCase();
  if (s === 'new') return 1 + Math.floor(Math.random() * 2);
  if (s === 'transition') return 2 + Math.floor(Math.random() * 2);
  if (s === 'growing') return 3 + Math.floor(Math.random() * 3);
  if (s === 'mature') return 5 + Math.floor(Math.random() * 4);
  return 4 + Math.floor(Math.random() * 3); // stable/unknown
};
const getBreakDuration = (stage) => {
  const s = String(stage || '').toLowerCase();
  if (s === 'new') return jitter(3 * 60_000, 8 * 60_000);
  if (s === 'transition') return jitter(5 * 60_000, 10 * 60_000);
  if (s === 'mature') return jitter(5 * 60_000, 15 * 60_000);
  return jitter(BOT_HUMAN_BREAK_MIN_MS, BOT_HUMAN_BREAK_MAX_MS);
};
const maybeScheduleBreak = async (command) => {
  const stage = String(command?.accountStage || lastAccountStage || 'stable').toLowerCase();
  lastAccountStage = stage;
  if (command?.industry) lastIndustry = String(command.industry);
  profilesSinceBreak++;
  const threshold = getBreakThreshold(stage);
  if (profilesSinceBreak >= threshold) {
    const dur = getBreakDuration(stage);
    breakUntil = Date.now() + dur;
    profilesSinceBreak = 0;
    logBehavior('human_break_start', { breakMs: dur, breakUntil: new Date(breakUntil).toISOString(), stage });
    console.log(`[bot-real] break ${Math.round(dur / 1000)}s (stage=${stage}, threshold=${threshold})`);
  }
};

// Human-like mouse movement: gently move cursor to a random point in the viewport.
const humanMouseMove = async () => {
  if (!page || Math.random() > 0.4) return; // only ~60% chance
  try {
    const vp = page.viewportSize() || { width: 1280, height: 900 };
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
const logBehavior = (event: string, data: Record<string, any> = {}) => {
  try {
    const row = {
      ts: new Date().toISOString(),
      botId: BOT_ID,
      event,
      ...data
    };
    fs.appendFileSync(BEHAVIOR_LOG_FILE, JSON.stringify(row) + '\n', 'utf8');
    // Also push to cloud buffer for frontend display
    behaviorBuffer.push(row);
  } catch {}
};

const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BOT_API_KEY) headers['x-bot-key'] = BOT_API_KEY;
  if (BOT_API_TOKEN) headers['Authorization'] = `Bearer ${BOT_API_TOKEN}`;
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
  // Flush behavior log buffer to cloud
  if (behaviorBuffer.length >= FLUSH_AT) {
    const batch = behaviorBuffer.splice(0);
    postJson('/api/automation/behavior-logs', { logs: batch }).catch(() => {});
  }
};

const reportCommand = async (commandId: string, status: 'done' | 'failed', reason?: string) => {
  const payload: Record<string, any> = { botId: BOT_ID, commandId, status };
  if (reason) payload.reason = reason;
  await postJson('/api/automation/report', payload);
};

const ensureBrowser = async () => {
  if (context && page) {
    try {
      const url = page.url();
      if (url && url.includes('instagram.com')) return;
    } catch {}
    context = null as any; page = null as any;
  }

  if (BOT_LAUNCH_MODE === 'persistent') {
    // Persistent context: Playwright's own browser, navigator.webdriver removed automatically.
    // Login session is saved in the profile directory.
    const profilePath = path.resolve(process.cwd(), PROFILE_DIR);
    if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
    const userDataDir = profilePath;
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: HEADLESS,
      viewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    }) as any;
    // Patch pages to hide automation
    const existingPages = (context as any).pages?.() || [];
    if (existingPages.length > 0) {
      for (const p of existingPages) {
        try {
          if (p.url().includes('instagram.com')) { page = p; break; }
        } catch {}
      }
    }
    if (!page) {
      page = await (context as any).newPage();
    }
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    if (!page.url() || !page.url().includes('instagram.com')) {
      await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.bringToFront().catch(() => {});
    console.log('[bot-real] launched persistent browser (stealth mode)');
    return;
  }

  // CDP mode (legacy): connect to an already-running Chrome.
  if (!BOT_CDP_URL) throw new Error('cdp_required_set_BOT_CDP_URL_or_use_BOT_LAUNCH_MODE_persistent');
  browser = await chromium.connectOverCDP(BOT_CDP_URL);
  context = browser.contexts()[0] || await browser.newContext();
  const existingPages = context.pages();
  if (existingPages.length > 0) {
    for (const p of existingPages) {
      try {
        const u = p.url();
        if (u && u.includes('instagram.com')) { page = p; break; }
      } catch {}
    }
  }
  if (!page) {
    page = await context.newPage();
    // Attempt anti-detection before navigation (may not fully work in CDP mode).
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
    } catch {}
    await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.bringToFront().catch(() => {});
  console.log(`[bot-real] connected via CDP: ${BOT_CDP_URL}`);
};

const reportObservation = async (command: CommandPayload, summary: BrowseSummary, profileFacts?: Record<string, any>) => {
  const payload: Record<string, any> = {
    botId: BOT_ID,
    commandId: command.id,
    artistId: command.artistId || null,
    artistHandle: command.artistHandle || null,
    mode: BOT_EXEC_MODE,
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
  // Legacy launch intentionally disabled in CDP-first workflow.
  // This prevents accidental opening of a new browser/profile.
  return;
};

const openProfile = async (handle: string) => {
  if (!page) throw new Error('page_not_initialized');
  const url = `${IG_BASE}/${handle.replace(/^@/, '')}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const dwell = jitter(1500, 3200);
  await page.waitForTimeout(dwell);
  logBehavior('open_profile', { handle, dwellMs: dwell });
  logBehavior('open_profile_done', { handle, currentUrl: page.url() });
};

const isInvalidProfilePage = async () => {
  if (!page) return false;
  const url = page.url().toLowerCase();
  if (url.includes('/accounts/login')) return true;
  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  return (
    bodyText.includes("sorry, this page isn't available") ||
    bodyText.includes('the link you followed may be broken') ||
    bodyText.includes('page not found') ||
    bodyText.includes('user not found')
  );
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
  // Instagram SPA prevents direct DOM access via CDP; use screenshot-based OCR as fallback.
  try {
    // Strategy A: try known anchor href selectors (may work on some layouts).
    let anchorFollowers = '';
    let anchorFollowing = '';
    try {
      const anchorCounts = await page.evaluate(() => {
        const getNum = (s: string) => {
          const m = String(s || '').match(/(\d[\d,.]*\s*[kKmM]?)/);
          return m?.[1] || '';
        };
        const fA = document.querySelector('a[href*="/followers/"]');
        const gA = document.querySelector('a[href*="/following/"]');
        return {
          followers: fA ? (getNum(fA.querySelector('span[title]')?.getAttribute('title') || '') || getNum(fA.textContent || '')) : '',
          following: gA ? (getNum(gA.querySelector('span[title]')?.getAttribute('title') || '') || getNum(gA.textContent || '')) : '',
        };
      }).catch(() => null);
      if (anchorCounts) {
        anchorFollowers = anchorCounts.followers || '';
        anchorFollowing = anchorCounts.following || '';
      }
    } catch {}

    const followers = parseFirstNumberLike(anchorFollowers);
    const following = parseFirstNumberLike(anchorFollowing);
    if (followers > 0) facts.followers = followers;
    if (following > 0) facts.following = following;

    // Strategy B: locator-based extraction.
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

    // Strategy C: screenshot the stats row via OCR (layout-independent).
    // Stats appear as 3 numbers (posts / followers / following) in a horizontal row.
    if (!facts.followers || !facts.following || !facts.postCount) {
      try {
        const ssDir = path.resolve(process.cwd(), 'data', 'screenshots');
        if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
        const ts = Date.now();
        const handleSlug = profileHandleFromUrl(page.url()) || 'unknown';
        const statsPath = path.join(ssDir, `${handleSlug}_${ts}_stats.png`);

        // Screenshot a narrow top strip — stats row always appears near the top.
        // Note: page.evaluate() is blocked via CDP for Instagram, so we use a fixed clip
        // that works across window sizes (the stats row is positioned near y=0 regardless).
        await page.screenshot({ path: statsPath, clip: { x: 0, y: 0, width: 700, height: 180 }, type: 'png', timeout: 8000 });
        (facts as any)._statsScreenshot = statsPath;

        // OCR the stats strip to read post/follower/following numbers.
        try {
          const worker = await createWorker('eng');
          const { data: { text } } = await worker.recognize(statsPath);
          await worker.terminate();
          const ocrText = text || '';
          (facts as any)._ocrStatsRaw = ocrText.slice(0, 200);

          // Multi-language patterns: "posts/帖子", "followers/粉丝", "following/关注"
          const postMatch = ocrText.match(/([\d,.]+\s*[kKmM]?)\s*(?:posts|post|帖子|帖|發佈|条)/i);
          const followerMatch = ocrText.match(/([\d,.]+\s*[kKmM]?)\s*(?:followers|follower|粉丝|粉絲|位)/i);
          const followingMatch = ocrText.match(/([\d,.]+\s*[kKmM]?)\s*(?:following|关注|關注|追蹤|追踪)/i);

          if (postMatch && !facts.postCount) facts.postCount = parseCompactNumber(postMatch[1]);
          if (followerMatch && !facts.followers) facts.followers = parseCompactNumber(followerMatch[1]);
          if (followingMatch && !facts.following) facts.following = parseCompactNumber(followingMatch[1]);
        } catch {}

        // Clean up screenshot after OCR to save disk space.
        try { if (fs.existsSync(statsPath)) fs.unlinkSync(statsPath); } catch {}
      } catch {}
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
  facts.categorySignals = { textPositiveHits, textNegativeHits, imagePositiveHits, imageNegativeHits };

  const positiveScore = textPositiveHits.length + imagePositiveHits.length;
  const negativeScore = textNegativeHits.length + imageNegativeHits.length;
  const handleLooksTattoo = /\b(tattoo|ink|irezumi|piercing|needle)\b/.test(handleBlob);
  const strongNegative = negativeScore >= 2;
  // Conservative safety rule: only mark as non-tattoo when negatives are strong,
  // no positives exist, and handle/url itself has no tattoo signal.
  facts.nonTattooSuspect = strongNegative && positiveScore === 0 && !handleLooksTattoo;

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
  // 优先从预热池取
  const pooled = getFromPool();
  if (pooled) {
    refillPool().catch(() => {}); // 异步补充
    return pooled;
  }

  // DeepSeek 实时生成
  const commentStyle = postMeta?.postStyle
    || getPrimaryStyle(facts)
    || '';
  const styleConf = postMeta?.styleConfidence || 'low';

  try {
    const result = await Promise.race([
      generateComment({
        caption: facts?.sampleCaption?.slice(0, 300) || postMeta?.caption?.slice(0, 300),
        imageAlt: facts?.imageAltHints?.join(' ').slice(0, 200),
        artistHandle: facts?.title?.replace(/[\(\)@]/g, '').trim(),
        style: commentStyle,
        styleConfidence: styleConf,
        likeCount: postMeta?.likeCount,
        commentCount: postMeta?.commentCount,
        isReel: postMeta?.isReel,
      }),
      new Promise<{ text: string }>((_, reject) =>
        setTimeout(() => reject(new Error('comment_gen_timeout')), 8000)
      ),
    ]);
    // 异步补充池子
    refillPool().catch(() => {});
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

  const chars = text.split('');
  const useDistractedTyping = Math.random() < 0.3; // 30% chance of "distracted" typing

  if (!useDistractedTyping) {
    // Mode A (70%): steady typing with natural pauses
    for (let i = 0; i < chars.length; i++) {
      await textarea.press(chars[i]);
      await page.waitForTimeout(jitter(50, 200));
      if (i > 0 && i % 12 === 0) await page.waitForTimeout(jitter(300, 900));
    }
  } else {
    // Mode B (30%): chunked typing — type a few words, pause, scroll, come back
    let i = 0;
    while (i < chars.length) {
      const chunkSize = randInt(3, 8);
      const end = Math.min(i + chunkSize, chars.length);
      for (let j = i; j < end; j++) {
        await textarea.press(chars[j]);
        await page.waitForTimeout(jitter(45, 160));
      }
      i = end;
      if (i >= chars.length) break;

      // Distraction: scroll post slightly, pause, then resume typing
      const distraction = Math.random();
      if (distraction < 0.4) {
        // Slight scroll like re-reading the image
        await page.mouse.wheel(0, randInt(-80, 80));
        await page.waitForTimeout(jitter(600, 1500));
      } else if (distraction < 0.7) {
        // Just pause like thinking
        await page.waitForTimeout(jitter(800, 2500));
      } else {
        // Move cursor back a few chars, then retype (simulate typo correction)
        for (let k = 0; k < randInt(1, 3); k++) {
          await textarea.press('Backspace');
          await page.waitForTimeout(jitter(80, 250));
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
  const dialogText = normalizeForMatch(
    (await page.locator('div[role="dialog"]').first().innerText().catch(() => '')) || ''
  );
  const likesMatch = dialogText.match(/(\d[\d,\.]*)\s+likes?\b/i);
  const commentsMatch = dialogText.match(/view all\s+(\d[\d,\.]*)\s+comments?\b/i);
  const likeCount = likesMatch?.[1] ? Number(String(likesMatch[1]).replace(/[^\d]/g, '')) : 0;
  const commentCount = commentsMatch?.[1] ? Number(String(commentsMatch[1]).replace(/[^\d]/g, '')) : 0;
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
      const likeBtn = page.locator('svg[aria-label="Like"]').first();
      if ((await likeBtn.count()) > 0) {
        await likeBtn.click({ timeout: 8000 });
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
        const btn = page.locator('button').filter({ hasText: /Like/i }).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 8000 });
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
        }
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

const executeCommand = async (command: CommandPayload) => {
  const commandId = command.id;
  const handle = String(command.artistHandle || '').replace(/^@/, '').trim();
  if (!handle) throw new Error('missing_artist_handle');
  const taskModeRaw = String(command?.suggestedExecMode || '').trim().toLowerCase();
  const execMode = (taskModeRaw === 'browse_only' || taskModeRaw === 'browse_like') ? taskModeRaw : BOT_EXEC_MODE;
  const stage = String(command?.accountStage || '').trim().toLowerCase() || 'stable';
  const age = Number(command?.accountAgeDays) ?? -1;
  console.log(`[bot-real] execute ${commandId} -> @${handle} [stage=${stage}, age=${age}d, mode=${execMode}]`);
  logBehavior('task_start', { commandId, handle, mode: execMode, suggestedExecMode: taskModeRaw || null, accountStage: stage, accountAgeDays: age });
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
  if (profileFacts?.nonTattooSuspect) {
    logBehavior('non_tattoo_profile', { commandId, handle, title: profileFacts.title, bio: profileFacts.bio });
    try {
      await reportObservation(command, { totalMedia: 0, opened: 0, desiredOpenCount: 0 }, {
        ...profileFacts,
        nonTattooSuspect: true
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

const pollLoop = async () => {
  while (running) {
    try {
      const data = await getJson(`/api/automation/poll?botId=${encodeURIComponent(BOT_ID)}&limit=${POLL_LIMIT}`);
      const commands: CommandPayload[] = Array.isArray(data?.commands) ? data.commands : [];
      if (!commands.length) {
        await humanBreak(); // also rest/noise during idle
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      for (const cmd of commands) {
        if (!running) break;
        await humanBreak(); // wait if currently in a break period
        try {
          await executeCommand(cmd);
          await reportCommand(cmd.id, 'done');
          console.log(`[bot-real] done ${cmd.id}`);
          await maybeScheduleBreak(cmd); // schedule next break after N profiles
          await sleep(jitter(3500, 9500)); // elastic gap between targets
        } catch (err: any) {
          const reason = String(err?.message || 'worker_exception');
          console.error(`[bot-real] failed ${cmd?.id || 'unknown'}:`, reason);
          logBehavior('task_failed', { commandId: cmd?.id || null, reason });
          if (cmd?.id) {
            try { await reportCommand(cmd.id, 'failed', reason); } catch {}
          }
        }
      }
    } catch (err: any) {
      console.error('[bot-real] poll error:', err?.message || err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
};

const heartbeatLoop = async () => {
  let recoverAttempts = 0;
  while (running) {
    try {
      await heartbeatBot();
      recoverAttempts = 0;
      await sleep(HEARTBEAT_INTERVAL_MS);
    } catch (err: any) {
      console.error('[bot-real] heartbeat error:', err?.message || err);
      recoverAttempts++;
      if (recoverAttempts <= 3) {
        // Re-register and re-connect after server restart
        try {
          await registerBot();
          await ensureBrowser();
          console.log('[bot-real] recovered after server restart');
        } catch (recoverErr: any) {
          console.error('[bot-real] recovery failed:', recoverErr?.message || recoverErr);
        }
      }
      await sleep(Math.min(HEARTBEAT_INTERVAL_MS, 5000));
    }
  }
};

const shutdown = async (signal: string) => {
  console.log(`[bot-real] shutdown on ${signal}`);
  running = false;
  try {
    if (BOT_LAUNCH_MODE === 'persistent') {
      if (context) await (context as any).close?.();
    } else if (BOT_CDP_URL) {
      if (browser) await browser.close();
    }
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

const main = async () => {
  console.log('[bot-real] starting with config:', {
    API_BASE, BOT_ID, BOT_HOST, BOT_VERSION, ACCOUNT_IDS, POLL_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, PROFILE_DIR, HEADLESS,
    pollLimit: POLL_LIMIT,
    minVisibleTiles: BOT_MIN_VISIBLE_TILES,
    cdpMode: Boolean(BOT_CDP_URL),
    cdpUrl: BOT_CDP_URL || null,
    execMode: BOT_EXEC_MODE,
    speedFactor: BOT_SPEED_FACTOR,
    variance: BOT_VARIANCE,
    browseOrder: BOT_BROWSE_ORDER,
    behaviorLog: BEHAVIOR_LOG_FILE,
    proxyEnabled: Boolean(BOT_PROXY_SERVER),
    proxyServer: BOT_PROXY_SERVER || null,
    commentEnabled: BOT_COMMENT_ENABLED,
  });
  // 预热评论池
  if (BOT_COMMENT_ENABLED) {
    refillPool().then(() => console.log('[bot-real] comment pool warmed up'));
  }
  await registerBot();
  await ensureBrowser();
  await Promise.all([heartbeatLoop(), pollLoop()]);
};

main().catch((err) => {
  console.error('[bot-real] fatal:', err);
  process.exit(1);
});

