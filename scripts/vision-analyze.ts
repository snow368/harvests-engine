/**
 * 视觉分析模块 — 把帖子图片交给视觉模型，产出结构化「图观测」文字。
 *
 * 设计原则（与项目 VISION RULE 一致）：
 * - bot 自身无看图能力；这里用视觉模型替它"看"，产出的是一段 TEXT（模型观测到的内容）。
 * - 评论生成器把这段观测当作"别人描述给你听的图内容"来引用 —— 安全（不会编图），
 *   又能做到"文案 + 图片多方面结合"。
 * - 任何失败都返回 null，调用方优雅降级回纯文案路径，绝不编风格/视觉结论。
 *
 * 默认关闭（BOT_VISION_ENABLED=0），由 VPS 配置决定是否开启 + 走哪个视觉后端。
 * 默认后端 DeepSeek V4 视觉（OpenAI 兼容 image_url 线格式，模型 deepseek-v4-flash），
 * 可通过 BOT_VISION_BASE_URL / BOT_VISION_MODEL 指向 international 端点或任何兼容网关。
 */

const VISION_ENABLED = (process.env.BOT_VISION_ENABLED || '0').trim() === '1';
const VISION_API_KEY = (process.env.BOT_VISION_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
const VISION_BASE = (process.env.BOT_VISION_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const VISION_MODEL = (process.env.BOT_VISION_MODEL || 'deepseek-v4-flash').trim();
const VISION_TIMEOUT_MS = Number(process.env.BOT_VISION_TIMEOUT_MS || '9000');

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
 * @param imageUrl Instagram 图片 URL（scontent 签名 URL，由视觉模型服务端拉取；即时使用不过期）。
 * @returns 结构化观测，或 null（关闭/出错/超时）。
 */
export const analyzePostImage = async (imageUrl: string): Promise<VisionResult | null> => {
  if (!isVisionEnabled() || !imageUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
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
      signal: controller.signal,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      throw new Error(`vision ${resp.status}: ${err.slice(0, 200)}`);
    }

    const data: any = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';
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
  } catch {
    return null; // 优雅降级：视觉不可用不影响评论主流程
  } finally {
    clearTimeout(timer);
  }
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
