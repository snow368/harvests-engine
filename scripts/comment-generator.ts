/**
 * 评论生成器 — 基于 DeepSeek API 生成自然真人评论
 * 不依赖 Gemini，内容贴近纹身社区真实交流风格
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildTattooArtistContext, detectPostType, getSpanishFallback } from './tattoo-voice';
import { getCorpusContext } from './comment-corpus.js';

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
const PERMANENT_HISTORY_FILE = path.join(STATE_DIR, 'comment_gen_history.jsonl');

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
  likeCount?:  number;
  commentCount?: number;
  isReel?: boolean;
  tags?: string[];          // 视觉标签（fine_line / black_and_grey 等），用于检索公开语料做风格参考
};

type GeneratedComment = {
  text: string;
  style: string;
  tokens?: number;
};

export const sanitizeVerifiedFacts = (facts: unknown[]): string[] => facts
  .map((fact) => String(fact || '').trim())
  .filter(Boolean)
  .filter((fact) => !/\b(heal(?:ed|ing)?|steril(?:e|ized|isation|ization)|safe(?:r|ty)?|certif(?:ied|ication)|pain|infection)\b/i.test(fact))
  .filter((fact) => !/\b(on|around|against)\s+(?:the\s+)?(?:skin|arm|leg|thigh|back|chest|shoulder|hand|neck|forearm|body)\b/i.test(fact))
  .slice(0, 12);

/** Final closed-fact firewall shared by tests and the live worker. */
export const validateGroundedComment = (text: string, facts: string[]): string[] => {
  const risks: string[] = [];
  const normalized = text.trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (!normalized) risks.push('empty');
  if (words.length < 3 || words.length > 24) risks.push('unsafe_length');
  if (/[?？]/.test(normalized)) risks.push('question_not_allowed');
  const banned: Array<[string, RegExp]> = [
    ['client_or_booking_language', /\b(book(?:ing)?|appointment|availability|available slot|next tattoo|tattoo me|want this|need this|would get|where are you located)\b/i],
    ['sales_or_dm_language', /\b(dm me|send (?:me|us) a dm|buy|order|shop now|check (?:my|our) bio|discount|promo|wholesale|supplier|supplies)\b/i],
    ['unsupported_style_claim', /\b(microrealism|blackwork|traditional|neo[- ]?traditional|watercolor|realism)\b/i],
    ['botty_that_opening', /^(?:that|this)\b/i],
    ['botty_body_placement_phrase', /\b(?:that|this)\s+.+\bsits\s+(?:really\s+)?nicely\s+on\s+the\s+(?:skin|arm|leg|thigh|back|chest|shoulder|hand|neck)\b/i],
    ['botty_generic_template', /\b(?:really\s+)?(?:holds together nicely|stands out(?:\s+on\s+the\s+\w+)?|looks really nice|solid piece|coming together really nicely|is seriously striking)\b/i],
    ['malformed_short_fragment', /\b(?:tha|th|gh|rse)\b/i],
  ];
  for (const [label, pattern] of banned) if (pattern.test(normalized)) risks.push(label);
  const factText = facts.join(' ').toLowerCase();
  const claims: Array<[string, RegExp, RegExp]> = [
    ['unsupported_color_claim', /\b(black|blackwork|grey|gray|color|colour|white ink)\b/i, /\b(black|grey|gray|color|colour|white ink)\b/i],
    ['unsupported_line_claim', /\b(fine\s*line|linework|line work|lines?|outline)\b/i, /\b(fine\s*line|linework|line work|lines?|outline)\b/i],
    ['unsupported_shading_claim', /\b(shad(?:e|ed|ing)|gradient|blend(?:ed|ing|s)?)\b/i, /\b(shad(?:e|ed|ing)|gradient|blend(?:ed|ing|s)?)\b/i],
    ['unsupported_saturation_claim', /\b(saturat(?:ed|ion)|pack(?:ed|ing)|solid fill|solid black)\b/i, /\b(saturat(?:ed|ion)|pack(?:ed|ing)|solid fill|solid black)\b/i],
    ['unsupported_composition_claim', /\b(composition|flow|flows|placement)\b/i, /\b(composition|flow|flows)\b/i],
    ['unsupported_edge_claim', /\b(edge|edges|edge-to-edge)\b/i, /\b(edge|edges|edge-to-edge)\b/i],
  ];
  for (const [label, claim, grounded] of claims) if (claim.test(normalized) && !grounded.test(factText)) risks.push(label);
  return [...new Set(risks)];
};

const factsFromClosedFactInput = (input: CommentInput): string[] => {
  const imageAlt = input.imageAlt || '';
  const match = imageAlt.match(/^Verified visual facts only:\s*(.+)$/i);
  if (!match) return [];
  return match[1]
    .split(';')
    .map((fact) => fact.trim())
    .filter(Boolean)
    .slice(0, 12);
};

const hasFact = (facts: string[], pattern: RegExp): boolean => facts.some((fact) => pattern.test(fact));

const groundedTemplateCandidates = (facts: string[]): string[] => {
  const candidates: string[] = [];
  const floral = hasFact(facts, /\b(floral|botanical|rose|flower)\b/i);
  const skull = hasFact(facts, /\bskull\b/i);
  const animal = hasFact(facts, /\banimal\b/i);
  const portrait = hasFact(facts, /\bportrait\b/i);
  const lettering = hasFact(facts, /\blettering\b/i);
  const geometric = hasFact(facts, /\b(geometric|ornamental)\b/i);
  const blackGrey = hasFact(facts, /\bblack[- ]and[- ]grey|black and grey\b/i);
  const color = hasFact(facts, /\bfull[- ]color|full color\b/i);
  const fineLine = hasFact(facts, /\bfine linework|fine line\b/i);
  const boldLine = hasFact(facts, /\bbold linework|bold line\b/i);
  const shading = hasFact(facts, /\b(shading|gradient|dotwork|stipple|solid fill)\b/i);
  const flow = hasFact(facts, /\b(composition|flow|wraps|centered)\b/i);

  if (floral && shading) candidates.push('Soft shading gives the floral work a lot of depth.');
  if (floral && fineLine) candidates.push('Fine lines keep the floral details feeling really delicate.');
  if (floral && blackGrey) candidates.push('Black-and-grey works beautifully with those floral details.');
  if (floral && color) candidates.push('The color choices make the floral details feel alive.');
  if (skull && shading) candidates.push('Nice depth through the skull shading.');
  if (animal && shading) candidates.push('The shading gives the animal motif real dimension.');
  if (portrait && blackGrey) candidates.push('Black-and-grey suits the portrait work really well.');
  if (lettering && boldLine) candidates.push('The lettering reads clean with that bold linework.');
  if (geometric && fineLine) candidates.push('Sharp fine-line control in the ornamental details.');
  if (blackGrey && shading) candidates.push('The black-and-grey shading has a clean, controlled feel.');
  if (color && boldLine) candidates.push('Bold lines give the color work a strong read.');
  if (fineLine && shading) candidates.push('Fine linework and soft shading balance nicely here.');
  if (boldLine && shading) candidates.push('Bold linework and shading give this a strong read.');
  if (flow && floral) candidates.push('The floral shapes carry the composition nicely.');
  if (flow && shading) candidates.push('The shading helps the whole composition read clearly.');

  return candidates;
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
// Keep a longer memory so large-scale natural variants do not collapse into
// the same handful of phrases across multiple bot sessions.
const MAX_RECENT = 200;

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

const normalizePermanent = (text: string): string => text.toLowerCase()
  .replace(/[^a-z0-9À-ÿ\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const FILLER_WORDS = new Set(['a','an','the','this','that','it','is','so','such','really','very','just','on','in','of','and','here']);
const commentSkeleton = (text: string): string => [...new Set(normalizePermanent(text)
  .split(' ')
  .filter((word) => word.length > 1 && !FILLER_WORDS.has(word)))]
  .sort()
  .join('|');

const permanentTexts = new Set<string>();
const permanentSkeletons = new Set<string>();

const rememberLoaded = (text: string) => {
  const normalized = normalizePermanent(text);
  const skeleton = commentSkeleton(text);
  if (normalized) permanentTexts.add(normalized);
  if (skeleton) permanentSkeletons.add(skeleton);
};

for (const text of recentCommentTexts) rememberLoaded(text);
try {
  if (fs.existsSync(PERMANENT_HISTORY_FILE)) {
    for (const line of fs.readFileSync(PERMANENT_HISTORY_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rememberLoaded(String(JSON.parse(line)?.text || '')); } catch {}
    }
  } else if (recentCommentTexts.length) {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const migrated = recentCommentTexts.map((text) => JSON.stringify({
      text,
      normalized: normalizePermanent(text),
      skeleton: commentSkeleton(text),
      createdAt: new Date().toISOString(),
      migrated: true,
    })).join('\n');
    fs.writeFileSync(PERMANENT_HISTORY_FILE, `${migrated}\n`, 'utf8');
  }
} catch {}

const recordPermanent = (text: string) => {
  const normalized = normalizePermanent(text);
  const skeleton = commentSkeleton(text);
  if (!normalized) return;
  permanentTexts.add(normalized);
  if (skeleton) permanentSkeletons.add(skeleton);
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(PERMANENT_HISTORY_FILE, `${JSON.stringify({ text, normalized, skeleton, createdAt: new Date().toISOString() })}\n`, 'utf8');
  } catch {}
};

const isTooSimilar = (text: string, threshold = 0.82): boolean => {
  const lower = text.toLowerCase().trim();
  const normalized = normalizePermanent(text);
  const skeleton = commentSkeleton(text);
  if (permanentTexts.has(normalized) || (skeleton && permanentSkeletons.has(skeleton))) return true;
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
const buildPrompt = (input: CommentInput, variationStyle: string, corpusHints: string[] = []): string => {
  const hasVerifiedVisionFacts = /^Verified visual facts only:/i.test(input.imageAlt || '');
  const postType = detectPostType(
    input.caption || '',
    input.imageAlt ? [input.imageAlt] : []
  );

  const conf = input.styleConfidence || 'low';
  // Only inject style-specific vocabulary when image-aware detection confirms it.
  // Low confidence → generic technical comment (no style terms that could mismatch).
  const styleForContext = conf === 'high' || conf === 'medium' ? input.style : '';
  const tattooContext = hasVerifiedVisionFacts
    ? 'You are writing a short, respectful industry comment using a closed list of verified visual facts.'
    : buildTattooArtistContext(postType, styleForContext);

  const postContext = [
    input.caption ? `Post caption: "${input.caption.slice(0, 300)}"` : null,
    input.imageAlt ? `Image: "${input.imageAlt.slice(0, 200)}"` : null,
    input.isReel ? '(Video/Reel)' : '(Static post)',
    `Stats: ${input.likeCount || '?'} likes, ${input.commentCount || '?'} comments`,
  ].filter(Boolean).join(' | ');

  const styleConfNote = hasVerifiedVisionFacts
    ? 'CRITICAL CLOSED-FACT MODE: The Image field is the complete list of facts you may use. Every concrete visual or technical claim in the comment must be directly stated there. Convert those facts into an ordinary human compliment; do not repeat them like a vision report, inventory, or anatomy description. Do not introduce ink color, black/grey/colorwork, linework, shading, saturation, packing, contrast, composition, flow, edges, placement, healing state, tools, or style unless the exact idea appears in the verified facts. When facts are generic, vary the wording of plain overall praise instead of inventing detail. Do not ask a question. InkFlow is a tattoo-supply industry account, not a potential tattoo client. Never imply booking interest, ask for price/location/availability, use client-style language, or promote products.'
    : conf === 'low'
    ? 'CRITICAL: You cannot see the image. Do NOT guess the tattoo style. Stick to universal technical observations (technique, composition, application quality). Do not name a specific style unless the caption explicitly states it.'
    : conf === 'medium'
    ? 'The style may be "{style}". You can mention it briefly, but focus more on execution quality and technique.'
    : '';

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

  const variationGuides: Record<string, string> = {
    professional: 'restrained peer-to-peer praise; calm and specific only where verified',
    casual: 'warm casual reaction; natural wording without slang overload',
    question: 'observational reaction phrased as a statement, never a question',
    short_praise: 'very concise praise with a fresh sentence structure',
    detail_focused: 'respond to one verified fact in ordinary language, or overall presence when facts are generic',
  };
  const variationGuide = variationGuides[variationStyle] || variationGuides.casual;
  const recentWording = hasVerifiedVisionFacts
    ? recentCommentTexts.slice(-12).map((text) => `- ${text}`).join('\n')
    : '';

  return `${tattooContext}

Post context: ${postContext}

${langGuide}

${styleConfNote}

Variation direction: ${variationGuide}.
${recentWording ? `Do not reuse the wording or sentence structure of these earlier comments:\n${recentWording}` : ''}
${corpusHints.length ? `Reference tone only (NEVER copy; mirror the natural wording/structure in your own words). Community comments from similar tattoos:\n${corpusHints.map((t) => `- ${t}`).join('\n')}` : ''}

Rules:
- NEVER sound like spam, bot, marketing, or a customer
- Avoid starting with "That" or "This"; it has been overused
- NEVER mention buying anything, supplies, DM for info, check bio, etc.
- In CLOSED-FACT MODE, prefer plain praise over unsupported tattoo terminology
- Do not ask a question in CLOSED-FACT MODE
- Do not use body-placement filler like "sits nicely on the thigh/arm/skin"
- Do not use empty template praise like "solid piece", "stands out", "holds together nicely", or "seriously striking"
- Good examples when grounded by facts: "Soft shading gives the floral work a lot of depth." / "Fine lines keep the ornamental details feeling precise."
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
  const closedFacts = factsFromClosedFactInput(input);
  const hasVerifiedVisionFacts = closedFacts.length > 0;
  if (hasVerifiedVisionFacts) {
    const templateDrafts = groundedTemplateCandidates(closedFacts);
    for (const text of templateDrafts.sort(() => Math.random() - 0.5)) {
      if (!isTooSimilar(text) && validateGroundedComment(text, closedFacts).length === 0) {
        recentCommentTexts.push(text);
        if (recentCommentTexts.length > MAX_RECENT) recentCommentTexts.shift();
        saveDedup(recentCommentTexts);
        recordPermanent(text);
        return { text, style: 'grounded_template', tokens: text.length };
      }
    }
  }

  if (!DEEPSEEK_API_KEY) {
    if (hasVerifiedVisionFacts) throw new Error('grounded_comment_requires_specific_facts');
    // 无 API key 时直接用模板库
    const fallbacks = [
      'Love the shading on this piece.',
      'Clean linework, really nice result.',
      'Smooth blends on this one.',
      'Nice saturation, the color holds well.',
      'Great composition, flows really nicely.',
      'The contrast in this is beautiful.',
      'Really clean work.',
      'This is awesome.',
    ];
    const fbText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    return { text: fbText, style: 'fallback' };
  }

  // 随机选风格，但倾向简短赞美和随性
  const weights = [0.15, 0.25, 0.2, 0.25, 0.15];  // professional,, casual, question, short_praise, detail_focused
  const r = Math.random();
  let acc = 0;
  let styleIdx = 1; // default casual
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r <= acc) { styleIdx = i; break; }
  }
  const style = COMMENT_STYLES[styleIdx];

  // Fetch community-style references from the public comment corpus (only when the
  // post carries visual tags). Never copied — used purely as tone/structure guidance.
  const corpusHints = (input.tags && input.tags.length) ? getCorpusContext(input.tags, 4) : [];

  // Grounded comments have a smaller truthful vocabulary, so give the model more
  // chances and rotate rhetorical direction instead of rejecting the whole draft.
  const variationOrder = ['professional', 'casual', 'short_praise', 'detail_focused', 'question', 'casual', 'professional', 'short_praise'];
  for (let attempt = 0; attempt < variationOrder.length; attempt++) {
    const prompt = buildPrompt(
      attempt > 0 ? { ...input, caption: '' } : input,
      attempt === 0 ? style : variationOrder[attempt],
      corpusHints
    );
    const raw = await callDeepSeek(prompt);
    const parsed = safeJsonParse(raw, { text: raw.slice(0, 100), style });

    let text = String(parsed.text || '').trim();
    // 清理常见的 AI 废话
    text = text.replace(/^(here's|here is|sure|okay|of course|absolutely)[,:!. ]+/i, '');
    text = text.replace(/[""]/g, '"').replace(/['']/g, "'");
    text = text.slice(0, 150); // 硬截断

    if (!text || text.length < 3) continue;
    if (hasVerifiedVisionFacts && validateGroundedComment(text, closedFacts).length > 0) continue;
    if (isTooSimilar(text)) continue;

    // 加入历史去重
    recentCommentTexts.push(text);
    if (recentCommentTexts.length > MAX_RECENT) recentCommentTexts.shift();
    saveDedup(recentCommentTexts);
    recordPermanent(text);

    return { text, style, tokens: text.length };
  }

  if (hasVerifiedVisionFacts) {
    throw new Error('grounded_comment_variants_exhausted');
  }

  // 最终 fallback — 仅供不经过视觉审核的旧调用；新评论流程不会使用
  const fallbacks = [
    'Love the shading on this piece.',
    'Clean linework, really nice result.',
    'The composition here is on point.',
    'Such a solid piece, great execution.',
    'This is really well done.',
    'Love how the tones turned out on this.',
    'Incredible detail work.',
    'The contrast in this is beautiful.',
  ];
  const fbText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  recentCommentTexts.push(fbText);
  if (recentCommentTexts.length > MAX_RECENT) recentCommentTexts.shift();
  saveDedup(recentCommentTexts);
  recordPermanent(fbText);
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
