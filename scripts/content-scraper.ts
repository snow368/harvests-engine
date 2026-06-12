/**
 * Content Scraper v2 — 采集合作纹身师帖子 + 评分系统
 *
 * 两套评分：
 *   PartnerArtistScore — 这个纹身师值不值得持续采集
 *   PostQualityScore   — 单个帖子能不能用于二次创作
 *
 * 输入: content_competitors 表中的 active handles
 * 输出: content_samples 表 (SQLite 直写) + content-library/products/ (媒体文件)
 *
 * ENV:
 *   BOT_ID=bot_wa_02
 *   BOT_PROFILE_DIR=.../bot_wa_02_cloak
 *   BOT_PROXY_SERVER=socks5://127.0.0.1:10808
 *   CONTENT_SCRAPE_POSTS_PER_HANDLE=5
 *   CONTENT_SCRAPE_MIN_POST_SCORE=55    (低于此分不采集)
 *   GEMINI_API_KEY=...                  (推荐: 1500次/天免费, 自动检测)
 *   DEEPSEEK_API_KEY=...                (备选, 同时用于文案改写)
 *   OPENAI_API_KEY=...                  (备选, GPT-4V)
 *   VISION_BACKEND=gemini|deepseek|openai  (显式指定, 留空自动检测)
 *   VISION_MODEL=gemini-2.0-flash       (覆盖默认模型)
 *   CONTENT_SCRAPE_SKIP_VISION=true     (跳过 AI 视觉评分, 纯关键词评分)
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';

// ============ Config ============
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const BOT_ID = (process.env.BOT_ID || 'bot_wa_02').trim();
const PROFILE_DIR = process.env.BOT_PROFILE_DIR || `./data/bot_profiles/${BOT_ID}_cloak`;
const HEADLESS = String(process.env.BOT_HEADLESS || 'false').toLowerCase() === 'true';
const PROXY_SERVER = (process.env.BOT_PROXY_SERVER || '').trim();
const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.CONTENT_SCRAPE_POLL_MS || 15000));
const POSTS_PER_HANDLE = Math.max(1, Math.min(12, Number(process.env.CONTENT_SCRAPE_POSTS_PER_HANDLE || 5)));
const MIN_POST_SCORE = Math.max(0, Math.min(100, Number(process.env.CONTENT_SCRAPE_MIN_POST_SCORE || 50)));
const MIN_ARTIST_SCORE = Math.max(0, Math.min(100, Number(process.env.CONTENT_SCRAPE_MIN_ARTIST_SCORE || 40)));

const CONTENT_LIBRARY = (process.env.CONTENT_LIBRARY_DIR || './content-library').trim();
const PRODUCT_DIR = path.join(CONTENT_LIBRARY, 'products');
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');

// ============ AI Vision Config ============
// All free backends: gemini (1500/day), glm (智谱 free tier), doubao (字节 free tier)
// Set VISION_BACKEND=gemini|glm|doubao|deepseek|openai . Auto-detects from available keys.
const VISION_BACKEND = (process.env.VISION_BACKEND || '').trim().toLowerCase();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GLM_KEY = (process.env.GLM_API_KEY || '').trim();
const DOUBAO_KEY = (process.env.DOUBAO_API_KEY || '').trim();
const DEEPSEEK_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();

// Auto-detect backend: free ones first, then paid
const detectBackend = (): { apiKey: string; base: string; model: string } | null => {
  if (VISION_BACKEND === 'gemini' && GEMINI_KEY) {
    return { apiKey: GEMINI_KEY, base: 'https://generativelanguage.googleapis.com/v1beta', model: process.env.VISION_MODEL || 'gemini-2.0-flash' };
  }
  if (VISION_BACKEND === 'glm' && GLM_KEY) {
    return { apiKey: GLM_KEY, base: 'https://open.bigmodel.cn/api/paas/v4', model: process.env.VISION_MODEL || 'glm-4v' };
  }
  if (VISION_BACKEND === 'doubao' && DOUBAO_KEY) {
    return { apiKey: DOUBAO_KEY, base: 'https://ark.cn-beijing.volces.com/api/v3', model: DOUBAO_KEY };
  }
  if (VISION_BACKEND === 'deepseek' && DEEPSEEK_KEY) {
    return { apiKey: DEEPSEEK_KEY, base: 'https://api.deepseek.com/v1', model: process.env.VISION_MODEL || 'deepseek-chat' };
  }
  if (VISION_BACKEND === 'openai' && OPENAI_KEY) {
    return { apiKey: OPENAI_KEY, base: 'https://api.openai.com/v1', model: process.env.VISION_MODEL || 'gpt-4o' };
  }
  // Auto-detect: prefer free backends
  if (GEMINI_KEY) return { apiKey: GEMINI_KEY, base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' };
  if (GLM_KEY) return { apiKey: GLM_KEY, base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4v' };
  if (DOUBAO_KEY) return { apiKey: DOUBAO_KEY, base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-vision-pro-32k' };
  if (DEEPSEEK_KEY) return { apiKey: DEEPSEEK_KEY, base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
  if (OPENAI_KEY) return { apiKey: OPENAI_KEY, base: 'https://api.openai.com/v1', model: 'gpt-4o' };
  return null;
};

const visionBackend = detectBackend();
const VISION_ENABLED = !!visionBackend && !(process.env.CONTENT_SCRAPE_SKIP_VISION === 'true');
const VISION_TIMEOUT_MS = 30000;
console.log('[content-scraper] vision backend:', visionBackend ? `${visionBackend.model} (${visionBackend.base})` : 'disabled');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, range: number) => base + Math.floor(Math.random() * range);

// ============ Tattoo City Density Map (global) ============
// Score 0-10 based on tattoo culture density
const CITY_DENSITY: Record<string, number> = {
  // Americas
  'los angeles': 10, 'new york': 10, 'miami': 9, 'portland': 9, 'seattle': 9, 'austin': 9,
  'chicago': 8, 'san francisco': 8, 'san diego': 8, 'denver': 8, 'las vegas': 8,
  'atlanta': 7, 'nashville': 7, 'phoenix': 7, 'dallas': 7, 'houston': 7, 'philadelphia': 7,
  'toronto': 9, 'vancouver': 8, 'montreal': 8, 'mexico city': 8, 'buenos aires': 7, 'sao paulo': 8,
  // Europe
  'london': 10, 'berlin': 9, 'paris': 8, 'amsterdam': 9, 'barcelona': 8, 'madrid': 7,
  'milan': 8, 'rome': 7, 'copenhagen': 8, 'stockholm': 8, 'oslo': 7, 'helsinki': 7,
  'warsaw': 7, 'prague': 7, 'vienna': 6, 'brussels': 6, 'dublin': 7, 'lisbon': 7,
  // Asia
  'tokyo': 10, 'seoul': 9, 'hong kong': 9, 'bangkok': 8, 'singapore': 8, 'taipei': 8,
  'shanghai': 7, 'beijing': 6, 'mumbai': 7, 'manila': 8, 'jakarta': 7, 'kuala lumpur': 7,
  // Oceania
  'sydney': 9, 'melbourne': 9, 'auckland': 8, 'brisbane': 8, 'perth': 7,
};

const getCityDensityScore = (cityLabel: string): number => {
  const lower = cityLabel.toLowerCase().replace(/[^a-z\s]/g, '');
  for (const [city, score] of Object.entries(CITY_DENSITY)) {
    if (lower.includes(city)) return score;
  }
  return 3; // unknown city, baseline
};

// ============ Product Keywords (by category) ============
const PRODUCT_SIGNALS: Record<string, number> = {
  // Strong signals (direct product mention)
  'tattoo ink': 10, 'tattoo cartridge': 10, 'tattoo needle': 10,
  'rotary machine': 9, 'tattoo machine': 9, 'pen machine': 9,
  'wireless tattoo': 9, 'tattoo grip': 8, 'tattoo supply': 8,
  // Medium signals
  'tattoo equipment': 7, 'tattoo gear': 7, 'tattoo shop supply': 7,
  'needle cartridge': 8, 'power supply': 6, 'tattoo setup': 6,
  // Weak signals (could be generic)
  'ink': 3, 'cartridge': 3, 'needle': 3, 'grip': 3, 'machine': 2,
  'rotary': 4, 'wireless': 3, 'cordless': 3, 'battery': 2,
};

const detectProductScore = (caption: string): number => {
  const lower = caption.toLowerCase();
  let score = 0;
  for (const [kw, pts] of Object.entries(PRODUCT_SIGNALS)) {
    if (lower.includes(kw)) score = Math.max(score, pts); // take highest signal
  }
  return Math.min(10, score);
};

// ============ Engagement OCR ============
const extractEngagementFromPage = async (p: any): Promise<{ likes: number; comments: number }> => {
  try {
    // Post modal: likes are usually in a section or span near the action buttons
    const sel = 'section span, div[role="dialog"] span, article span';
    const texts = await p.locator(sel).allInnerTexts().catch(() => []) as string[];
    const allText = texts.join(' ');
    let likes = 0, comments = 0;
    // IG formats globally
    const likeM = allText.match(/([\d,.]+[kKmM]?)\s*(likes?|赞|Me gusta|curtidas|personnes|Likes)/i);
    if (likeM) {
      const raw = likeM[1].toLowerCase().replace(/,/g, '');
      likes = raw.endsWith('m') ? Math.round(parseFloat(raw) * 1e6) : raw.endsWith('k') ? Math.round(parseFloat(raw) * 1e3) : parseInt(raw) || 0;
    }
    const commentM = allText.match(/([\d,]+)\s*(comments?|评论|commentaires?|comentarios)/i);
    if (commentM) comments = parseInt(commentM[1].replace(/,/g, '')) || 0;
    return { likes, comments };
  } catch {
    return { likes: 0, comments: 0 };
  }
};

// ============ AI Vision: Tattoo Quality Evaluation ============
interface TattooQualityScores {
  lineWork: number;        // 0-10 clean lines, no wobble, consistent weight
  shading: number;         // 0-10 smooth gradients, proper saturation
  composition: number;     // 0-10 balanced layout, body flow, proportions
  technicalExecution: number; // 0-10 no blowouts, proper depth, minimal skin damage
  overallAesthetic: number;   // 0-10 overall visual appeal
  productVisibility: number;  // 0-10 how visible/featured tattoo supplies are
  photographerQuality: number; // 0-10 lighting, sharpness, angle (NOT tattoo quality)
  summary: string;         // 1-2 sentence critique
}

interface VideoQualityScores extends TattooQualityScores {
  // Video-specific dimensions (0-10)
  stability: number;          // camera steadiness, lack of shake
  cameraMovement: number;     // quality of pans/zooms/tracking movement
  pacing: number;             // editing rhythm, scene transitions, no dead time
  keyframeCoverage: number;   // are key moments captured (detail/wide/process)?
  lightingConsistency: number; // lighting stability across frames
  contentClassification: string; // product_demo / artist_work / educational / lifestyle / bts
}

const evaluateTattooQuality = async (imageBase64: string, caption: string): Promise<TattooQualityScores | null> => {
  if (!VISION_ENABLED || !visionBackend) return null;

  const prompt = `Analyze this tattoo image and rate it on each dimension (0-10 scale). Be critical and precise — most tattoos should score 4-7, only exceptional work scores 8+.

Dimensions:
1. **Line Work** (0-10): Are lines clean and consistent? Any wobble, uneven weight, or gaps?
2. **Shading & Color** (0-10): Are gradients smooth? Is color saturation even and well-packed?
3. **Composition & Design** (0-10): Is the layout balanced? Does it flow with the body? Are proportions correct? Is it readable from a distance?
4. **Technical Execution** (0-10): Any blowouts (ink spread under skin)? Proper needle depth? Minimal unnecessary skin trauma/redness?
5. **Overall Aesthetic** (0-10): General visual appeal. Would this stop a scroll?
6. **Product Visibility** (0-10): Are tattoo supplies/equipment/products visible or featured? (0 = not at all, 10 = product is the main focus)
7. **Photographer Quality** (0-10): Is the photo well-lit, sharp, well-angled? (This rates the PHOTO, not the tattoo)

Caption context: "${caption.slice(0, 300)}"

Respond ONLY with valid JSON, no markdown:
{
  "lineWork": <0-10>,
  "shading": <0-10>,
  "composition": <0-10>,
  "technicalExecution": <0-10>,
  "overallAesthetic": <0-10>,
  "productVisibility": <0-10>,
  "photographerQuality": <0-10>,
  "summary": "<1-2 sentence critique>"
}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

    let text: string;

    if (visionBackend.base.includes('generativelanguage')) {
      // ====== Gemini API ======
      const resp = await fetch(
        `${visionBackend.base}/models/${visionBackend.model}:generateContent?key=${visionBackend.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType: 'image/png', data: imageBase64 } },
                { text: prompt }
              ]
            }],
            generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
          }),
          signal: controller.signal
        }
      );
      clearTimeout(timeout);
      const data: any = await resp.json();
      if (!resp.ok || data.error) {
        console.warn('[content-scraper] Gemini API error:', data?.error?.message || resp.status);
        return null;
      }
      text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      if (!text && data?.candidates?.[0]?.finishReason === 'SAFETY') {
        console.warn('[content-scraper] Gemini blocked image (safety filter)');
        return null;
      }
    } else if (visionBackend.base.includes('deepseek')) {
      // ====== DeepSeek Vision (image object format) ======
      // Note: deepseek-chat text model has limited vision support.
      // Images must be small (<20MB) and use type: "image" not "image_url"
      const resp = await fetch(`${visionBackend.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${visionBackend.apiKey}`
        },
        body: JSON.stringify({
          model: visionBackend.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', image_url: { url: `data:image/png;base64,${imageBase64}` } },
              { type: 'text', text: prompt }
            ]
          }],
          max_tokens: 500,
          temperature: 0.3,
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data: any = await resp.json();
      if (!resp.ok || data.error) {
        console.warn('[content-scraper] DeepSeek vision error:', data?.error?.message || resp.status);
        return null;
      }
      text = data?.choices?.[0]?.message?.content?.trim() || '';
    } else {
      // ====== OpenAI-compatible API (OpenAI, GLM, Doubao) ======
      const resp = await fetch(`${visionBackend.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${visionBackend.apiKey}`
        },
        body: JSON.stringify({
          model: visionBackend.model,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
              { type: 'text', text: prompt }
            ]
          }],
          max_tokens: 500,
          temperature: 0.3,
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const data: any = await resp.json();
      if (!resp.ok || data.error) {
        console.warn('[content-scraper] vision API error:', data?.error?.message || data?.error?.code || resp.status);
        return null;
      }
      text = data?.choices?.[0]?.message?.content?.trim() || '';
    }

    // Extract JSON from response (may have markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[content-scraper] vision response not JSON:', text.slice(0, 100));
      return null;
    }

    const scores: TattooQualityScores = JSON.parse(jsonMatch[0]);
    const clamp = (v: number) => Math.max(0, Math.min(10, Number(v) || 5));
    return {
      lineWork: clamp(scores.lineWork),
      shading: clamp(scores.shading),
      composition: clamp(scores.composition),
      technicalExecution: clamp(scores.technicalExecution),
      overallAesthetic: clamp(scores.overallAesthetic),
      productVisibility: clamp(scores.productVisibility),
      photographerQuality: clamp(scores.photographerQuality),
      summary: String(scores.summary || '').slice(0, 200),
    };
  } catch (e: any) {
    console.warn('[content-scraper] vision API error:', e?.message?.slice(0, 100));
    return null;
  }
};

// ============ Video Quality Evaluation ============

/**
 * Score video frames individually, then aggregate into video-specific dimensions.
 * Frames should be base64-encoded JPEGs extracted via ffmpeg.
 */
const evaluateVideoFrames = async (
  frameBase64List: string[],
  caption: string,
): Promise<VideoQualityScores | null> => {
  if (!VISION_ENABLED || !visionBackend || frameBase64List.length === 0) return null;

  // Score up to 3 frames individually (in parallel)
  const framesToScore = frameBase64List.slice(0, 3);
  const frameScores: (TattooQualityScores | null)[] = await Promise.all(
    framesToScore.map((frame) => evaluateTattooQuality(frame, caption))
  );

  const validScores = frameScores.filter((s): s is TattooQualityScores => s !== null);
  if (validScores.length === 0) return null;

  // Aggregate frame scores (median for robustness)
  const avg = (vals: number[]) => {
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  const extract = (key: keyof TattooQualityScores) =>
    avg(validScores.map((s) => (s as any)[key] as number));

  // Video-specific dimensions computed from frame variance + metadata
  const photographerVals = validScores.map((s) => s.photographerQuality);
  const stability = Math.max(0, Math.min(10, Math.round(
    10 - (photographerVals.length > 1 ? Math.abs(photographerVals[0] - photographerVals[photographerVals.length - 1]) * 2 : 3)
  )));
  const cameraMovement = Math.max(0, Math.min(10, Math.round(
    photographerVals.length > 1 ? Math.max(...photographerVals) - Math.min(...photographerVals) + 4 : 5
  )));
  const pacing = Math.round(extract('overallAesthetic') * 0.8);
  const keyframeCoverage = Math.round(
    (validScores.length >= 3 ? 8 : validScores.length >= 2 ? 6 : 4) +
    (extract('productVisibility') > 5 ? 1 : 0)
  );
  const lightingConsistency = Math.round(extract('photographerQuality') * 0.9);

  // Content classification via simple heuristics (refined later by content-analyzer)
  let contentClassification = 'artist_work';
  if (extract('productVisibility') >= 7) contentClassification = 'product_demo';
  else if (caption.length > 200 && extract('overallAesthetic') >= 7) contentClassification = 'educational';
  else if (caption.length < 50 && extract('photographerQuality') >= 7) contentClassification = 'lifestyle';

  return {
    lineWork: Math.round(extract('lineWork')),
    shading: Math.round(extract('shading')),
    composition: Math.round(extract('composition')),
    technicalExecution: Math.round(extract('technicalExecution')),
    overallAesthetic: Math.round(extract('overallAesthetic')),
    productVisibility: Math.round(extract('productVisibility')),
    photographerQuality: Math.round(extract('photographerQuality')),
    summary: validScores.map((s) => s.summary).filter(Boolean).join(' | ').slice(0, 300),
    stability,
    cameraMovement,
    pacing,
    keyframeCoverage,
    lightingConsistency,
    contentClassification,
  };
};

// ============ Scoring: Individual Post ============
interface PostScore {
  productVisibility: number;  // 0-35  — product visible in image/caption
  tattooQuality: number;      // 0-20  — AI-evaluated tattoo craftsmanship
  imageAesthetics: number;    // 0-10  — photo lighting, sharpness, angle
  engagement: number;         // 0-15  — likes/comments normalized
  captionQuality: number;     // 0-10  — length, product description quality
  freshness: number;          // 0-10  — how recent
  total: number;              // 0-100
  visionScores?: TattooQualityScores | null;
}

const scorePost = (
  caption: string,
  engagement: { likes: number; comments: number },
  imageInfo: { width: number; height: number; isVideo: boolean },
  postDaysAgo: number,
  visionScores?: TattooQualityScores | null
): PostScore => {
  // 1. Product visibility (0-35) — caption keywords + AI vision product detection
  const productScore = detectProductScore(caption);
  const visionProductScore = visionScores?.productVisibility ?? 0;
  const productVisibility = Math.min(35, Math.round(productScore * 2.5 + visionProductScore * 1.0));

  // 2. Tattoo quality (0-20) — AI vision evaluation of actual craftsmanship
  let tattooQuality = 10; // default neutral
  if (visionScores) {
    tattooQuality = Math.round(
      (visionScores.lineWork * 4 + visionScores.shading * 4 + visionScores.composition * 4 +
       visionScores.technicalExecution * 4 + visionScores.overallAesthetic * 4) / 10
    );
  }
  tattooQuality = Math.min(20, tattooQuality);

  // 3. Image aesthetics (0-10) — photo quality (lighting, sharpness, angle)
  let imageAesthetics = 5; // default mediocre
  if (visionScores) {
    imageAesthetics = Math.round(visionScores.photographerQuality);
  } else {
    // Fallback: crude resolution-based score
    const px = imageInfo.width * imageInfo.height;
    imageAesthetics = Math.min(10, Math.round((Math.log2(px + 1) - 18) * 2));
  }

  // 4. Engagement (0-15) — log-scale normalize
  const totalEng = engagement.likes + engagement.comments * 2;
  const engScore = Math.min(10, Math.log2(totalEng + 1));
  const engagementScore = Math.round(engScore * 1.5);

  // 5. Caption quality (0-10) — length + product description
  const lengthScore = Math.min(6, Math.round(caption.length / 30));
  const captionQuality = Math.min(10, lengthScore + (productScore >= 5 ? 4 : 0));

  // 6. Freshness (0-10) — newer = higher
  const freshness = Math.max(0, Math.round(10 - postDaysAgo * 1.5));

  const total = productVisibility + tattooQuality + imageAesthetics + engagementScore + captionQuality + freshness;
  return { productVisibility, tattooQuality, imageAesthetics, engagement: engagementScore, captionQuality, freshness, total, visionScores };
};

// ============ Scoring: Partner Artist ============
interface ArtistScore {
  workQuality: number;      // 0-40  — avg AI-evaluated tattoo quality across posts
  productFrequency: number; // 0-25  — % posts featuring product
  activity: number;         // 0-15  — post frequency
  engagementRate: number;   // 0-10  — avg engagement / followers
  regionDensity: number;    // 0-10  — tattoo city density
  total: number;
}

const scoreArtist = (
  stats: {
    postCount: number;
    avgLikes: number;
    avgComments: number;
    followers: number;
    productPostRatio: number;
    cityLabel: string;
    avgTattooQuality?: number; // 0-20 from vision scores
  }
): ArtistScore => {
  // workQuality: use AI vision scores if available, fallback to engagement proxy
  let workQuality: number;
  if (stats.avgTattooQuality !== undefined && stats.avgTattooQuality > 0) {
    workQuality = Math.min(40, Math.round(stats.avgTattooQuality * 2)); // 0-20 → 0-40
  } else {
    workQuality = Math.min(40, Math.round(stats.avgLikes > 100 ? 35 : stats.avgLikes > 20 ? 25 : 10));
  }
  const productFrequency = Math.min(25, Math.round(stats.productPostRatio * 25));
  const activity = Math.min(15, Math.round((stats.postCount / 100) * 15));
  const er = stats.followers > 0 ? ((stats.avgLikes + stats.avgComments) / stats.followers) * 100 : 0;
  const engagementRate = Math.min(10, Math.round(er * 2));
  const regionDensity = getCityDensityScore(stats.cityLabel);

  const total = workQuality + productFrequency + activity + engagementRate + regionDensity;
  return { workQuality, productFrequency, activity, engagementRate, regionDensity, total };
};

// ============ DB ============
const db = new Database(DB_PATH);
const insertContentSample = db.prepare(`
  INSERT OR IGNORE INTO content_samples (handle, source_type, post_url, caption, style_tags_json, topic_tag, quality_score, observed_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ============ API ============
const getJson = async (p: string) => {
  const resp = await fetch(`${API_BASE}${p}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

// ============ CloakBrowser ============
let context: any = null;
let page: any = null;
let launching: Promise<void> | null = null; // prevent concurrent launches
let lastLaunchTime = 0; // prevent rapid relaunch cycles

const ensureBrowser = async () => {
  // Reuse alive page
  if (page && context) {
    try {
      await page.evaluate(() => document.title);
      return;
    } catch {
      console.log('[content-scraper] dead context, cleaning up...');
      try { await context.close(); } catch {}
      context = null;
      page = null;
    }
  }
  // Close orphaned context
  if (context) {
    try { await context.close(); } catch {}
    context = null;
    page = null;
  }
  // Enforce launch cooldown (prevents window spam on repeated failures)
  const now = Date.now();
  const cooldownMs = 30000;
  if (now - lastLaunchTime < cooldownMs) {
    throw new Error(`browser launch cooldown (${Math.round((cooldownMs - (now - lastLaunchTime)) / 1000)}s remaining)`);
  }
  // Wait for an in-progress launch
  if (launching) {
    console.log('[content-scraper] waiting for browser launch in progress...');
    await launching;
    return;
  }

  lastLaunchTime = Date.now();

  launching = (async () => {
    const { launchPersistentContext } = await import('cloakbrowser');
    const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR || undefined;
    if (cacheDir && !fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    const proxyConfig = PROXY_SERVER ? {
      server: PROXY_SERVER,
      bypass: 'localhost,127.0.0.1,::1'
    } : undefined;

    const launchArgs: string[] = [];
    if (!HEADLESS) launchArgs.push('--window-size=1280,900');

    console.log('[content-scraper] launching CloakBrowser...');
    context = await launchPersistentContext({
      userDataDir: PROFILE_DIR,
      headless: HEADLESS,
      viewport: { width: 1280, height: 900 },
      humanize: !(process.env.BOT_HUMANIZE === 'false'),
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
      args: launchArgs,
    }) as any;

    const existingPages = (context as any).pages?.() || [];
    for (const p of existingPages) {
      try { if (p.url().includes('instagram.com')) { page = p; break; } } catch {}
    }
    if (!page) {
      page = await (context as any).newPage();
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    console.log('[content-scraper] CloakBrowser ready');
  })();

  try {
    await launching;
  } catch (e: any) {
    console.error('[content-scraper] launch failed:', e?.message?.slice(0, 150));
    context = null;
    page = null;
    throw e;
  } finally {
    launching = null;
  }
};

// ============ Helpers ============
const downloadMedia = async (url: string, destPath: string): Promise<boolean> => {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return false;
    const writer = createWriteStream(destPath);
    await pipeline(resp.body as any, writer);
    return true;
  } catch { return false; }
};

const extractFramesFromVideo = async (videoPath: string, outputDir: string, handle: string): Promise<string[]> => {
  const frames: string[] = [];
  const baseName = `${handle}_${Date.now()}`;
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', [
        '-i', videoPath, '-vf', 'fps=1/3', '-frames:v', '5', '-q:v', '2',
        path.join(outputDir, `${baseName}_frame_%02d.jpg`)
      ], (err) => { if (err) reject(err); else resolve(); });
    });
    for (const f of fs.readdirSync(outputDir).filter(f => f.startsWith(baseName))) {
      frames.push(path.join(outputDir, f));
    }
    console.log(`[content-scraper] extracted ${frames.length} frames for @${handle}`);
  } catch (e: any) {
    console.warn(`[content-scraper] ffmpeg failed:`, e?.message);
  }
  return frames;
};

// ============ Core ============
const scrapeProfile = async (handle: string, postsLimit: number = POSTS_PER_HANDLE) => {
  console.log(`\n[content-scraper] === @${handle} (limit: ${postsLimit}) ===`);
  await ensureBrowser();

  await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for main content area (same pattern as bot-worker)
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(jitter(3000, 5000));

  // --- Artist-level stats ---
  let followerCount = 0, postCount = 0, cityLabel = '';
  try {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const fM = bodyText.match(/([\d,.]+[kKmM]?)\s*followers?/i);
    if (fM) {
      const raw = fM[1].toLowerCase().replace(/,/g, '');
      followerCount = raw.endsWith('m') ? parseFloat(raw) * 1e6 : raw.endsWith('k') ? parseFloat(raw) * 1e3 : parseInt(raw) || 0;
    }
    const pM = bodyText.match(/([\d,]+)\s*posts?/i);
    if (pM) postCount = parseInt(pM[1].replace(/,/g, '')) || 0;
    // Extract city from bio
    const bioM = bodyText.match(/(?:📍|location:|based in|based out of|from)\s*([^\n]{3,40})/i);
    cityLabel = bioM ? bioM[1].trim() : '';
  } catch {}

  // --- Post tiles (same selectors as bot-worker) ---
  const tileSelector = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
  let tileCount = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    tileCount = await page.locator(tileSelector).count();
    if (tileCount > 0) break;
    await page.mouse.wheel(0, 200); // gentle scroll triggers lazy loading
    await page.waitForTimeout(jitter(1500, 3000));
  }
  if (tileCount === 0) {
    console.log(`[content-scraper] @${handle}: no posts found`);
    return { handle, postsScored: 0, artistScore: null };
  }
  console.log(`[content-scraper] @${handle}: ${tileCount} post tiles`);

  const limit = Math.min(postsLimit, tileCount);
  const scoredPosts: Array<{ score: PostScore; postUrl: string; caption: string; mediaPaths: string[] }> = [];

  for (let i = 0; i < limit; i++) {
    try {
      const tile = page.locator(tileSelector).nth(i);
      await tile.scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(800, 2000));
      await tile.click({ timeout: 10000 });
      await page.waitForTimeout(jitter(2000, 4000));

      const postUrl = page.url();

      // Caption: the first <li> in the post dialog's comment list is the post caption.
      // Use first() — allInnerTexts() was picking up nav/timestamp/UI text from ALL <li> elements.
      let caption = '';
      try {
        const captionLi = page.locator('div[role="dialog"] ul > li').first();
        if ((await captionLi.count()) > 0) {
          caption = (await captionLi.innerText().catch(() => '')).trim();
        }
      } catch {}
      if (!caption) {
        try {
          const h1 = page.locator('div[role="dialog"] h1').first();
          if ((await h1.count()) > 0) caption = (await h1.innerText().catch(() => '')).trim();
        } catch {}
      }
      // Strip IG UI noise (handle repeats, "View translation", timestamps)
      caption = caption
        .replace(/\b\d+[dw] ago\b/gi, '')
        .replace(/\bView translation\b/gi, '')
        .replace(/\b查看翻译\b/g, '')
        .replace(/\bVer traducción\b/gi, '')
        .replace(/\b\d+天\b/g, '')
        .replace(/\b\d+[kKmM]?\s*(?:likes?|views?|comments?)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Engagement
      const eng = await extractEngagementFromPage(page);

      // Image info
      const imgInfo = { width: 1080, height: 1080, isVideo: postUrl.includes('/reel/') };

      // Post age: try to read <time datetime="..."> element
      let postDaysAgo = 7;
      try {
        const dt = await page.locator('time').first().getAttribute('datetime').catch(() => null);
        if (dt) {
          const postDate = new Date(dt as string);
          postDaysAgo = Math.max(0, Math.round((Date.now() - postDate.getTime()) / (86400 * 1000)));
        }
      } catch {}

      // ---- Media download (reordered: download first so we can score video frames) ----
      const mediaPaths: string[] = [];
      const mediaDir = path.join(process.cwd(), 'data', 'content_scraped');
      if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });

      let videoFrames: string[] = [];

      try {
        const mediaEl = page.locator('div[role="dialog"] img, div[role="dialog"] video').first();
        if ((await mediaEl.count()) > 0) {
          const src = await mediaEl.getAttribute('src') || '';
          if (src) {
            const ext = src.includes('.mp4') ? 'mp4' : 'jpg';
            const file = path.join(PRODUCT_DIR, `${handle}_post_${i}_${Date.now()}.${ext}`);
            if (await downloadMedia(src, file)) {
              mediaPaths.push(file);
              if (ext === 'mp4' && imgInfo.isVideo) {
                const frames = await extractFramesFromVideo(file, PRODUCT_DIR, handle);
                videoFrames = frames;
                mediaPaths.push(...frames);
              }
            }
          }
        }
      } catch {}

      // ---- AI Vision evaluation ----
      let visionScores: TattooQualityScores | null = null;
      let videoScores: VideoQualityScores | null = null;

      if (VISION_ENABLED) {
        if (imgInfo.isVideo && videoFrames.length > 0) {
          // Video: score extracted frames with video-specific dimensions
          const frameBase64List: string[] = [];
          for (const fpath of videoFrames.slice(0, 3)) {
            try {
              const buf = fs.readFileSync(fpath);
              frameBase64List.push(buf.toString('base64'));
            } catch {}
          }
          if (frameBase64List.length > 0) {
            videoScores = await evaluateVideoFrames(frameBase64List, caption);
            visionScores = videoScores; // inherit static dimensions
            if (videoScores) {
              console.log(`[content-scraper]   video vision (${frameBase64List.length} frames): line=${videoScores.lineWork} shade=${videoScores.shading} comp=${videoScores.composition} tech=${videoScores.technicalExecution} stability=${videoScores.stability} camera=${videoScores.cameraMovement} pacing=${videoScores.pacing} keyframes=${videoScores.keyframeCoverage} lighting=${videoScores.lightingConsistency} class=${videoScores.contentClassification}`);
            }
          }
        } else {
          // Static image: score page screenshot
          try {
            const ssBuf = await page.screenshot({ type: 'png', fullPage: false });
            const screenshotBase64 = ssBuf.toString('base64');
            visionScores = await evaluateTattooQuality(screenshotBase64, caption);
            if (visionScores) {
              console.log(`[content-scraper]   vision: line=${visionScores.lineWork} shade=${visionScores.shading} comp=${visionScores.composition} tech=${visionScores.technicalExecution} aesthetic=${visionScores.overallAesthetic} product=${visionScores.productVisibility} photo=${visionScores.photographerQuality}`);
            }
          } catch {}
        }
      }

      // Score the post (video scores add extra weight for video-specific quality)
      const baseScore = scorePost(caption, eng, imgInfo, postDaysAgo, visionScores);
      // Boost video posts that have high video-specific quality
      let videoBonus = 0;
      if (videoScores) {
        videoBonus = Math.round((videoScores.stability + videoScores.cameraMovement + videoScores.pacing + videoScores.keyframeCoverage) / 8);
      }
      const score = { ...baseScore, total: Math.min(100, baseScore.total + videoBonus) };

      console.log(`[content-scraper]   post ${i}: score=${score.total}/100 (product=${score.productVisibility} tattoo=${score.tattooQuality} photo=${score.imageAesthetics} eng=${score.engagement} caption=${score.captionQuality} fresh=${score.freshness}${videoBonus ? ` +video=${videoBonus}` : ''})`);

      // Only keep posts above threshold
      if (score.total >= MIN_POST_SCORE) {
        // Screenshot
        const ssPath = path.join(mediaDir, `${handle}_post_${i}_${Date.now()}.png`);
        await page.screenshot({ path: ssPath, fullPage: false });

        // Store in DB (include vision scores and video dimensions for downstream use)
        insertContentSample.run(
          handle, 'partner_scrape', postUrl, caption.slice(0, 1000),
          JSON.stringify({
            productKeywords: detectProductScore(caption),
            vision: visionScores ? {
              lineWork: visionScores.lineWork,
              shading: visionScores.shading,
              composition: visionScores.composition,
              technicalExecution: visionScores.technicalExecution,
              overallAesthetic: visionScores.overallAesthetic,
              productVisibility: visionScores.productVisibility,
              photographerQuality: visionScores.photographerQuality,
              summary: visionScores.summary,
            } : null,
            video: videoScores ? {
              stability: videoScores.stability,
              cameraMovement: videoScores.cameraMovement,
              pacing: videoScores.pacing,
              keyframeCoverage: videoScores.keyframeCoverage,
              lightingConsistency: videoScores.lightingConsistency,
              contentClassification: videoScores.contentClassification,
            } : null,
          }), imgInfo.isVideo ? 'video' : 'product',
          score.total, Date.now(), Date.now()
        );

        scoredPosts.push({ score, postUrl, caption, mediaPaths });
      } else {
        console.log(`[content-scraper]   post ${i}: SKIPPED (score ${score.total} < ${MIN_POST_SCORE})`);
      }

      // Close modal
      try { await page.keyboard.press('Escape'); } catch {}
      await page.waitForTimeout(jitter(600, 1500));

    } catch (e: any) {
      console.warn(`[content-scraper]   post ${i} error:`, e?.message?.slice(0, 80));
      try { await page.keyboard.press('Escape'); } catch {}
    }
  }

  // --- Score the artist ---
  const productPosts = scoredPosts.filter(p => p.score.productVisibility >= 20);
  const productRatio = limit > 0 ? productPosts.length / limit : 0;
  const avgLikes = 0, avgComments = 0; // TODO: accumulate from post scores

  // Average tattoo quality from vision scores
  const visionPosts = scoredPosts.filter(p => p.score.visionScores != null);
  const avgTattooQuality = visionPosts.length > 0
    ? visionPosts.reduce((sum, p) => sum + p.score.tattooQuality, 0) / visionPosts.length
    : undefined;

  const artistScore = scoreArtist({
    postCount, avgLikes, avgComments, followers: followerCount,
    productPostRatio: productRatio, cityLabel, avgTattooQuality
  });

  console.log(`[content-scraper] @${handle} artist_score=${artistScore.total}/100 | posts_kept=${scoredPosts.length}/${limit} | prod_ratio=${(productRatio*100).toFixed(0)}% | ${cityLabel || 'no city'}`);

  return { handle, postsScored: scoredPosts.length, artistScore };
};

// ============ Main Loop ============
const mainLoop = async () => {
  console.log('[content-scraper] v2 starting:', { BOT_ID, MIN_POST_SCORE, MIN_ARTIST_SCORE, POSTS_PER_HANDLE });

  if (!fs.existsSync(PRODUCT_DIR)) fs.mkdirSync(PRODUCT_DIR, { recursive: true });

  let consecutiveFailures = 0;

  while (true) {
    try {
      const resp = await getJson('/api/content/competitors');
      const handles: string[] = (resp?.rows || [])
        .filter((r: any) => r.active !== 0)
        .map((r: any) => r.handle);

      if (handles.length === 0) {
        console.log('[content-scraper] no active competitors, waiting...');
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const handle = handles[Math.floor(Math.random() * handles.length)];
      await scrapeProfile(handle);
      consecutiveFailures = 0; // reset on success

      const gapMs = jitter(POLL_INTERVAL_MS, 30000);
      console.log(`[content-scraper] waiting ${Math.round(gapMs / 1000)}s...\n`);
      await sleep(gapMs);

    } catch (e: any) {
      consecutiveFailures++;
      const errMsg = e?.message?.slice(0, 200) || '';
      console.error('[content-scraper] loop error:', errMsg);

      // Browser launch failures: back off aggressively to avoid zombie windows
      if (errMsg.includes('launchPersistentContext') || errMsg.includes('browser has been closed') || errMsg.includes('launch cooldown')) {
        const backoffMs = Math.min(10 * 60 * 1000, consecutiveFailures * 30 * 1000);
        console.log(`[content-scraper] browser error, backoff ${Math.round(backoffMs / 1000)}s (failure #${consecutiveFailures})`);
        await sleep(backoffMs);
      } else {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }
};

const shutdown = async (signal: string) => {
  console.log(`[content-scraper] shutdown on ${signal}`);
  try { if (context) await (context as any).close?.(); } catch {}
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

mainLoop().catch((e) => {
  console.error('[content-scraper] fatal:', e?.message || e);
  db.close();
  process.exit(1);
});
