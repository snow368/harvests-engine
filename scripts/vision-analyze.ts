/**
 * 视觉分析模块 — 把帖子图片交给视觉模型，产出结构化「图观测」文字。
 *
 * 设计原则（与项目 VISION RULE 一致）：
 * - bot 自身无看图能力；这里用视觉模型替它"看"，产出的是一段 TEXT（模型观测到的内容）。
 * - 评论生成器把这段观测当作"别人描述给你听的图内容"来引用 —— 安全（不会编图），
 *   又能做到"文案 + 图片多方面结合"。
 * - 任何失败都返回 null，调用方优雅降级回纯文案路径，绝不编风格/视觉结论。
 *
 * 默认关闭（BOT_VISION_ENABLED=0）。支持两种后端：
 * - OpenAI 兼容（默认）：DeepSeek / 任意兼容网关，用 image_url 线格式（服务端拉取远程图）。
 * - Gemini（原生）：BOT_VISION_BASE_URL 含 'googleapis.com' 时自动走 Gemini 原生 inline_data 格式，
 *   用 GOOGLE_API_KEY（或 BOT_VISION_API_KEY）作 query 参数；Gemini 不支持远程 URL 拉图，
 *   故图片需本地下载转 base64 再传。
 */

const VISION_ENABLED = (process.env.BOT_VISION_ENABLED || '0').trim() === '1';
const VISION_BASE = (process.env.BOT_VISION_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const VISION_MODEL = (process.env.BOT_VISION_MODEL || 'deepseek-v4-flash').trim();
const VISION_TIMEOUT_MS = Number(process.env.BOT_VISION_TIMEOUT_MS || '12000');

const isGemini = (): boolean => VISION_BASE.includes('googleapis.com');

// key 解析：显式 BOT_VISION_API_KEY 优先；否则 Gemini 后端用 GOOGLE_API_KEY，OpenAI 后端用 DEEPSEEK_API_KEY
const VISION_API_KEY = ((): string => {
  if (process.env.BOT_VISION_API_KEY) return process.env.BOT_VISION_API_KEY.trim();
  return (isGemini() ? process.env.GOOGLE_API_KEY : process.env.DEEPSEEK_API_KEY || '').trim();
})();

export type VisionResult = {
  subject: string;          // 图里纹身描绘的题材
  style: string;            // 视觉模型判定的风格（原始字符串）
  styleConfidence: 'high' | 'medium' | 'low';
  craftNotes: string[];     // 2-4 条"同行能注意到的可见工艺事实"（linework/shading/composition/color/negative space）
  palette: string;          // 简短配色描述
  raw: string;              // 模型原始输出（截断）
};

export const isVisionEnabled = (): boolean => VISION_ENABLED && !!VISION_API_KEY;

const safeJsonParse = (text: string, fallback: any): any => {
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
};

const VISION_PROMPT = `You are analyzing a tattoo PHOTO. Return ONLY valid JSON, no prose, no markdown:
{"subject":"what the tattoo depicts, in a few words","style":"best-fit tattoo style — use one of: blackwork, fine line, traditional, neo traditional, new school, japanese, realism, black and grey, color, microrealism, watercolor, dotwork, geometric, tribal, trash polka, illustrative, ornamental, lettering, portrait, surrealism, cover up, linework, minimalist, chicano, anime, or OTHER","styleConfidence":"high if you are confident about the style, medium if uncertain, low if unclear","craftNotes":["2 to 4 specific OBSERVABLE craft facts a fellow tattoo artist would notice, e.g. linework crispness, shading smoothness, composition balance, color saturation, negative space","..."],"palette":"short color description"}
Be factual about what is visible in THIS image. Do not guess beyond what you see.`;

/**
 * 调用视觉模型分析帖子图片。
 * @param imageUrl Instagram 图片 URL（scontent 签名 URL，即时使用不过期）。
 * @returns 结构化观测，或 null（关闭/出错/超时）。
 */
export const analyzePostImage = async (imageUrl: string): Promise<VisionResult | null> => {
  if (!isVisionEnabled() || !imageUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    // 分发到具体后端
    if (isGemini()) return await analyzeWithGemini(imageUrl, controller.signal);
    return await analyzeWithOpenAI(imageUrl, controller.signal);
  } catch {
    return null; // 优雅降级：视觉不可用不影响评论主流程
  } finally {
    clearTimeout(timer);
  }
};

// OpenAI 兼容后端（DeepSeek / 兼容网关）：image_url 让服务端拉取远程图，无需本地下载
const analyzeWithOpenAI = async (imageUrl: string, signal: AbortSignal): Promise<VisionResult | null> => {
  const resp = await fetch(`${VISION_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VISION_API_KEY}`,
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: 300,
    }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`vision ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data: any = await resp.json();
  const content = data?.choices?.[0]?.message?.content || '';
  return parseVisionContent(content);
};

// Gemini 原生后端：inline_data 接受 base64，不支持远程 URL，故先本地下载图转 base64
const analyzeWithGemini = async (imageUrl: string, signal: AbortSignal): Promise<VisionResult | null> => {
  // 1) 下载图片 → base64（可能因 IG 签名过期/403 失败，catch 后降级）
  const imgResp = await fetch(imageUrl, { signal });
  if (!imgResp.ok) throw new Error(`img download ${imgResp.status}`);
  const buf = Buffer.from(await imgResp.arrayBuffer());
  const mime = (imgResp.headers.get('content-type') || 'image/jpeg').split(';')[0] || 'image/jpeg';
  const b64 = buf.toString('base64');

  // 2) 调 Gemini（key 作为 query 参数；不含 Authorization header）
  const url = `${VISION_BASE}/${VISION_MODEL}:generateContent?key=${VISION_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: VISION_PROMPT },
            { inline_data: { mime_type: mime, data: b64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
    }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`gemini ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data: any = await resp.json();
  // Gemini 响应：candidates[0].content.parts[].text
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('');
  if (!content) throw new Error('gemini empty content');
  return parseVisionContent(content);
};

// 统一：把模型返回的文本解析成 VisionResult（JSON 提取 + 归一化）
const parseVisionContent = (content: string): VisionResult | null => {
  const parsed = safeJsonParse(content, null);
  if (!parsed || typeof parsed !== 'object') return null;

  const confRaw = String(parsed.styleConfidence || 'low').toLowerCase();
  const styleConfidence: 'high' | 'medium' | 'low' =
    confRaw === 'high' ? 'high' : confRaw === 'medium' ? 'medium' : 'low';

  return {
    subject: String(parsed.subject || '').slice(0, 120),
    style: String(parsed.style || '').slice(0, 60),
    styleConfidence,
    craftNotes: Array.isArray(parsed.craftNotes)
      ? parsed.craftNotes.map((x: any) => String(x)).slice(0, 4).map((s: string) => s.slice(0, 140))
      : [],
    palette: String(parsed.palette || '').slice(0, 80),
    raw: content.slice(0, 500),
  };
};

/**
 * 把视觉结果压成一段可注入 prompt 的"观测描述"文字。
 */
export const buildVisionDescription = (v: VisionResult): string => {
  const parts: string[] = [];
  if (v.subject) parts.push(`subject: ${v.subject}`);
  if (v.craftNotes.length) parts.push(`observed craft: ${v.craftNotes.join('; ')}`);
  if (v.palette) parts.push(`palette: ${v.palette}`);
  if (v.style && v.styleConfidence !== 'low') parts.push(`likely style: ${v.style} (${v.styleConfidence})`);
  return parts.join(' | ');
};
