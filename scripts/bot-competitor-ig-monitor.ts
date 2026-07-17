/**
 * bot-competitor-ig-monitor.ts
 * ─────────────────────────────────────────────────────────────────────────
 * 竞品 Instagram 新品监测 → 写回 AI Core 知识库（competitors:tattoo 租户）。
 *
 * 背景：bot-worker-cloak.ts 的 supply_analysis 已经能抓竞品 supply 品牌 IG 并
 * 分析上新玩法，但它只做本地分析，从不把「新品」写回知识库。本脚本补上这最后一环：
 * 把竞品账号的帖子写成 memory_item（brand=竞品, first_seen=发帖时间），复用现有
 * 供给侧 diff 引擎（captureSnapshot / listIntelEvents）自动在「新品情报」板冒出。
 *
 * 复用：
 *  - Playwright 已登录 Chrome（默认 CDP http://localhost:9222，与 bot-worker 同 session）
 *  - _scrape_brand_posts.ts 的 post 页解析（caption + 图片 + postedAt，JSON script 提取）
 *  - AI Core createMemory 字段（见 D:\harvests-ai-core\packages\memory\src\index.ts）
 *
 * 去重新品逻辑（即用户说的「先用 bot worker 比对下，后续发的就是新品」）：
 *  - 首跑 / --baseline：把竞品现有帖子全量灌入，first_seen = 真实发帖时间 → 不当新品
 *  - 增量：按 post shortcode 去重，从未见过的帖 → first_seen = now → 在「新品」板冒出
 *
 * 用法：
 *  npx tsx scripts/bot-competitor-ig-monitor.ts            # 跑一轮增量（默认）
 *  npx tsx scripts/bot-competitor-ig-monitor.ts --baseline # 全量灌基线
 *  npx tsx scripts/bot-competitor-ig-monitor.ts --loop --interval-min 360  # 每 6h 一轮
 *  npx tsx scripts/bot-competitor-ig-monitor.ts --include-all  # 非关键词帖也存为 social_post
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

// Windows 上 localhost 常先解析到 IPv6(::1)，而 Chrome 的 CDP 只监听 127.0.0.1(IPv4)。
// 这会导致 connectOverCDP 的 WebSocket 握手失败、被误报为「CDP 不可用」。强制 IPv4 优先。
dns.setDefaultResultOrder('ipv4first');

// ── 配置（与 bot-worker-real.ts 同源，方便 VPS 复用 env） ───────────────────
const IG_BASE = (process.env.INSTAGRAM_BASE || 'https://www.instagram.com').replace(/\/+$/, '');
const AI_CORE_BASE = (process.env.AI_CORE_BASE || 'https://harvests-ai-core-api.inkflowapp.workers.dev').replace(/\/+$/, '');
const AI_CORE_AUTH = process.env.AI_CORE_AUTH || 'Bearer dev';
const CDP_URL = (process.env.BOT_CDP_URL || 'http://127.0.0.1:9222').trim();
// 本机代理（GFW 下抓 IG 必需）。如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7891
// 兼容：用户常只设 HTTPS_PROXY/HTTP_PROXY，浏览器也必须走同一代理才能抓到 IG
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

// 「新品」触发关键词（命中视为上新候选）
const NEW_PRODUCT_KEYWORDS = [
  'new', 'launch', 'drop', 'release', 'restock', 'back in stock', 'pre-order', 'preorder',
  'now available', 'just dropped', 'now live', 'fresh drop',
  '上架', '上新', '新品', '新款', '补货', '现货', '开售', '首发', '预售',
];
// 次要信号：caption 里出现 SKU 形态（如 CON-1209MG / PEACH-0803RL）
const SKU_RE = /\b(PEACH-|CON-|AES-|COG-|CAN-BU-|KW-|MG|RL|RS|MAG)\b[\w-]*/i;

const jitter = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// ── 读取监视列表 ──────────────────────────────────────────────────────────
function loadWatchList(): { brand: string; handle: string; tenant: string }[] {
  const out: { brand: string; handle: string; tenant: string }[] = [];
  // 1) JSON 配置文件（与 _scrape_brand_posts.ts 用 data/brand_database.json 同一约定）
  if (fs.existsSync(WATCH_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
      for (const c of cfg.competitors || []) {
        if (c.brand && c.handle && c.handle !== 'REPLACE_WITH_REAL_HANDLE') {
          out.push({ brand: c.brand, handle: String(c.handle).replace(/^@/, ''), tenant: c.tenant || 'competitors:tattoo' });
        } else if (c.handle === 'REPLACE_WITH_REAL_HANDLE') {
          console.warn(`[warn] ${c.brand}: handle 仍是占位符，跳过（请在 data/competitor_watch.json 填入真实 IG handle）`);
        }
      }
    } catch (e: any) {
      console.warn('[warn] 读取 competitor_watch.json 失败:', e.message);
    }
  }
  // 2) 环境变量覆盖：COMPETITOR_HANDLES=painpleasure:@handle,brand2:@handle2
  const env = (process.env.COMPETITOR_HANDLES || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of env) {
    const [brand, handle] = e.split(':').map((s) => s.trim());
    if (brand && handle) out.push({ brand, handle: handle.replace(/^@/, ''), tenant: 'competitors:tattoo' });
  }
  return out;
}

// ── 本地去重状态 ──────────────────────────────────────────────────────────
function loadState(): Record<string, { lastRun: string; seen: Record<string, string> }> {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s: Record<string, { lastRun: string; seen: Record<string, string> }>) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// ── AI Core 写回（mirror bot-worker-real.ts 的 aicorePost） ─────────────────
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

// ── 浏览器：优先 CDP 复用已登录 session，否则 persistent ───────────────────
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
    console.log(`[browser] CDP 不可用 (${reason})，回退 persistent profile ${PROFILE_DIR}`);
    const ctxOpts: any = {
      headless: false, channel: 'chrome',
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
      ignoreDefaultArgs: ['--enable-automation'],
      ignoreHTTPSErrors: true,
    };
    if (BROWSER_PROXY) {
      ctxOpts.proxy = { server: BROWSER_PROXY };
      console.log(`[browser] 使用代理 ${BROWSER_PROXY}`);
    }
    const context = await chromium.launchPersistentContext(PROFILE_DIR, ctxOpts);
    const page = context.pages()[0] || await context.newPage();
    return { browser: context.browser()!, context, page, viaCdp: false };
  }
}

// ── 抓主页 tile 链接（复用 _scrape_brand_posts 选择器） ───────────────────
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

// ── 抓 post 页内容（复用 _scrape_brand_posts.scrapePost 的 JSON 提取） ──────
// ── 抓 post 页完整内容（caption + 全部图片 + 评论 + 互动量） ─────────────
// 返回整篇帖子素材，供 content pipeline 生成社媒图/视频直接取用。
async function scrapePost(page: Page, url: string): Promise<{
  caption: string; imageUrl: string; postedAt: string;
  imageUrls: string[]; comments: { author: string; text: string; likes: number }[];
  likes_count: number | null; comments_count: number | null;
}> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(jitter(1500, 2500));
  // 登录墙检测：未登录时 IG 会把 /p/xxx 重定向到 /accounts/login 或塞登录弹窗
  const loginWall = await page.evaluate(() => {
    const u = location.href;
    if (/\/accounts\/login/i.test(u)) return 'redirected to /accounts/login';
    const t = document.body?.innerText || '';
    if (/log in to see|Log in to Instagram|登录以查看|请先登录/i.test(t) &&
        !document.querySelector('script[type="application/json"]')) return 'login wall dialog';
    return '';
  }).catch(() => '');
  if (loginWall) throw new Error(`login wall (${loginWall}) — 该 Chrome profile 未登录 Instagram`);
  // 优先从 post 页内嵌 JSON 抽取完整结构（caption / carousel 图 / 评论 / 互动）
  const data = await page.evaluate(() => {
    const pick = (o: any): any => {
      if (!o || typeof o !== 'object') return null;
      if (o.shortcode_media) return o.shortcode_media;
      for (const k of Object.keys(o)) {
        const v = (o as any)[k];
        if (v && typeof v === 'object' && v.shortcode_media) return v.shortcode_media;
      }
      return null;
    };
    const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
    let media: any = null;
    for (const s of scripts) {
      try {
        const d = JSON.parse(s.textContent || '{}');
        media = pick(d?.graphql) || pick(d?.data) || pick(d) || media;
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
  // 兜底：只拿 caption + og:image（评论/多图拿不到）
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

// 评论相关性分类：判断一条评论是否"对项目有用"，并标注意图。
// 注意：这里只打标签，不丢弃——整篇帖子（含全部评论）都会存，方便 content
// pipeline 取完整上下文；"有用"标签用于留言洞察筛选。
const COMMENT_INTENT_KEYWORDS: Record<string, string[]> = {
  product_question: ['where', 'buy', 'price', 'how much', 'cost', 'available', 'in stock', 'restock', 'link', 'shop', 'order', '哪', '买', '多少钱', '有货', '补货', '链接', '求', '入手', '同款', '现货', '店铺'],
  complaint: ['broken', 'broke', 'sucks', 'disappointed', 'fake', 'scam', 'terrible', 'bad quality', '差', '坏', '假', '坑', '失望', '垃圾', '劣质', '退货', '投诉'],
  lead: ['want', 'need', 'looking for', 'interested', 'dm me', 'want this', '想要', '需要', '私', '感兴趣', '求购', '蹲'],
  praise: ['love', 'amazing', 'great', 'perfect', 'obsessed', '好看', '喜欢', '美', '绝', '爱了', '太棒', 'nice'],
};
function classifyComment(text: string): { useful: boolean; intent: string } {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return { useful: false, intent: 'empty' };
  // 纯表情 / 过短 = 噪音，不打有用标签
  const stripped = t.replace(/[\p{Emoji}\s]/gu, '');
  if (stripped.length < 3) return { useful: false, intent: 'noise' };
  for (const [intent, kws] of Object.entries(COMMENT_INTENT_KEYWORDS)) {
    if (kws.some((k) => t.includes(k.toLowerCase()))) return { useful: true, intent };
  }
  return { useful: false, intent: 'other' };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function runCompetitor(c: { brand: string; handle: string; tenant: string }, opts: { baseline: boolean; includeAll: boolean }, state: Record<string, any>) {
  const tiles = await scrapeProfileTiles(page!, c.handle, MAX_POSTS_PER_BRAND);
  console.log(`\n[${c.brand}] @${c.handle}: ${tiles.length} 帖`);
  const brandState = state[c.brand] || { lastRun: '', seen: {} as Record<string, string> };
  let wroteNew = 0, wroteBaseline = 0, skipped = 0, wrotePosts = 0, fetchFail = 0;

  for (const url of tiles) {
    const code = shortcodeFromUrl(url);
    const alreadySeen = !!brandState.seen[code];
    const post = await scrapePost(page!, url).catch((e: any) => {
      console.warn(`  [抓取失败] ${code}: ${(e && e.message) || e}`);
      return null;
    });
    if (!post) { skipped++; fetchFail++; continue; }
    const hits = keywordHits(post.caption);
    const hasSku = SKU_RE.test(post.caption);
    const isNewProduct = hits.length > 0 || hasSku;

    // 记录到 seen（无论是否写入，避免重复处理）
    if (!alreadySeen) brandState.seen[code] = post.postedAt || new Date().toISOString();

    if (alreadySeen) { skipped++; continue; }

    // 整篇帖子（图 + 评论 + 互动量）全量写入 competitor_post，作为 content
    // pipeline 生成社媒图/视频的原料，以及留言洞察的数据源。每条新帖都写一次。
    await writeCompetitorPost(c, code, post, hits);
    wrotePosts++;

    // 首跑/--baseline：全量灌入，first_seen = 真实发帖时间（不当新品）
    if (opts.baseline) {
      await writeMemory(c, code, post, false, hits, opts.includeAll);
      wroteBaseline++;
      await sleep(jitter(800, 1500));
      continue;
    }

    // 增量：只写「新品」候选；非关键词帖默认跳过（--include-all 才存 social_post）
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
  console.log(`[${c.brand}] 本轮: 整帖(competitor_post)写 ${wrotePosts}, 新品写 ${wroteNew}, 基线写 ${wroteBaseline}, 跳过 ${skipped}(抓取失败 ${fetchFail} / 已见过 ${seenSkip})`);
  if (fetchFail > 0 && wrotePosts === 0) {
    console.log(`  ⚠️ 全部 ${fetchFail} 篇详情抓取失败。最常见原因：该 Chrome profile 未登录 Instagram（详情页 /p/ 被登录墙拦），或代理不稳导致 goto 超时。上面的 [抓取失败] 行给出了每篇的真实原因。`);
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

// 写整篇帖子素材（caption + 全部图片 + 评论 + 互动量）为 competitor_post 类型。
// 这是 content pipeline 生成社媒图/视频的原料，也是「留言洞察」的数据源。
// 评论逐条打 useful/intent 标签（不打标签不丢弃），方便前端筛选「有用留言」。
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

// ── 入口 ──────────────────────────────────────────────────────────────────
let page: Page | null = null;
async function main() {
  const args = process.argv.slice(2);
  const baseline = args.includes('--baseline');
  const includeAll = args.includes('--include-all');
  const loop = args.includes('--loop');
  const intervalMin = Number(args.find((a) => a.startsWith('--interval-min='))?.split('=')[1] || '360');

  const watch = loadWatchList();
  if (watch.length === 0) {
    console.error('没有可监视的竞品（data/competitor_watch.json 为空或全是占位符，或 COMPETITOR_HANDLES 未设）。退出。');
    process.exit(1);
  }
  console.log(`=== Competitor IG Monitor (baseline=${baseline}, includeAll=${includeAll}) ===`);
  console.log(`监视: ${watch.map((w) => `${w.brand}@${w.handle}`).join(', ')}`);

  const { browser, page: p, viaCdp } = await launchBrowser();
  page = p;

  const tick = async () => {
    const state = loadState();
    for (const c of watch) {
      try { await runCompetitor(c, { baseline, includeAll }, state); }
      catch (e: any) { console.warn(`[${c.brand}] 失败: ${e.message?.slice(0, 100)}`); }
      await sleep(jitter(2000, 4000));
    }
    saveState(state);
  };

  await tick();
  if (loop) {
    console.log(`\n进入循环模式，每 ${intervalMin} 分钟一轮 (Ctrl+C 退出)`);
    while (true) { await sleep(intervalMin * 60_000); await tick(); }
  }
  // CDP 模式复用 bot-worker 的 Chrome，绝不关闭；仅 persistent 回退时才关
  if (!viaCdp) {
    try { await browser.close(); } catch {}
  }
}

// 仅在直接运行时执行（被 import 时不跑，方便将来复用函数）
const invoked = process.argv[1]?.replace(/\\/g, '/').endsWith('bot-competitor-ig-monitor.ts');
if (invoked) {
  main().catch((e) => { console.error('Fatal:', e?.message || e); process.exit(1); });
}
