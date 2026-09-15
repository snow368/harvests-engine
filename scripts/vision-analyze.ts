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
 * - OpenAI 兼容（默认）：DeepSeek / Qwen-VL via DashScope / 任意兼容网关，用 image_url 线格式（服务端拉取远程图）。
 * - Gemini（原生）：BOT_VISION_BASE_URL 含 'googleapis.com' 时自动走 Gemini 原生 inline_data 格式，
 *   用 GOOGLE_API_KEY（或 BOT_VISION_API_KEY）作 query 参数；Gemini 不支持远程 URL 拉图，
 *   故图片需本地下载转 base64 再传。
 */

const VISION_ENABLED = (process.env.BOT_VISION_ENABLED || '0').trim() === '1';
const VISION_BASE = (process.env.BOT_VISION_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const VISION_MODEL = (process.env.BOT_VISION_MODEL || 'deepseek-v4-flash').trim();
const VISION_TIMEOUT_MS = Number(process.env.BOT_VISION_TIMEOUT_MS || '30000');

// 2026-08-31 主备双模型：主模型失败（网络/5xx/超时/返回空）自动切备用模型，
// 两者都不行才返回 null 让调用方降级纯文案。三个变量都配齐才启用备用。
const VISION_FALLBACK_MODEL = (process.env.BOT_VISION_FALLBACK_MODEL || '').trim();
const VISION_FALLBACK_BASE = (process.env.BOT_VISION_FALLBACK_BASE_URL || '').trim();
const VISION_FALLBACK_KEY = (process.env.BOT_VISION_FALLBACK_KEY || '').trim();

// 2026-09-15 A/B 影子对照（评测用）：主模型跑完后，用第二个视觉模型对同一张图再跑一次，
// 结果只进日志、不参与任何决策。用来在真实 IG 图上成对比较 hookUsable / motif 命中率，
// 避免"换模型靠感觉"。三个变量都配齐才启用；删掉 env 即彻底关闭（零额外开销）。
const SHADOW_MODEL = (process.env.BOT_VISION_SHADOW_MODEL || '').trim();
const SHADOW_BASE = (process.env.BOT_VISION_SHADOW_BASE_URL || '').trim();
const SHADOW_KEY = (process.env.BOT_VISION_SHADOW_KEY || '').trim();
const SHADOW_TIMEOUT_MS = Number(process.env.BOT_VISION_SHADOW_TIMEOUT_MS || '30000');

const shadowEnabled = (): boolean => !!SHADOW_MODEL && !!SHADOW_BASE && !!SHADOW_KEY;

export type VisionShadowResult = {
  model: string;
  ms: number;
  ok: boolean;              // 调用是否成功（false = 报错/返回不可解析）
  hookUsable: boolean;
  commentHook: string;
  motif: string;
  placement: string;
  craftNoteCount: number;
  error?: string;
};

const isGemini = (): boolean => VISION_BASE.includes('googleapis.com');

// key 解析：显式 BOT_VISION_API_KEY 优先；否则 Gemini 后端用 GOOGLE_API_KEY，OpenAI 后端用 DEEPSEEK_API_KEY
const VISION_API_KEY = ((): string => {
  if (process.env.BOT_VISION_API_KEY) return process.env.BOT_VISION_API_KEY.trim();
  return (isGemini() ? process.env.GOOGLE_API_KEY : process.env.DEEPSEEK_API_KEY || '').trim();
})();

export type VisionResult = {
  imageType: string;        // tattoo_on_skin | flash_art | studio | portrait | other
  tattooVisible: boolean;
  motif: string;            // 2026-09-15 精准化：图上画的具体名词短语（例 "panther head with rose"）
  subject: string;          // 兼容旧字段 = motif（下游 logBehavior 仍在用）
  subjectConfidence: 'high' | 'medium' | 'low';
  placement: string;        // 2026-09-15：可见的身体部位（inner forearm / sternum...）
  stage: string;            // 2026-09-15：fresh | healed | wip | unknown
  style: string;            // 视觉模型判定的风格（原始字符串）
  styleConfidence: 'high' | 'medium' | 'low';
  craftNotes: string[];     // 2-4 条"同行能注意到的可见工艺事实"
  palette: string;          // 简短配色描述
  commentHook: string;      // 同行看到图最可能脱口而出的 ONE 具体观察（陈述句，非赞美/提问）
  hookUsable: boolean;      // hook 是否通过"具体性"闸门（含空腔调/赞美词则 false）
  raw: string;              // 模型原始输出（截断）
  // 仅当配置 BOT_VISION_SHADOW_* 时存在：第二个模型在同一张图上的对照结果（不参与决策）
  shadow?: VisionShadowResult;
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

// 2026-09-15 精准化重写（用户要求"评论越来越精准"）：
// 旧 prompt 把"题材"当可选项（允许留空）→ qwen-vl-plus 经常交白卷（实测 hook/subject 大量为空、
// subjectConfidence=low），下游只能退回泛泛评语。现在强制三件套必须落地：
//   motif（具体名词）+ placement（身体部位）+ craftNotes（可见工艺事实），
// 并把 commentHook 钉死为「可见名词 + 一个具体工艺/构图事实」的陈述句，带正反例与禁用词表。
const VISION_PROMPT = `You are a working tattoo artist looking at ONE Instagram frame. Report ONLY what is clearly visible. Return ONLY valid JSON, no prose, no markdown:
{"imageType":"tattoo_on_skin|flash_art|studio|portrait|other","tattooVisible":true,"motif":"the most specific noun phrase for WHAT IS DRAWN — always name the literal thing(s), e.g. \\"panther head with a rose\\", \\"raven skull with pocket watch\\", \\"fine-line lavender sprig\\", \\"traditional dagger through a banner\\", \\"blackwork mandala\\". Leave empty ONLY when there is no tattoo in frame or the shape is too blurry to name.","subjectConfidence":"high|medium|low","placement":"the body part the tattoo sits on, e.g. \\"inner forearm\\", \\"outer calf\\", \\"sternum\\", \\"ribcage\\", \\"upper back\\" — empty when not visible","stage":"fresh|healed|wip|unknown","palette":"short palette description, or empty","style":"best-fit tattoo style or OTHER","styleConfidence":"high|medium|low","craftNotes":["0 to 3 specific observable craft facts — each MUST name a real visible property: line weight change, whip-shading direction, dot-gradient density, solid-black packing, negative-space use, symmetry, edge crispness, saturation"],"commentHook":"ONE concrete observation another tattoo artist would actually say out loud about THIS piece. MUST contain a visible NOUN (the motif or the placement) AND one concrete craft or composition fact. Max 12 words. No praise. No question."}
Examples of GOOD commentHook values:
- "the whip shading on that panther's jaw"
- "solid black packing doing the depth behind the rose"
- "that lavender sprig follows the inner forearm line"
- "the dot gradient carries the whole background here"
- "sternum placement sits dead centre on the sternum notch"
Examples of USELESS hooks (never output these):
- "so clean", "crisp linework", "this is fire", "insane detail", "love this piece", "the linework is clean", "amazing work"
Strict evidence rules:
- Describe the TATTOO or flash artwork only. Ignore clothing, room decor, plants, jewelry, background props and skin marks.
- If no tattoo/flash is clearly visible: set tattooVisible=false and leave every other field empty.
- Never invent a motif from a vague blob. If you cannot name it literally, return an empty motif and subjectConfidence=low.
- Use craft words ONLY when that exact property is visible at this resolution. Omit rather than guess.
- BANNED anywhere in the output: clean, crispy, insane, fire, sick, dope, amazing, gorgeous, flawless, perfect, beautiful, "great work", "nice piece", "love this". If the only thing you can say is praise, return an empty commentHook.
- Never praise quality in any field. Report neutral visual facts only.`;

// 空腔调/纯赞美 hook 闸门：命中即判定"这条 hook 没有信息量"，下游当作没有 hook 处理。
// 同时要求至少 3 个词 —— 单词/双词 hook 基本都是空赞美（"clean lines"）。
const HOOK_FLAVOR_RE = /\b(clean|crispy|crisp|fire|sick|dope|insane|amazing|gorgeous|flawless|perfect|beautiful|gorgeous|slaps|beast|hits? different|great work|nice piece|love this|solid work|well done|killing it|fine shyt|insane detail)\b/i;
export const usableHook = (hook?: string): string => {
  const h = String(hook || '').trim();
  if (h.length < 8) return '';
  const words = h.split(/\s+/).filter(Boolean);
  if (words.length < 3) return '';
  if (HOOK_FLAVOR_RE.test(h)) return '';
  if (/[?]$/.test(h)) return '';
  return h;
};

/**
 * 调用视觉模型分析帖子图片。
 * @param imageUrl Instagram 图片 URL（scontent 签名 URL，即时使用不过期）。
 * @returns 结构化观测，或 null（关闭/出错/超时）。
 */
export const analyzePostImage = async (imageUrl: string): Promise<VisionResult | null> => {
  if (!isVisionEnabled() || !imageUrl) return null;
  const primary = await analyzeOnce(imageUrl);
  // 影子模型只在配齐 env 时跑，且跑在主链路之外：结果不参与任何决策、失败静默。
  if (primary && shadowEnabled()) {
    primary.shadow = await runShadowCompare(imageUrl);
    logShadowCompare(primary);
  }
  return primary;
};

// 单次完整识别（主 → 备降级），带整体超时。
const analyzeOnce = async (imageUrl: string): Promise<VisionResult | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    // 分发到具体后端
    if (isGemini()) return await analyzeWithGemini(imageUrl, controller.signal);

    // 2026-08-31 主 → 备：任一成功即返回；都失败才降级纯文案路径
    const attempts: Array<{ base: string; model: string; key: string } | undefined> = [undefined];
    if (VISION_FALLBACK_MODEL && VISION_FALLBACK_BASE && VISION_FALLBACK_KEY) {
      attempts.push({ base: VISION_FALLBACK_BASE, model: VISION_FALLBACK_MODEL, key: VISION_FALLBACK_KEY });
    }
    for (const cfg of attempts) {
      try {
        const result = await analyzeWithOpenAI(imageUrl, controller.signal, cfg);
        if (result) return result;
      } catch {
        // 这个模型失败，换下一个继续
      }
    }
    return null; // 优雅降级：视觉不可用不影响评论主流程
  } finally {
    clearTimeout(timer);
  }
};

// 同一张图用影子模型再跑一遍 —— A/B 评测专用，只产出观测数据。
const runShadowCompare = async (imageUrl: string): Promise<VisionShadowResult> => {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SHADOW_TIMEOUT_MS);
  try {
    const r = await analyzeWithOpenAI(imageUrl, ctrl.signal, {
      base: SHADOW_BASE,
      model: SHADOW_MODEL,
      key: SHADOW_KEY,
    });
    return {
      model: SHADOW_MODEL,
      ms: Date.now() - t0,
      ok: !!r,
      hookUsable: !!r?.hookUsable,
      commentHook: r?.commentHook || '',
      motif: r?.motif || '',
      placement: r?.placement || '',
      craftNoteCount: r?.craftNotes?.length || 0,
    };
  } catch (e: any) {
    return {
      model: SHADOW_MODEL,
      ms: Date.now() - t0,
      ok: false,
      hookUsable: false,
      commentHook: '',
      motif: '',
      placement: '',
      craftNoteCount: 0,
      error: String(e?.message || e).slice(0, 160),
    };
  } finally {
    clearTimeout(timer);
  }
};

// 一行日志同时打主/影结果 → PM2 日志里 grep `[vision_shadow]` 即可逐条对照。
const logShadowCompare = (primary: VisionResult): void => {
  const s = primary.shadow;
  if (!s) return;
  try {
    console.log(`[vision_shadow] ${JSON.stringify({
      primaryModel: VISION_MODEL,
      primaryHookUsable: primary.hookUsable,
      primaryHook: primary.commentHook,
      primaryMotif: primary.motif,
      primaryPlacement: primary.placement,
      primaryCraftNotes: primary.craftNotes.length,
      shadow: s,
    })}`);
  } catch {
    // 日志绝不能把主流程搞崩
  }
};

// 自己先把远程图下载成 base64 data URI，避免依赖视觉服务端去拉图（DashScope 拉远程图常超时
// → "Download multimodal file timed out"，会让视觉在真实环境系统性失效）。下载失败则退回原始 URL。
const downloadImageAsDataUri = async (url: string, ms = 15000): Promise<string | null> => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InkFlowBot/1.0)' },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = (r.headers.get('content-type') || 'image/jpeg').split(';')[0] || 'image/jpeg';
    // 单图上限保护：超过 ~8MB 不再 base64（视觉服务端也通常拒绝），退回 URL 让服务端试拉
    if (buf.length > 8 * 1024 * 1024) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

// OpenAI 兼容后端（Qwen-VL via DashScope / DeepSeek / 任意兼容网关）：优先 base64 data URI，
// 下载失败才退回 image_url 让服务端拉取远程图。
const analyzeWithOpenAI = async (
  imageUrl: string,
  signal: AbortSignal,
  override?: { base: string; model: string; key: string },
): Promise<VisionResult | null> => {
  const base = override?.base || VISION_BASE;
  const model = override?.model || VISION_MODEL;
  const key = override?.key || VISION_API_KEY;
  const dataUri = await downloadImageAsDataUri(imageUrl);
  const imgRef = dataUri || imageUrl; // base64 优先，失败退回远程 URL
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: imgRef } },
          ],
        },
      ],
      temperature: 0.2,
      // 2026-09-15：新增 motif/placement/stage 三个字段后 JSON 变长，300 token 会被截断
      // → 实测出现"返回不完整 JSON → 解析失败 → 整张图当没看懂"。放宽到 500。
      max_tokens: 500,
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
      generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
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

  // 2026-09-15：subject 名改成 motif，同时保留旧字段名（下游 logBehavior 仍在读 subject）
  const motif = String(parsed.motif ?? parsed.subject ?? '').slice(0, 120);
  const stage = String(parsed.stage || 'unknown').toLowerCase();
  const hook = String(parsed.commentHook || '').slice(0, 180);

  return {
    imageType: String(parsed.imageType || 'other').slice(0, 40),
    tattooVisible: parsed.tattooVisible === true,
    motif,
    subject: motif,
    subjectConfidence: String(parsed.subjectConfidence || 'low').toLowerCase() === 'high'
      ? 'high'
      : String(parsed.subjectConfidence || 'low').toLowerCase() === 'medium' ? 'medium' : 'low',
    placement: String(parsed.placement || '').slice(0, 60),
    stage: ['fresh', 'healed', 'wip'].includes(stage) ? stage : 'unknown',
    style: String(parsed.style || '').slice(0, 60),
    styleConfidence,
    craftNotes: Array.isArray(parsed.craftNotes)
      ? parsed.craftNotes.map((x: any) => String(x)).slice(0, 4).map((s: string) => s.slice(0, 140))
      : [],
    palette: String(parsed.palette || '').slice(0, 80),
    commentHook: usableHook(hook), // 空腔调/过短的 hook 直接在此丢弃，下游拿不到 = 不会被写进 prompt
    hookUsable: !!usableHook(hook),
    raw: content.slice(0, 500),
  };
};

/**
 * 把视觉结果压成一段可注入 prompt 的"观测描述"文字。
 */
export const buildVisionDescription = (v: VisionResult): string => {
  if (!v.tattooVisible) return '';
  const parts: string[] = [];
  // 2026-09-08：commentHook 置首 —— 它是视觉模型挑出的"同行最强观察"，评论生成时最值得做开场锚点；
  // 放最前面保证下游 slice 截断时优先保留（下游注入上限已同步放宽到 900 字符）。
  if (v.commentHook) parts.push(`hook: ${v.commentHook}`);
  // 2026-09-15 精准化：把新字段注入观测串，给下游 LLM 更多"可引用的具体素材"。
  // motif 现已强制要求具体名词（上游已截断到 120 字符）；confidence 低时不注入，
  // 避免把一个瞎猜的名词当成事实写进评论。
  if (v.motif && v.subjectConfidence !== 'low') parts.push(`motif: ${v.motif} (${v.subjectConfidence})`);
  if (v.placement) parts.push(`placement: ${v.placement}`);
  if (v.stage && v.stage !== 'unknown') parts.push(`stage: ${v.stage}`);
  if (v.imageType) parts.push(`image type: ${v.imageType}`);
  if (v.craftNotes.length) parts.push(`observed craft: ${v.craftNotes.join('; ')}`);
  if (v.palette) parts.push(`palette: ${v.palette}`);
  if (v.style && v.styleConfidence !== 'low') parts.push(`likely style: ${v.style} (${v.styleConfidence})`);
  return parts.join(' | ');
};
