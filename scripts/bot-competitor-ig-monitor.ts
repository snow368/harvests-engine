/**
 * bot-competitor-ig-monitor.ts
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * ç«žå“ Instagram æ–°å“ç›‘æµ‹ â†’ å†™å›ž AI Core çŸ¥è¯†åº“ï¼ˆcompetitors:tattoo ç§Ÿæˆ·ï¼‰ã€‚
 *
 * èƒŒæ™¯ï¼šbot-worker-cloak.ts çš„ supply_analysis å·²ç»èƒ½æŠ“ç«žå“ supply å“ç‰Œ IG å¹¶
 * åˆ†æžä¸Šæ–°çŽ©æ³•ï¼Œä½†å®ƒåªåšæœ¬åœ°åˆ†æžï¼Œä»Žä¸æŠŠã€Œæ–°å“ã€å†™å›žçŸ¥è¯†åº“ã€‚æœ¬è„šæœ¬è¡¥ä¸Šè¿™æœ€åŽä¸€çŽ¯ï¼š
 * æŠŠç«žå“è´¦å·çš„å¸–å­å†™æˆ memory_itemï¼ˆbrand=ç«žå“, first_seen=å‘å¸–æ—¶é—´ï¼‰ï¼Œå¤ç”¨çŽ°æœ‰
 * ä¾›ç»™ä¾§ diff å¼•æ“Žï¼ˆcaptureSnapshot / listIntelEventsï¼‰è‡ªåŠ¨åœ¨ã€Œæ–°å“æƒ…æŠ¥ã€æ¿å†’å‡ºã€‚
 *
 * å¤ç”¨ï¼š
 *  - Playwright å·²ç™»å½• Chromeï¼ˆé»˜è®¤ CDP http://localhost:9222ï¼Œä¸Ž bot-worker åŒ sessionï¼‰
 *  - _scrape_brand_posts.ts çš„ post é¡µè§£æžï¼ˆcaption + å›¾ç‰‡ + postedAtï¼ŒJSON script æå–ï¼‰
 *  - AI Core createMemory å­—æ®µï¼ˆè§ D:\harvests-ai-core\packages\memory\src\index.tsï¼‰
 *
 * åŽ»é‡æ–°å“é€»è¾‘ï¼ˆå³ç”¨æˆ·è¯´çš„ã€Œå…ˆç”¨ bot worker æ¯”å¯¹ä¸‹ï¼ŒåŽç»­å‘çš„å°±æ˜¯æ–°å“ã€ï¼‰ï¼š
 *  - é¦–è·‘ / --baselineï¼šæŠŠç«žå“çŽ°æœ‰å¸–å­å…¨é‡çŒå…¥ï¼Œfirst_seen = çœŸå®žå‘å¸–æ—¶é—´ â†’ ä¸å½“æ–°å“
 *  - å¢žé‡ï¼šæŒ‰ post shortcode åŽ»é‡ï¼Œä»Žæœªè§è¿‡çš„å¸– â†’ first_seen = now â†’ åœ¨ã€Œæ–°å“ã€æ¿å†’å‡º
 *
 * ç”¨æ³•ï¼š
 *  npx tsx scripts/bot-competitor-ig-monitor.ts            # è·‘ä¸€è½®å¢žé‡ï¼ˆé»˜è®¤ï¼‰
 *  npx tsx scripts/bot-competitor-ig-monitor.ts --baseline # å…¨é‡çŒåŸºçº¿
 *  npx tsx scripts/bot-competitor-ig-monitor.ts --loop --interval-min 360  # æ¯ 6h ä¸€è½®
 *  npx tsx scripts/bot-competitor-ig-monitor.ts --include-all  # éžå…³é”®è¯å¸–ä¹Ÿå­˜ä¸º social_post
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Windows ä¸Š localhost å¸¸å…ˆè§£æžåˆ° IPv6(::1)ï¼Œè€Œ Chrome çš„ CDP åªç›‘å¬ 127.0.0.1(IPv4)ã€‚
// è¿™ä¼šå¯¼è‡´ connectOverCDP çš„ WebSocket æ¡æ‰‹å¤±è´¥ã€è¢«è¯¯æŠ¥ä¸ºã€ŒCDP ä¸å¯ç”¨ã€ã€‚å¼ºåˆ¶ IPv4 ä¼˜å…ˆã€‚
dns.setDefaultResultOrder('ipv4first');

// â”€â”€ é…ç½®ï¼ˆä¸Ž bot-worker-real.ts åŒæºï¼Œæ–¹ä¾¿ VPS å¤ç”¨ envï¼‰ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const IG_BASE = (process.env.INSTAGRAM_BASE || 'https://www.instagram.com').replace(/\/+$/, '');
const AI_CORE_BASE = (process.env.AI_CORE_BASE || 'https://harvests-ai-core-api.inkflowapp.workers.dev').replace(/\/+$/, '');
const AI_CORE_AUTH = process.env.AI_CORE_AUTH || 'Bearer dev';
const CDP_URL = (process.env.BOT_CDP_URL || 'http://127.0.0.1:9222').trim();
// æœ¬æœºä»£ç†ï¼ˆGFW ä¸‹æŠ“ IG å¿…éœ€ï¼‰ã€‚å¦‚ http://127.0.0.1:7890 æˆ– socks5://127.0.0.1:7891
// å…¼å®¹ï¼šç”¨æˆ·å¸¸åªè®¾ HTTPS_PROXY/HTTP_PROXYï¼Œæµè§ˆå™¨ä¹Ÿå¿…é¡»èµ°åŒä¸€ä»£ç†æ‰èƒ½æŠ“åˆ° IG
const BOT_PROXY = (process.env.BOT_PROXY || '').trim();
const BROWSER_PROXY = (BOT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
const PROFILE_DIR = process.env.BOT_PROFILE_DIR || path.join(process.cwd(), 'data', 'bot_profiles', 'competitor_ig');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENGINE_DIR = __dirname.replace(/[/\\]scripts$/, '');
const WATCH_FILE = path.join(ENGINE_DIR, 'data', 'competitor_watch.json');
const STATE_FILE = path.join(ENGINE_DIR, 'data', 'competitor_ig_state.json');
const MAX_POSTS_PER_BRAND = 20;
const MAX_SCROLL = 6;

// ã€Œæ–°å“ã€è§¦å‘å…³é”®è¯ï¼ˆå‘½ä¸­è§†ä¸ºä¸Šæ–°å€™é€‰ï¼‰
const NEW_PRODUCT_KEYWORDS = [
  'new', 'launch', 'drop', 'release', 'restock', 'back in stock', 'pre-order', 'preorder',
  'now available', 'just dropped', 'now live', 'fresh drop',
  'ä¸Šæž¶', 'ä¸Šæ–°', 'æ–°å“', 'æ–°æ¬¾', 'è¡¥è´§', 'çŽ°è´§', 'å¼€å”®', 'é¦–å‘', 'é¢„å”®',
];
// æ¬¡è¦ä¿¡å·ï¼šcaption é‡Œå‡ºçŽ° SKU å½¢æ€ï¼ˆå¦‚ CON-1209MG / PEACH-0803RLï¼‰
const SKU_RE = /\b(PEACH-|CON-|AES-|COG-|CAN-BU-|KW-|MG|RL|RS|MAG)\b[\w-]*/i;

const jitter = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// â”€â”€ è¯»å–ç›‘è§†åˆ—è¡¨ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadWatchList(): { brand: string; handle: string; tenant: string }[] {
  const out: { brand: string; handle: string; tenant: string }[] = [];
  // 1) JSON é…ç½®æ–‡ä»¶ï¼ˆä¸Ž _scrape_brand_posts.ts ç”¨ data/brand_database.json åŒä¸€çº¦å®šï¼‰
  if (fs.existsSync(WATCH_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
      for (const c of cfg.competitors || []) {
        if (c.brand && c.handle && c.handle !== 'REPLACE_WITH_REAL_HANDLE') {
          out.push({ brand: c.brand, handle: String(c.handle).replace(/^@/, ''), tenant: c.tenant || 'competitors:tattoo' });
        } else if (c.handle === 'REPLACE_WITH_REAL_HANDLE') {
          console.warn(`[warn] ${c.brand}: handle ä»æ˜¯å ä½ç¬¦ï¼Œè·³è¿‡ï¼ˆè¯·åœ¨ data/competitor_watch.json å¡«å…¥çœŸå®ž IG handleï¼‰`);
        }
      }
    } catch (e: any) {
      console.warn('[warn] è¯»å– competitor_watch.json å¤±è´¥:', e.message);
    }
  }
  // 2) çŽ¯å¢ƒå˜é‡è¦†ç›–ï¼šCOMPETITOR_HANDLES=painpleasure:@handle,brand2:@handle2
  const env = (process.env.COMPETITOR_HANDLES || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of env) {
    const [brand, handle] = e.split(':').map((s) => s.trim());
    if (brand && handle) out.push({ brand, handle: handle.replace(/^@/, ''), tenant: 'competitors:tattoo' });
  }
  return out;
}

// â”€â”€ æœ¬åœ°åŽ»é‡çŠ¶æ€ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadState(): Record<string, { lastRun: string; seen: Record<string, string> }> {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s: Record<string, { lastRun: string; seen: Record<string, string> }>) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// â”€â”€ AI Core å†™å›žï¼ˆmirror bot-worker-real.ts çš„ aicorePostï¼‰ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function aicorePost(tenant: string, body: Record<string, any>): Promise<any> {
  const url = `${AI_CORE_BASE}/${tenant}/memory`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: AI_CORE_AUTH },
      body: JSON.stringify({ ...body, tenant_id: tenant }),
    });
    const text = await resp.text();
    let payload: any = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 200) }; }
    if (!resp.ok) {
      console.warn(`[aicore] POST ${url} FAILED ${resp.status}: ${JSON.stringify(payload).slice(0, 200)}`);
      return null;
    }
    console.log(`[aicore] POST ${url} OK (entity_id=${body.entity_id})`);
    return payload;
  } catch (e: any) {
    console.warn(`[aicore] POST ${url} ERROR: ${e.message}`);
    return null;
  }
}

// â”€â”€ æµè§ˆå™¨ï¼šä¼˜å…ˆ CDP å¤ç”¨å·²ç™»å½• sessionï¼Œå¦åˆ™ persistent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function launchBrowser(): Promise<{ browser: Browser; context: BrowserContext; page: Page; viaCdp: boolean }> {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    const context = contexts[0] || (await browser.newContext());
    const page = context.pages()[0] || await context.newPage();
    console.log(`[browser] connected via CDP ${CDP_URL}`);
    return { browser, context, page, viaCdp: true };
  } catch (e: any) {
    const reason = e?.message?.split('\n')[0] || e?.code || 'unknown';
    console.log(`[browser] CDP ä¸å¯ç”¨ (${reason})ï¼Œå›žé€€ persistent profile ${PROFILE_DIR}`);
    const ctxOpts: any = {
      headless: false, channel: 'chrome',
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
      ignoreDefaultArgs: ['--enable-automation'],
      ignoreHTTPSErrors: true,
    };
    if (BROWSER_PROXY) {
      ctxOpts.proxy = { server: BROWSER_PROXY };
      console.log(`[browser] ä½¿ç”¨ä»£ç† ${BROWSER_PROXY}`);
    }
    const context = await chromium.launchPersistentContext(PROFILE_DIR, ctxOpts);
    const page = context.pages()[0] || await context.newPage();
    return { browser: context.browser()!, context, page, viaCdp: false };
  }
}

// â”€â”€ æŠ“ä¸»é¡µ tile é“¾æŽ¥ï¼ˆå¤ç”¨ _scrape_brand_posts é€‰æ‹©å™¨ï¼‰ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function scrapeProfileTiles(page: Page, handle: string, maxN: number): Promise<string[]> {
  await page.goto(`${IG_BASE}/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(jitter(2500, 4500));
  const seen = new Set<string>();
  const selector = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
  for (let i = 0; i < MAX_SCROLL && seen.size < maxN; i++) {
    const tiles = await page.locator(selector).all().catch(() => []);
    for (const t of tiles) {
      const href = await t.getAttribute('href').catch(() => '');
      if (href) seen.add(href.startsWith('http') ? href : `${IG_BASE}${href}`);
    }
    await page.mouse.wheel(0, 800 + i * 200);
    await page.waitForTimeout(jitter(1200, 2200));
  }
  return [...seen].slice(0, maxN);
}

// â”€â”€ æŠ“ post é¡µå†…å®¹ï¼ˆå¤ç”¨ _scrape_brand_posts.scrapePost çš„ JSON æå–ï¼‰ â”€â”€â”€â”€â”€â”€
// â”€â”€ æŠ“ post é¡µå®Œæ•´å†…å®¹ï¼ˆcaption + å…¨éƒ¨å›¾ç‰‡ + è¯„è®º + äº’åŠ¨é‡ï¼‰ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// è¿”å›žæ•´ç¯‡å¸–å­ç´ æï¼Œä¾› content pipeline ç”Ÿæˆç¤¾åª’å›¾/è§†é¢‘ç›´æŽ¥å–ç”¨ã€‚
async function scrapePost(page: Page, url: string): Promise<{
  caption: string; imageUrl: string; postedAt: string;
  imageUrls: string[]; comments: { author: string; text: string; likes: number }[];
  likes_count: number | null; comments_count: number | null;
}> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(jitter(1500, 2500));
  // ç™»å½•å¢™æ£€æµ‹ï¼šæœªç™»å½•æ—¶ IG ä¼šæŠŠ /p/xxx é‡å®šå‘åˆ° /accounts/login æˆ–å¡žç™»å½•å¼¹çª—
  const loginWall = await page.evaluate(() => {
    const u = location.href;
    if (/\/accounts\/login/i.test(u)) return 'redirected to /accounts/login';
    const t = document.body?.innerText || '';
    if (/log in to see|Log in to Instagram|ç™»å½•ä»¥æŸ¥çœ‹|è¯·å…ˆç™»å½•/i.test(t) &&
        !document.querySelector('script[type="application/json"]')) return 'login wall dialog';
    return '';
  }).catch(() => '');
  if (loginWall) throw new Error(`login wall (${loginWall}) â€” è¯¥ Chrome profile æœªç™»å½• Instagram`);
  // ä¼˜å…ˆä»Ž post é¡µå†…åµŒ JSON æŠ½å–å®Œæ•´ç»“æž„ï¼ˆcaption / carousel å›¾ / è¯„è®º / äº’åŠ¨ï¼‰
  // âš ï¸ æ­¤å—å†…ç¦æ­¢å‡ºçŽ°å…·åå‡½æ•°(å£°æ˜Ž/è¡¨è¾¾å¼éƒ½ä¸è¡Œ)ï¼štsx(esbuild keepNames)ä¼šç»™å…·åå‡½æ•°
  //    æ³¨å…¥ __name() åŒ…è£…ï¼Œè€Œ page.evaluate ä¼šæŠŠå‡½æ•°åºåˆ—åŒ–åˆ°æµè§ˆå™¨æ‰§è¡Œï¼Œæµè§ˆå™¨æ—  __name
  //    å®šä¹‰ä¼šæŠ› ReferenceErrorã€‚æ•… pick æ”¹ä¸ºå†…è”å±žæ€§è®¿é—®ï¼Œä¿ç•™é›¶å…·åå‡½æ•°ã€‚
  const data = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
    let media: any = null;
    for (const s of scripts) {
      try {
        const d = JSON.parse(s.textContent || '{}');
        media = d?.graphql?.shortcode_media || d?.data?.shortcode_media || d?.shortcode_media || media;
        if (media) break;
      } catch {}
    }
    if (!media) {
      try {
        const w = (window as any).__additionalData || {};
        const key = Object.keys(w)[0];
        media = w[key]?.data?.shortcode_media || w[key]?.graphql?.shortcode_media || null;
      } catch {}
    }
    if (!media) return null;
    const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const images: string[] = [];
    if (media.edge_sidecar_to_children?.edges?.length) {
      for (const e of media.edge_sidecar_to_children.edges) images.push(e.node.display_url);
    } else if (media.display_url) {
      images.push(media.display_url);
    }
    const likes = media.edge_media_preview_like?.count ?? media.edge_liked_by?.count ?? null;
    const commentsCount = media.edge_media_to_parent_comment?.count ?? null;
    const comments = (media.edge_media_to_parent_comment?.edges || [])
      .slice(0, 40)
      .map((e: any) => ({
        author: e?.node?.owner?.username || '',
        text: e?.node?.text || '',
        likes: e?.node?.edge_liked_by?.count ?? 0,
      }))
      .filter((c: any) => c.text);
    const taken = media.taken_at_timestamp ? new Date(media.taken_at_timestamp * 1000).toISOString() : '';
    return { caption, image_urls: images, likes_count: likes, comments_count: commentsCount, comments, postedAt: taken };
  });
  if (data) {
    return {
      caption: (data.caption || '').replace(/\s+/g, ' ').trim(),
      imageUrl: data.image_urls?.[0] || '',
      imageUrls: data.image_urls || [],
      comments: data.comments || [],
      likes_count: data.likes_count ?? null,
      comments_count: data.comments_count ?? null,
      postedAt: data.postedAt || '',
    };
  }
  // å…œåº•ï¼šåªæ‹¿ caption + og:imageï¼ˆè¯„è®º/å¤šå›¾æ‹¿ä¸åˆ°ï¼‰
  const caption = await page.locator('div[role="dialog"] ul > li').first().innerText().catch(() => '')
    || await page.locator('article h1').first().innerText().catch(() => '');
  const imageUrl = await page.evaluate(() => document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '').catch(() => '');
  const postedAt = await page.evaluate(() => document.querySelector('time[datetime]')?.getAttribute('datetime') || '').catch(() => '');
  return {
    caption: caption.replace(/\s+/g, ' ').trim(),
    imageUrl: imageUrl.trim(),
    imageUrls: imageUrl ? [imageUrl.trim()] : [],
    comments: [],
    likes_count: null,
    comments_count: null,
    postedAt: postedAt.trim(),
  };
}

function shortcodeFromUrl(url: string): string {
  const m = url.match(/\/(?:p|reel|tv)\/([^/?#]+)/);
  return m ? m[1] : url;
}
function keywordHits(text: string): string[] {
  const lower = text.toLowerCase();
  return NEW_PRODUCT_KEYWORDS.filter((k) => lower.includes(k.toLowerCase()));
}

// è¯„è®ºç›¸å…³æ€§åˆ†ç±»ï¼šåˆ¤æ–­ä¸€æ¡è¯„è®ºæ˜¯å¦"å¯¹é¡¹ç›®æœ‰ç”¨"ï¼Œå¹¶æ ‡æ³¨æ„å›¾ã€‚
// æ³¨æ„ï¼šè¿™é‡Œåªæ‰“æ ‡ç­¾ï¼Œä¸ä¸¢å¼ƒâ€”â€”æ•´ç¯‡å¸–å­ï¼ˆå«å…¨éƒ¨è¯„è®ºï¼‰éƒ½ä¼šå­˜ï¼Œæ–¹ä¾¿ content
// pipeline å–å®Œæ•´ä¸Šä¸‹æ–‡ï¼›"æœ‰ç”¨"æ ‡ç­¾ç”¨äºŽç•™è¨€æ´žå¯Ÿç­›é€‰ã€‚
const COMMENT_INTENT_KEYWORDS: Record<string, string[]> = {
  product_question: ['where', 'buy', 'price', 'how much', 'cost', 'available', 'in stock', 'restock', 'link', 'shop', 'order', 'å“ª', 'ä¹°', 'å¤šå°‘é’±', 'æœ‰è´§', 'è¡¥è´§', 'é“¾æŽ¥', 'æ±‚', 'å…¥æ‰‹', 'åŒæ¬¾', 'çŽ°è´§', 'åº—é“º'],
  complaint: ['broken', 'broke', 'sucks', 'disappointed', 'fake', 'scam', 'terrible', 'bad quality', 'å·®', 'å', 'å‡', 'å‘', 'å¤±æœ›', 'åžƒåœ¾', 'åŠ£è´¨', 'é€€è´§', 'æŠ•è¯‰'],
  lead: ['want', 'need', 'looking for', 'interested', 'dm me', 'want this', 'æƒ³è¦', 'éœ€è¦', 'ç§', 'æ„Ÿå…´è¶£', 'æ±‚è´­', 'è¹²'],
  praise: ['love', 'amazing', 'great', 'perfect', 'obsessed', 'å¥½çœ‹', 'å–œæ¬¢', 'ç¾Ž', 'ç»', 'çˆ±äº†', 'å¤ªæ£’', 'nice'],
};
function classifyComment(text: string): { useful: boolean; intent: string } {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return { useful: false, intent: 'empty' };
  // çº¯è¡¨æƒ… / è¿‡çŸ­ = å™ªéŸ³ï¼Œä¸æ‰“æœ‰ç”¨æ ‡ç­¾
  const stripped = t.replace(/[\p{Emoji}\s]/gu, '');
  if (stripped.length < 3) return { useful: false, intent: 'noise' };
  for (const [intent, kws] of Object.entries(COMMENT_INTENT_KEYWORDS)) {
    if (kws.some((k) => t.includes(k.toLowerCase()))) return { useful: true, intent };
  }
  return { useful: false, intent: 'other' };
}

// â”€â”€ ä¸»æµç¨‹ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runCompetitor(c: { brand: string; handle: string; tenant: string }, opts: { baseline: boolean; includeAll: boolean }, state: Record<string, any>) {
  const tiles = await scrapeProfileTiles(page!, c.handle, MAX_POSTS_PER_BRAND);
  console.log(`\n[${c.brand}] @${c.handle}: ${tiles.length} å¸–`);
  const brandState = state[c.brand] || { lastRun: '', seen: {} as Record<string, string> };
  let wroteNew = 0, wroteBaseline = 0, skipped = 0, wrotePosts = 0, fetchFail = 0;

  for (const url of tiles) {
    const code = shortcodeFromUrl(url);
    const alreadySeen = !!brandState.seen[code];
    const post = await scrapePost(page!, url).catch((e: any) => {
      console.warn(`  [æŠ“å–å¤±è´¥] ${code}: ${(e && e.message) || e}`);
      return null;
    });
    if (!post) { skipped++; fetchFail++; continue; }
    const hits = keywordHits(post.caption);
    const hasSku = SKU_RE.test(post.caption);
    const isNewProduct = hits.length > 0 || hasSku;

    // è®°å½•åˆ° seenï¼ˆæ— è®ºæ˜¯å¦å†™å…¥ï¼Œé¿å…é‡å¤å¤„ç†ï¼‰
    if (!alreadySeen) brandState.seen[code] = post.postedAt || new Date().toISOString();

    if (alreadySeen) { skipped++; continue; }

    // æ•´ç¯‡å¸–å­ï¼ˆå›¾ + è¯„è®º + äº’åŠ¨é‡ï¼‰å…¨é‡å†™å…¥ competitor_postï¼Œä½œä¸º content
    // pipeline ç”Ÿæˆç¤¾åª’å›¾/è§†é¢‘çš„åŽŸæ–™ï¼Œä»¥åŠç•™è¨€æ´žå¯Ÿçš„æ•°æ®æºã€‚æ¯æ¡æ–°å¸–éƒ½å†™ä¸€æ¬¡ã€‚
    await writeCompetitorPost(c, code, post, hits);
    wrotePosts++;

    // é¦–è·‘/--baselineï¼šå…¨é‡çŒå…¥ï¼Œfirst_seen = çœŸå®žå‘å¸–æ—¶é—´ï¼ˆä¸å½“æ–°å“ï¼‰
    if (opts.baseline) {
      await writeMemory(c, code, post, false, hits, opts.includeAll);
      wroteBaseline++;
      await sleep(jitter(800, 1500));
      continue;
    }

    // å¢žé‡ï¼šåªå†™ã€Œæ–°å“ã€å€™é€‰ï¼›éžå…³é”®è¯å¸–é»˜è®¤è·³è¿‡ï¼ˆ--include-all æ‰å­˜ social_postï¼‰
    if (isNewProduct) {
      await writeMemory(c, code, post, true, hits, true);
      wroteNew++;
    } else if (opts.includeAll) {
      await writeMemory(c, code, post, true, hits, false);
      wroteNew++;
    }
    await sleep(jitter(800, 1500));
  }

  brandState.lastRun = new Date().toISOString();
  state[c.brand] = brandState;
  const seenSkip = skipped - fetchFail;
  console.log(`[${c.brand}] æœ¬è½®: æ•´å¸–(competitor_post)å†™ ${wrotePosts}, æ–°å“å†™ ${wroteNew}, åŸºçº¿å†™ ${wroteBaseline}, è·³è¿‡ ${skipped}(æŠ“å–å¤±è´¥ ${fetchFail} / å·²è§è¿‡ ${seenSkip})`);
  if (fetchFail > 0 && wrotePosts === 0) {
    console.log(`  âš ï¸ å…¨éƒ¨ ${fetchFail} ç¯‡è¯¦æƒ…æŠ“å–å¤±è´¥ã€‚æœ€å¸¸è§åŽŸå› ï¼šè¯¥ Chrome profile æœªç™»å½• Instagramï¼ˆè¯¦æƒ…é¡µ /p/ è¢«ç™»å½•å¢™æ‹¦ï¼‰ï¼Œæˆ–ä»£ç†ä¸ç¨³å¯¼è‡´ goto è¶…æ—¶ã€‚ä¸Šé¢çš„ [æŠ“å–å¤±è´¥] è¡Œç»™å‡ºäº†æ¯ç¯‡çš„çœŸå®žåŽŸå› ã€‚`);
  }
}

async function writeMemory(
  c: { brand: string; handle: string; tenant: string },
  code: string,
  post: { caption: string; imageUrl: string; postedAt: string },
  isNew: boolean,
  hits: string[],
  asProduct: boolean,
) {
  const type = asProduct ? 'product' : 'social_post';
  const title = (post.caption.split('\n')[0] || `${c.brand} IG post`).slice(0, 80);
  const firstSeen = isNew ? new Date().toISOString() : (post.postedAt || new Date().toISOString());
  await aicorePost(c.tenant, {
    type,
    entity_id: `${c.brand}::ig-${code}`,
    title,
    content: post.caption || title,
    metadata: {
      brand: c.brand,
      handle: c.handle,
      post_url: `${IG_BASE}/${c.handle}/p/${code}/`,
      image_url: post.imageUrl || null,
      posted_at: post.postedAt || null,
      first_seen: firstSeen,
      is_new_product: asProduct,
      keywords: hits,
      source_type: 'instagram',
    },
    source: `instagram:${c.brand}`,
  });
}

// å†™æ•´ç¯‡å¸–å­ç´ æï¼ˆcaption + å…¨éƒ¨å›¾ç‰‡ + è¯„è®º + äº’åŠ¨é‡ï¼‰ä¸º competitor_post ç±»åž‹ã€‚
// è¿™æ˜¯ content pipeline ç”Ÿæˆç¤¾åª’å›¾/è§†é¢‘çš„åŽŸæ–™ï¼Œä¹Ÿæ˜¯ã€Œç•™è¨€æ´žå¯Ÿã€çš„æ•°æ®æºã€‚
// è¯„è®ºé€æ¡æ‰“ useful/intent æ ‡ç­¾ï¼ˆä¸æ‰“æ ‡ç­¾ä¸ä¸¢å¼ƒï¼‰ï¼Œæ–¹ä¾¿å‰ç«¯ç­›é€‰ã€Œæœ‰ç”¨ç•™è¨€ã€ã€‚
async function writeCompetitorPost(
  c: { brand: string; handle: string; tenant: string },
  code: string,
  post: { caption: string; imageUrl: string; imageUrls: string[]; postedAt: string; comments: { author: string; text: string; likes: number }[]; likes_count: number | null; comments_count: number | null },
  hits: string[],
) {
  const comments = (post.comments || []).map((cm) => {
    const cl = classifyComment(cm.text);
    return { author: cm.author, text: cm.text, likes: cm.likes || 0, useful: cl.useful, intent: cl.intent };
  });
  const usefulCount = comments.filter((x) => x.useful).length;
  const title = (post.caption.split('\n')[0] || `${c.brand} IG post`).slice(0, 80);
  await aicorePost(c.tenant, {
    type: 'competitor_post',
    entity_id: `${c.brand}::igpost-${code}`,
    title,
    content: post.caption || title,
    metadata: {
      brand: c.brand,
      handle: c.handle,
      post_url: `${IG_BASE}/${c.handle}/p/${code}/`,
      image_urls: post.imageUrls && post.imageUrls.length ? post.imageUrls : (post.imageUrl ? [post.imageUrl] : []),
      caption: post.caption,
      posted_at: post.postedAt || null,
      likes_count: post.likes_count ?? null,
      comments_count: post.comments_count ?? null,
      comments,
      useful_comment_count: usefulCount,
      is_new_product: hits.length > 0,
      keywords: hits,
      source_type: 'instagram',
      content_kind: 'post',
      captured_at: new Date().toISOString(),
    },
    source: `instagram:${c.brand}`,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// â”€â”€ å…¥å£ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let page: Page | null = null;
async function main() {
  const args = process.argv.slice(2);
  const baseline = args.includes('--baseline');
  const includeAll = args.includes('--include-all');
  const loop = args.includes('--loop');
  const intervalMin = Number(args.find((a) => a.startsWith('--interval-min='))?.split('=')[1] || '360');

  const watch = loadWatchList();
  if (watch.length === 0) {
    console.error('æ²¡æœ‰å¯ç›‘è§†çš„ç«žå“ï¼ˆdata/competitor_watch.json ä¸ºç©ºæˆ–å…¨æ˜¯å ä½ç¬¦ï¼Œæˆ– COMPETITOR_HANDLES æœªè®¾ï¼‰ã€‚é€€å‡ºã€‚');
    process.exit(1);
  }
  console.log(`=== Competitor IG Monitor (baseline=${baseline}, includeAll=${includeAll}) ===`);
  console.log(`ç›‘è§†: ${watch.map((w) => `${w.brand}@${w.handle}`).join(', ')}`);

  const { browser, page: p, viaCdp } = await launchBrowser();
  page = p;

  const tick = async () => {
    const state = loadState();
    for (const c of watch) {
      try { await runCompetitor(c, { baseline, includeAll }, state); }
      catch (e: any) { console.warn(`[${c.brand}] å¤±è´¥: ${e.message?.slice(0, 100)}`); }
      await sleep(jitter(2000, 4000));
    }
    saveState(state);
  };

  await tick();
  if (loop) {
    console.log(`\nè¿›å…¥å¾ªçŽ¯æ¨¡å¼ï¼Œæ¯ ${intervalMin} åˆ†é’Ÿä¸€è½® (Ctrl+C é€€å‡º)`);
    while (true) { await sleep(intervalMin * 60_000); await tick(); }
  }
  // CDP æ¨¡å¼å¤ç”¨ bot-worker çš„ Chromeï¼Œç»ä¸å…³é—­ï¼›ä»… persistent å›žé€€æ—¶æ‰å…³
  if (!viaCdp) {
    try { await browser.close(); } catch {}
  }
}

// ä»…åœ¨ç›´æŽ¥è¿è¡Œæ—¶æ‰§è¡Œï¼ˆè¢« import æ—¶ä¸è·‘ï¼Œæ–¹ä¾¿å°†æ¥å¤ç”¨å‡½æ•°ï¼‰
const invoked = process.argv[1]?.replace(/\\/g, '/').endsWith('bot-competitor-ig-monitor.ts');
if (invoked) {
  main().catch((e) => { console.error('Fatal:', e?.message || e); process.exit(1); });
}
