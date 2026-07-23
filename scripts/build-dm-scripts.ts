import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
/**
 * build-dm-scripts.ts  ——  竞品留言 → DM 话术库（含系统化清洗/筛选层）
 *
 * 流程:
 *   提取真实留言 → 【清洗/筛选层】→ 去重 → 分类 → (可选改写) → POST 草稿(active=0) 待人工审
 *
 * 清洗层 (data/dm-script-filters.json 可编辑) 会拦截:
 *   - 提到竞品品牌词 (自动从抓取品牌列表 + 配置加载, 如 @kwadron / FK Irons / World Famous Ink)
 *   - 违禁/不符调性的词 (脏话/拉踩/knockoff 等)
 *   - spam 信号 (link in bio / dm me / giveaway / 付款方式 等)
 *   - 全大写吼叫、含 URL、过短/过长、赞数过低
 *   - (可选 FIT_CHECK=1) DeepSeek 品牌契合度二审, <3 分拦截
 * 被拦截的留言写入 data/dm-scripts-rejected.json 并标注原因, 透明可查。
 *
 * 前置: 先在 VPS 跑 `npx tsx scripts/bot-comments-scraper.ts` 生成 brand_captions_dataset.json
 * 运行: npx tsx scripts/build-dm-scripts.ts
 * 可选:
 *   REWRITE=1      用 DeepSeek 把留言改写成 outreach 口吻
 *   FIT_CHECK=1    开启 DeepSeek 品牌契合度二审 (需 DEEPSEEK_KEY)
 *   CLOUD_API_BASE=https://<worker>  BOT_TOKEN=dev
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(ENGINE_DIR, '..', 'data', 'brand_captions_dataset.json');
const FILTERS_FILE = path.join(ENGINE_DIR, 'dm-script-filters.json');
const REJECTED_FILE = path.join(ENGINE_DIR, '..', 'data', 'dm-scripts-rejected.json');
const API_BASE = (process.env.CLOUD_API_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.BOT_TOKEN || 'dev';
const REWRITE = process.env.REWRITE === '1';
const FIT_CHECK = process.env.FIT_CHECK === '1';
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || '';

// DM 四类 (与 bot pickAutoReply / create-marketing-task 对齐)
type DmCategory = 'product_intro' | 'collaboration' | 'industry_talk' | 'after_sales';
const CATEGORIES: DmCategory[] = ['product_intro', 'collaboration', 'industry_talk', 'after_sales'];

// ---------------- 筛选配置 ----------------
interface Filters {
  ourBrand: string;
  competitorBrands: string[];
  blockWords: string[];
  spamSignals: string[];
  minLen: number;
  maxLen: number;
  minLikes: number;
  rejectAllCapsRatio: number;
  rejectUrls: boolean;
  llmFitCheck: boolean;
}
function loadFilters(): Filters {
  const defaults: Filters = {
    ourBrand: 'peach', competitorBrands: [], blockWords: [], spamSignals: [],
    minLen: 8, maxLen: 280, minLikes: 5, rejectAllCapsRatio: 0.6, rejectUrls: true, llmFitCheck: false,
  };
  if (!fs.existsSync(FILTERS_FILE)) return defaults;
  try {
    const f = JSON.parse(fs.readFileSync(FILTERS_FILE, 'utf8'));
    return { ...defaults, ...f };
  } catch {
    return defaults;
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 检测是否提到竞品品牌 (自动覆盖 @handle / 空格写法, 如 "FK Irons"→fkirons) */
function detectCompetitorMention(text: string, ourBrand: string, competitors: string[]): string | null {
  const t = text.toLowerCase();
  const on = norm(ourBrand);
  for (const b of competitors) {
    const bl = b.toLowerCase();
    if (bl.length < 3) continue;
    // @handle 直接命中
    if (t.includes('@' + bl)) {
      if (on && norm(bl).includes(on)) continue; // 自家品牌不算竞品
      return b;
    }
    // 正文里出现 (归一化, 兼容空格写法)
    const bn = norm(bl);
    if (bn.length >= 3 && norm(t).includes(bn)) {
      if (on && bn.includes(on)) continue;
      return b;
    }
  }
  return null;
}

/** 返回拦截原因数组; 空数组=通过 */
function curate(text: string, likes: number, f: Filters): string[] {
  const reasons: string[] = [];
  const t = text.toLowerCase();
  const raw = text.trim();

  if (raw.length < f.minLen) reasons.push(`too_short(${raw.length})`);
  if (text.length > f.maxLen) reasons.push(`too_long(${text.length})`);
  if (f.minLikes > 0 && likes < f.minLikes) reasons.push(`low_likes(${likes}<${f.minLikes})`);

  for (const w of f.blockWords) {
    if (t.includes(w.toLowerCase())) { reasons.push(`unsafe_word:${w}`); break; }
  }
  for (const s of f.spamSignals) {
    if (t.includes(s.toLowerCase())) { reasons.push(`spam_signal:${s}`); break; }
  }
  if (f.rejectUrls && /https?:\/\/|www\.|\.com|\.io\b|\.co\b|linktr|bit\.ly/i.test(text)) {
    reasons.push('has_url');
  }
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 8) {
    const caps = letters.replace(/[^A-Z]/g, '').length;
    if (caps / letters.length >= f.rejectAllCapsRatio) reasons.push('shouting');
  }
  const brand = detectCompetitorMention(text, f.ourBrand, f.competitorBrands);
  if (brand) reasons.push(`competitor_mention:${brand}`);

  return reasons;
}

/** (可选) DeepSeek 品牌契合度二审: 返回 1-5 分 + 原因 */
async function llmFitScore(text: string): Promise<{ fit: number; reason: string }> {
  if (!DEEPSEEK_KEY) return { fit: 5, reason: '' };
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a brand-safety reviewer for a tattoo SUPPLY brand (ink, machines, needles, aftercare) doing IG outreach to tattoo ARTISTS. Given a comment scraped from a COMPETITOR\'s post, decide if it is SAFE and ON-BRAND to borrow as outreach phrasing. Rate fit 1-5 (5=safe/natural/on-brand, 1=off-brand/negative/spam/too salesy). Respond ONLY with JSON: {"fit":<int>,"reason":"<short>"}' },
          { role: 'user', content: text },
        ],
      }),
    });
    const j = await r.json();
    const m = j?.choices?.[0]?.message?.content?.trim();
    const parsed = m ? JSON.parse(m.replace(/```json|```/g, '')) : null;
    if (parsed && typeof parsed.fit === 'number') return { fit: parsed.fit, reason: parsed.reason || '' };
  } catch { /* 评审失败则放行, 不阻塞管道 */ }
  return { fit: 5, reason: '' };
}

// ---------------- 分类 / 改写 / 入库 (保留原逻辑) ----------------
function classifyComment(text: string): DmCategory {
  const t = text.toLowerCase();
  if (/(where|buy|order|shop|purchase|ship|shipping|available|stock|price|cost|how much|€|usd|\$)/.test(t)) return 'product_intro';
  if (/(collab|ambassador|artist program|pro team|rep|sponsor|partner)/.test(t)) return 'collaboration';
  if (/\?$|how|what|which|can you|do you|is it|recommend|vs\b/.test(t)) return 'after_sales';
  return 'industry_talk';
}
function dedupKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}
async function rewriteToOutreach(comment: string, brand: string): Promise<string> {
  if (!DEEPSEEK_KEY) return comment;
  try {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.8,
        messages: [
          { role: 'system', content: 'You are a tattoo SUPPLY brand (ink, machines, needles, aftercare) doing IG outreach to tattoo ARTISTS. Rewrite the user\'s collected competitor-post comment into a SHORT, natural 1-2 sentence DM opener a supply rep might send to an artist. No spam, no ALL CAPS, no links, no price. Keep it human. Return only the message.' },
          { role: 'user', content: `Brand context: a tattoo supply brand doing outreach to artists — do NOT name any brand (neither ours nor the competitor), keep it generic. Comment to adapt: "${comment}"` },
        ],
      }),
    });
    const j = await r.json();
    const out = j?.choices?.[0]?.message?.content?.trim();
    return out && out.length > 3 ? out : comment;
  } catch {
    return comment;
  }
}
async function postScript(s: { category: string; content: string; title: string; tone: string; tags: string; match_conditions: string }) {
  try {
    const r = await fetch(`${API_BASE}/api/marketing/scripts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...s, active: 0, direction: 'outbound' }),
    });
    return await r.json().catch(() => ({}));
  } catch (e: any) {
    return { error: e?.message || 'fetch_failed' };
  }
}

// ---------------- 主流程 ----------------
async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`找不到 ${DATA_FILE}。请先跑: npx tsx scripts/bot-comments-scraper.ts`);
    process.exit(1);
  }
  const filters = loadFilters();
  console.log(`筛选配置: 竞品品牌 ${filters.competitorBrands.length} 个 | 违禁词 ${filters.blockWords.length} | spam信号 ${filters.spamSignals.length} | 最低赞 ${filters.minLikes} | FIT_CHECK=${FIT_CHECK && !!DEEPSEEK_KEY}`);

  const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`载入语料: ${dataset.length} 帖子`);

  const seen = new Set<string>();
  const rejected: { brand: string; text: string; likes: number; reasons: string[]; category: string }[] = [];
  let passed = 0, rejectedCount = 0;
  const perCat: Record<string, number> = {};

  for (const post of dataset) {
    const brand = post.brand || 'unknown';
    for (const c of post.comments || []) {
      const text = (c.text || '').trim();
      const likes = Number(c.likes) || 0;
      if (text.length < 4) continue;
      const dk = dedupKey(text);
      if (seen.has(dk)) continue;
      seen.add(dk);

      // ① 清洗/筛选层
      const reasons = curate(text, likes, filters);
      const category = classifyComment(text);
      if (reasons.length) {
        rejected.push({ brand, text, likes, reasons, category });
        rejectedCount++;
        continue;
      }
      // ② (可选) DeepSeek 品牌契合度二审
      if (FIT_CHECK && DEEPSEEK_KEY) {
        const { fit, reason } = await llmFitScore(text);
        if (fit < 3) {
          rejected.push({ brand, text, likes, reasons: [`llm_fit:${fit}(${reason})`], category });
          rejectedCount++;
          continue;
        }
      }

      // ③ 通过 → 改写(可选) → 入库草稿
      const content = REWRITE ? await rewriteToOutreach(text, brand) : text;
      const res: any = await postScript({
        category,
        content,
        title: `[${brand}] ${category}`,
        tone: 'borrowed_from_competitor_comment',
        tags: `src:competitor_comment,brand:${brand},curated:pass`,
        match_conditions: JSON.stringify({ source: 'competitor_comment', brand, likes }),
      });
      if (res?.ok) {
        passed++;
        perCat[category] = (perCat[category] || 0) + 1;
        if (passed % 25 === 0) console.log(`  已入库 ${passed} 条...`);
      } else {
        console.log(`  [skip] ${brand}: ${res?.error || 'unknown'}`);
      }
    }
  }

  // 写拒绝留底
  if (rejected.length) {
    let existing: any[] = [];
    if (fs.existsSync(REJECTED_FILE)) {
      try { existing = JSON.parse(fs.readFileSync(REJECTED_FILE, 'utf8')); } catch {}
    }
    existing.push(...rejected);
    fs.writeFileSync(REJECTED_FILE, JSON.stringify(existing, null, 2), 'utf8');
  }

  console.log(`\n完成。通过入库(草稿): ${passed} 条 | 被拦截: ${rejectedCount} 条`);
  console.log('入库分布:', perCat);
  console.log(`被拦截原因已写入: ${REJECTED_FILE}`);
  if (rejectedCount) {
    const byReason: Record<string, number> = {};
    rejected.forEach(r => r.reasons.forEach(rr => {
      const key = rr.split(':')[0].split('(')[0];
      byReason[key] = (byReason[key] || 0) + 1;
    }));
    console.log('拦截原因分布:', byReason);
  }
  console.log('下一步: 前端 /marketing/scripts 审核 → 把合适的 active 改为 1 → bot DM 即按目标轮换发送');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
