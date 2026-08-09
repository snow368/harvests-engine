/**
 * 评论生成器 — 基于 DeepSeek API 生成自然真人评论
 * 不依赖 Gemini，内容贴近纹身社区真实交流风格
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildTattooArtistContext, detectPostType, getSpanishFallback } from './tattoo-voice';

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const COMMENT_LANG = (process.env.BOT_COMMENT_LANG || 'auto').trim().toLowerCase(); // auto | en | es | it | pt | fr | de

// Language detection via common function words + character ranges
const LANG_SIGNALS: Record<string, { words: string[]; weight: number }> = {
  en: { words: ['the','and','is','in','of','to','this','for','with','that','are','was','not','but','from','have','they','she','he','love','work','piece','clean','done'], weight: 1.0 },
  es: { words: ['el','la','los','las','que','de','en','un','una','con','por','para','del','como','más','pero','muy','está','bien','trabajo','pieza','quedó','hermoso','buen'], weight: 1.0 },
  it: { words: ['il','la','che','di','in','un','una','per','con','come','più','sono','molto','bello','lavoro','pezzo','fatto','bene','questa','questo','tatuaggio'], weight: 1.0 },
  pt: { words: ['que','não','uma','com','para','mais','muito','bem','trabalho','peça','ficou','lindo','está','como','isso','esse','essa','tatuagem'], weight: 1.0 },
  fr: { words: ['que','pas','une','dans','pour','avec','plus','très','bien','beau','cette','fait','pièce','tatouage','magnifique','super','trop','jamais'], weight: 1.0 },
  de: { words: ['der','die','das','und','ist','ein','eine','mit','von','auf','sich','auch','nicht','sehr','gut','arbeit','stück','schön','tattoo','toll','super'], weight: 1.0 },
};

const detectPostLanguage = (caption?: string): string => {
  if (!caption || caption.trim().length < 10) return COMMENT_LANG === 'auto' ? 'en' : COMMENT_LANG;
  const text = caption.toLowerCase().replace(/[^a-zÀ-ÿ\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 8) return COMMENT_LANG === 'auto' ? 'en' : COMMENT_LANG;

  const words = text.split(/\s+/).filter(w => w.length > 1);
  if (words.length < 4) return COMMENT_LANG === 'auto' ? 'en' : COMMENT_LANG;

  const scores: Record<string, number> = {};
  for (const [lang, sig] of Object.entries(LANG_SIGNALS)) {
    let hits = 0;
    const wordSet = new Set(words);
    for (const kw of sig.words) {
      if (wordSet.has(kw)) hits++;
    }
    // Also check character range signals
    let charSignal = 0;
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (lang === 'es' && (code === 0xF3 || code === 0xFA || code === 0xE1 || code === 0xE9 || code === 0xED || code === 0xF1)) charSignal++;
      if (lang === 'it' && (code === 0xE0 || code === 0xE8 || code === 0xEC || code === 0xF2 || code === 0xF9)) charSignal++;
      if (lang === 'pt' && (code === 0xE3 || code === 0xF5 || code === 0xE7 || code === 0xEA || code === 0xF4)) charSignal++;
      if (lang === 'fr' && (code === 0xE0 || code === 0xE2 || code === 0xE8 || code === 0xE9 || code === 0xEA || code === 0xEB || code === 0xEE || code === 0xF4 || code === 0xFB || code === 0xE7)) charSignal++;
      if (lang === 'de' && (code === 0xE4 || code === 0xF6 || code === 0xFC || code === 0xDF)) charSignal++;
    }
    scores[lang] = (hits * sig.weight) + (charSignal * 0.3);
  }

  // Find language with highest score
  let bestLang = 'en';
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; bestLang = lang; }
  }

  // Require minimum signal to switch from default
  if (bestScore < 1.5) return COMMENT_LANG === 'auto' ? 'en' : COMMENT_LANG;

  // If user set a specific language, respect it (not auto)
  if (COMMENT_LANG !== 'auto') return COMMENT_LANG;

  return bestLang;
};

const STATE_DIR = path.join(process.env.BOT_STATE_DIR || './data/bot_state');
const DEDUP_FILE = path.join(STATE_DIR, 'comment_gen_dedup.json');

// 评论风格模板池 - 轮换使用保证多样性
const COMMENT_STYLES = [
  'professional',    // 专业点评
  'casual',          // 随性称赞
  'question',        // 提问互动
  'short_praise',    // 简短赞美
  'detail_focused',  // 关注细节
];

type CommentInput = {
  caption?: string;
  imageAlt?: string;
  artistHandle?: string;
  style?: string;           // tattoo style detected
  styleConfidence?: string; // 'high' | 'medium' | 'low' — alt-text verified
  likeCount?: number;
  commentCount?: number;
  isReel?: boolean;
};

type GeneratedComment = {
  text: string;
  style: string;
  tokens?: number;
};

const safeJsonParse = (text: string, fallback: any) => {
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
};

/**
 * 从对话历史中提取最近生成的评论文本用于去重
 */
const MAX_RECENT = 20;

const loadDedup = (): string[] => {
  try {
    if (!fs.existsSync(DEDUP_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.slice(-MAX_RECENT) : [];
  } catch { return []; }
};

const saveDedup = (texts: string[]) => {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(DEDUP_FILE, JSON.stringify(texts.slice(-MAX_RECENT)), 'utf8');
  } catch {}
};

let recentCommentTexts: string[] = loadDedup();

const isTooSimilar = (text: string, threshold = 0.6): boolean => {
  const lower = text.toLowerCase().trim();
  for (const prev of recentCommentTexts) {
    const prevLower = prev.toLowerCase().trim();
    // Simple overlap check - if >60% words overlap, skip
    const words1 = new Set(lower.split(/\s+/).filter((w) => w.length > 2));
    const words2 = new Set(prevLower.split(/\s+/).filter((w) => w.length > 2));
    if (words1.size === 0 || words2.size === 0) continue;
    const intersectionSize = Array.from(words1).filter((w) => words2.has(w)).length;
    const overlap = intersectionSize / Math.min(words1.size, words2.size);
    if (overlap >= threshold) return true;
  }
  return false;
};

/**
 * 构建专业纹身师视角的 prompt
 */
const buildPrompt = (input: CommentInput, _style: string): string => {
  const postType = detectPostType(
    input.caption || '',
    input.imageAlt ? [input.imageAlt] : []
  );

  const conf = input.styleConfidence || 'low';
  // 🔴 评论铁律（2026-08-09 修订·用户拍板）：bot 完全无看图能力，只能读文字。
  // 规则：① 绝不断言看得到的视觉工艺(shading/linework/composition/contrast/color/execution)——除非 caption 自己写了；
  // ② 可引用题材/风格，但 ONLY IF caption 明确写出（caption 是可读文字，图就是那个题材，不会牛头不对马嘴）；③ 不编 caption 没提到的题材。
  const styleForContext = conf === 'high' || conf === 'medium' ? (input.style || '') : '';
  const tattooContext = buildTattooArtistContext(postType, styleForContext);

  const postContext = [
    input.caption ? `Post caption: "${input.caption.slice(0, 300)}"` : null,
    // ⚠️ imageAlt 是 IG 自动生成、可能不准；仅作弱提示，subject 以 caption 为准，绝不可仅凭 alt 判定题材
    input.imageAlt ? `Image auto-description (may be inaccurate — weak hint only, prefer the caption for subject): "${input.imageAlt.slice(0, 200)}"` : null,
    input.isReel ? '(Video/Reel)' : '(Static post)',
    `Stats: ${input.likeCount || '?'} likes, ${input.commentCount || '?'} comments`,
  ].filter(Boolean).join(' | ');

  // 视觉规则：最高优先级。bot 无看图能力，只能读 caption 文字；可引用题材但 ONLY IF caption 写出。
  const NEUTRAL_RULE = `VISION RULE (highest priority): You CANNOT see the image — you only read text. Therefore:
- NEVER claim visual qualities you did not observe: do NOT assert shading, linework quality, composition, contrast, color, or execution as if you saw them. (Only exception: the caption itself describes that quality — then you may echo it.)
- You MAY reference the tattoo's subject or style, but ONLY if the post caption explicitly states it. The caption is text you can read, and the image depicts that same thing, so this is safe and relevant. Do NOT invent a subject the caption does not mention.
- Stay natural, like a fellow artist/enthusiast reacting to what the post describes. No spam, no marketing.`;

  const styleConfNote = conf === 'low'
    ? `You cannot see the image. ${NEUTRAL_RULE} Read the caption to find what the tattoo is, and you may acknowledge that subject/style if the caption names it. Never claim visual technique you cannot verify.`
    : conf === 'medium'
    ? `${NEUTRAL_RULE} (The style above is only a text guess from caption/alt — you may reference it if the caption states it, but never claim you observed the visual result.)`
    : `${NEUTRAL_RULE} (The style above is text-confirmed from caption — you may reference it, but never claim you observed the visual quality.)`;

  const lang = (COMMENT_LANG === 'auto' || COMMENT_LANG === 'es') && (input.caption || '').trim().length >= 10
    ? detectPostLanguage(input.caption)
    : COMMENT_LANG;
  const LANG_GUIDES: Record<string, string> = {
    en: 'Write in English. Use natural tattoo industry English.',
    es: 'Write in Spanish. Use natural Latin American tattoo community Spanish.',
    it: 'Write in Italian. Use natural Italian tattoo community Italian.',
    pt: 'Write in Portuguese. Use natural Brazilian tattoo community Portuguese.',
    fr: 'Write in French. Use natural French tattoo community French.',
    de: 'Write in German. Use natural German tattoo community German.',
  };
  const langGuide = LANG_GUIDES[lang] || LANG_GUIDES['en'];

  return `${tattooContext}

Post context: ${postContext}

${langGuide}

${styleConfNote}

Rules:
- NEVER sound like spam, bot, marketing, or a customer
- NEVER mention buying anything, supplies, DM for info, check bio, etc.
- You CANNOT see the image. Do NOT claim visual technique (shading/linework/composition/contrast/color) you did not observe.
- You MAY name the tattoo's subject or style ONLY if the caption explicitly states it; otherwise keep it general. Do NOT invent a subject the caption does not mention.
- Use tattoo industry language naturally — don't force it
- 6-20 words. One short sentence is often best.
- Max 1 emoji. Often no emoji is more authentic.

Return ONLY JSON: {"text": "your comment", "style": "tattoo_artist"}`;
};

/**
 * 调用 DeepSeek API 生成评论
 */
const callDeepSeek = async (prompt: string): Promise<string> => {
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You generate authentic Instagram comments. You respond only with valid JSON. You never sound like AI.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.9,  // Higher temperature for more variety
      max_tokens: 80,
      top_p: 0.95,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`DeepSeek API ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
};

/**
 * 主入口：生成一条自然评论
 */
export const generateComment = async (input: CommentInput): Promise<GeneratedComment> => {
  if (!DEEPSEEK_API_KEY) {
    // 无 API key 时直接用模板库
    const fallbacks = [
      'This is really well done.',
      'Great work as always.',
      'Such a clean piece.',
      'This turned out great.',
      'Really nice post.',
      'Awesome tattoo.',
      'Love this, great work.',
      'This is solid work.',
    ];
    const fbText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    return { text: fbText, style: 'fallback' };
  }

  // 随机选风格，但倾向简短赞美和随性
  const weights = [0.30, 0.30, 0.10, 0.25, 0.05];  // professional, casual, question, short_praise, detail_focused — 偏向中性工艺评论，降权 detail_focused/question 防题材错配
  const r = Math.random();
  let acc = 0;
  let styleIdx = 1; // default casual
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r <= acc) { styleIdx = i; break; }
  }
  const style = COMMENT_STYLES[styleIdx];

  // 最多重试3次生成不重复的评论
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = buildPrompt(
      attempt > 0 ? { ...input, caption: '' } : input, // 重试时降级上下文
      attempt > 0 ? 'short_praise' : style
    );
    const raw = await callDeepSeek(prompt);
    const parsed = safeJsonParse(raw, { text: raw.slice(0, 100), style });

    let text = String(parsed.text || '').trim();
    // 清理常见的 AI 废话
    text = text.replace(/^(here's|here is|sure|okay|of course|absolutely)[,:!. ]+/i, '');
    text = text.replace(/[""]/g, '"').replace(/['']/g, "'");
    text = text.slice(0, 150); // 硬截断

    if (!text || text.length < 3) continue;
    if (isTooSimilar(text)) continue;

    // 加入历史去重
    recentCommentTexts.push(text);
    if (recentCommentTexts.length > MAX_RECENT) recentCommentTexts.shift();
    saveDedup(recentCommentTexts);

    return { text, style, tokens: text.length };
  }

  // 最终 fallback — 模板库
  const fallbacks = [
    'This is really well done.',
    'Great work as always.',
    'Such a clean piece.',
    'This turned out great.',
    'Really nice post.',
    'Awesome tattoo.',
    'Love this, great work.',
    'This is solid work.',
  ];
  const fbText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  recentCommentTexts.push(fbText);
  if (recentCommentTexts.length > MAX_RECENT) recentCommentTexts.shift();
  saveDedup(recentCommentTexts);
  return { text: fbText, style: 'fallback' };
};

/**
 * 批量预生成评论池（预热，降低实时调用延迟）
 */
export const warmupCommentPool = async (count: number = 8): Promise<string[]> => {
  const pool: string[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const result = await generateComment({
        caption: `Tattoo post #${i + 1}`,
        style: 'various',
      });
      pool.push(result.text);
    } catch {
      // Skip failed generation
    }
  }
  return pool;
};

/**
 * 从预生成池里随机取一条（供 bot worker 调用）
 */
let commentPool: string[] = [];
export const getFromPool = (): string | null => {
  if (commentPool.length === 0) return null;
  const idx = Math.floor(Math.random() * commentPool.length);
  return commentPool.splice(idx, 1)[0];
};

export const refillPool = async (): Promise<void> => {
  if (commentPool.length > 3) return;
  const newComments = await warmupCommentPool(5);
  commentPool.push(...newComments);
};

export const clearRecentHistory = () => {
  recentCommentTexts = [];
  saveDedup([]);
};
