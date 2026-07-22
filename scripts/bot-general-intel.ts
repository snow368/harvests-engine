/* eslint-disable no-console */
/**
 * bot-general-intel.ts
 * ─────────────────────────────────────────────────────────────────────────
 * 通用行业情报机器人 —— 面向任意行业/产品的通用情报采集 worker。
 *
 * 走「纹身机器人」同一套规则（配置 → 抓取 → 分类 → 入库）：
 *  - 配置来源：① ecosystem.env（dev 可直接改）② 前端卡片配置（经控制面落盘
 *    data/general-intel.config.json，启动时合并，前端优先）③ 进程 env。
 *  - 抓取：Playwright（headless chromium），GFW 下自动走 BOT_PROXY/HTTPS_PROXY。
 *  - 分类：本地关键词启发式，把文本切成 4 类信号（与纹身侧一致）：
 *      new_product（竞品/行业新品）· improvement（产品改进方向）·
 *      complaints（客户抱怨）· reviews（差评/口碑）。
 *  - 入库：写回 AI Core 知识库 `${GENERAL_TENANT}/memory`（默认 competitors:general），
 *    与 bot-competitor-ig-monitor 同一回写通道（Authorization: Bearer dev）。
 *
 * 用法：
 *  npx tsx scripts/bot-general-intel.ts                 # 跑一轮
 *  npx tsx scripts/bot-general-intel.ts --loop --interval-min 360   # 每 6h 一轮
 *
 * 配置键（与前端 BOT_FUNCTION_CATALOG.general_intel.configs 对齐）：
 *  TARGET_INDUSTRY  目标行业（如 "coffee equipment" / "宠物用品"）
 *  TARGET_BRANDS    品牌/竞品，逗号分隔
 *  SOURCE_URLS      目标源 URL，逗号分隔（产品页/评论页/社区帖/新闻）
 *  KEYWORDS         额外关键词，逗号分隔（可选，增强命中）
 *  INTEL_FOCUS      情报聚焦：new_product|improvement|complaints|reviews|all
 *  GENERAL_TENANT   AI Core 租户，默认 competitors:general
 */
import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENGINE_DIR = __filename.replace(/[/\\]scripts[/\\]bot-general-intel\.ts$/, '');
const CONFIG_FILE = path.join(ENGINE_DIR, 'data', 'general-intel.config.json');

// ── 配置解析（前端卡片 > 落盘文件 > env） ──────────────────────────────────
function loadConfig() {
  const cfg: Record<string, string> = {};
  // 1) env 默认值
  for (const k of ['TARGET_INDUSTRY', 'TARGET_BRANDS', 'SOURCE_URLS', 'KEYWORDS', 'INTEL_FOCUS', 'GENERAL_TENANT']) {
    if (process.env[k]) cfg[k] = process.env[k] as string;
  }
  // 2) 落盘文件（控制面从前端配置写入）
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const f = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      for (const k of Object.keys(f)) if (f[k] !== undefined && f[k] !== '') cfg[k] = String(f[k]);
    }
  } catch (e: any) {
    console.warn('[general-intel] 读配置文件失败，忽略:', e.message);
  }
  cfg.INTEL_FOCUS = cfg.INTEL_FOCUS || 'all';
  cfg.GENERAL_TENANT = cfg.GENERAL_TENANT || 'competitors:general';
  return cfg;
}

// ── 信号分类关键词（4 桶，与纹身侧情报语义对齐） ──────────────────────────
const SIGNAL_KEYWORDS: Record<string, string[]> = {
  new_product: [
    'new', 'launch', 'drop', 'release', 'restock', 'pre-order', 'preorder', 'now available',
    'just dropped', 'new arrival', '新品', '上新', '新款', '发布', '上市', '预售', '开售', '首发',
  ],
  improvement: [
    'improve', 'upgrade', 'redesign', 'better', 'enhanced', 'wish', 'should have', 'hope they',
    '建议', '改进', '优化', '希望', '期待', '升级', '更好用', '缺点',
  ],
  complaints: [
    'complain', 'issue', 'problem', 'broken', 'disappointed', 'terrible', 'worst', 'hate',
    '投诉', '问题', '坏了', '失望', '差评', '坑', '垃圾', '后悔', '崩溃',
  ],
  reviews: [
    'review', 'rating', 'star', 'recommend', 'worth', 'love', 'best', 'quality',
    '评测', '评价', '推荐', '值得', '喜欢', '质量', '好评', '种草',
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

// ── AI Core 回写（与 bot-competitor-ig-monitor 同通道） ────────────────────
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

// ── 抓取单个 URL ──────────────────────────────────────────────────────────
async function scrapeUrl(page: Page, url: string): Promise<{ title: string; text: string }> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    const title = (await page.title()) || '';
    const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ').trim().slice(0, 8000);
    return { title, text };
  } catch (e: any) {
    console.warn(`[general-intel] 抓取失败 ${url}: ${e.message}`);
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
    console.log('[general-intel] 未配置 SOURCE_URLS，跳过本轮（在 ecosystem.env 或前端卡片填写目标源 URL）。');
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
  console.log(`[general-intel] 行业="${industry}" 品牌=${brands.length} 源URL=${urls.length} 聚焦=${focus}`);
  for (const url of urls) {
    const { title, text } = await scrapeUrl(page, url);
    if (!text) continue;
    const buckets = classify(text, focus, extraKeywords);
    if (buckets.length === 0) {
      console.log(`[general-intel] ${url} 无命中信号，跳过`);
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
  console.log(`[general-intel] 本轮完成：入库 ${stored} 条（tenant=${tenant}）`);
}

async function main() {
  const loop = process.argv.includes('--loop');
  const idx = process.argv.indexOf('--interval-min');
  const intervalMin = idx >= 0 ? Math.max(10, Number(process.argv[idx + 1]) || 360) : 360;
  console.log(`=== 通用行业情报机器人 ===  loop=${loop} interval=${intervalMin}m`);
  if (loop) {
    // 立即跑一轮，再进入循环
    while (true) {
      try { await runOnce(); } catch (e: any) { console.error('[general-intel] run error:', e.message); }
      await new Promise((r) => setTimeout(r, intervalMin * 60_000));
    }
  } else {
    await runOnce();
  }
}

main().catch((e) => { console.error('[general-intel] fatal:', e?.message || e); process.exit(1); });
