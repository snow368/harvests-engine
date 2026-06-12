/**
 * Content Bot — 自动发帖系统（供应商人设）
 *
 * 5 种内容类型，按权重轮换（权重会根据发布后的真实反馈自动调整）：
 *
 *   Type 1 | static_post    | 图片+文案           | DeepSeek                  | 初始 35%
 *   Type 2 | slideshow_reel | 多图→幻灯片Reel      | Shotstack API             | 初始 18%
 *   Type 3 | ai_animation   | 单图→AI动画视频      | Replicate (Runway/Kling)  | 初始 8%
 *   Type 4 | video_remix    | 客用视频重制(去字幕) | Whisper + DeepSeek + FFmpeg | 初始 18%
 *   Type 5 | voiceover_reel | 图片+AI配音讲解      | ElevenLabs + FFmpeg       | 初始 8%
 *   Type 6 | artist_feature | 转发客户返图/视频    | DeepSeek + FFmpeg(可选)   | 初始 13%
 *
 * 对应 API key 不配则自动跳过该类型。
 * 反馈闭环：发布后跟踪表现 → 自动调整各类型权重 → 表现好的多发。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// ============ Config ============

const CONTENT_LIBRARY_DIR = (process.env.CONTENT_LIBRARY_DIR || './content-library').trim();
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');

// DeepSeek (Type 1,4,5)
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

// Shotstack (Type 2)
const SHOTSTACK_API_KEY = (process.env.SHOTSTACK_API_KEY || '').trim();
const SHOTSTACK_BASE = 'https://api.shotstack.io/v1';

// Replicate (Type 3 — Runway Gen-4 Turbo / Kling)
const REPLICATE_API_KEY = (process.env.REPLICATE_API_KEY || '').trim();
const REPLICATE_BASE = 'https://api.replicate.com/v1';

// Whisper (Type 4 — OpenAI or Groq)
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const WHISPER_PROVIDER = (process.env.WHISPER_PROVIDER || 'openai').trim(); // openai | groq

// ElevenLabs (Type 5)
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || '').trim();
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// Scheduling
const POSTS_PER_DAY_PER_BOT = Number(process.env.CONTENT_POSTS_PER_DAY || 1);
const MIN_INTERVAL_HOURS = Number(process.env.CONTENT_MIN_INTERVAL_HOURS || 18);
const CHECK_INTERVAL_MS = Math.max(60000, Number(process.env.CONTENT_CHECK_INTERVAL_MS || 300000));

// Output dir for generated videos
const OUTPUT_DIR = path.join(CONTENT_LIBRARY_DIR, '_generated');

const STATE_DIR = path.join(process.env.BOT_STATE_DIR || './data/bot_state', 'content_bot');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const USED_FILE = path.join(STATE_DIR, 'used_media.json');
const PERF_FILE = path.join(STATE_DIR, 'performance.json');

// Feedback config
const FEEDBACK_MATURITY_HOURS = Number(process.env.CONTENT_FEEDBACK_MATURITY_HOURS || 24); // min age before checking
const FEEDBACK_MIN_SAMPLES = Number(process.env.CONTENT_FEEDBACK_MIN_SAMPLES || 3);        // min posts before adjusting
const WEIGHT_FLOOR = 0.03;   // min weight for any type
const WEIGHT_CEILING = 0.60;  // max weight for any type
const SMOOTHING = 0.3;        // EMA smoothing factor (lower = slower adjustment)

// ============ Types ============

type ContentType = 'static_post' | 'slideshow_reel' | 'ai_animation' | 'video_remix' | 'voiceover_reel' | 'artist_feature';

interface ContentTypeConfig {
  folder: string;
  weight: number;
  format: string;        // image_carousel | reel
  needsApiKey: string;    // env var name to check
}

const TYPE_CONFIG: Record<ContentType, ContentTypeConfig> = {
  static_post:    { folder: 'products',        weight: 0.35, format: 'image_carousel', needsApiKey: 'DEEPSEEK_API_KEY' },
  slideshow_reel: { folder: 'slideshows',      weight: 0.18, format: 'reel',           needsApiKey: 'SHOTSTACK_API_KEY' },
  ai_animation:   { folder: 'animate',         weight: 0.08, format: 'reel',           needsApiKey: 'REPLICATE_API_KEY' },
  video_remix:    { folder: 'remix',           weight: 0.18, format: 'reel',           needsApiKey: 'DEEPSEEK_API_KEY' },
  voiceover_reel: { folder: 'voiceover',       weight: 0.08, format: 'reel',           needsApiKey: 'ELEVENLABS_API_KEY' },
  artist_feature: { folder: 'artist_features', weight: 0.13, format: 'image_carousel', needsApiKey: 'DEEPSEEK_API_KEY' },
};

interface ContentBotState {
  lastPostAt: Record<string, number>;
  libraryScannedAt: number;
}

interface UsedMedia {
  files: string[];
  maxKeep: number;
}

interface PostRecord {
  contentId: string;
  contentType: ContentType;
  botId: string;
  postedAt: number;
  checkedAt?: number;
  likes?: number;
  comments?: number;
  views?: number;
  engagementRate?: number; // computed
}

interface PerformanceData {
  posts: PostRecord[];
  maxPosts: number;          // keep last N posts
  // per-type rolling engagement averages
  typeAvgEngagement: Partial<Record<ContentType, number>>;
  typeSampleCount: Partial<Record<ContentType, number>>;
  // active weights (adjusted from defaults)
  activeWeights: Record<ContentType, number>;
  lastAdjustedAt: number;
}

const DEFAULT_WEIGHTS: Record<ContentType, number> = {
  static_post: 0.35,
  slideshow_reel: 0.18,
  ai_animation: 0.08,
  video_remix: 0.18,
  voiceover_reel: 0.08,
  artist_feature: 0.13,
};

interface PublishPayload {
  caption: string;
  hook: string;
  hashtags: string[];
  mediaFile: string;
  generatedVideo?: string;
  format: string;
  cta: string;
  contentType: string;
  generatedAt: string;
}

interface BrandProfile {
  brandName: string;
  primaryLine: string;
  valueProps: string[];
  tone: string;
}

// ============ Helpers ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const loadState = (): ContentBotState => {
  try { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { lastPostAt: {}, libraryScannedAt: 0 }; }
  catch { return { lastPostAt: {}, libraryScannedAt: 0 }; }
};
const saveState = (s: ContentBotState) => { ensureDir(STATE_DIR); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); };

const loadUsed = (): UsedMedia => {
  try { return fs.existsSync(USED_FILE) ? JSON.parse(fs.readFileSync(USED_FILE, 'utf8')) : { files: [], maxKeep: 500 }; }
  catch { return { files: [], maxKeep: 500 }; }
};
const saveUsed = (u: UsedMedia) => { ensureDir(STATE_DIR); fs.writeFileSync(USED_FILE, JSON.stringify(u, null, 2), 'utf8'); };

const loadPerf = (): PerformanceData => {
  try {
    if (!fs.existsSync(PERF_FILE)) return { posts: [], maxPosts: 200, typeAvgEngagement: {}, typeSampleCount: {}, activeWeights: { ...DEFAULT_WEIGHTS }, lastAdjustedAt: 0 };
    const raw = JSON.parse(fs.readFileSync(PERF_FILE, 'utf8'));
    return {
      posts: Array.isArray(raw.posts) ? raw.posts : [],
      maxPosts: raw.maxPosts || 200,
      typeAvgEngagement: raw.typeAvgEngagement || {},
      typeSampleCount: raw.typeSampleCount || {},
      activeWeights: raw.activeWeights || { ...DEFAULT_WEIGHTS },
      lastAdjustedAt: raw.lastAdjustedAt || 0,
    };
  } catch { return { posts: [], maxPosts: 200, typeAvgEngagement: {}, typeSampleCount: {}, activeWeights: { ...DEFAULT_WEIGHTS }, lastAdjustedAt: 0 }; }
};
const savePerf = (p: PerformanceData) => { ensureDir(STATE_DIR); fs.writeFileSync(PERF_FILE, JSON.stringify(p, null, 2), 'utf8'); };

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VID_EXTS = new Set(['.mp4', '.mov', '.webm']);
const ALL_EXTS = new Set([...IMG_EXTS, ...VID_EXTS]);

const execFileAsync = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });

const isApiKeySet = (envVar: string): boolean => {
  return (process.env[envVar] || '').trim().length > 0;
};

// ============ Media Library ============

const scanFolder = (folderName: string): string[] => {
  const dir = path.join(CONTENT_LIBRARY_DIR, folderName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => ALL_EXTS.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(folderName, f));
};

const scanLibrary = (): Record<string, string[]> => {
  const result: Record<string, string[]> = {};
  for (const [type, cfg] of Object.entries(TYPE_CONFIG)) {
    result[type] = scanFolder(cfg.folder);
  }
  // 'products' folder also feeds static_post if that type has no dedicated folder
  // Already handled — static_post maps to 'products'
  return result;
};

const pickMedia = (library: Record<string, string[]>, type: ContentType, usedSet: Set<string>): string | null => {
  const files = library[type] || [];
  const unused = files.filter((f) => !usedSet.has(f));
  if (unused.length === 0) return null;
  return unused[Math.floor(Math.random() * unused.length)];
};

// For slideshow: pick N images from a subfolder
const pickSlideshowSet = (usedSet: Set<string>): { images: string[]; setName: string } | null => {
  const dir = path.join(CONTENT_LIBRARY_DIR, 'slideshows');
  if (!fs.existsSync(dir)) return null;
  const subs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const unusedSubs = subs.filter((s) => !usedSet.has(`slideshows/${s}`));
  if (unusedSubs.length === 0) return null;
  const setName = unusedSubs[Math.floor(Math.random() * unusedSubs.length)];
  const setDir = path.join(dir, setName);
  const images = fs.readdirSync(setDir)
    .filter((f) => IMG_EXTS.has(path.extname(f).toLowerCase()))
    .slice(0, 8); // max 8 images per slideshow
  if (images.length < 2) return null;
  return { images: images.map((img) => path.join('slideshows', setName, img)), setName };
};

// ============ DeepSeek Caption (Type 1, 4, 5) ============

const callDeepSeek = async (systemPrompt: string, userPrompt: string, maxTokens = 150): Promise<string> => {
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.85, max_tokens: maxTokens, top_p: 0.95,
    }),
  });
  if (!resp.ok) throw new Error(`DeepSeek ${resp.status}`);
  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
};

const safeJsonParse = (text: string, fallback: any) => {
  try { return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()); }
  catch { return fallback; }
};

// ============ Brand Profile ============

const getBrandProfile = async (): Promise<BrandProfile> => {
  try {
    const resp = await fetch(`${API_BASE}/api/llm/brand-profile`);
    if (resp.ok) {
      const data = await resp.json();
      const p = data?.profile || {};
      return {
        brandName: p.brandName || 'Tattoo Supply',
        primaryLine: p.primaryLine || 'cartridge',
        valueProps: Array.isArray(p.valueProps) ? p.valueProps : ['precision', 'quality'],
        tone: p.tone || 'professional_friendly',
      };
    }
  } catch {}
  return { brandName: 'Tattoo Supply', primaryLine: 'cartridge', valueProps: ['precision', 'quality'], tone: 'professional_friendly' };
};

// ============ Bot Accounts ============

const getBotAccounts = async (): Promise<any[]> => {
  try {
    const resp = await fetch(`${API_BASE}/api/bots`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data?.bots) ? data.bots.filter((b: any) => b.enabled !== false) : [];
  } catch { return []; }
};

const pickNextBot = (bots: any[], state: ContentBotState): any | null => {
  if (bots.length === 0) return null;
  const now = Date.now();
  const minMs = MIN_INTERVAL_HOURS * 3600 * 1000;
  const eligible = bots
    .map((b) => ({ bot: b, lastPost: state.lastPostAt[b.botId] || 0 }))
    .filter((e) => now - e.lastPost >= minMs)
    .sort((a, b) => a.lastPost - b.lastPost);
  return eligible.length === 0 ? null : eligible[0].bot;
};

// ============ Publish Task ============

const createPublishTask = async (
  botId: string, accountId: string, type: ContentType,
  payload: PublishPayload,
): Promise<boolean> => {
  try {
    const scheduledAt = Date.now() + 5 * 60 * 1000;
    const resp = await fetch(`${API_BASE}/api/publish/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'instagram',
        botId, accountId,
        contentId: `cnt_${type}_${Date.now()}`,
        payload,
        scheduledAt,
      }),
    });
    const data = await resp.json();
    return data?.ok === true;
  } catch (e: any) {
    console.error(`[content-bot] Publish task failed: ${e.message}`);
    return false;
  }
};

// ============================================================
//  TYPE 1: Static Post — 图片 + 文案
// ============================================================

const genType1 = async (brand: BrandProfile, library: Record<string, string[]>, usedSet: Set<string>): Promise<{
  payload: PublishPayload; mediaKey: string;
} | null> => {
  if (!isApiKeySet('DEEPSEEK_API_KEY')) return null;

  const mediaFile = pickMedia(library, 'static_post', usedSet);
  if (!mediaFile) return null;

  const prompt = `Write a short Instagram caption for a tattoo supply brand.
Brand: ${brand.brandName} | Product: ${brand.primaryLine}
Value props: ${brand.valueProps.join(', ')}

Rules: You are a tattoo supplier. Sound like a real industry person, not a marketer.
NO hard selling. 1-3 short sentences. Max 1 emoji.

Return JSON: {"caption": "...", "hashtags": ["..."]}`;

  try {
    const raw = await callDeepSeek(
      'You create authentic Instagram captions for a tattoo supply brand. Respond ONLY with valid JSON.',
      prompt, 150
    );
    const parsed = safeJsonParse(raw, { caption: raw.trim().slice(0, 300), hashtags: [] });
    const caption = String(parsed.caption || '').trim().slice(0, 500);
    const hashtags: string[] = Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 10) : [];

    return {
      mediaKey: mediaFile,
      payload: {
        caption: hashtags.length ? `${caption}\n\n${hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}` : caption,
        hook: 'Fresh detail',
        hashtags,
        mediaFile,
        format: 'image_carousel',
        cta: 'soft',
        contentType: 'static_post',
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (e: any) {
    console.error(`[content-bot] Type1 failed: ${e.message}`);
    return null;
  }
};

// ============================================================
//  TYPE 2: Slideshow Reel — 多图→视频 (Shotstack)
// ============================================================

const genType2 = async (brand: BrandProfile, _library: Record<string, string[]>, usedSet: Set<string>): Promise<{
  payload: PublishPayload; mediaKey: string;
} | null> => {
  if (!isApiKeySet('SHOTSTACK_API_KEY')) return null;

  const set = pickSlideshowSet(usedSet);
  if (!set) return null;

  // Read images as base64 data URIs
  const clips: any[] = [];
  for (const imgPath of set.images) {
    const fullPath = path.join(CONTENT_LIBRARY_DIR, imgPath);
    try {
      const buf = fs.readFileSync(fullPath);
      const ext = path.extname(imgPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const dataUri = `data:${mime};base64,${buf.toString('base64')}`;
      clips.push({
        asset: { type: 'image', src: dataUri },
        start: 0, length: 3, // 3s per image
        transition: { in: 'fade', out: 'fade' },
      });
    } catch { continue; }
  }
  if (clips.length < 2) return null;

  const musicSrc = 'https://shotstack-assets.s3.ap-southeast-2.amazonaws.com/music/disco.mp3'; // default royalty-free
  const soundSrc: string | undefined = process.env.SHOTSTACK_MUSIC_URL?.trim() || undefined;

  const template = {
    timeline: {
      soundtrack: { src: soundSrc || musicSrc, effect: 'fadeOut' },
      tracks: [{ clips }],
    },
    output: { format: 'mp4', resolution: '1080p' },
  };

  try {
    // Submit render
    const renderResp = await fetch(`${SHOTSTACK_BASE}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': SHOTSTACK_API_KEY },
      body: JSON.stringify(template),
    });
    if (!renderResp.ok) throw new Error(`Shotstack ${renderResp.status}`);
    const renderData: any = await renderResp.json();
    const renderId = renderData?.data?.id;
    if (!renderId) throw new Error('No render ID');

    // Poll for completion (max 2 min)
    let videoUrl = '';
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const pollResp = await fetch(`${SHOTSTACK_BASE}/render/${renderId}`, {
        headers: { 'x-api-key': SHOTSTACK_API_KEY },
      });
      const pollData: any = await pollResp.json();
      if (pollData?.data?.attributes?.status === 'done') {
        videoUrl = pollData.data.attributes.url || '';
        break;
      }
      if (pollData?.data?.attributes?.status === 'failed') break;
    }
    if (!videoUrl) throw new Error('Render timeout or failed');

    // Download to local
    ensureDir(OUTPUT_DIR);
    const outName = `slideshow_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, outName);
    const videoResp = await fetch(videoUrl);
    const videoBuf = Buffer.from(await videoResp.arrayBuffer());
    fs.writeFileSync(outPath, videoBuf);

    // Caption via DeepSeek if available
    let caption = brand.primaryLine
      ? `Quick look at our ${brand.primaryLine} lineup. Detail matters.`
      : 'Detail matters. Every piece, every time.';
    let hashtags: string[] = [];
    if (isApiKeySet('DEEPSEEK_API_KEY')) {
      try {
        const raw = await callDeepSeek(
          'You write authentic IG captions for a tattoo supply brand. Return JSON only.',
          `Write a short caption for a slideshow video showing ${brand.brandName} ${brand.primaryLine} products. 1-2 sentences. Return JSON: {"caption":"...","hashtags":["..."]}`,
          100
        );
        const p = safeJsonParse(raw, { caption, hashtags: [] });
        caption = String(p.caption || caption).trim();
        hashtags = Array.isArray(p.hashtags) ? p.hashtags : [];
      } catch {}
    }

    return {
      mediaKey: `slideshows/${set.setName}`,
      payload: {
        caption,
        hook: 'Product lineup',
        hashtags,
        mediaFile: set.images[0],
        generatedVideo: outPath,
        format: 'reel',
        cta: 'soft',
        contentType: 'slideshow_reel',
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (e: any) {
    console.error(`[content-bot] Type2 failed: ${e.message}`);
    return null;
  }
};

// ============================================================
//  TYPE 3: AI Animation — 单图→AI动画 (Replicate)
// ============================================================

const genType3 = async (brand: BrandProfile, library: Record<string, string[]>, usedSet: Set<string>): Promise<{
  payload: PublishPayload; mediaKey: string;
} | null> => {
  if (!isApiKeySet('REPLICATE_API_KEY')) return null;

  const mediaFile = pickMedia(library, 'ai_animation', usedSet);
  if (!mediaFile) return null;

  // Read image as base64 or use file path
  const fullPath = path.join(CONTENT_LIBRARY_DIR, mediaFile);
  const buf = fs.readFileSync(fullPath);
  const dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;

  const modelVersion = process.env.REPLICATE_IMG2VID_MODEL || 'runwayml/runway-gen-4-turbo';
  // Alternate: 'kwaivgi/kling-v2.5-turbo-pro'

  try {
    // Submit prediction
    const predResp = await fetch(`${REPLICATE_BASE}/predictions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${REPLICATE_API_KEY}` },
      body: JSON.stringify({
        version: modelVersion,
        input: { image: dataUri, duration: 5, prompt: `${brand.primaryLine} tattoo supply product showcase, cinematic lighting, professional` },
      }),
    });
    if (!predResp.ok) throw new Error(`Replicate ${predResp.status}`);
    const predData: any = await predResp.json();
    const predId = predData?.id;
    if (!predId) throw new Error('No prediction ID');

    // Poll (Replicate image-to-video takes 30-90s typically)
    let videoUrl = '';
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      const pollResp = await fetch(`${REPLICATE_BASE}/predictions/${predId}`, {
        headers: { Authorization: `Bearer ${REPLICATE_API_KEY}` },
      });
      const pollData: any = await pollResp.json();
      if (pollData?.status === 'succeeded') {
        videoUrl = pollData.output || '';
        if (Array.isArray(videoUrl)) videoUrl = videoUrl[0] || '';
        break;
      }
      if (pollData?.status === 'failed' || pollData?.status === 'canceled') break;
    }
    if (!videoUrl) throw new Error('Animation timeout or failed');

    // Download result
    ensureDir(OUTPUT_DIR);
    const outName = `animate_${Date.now()}.mp4`;
    const outPath = path.join(OUTPUT_DIR, outName);
    const videoResp = await fetch(videoUrl);
    fs.writeFileSync(outPath, Buffer.from(await videoResp.arrayBuffer()));

    const caption = `Some things are hard to capture in a photo. ${brand.primaryLine} in motion.`;

    return {
      mediaKey: mediaFile,
      payload: {
        caption,
        hook: 'See it in motion',
        hashtags: [],
        mediaFile,
        generatedVideo: outPath,
        format: 'reel',
        cta: 'soft',
        contentType: 'ai_animation',
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (e: any) {
    console.error(`[content-bot] Type3 failed: ${e.message}`);
    return null;
  }
};

// ============================================================
//  TYPE 4: Video Remix — 客用视频重制（转写+翻译+烧字幕）
// ============================================================

const genType4 = async (brand: BrandProfile, library: Record<string, string[]>, usedSet: Set<string>): Promise<{
  payload: PublishPayload; mediaKey: string;
} | null> => {
  if (!isApiKeySet('DEEPSEEK_API_KEY')) return null;

  const mediaFile = pickMedia(library, 'video_remix', usedSet);
  if (!mediaFile) return null;

  const fullPath = path.join(CONTENT_LIBRARY_DIR, mediaFile);

  try {
    ensureDir(OUTPUT_DIR);
    const baseName = `remix_${Date.now()}`;

    // Step 1: Extract audio
    const audioPath = path.join(OUTPUT_DIR, `${baseName}.mp3`);
    await execFileAsync('ffmpeg', ['-y', '-i', fullPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', audioPath]);

    // Step 2: Transcribe via Whisper API
    let transcript = '';
    if (WHISPER_PROVIDER === 'groq') {
      const groqKey = process.env.GROQ_API_KEY || '';
      if (!groqKey) throw new Error('GROQ_API_KEY not set for Whisper');
      const audioBuf = fs.readFileSync(audioPath);
      // Groq requires multipart form upload
      // ... simplified for now - use OpenAI path
    }

    // OpenAI Whisper
    if (!transcript && isApiKeySet('OPENAI_API_KEY')) {
      const formData = new FormData();
      formData.append('file', new Blob([fs.readFileSync(audioPath)]), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'text');
      const wResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: formData,
      });
      if (wResp.ok) transcript = (await wResp.text()).trim();
    }

    // If no transcript available, skip subtitle burn but still use the video
    let finalVideoPath = fullPath;
    let caption = 'Results speak for themselves.';

    if (transcript) {
      // Step 3: Translate + rewrite via DeepSeek
      const raw = await callDeepSeek(
        'You are a translator for a tattoo supply brand. Return JSON only.',
        `Translate this transcript to English, then rewrite it as a short, natural Instagram caption (supplier persona, not marketing).\n\nOriginal transcript: "${transcript.slice(0, 500)}"\n\nReturn JSON: {"english_subtitle": "the translated subtitle text", "caption": "short IG caption", "hashtags": ["tag1"]}`,
        200
      );
      const parsed = safeJsonParse(raw, { english_subtitle: transcript, caption, hashtags: [] });
      caption = String(parsed.caption || caption).trim();
      const engSub = String(parsed.english_subtitle || transcript).trim();
      const hashtags: string[] = Array.isArray(parsed.hashtags) ? parsed.hashtags : [];

      // Step 4: Burn English subtitles
      if (engSub) {
        const srtPath = path.join(OUTPUT_DIR, `${baseName}.srt`);
        // Simple SRT: one block, 2s-8s
        const srtContent = `1\n00:00:02,000 --> 00:00:08,000\n${engSub}\n`;
        fs.writeFileSync(srtPath, srtContent, 'utf8');

        const subOutPath = path.join(OUTPUT_DIR, `${baseName}_sub.mp4`);
        await execFileAsync('ffmpeg', [
          '-y', '-i', fullPath, '-vf',
          `subtitles=${srtPath.replace(/\\/g, '/')}:force_style='FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2'`,
          '-c:a', 'copy', subOutPath,
        ]);
        finalVideoPath = subOutPath;
      }
    }

    return {
      mediaKey: mediaFile,
      payload: {
        caption,
        hook: 'Artist spotlight',
        hashtags: [],
        mediaFile,
        generatedVideo: finalVideoPath !== fullPath ? finalVideoPath : undefined,
        format: 'reel',
        cta: 'soft',
        contentType: 'video_remix',
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (e: any) {
    console.error(`[content-bot] Type4 failed: ${e.message}`);
    return null;
  }
};

// ============================================================
//  TYPE 5: Voiceover Reel — 图片 + AI配音 (ElevenLabs + FFmpeg)
// ============================================================

const genType5 = async (brand: BrandProfile, library: Record<string, string[]>, usedSet: Set<string>): Promise<{
  payload: PublishPayload; mediaKey: string;
} | null> => {
  if (!isApiKeySet('ELEVENLABS_API_KEY') || !isApiKeySet('DEEPSEEK_API_KEY')) return null;

  const mediaFile = pickMedia(library, 'voiceover_reel', usedSet);
  if (!mediaFile) return null;

  const fullPath = path.join(CONTENT_LIBRARY_DIR, mediaFile);

  try {
    // Step 1: Generate voiceover script via DeepSeek
    const raw = await callDeepSeek(
      'You write short voiceover scripts for tattoo supply product videos. Return JSON only.',
      `Write a 15-20 second voiceover script for a ${brand.brandName} ${brand.primaryLine} product image. Tone: ${brand.tone}. Keep it concise and natural — not a commercial.\n\nReturn JSON: {"script": "the voiceover text", "caption": "short IG caption", "hashtags": ["tag1"]}`,
      150
    );
    const parsed = safeJsonParse(raw, {
      script: `${brand.brandName} ${brand.primaryLine} — built for artists who care about every detail.`,
      caption: 'Precision you can feel.',
      hashtags: [] as string[],
    });
    const script: string = String(parsed.script || '').trim();
    const caption: string = String(parsed.caption || '').trim() || script;
    const hashtags: string[] = Array.isArray(parsed.hashtags) ? parsed.hashtags : [];

    // Step 2: TTS via ElevenLabs
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // default "Rachel"
    const ttsResp = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: script,
        model_id: 'eleven_flash_2_5', // fast + cheap
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!ttsResp.ok) throw new Error(`ElevenLabs ${ttsResp.status}`);

    const audioBuf = Buffer.from(await ttsResp.arrayBuffer());
    ensureDir(OUTPUT_DIR);
    const baseName = `voiceover_${Date.now()}`;
    const audioPath = path.join(OUTPUT_DIR, `${baseName}.mp3`);
    fs.writeFileSync(audioPath, audioBuf);

    // Step 3: Combine image + audio into video via FFmpeg
    const videoPath = path.join(OUTPUT_DIR, `${baseName}.mp4`);
    await execFileAsync('ffmpeg', [
      '-y', '-loop', '1', '-i', fullPath, '-i', audioPath,
      '-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac',
      '-b:a', '128k', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2',
      '-shortest', videoPath,
    ]);

    return {
      mediaKey: mediaFile,
      payload: {
        caption,
        hook: script.slice(0, 80),
        hashtags,
        mediaFile,
        generatedVideo: videoPath,
        format: 'reel',
        cta: 'soft',
        contentType: 'voiceover_reel',
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (e: any) {
    console.error(`[content-bot] Type5 failed: ${e.message}`);
    return null;
  }
};

// ============================================================
//  TYPE 6: Artist Feature — 转发客户返图/视频
// ============================================================

const genType6 = async (brand: BrandProfile, library: Record<string, string[]>, usedSet: Set<string>): Promise<{
  payload: PublishPayload; mediaKey: string;
} | null> => {
  if (!isApiKeySet('DEEPSEEK_API_KEY')) return null;

  const mediaFile = pickMedia(library, 'artist_feature', usedSet);
  if (!mediaFile) return null;

  const fullPath = path.join(CONTENT_LIBRARY_DIR, mediaFile);
  const ext = path.extname(mediaFile).toLowerCase();
  const isVideo = VID_EXTS.has(ext);

  try {
    let finalMediaPath = fullPath;
    let finalMediaFile = mediaFile;

    // For videos: optionally remove subtitles from original, add watermark
    if (isVideo) {
      ensureDir(OUTPUT_DIR);
      const baseName = `artist_${Date.now()}`;
      const watermarkPath = path.join(CONTENT_LIBRARY_DIR, 'brand_watermark.png');
      const hasWatermark = fs.existsSync(watermarkPath);

      if (hasWatermark) {
        // Overlay watermark in bottom-right corner
        const outPath = path.join(OUTPUT_DIR, `${baseName}_wm.mp4`);
        await execFileAsync('ffmpeg', [
          '-y', '-i', fullPath, '-i', watermarkPath,
          '-filter_complex',
          '[1:v]scale=120:-1[wm];[0:v][wm]overlay=W-w-20:H-h-20:format=auto',
          '-c:a', 'copy', outPath,
        ]);
        finalMediaPath = outPath;
        finalMediaFile = path.join('_generated', `${baseName}_wm.mp4`);
      } else {
        // Just copy to output dir for consistency
        finalMediaPath = fullPath;
      }
    }

    // Build context hints for DeepSeek
    const mediaTypeHint = isVideo ? 'video' : 'photo';

    const prompt = `Write a short Instagram caption for a tattoo supply brand sharing a ${mediaTypeHint} from one of their artist clients.

Brand: ${brand.brandName} | Product: ${brand.primaryLine}
Value props: ${brand.valueProps.join(', ')}

Context: An artist using our products sent us this ${mediaTypeHint} of their work. We're reposting it as social proof.

Rules:
- Sound like a real tattoo supplier, not a marketer
- Express genuine appreciation for the artist's work
- Subtly connect to product quality without hard selling
- NO "DM for price", NO "buy now", NO direct promotion
- 2-4 sentences, natural and warm
- Max 1 emoji
- Write in English

Return JSON: {"caption": "...", "hashtags": ["..."]}`;

    const raw = await callDeepSeek(
      'You write authentic Instagram captions for a tattoo supply brand sharing client work. Respond ONLY with valid JSON.',
      prompt, 180
    );
    const parsed = safeJsonParse(raw, {
      caption: `Love seeing what artists create with ${brand.primaryLine}. Real work, real results.`,
      hashtags: [] as string[],
    });
    const caption = String(parsed.caption || '').trim().slice(0, 500);
    const hashtags: string[] = Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 10) : [];

    return {
      mediaKey: mediaFile,
      payload: {
        caption: hashtags.length ? `${caption}\n\n${hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}` : caption,
        hook: 'Artist spotlight',
        hashtags,
        mediaFile: isVideo ? finalMediaFile : mediaFile,
        generatedVideo: isVideo ? finalMediaPath : undefined,
        format: isVideo ? 'reel' : 'image_carousel',
        cta: 'soft',
        contentType: 'artist_feature',
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (e: any) {
    console.error(`[content-bot] Type6 failed: ${e.message}`);
    return null;
  }
};

// ============================================================
//  Type Handlers Map
// ============================================================

type GeneratorFn = (brand: BrandProfile, library: Record<string, string[]>, usedSet: Set<string>) => Promise<{
  payload: PublishPayload; mediaKey: string;
} | null>;

const GENERATORS: Record<ContentType, GeneratorFn> = {
  static_post: genType1,
  slideshow_reel: genType2,
  ai_animation: genType3,
  video_remix: genType4,
  voiceover_reel: genType5,
  artist_feature: genType6,
};

// ============================================================
//  Scheduler
// ============================================================

const PEAK_HOURS = [
  { start: 9, end: 11 },
  { start: 14, end: 16 },
  { start: 20, end: 23 },
];

const isPeakHour = (): boolean => {
  const hour = new Date().getHours();
  return PEAK_HOURS.some((w) => hour >= w.start && hour <= w.end);
};

// Which types are enabled (API key configured)
const getEnabledTypes = (): ContentType[] => {
  return (Object.keys(TYPE_CONFIG) as ContentType[]).filter((t) => {
    const needsKey = TYPE_CONFIG[t].needsApiKey;
    // video_remix needs either OpenAI or Groq for Whisper, plus DeepSeek
    if (t === 'video_remix') return isApiKeySet('DEEPSEEK_API_KEY') && (isApiKeySet('OPENAI_API_KEY') || isApiKeySet('GROQ_API_KEY'));
    return !needsKey || isApiKeySet(needsKey);
  });
};

const pickType = (enabledTypes: ContentType[], perf: PerformanceData): ContentType => {
  // Blend our own learned weights with competitor insights
  const weights = blendWeights(perf);
  const totalWeight = enabledTypes.reduce((sum, t) => sum + (weights[t] || TYPE_CONFIG[t].weight), 0);
  const r = Math.random() * totalWeight;
  let acc = 0;
  for (const t of enabledTypes) {
    acc += weights[t] || TYPE_CONFIG[t].weight;
    if (r <= acc) return t;
  }
  return enabledTypes[0];
};

// ============ Feedback & Weight Adjustment ============

const computeEngagementRate = (likes: number, comments: number, views?: number): number => {
  // Simplified IG engagement rate: (likes + comments * 2) normalized to 0-1
  // Comments are weighted 2x because they signal deeper interest
  const base = likes + comments * 2;
  // Cap at reasonable max for tattoo supply niche (most posts get <200 likes)
  return Math.min(1, base / 200);
};

const reportFeedback = (
  perf: PerformanceData,
  contentId: string,
  likes: number,
  comments: number,
  views?: number,
): boolean => {
  const post = perf.posts.find((p) => p.contentId === contentId);
  if (!post) {
    console.warn(`[content-bot] Feedback for unknown post: ${contentId}`);
    return false;
  }
  post.checkedAt = Date.now();
  post.likes = likes;
  post.comments = comments;
  post.views = views;
  post.engagementRate = computeEngagementRate(likes, comments, views);

  // Update per-type rolling averages
  const t = post.contentType;
  const prevAvg = perf.typeAvgEngagement[t] || 0;
  const prevCount = perf.typeSampleCount[t] || 0;
  const newCount = prevCount + 1;
  // Exponential moving average
  const newAvg = prevCount === 0 ? post.engagementRate : prevAvg + SMOOTHING * (post.engagementRate - prevAvg);
  perf.typeAvgEngagement[t] = newAvg;
  perf.typeSampleCount[t] = newCount;

  adjustWeights(perf);
  savePerf(perf);
  console.log(`[content-bot] Feedback: ${contentId} (${t}) → ${likes}L ${comments}C | score=${post.engagementRate.toFixed(3)} | newWeight=${(perf.activeWeights[t] * 100).toFixed(0)}%`);
  return true;
};

const adjustWeights = (perf: PerformanceData) => {
  const samples = perf.typeSampleCount;
  const avgs = perf.typeAvgEngagement;

  // Only adjust types with enough samples
  const typesWithData = (Object.keys(DEFAULT_WEIGHTS) as ContentType[])
    .filter((t) => (samples[t] || 0) >= FEEDBACK_MIN_SAMPLES && typeof avgs[t] === 'number');

  if (typesWithData.length < 2) return; // Need at least 2 types with data to redistribute

  // Compute average engagement among types with data
  const avgEngagement = typesWithData.reduce((sum, t) => sum + (avgs[t] || 0), 0) / typesWithData.length;

  // Adjust each type's weight based on relative performance
  const newWeights: Record<string, number> = {};
  for (const t of (Object.keys(DEFAULT_WEIGHTS) as ContentType[])) {
    if (typesWithData.includes(t)) {
      // Ratio of this type's avg to overall avg
      const ratio = (avgs[t] || 0) / (avgEngagement || 0.01);
      // Scale the default weight by performance ratio
      let adjusted = DEFAULT_WEIGHTS[t] * Math.max(0.3, Math.min(3.0, ratio));
      // Apply floor/ceiling
      adjusted = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, adjusted));
      newWeights[t] = adjusted;
    } else {
      // Keep default for types without enough data
      newWeights[t] = DEFAULT_WEIGHTS[t];
    }
  }

  // Normalize to sum to 1.0
  const total = Object.values(newWeights).reduce((a, b) => a + b, 0);
  for (const t of Object.keys(newWeights)) {
    perf.activeWeights[t as ContentType] = newWeights[t] / total;
  }
  perf.lastAdjustedAt = Date.now();
};

const autoCollectFeedback = async (perf: PerformanceData): Promise<number> => {
  // Check posts that have matured but haven't been checked yet
  const now = Date.now();
  const maturityMs = FEEDBACK_MATURITY_HOURS * 3600 * 1000;
  const unchecked = perf.posts.filter(
    (p) => !p.checkedAt && (now - p.postedAt) >= maturityMs
  );

  if (unchecked.length === 0) return 0;

  // Try to fetch engagement from server (bot-worker observations)
  let collected = 0;
  for (const post of unchecked.slice(0, 5)) { // max 5 per cycle
    try {
      const resp = await fetch(`${API_BASE}/api/content/engagement/${encodeURIComponent(post.contentId)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data?.likes !== undefined || data?.comments !== undefined) {
        const ok = reportFeedback(perf, post.contentId, data.likes || 0, data.comments || 0, data.views);
        if (ok) collected++;
      }
    } catch { /* server might not have the endpoint yet */ }
  }

  // For posts older than 72h with no data, assign a neutral score so they don't linger
  for (const post of unchecked) {
    if (post.checkedAt) continue;
    if (now - post.postedAt > 72 * 3600 * 1000) {
      reportFeedback(perf, post.contentId, 0, 0);
    }
  }

  return collected;
};

// ============ Competitor Insights Integration ============

const COMPETITOR_INSIGHTS_FILE = path.join(
  process.env.BOT_STATE_DIR || './data/bot_state',
  'competitor_content',
  'insights.json'
);

const COMPETITOR_INSIGHTS_TTL = 12 * 3600 * 1000; // 12h
const COMPETITOR_WEIGHT_BLEND = 0.3; // blend 30% competitor insight into our own weights

interface CompetitorInsights {
  generatedAt: string;
  profilesAnalyzed: number;
  totalPostsAnalyzed: number;
  summary: string;
  marketTrend: string;
  gapsAndOpportunities: string[];
  topVideos: any[];
  videoPatterns: any;
  topicPerformance: any[];
  contentMix: { contentType: string; recommendedWeight: number; reason: string; sampleHashtags: string[] }[];
  topHashtags: { tag: string; avgEng: number; count: number }[];
  hashtagCombos: { combo: string[]; avgEng: number }[];
  weeklySchedule: any[];
  forContentBot: {
    adjustedWeights: Record<string, number>;
    recommendedHashtags: string[];
    captionTemplates: { style: string; template: string; context: string }[];
    avoidPatterns: string[];
    priorityContentTypes: string[];
    bestPostingWindows: { day: string; hour: number }[];
  };
}

let cachedInsights: CompetitorInsights | null = null;
let insightsLoadedAt = 0;

const loadCompetitorInsights = (): CompetitorInsights | null => {
  const now = Date.now();
  if (cachedInsights && now - insightsLoadedAt < COMPETITOR_INSIGHTS_TTL) return cachedInsights;

  try {
    if (!fs.existsSync(COMPETITOR_INSIGHTS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(COMPETITOR_INSIGHTS_FILE, 'utf8'));
    const age = now - new Date(raw.generatedAt || '').getTime();
    if (age > 7 * 24 * 3600 * 1000) {
      console.warn('[content-bot] Competitor insights are >7 days old — re-run competitor-content-analyzer');
    }
    cachedInsights = raw;
    insightsLoadedAt = now;
    return raw;
  } catch { return null; }
};

/**
 * Blend competitor-recommended weights with our own learned weights.
 * Our own data gets 70% weight, competitor insights get 30%.
 */
const blendWeights = (perf: PerformanceData): Record<ContentType, number> => {
  const insights = loadCompetitorInsights();
  const ownWeights = perf.activeWeights || DEFAULT_WEIGHTS;

  if (!insights || !insights.forContentBot?.adjustedWeights) return ownWeights;

  const competitorWeights = insights.forContentBot.adjustedWeights;
  const blended: Record<string, number> = {};

  for (const t of Object.keys(TYPE_CONFIG) as ContentType[]) {
    const own = ownWeights[t] || DEFAULT_WEIGHTS[t];
    const comp = (competitorWeights[t] || competitorWeights[t.replace('_', '-')]) ?? own;
    blended[t] = own * (1 - COMPETITOR_WEIGHT_BLEND) + comp * COMPETITOR_WEIGHT_BLEND;
  }

  // Normalize
  const total = Object.values(blended).reduce((a, b) => a + b, 0);
  for (const t of Object.keys(blended)) {
    blended[t] = blended[t] / total;
  }

  return blended as Record<ContentType, number>;
};

/**
 * Get competitor-recommended hashtags to supplement generated ones.
 */
const getCompetitorRecommendedHashtags = (): string[] => {
  const insights = loadCompetitorInsights();
  if (!insights?.forContentBot?.recommendedHashtags) return [];
  return insights.forContentBot.recommendedHashtags.slice(0, 5);
};

const schedulePost = async (state: ContentBotState, used: UsedMedia, perf: PerformanceData): Promise<boolean> => {
  const bots = await getBotAccounts();
  if (bots.length === 0) { return false; }

  const bot = pickNextBot(bots, state);
  if (!bot) { return false; }

  // Scan library
  const library = scanLibrary();

  // Pick type using performance-adjusted weights
  const enabledTypes = getEnabledTypes();
  if (enabledTypes.length === 0) {
    console.error('[content-bot] No content types enabled — check API keys');
    return false;
  }
  const contentType = pickType(enabledTypes, perf);

  // Get brand profile
  const brand = await getBrandProfile();

  // Generate
  const usedSet = new Set(used.files);
  const generator = GENERATORS[contentType];
  const result = await generator(brand, library, usedSet);

  if (!result) {
    console.warn(`[content-bot] ${contentType} generation returned nothing`);
    return false;
  }

  // Blend in competitor-recommended hashtags if available
  const compHashtags = getCompetitorRecommendedHashtags();
  if (compHashtags.length > 0) {
    const existing = new Set(result.payload.hashtags.map((h: string) => h.toLowerCase()));
    const toAdd = compHashtags.filter((h) => !existing.has(h.toLowerCase())).slice(0, 3);
    if (toAdd.length > 0) {
      result.payload.hashtags = [...result.payload.hashtags, ...toAdd];
      result.payload.caption = result.payload.caption.replace(/\n\n[#\w\s]+$/, '');
      result.payload.caption = `${result.payload.caption}\n\n${result.payload.hashtags.map((h: string) => `#${h.replace(/^#/, '')}`).join(' ')}`;
    }
  }

  // Create publish task
  const contentId = `cnt_${contentType}_${Date.now()}`;
  const ok = await createPublishTask(bot.botId, bot.accountId, contentType, result.payload);
  if (ok) {
    state.lastPostAt[bot.botId] = Date.now();
    saveState(state);
    used.files.push(result.mediaKey);
    if (used.files.length > used.maxKeep) used.files = used.files.slice(-used.maxKeep);
    saveUsed(used);

    // Record in performance log
    perf.posts.push({
      contentId,
      contentType,
      botId: bot.botId,
      postedAt: Date.now(),
    });
    if (perf.posts.length > perf.maxPosts) perf.posts = perf.posts.slice(-perf.maxPosts);
    savePerf(perf);

    console.log(`[content-bot] Scheduled: ${contentType} → bot=${bot.botId} media=${result.mediaKey}`);
    return true;
  }
  return false;
};

// ============================================================
//  Daemon Mode
// ============================================================

let running = true;
process.on('SIGINT', () => { console.log('[content-bot] SIGINT'); running = false; });
process.on('SIGTERM', () => { console.log('[content-bot] SIGTERM'); running = false; });

const mainLoop = async () => {
  const state = loadState();
  const used = loadUsed();
  const perf = loadPerf();

  const enabled = getEnabledTypes();
  const insights = loadCompetitorInsights();

  console.log('[content-bot] Starting:', {
    libraryDir: CONTENT_LIBRARY_DIR,
    apiBase: API_BASE,
    postsPerDay: POSTS_PER_DAY_PER_BOT,
    minIntervalH: MIN_INTERVAL_HOURS,
    checkIntervalS: CHECK_INTERVAL_MS / 1000,
    enabledTypes: enabled,
    activeWeights: Object.fromEntries(Object.entries(perf.activeWeights).map(([k, v]) => [k, `${(v * 100).toFixed(0)}%`])),
    competitorInsights: insights ? {
      generatedAt: insights.generatedAt,
      profiles: insights.profilesAnalyzed,
      posts: insights.totalPostsAnalyzed,
      trend: insights.marketTrend,
      priorityTypes: insights.forContentBot.priorityContentTypes,
    } : null,
    keys: {
      deepseek: isApiKeySet('DEEPSEEK_API_KEY'),
      shotstack: isApiKeySet('SHOTSTACK_API_KEY'),
      replicate: isApiKeySet('REPLICATE_API_KEY'),
      openai: isApiKeySet('OPENAI_API_KEY'),
      elevenlabs: isApiKeySet('ELEVENLABS_API_KEY'),
    },
  });

  // Scan
  const library = scanLibrary();
  const totalFiles = Object.values(library).reduce((a, b) => a + b.length, 0);
  console.log(`[content-bot] Library: ${totalFiles} files across ${Object.entries(library).filter(([, v]) => v.length > 0).length} folders`);

  let lastScheduleCheck = 0;
  let lastFeedbackCheck = 0;
  let lastInsightsCheck = 0;

  while (running) {
    try {
      const now = Date.now();

      // Periodic insights reload (every 6 hours)
      if (now - lastInsightsCheck > 6 * 3600 * 1000) {
        lastInsightsCheck = now;
        const freshInsights = loadCompetitorInsights();
        if (freshInsights && freshInsights.generatedAt !== (cachedInsights?.generatedAt || '')) {
          const blended = blendWeights(perf);
          console.log('[content-bot] Reloaded competitor insights → blended weights:', Object.fromEntries(Object.entries(blended).map(([k, v]) => [k, `${(v * 100).toFixed(0)}%`])));
        }
      }

      // Periodic feedback collection (every 2 hours)
      if (now - lastFeedbackCheck > 2 * 3600 * 1000) {
        lastFeedbackCheck = now;
        const collected = await autoCollectFeedback(perf);
        if (collected > 0) console.log(`[content-bot] Auto-collected feedback for ${collected} posts`);
      }

      // Throttle checks
      if (now - lastScheduleCheck < 60000) { await sleep(10000); continue; }
      lastScheduleCheck = now;

      // Skip non-peak if on schedule
      const postsToday = Object.values(state.lastPostAt).filter((t) => now - t < 24 * 3600 * 1000).length;
      const expectedPosts = Math.max(1, Object.keys(state.lastPostAt).length) * POSTS_PER_DAY_PER_BOT;
      if (!isPeakHour() && postsToday >= expectedPosts) {
        await sleep(CHECK_INTERVAL_MS * 2);
        continue;
      }

      const scheduled = await schedulePost(state, used, perf);
      await sleep(scheduled ? 30000 : CHECK_INTERVAL_MS);
    } catch (e: any) {
      console.error(`[content-bot] Loop error: ${e.message}`);
      await sleep(60000);
    }
  }
};

// ============================================================
//  CLI
// ============================================================

const runOnce = async (count: number) => {
  const state = loadState();
  const used = loadUsed();
  const perf = loadPerf();

  const library = scanLibrary();
  const total = Object.values(library).reduce((a, b) => a + b.length, 0);
  console.log(`[content-bot] Library: ${total} files`);
  console.log(`[content-bot] Enabled: ${getEnabledTypes().join(', ')}`);
  console.log(`[content-bot] Weights: ${Object.entries(perf.activeWeights).map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`).join(', ')}`);

  let ok = 0;
  for (let i = 0; i < count; i++) {
    if (await schedulePost(state, used, perf)) ok++;
    if (i < count - 1) await sleep(3000);
  }
  console.log(`[content-bot] Done: ${ok}/${count}`);
};

const args = process.argv.slice(2);
if (args.includes('--once')) {
  const ci = args.indexOf('--count');
  const count = ci >= 0 ? Number(args[ci + 1]) || 1 : 1;
  runOnce(count).catch((e) => { console.error('[content-bot] Fatal:', e); process.exit(1); });
} else if (args.includes('--scan')) {
  const library = scanLibrary();
  for (const [type, files] of Object.entries(library)) {
    console.log(`  ${type}: ${files.length} files`);
  }
  process.exit(0);
} else if (args.includes('--types')) {
  const perf = loadPerf();
  console.log('Content types:');
  for (const t of (Object.keys(TYPE_CONFIG) as ContentType[])) {
    const cfg = TYPE_CONFIG[t];
    const enabled = getEnabledTypes().includes(t);
    const icon = enabled ? '✅' : '❌';
    const activeW = (perf.activeWeights[t] || 0) * 100;
    const defW = cfg.weight * 100;
    const samples = perf.typeSampleCount[t] || 0;
    const avgEng = typeof perf.typeAvgEngagement[t] === 'number' ? perf.typeAvgEngagement[t]!.toFixed(3) : '-';
    console.log(`  ${icon} ${t.padEnd(18)} active=${activeW.toFixed(0)}% (default=${defW.toFixed(0)}%)  samples=${samples}  avgEng=${avgEng}  needs:${cfg.needsApiKey}`);
  }
  process.exit(0);
} else if (args.includes('--insights')) {
  // Show competitor insights status
  const insights = loadCompetitorInsights();
  if (!insights) {
    console.log('No competitor insights available.');
    console.log('Run: npx tsx scripts/competitor-content-analyzer.ts');
  } else {
    console.log('=== Competitor Insights ===');
    console.log(`Generated: ${insights.generatedAt}`);
    console.log(`Profiles: ${insights.profilesAnalyzed} | Posts: ${insights.totalPostsAnalyzed}`);
    console.log(`Summary: ${insights.summary}`);
    console.log(`Trend: ${insights.marketTrend}`);
    console.log('');
    console.log('Opportunities:');
    for (const g of insights.gapsAndOpportunities) console.log(`  • ${g}`);
    console.log('');
    console.log('Content Mix:');
    for (const c of insights.contentMix) {
      console.log(`  ${c.contentType}: ${Math.round(c.recommendedWeight * 100)}% — ${c.reason}`);
    }
    console.log('');
    console.log('Priority: ' + insights.forContentBot.priorityContentTypes?.join(' > '));
    console.log('Top hashtags: ' + insights.forContentBot.recommendedHashtags?.map((h) => '#' + h).join(' '));
    if (insights.forContentBot.avoidPatterns?.length) {
      console.log('Avoid: ' + insights.forContentBot.avoidPatterns.join('; '));
    }
    console.log('');
    const perf = loadPerf();
    const blended = blendWeights(perf);
    console.log('Blended weights (own × competitor):');
    for (const t of (Object.keys(TYPE_CONFIG) as ContentType[])) {
      const own = (perf.activeWeights[t] || DEFAULT_WEIGHTS[t]) * 100;
      const bl = (blended[t] || 0) * 100;
      const arrow = bl > own + 1 ? '↑' : bl < own - 1 ? '↓' : '→';
      console.log(`  ${t.padEnd(18)} own=${own.toFixed(0)}% → blended=${bl.toFixed(0)}% ${arrow}`);
    }
  }
  process.exit(0);
} else if (args.includes('--feedback')) {
  // Manual feedback: --feedback <contentId> <likes> <comments> [views]
  const idIdx = args.indexOf('--feedback');
  const contentId = args[idIdx + 1] || '';
  const likes = Number(args[idIdx + 2]) || 0;
  const comments = Number(args[idIdx + 3]) || 0;
  const views = Number(args[idIdx + 4]) || undefined;
  if (!contentId) { console.error('Usage: --feedback <contentId> <likes> <comments> [views]'); process.exit(1); }
  const perf = loadPerf();
  const ok = reportFeedback(perf, contentId, likes, comments, views);
  console.log(ok ? 'Feedback recorded' : 'Post not found');
  process.exit(ok ? 0 : 1);
} else if (args.includes('--perf')) {
  // Show performance dashboard
  const perf = loadPerf();
  console.log('=== Performance Dashboard ===');
  console.log(`Last adjusted: ${perf.lastAdjustedAt ? new Date(perf.lastAdjustedAt).toISOString() : 'never'}`);
  console.log(`Posts tracked: ${perf.posts.length} (checked: ${perf.posts.filter((p) => p.checkedAt).length})`);
  console.log('');
  console.log('By type:');
  for (const t of (Object.keys(DEFAULT_WEIGHTS) as ContentType[])) {
    const samples = perf.typeSampleCount[t] || 0;
    const avgEng = perf.typeAvgEngagement[t];
    const weight = perf.activeWeights[t] || 0;
    const defWeight = DEFAULT_WEIGHTS[t];
    const delta = weight - defWeight;
    const arrow = delta > 0.02 ? '↑' : delta < -0.02 ? '↓' : '→';
    console.log(`  ${t.padEnd(18)} weight=${(weight * 100).toFixed(0)}% ${arrow}  samples=${samples}  avgEng=${typeof avgEng === 'number' ? avgEng.toFixed(3) : '-'}`);
  }
  console.log('');
  console.log('Recent posts:');
  for (const p of perf.posts.slice(-10).reverse()) {
    const status = p.checkedAt ? `${p.likes}L ${p.comments}C` : `pending (${Math.round((Date.now() - p.postedAt) / 3600000)}h ago)`;
    console.log(`  ${p.contentId.padEnd(32)} ${p.contentType.padEnd(16)} ${status}`);
  }
  process.exit(0);
} else if (args.includes('--reset-weights')) {
  const perf = loadPerf();
  perf.activeWeights = { ...DEFAULT_WEIGHTS };
  perf.lastAdjustedAt = Date.now();
  savePerf(perf);
  console.log('Weights reset to defaults');
  process.exit(0);
} else {
  mainLoop().catch((e) => { console.error('[content-bot] Fatal:', e); process.exit(1); });
}
