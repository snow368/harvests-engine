/**
 * Human Mimicry — Bot 休息期真人行为模拟 (v2)
 *
 * 在 bot 休息期用 CDP Chrome 模拟纽约居民上网行为。
 * 7 种行为模式，每次休息随机抽一种，无固定规律。
 *
 * VPS IP: 163.245.212.169 (New York City, NY)
 *
 * 用法（由 bot-worker-real.ts 在休息期调用）：
 *   import { runHumanMimicry } from './human-mimicry';
 *   await runHumanMimicry(browser, accountId, restDurationMs);
 */

import { Browser, Page } from 'playwright';

// ============================================================
// Types
// ============================================================

type SiteCategory = 'news' | 'social' | 'shopping' | 'entertainment' | 'local' | 'music' | 'sports' | 'food' | 'travel' | 'finance' | 'industry';

type BehaviorMode =
  | 'news_reader'
  | 'casual_shopper'
  | 'social_scroller'
  | 'gamer'
  | 'researcher'
  | 'random_mix'
  | 'lazy_mode'
  | 'music_binger'
  | 'sports_fan'
  | 'foodie'
  | 'travel_planner'
  | 'finance_checker';

interface SiteDef {
  url: string;
  label: string;
  category: SiteCategory;
}

interface GameDef {
  url: string;
  label: string;
  playMinSec: number;
  playMaxSec: number;
}

interface BehaviorProfile {
  name: string;
  maxTabs: number;
  dwellMinMs: number;
  dwellMaxMs: number;
  scrollSpeed: 'slow' | 'medium' | 'fast';
  scrollBackChance: number;
  clickChance: number;
  searchChance: number;
  gameChance: number;
  preferredCategories: SiteCategory[];
}

// ============================================================
// 7 种行为模式
// ============================================================

const BEHAVIOR_PROFILES: Record<BehaviorMode, BehaviorProfile> = {
  news_reader: {
    name: 'News Reader',
    maxTabs: 3, dwellMinMs: 15000, dwellMaxMs: 60000,
    scrollSpeed: 'medium', scrollBackChance: 0.4,
    clickChance: 0.4, searchChance: 0.3, gameChance: 0,
    preferredCategories: ['news', 'local'],
  },
  casual_shopper: {
    name: 'Casual Shopper',
    maxTabs: 4, dwellMinMs: 8000, dwellMaxMs: 35000,
    scrollSpeed: 'slow', scrollBackChance: 0.5,
    clickChance: 0.5, searchChance: 0.6, gameChance: 0,
    preferredCategories: ['shopping', 'entertainment'],
  },
  social_scroller: {
    name: 'Social Scroller',
    maxTabs: 5, dwellMinMs: 3000, dwellMaxMs: 15000,
    scrollSpeed: 'fast', scrollBackChance: 0.2,
    clickChance: 0.2, searchChance: 0.3, gameChance: 0.1,
    preferredCategories: ['social', 'entertainment'],
  },
  gamer: {
    name: 'Gamer',
    maxTabs: 2, dwellMinMs: 4000, dwellMaxMs: 12000,
    scrollSpeed: 'medium', scrollBackChance: 0.3,
    clickChance: 0.1, searchChance: 0.2, gameChance: 1,
    preferredCategories: ['entertainment'],
  },
  researcher: {
    name: 'Researcher',
    maxTabs: 4, dwellMinMs: 10000, dwellMaxMs: 45000,
    scrollSpeed: 'slow', scrollBackChance: 0.6,
    clickChance: 0.6, searchChance: 1, gameChance: 0,
    preferredCategories: ['news', 'local'],
  },
  random_mix: {
    name: 'Random Mix',
    maxTabs: 4, dwellMinMs: 3000, dwellMaxMs: 40000,
    scrollSpeed: 'medium', scrollBackChance: 0.35,
    clickChance: 0.35, searchChance: 0.5, gameChance: 0.3,
    preferredCategories: ['news', 'social', 'shopping', 'entertainment', 'local'],
  },
  lazy_mode: {
    name: 'Lazy Mode',
    maxTabs: 2, dwellMinMs: 20000, dwellMaxMs: 80000,
    scrollSpeed: 'slow', scrollBackChance: 0.2,
    clickChance: 0.15, searchChance: 0.2, gameChance: 0,
    preferredCategories: ['news', 'social'],
  },
  music_binger: {
    name: 'Music Binger',
    maxTabs: 3, dwellMinMs: 15000, dwellMaxMs: 60000,
    scrollSpeed: 'slow', scrollBackChance: 0.3,
    clickChance: 0.3, searchChance: 0.4, gameChance: 0,
    preferredCategories: ['music', 'entertainment'],
  },
  sports_fan: {
    name: 'Sports Fan',
    maxTabs: 4, dwellMinMs: 10000, dwellMaxMs: 45000,
    scrollSpeed: 'medium', scrollBackChance: 0.4,
    clickChance: 0.5, searchChance: 0.3, gameChance: 0,
    preferredCategories: ['sports', 'news', 'local'],
  },
  foodie: {
    name: 'Foodie',
    maxTabs: 4, dwellMinMs: 8000, dwellMaxMs: 35000,
    scrollSpeed: 'slow', scrollBackChance: 0.5,
    clickChance: 0.5, searchChance: 0.7, gameChance: 0,
    preferredCategories: ['food', 'local', 'shopping'],
  },
  travel_planner: {
    name: 'Travel Planner',
    maxTabs: 4, dwellMinMs: 12000, dwellMaxMs: 50000,
    scrollSpeed: 'medium', scrollBackChance: 0.4,
    clickChance: 0.5, searchChance: 0.7, gameChance: 0,
    preferredCategories: ['travel', 'local', 'entertainment'],
  },
  finance_checker: {
    name: 'Finance Checker',
    maxTabs: 3, dwellMinMs: 8000, dwellMaxMs: 30000,
    scrollSpeed: 'medium', scrollBackChance: 0.3,
    clickChance: 0.3, searchChance: 0.6, gameChance: 0,
    preferredCategories: ['finance', 'news'],
  },
  industry_pro: {
    name: 'Industry Pro',
    maxTabs: 4, dwellMinMs: 10000, dwellMaxMs: 40000,
    scrollSpeed: 'slow', scrollBackChance: 0.5,
    clickChance: 0.5, searchChance: 0.4, gameChance: 0,
    preferredCategories: ['industry', 'social', 'shopping', 'entertainment'],
  },
  tattoo_artist: {
    name: 'Tattoo Artist',
    maxTabs: 3, dwellMinMs: 15000, dwellMaxMs: 50000,
    scrollSpeed: 'slow', scrollBackChance: 0.4,
    clickChance: 0.4, searchChance: 0.3, gameChance: 0,
    preferredCategories: ['industry', 'social', 'entertainment', 'music'],
  },
};

const MODE_WEIGHTS = [
  { mode: 'news_reader' as BehaviorMode, weight: 20 },
  { mode: 'casual_shopper' as BehaviorMode, weight: 15 },
  { mode: 'social_scroller' as BehaviorMode, weight: 20 },
  { mode: 'gamer' as BehaviorMode, weight: 10 },
  { mode: 'researcher' as BehaviorMode, weight: 15 },
  { mode: 'random_mix' as BehaviorMode, weight: 15 },
  { mode: 'lazy_mode' as BehaviorMode, weight: 5 },
  { mode: 'music_binger' as BehaviorMode, weight: 8 },
  { mode: 'sports_fan' as BehaviorMode, weight: 10 },
  { mode: 'foodie' as BehaviorMode, weight: 12 },
  { mode: 'travel_planner' as BehaviorMode, weight: 8 },
  { mode: 'finance_checker' as BehaviorMode, weight: 7 },
  { mode: 'industry_pro' as BehaviorMode, weight: 15 },
  { mode: 'tattoo_artist' as BehaviorMode, weight: 12 },
];

// ============================================================
// Site Pool — NYC themed
// ============================================================

const SITE_POOL: SiteDef[] = [
  { url: 'https://www.cnn.com', label: 'CNN', category: 'news' },
  { url: 'https://www.foxnews.com', label: 'Fox News', category: 'news' },
  { url: 'https://www.nytimes.com', label: 'NY Times', category: 'news' },
  { url: 'https://nypost.com', label: 'NY Post', category: 'news' },
  { url: 'https://weather.com/weather/today/l/10004', label: 'Weather NYC', category: 'news' },
  { url: 'https://www.amny.com', label: 'AM NY', category: 'news' },
  { url: 'https://www.reddit.com/r/nyc/', label: 'Reddit r/nyc', category: 'social' },
  { url: 'https://www.reddit.com/r/all/top/', label: 'Reddit All', category: 'social' },
  { url: 'https://x.com', label: 'X/Twitter', category: 'social' },
  { url: 'https://www.tumblr.com', label: 'Tumblr', category: 'social' },
  { url: 'https://www.amazon.com', label: 'Amazon', category: 'shopping' },
  { url: 'https://www.walmart.com', label: 'Walmart', category: 'shopping' },
  { url: 'https://www.ebay.com', label: 'eBay', category: 'shopping' },
  { url: 'https://www.target.com', label: 'Target', category: 'shopping' },
  { url: 'https://www.youtube.com', label: 'YouTube', category: 'entertainment' },
  { url: 'https://www.twitch.tv/directory', label: 'Twitch Browse', category: 'entertainment' },
  { url: 'https://www.tiktok.com', label: 'TikTok', category: 'entertainment' },
  { url: 'https://www.espn.com', label: 'ESPN', category: 'local' },
  { url: 'https://www.nfl.com/teams/new-york-giants/', label: 'NY Giants', category: 'local' },
  { url: 'https://www.nba.com/knicks/', label: 'NY Knicks', category: 'local' },
  { url: 'https://new.mta.info', label: 'MTA NYC', category: 'local' },
  { url: 'https://www.timeout.com/newyork', label: 'Timeout NYC', category: 'local' },
  { url: 'https://www.yelp.com/search?find_desc=Restaurants&find_loc=New+York%2C+NY', label: 'Yelp NYC', category: 'local' },
  // Music
  { url: 'https://music.youtube.com', label: 'YT Music', category: 'music' },
  { url: 'https://open.spotify.com', label: 'Spotify', category: 'music' },
  { url: 'https://www.billboard.com', label: 'Billboard', category: 'music' },
  { url: 'https://genius.com', label: 'Genius Lyrics', category: 'music' },
  // Sports
  { url: 'https://www.espn.com/nba/', label: 'ESPN NBA', category: 'sports' },
  { url: 'https://www.mlb.com/mets', label: 'NY Mets', category: 'sports' },
  { url: 'https://www.nhl.com/rangers', label: 'NY Rangers', category: 'sports' },
  { url: 'https://www.si.com', label: 'Sports Illustrated', category: 'sports' },
  { url: 'https://bleacherreport.com', label: 'Bleacher Report', category: 'sports' },
  // Food
  { url: 'https://www.yelp.com/nyc', label: 'Yelp NYC Food', category: 'food' },
  { url: 'https://www.allrecipes.com', label: 'AllRecipes', category: 'food' },
  { url: 'https://www.foodnetwork.com', label: 'Food Network', category: 'food' },
  { url: 'https://www.seriouseats.com', label: 'Serious Eats', category: 'food' },
  { url: 'https://www.doordash.com', label: 'DoorDash', category: 'food' },
  // Travel
  { url: 'https://www.tripadvisor.com', label: 'TripAdvisor', category: 'travel' },
  { url: 'https://www.kayak.com', label: 'Kayak', category: 'travel' },
  { url: 'https://www.booking.com', label: 'Booking.com', category: 'travel' },
  { url: 'https://www.airbnb.com', label: 'Airbnb', category: 'travel' },
  { url: 'https://www.amtrak.com', label: 'Amtrak', category: 'travel' },
  // Finance
  { url: 'https://www.bloomberg.com', label: 'Bloomberg', category: 'finance' },
  { url: 'https://www.wsj.com', label: 'WSJ', category: 'finance' },
  { url: 'https://finance.yahoo.com', label: 'Yahoo Finance', category: 'finance' },
  { url: 'https://www.investopedia.com', label: 'Investopedia', category: 'finance' },
  { url: 'https://www.coinbase.com', label: 'Coinbase', category: 'finance' },
  // Tattoo Industry
  { url: 'https://www.pinterest.com/search/pins/?q=tattoo+ideas', label: 'Pinterest Tattoo', category: 'industry' },
  { url: 'https://www.instagram.com/explore/tags/tattoo/', label: 'IG Explore Tattoo', category: 'industry' },
  { url: 'https://inkedmag.com', label: 'Inked Mag', category: 'industry' },
  { url: 'https://www.tattoodo.com', label: 'Tattoodo', category: 'industry' },
  { url: 'https://www.killerinktattoo.com', label: 'Killer Ink', category: 'industry' },
  { url: 'https://www.painfulpleasures.com', label: 'Painful Pleasures', category: 'industry' },
  { url: 'https://www.worldtattooevents.com', label: 'Tattoo Events', category: 'industry' },
  { url: 'https://www.youtube.com/results?search_query=tattoo+process', label: 'YT Tattoo', category: 'industry' },
  { url: 'https://www.thetattootemple.com', label: 'Tattoo Temple', category: 'industry' },
  { url: 'https://www.barberdts.com', label: 'Barber DTS', category: 'industry' },
  { url: 'https://www.tattoolife.com', label: 'Tattoo Life', category: 'industry' },
  { url: 'https://stockists.com', label: 'Stockists Industry', category: 'industry' },
  { url: 'https://www.customtattoosupply.com', label: 'Custom Tattoo Supply', category: 'industry' },
];

const SEARCH_QUERIES: string[] = [
  'weather in new york city today', 'best pizza near me',
  'nike outlet store', 'how to fix a leaky faucet',
  'nfl schedule 2026', 'youtube trending',
  'amazon prime deals', 'best coffee shops nyc',
  'nyc events this weekend', 'giants schedule 2026',
  'how to make iced coffee', 'best air fryer 2026',
  'central park hours', 'new york restaurants',
  'times square events', 'iphone 17 price',
  'netflix new releases', 'best wireless earbuds',
  'how to tie a tie', 'mta subway map',
  'best burger nyc', 'j crew sale',
  'what to do in nyc this weekend', 'best hiking trails near nyc',
  'new songs 2026', 'spotify top charts',
  'knicks score tonight', 'mets schedule 2026',
  'easy dinner recipes', 'best italian restaurant nyc',
  'cheap flights from jfk', 'hotels in nyc',
  'stock market today', 'bitcoin price',
  'brooklyn events this weekend', 'nyc free museums',
  'how to make pasta', 'best bagels nyc',
  'jfk airport parking', 'nyc to tokyo flights',
  's&p 500 today', 'best high yield savings',
  'tattoo ideas for cover up', 'best tattoo ink 2026',
  'tattoo aftercare tips', 'tattoo machine reviews',
  'nyc tattoo convention 2026', 'tattoo apprentice tips',
  'tattoo stencil paper', 'best tattoo numbing cream',
  'tattoo portfolio examples', 'how to price tattoos',
  'tattoo style guide', 'henna vs tattoo',
];

// Built-in industry contexts (extendable)
const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  tattoo: ['tattoo', 'ink', 'piercing', 'body art', '工作室', '纹身'],
  general: [],
};

const GAMES: GameDef[] = [
  { url: 'https://play2048.co/', label: '2048', playMinSec: 30, playMaxSec: 120 },
  { url: 'https://www.nytimes.com/puzzles/wordle', label: 'Wordle', playMinSec: 30, playMaxSec: 90 },
  { url: 'https://sudoku.com', label: 'Sudoku', playMinSec: 60, playMaxSec: 180 },
  { url: 'https://gabrielecirulli.github.io/2048/', label: '2048 Classic', playMinSec: 30, playMaxSec: 120 },
];

// ============================================================
// Helpers
// ============================================================

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function weightedChoice(items: { mode: BehaviorMode; weight: number }[]): BehaviorMode {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.mode;
  }
  return items[items.length - 1].mode;
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Tab Manager
// ============================================================

class TabManager {
  private pages: Page[] = [];
  add(p: Page) { this.pages.push(p); }
  async trimTo(max: number) {
    const alive = this.pages.filter(p => !p.isClosed());
    while (alive.length > max) {
      const o = alive.shift()!;
      if (!o.isClosed()) await o.close().catch(() => {});
    }
    this.pages = this.pages.filter(p => !p.isClosed());
  }
  async closeAll(): Promise<number> {
    let n = 0;
    for (const p of this.pages) { if (!p.isClosed()) { await p.close().catch(() => {}); n++; } }
    this.pages = [];
    return n;
  }
}

// ============================================================
// Scroll — 含回滚
// ============================================================

async function humanScroll(page: Page, profile: BehaviorProfile): Promise<void> {
  try {
    const speedMap = { slow: { min: 100, max: 400 }, medium: { min: 200, max: 700 }, fast: { min: 400, max: 1200 } };
    const spd = speedMap[profile.scrollSpeed];
    const dir = Math.random() < profile.scrollBackChance && Math.random() < 0.5 ? -1 : 1;
    const dist = randomInt(spd.min, spd.max) * dir;
    const steps = randomInt(2, 6);
    const perStep = Math.floor(dist / steps);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, perStep + randomInt(-40, 40));
      await sleep(randomInt(300, 1200));
    }
  } catch {}
}

async function humanMouseMove(page: Page): Promise<void> {
  try {
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(randomInt(50, vp.width - 50), randomInt(50, vp.height - 50), { steps: randomInt(4, 12) });
  } catch {}
}

// ============================================================
// Click — 非正中心
// ============================================================

async function maybeClickLink(page: Page, chance: number): Promise<boolean> {
  if (Math.random() > chance) return false;
  try {
    const links = page.locator('a:visible[href]');
    const count = await links.count();
    if (count === 0) return false;
    for (let a = 0; a < 5; a++) {
      const idx = randomInt(0, Math.min(count - 1, 50));
      const link = links.nth(idx);
      const href = await link.getAttribute('href').catch(() => null);
      if (!href || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('mailto:')) continue;
      const box = await link.boundingBox().catch(() => null);
      if (!box) continue;
      const ox = box.width * (0.1 + Math.random() * 0.8);
      const oy = box.height * (0.1 + Math.random() * 0.8);
      await page.mouse.move(box.x + ox, box.y + oy, { steps: randomInt(4, 10) });
      await sleep(randomInt(100, 600));
      await link.click({ position: { x: ox, y: oy }, timeout: 5000, force: true }).catch(() => {});
      return true;
    }
    return false;
  } catch { return false; }
}

async function humanKeyPress(page: Page): Promise<void> {
  try {
    await page.keyboard.press(randomChoice(['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'PageDown']));
    await sleep(randomInt(200, 800));
  } catch {}
}

// ============================================================
// Google Search
// ============================================================

async function doGoogleSearch(browser: Browser, queries: string[]): Promise<void> {
  if (queries.length === 0) return;
  const page = await browser.newPage();
  const query = randomChoice(queries);
  try {
    console.log(`[mimicry] Google: "${query}"`);
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(randomInt(800, 3000));
    const sb = page.locator('textarea[name="q"], input[name="q"]').first();
    await sb.waitFor({ timeout: 8000 });
    const bx = await sb.boundingBox().catch(() => null);
    if (bx) { await page.mouse.move(bx.x + bx.width * 0.5, bx.y + bx.height * 0.5, { steps: randomInt(3, 7) }); await sleep(randomInt(100, 400)); }
    await sb.click();
    await sleep(randomInt(200, 600));
    for (const c of query) { await page.keyboard.type(c, { delay: randomInt(50, 220) }); if (Math.random() < 0.08) await sleep(randomInt(500, 2500)); }
    await sleep(randomInt(500, 1500));
    await page.keyboard.press('Enter');
    await sleep(randomInt(3000, 10000));
    if (Math.random() < 0.4) {
      const rl = page.locator('#search a[href^="http"]:visible');
      const n = await rl.count().catch(() => 0);
      if (n > 0) { const idx = randomInt(0, Math.min(n - 1, 5)); const lk = rl.nth(idx); const lb = await lk.boundingBox().catch(() => null); if (lb) { await page.mouse.move(lb.x + lb.width * 0.3, lb.y + lb.height * 0.5, { steps: randomInt(4, 10) }); await sleep(randomInt(100, 500)); } await lk.click({ timeout: 5000 }).catch(() => {}); console.log(`[mimicry] Clicked result #${idx + 1}`); await sleep(randomInt(5000, 20000)); }
    }
  } catch (err) { console.log(`[mimicry] Search: ${err}`); }
  finally { await page.close().catch(() => {}); }
}

// ============================================================
// Game
// ============================================================

async function playGame(browser: Browser, games: GameDef[]): Promise<void> {
  if (games.length === 0) return;
  const game = randomChoice(games);
  const page = await browser.newPage();
  try {
    console.log(`[mimicry] Playing: ${game.label}`);
    await page.goto(game.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const start = Date.now();
    const end = start + randomInt(game.playMinSec * 1000, game.playMaxSec * 1000);
    while (Date.now() < end) {
      if (Math.random() < 0.5) { const vp = page.viewportSize() || { width: 1280, height: 720 }; await page.mouse.click(randomInt(100, vp.width - 100), randomInt(200, vp.height - 100)); }
      if (Math.random() < 0.6) { await page.keyboard.press(randomChoice(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])); }
      await sleep(randomInt(500, 3000));
    }
  } catch (err) { console.log(`[mimicry] Game: ${err}`); }
  finally { await page.close().catch(() => {}); }
}

// ============================================================
// Browse One Site
// ============================================================

async function browseSite(browser: Browser, site: SiteDef, profile: BehaviorProfile, tabs: TabManager, budget: number): Promise<void> {
  console.log(`[mimicry] ${site.label}`);
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    tabs.add(page);
    await page.setViewportSize({ width: randomInt(1280, 1920), height: randomInt(720, 1080) });
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const end = Date.now() + Math.max(budget, 5000);
    while (Date.now() < end) {
      const a = Math.random();
      if (a < 0.35) await humanScroll(page, profile);
      else if (a < 0.45) await humanMouseMove(page);
      else if (a < 0.65) await maybeClickLink(page, profile.clickChance);
      else if (a < 0.75) await humanKeyPress(page);
      else await sleep(randomInt(profile.dwellMinMs, profile.dwellMaxMs));
      await tabs.trimTo(profile.maxTabs);
      await sleep(randomInt(1000, 4000));
    }
  } catch (err) { console.log(`[mimicry] ${site.label}: ${err}`); if (page && !page.isClosed()) await page.close().catch(() => {}); }
}

// ============================================================
// Pick mode & sites
// ============================================================

function pickMode(): BehaviorMode { return weightedChoice(MODE_WEIGHTS); }

function getSites(profile: BehaviorProfile, industry?: string): SiteDef[] {
  // Filter by industry context if specified: match sites whose label/category hint at the industry
  let pool = SITE_POOL;
  if (industry && industry !== 'general') {
    const indLower = industry.toLowerCase();
    // Prefer industry-category sites, fall back to all sites
    const industrySites = SITE_POOL.filter(s => s.category === 'industry');
    // Also include sites whose label contains the industry keyword
    const keywordSites = SITE_POOL.filter(s =>
      s.label.toLowerCase().includes(indLower) ||
      s.url.toLowerCase().includes(indLower)
    );
    const matched = [...new Set([...industrySites, ...keywordSites])];
    if (matched.length > 0) {
      // Mix: 60% industry-specific + 40% regular (keep it varied)
      const regular = SITE_POOL.filter(s => !matched.includes(s));
      const chosen = [...matched.sort(() => Math.random() - 0.5)];
      const extra = regular.sort(() => Math.random() - 0.5).slice(0, Math.max(2, Math.floor(chosen.length * 0.4)));
      pool = [...chosen, ...extra];
    }
  }
  const pref = pool.filter(s => profile.preferredCategories.includes(s.category));
  const others = pool.filter(s => !profile.preferredCategories.includes(s.category)).sort(() => Math.random() - 0.5);
  const result = [...pref];
  const extra = Math.min(others.length, Math.max(1, Math.floor(pref.length * 0.3)));
  result.push(...others.slice(0, extra));
  return result.sort(() => Math.random() - 0.5);
}

// ============================================================
// Main Entry Point
// ============================================================

export async function runHumanMimicry(browser: Browser, _accountId: string, durationMs: number, industryContext?: string): Promise<void> {
  if (durationMs < 60_000) { console.log(`[mimicry] Too short (<60s)`); return; }

  const mode = pickMode();
  const profile = BEHAVIOR_PROFILES[mode];
  const sites = getSites(profile, industryContext);
  const queries = [...SEARCH_QUERIES];
  const games = [...GAMES];

  if (sites.length === 0 && games.length === 0) { console.log(`[mimicry] No sites/games`); return; }

  const tabs = new TabManager();
  const start = Date.now();
  const end = start + durationMs;
  const WARN = 10_000;

  console.log(`[mimicry] ${profile.name} | ${sites.length} sites | ${Math.round(durationMs / 1000)}s`);

  for (const site of sites) {
    if (Date.now() > end - WARN) break;
    const budget = Math.min(randomInt(15000, 45000), end - Date.now() - WARN);
    await browseSite(browser, site, profile, tabs, Math.max(budget, 5000));
  }

  if (Date.now() < end - WARN && Math.random() < profile.searchChance && queries.length > 0) {
    await doGoogleSearch(browser, queries);
  }
  if (Date.now() < end - WARN * 2 && Math.random() < profile.gameChance && games.length > 0) {
    await playGame(browser, games);
  }

  const closed = await tabs.closeAll();
  await sleep(1000);
  console.log(`[mimicry] Done (${Math.round((Date.now() - start) / 1000)}s, ${profile.name}, ${closed} tabs)`);
}
