/**
 * Public comment corpus — anonymous, fail-open learning旁路.
 *
 * Bot 在打开已确认纹身的帖子时，只读少量公开评论（不滚动、不互动），
 * 匿名化后落盘到 data/comment_corpus/corpus.jsonl；后续 DeepSeek 检索增强生成时
 * 按视觉标签匹配对应技术语料，但绝不复制原句，只参考语气/结构。
 *
 * 设计铁律（来自 handoff）：
 *  - 不保存用户名、个人主页 URL、DM；只保存匿名化评论文本、来源哈希、语言、标签。
 *  - 清洗掉：广告、预约、询价、引流、@提及、链接、纯表情、标签刷屏、重复文本。
 *  - 保存两组标签：图像确认标签 + 评论文字观察标签。
 *  - 任何异常 fail-open，绝不抛错阻塞主任务。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CORPUS_DIR = path.resolve(process.env.BOT_COMMENT_CORPUS_DIR || './data/comment_corpus');
const CORPUS_FILE = path.join(CORPUS_DIR, 'corpus.jsonl');
const MAX_PER_POST = Math.max(1, Number(process.env.BOT_COMMENT_CORPUS_MAX_PER_POST || 20));
const ENABLED = String(process.env.BOT_COMMENT_CORPUS_ENABLED || 'true').toLowerCase() !== 'false';

// 技术表达词典：既用于评论文字观察标签，也用于从视觉事实提取图像标签。
const TECH_LEXICON: Record<string, RegExp> = {
  fine_line: /\b(fine[ -]?line|delicate line|single needle)\b/i,
  black_and_grey: /\b(black ?and grey|black ?and gray|black & grey|blackwork)\b/i,
  full_color: /\b(colou?r work|full ?colou?r|chromatic)\b/i,
  shading: /\b(shading|shaded|gradient|blend(?:ed)?)\b/i,
  linework: /\b(line ?work|linework|clean lines|line weight)\b/i,
  dotwork: /\b(dotwork|stipple|stippling)\b/i,
  composition: /\b(composition|flow|placement|layout|negative space)\b/i,
  saturation: /\b(saturated|bold|solid|vibrant)\b/i,
  detail: /\b(detail|detailed|intricate|texture)\b/i,
  traditional: /\b(traditional|neo[ -]?traditional|old school|new school)\b/i,
  realism: /\b(realism|realistic|portrait tattoo)\b/i,
  floral: /\b(floral|flower|botanical|rose)\b/i, 
  geometric: /\b(geometric|sacred geometry|mandala)\b/i,
  blackwork: /\b(blackwork|heavy black|solid black)\b/i,
};

// 必须剔除的内容：广告/预约/询价/引流/@提及/链接/纯表情/刷屏。
const BLOCK_PATTERNS: RegExp[] = [
  /\bhttps?:\/\//i,
  /(^|\s)@[A-Za-z0-9_.]+\b/i,
  /\b(dm me|send me a dm|check (?:my|our) (?:bio|link)|buy|order|shop now|discount|promo|wholesale|supplier|supplies|appointment|booking|available slot|price|how much|cost|for sale)\b/i,
  /^[ \t]*[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]+[ \t]*$/u,
];

export const normalizeCorpusText = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9À-ÿ\s]/g, ' ').replace(/\s+/g, ' ').trim();

export const detectCommentTags = (text: string): string[] => {
  const tags: string[] = [];
  for (const [tag, re] of Object.entries(TECH_LEXICON)) {
    if (re.test(text)) tags.push(tag);
  }
  return tags;
};

const isBlocked = (text: string): boolean => BLOCK_PATTERNS.some((re) => re.test(text.trim()));

const detectLang = (text: string): string => {
  const set = new Set(text.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const sig: Record<string, string[]> = {
    es: ['que', 'para', 'con', 'como', 'más', 'muy', 'bien', 'hermoso', 'buen', 'está', 'tattoo'],
    it: ['che', 'per', 'come', 'molto', 'bello', 'lavoro', 'pezzo', 'tatuaggio', 'fatto'],
    pt: ['para', 'com', 'que', 'muito', 'bem', 'trabalho', 'ficou', 'lindo', 'tatuagem'],
    fr: ['pour', 'avec', 'très', 'bien', 'beau', 'tatouage', 'magnifique', 'trop'],
    de: ['und', 'ist', 'sehr', 'gut', 'arbeit', 'schön', 'tattoo', 'toll'],
  };
  for (const [lang, words] of Object.entries(sig)) {
    if (words.some((w) => set.has(w))) return lang;
  }
  return 'en';
};

// 进程内去重：避免一次运行时重复写盘；文件作为跨进程兜底。
let loadedHashes: Set<string> | null = null;
const loadHashes = (): Set<string> => {
  if (loadedHashes) return loadedHashes;
  const set = new Set<string>();
  try {
    if (fs.existsSync(CORPUS_FILE)) {
      for (const line of fs.readFileSync(CORPUS_FILE, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec?.hash) set.add(rec.hash);
        } catch {}
      }
    }
  } catch {}
  loadedHashes = set;
  return set;
};

export type CorpusEntry = {
  id: string;
  text: string;
  sourceHash: string;
  lang: string;
  imageTags: string[];
  commentTags: string[];
  quality: 'pending' | 'approved';
  createdAt: string;
};

/**
 * 这批公开评论入库。fail-open：任何异常只返回 reason，绝不抛错影响主任务。
 * @param input.comments 原始评论文本数组（来自 IG modal）
 * @param input.imageFacts 视觉事实/标签文本（vision.safeFacts + technical facts）
 * @param input.postUrl 来源帖（匿名化为哈希，不保存 URL 原文）
 * @param input.handle 仅用于匿名哈希，不入库
 */
export const addCorpusEntries = (input: {
  comments?: string[];
  imageFacts?: string[];
  postUrl?: string;
  handle?: string;
}): { added: number; skipped: number; reason?: string } => {
  if (!ENABLED) return { added: 0, skipped: 0, reason: 'disabled' };
  const hashes = loadHashes();
  let added = 0;
  let skipped = 0;
  try {
    if (!fs.existsSync(CORPUS_DIR)) fs.mkdirSync(CORPUS_DIR, { recursive: true });
    const sourceHash = createHash('sha1').update(`${input.postUrl || ''}|${input.handle || 'unknown'}`).digest('hex').slice(0, 16);
    const imageTags = Array.from(new Set((input.imageFacts || []).flatMap((fact) => detectCommentTags(fact))));
    const lines: string[] = [];
    const comments = (input.comments || []).slice(0, MAX_PER_POST);
    for (const raw of comments) {
      const text = (raw || '').replace(/\s+/g, ' ').trim();
      if (text.length < 4) { skipped++; continue; }
      if (isBlocked(text)) { skipped++; continue; }
      const h = createHash('sha256').update(normalizeCorpusText(text)).digest('hex');
      if (hashes.has(h)) { skipped++; continue; }
      hashes.add(h);
      const entry: CorpusEntry = {
        id: `${Date.now()}_${h.slice(0, 8)}`,
        text,
        sourceHash,
        lang: detectLang(text),
        imageTags,
        commentTags: detectCommentTags(text),
        quality: 'pending',
        createdAt: new Date().toISOString(),
      };
      lines.push(JSON.stringify(entry));
      added++;
    }
    if (lines.length) {
      const fd = fs.openSync(CORPUS_FILE, 'a');
      fs.writeSync(fd, lines.join('\n') + '\n');
      fs.closeSync(fd);
    }
    return { added, skipped };
  } catch (e: any) {
    return { added, skipped, reason: `error:${String(e?.message || e).slice(0, 80)}` };
  }
};

/**
 * 检索增强：按视觉标签匹配语料，返回风格参考文本（绝不原样复制）。
 * 仅在视觉标签明确匹配时返回对应技术语料；否则返回空，退回 general_praise。
 */
export const getCorpusContext = (imageTags: string[], limit = 4): string[] => {
  if (!ENABLED || !imageTags.length) return [];
  try {
    if (!fs.existsSync(CORPUS_FILE)) return [];
    const tags = new Set(imageTags);
    const matched: string[] = [];
    for (const line of fs.readFileSync(CORPUS_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.quality !== 'pending' && rec.quality !== 'approved') continue;
        const recTags = new Set([...(rec.imageTags || []), ...(rec.commentTags || [])]);
        if ([...tags].some((t) => recTags.has(t))) matched.push(rec.text);
        if (matched.length >= limit) break;
      } catch {}
    }
    return matched;
  } catch {
    return [];
  }
};

export const getCorpusStats = () => {
  try {
    if (!fs.existsSync(CORPUS_FILE)) return { total: 0, tagCount: {} };
    let total = 0;
    const tagCount: Record<string, number> = {};
    for (const line of fs.readFileSync(CORPUS_FILE, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        total++;
        for (const t of [...(rec.imageTags || []), ...(rec.commentTags || [])]) tagCount[t] = (tagCount[t] || 0) + 1;
      } catch {}
    }
    return { total, tagCount };
  } catch {
    return { total: 0, tagCount: {} };
  }
};
