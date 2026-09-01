/**
 * 评论生成器 — 基于 DeepSeek API 生成自然真人评论
 * 不依赖 Gemini，内容贴近纹身社区真实交流风格
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildTattooArtistContext, detectPostType, getSpanishFallback, getIntentGuidance } from './tattoo-voice';

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
// ⚠️ 2026-08-14 修订：移除 'question' 风格。用户硬要求：不靠提问引互动，
// 而是靠「识图(vision)+识文字(caption)实时分析」产出针对当帖的具体观察陈述来引互动。
const COMMENT_STYLES = [
  'professional',    // 专业点评（克制，少占比）
  'casual',          // 随性反应
  'short_praise',    // 简短赞美
  'detail_focused',  // 关注细节（识图/识文字后落到具体观察）
  'slang',           // 真实口语/俚语（最不像 bot，新加）
];

type CommentInput = {
  caption?: string;
  imageAlt?: string;
  artistHandle?: string;
  style?: string;           // tattoo style detected
  styleConfidence?: string; // 'high' | 'medium' | 'low' — alt-text verified
  techniqueHints?: string[]; // 技法级细分（点刺/手雕/单针…），来自 caption/alt 文本（作者自标）
  visionTechniqueHints?: string[]; // 技法级细分，来自视觉模型观测描述（IMAGE ANALYSIS 看到的技法）
  visionDescription?: string; // 视觉模型对图的观测描述（TEXT，安全可引用）；为空=无图信号
  likeCount?: number;
  commentCount?: number;
  isReel?: boolean;
  postIntent?: string;       // canonical intent key from detectPostIntent
  postSummary?: string;      // one-line understanding of what the author is saying
  postTone?: string;         // respectful | casual | enthusiastic | technical | celebratory
  sensitive?: boolean;       // true => commemorative/grief => must be respectful, no slang/joke
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
const MAX_RECENT = 40;

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

const isTooSimilar = (text: string, threshold = 0.45): boolean => {
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
  techniqueHints: string[];   // 技法级细分（点刺/手雕/单针…），来自 caption/alt 文本（VISION 安全）
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
  // —— 扩细：常见自标子风格（让检测更精准，避免都归到宽泛 key）——
  { key: 'biomechanical', aliases: ['biomechanical','biomech','bio mechanical','bio-mech'], hashtags: ['biomech','biomechanical','biomechtattoo'] },
  { key: 'engraving', aliases: ['engraving style','engraving','etching','etch style','scratchboard'], hashtags: ['engravingtattoo','etchingtattoo','engraving'] },
  { key: 'sketch', aliases: ['sketch style','sketchy','scratchy line','pencil sketch','sketch tattoo'], hashtags: ['sketchtattoo','sketchstyle','sketchtattoos'] },
  { key: 'old english', aliases: ['old english','old english lettering','blackletter','gothic lettering'], hashtags: ['oldenglish','oldenglishlettering','blackletter','blacklettertattoo'] },
  { key: 'portrait realism', aliases: ['portrait realism','photo realistic portrait','realistic portrait','hyper realistic portrait'], hashtags: ['portraitrealism','realisticportrait','hyperrealisticportrait'] },
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

// ========== 技法级细分提示（2026-08-14 扩细·用户要求"风格识别扩细"）==========
// 这是「风格之下的技法层级」区分——作者常在 caption/hashtag 自标，属 TEXT 信号（VISION 安全）。
// 例：blackwork 下的「点刺 vs 实黑」、日式里的「手雕 tebori vs 机器」、fine line 的「single needle/bugpin」。
// 这些都是作者自己写出来的技法词，bot 引用它们 = 引用文字（不靠看图编），所以安全且精准。
const TECHNIQUE_HINTS: { key: string; re: RegExp }[] = [
  { key: 'handpoked',       re: /(hand.?pok|hand poke|stick.?n.?poke|stick and poke|machine.?free|by hand no machine|non.?machine|done by hand)/i },
  { key: 'tebori',         re: /(tebori|hand.?carv|hand.?poked (japanese|irezumi))/i },
  { key: 'dotwork',        re: /(dotwork|stippl|stipple|pointillism|dot.?shad|dotted|stipple.?shad)/i },
  { key: 'whip_shade',     re: /(whip.?shad|spit.?shad|whip shade|spit shade)/i },
  { key: 'grey_wash',      re: /(grey.?wash|gray.?wash|wash shade|wash shading|wash (gradient|transition)|dilution)/i },
  { key: 'single_needle',  re: /(single.?needle|bugpin|3.?rl|hairline|micro.?needle|one needle)/i },
  { key: 'bold_lines',     re: /(bold.?will.?hold|bold lines|bold outline|bold will hold|thick outline)/i },
  { key: 'color_packing',  re: /(color.?pack|packing color|solid color|packed color|color saturation)/i },
  { key: 'negative_space', re: /(negative.?space|skin break|bare skin|skin breaks)/i },
  { key: 'blackout',       re: /(blackout|black.?out|solid black|full black|100% black|all black)/i },
  { key: 'freehand_line',  re: /(freehand line|freehand outline|drawn direct|no stencil outline)/i },
  { key: 'fineline_botanical', re: /(fineline botanical|floral fineline|fine line flower|fine line floral|fineline floral)/i },
  { key: 'micro',          re: /(microrealism|miniature|thumb.?sized|tiny piece|micro realism)/i },
  { key: 'color_real',     re: /(color realism|colour realism|color realistic|colour realistic)/i },
  { key: 'ornamental_dot', re: /(ornamental dot|dotted ornament|geometric dot|sacred geometry dot)/i },
];

// ========== 视觉辅助技法识别（2026-08-14 补·用户要"视觉辅助"）==========
// 上面 TECHNIQUE_HINTS 匹配「作者 caption/alt 自标」的技法词（点刺/手雕…）。
// 但实际很多帖作者不写技法词、只有图——此时视觉模型(Qwen-VL)产出的观测 TEXT 里会描述
// 它看到的技法（"dotted shading"、"hand-poked look"、"stippled"、"single needle lines"、
// "bold solid outlines"、"solid black fill"、"negative space" 等）。
// 这层：从 visionDescription 文字描述里提取技法 key，补进评论生成器的 TECHNIQUE DETAIL，
// 让 LLM 强制认领「视觉实际看到的技法」→ 评论更针对当帖、更像真看懂了图。
// 诚实边界：这些词来自"别人替你看图后告诉你的文字"，所以 prompt 里允许当作观测细节引用，
// 不复用文字 hint 的"do NOT claim you observed it visually"约束。
const TECHNIQUE_HINTS_VISION: { key: string; re: RegExp }[] = [
  { key: 'handpoked',   re: /(hand.?pok|hand.?poked|done by hand|machine.?free|no machine|non.?machine)/i },
  { key: 'tebori',     re: /(tebori|hand.?carv|hand.?carved|hand.?pulled)/i },
  { key: 'dotwork',     re: /(dotwork|dotted|stippl|pointillism|dot.?shad|made of dots|dotted shading)/i },
  { key: 'whip_shade',  re: /(whip.?shad|spit.?shad|curved shade|whip.?like shade)/i },
  { key: 'grey_wash',   re: /(grey.?wash|gray.?wash|wash (tone|shade|gradient|transition)|diluted (ink|black|grey))/i },
  { key: 'single_needle', re: /(single.?needle|bugpin|hairline|thin needle|fine needle|whisper.?thin)/i },
  { key: 'bold_lines',  re: /(bold (line|outline)|thick (line|outline)|heavy outline|solid outline|unapologetic line)/i },
  { key: 'color_packing', re: /(color.?pack|packed color|solid color fill|saturated color|color fill)/i },
  { key: 'negative_space', re: /(negative.?space|bare skin|skin break|skin left|untattooed|left un.?ink)/i },
  { key: 'blackout',    re: /(blackout|solid black|full black|all black|black fill|edge.?to.?edge black)/i },
  { key: 'freehand_line', re: /(freehand|drawn freehand|no stencil|directly drawn|freehand outline)/i },
  { key: 'ornamental_dot', re: /(ornamental dot|dotted ornament|geometric dot|dotted pattern)/i },
  { key: 'micro',       re: /(microrealism|miniature|thumbnail|tiny detailed|needle control at scale)/i },
  { key: 'color_real',  re: /(color realism|colour realism|realistic color|color realistic)/i },
];

export const extractTechniqueHintsFromVision = (visionText?: string): string[] => {
  if (!visionText || !visionText.trim()) return [];
  const hay = visionText.toLowerCase();
  const hits: string[] = [];
  for (const { key, re } of TECHNIQUE_HINTS_VISION) {
    if (re.test(hay)) hits.push(key);
  }
  return hits;
};

// 每条技法细分的「内行评论角度」——让评论写得更针对，不靠预置提问（用户硬要求）。
export const TECHNIQUE_ANGLES: Record<string, string[]> = {
  handpoked: [
    'the hand-poke rhythm — every puncture deliberate, no machine cadence, you can feel the patience',
    'pulling this machine-free takes real nerve on the linework — respect',
    'the slightly irregular, hand-laid dots read as human, not mechanical',
  ],
  tebori: [
    'the tebori hand-carving — that irregular bite only a hand-pulled needle gives, machines can’t fake it',
    'hand-poked irezumi — the gradations have that soft, organic tebori fall-off',
  ],
  dotwork: [
    'the whole gradient is built from dot density alone — no line, just rhythm',
    'machine dotwork vs hand stipple, either way the spacing implies all the form',
    'how the dotwork shading melts into the solid black at the edges',
  ],
  whip_shade: [
    'that whip-shade pull on the fades — curved, not a hard scrub, proper trad',
    'the spit-shade softness near the edges reads so old-school',
  ],
  grey_wash: [
    'the grey-wash dilution control — soft transition without going muddy',
    'pushing that contrast with wash alone, no solid black needed',
  ],
  single_needle: [
    'the bugpin/single-needle discipline for that hairline — one wrong pass and it blows out',
    'holding a whisper-thin taper on a single needle takes insane steadiness',
  ],
  bold_lines: [
    'bold will hold — those outlines are built to age 20 years',
    'the outline weight is unapologetic, exactly how trad should sit',
  ],
  color_packing: [
    'the color packing — solid in one pass, no patchy gaps',
    'saturation control so the color stays punchy, never muddy',
  ],
  negative_space: [
    'the negative space does the work — bare skin reads as the highlight, not the black',
    'how the skin breaks carve the form instead of outlines',
  ],
  blackout: [
    'the full blackout saturation — zero holidays, edge-to-edge solid',
    'holding that much packed black crisp at the border, no fuzzy halo',
  ],
  freehand_line: [
    'drawn freehand, no stencil — the line confidence is wild',
  ],
  fineline_botanical: [
    'the fineline botanical detail — leaf veins at hairline weight, steady hand',
  ],
  micro: [
    'needle control at thumbnail scale — detail that stays readable once healed',
  ],
  color_real: [
    'color realism value range — keeping it punchy but not cartoonish',
  ],
  ornamental_dot: [
    'the ornamental dotwork rhythm — even spacing carrying the whole pattern',
  ],
};

const extractTechniqueHints = (captionNorm: string, altNorm: string): string[] => {
  const hay = `${captionNorm} ${altNorm}`;
  const hits: string[] = [];
  for (const { key, re } of TECHNIQUE_HINTS) {
    if (re.test(hay)) hits.push(key);
  }
  return hits;
};

export const detectTattooStyle = (caption?: string, alt?: string, providedHashtags?: string[]): StyleDetection => {  const cap = normAlias(caption || '');
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

  if (selfLabeled.length) return { primary: selfLabeled[0], all: selfLabeled, confidence: 'high', source: selfSource, techniqueHints: extractTechniqueHints(cap, altNorm) };
  if (altLabeled.length) return { primary: altLabeled[0], all: altLabeled, confidence: 'medium', source: 'alt', techniqueHints: extractTechniqueHints(cap, altNorm) };
  return { primary: '', all: [], confidence: 'low', source: 'none', techniqueHints: extractTechniqueHints(cap, altNorm) };
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

// ========== 兜底互动模板（仅 DeepSeek 连续失败/无 key 时触发，最后安全网）==========
// ⚠️ 2026-08-14 修订：主体生成路径「零预置」——实时靠 VISION(识图) + caption(识文字) 由 LLM 分析出
// 针对当帖的具体观察陈述，绝不靠写死的模板。这里只是 API 完全不可用时的最低保障：
// 返回「针对帖型的具体陈述(非提问)」，至少在帖型层面不离谱，绝不掉进泛泛 "fire"。
export const getInteractionFallback = (intent = 'generic', sensitive = false, caption = ''): string => {
  if (sensitive) {
    const s = [
      'what a beautiful way to honor them',
      'this is such a touching tribute',
      'keeping their memory close — beautiful',
      'a lovely tribute, the detail says it all',
    ];
    return s[Math.floor(Math.random() * s.length)];
  }
  // 尽量从 caption 里抓一个具体名词做观察锚点；抓不到就退回极简陈述
  const map: Record<string, string[]> = {
    flash_available: ['this sheet is so clean', 'these are fire, the layout on the sheet'],
    pet_portrait: ['what a gorgeous tribute — the likeness is unreal', 'this is such a beautiful tribute'],
    portrait: ['the eyes are alive on this', 'the tones on this portrait are dialed'],
    healed: ['healed so crisp, the lines held', 'aged beautifully, the color still pops'],
    wip: ['progress so far is clean', 'that linework already looking tight'],
    coverup: ['the old piece is gone, clean cover', 'smart weave of the old ink into the new'],
    booking: ['your work sells itself', 'this portfolio would make anyone book'],
    convention: ['your booth is always packed', 'would love to catch you at a guest spot'],
    bts: ['that setup is clean', 'dialed station'],
    script_quote: ['the flow on that script is perfect', 'that lettering connection is clean'],
    fan_art: ['this character is spot on', 'the cel-shaded look is clean'],
    botanical_nature: ['that leaf detail is so clean', 'the composition flows with the body'],
    generic: ['this is clean', 'the flow on this is something'],
  };
  const arr = map[intent] || map.generic;
  return arr[Math.floor(Math.random() * arr.length)];
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
  const captionText = String(input.caption || '').trim().slice(0, 700);
  const hasCaptionAnchor = captionText.replace(/https?:\/\/\S+|#[\w.]+|@[\w.]+/g, ' ').replace(/\s+/g, ' ').trim().length >= 12;
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
    captionText ? `AUTHOR CAPTION (primary source): "${captionText}"` : null,
    // ⚠️ imageAlt 是 IG 自动生成、可能不准；仅作弱提示，subject 以 caption 为准，绝不可仅凭 alt 判定题材
    input.imageAlt ? `Image auto-description (may be inaccurate — weak hint only, prefer the caption for subject): "${input.imageAlt.slice(0, 200)}"` : null,
    hasVision ? `IMAGE ANALYSIS (secondary, may be inaccurate; discard anything that conflicts with the caption): ${input.visionDescription!.slice(0, 400)}` : null,
    input.isReel ? '(Video/Reel)' : '(Static post)',
    `Stats: ${input.likeCount || '?'} likes, ${input.commentCount || '?'} comments`,
  ].filter(Boolean).join(' | ');

  // ===== 帖子「意图理解」：先读懂作者想说什么（基于 caption + 风格识别），再据此写具体评论（2026-08-14）=====
  // ⚠️ 用户硬要求：不要预置提问钩子、不要 question 风格。评论的具体性来自 LLM 实时消化
  //   IMAGE ANALYSIS(识图) + caption(识文字)，不靠写死的模板。
  const isGenericNoVision = !hasVision && (input.postIntent || 'generic') === 'generic';
  const intentBlock = input.postSummary
    ? `POST UNDERSTANDING (read this FIRST - your comment must be about THIS, not generic praise):\n${input.postSummary}\n${getIntentGuidance({ intent: input.postIntent || 'generic', summary: input.postSummary, tone: (input.postTone as any) || 'casual', sensitive: !!input.sensitive, keywords: [] })}${isGenericNoVision ? '\nSAFE MODE: no image analysis available and the caption is thin — you cannot tell the exact subject, so open with a genuine reaction based on whatever the caption or IMAGE ANALYSIS does tell you. Do NOT claim to understand the exact subject or technique.' : ''}`
    : '';

  const captionPriorityRule = `EVIDENCE ORDER (strict):
1. AUTHOR CAPTION is the primary source. First identify its main point: named subject, meaning/story, client milestone, stage (fresh/healed/WIP/cover-up), placement, style/technique, or announcement.
2. Your comment MUST anchor to one meaningful caption fact when the caption provides one. Do not replace it with a visual detail.
3. IMAGE ANALYSIS is secondary and may be wrong. Use at most one visual detail, only when it supports rather than conflicts with the caption. If they conflict, ignore IMAGE ANALYSIS.
4. Image auto-description is only a weak last resort.`;

  const NEUTRAL_RULE = hasVision
    ? `${captionPriorityRule}\nYou may reference one detail from IMAGE ANALYSIS only after grounding the comment in the caption. Never claim a visual quality beyond that analysis. Never invent.`
    : `${captionPriorityRule}\nYou CANNOT see the image — you only read text. Therefore:
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
    ? `\nSTYLE-DEEP MODE (safe — the artist self-identified "${input.style}" in text): engage with ${input.style}-specific CRAFT KNOWLEDGE using the angles below. The goal is SPECIFICITY — name one insider detail the way a fellow artist would, so the poster feels truly seen and hits like/reply. These are craft facts ABOUT THE STYLE (process/tradition/technique), NOT claims about their specific image — never say you observed the visual result of their piece. Style craft details to draw from:\n${deepAngles.map((a) => '- ' + a).join('\n')}\nPrefer a comment that names ONE specific detail above, as a statement of recognition (no question).`
    : '';

  // 技法级细分块（2026-08-14 扩细 + 视觉辅助补层）：
  //  - 文字 hint：作者 caption/alt 自标的具体技法（点刺/手雕/单针/实黑…），属 TEXT 信号，
  //    引用时当作"作者自己提到的技法"认可，绝不断言这是从图上看到的。
  //  - 视觉 hint：视觉模型观测描述里看到的技法（dotwork/hand-poked…），这些是"别人替你看图
  //    后告诉你的文字"，可在 prompt 里当作观测细节引用（不同于文字 hint 的"别谎称看图"约束）。
  const techHints = (input.techniqueHints || []).filter((k) => TECHNIQUE_ANGLES[k]);
  const visionTechHints = techHints.length
    ? []
    : (input.visionTechniqueHints || []).filter((k) => TECHNIQUE_ANGLES[k]);
  const techniqueBlock = (techHints.length || visionTechHints.length)
    ? `\nTECHNIQUE DETAIL — acknowledge ONE specific technique as a statement of recognition (no question), so the poster feels truly seen:\n${
        techHints.map((k) => `- ${k} (author's caption mentions it — do NOT claim you observed it visually): ${TECHNIQUE_ANGLES[k][0]}`).join('\n')
      }\n${
        visionTechHints.map((k) => `- ${k} (the IMAGE ANALYSIS observed this technique in the tattoo — you MAY reference it as something actually seen in the image): ${TECHNIQUE_ANGLES[k][0]}`).join('\n')
      }`
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

  // ⚠️ 无 question 风格：所有风格都是「针对当帖的具体观察陈述」(非提问)。具体性来自 LLM 实时消化
  //   IMAGE ANALYSIS(识图) + caption(识文字)，不靠预置钩子。互动靠"被看懂"引回复/关注。
  const STYLE_INSTRUCTIONS: Record<string, string> = {
    professional: 'Tone: a fellow tattoo artist giving brief, respectful pro feedback. Name ONE specific craft thing you noticed (from the caption or IMAGE ANALYSIS) as a statement. No question.',
    casual: 'Tone: a relaxed peer reacting. OPEN with a specific thing you noticed about their post (subject/craft/palette/composition), stated plainly. No question.',
    short_praise: 'Tone: a short genuine reaction (2-6 words) that names a SPECIFIC thing you saw. Punchy, statement only. No question.',
    detail_focused: deepAngles.length
      ? `Tone: name ONE specific, insider craft detail about ${input.style} drawn from the STYLE-DEEP angles (e.g. "${deepAngles[0]}"), as a statement of recognition like a fellow artist who knows the style. Never claim you observed the visual result of their piece. No question.`
      : 'Tone: reference a specific subject/theme the caption names (never visual technique), as a statement. Do NOT claim visual quality. No question.',
    slang: 'Tone: a REAL person hyping a peer on their phone — slang, lowercase, fragments OK — anchored in something specific you noticed, not just "fire". e.g. "ok the linework on this is clean af". Never sound like a brand. No question.',
  };
  const styleInstruction = STYLE_INSTRUCTIONS[style] || STYLE_INSTRUCTIONS.casual;

  return `${tattooContext}

Post context: ${postContext}

${intentBlock}

${langGuide}

${styleConfNote}${deepNote}${techniqueBlock}

${hasCaptionAnchor ? 'CAPTION ANCHOR REQUIRED: Base the comment on the author caption\'s most distinctive concrete point. The visual analysis may only add support.' : 'The caption is thin; use only high-confidence supplied evidence and stay conservative.'}

Style instruction: ${styleInstruction}

Rules — write like a REAL HUMAN reacting on their phone, NOT a brand, NOT a critic:
- NEVER sound like spam, bot, marketing, or a customer. BANNED phrases (instant fail): "great work as always", "this is really well done", "such a clean piece", "love this great work", "awesome tattoo", "really nice post". Those read as bot.
${input.sensitive ? '- SENSITIVE / RESPECTFUL POST: this is personal or commemorative (e.g. a pet or human memorial). You MUST be warm and respectful. FORBIDDEN: slang (slaps, af, tho, bruh, hits different), jokes, hype, fragments, emoji spam. A simple heartfelt line acknowledging the subject is perfect. Never be flippant or casual-cool. No questions.' : `- INTERACTION IS THE GOAL (this is how you earn the follow), but WITHOUT questions. PROVE you saw THIS post: OPEN with ONE specific observation drawn from the caption or IMAGE ANALYSIS. A genuine specific reaction earns more than praise. Reference the material above; never invent.`}
- NEVER mention buying, supplies, DM, bio, links, or promo.
- ${hasVision ? 'IMAGE ANALYSIS is secondary. Use it only when it agrees with the caption, and never let it replace a concrete caption point.' : 'You CANNOT see the image. Do NOT claim visual technique you did not observe.'}
- ${input.sensitive ? 'Keep it short and warm. 1-20 words is fine.' : 'VARY YOUR LENGTH WILDLY: sometimes one word ("fire", "clean", "sick"), sometimes a fragment ("ok but the linework tho"), sometimes a full sentence. Do NOT aim for a fixed length. 1-35 words is fine.'}
- ${input.sensitive ? '' : 'Use REAL casual register: slang (slaps, hits different, lowkey, ngl, af, tho, bruh, legit, mad), dropped punctuation, lowercase starts, run-on fragments, the occasional typo. Real comments are messy.'}
- VARY YOUR OPENING — do NOT start most comments with "Love", "Great", "This", "Such", or "Awesome". React or fragment instead.
- If a tattoo style is detected and confidence is high, you MAY reference its craft naturally (not as a lecture). Never claim you observed the visual result.
- You MAY name the subject/style ONLY if the caption states it or IMAGE ANALYSIS reports it. Do NOT invent a subject.
- Tattoo slang welcome (whip shade, packing, blowout, bold will hold) but don't force it.
- Emoji: 0-1, usually none. No hashtags, no @mentions, no quotation marks around your comment.

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
        { role: 'system', content: 'Write natural Instagram comments. Read the author caption first and anchor the comment to its most distinctive concrete point. Image analysis is secondary and may be inaccurate: ignore it whenever it conflicts with or distracts from the caption. Never invent. No questions. Respond only with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 1.0,  // max variety, avoid repetitive phrasing
      max_tokens: 140,
      top_p: 0.98,
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
    // 无 API key 时直接用「锚定本帖」的互动模板（针对帖型的具体陈述，非提问）
    const fbText = getInteractionFallback(input.postIntent, !!input.sensitive, input.caption);
    return { text: fbText, style: 'fallback' };
  }

  // ⚠️ 2026-08-14 修订：移除 question 风格。权重重偏「针对当帖的具体观察陈述」：
  //   detail_focused(识图/识文字后落到具体工艺观察) + casual(具体反应) + slang(锚定具体的口语)。
  //   用户硬要求：不靠提问引互动，靠"被看懂"的具体观察引回复/关注；纯赞美(short_praise)压到最低。
  const conf = input.styleConfidence || 'low';
  const hasVision = !!(input.visionDescription && input.visionDescription.trim());
  const sensitive = !!input.sensitive;
  // 敏感/纪念帖：绝不用俚语/玩梗/细节炫技，只走温暖尊重的口吻（且不提问）
  const weights = sensitive
    ? [0.40, 0.45, 0.15, 0.0, 0.0]   // professional, casual, short_praise, detail_focused, slang (后两者禁用于敏感帖)
    : (conf === 'high')
    ? [0.12, 0.13, 0.05, 0.40, 0.30]   // 风格 high：细节化具体观察 + 口语化具体反应 为主力
    : hasVision
      ? [0.15, 0.15, 0.05, 0.35, 0.30] // 有视觉观测：具体工艺/题材观察 + 口语化具体反应
      : [0.10, 0.25, 0.10, 0.15, 0.40]; // 无视觉：口语化为主(读文字反应)，细节化保守(不假装看懂图)
  const r = Math.random();
  let acc = 0;
  let styleIdx = 1; // default casual
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r <= acc) { styleIdx = i; break; }
  }
  let style = COMMENT_STYLES[styleIdx];
  if (sensitive && (style === 'slang' || style === 'detail_focused')) style = 'casual';

  // 最多重试3次生成不重复的评论
  for (let attempt = 0; attempt < 3; attempt++) {
    // 重试时降级上下文防重复，但高风格时继续走 detail_focused 保持细节化，不退回泛泛赞美
    const retryStyle = (attempt > 0 && style === 'short_praise') ? 'casual' : style;
    const prompt = buildPrompt(input, retryStyle);
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

  // 最终 fallback（仅 DeepSeek 连续失败 3 次时触发）：用「针对帖型的具体陈述」模板，而非泛泛 "fire"
  const fbText = getInteractionFallback(input.postIntent, sensitive, input.caption);
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
