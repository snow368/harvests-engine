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
  visionDescription?: string; // 视觉模型对图的观测描述（TEXT，安全可引用）；为空=无图信号
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

// 风格专属「内行细节维度」——每风格 3-5 个懂行人才会注意的具体工艺点。
// ⚠️ 这些是对 STYLE 本身的工艺知识（谈过程/传统/技法），不是对「这张图」视觉结果的断言（VISION 安全）。
// 评论落到一个具体细节上，艺术家才会觉得"这人真懂行"→ 点赞/回评率上升。
export const STYLE_DEEP_ANGLES: Record<string, string[]> = {
  'fine line': [
    'that single-pass discipline — one clean run, no going back over the line',
    'how the thinnest taper stays crisp instead of blowing out into the skin',
    'the control where a line drops from bold to a whisper',
    'bugpin vs standard liner for that hairline finish',
  ],
  'blackwork': [
    'how the negative space does the work — the bare skin reads as the highlight, not the black',
    'keeping packed-black edges crisp, no fuzzy halo where it meets skin',
    'planning the black as one continuous mass instead of scattered chunks',
    'using solid black to create depth with zero grey',
  ],
  'traditional': [
    'bold will hold — why those thick outlines are the whole point',
    'whip-shade vs spit-shade on the fades',
    'the 3-4 color discipline that makes it read across a room',
    'those solid color packs with no patchy gaps',
  ],
  'neo traditional': [
    'the line-weight variation that builds illustrative depth',
    'how the decorative background frames the focal subject instead of crowding it',
    'that palette — muted but punchy, very neo-trad',
  ],
  'japanese': [
    'mikiri — the fade where a motif dissolves into the background',
    'how the background flows with the body contour, not against it',
    'placing the main motif vs the supporting elements for balance',
    'the way scale is used to show depth in a full sleeve',
  ],
  'realism': [
    'building the full value range from deep darks to bright lights',
    'holding one consistent light source across the whole piece',
    'keeping midtones clean so it never goes muddy',
    'the skin texture detail that sells the realism',
  ],
  'black and grey': [
    'grey-wash dilution ratios for those soft transitions',
    'knowing when to use a soft edge vs a hard one',
    'pushing contrast with wash alone, no solid black needed',
  ],
  'color': [
    'saturation control so colors stay punchy instead of muddy',
    'laying color without blowing out the line',
    'packing a flat area solid in one pass vs building it up',
  ],
  'microrealism': [
    'needle control at that tiny scale',
    'keeping the detail readable once it heals, not blending together',
    'how you hold the value range on a thumbnail-sized piece',
  ],
  'watercolor': [
    'keeping the color bleeds controlled, not turning to mud',
    'pairing a solid anchor line with the wash so it does not drift',
    'layering washes so the colors stay translucent, not opaque',
  ],
  'dotwork': [
    'building the whole gradient from dot density alone',
    'the rhythm of machine dotwork vs hand stipple',
    'how dot spacing implies form without any line',
  ],
  'geometric': [
    'locking perfect symmetry across the whole mandala',
    'dot precision where the layers meet',
    'how the geometry follows the body plane without distorting',
  ],
  'tribal': [
    'the negative-space rhythm in the pattern',
    'how the bold curves follow the muscle, not cross it',
    'how the negative space defines the shape as much as the black',
  ],
  'trash polka': [
    'the red-black contrast and that chaotic collage energy',
    'mixing realistic fragments with graphic black marks',
    'the torn / splatter transitions between elements',
  ],
  'illustrative': [
    'mixing fine and bold line for that drawn feel',
    'composition that reads as illustration, not just a tattoo',
    'the way it reads like a page lifted from a sketchbook',
  ],
  'ornamental': [
    'pattern rhythm and even spacing across the flow',
    'how the ornament follows the body line',
    'negative space working with the pattern, not against it',
  ],
  'lettering': [
    'script weight and flow — keeping the letters connected naturally',
    'how the flourishes stay intact as it ages',
    'the contrast of thick and thin strokes inside one word',
  ],
  'portrait': [
    'catching likeness through value, not just outline',
    'the soft skin-tone transitions',
    'keeping the eyes alive',
  ],
  'surrealism': [
    'the dreamlike scale shifts between elements',
    'blending realistic rendering with impossible forms',
    'the impossible perspective that makes it feel like a dream',
  ],
  'cover up': [
    'using the old ink as part of the new design',
    'strategic black to kill the old contrast',
    'designing around the old piece instead of just hiding it',
  ],
  'linework': [
    'consistent line weight across the whole piece',
    'a line that flows without hesitant stops',
    'the confident single-weight contour',
  ],
  'minimalist': [
    'saying more with the least possible line',
    'negative space doing the storytelling',
    'one perfect gesture instead of detail',
  ],
  'chicano': [
    'the rolled-letter script flow',
    'franco-style black and grey fades',
    'the iconic blocks — clowns, roses, lettering',
  ],
  'anime': [
    'keeping the cel-shaded look crisp',
    'line economy that reads as anime, not generic',
    'clean fills inside bold outlines',
  ],
  'new school': [
    'that exaggerated 3D shading and cartoon proportion',
    'bold outlines with wild gradient fills',
    'how the highlights pop off the wobbly lines',
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
  const hasVision = !!(input.visionDescription && input.visionDescription.trim());
  // 🔴 评论铁律（2026-08-09 修订·用户拍板，2026-08-10 扩展视觉）：
  // 无视觉模型时：bot 只能读文字，绝不断言看不见的视觉工艺。
  // 有视觉模型时：视觉模型"替 bot 看了图"并产出 TEXT 观测（visionDescription），bot 可以把这些
  //   "别人描述给你听的图内容"当作可信素材引用 —— 但绝不超出观测范围去编。
  // 风格深入(STYLE-DEEP)仍仅在 high 触发：high 来自作者自标(caption/hashtag) 或 视觉确认(模型真看了图)。
  //   medium = 仅 IG alt 图 AI 猜测（可能不准），low = 无信号 —— 二者一律不深入风格、不假装懂。
  const styleForContext = conf === 'high' ? (input.style || '') : '';
  const deepAngles = conf === 'high' && input.style ? (STYLE_DEEP_ANGLES[input.style] || []) : [];
  const tattooContext = buildTattooArtistContext(postType, styleForContext);

  const postContext = [
    input.caption ? `Post caption: "${input.caption.slice(0, 300)}"` : null,
    // ⚠️ imageAlt 是 IG 自动生成、可能不准；仅作弱提示，subject 以 caption 为准，绝不可仅凭 alt 判定题材
    input.imageAlt ? `Image auto-description (may be inaccurate — weak hint only, prefer the caption for subject): "${input.imageAlt.slice(0, 200)}"` : null,
    hasVision ? `IMAGE ANALYSIS (observed facts from a vision model — you MAY reference these as if described to you, but NEVER claim visual qualities beyond this list): ${input.visionDescription!.slice(0, 400)}` : null,
    input.isReel ? '(Video/Reel)' : '(Static post)',
    `Stats: ${input.likeCount || '?'} likes, ${input.commentCount || '?'} comments`,
  ].filter(Boolean).join(' | ');

  // 视觉规则：最高优先级。当无图观测时维持"只能读文字"；当有图观测时允许引用观测到的细节。
  const NEUTRAL_RULE = hasVision
    ? `VISION RULE (highest priority): You have an IMAGE ANALYSIS describing what was observed (see IMAGE ANALYSIS in Post context). You MAY reference those observed details — the subject, craft (linework/shading/composition/color/negative space), and palette — because they were reported by analysis, not imagined. Do NOT claim any visual quality NOT listed in the IMAGE ANALYSIS. You may ALSO reference the tattoo's subject/style if the caption states it. Never invent. Stay natural, like a fellow artist reacting to the post. No spam, no marketing.`
    : `VISION RULE (highest priority): You CANNOT see the image — you only read text. Therefore:
- NEVER claim visual qualities you did not observe: do NOT assert shading, linework quality, composition, contrast, color, or execution as if you saw them. (Only exception: the caption itself describes that quality — then you may echo it.)
- You MAY reference the tattoo's subject or style, but ONLY if the post caption explicitly states it. The caption is text you can read, and the image depicts that same thing, so this is safe and relevant. Do NOT invent a subject the caption does not mention.
- Stay natural, like a fellow artist/enthusiast reacting to what the post describes. No spam, no marketing.`;

  const styleConfNote = conf === 'low'
    ? (hasVision
        ? `An image analysis is available (see IMAGE ANALYSIS) — you may reference its observed subject/craft, but never claim beyond it. ${NEUTRAL_RULE}`
        : `You cannot see the image. ${NEUTRAL_RULE} Read the caption to find what the tattoo is, and you may acknowledge that subject/style if the caption names it. Never claim visual technique you cannot verify.`)
    : conf === 'medium'
    ? `${NEUTRAL_RULE} (The style above is only a text guess from caption/alt — you may reference it if the caption states it, but never claim you observed the visual result.)`
    : `${NEUTRAL_RULE} (The style above is confirmed — from caption or image analysis — you may reference it and its craft; never claim you observed the visual result beyond the IMAGE ANALYSIS.)`;

  const deepNote = deepAngles.length
    ? `\nSTYLE-DEEP MODE (safe — the artist self-identified "${input.style}" in text): engage with ${input.style}-specific CRAFT KNOWLEDGE using the angles below. The goal is SPECIFICITY — name one insider detail the way a fellow artist would, so the poster feels truly seen and hits like/reply. These are craft facts ABOUT THE STYLE (process/tradition/technique), NOT claims about their specific image — never say you observed the visual result of their piece. Style craft details to draw from:\n${deepAngles.map((a) => '- ' + a).join('\n')}\nPrefer a comment that names ONE specific detail above, then you may add a low-pressure question about how they approach it.`
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
    detail_focused: deepAngles.length
      ? `Tone: name ONE specific, insider craft detail about ${input.style} drawn from the STYLE-DEEP angles (e.g. "${deepAngles[0]}"). State it like a fellow artist who knows the style — this specificity is what earns the like. You may add a light, low-pressure question. Never claim you observed the visual quality of their piece.`
      : 'Tone: reference a specific subject/theme the caption names (never visual technique), and you may add a light question. Do NOT claim visual quality.',
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
- ${hasVision ? 'You have an IMAGE ANALYSIS in Post context. You MAY reference its observed subject/craft/palette, but NEVER claim visual qualities beyond what it lists.' : 'You CANNOT see the image. Do NOT claim visual technique (shading/linework/composition/contrast/color) you did not observe.'}
- If a tattoo style is detected and confidence is high, you MAY reference it and engage with its craft (the artist named the style in text, OR a vision model observed it — both safe). Never claim you observed the visual result beyond the IMAGE ANALYSIS.
- You MAY name the tattoo's subject or style ONLY if the caption explicitly states it, or if the IMAGE ANALYSIS reports it; otherwise keep it general. Do NOT invent a subject the caption does not mention.
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

  // 风格 high（作者自标）时：把「细节化陈述」(detail_focused)权重拉到 30%，与提问(35%)一起成为主体——
  // 懂行的具体细节最引赞，风格相关问题最引回复；纯赞美压到 5%。
  // medium（仅 IG alt 图猜测）/low（无信号）时：退回提问为主力(45%)的通用策略，绝不假装懂风格。
  const conf = input.styleConfidence || 'low';
  const weights = (conf === 'high')
    ? [0.18, 0.12, 0.35, 0.05, 0.30]   // professional, casual, question, short_praise, detail_focused
    : [0.15, 0.25, 0.45, 0.10, 0.05];  // professional, casual, question, short_praise, detail_focused
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
    // 重试时降级上下文防重复，但高风格时继续走 detail_focused/question 保持细节化，不退回泛泛赞美
    const retryStyle = (attempt > 0 && style === 'short_praise') ? 'casual' : style;
    const prompt = buildPrompt(
      attempt > 0 ? { ...input, caption: '' } : input, // 重试时降级上下文
      retryStyle
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
