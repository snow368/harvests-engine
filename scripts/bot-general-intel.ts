/* eslint-disable no-console */
/**
 * bot-general-intel.ts
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * é€šç”¨è¡Œä¸šæƒ…æŠ¥æœºå™¨äºº â€”â€” é¢å‘ä»»æ„è¡Œä¸š/äº§å“çš„é€šç”¨æƒ…æŠ¥é‡‡é›† workerã€‚
 *
 * èµ°ã€Œçº¹èº«æœºå™¨äººã€åŒä¸€å¥—è§„åˆ™ï¼ˆé…ç½® â†’ æŠ“å– â†’ åˆ†ç±» â†’ å…¥åº“ï¼‰ï¼š
 *  - é…ç½®æ¥æºï¼šâ‘  ecosystem.envï¼ˆdev å¯ç›´æŽ¥æ”¹ï¼‰â‘¡ å‰ç«¯å¡ç‰‡é…ç½®ï¼ˆç»æŽ§åˆ¶é¢è½ç›˜
 *    data/general-intel.config.jsonï¼Œå¯åŠ¨æ—¶åˆå¹¶ï¼Œå‰ç«¯ä¼˜å…ˆï¼‰â‘¢ è¿›ç¨‹ envã€‚
 *  - æŠ“å–ï¼šPlaywrightï¼ˆheadless chromiumï¼‰ï¼ŒGFW ä¸‹è‡ªåŠ¨èµ° BOT_PROXY/HTTPS_PROXYã€‚
 *  - åˆ†ç±»ï¼šæœ¬åœ°å…³é”®è¯å¯å‘å¼ï¼ŒæŠŠæ–‡æœ¬åˆ‡æˆ 4 ç±»ä¿¡å·ï¼ˆä¸Žçº¹èº«ä¾§ä¸€è‡´ï¼‰ï¼š
 *      new_productï¼ˆç«žå“/è¡Œä¸šæ–°å“ï¼‰Â· improvementï¼ˆäº§å“æ”¹è¿›æ–¹å‘ï¼‰Â·
 *      complaintsï¼ˆå®¢æˆ·æŠ±æ€¨ï¼‰Â· reviewsï¼ˆå·®è¯„/å£ç¢‘ï¼‰ã€‚
 *  - å…¥åº“ï¼šå†™å›ž AI Core çŸ¥è¯†åº“ `${GENERAL_TENANT}/memory`ï¼ˆé»˜è®¤ competitors:generalï¼‰ï¼Œ
 *    ä¸Ž bot-competitor-ig-monitor åŒä¸€å›žå†™é€šé“ï¼ˆAuthorization: Bearer devï¼‰ã€‚
 *
 * ç”¨æ³•ï¼š
 *  npx tsx scripts/bot-general-intel.ts                 # è·‘ä¸€è½®
 *  npx tsx scripts/bot-general-intel.ts --loop --interval-min 360   # æ¯ 6h ä¸€è½®
 *
 * é…ç½®é”®ï¼ˆä¸Žå‰ç«¯ BOT_FUNCTION_CATALOG.general_intel.configs å¯¹é½ï¼‰ï¼š
 *  TARGET_INDUSTRY  ç›®æ ‡è¡Œä¸šï¼ˆå¦‚ "coffee equipment" / "å® ç‰©ç”¨å“"ï¼‰
 *  TARGET_BRANDS    å“ç‰Œ/ç«žå“ï¼Œé€—å·åˆ†éš”
 *  SOURCE_URLS      ç›®æ ‡æº URLï¼Œé€—å·åˆ†éš”ï¼ˆäº§å“é¡µ/è¯„è®ºé¡µ/ç¤¾åŒºå¸–/æ–°é—»ï¼‰
 *  KEYWORDS         é¢å¤–å…³é”®è¯ï¼Œé€—å·åˆ†éš”ï¼ˆå¯é€‰ï¼Œå¢žå¼ºå‘½ä¸­ï¼‰
 *  INTEL_FOCUS      æƒ…æŠ¥èšç„¦ï¼šnew_product|improvement|complaints|reviews|all
 *  GENERAL_TENANT   AI Core ç§Ÿæˆ·ï¼Œé»˜è®¤ competitors:general
 */
import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENGINE_DIR = __filename.replace(/[/\\]scripts[/\\]bot-general-intel\.ts$/, '');
const CONFIG_FILE = path.join(ENGINE_DIR, 'data', 'general-intel.config.json');

// â”€â”€ é…ç½®è§£æžï¼ˆå‰ç«¯å¡ç‰‡ > è½ç›˜æ–‡ä»¶ > envï¼‰ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadConfig() {
  const cfg: Record<string, string> = {};
  // 1) env é»˜è®¤å€¼
  for (const k of ['TARGET_INDUSTRY', 'TARGET_BRANDS', 'SOURCE_URLS', 'KEYWORDS', 'INTEL_FOCUS', 'GENERAL_TENANT']) {
    if (process.env[k]) cfg[k] = process.env[k] as string;
  }
  // 2) è½ç›˜æ–‡ä»¶ï¼ˆæŽ§åˆ¶é¢ä»Žå‰ç«¯é…ç½®å†™å…¥ï¼‰
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const f = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      for (const k of Object.keys(f)) if (f[k] !== undefined && f[k] !== '') cfg[k] = String(f[k]);
    }
  } catch (e: any) {
    console.warn('[general-intel] è¯»é…ç½®æ–‡ä»¶å¤±è´¥ï¼Œå¿½ç•¥:', e.message);
  }
  cfg.INTEL_FOCUS = cfg.INTEL_FOCUS || 'all';
  cfg.GENERAL_TENANT = cfg.GENERAL_TENANT || 'competitors:general';
  return cfg;
}

// â”€â”€ ä¿¡å·åˆ†ç±»å…³é”®è¯ï¼ˆ4 æ¡¶ï¼Œä¸Žçº¹èº«ä¾§æƒ…æŠ¥è¯­ä¹‰å¯¹é½ï¼‰ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SIGNAL_KEYWORDS: Record<string, string[]> = {
  new_product: [
    'new', 'launch', 'drop', 'release', 'restock', 'pre-order', 'preorder', 'now available',
    'just dropped', 'new arrival', 'æ–°å“', 'ä¸Šæ–°', 'æ–°æ¬¾', 'å‘å¸ƒ', 'ä¸Šå¸‚', 'é¢„å”®', 'å¼€å”®', 'é¦–å‘',
  ],
  improvement: [
    'improve', 'upgrade', 'redesign', 'better', 'enhanced', 'wish', 'should have', 'hope they',
    'å»ºè®®', 'æ”¹è¿›', 'ä¼˜åŒ–', 'å¸Œæœ›', 'æœŸå¾…', 'å‡çº§', 'æ›´å¥½ç”¨', 'ç¼ºç‚¹',
  ],
  complaints: [
    'complain', 'issue', 'problem', 'broken', 'disappointed', 'terrible', 'worst', 'hate',
    'æŠ•è¯‰', 'é—®é¢˜', 'åäº†', 'å¤±æœ›', 'å·®è¯„', 'å‘', 'åžƒåœ¾', 'åŽæ‚”', 'å´©æºƒ',
  ],
  reviews: [
    'review', 'rating', 'star', 'recommend', 'worth', 'love', 'best', 'quality',
    'è¯„æµ‹', 'è¯„ä»·', 'æŽ¨è', 'å€¼å¾—', 'å–œæ¬¢', 'è´¨é‡', 'å¥½è¯„', 'ç§è‰',
  ],
};

const FOCUS_TO_BUCKETS: Record<string, string[]> = {
  new_product: ['new_product'],
  improvement: ['improvement'],
  complaints: ['complaints'],
  reviews: ['reviews'],
  all: ['new_product', 'improvement', 'complaints', 'reviews'],
};

function classify(text: string, focus: string, extraKeywords: string[]): string[] {
  const t = ` ${text.toLowerCase()} `;
  const buckets = FOCUS_TO_BUCKETS[focus] || FOCUS_TO_BUCKETS.all;
  const hits = new Set<string>();
  for (const b of buckets) {
    const kws = [...(SIGNAL_KEYWORDS[b] || []), ...extraKeywords.map((k) => k.toLowerCase())];
    for (const kw of kws) {
      if (kw && t.includes(kw.toLowerCase())) { hits.add(b); break; }
    }
  }
  return [...hits];
}

// â”€â”€ AI Core å›žå†™ï¼ˆä¸Ž bot-competitor-ig-monitor åŒé€šé“ï¼‰ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function aicorePost(tenant: string, body: Record<string, any>, auth: string, base: string): Promise<{ ok: boolean; status?: number }> {
  const url = `${base.replace(/\/+$/, '')}/${tenant}/memory`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ ...body, tenant_id: tenant }),
    });
    if (resp.ok) {
      console.log(`[aicore] POST ${url} OK (entity_id=${body.entity_id})`);
      return { ok: true, status: resp.status };
    }
    console.warn(`[aicore] POST ${url} FAILED ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return { ok: false, status: resp.status };
  } catch (e: any) {
    console.warn(`[aicore] POST ${url} ERROR: ${e.message}`);
    return { ok: false };
  }
}

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// â”€â”€ æŠ“å–å•ä¸ª URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function scrapeUrl(page: Page, url: string): Promise<{ title: string; text: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const title = (await page.title()) || '';
    const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ').trim().slice(0, 8000);
    return { title, text };
  } catch (e: any) {
    console.warn(`[general-intel] æŠ“å–å¤±è´¥ ${url}: ${e.message}`);
    return { title: '', text: '' };
  }
}

async function runOnce() {
  const cfg = loadConfig();
  const AI_CORE_BASE = (process.env.AI_CORE_BASE || 'https://harvests-ai-core-api.inkflowapp.workers.dev').replace(/\/+$/, '');
  const AI_CORE_AUTH = process.env.AI_CORE_AUTH || 'Bearer dev';
  const tenant = cfg.GENERAL_TENANT;
  const industry = cfg.TARGET_INDUSTRY || 'general';
  const brands = (cfg.TARGET_BRANDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const urls = (cfg.SOURCE_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const extraKeywords = (cfg.KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const focus = cfg.INTEL_FOCUS;

  if (urls.length === 0) {
    console.log('[general-intel] æœªé…ç½® SOURCE_URLSï¼Œè·³è¿‡æœ¬è½®ï¼ˆåœ¨ ecosystem.env æˆ–å‰ç«¯å¡ç‰‡å¡«å†™ç›®æ ‡æº URLï¼‰ã€‚');
    return;
  }

  const proxy = (process.env.BOT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
  const browser = await chromium.launch({
    headless: true,
    proxy: proxy ? { server: proxy } : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' });

  let stored = 0;
  console.log(`[general-intel] è¡Œä¸š="${industry}" å“ç‰Œ=${brands.length} æºURL=${urls.length} èšç„¦=${focus}`);
  for (const url of urls) {
    const { title, text } = await scrapeUrl(page, url);
    if (!text) continue;
    const buckets = classify(text, focus, extraKeywords);
    if (buckets.length === 0) {
      console.log(`[general-intel] ${url} æ— å‘½ä¸­ä¿¡å·ï¼Œè·³è¿‡`);
      continue;
    }
    const entityId = `gi_${hashId(`${industry}|${url}|${title}`)}`;
    const body = {
      entity_id: entityId,
      type: 'general_intel',
      title: title || url,
      content: text.slice(0, 4000),
      source_url: url,
      industry,
      brands: brands.join(','),
      signals: buckets.join(','),
      focus,
      captured_at: new Date().toISOString(),
    };
    const r = await aicorePost(tenant, body, AI_CORE_AUTH, AI_CORE_BASE);
    if (r.ok) stored++;
  }
  await browser.close();
  console.log(`[general-intel] æœ¬è½®å®Œæˆï¼šå…¥åº“ ${stored} æ¡ï¼ˆtenant=${tenant}ï¼‰`);
}

async function main() {
  const loop = process.argv.includes('--loop');
  const idx = process.argv.indexOf('--interval-min');
  const intervalMin = idx >= 0 ? Math.max(10, Number(process.argv[idx + 1]) || 360) : 360;
  console.log(`=== é€šç”¨è¡Œä¸šæƒ…æŠ¥æœºå™¨äºº ===  loop=${loop} interval=${intervalMin}m`);
  if (loop) {
    // ç«‹å³è·‘ä¸€è½®ï¼Œå†è¿›å…¥å¾ªçŽ¯
    while (true) {
      try { await runOnce(); } catch (e: any) { console.error('[general-intel] run error:', e.message); }
      await new Promise((r) => setTimeout(r, intervalMin * 60_000));
    }
  } else {
    await runOnce();
  }
}

main().catch((e) => { console.error('[general-intel] fatal:', e?.message || e); process.exit(1); });
