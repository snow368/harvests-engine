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

// ========== 纹身风格分类器（核心：测到帖子具体是什么风格） ==========
// canonical key → 正文别名 + hashtag(不含 #)。置信度：
//   high   = 作者在 caption/hashtag 自标该风格（文本信号，VISION 安全，评论可深入）
//   medium = 仅 IG alt 文本猜测（不深引，谨慎）
//   low    = 无信号（安全通用评论）
export type StyleDetection = {
  primary: string;            // canonical key，对应 STYLE_CRITIQUE / DOMAIN_PHRASES.styles
  all: string[];              // 命中的 canonical keys
  confidence: 'high' | 'medium' | 'low';
  source: 'hashtag' | 'caption' | 'alt' | 'none';
};

const TATTOO_STYLE_TAXONOMY: { key: string; aliases: string[]; hashtags: string[] }[] = [
  { key: 'blackwork', aliases: ['blackwork','black work','solid black','black out'], hashtags: ['blackwork','blackworktattoo','blackworktattoos','solidblack','blackouttattoo','blackout'] },
  { key: 'fine line', aliases: ['fine line','fineline','fine-line','single needle','single-needle','thin line','minimal line'], hashtags: ['fineline','finelinetattoo','finelinetattoos','single-needle','singleneedle','thinlinetattoo','thinlinetattoos','microneedle','minimalisttattoo','minimaltattoo','minimaltattoos'] },
  { key: 'traditional', aliases: ['traditional','old school','american traditional','americana','bold will hold'], hashtags: ['traditional','trad','oldtattoo','oldschooltattoo','americantraditional','tradtattoo','tattootrad'] },
  { key: 'neo traditional', aliases: ['neo traditional','neo-traditional','neo trad'], hashtags: ['neotraditional','neotrad','neotraditionaltattoo'] },
  { key: 'new school', aliases: ['new school','newschool'], hashtags: ['newschool','newschooltattoo','newskool'] },
  { key: 'japanese', aliases: ['japanese','irezumi','japanesetattoo','horimono'], hashtags: ['japanese','irezumi','japanesetattoo','japanesetattoos','horimono','japantattoo'] },
  { key: 'realism', aliases: ['realism','realistic','photo realistic','photoreal'], hashtags: ['realism','realistic','realismtattoo','realistictattoo','photorealism','photoreal'] },
  { key: 'black and grey', aliases: ['black and grey','black & grey','black and gray','black & gray','bng','grey wash','gray wash'], hashtags: ['blackandgrey','blackandgray','blackandgreytattoo','bang','bngtattoo','greywash','graywash'] },
  { key: 'color', aliases: ['color tattoo','colour tattoo','color realism','colour realism'], hashtags: ['colortattoo','colour tattoo','colorrealism','colourrealism','colortattoos'] },
  { key: 'microrealism', aliases: ['microrealism','micro realism','mini realism'], hashtags: ['microrealism','microrealistic','microrealismtattoo','miniaturetattoo'] },
  { key: 'watercolor', aliases: ['watercolor','watercolour','water color','water colour'], hashtags: ['watercolor','watercolortattoo','watercolour','watercolourtattoo'] },
  { key: 'dotwork', aliases: ['dotwork','stippling','stipple','pointillism'], hashtags: ['dotwork','dotworktattoo','stippling','stippled','pointillism'] },
  { key: 'geometric', aliases: ['geometric','sacred geometry'], hashtags: ['geometric','geometrictattoo','sacredgeometry','geotattoo'] },
  { key: 'tribal', aliases: ['tribal','polynesian','maori','samoan'], hashtags: ['tribal','tribaltattoo','polynesian','polynesiantattoo','maoritattoo','samoantattoo'] },
  { key: 'trash polka', aliases: ['trash polka'], hashtags: ['trashpolka','trashpolkatattoo'] },
  { key: 'illustrative', aliases: ['illustrative','illustration style'], hashtags: ['illustrative','illustrativetattoo','illustrationtattoo'] },
  { key: 'ornamental', aliases: ['ornamental','ornament'], hashtags: ['ornamental','ornamentaltattoo','ornament'] },
  { key: 'lettering', aliases: ['lettering','script tattoo','handlettering','hand lettering','calligraphy tattoo'], hashtags: ['lettering','letteringtattoo','scripttattoo','handlettering','calligraphy'] },
  { key: 'portrait', aliases: ['portrait tattoo','portrait'], hashtags: ['portraittattoo','portrait'] },
  { key: 'surrealism', aliases: ['surrealism','surreal'], hashtags: ['surrealism','surrealtattoo','surreal'] },
  { key: 'cover up', aliases: ['cover up','cover-up','coverup'], hashtags: ['coverup','coveruptattoo','cover'] },
  { key: 'linework', aliases: ['linework','line work','line art','line-art'], hashtags: ['linework','lineart','lineworktattoo','linearttattoo'] },
  { key: 'minimalist', aliases: ['minimalist','minimal'], hashtags: ['minimalist','minimal','minimalisttattoo'] },
  { key: 'chicano', aliases: ['chicano','chicano style'], hashtags: ['chicano','chicanotattoo'] },
  { key: 'anime', aliases: ['anime','anime tattoo'], hashtags: ['anime','animetattoo','animatattoo'] },
];

const extractHashtags = (text?: string): string[] => {
  if (!text) return [];
  const m = String(text).toLowerCase().match(/#([a-z0-9_]+)/g) || [];
  return m.map((t) => t.slice(1));
};

const normAlias = (s: string) => s.toLowerCase();

const aliasHit = (haystack: string, alias: string): boolean => {
  if (/\s/.test(alias)) return haystack.includes(alias); // 多词别名直接包含
  // 单词别名用边界匹配：仅 空格/#/开头/结尾 算边界，避免 non-traditional 误命中 traditional
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\s#])${esc}([\s#]|$)`, 'i').test(haystack);
};

export const detectTattooStyle = (caption?: string, alt?: string, providedHashtags?: string[]): StyleDetection => {
  const cap = normAlias(caption || '');
  const altNorm = normAlias(alt || '');
  const tags = (providedHashtags && providedHashtags.length ? providedHashtags : extractHashtags(caption))
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const tagSet = new Set(tags);

  const selfLabeled: string[] = [];
  const altLabeled: string[] = [];
  let selfSource: StyleDetection['source'] = 'none';

  for (const { key, aliases, hashtags } of TATTOO_STYLE_TAXONOMY) {
    const inHashtag = hashtags.some((h) => tagSet.has(h.replace(/[^a-z0-9]/g, '')));
    const inCaption = aliases.some((a) => aliasHit(cap, a));
    const inAlt = aliases.some((a) => aliasHit(altNorm, a));
    if (inHashtag || inCaption) {
      selfLabeled.push(key);
      if (inHashtag && selfSource === 'none') selfSource = 'hashtag';
      else if (inCaption && selfSource === 'none') selfSource = 'caption';
    } else if (inAlt) {
      altLabeled.push(key);
    }
  }

  if (selfLabeled.length) return { primary: selfLabeled[0], all: selfLabeled, confidence: 'high', source: selfSource };
  if (altLabeled.length) return { primary: altLabeled[0], all: altLabeled, confidence: 'medium', source: 'alt' };
  return { primary: '', all: [], confidence: 'low', source: 'none' };
};

// 风格专属「深层工艺角度」——仅谈工艺/传统/技法大方向（VISION 安全，绝不断言视觉结果）。
export const STYLE_DEEP_ANGLES: Record<string, string[]> = {
  'fine line': [
    'single-pass discipline — keeping line weight consistent without going back over',
    'avoiding blowouts at the thinnest weights',
    'bugpin vs standard round liner for crisp fine line',
  ],
  'blackwork': [
    'planning the solid-black masses vs negative space before you start',
    'packing solid black without leaving holidays',
    'balancing bold black mass against bare skin',
  ],
  'traditional': [
    'bold will hold — why those lines stay thick',
    'spit-shade vs whip-shade on trad fades',
    'limited-palette discipline in traditional',
  ],
  'neo traditional': [
    'line-weight variation for illustrative depth',
    'how the decorative background supports the focal subject',
    'color palette choices that read as neo-trad',
  ],
  'japanese': [
    'mikiri — the fade where motifs meet the background',
    'how the background flows with the body contour',
    'placing the main motif vs supporting elements',
  ],
  'realism': [
    'building value range from darks to lights',
    'keeping a consistent light source across the piece',
    'handling midtones so it does not go muddy',
  ],
  'black and grey': [
    'grey-wash mixing and dilution ratios',
    'soft vs hard edges in B&G',
    'pushing contrast without solid black',
  ],
  'microrealism': [
    'needle control at that tiny scale',
    'keeping detail readable once it heals',
  ],
  'watercolor': [
    'keeping color bleeds controlled (not muddy)',
    'pairing a solid anchor with the watercolor wash',
  ],
  'dotwork': [
    'building gradient purely from dot density',
    'stipple vs machine-dotwork rhythm',
  ],
  'geometric': [
    'locking symmetry across the piece',
    'dot precision on mandala layering',
  ],
  'lettering': [
    'script weight and flow',
    'keeping flourishes from breaking up over time',
  ],
  'tribal': [
    'negative-space rhythm in the patterns',
    'how the bold curves follow the muscle',
  ],
  'ornamental': [
    'pattern rhythm and consistent spacing',
    'how the flow follows the body',
  ],
  'illustrative': [
    'line quality — mixing fine + bold',
    'composition that makes it read as illustrative',
  ],
};

/**
 * 构建专业纹身师视角的 prompt
 */
const buildPrompt = (input: CommentInput, style: string): string => {
  const postType = detectPostType(
    input.caption || '',
    input.imageAlt ? [input.imageAlt] : []
  );

  const conf = input.styleConfidence || 'low';
  // 🔴 评论铁律（2026-08-09 修订·用户拍板）：bot 完全无看图能力，只能读文字。
  // 规则：① 绝不断言看得到的视觉工艺(shading/linework/composition/contrast/color/execution)——除非 caption 自己写了；
  // ② 可引用题材/风格，但 ONLY IF caption 明确写出（caption 是可读文字，图就是那个题材，不会牛头不对马嘴）；③ 不编 caption 没提到的题材。
  const styleForContext = conf === 'high' || conf === 'medium' ? (input.style || '') : '';
  const deepAngles = (conf === 'high' || conf === 'medium') && input.style ? (STYLE_DEEP_ANGLES[input.style] || []) : [];
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

  const deepNote = deepAngles.length
    ? `\nSTYLE-DEEP MODE (safe — the artist self-identified "${input.style}" in text): engage with ${input.style}-specific CRAFT KNOWLEDGE using the angles below. Talk about the style's process, tradition, or how it is built — never claim you observed the visual result. Style craft angles to draw from:\n${deepAngles.map((a) => '- ' + a).join('\n')}`
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

  const STYLE_INSTRUCTIONS: Record<string, string> = {
    professional: 'Tone: a fellow tattoo artist giving brief, respectful pro feedback. A statement, not a question.',
    casual: 'Tone: a relaxed peer/fan reacting. A short statement, not a question.',
    question: "Tone: curious peer. End with ONE genuine, low-pressure question. If a style is detected, make it style-relevant — ask about that style's process, tradition, or how it is built (e.g. for blackwork: how you plan the negative space; for japanese: the mikiri transitions). Questions drive replies. Keep it natural.",
    short_praise: 'Tone: very short genuine praise (2-5 words). A statement, not a question.',
    detail_focused: 'Tone: reference a specific subject/theme the caption names (never visual technique), and you may add a light question. Do NOT claim visual quality.',
  };
  const styleInstruction = STYLE_INSTRUCTIONS[style] || STYLE_INSTRUCTIONS.casual;

  return `${tattooContext}

Post context: ${postContext}

${langGuide}

${styleConfNote}${deepNote}

Style instruction: ${styleInstruction}

Rules:
- NEVER sound like spam, bot, marketing, or a customer
- NEVER mention buying anything, supplies, DM for info, check bio, etc.
- You CANNOT see the image. Do NOT claim visual technique (shading/linework/composition/contrast/color) you did not observe.
- If a tattoo style is detected and confidence is high, you MAY reference it and engage with its craft (the artist named the style in text, so this is safe and relevant). Never claim you observed the visual quality — only discuss the style's process/tradition/technique in general terms.
- You MAY name the tattoo's subject or style ONLY if the caption explicitly states it; otherwise keep it general. Do NOT invent a subject the caption does not mention.
- Use tattoo industry language naturally — don't force it
- 6-20 words. If your style is "question", a short sentence ending in a question is perfect.
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

  // 随机选风格：提问(question)为主力——问题是引回评/点赞的第一杠杆；
  // 降权纯赞美(short_praise)因为它几乎不引发互动；保留 casual 做自然调剂。
  const weights = [0.15, 0.25, 0.45, 0.10, 0.05];  // professional, casual, question, short_praise, detail_focused
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
