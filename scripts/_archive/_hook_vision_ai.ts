/**
 * Hook Vision AI v4 — Relative Performance + Proxy-aware
 *
 * 方法论:
 *   1. 每个账号抓 30-50 帖子建立 baseline
 *   2. Relative Performance = PostLikes / AvgLikes
 *   3. 选 Top RP 帖子 → 封面图 → Gemini Vision → Hook 聚类
 *
 * 网络策略:
 *   - 检测 Windows 系统代理 (127.0.0.1:33210)
 *   - Gemini API 走 curl -x 通过代理
 *   - Relay API (lemonapi) 支持直接传入 CDN URL，Gemini 服务端抓取
 *
 * 用法:
 *   npx tsx scripts/_hook_vision_ai.ts
 *   npx tsx scripts/_hook_vision_ai.ts --handles kwadron,madrabbit
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

// ======================== CONFIG ========================
const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_copy'; // Copied profile (original was locked)
const CANDIDATES_FILE = 'data/competitor_candidates.json';
const OUTPUT_FILE = 'data/hook_analysis.json';
const FRAMES_DIR = 'data/hook_frames';

const GEMINI_KEY = (() => {
  try { const e = fs.readFileSync('.env','utf8'); const m = e.match(/GEMINI_API_KEY=(.+)/); return m ? m[1].trim():''; } catch { return ''; }
})();
const GEMINI_MODEL = 'gemini-2.0-flash-001';

// Relay API (OpenAI-compatible proxy for Gemini in China)
const RELAY_BASE_URL = (() => {
  try { const e = fs.readFileSync('.env','utf8'); const m = e.match(/RELAY_BASE_URL=(.+)/); return m ? m[1].trim():''; } catch { return ''; }
})();
const RELAY_MODEL = (() => {
  try { const e = fs.readFileSync('.env','utf8'); const m = e.match(/RELAY_MODEL=(.+)/); return m ? m[1].trim():''; } catch { return ''; }
})();
const RELAY_KEY = (() => {
  try { const e = fs.readFileSync('.env','utf8'); const m = e.match(/RELAY_API_KEY=(.+)/); return m ? m[1].trim():''; } catch { return ''; }
})();

// SiliconFlow (China, Qwen3-VL)
const SILICON_KEY = 'sk-xmb...jtzt';
const SILICON_MODEL = 'Qwen/Qwen3-VL-32B-Thinking';
const SILICON_BASE = 'https://api.siliconflow.cn/v1';

// Agnes Vision (agnes-image-2.0-flash / 2.1-flash, OpenAI-compatible)
const AGNES_BASE_URL = (() => {
  try { const e = fs.readFileSync('.env','utf8'); const m = e.match(/AGNES_BASE_URL=(.+)/); return m ? m[1].trim():''; } catch { return ''; }
})();
const AGNES_MODEL = (() => {
  try { const e = fs.readFileSync('.env','utf8'); const m = e.match(/AGNES_VISION_MODEL=(.+)/); return m ? m[1].trim():''; } catch { return 'agnes-image-2.0-flash'; }
})();
const AGNES_KEY = (() => {
  try { const e = fs.readFileSync('.env','utf8'); const m = e.match(/AGNES_API_KEY=(.+)/); return m ? m[1].trim():''; } catch { return ''; }
})();

const COLLECT_TARGET = 60;
const MAX_SCROLLS = 60;
const TOP_RP_COUNT = 5;
const PRODUCT_TOP_RP_COUNT = 10;  // 针/墨水/机器品牌适当多分析，确保覆盖产品图
const PRODUCT_BRAND_CATS = ['needles_cartridges', 'ink', 'machines_pens', 'aftercare'];
const RP_MIN_LIKES = 5;
const TIMEOUT = 30000;

/** Caption patterns to exclude from analysis (saves API calls for irrelevant content) */
const SKIP_CAPTION_PATTERNS = [
  // Promotional / sales
  /\b(?:available\s+(?:this|now|friday)|link\s+in\s+bio|shop\s+now|limited|sale|discount|last\s+call|buck\s+up|save\s+\d+%)\b/i,
  // Interview / lifestyle
  /\b(?:artist\s+spotlight|family\s+artist|in\s+conversation|meet\s+(?:the\s+)?artist|behind\s+the\s+scenes)\b/i,
  // Events / conventions
  /\b(?:tattoo\s+(?:convention|expo|show)|come\s+see\s+us|godsofink|nyempirestate)\b/i,
  // Giveaway / contest
  /\b(?:giveaway|contest|win\s+a|tag\s+a\s+friend|raffle)\b/i,
  // Shoutout / thank you
  /\b(?:thank\s+you|thanks\s+for|shoutout|honored)\b/i,
  // Pure repost / no caption (just usernames)
  /^(?:[\s@.\w]+\s)*[\s@.\w]+$/,
];

// ======================== HOOK LABELS ========================
const HOOK_LABELS = [
  'needle_macro','skin_texture','machine_closeup','black_background',
  'wipe_shot','artist_face','finished_result','dramatic_zoom',
  'setup_process','tutorial_demo','before_after','lifestyle',
  'ink_flow','color_saturation','bottle_macro',
  'machine_sound','grip_closeup','hand_motion',
  'skin_entry','line_precision','wipe_reveal',
  'other',
] as const;
type HookLabel = typeof HOOK_LABELS[number];

// Content type hierarchy
const CONTENT_TYPES = [
  'finished_tattoo',   // 成品纹身展示
  'product_shot',      // 产品本身展示（针/墨水/机器等）
  'process_shot',       // 纹身操作过程
  'lifestyle',         // 工作室环境/日常生活
  'promotional',       // 营销推广/活动/折扣
] as const;

const PRODUCT_CATEGORIES = [
  'needle',            // 纹身针（RL圆针、RS排针、M1/M2、magnum等）
  'cartridge',         // 针嘴/针头/cartridge
  'machine',           // 纹身机器
  'ink',               // 墨水/色料
  'grip',              // 手柄
  'power_supply',      // 电源
  'paper',             // 转印纸/其他耗材
  'other_accessory',   // 其他配件
] as const;

type ContentType = typeof CONTENT_TYPES[number];
type ProductCategory = typeof PRODUCT_CATEGORIES[number];

interface VisionResult {
  contentType: ContentType;
  productCategory: ProductCategory | null;
  productDetail: string;
  needleSpec: NeedleSpec | null;
  cartridgeDetect: CartridgeDetect | null;
  packaging: string;       // 包装描述（瓶身/盒子/罐子设计，颜色，材质等）
  cartridgeColor: string; // 针头外壳配色: black_gold/translucent_blue/translucent_pink/translucent_purple/clear/rainbow/white/other
  membraneType: string;   // 膜类型: white_standard/clear_thin/silicone_high/none_visible/unknown
  connectionType: string; // 连接方式: screw_long/screw_short/bayonet/magnetic/push_fit/unknown
  packagingFormat: string; // 包装形式: individual_blister/multi_blister/box_set/loose_display/bulk_tray/unknown
  needleBrandPrediction: string; // 品牌预测: kwadron/cheyenne/bigwasp/blackclaw/dragonhawk/unknown
  needleTypeDetected: string; // 针型检测: RL/RS/RM/M1/CM/F/Bugpin/OpenLiner/unknown
  flowChannelVisible: string; // 流道可见性: yes_wide_gap/yes_tight_gap/yes_moderate_gap/no_opaque_housing/unknown
  internalTaperVisible: string; // 内锥角度: steep_angle/shallow_angle/multi_stage/not_visible/unknown
  hook: HookLabel;
  confidence: number;
  reasoning: string;
  emotion: string;
  style: string;
  audio: string;      // 可见的音乐信息（封面歌名/艺人），空串=未知
  technique: string;   // 针法推测: shading/pack/line/pointillism/realism/color_pack/unknown
  tattooStyle: string;  // 纹身风格: realism/traditional/blackwork/geometric/dotwork/watercolor/japanese/neotrad/trash_polka/lettering/unknown
  placement: string;    // 纹身部位: full_sleeve/half_sleeve/forearm/upper_arm/leg/thigh/calf/back/chest/ribs/hand/neck/face/other
  colorScheme: string;  // 配色: black_grey/color/watercolor/negative_space/selective_color
  size: string;         // 大小: micro/small/medium/large/full
  skinTone: string;     // 肤色适配: fair/medium/olive/dark/black/unknown
  photoQuality: string; // 拍摄质量: studio/professional/phone_good/phone_average/phone_blurry
  healingStage: string; // 愈合阶段: fresh/healing/fully_healed/unknown
  lineQuality: string;      // 线条功底: crisp/uneven/masterful/geometric_precision
  saturationLevel: string;  // 饱和度: low/medium/high/dense
  designComplexity: string; // 设计复杂度: simple/moderate/complex/masterpiece
  colorPalette: string;     // 色彩体系: warm/cool/neutral/monochrome/complementary/contrasting
  contrastLevel: string;    // 对比度: low/medium/high
  compositionQuality: string; // 构图: weak/balanced/strong/masterful
  anatomyAccuracy: string;  // 解剖: poor/fair/good/excellent
  shadingTechnique: string; // 素描功底: smooth/stippled/crosshatch/dynamic
  lightingStyle: string;    // 光影: flat/natural/dramatic/artistic
  perspective: string;      // 透视: flat/basic/advanced
}

interface NeedleSpec {
  gauge: string;      // "08" | "10" | "12" | "14"
  gaugeMm: string;    // 换算后直径
  count: string;      // 针数
  type: string;       // RL/RS/M1/CM/F/Bugpin etc
  typeName: string;   // 全称
  taper: string | null;  // ST/MT/LT/XLT
}

interface CartridgeDetect {
  cartridgeColor: string;     // black_gold / translucent_blue / clear / metal / etc
  membraneType: string;       // white_standard / clear_thin / silicone_high / none_visible / unknown
  connectionType: string;     // screw_long / screw_short / bayonet / magnetic / push_fit / unknown
  packagingFormat: string;    // individual_blister / multi_blister / box_set / loose_display / bulk_tray / unknown
  brandPrediction: string;    // kwadron / cheyenne / bigwasp / blackclaw / dragonhawk / unknown
  brandConfidence: string;    // high / medium / low
  needleTypeFromTip: string;  // RL / RS / RM / M1 / CM / F / Bugpin / OpenLiner / unknown
  estimatedCount: string;     // estimated needle count from tip inspection, "unknown" if not visible
}

const EMPTY_RESULT: VisionResult = {
  contentType: 'finished_tattoo',
  productCategory: null,
  productDetail: '',
  needleSpec: null,
  cartridgeDetect: null,
  packaging: '',
  cartridgeColor: '',
  membraneType: '',
  connectionType: '',
  packagingFormat: '',
  needleBrandPrediction: '',
  needleTypeDetected: '',
  flowChannelVisible: '',
  internalTaperVisible: '',
  audio: '',
  technique: '',
  tattooStyle: '',
  placement: '',
  colorScheme: '',
  size: '',
  skinTone: '',
  photoQuality: '',
  healingStage: '',
  lineQuality: '',
  saturationLevel: '',
  designComplexity: '',
  colorPalette: '',
  contrastLevel: '',
  compositionQuality: '',
  anatomyAccuracy: '',
  shadingTechnique: '',
  lightingStyle: '',
  perspective: '',
  hook: 'other',
  confidence: 0,
  reasoning: '',
  emotion: 'unknown',
  style: 'unknown',
};

// ======================== PROXY DETECTION ========================
const COMMON_PORTS = [33210, 7890, 10809, 1081, 1080, 8080, 3128];

function getProxy(): string | null {
  const cliArg = process.argv.find(a => a.startsWith('--proxy='));
  if (cliArg) return cliArg.split('=')[1];

  try {
    const out = execSync(
      `reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable 2>nul && reg query "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer 2>nul`,
      { encoding: 'utf8', timeout: 5000 }
    );
    const enabled = out.match(/ProxyEnable\s+REG_DWORD\s+0x([01])/);
    const server = out.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    if (enabled && enabled[1] === '1' && server) {
      return server[1].trim();
    }
  } catch {}

  if (process.env.HTTPS_PROXY) return process.env.HTTPS_PROXY;
  if (process.env.HTTP_PROXY) return process.env.HTTP_PROXY;

  for (const port of COMMON_PORTS) {
    try {
      const r = execSync(
        `curl -s --connect-timeout 2 -x "http://127.0.0.1:${port}" "http://www.gstatic.com/generate_204" 2>nul`,
        { encoding: 'utf8', timeout: 5000 }
      );
      if (r !== null) return `http://127.0.0.1:${port}`;
    } catch {}
  }
  return null;
}

function testGeminiReachable(): boolean {
  if (!PROXY) return false;
  try {
    const r = execSync(
      `curl -s --connect-timeout 10 --max-time 15 -x "${PROXY}" "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-001:generateContent?key=${GEMINI_KEY}" -H "Content-Type: application/json" -d '{"contents":[{"parts":[{"text":"ok"}]}]}'`,
      { encoding: 'utf8', timeout: 20000 }
    );
    if (r.includes('RESOURCE_EXHAUSTED') || r.includes('quota')) {
      console.log('  ⚠️  Gemini quota exceeded (429). Try again later or use a different key.');
      return false;
    }
    if (r.includes('candidates')) return true;
    if (r.includes('"error"')) return false;
    return true;
  } catch {
    return false;
  }
}

const PROXY = getProxy();

// ======================== HELPERS ========================
const jitter = (a: number, b: number) => Math.floor(Math.random()*(b-a+1))+a;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function b64(filePath: string): string | null {
  try {
    const d = fs.readFileSync(filePath);
    return d.toString('base64');
  } catch { return null; }
}

function isRef<T>(arr: readonly T[], v: unknown): v is T {
  return arr.includes(v as T);
}

const GAUGE_MAP: Record<string,string> = { '06':'0.20mm','08':'0.25mm','10':'0.30mm','12':'0.35mm','14':'0.40mm' };
const NEEDLE_TYPE_NAMES: Record<string,string> = {
  'RL':'Round Liner','RS':'Round Shader','RM':'Round Magnum',
  'M1':'Magnum','CM':'Curved Magnum','F':'Flat',
  'Bugpin':'Bugpin','Stacked':'Stacked Magnum','SEM':'Soft Edge Magnum',
  'TRL':'Turbo Round Liner','OpenLiner':'Open Liner'
};
const TAPER_NAMES: Record<string,string> = {
  'ST':'Short Taper 1.5mm','MT':'Medium Taper 2.5-3.5mm',
  'LT':'Long Taper 5-7mm','XLT':'Extra Long Taper 8mm+'
};

/** Parse productDetail string into structured NeedleSpec if format matches */
function parseNeedleSpec(detail: string): NeedleSpec | null {
  if (!detail) return null;
  // Standard format: 1003RL_LT  or  1207M1_MT  or  0807CM_XLT
  const m = detail.match(/^(\d{2})(\d{2})([A-Za-z]+)(?:_([A-Za-z]+))?$/);
  if (m) {
    const gauge = m[1], count = m[2], type = m[3].toUpperCase(), taper = m[4]?.toUpperCase() || null;
    if (GAUGE_MAP[gauge]) {
      return {
        gauge, gaugeMm: GAUGE_MAP[gauge],
        count, type, typeName: NEEDLE_TYPE_NAMES[type] || type,
        taper: taper && TAPER_NAMES[taper] ? taper : null,
      };
    }
  }
  // Bugpin format: bugpin_1005RL
  const bm = detail.match(/^bugpin_(\d{2})(\d{2})([A-Za-z]+)(?:_([A-Za-z]+))?$/i);
  if (bm) {
    const gauge = bm[1], count = bm[2], type = 'Bugpin', taper = bm[4]?.toUpperCase() || null;
    return {
      gauge, gaugeMm: GAUGE_MAP[gauge] || 'unknown',
      count, type, typeName: `Bugpin ${NEEDLE_TYPE_NAMES[bm[3].toUpperCase()] || bm[3]}`,
      taper: taper && TAPER_NAMES[taper] ? taper : null,
    };
  }
  // Cheyenne Open Liner format: cheyenne_openliner_L
  const om = detail.match(/^(cheyenne_)?openliner_([A-Z]+)$/i);
  if (om) {
    return {
      gauge: '', gaugeMm: '', count: '', type: 'OpenLiner',
      typeName: `Open Liner size ${om[2].toUpperCase()}`,
      taper: null,
    };
  }
  return null;
}

function parseVision(text: string): VisionResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { ...EMPTY_RESULT, reasoning: 'no_json' };
  try {
    const p = JSON.parse(m[0]);
    const productDetail = typeof p.productDetail === 'string' ? p.productDetail : '';
    const cartridgeColor = typeof p.cartridgeColor === 'string' ? p.cartridgeColor : '';
    const membraneType = typeof p.membraneType === 'string' ? p.membraneType : '';
    const connectionType = typeof p.connectionType === 'string' ? p.connectionType : '';
    const packagingFormat = typeof p.packagingFormat === 'string' ? p.packagingFormat : '';
    const needleTypeDetected = typeof p.needleTypeDetected === 'string' ? p.needleTypeDetected : '';
    const needleBrandPrediction = typeof p.needleBrandPrediction === 'string' ? p.needleBrandPrediction : '';
    const flowChannelVisible = typeof p.flowChannelVisible === 'string' ? p.flowChannelVisible : '';
    const internalTaperVisible = typeof p.internalTaperVisible === 'string' ? p.internalTaperVisible : '';

    // Build CartridgeDetect if any cartridge-level data is available
    let cartridgeDetect: CartridgeDetect | null = null;
    if (cartridgeColor || membraneType || connectionType || packagingFormat || needleTypeDetected || needleBrandPrediction) {
      cartridgeDetect = {
        cartridgeColor: cartridgeColor || 'unknown',
        membraneType: membraneType || 'unknown',
        connectionType: connectionType || 'unknown',
        packagingFormat: packagingFormat || 'unknown',
        brandPrediction: needleBrandPrediction || 'unknown',
        brandConfidence: 'unknown',
        needleTypeFromTip: needleTypeDetected || 'unknown',
        estimatedCount: 'unknown',
      };
    }

    return {
      contentType: isRef(CONTENT_TYPES, p.contentType) ? p.contentType : 'finished_tattoo',
      productCategory: p.productCategory === null ? null : (isRef(PRODUCT_CATEGORIES, p.productCategory) ? p.productCategory : null),
      productDetail,
      needleSpec: productDetail ? parseNeedleSpec(productDetail) : null,
      cartridgeDetect,
      packaging: typeof p.packaging === 'string' ? p.packaging : '',
      cartridgeColor,
      membraneType,
      connectionType,
      packagingFormat,
      needleBrandPrediction,
      needleTypeDetected,
      flowChannelVisible,
      internalTaperVisible,
      audio: typeof p.audio === 'string' ? p.audio : '',
      technique: typeof p.technique === 'string' ? p.technique : '',
      tattooStyle: typeof p.tattooStyle === 'string' ? p.tattooStyle : '',
      placement: typeof p.placement === 'string' ? p.placement : '',
      colorScheme: typeof p.colorScheme === 'string' ? p.colorScheme : '',
      size: typeof p.size === 'string' ? p.size : '',
      skinTone: typeof p.skinTone === 'string' ? p.skinTone : '',
      photoQuality: typeof p.photoQuality === 'string' ? p.photoQuality : '',
      healingStage: typeof p.healingStage === 'string' ? p.healingStage : '',
      lineQuality: typeof p.lineQuality === 'string' ? p.lineQuality : '',
      saturationLevel: typeof p.saturationLevel === 'string' ? p.saturationLevel : '',
      designComplexity: typeof p.designComplexity === 'string' ? p.designComplexity : '',
      colorPalette: typeof p.colorPalette === 'string' ? p.colorPalette : '',
      contrastLevel: typeof p.contrastLevel === 'string' ? p.contrastLevel : '',
      compositionQuality: typeof p.compositionQuality === 'string' ? p.compositionQuality : '',
      anatomyAccuracy: typeof p.anatomyAccuracy === 'string' ? p.anatomyAccuracy : '',
      shadingTechnique: typeof p.shadingTechnique === 'string' ? p.shadingTechnique : '',
      lightingStyle: typeof p.lightingStyle === 'string' ? p.lightingStyle : '',
      perspective: typeof p.perspective === 'string' ? p.perspective : '',
      hook: isRef(HOOK_LABELS, p.hook) ? p.hook : 'other',
      confidence: typeof p.confidence === 'number' ? p.confidence : 0,
      reasoning: p.reasoning || '',
      emotion: p.emotion || 'unknown',
      style: p.style || 'unknown',
    };
  } catch { return { ...EMPTY_RESULT, reasoning: 'parse_fail' }; }
}
const VISION_PROMPT = `

=== 填写原则（重要）===
1. **按内容类型区分该填什么**：
  - finished_tattoo → 所有纹身评估字段认真填（technique/tattooStyle/placement/colorScheme/size/healingStage/lineQuality/saturationLevel/designComplexity/anatomyAccuracy/shadingTechnique）
  - process_shot → technique 认真填，成品评估字段留空
  - lifestyle / promotional → compositionQuality/lightingStyle/perspective/colorPalette/contrastLevel/photoQuality 认真填，纹身专有字段留空
  - product_shot → productCategory/productDetail/packaging/cartridgeColor 认真填，纹身字段留空
2. **不适用就留空串 ""**，不要填无意义的值
3. **reasoning 写具体观察**：「你看到了什么 → 推断结论」
4. **仔细看 caption**，有时图片模糊但文案说了是什么产品/针型

=== 输出示例 ===
finished_tattoo: {"contentType":"finished_tattoo","productCategory":null,"productDetail":"","hook":"finished_result","confidence":0.9,"reasoning":"前臂写实肖像，光影层次丰富，灰阶过渡自然→风格realism，技法shading","emotion":"prestige","style":"high_contrast","audio":"","technique":"shading","tattooStyle":"realism","placement":"forearm","colorScheme":"black_grey","size":"medium","skinTone":"olive","photoQuality":"phone_good","healingStage":"fully_healed","lineQuality":"masterful","saturationLevel":"high","designComplexity":"complex","colorPalette":"monochrome","contrastLevel":"high","compositionQuality":"strong","anatomyAccuracy":"excellent","shadingTechnique":"smooth","lightingStyle":"dramatic","perspective":"advanced","packaging":"","cartridgeColor":""}
lifestyle: {"contentType":"lifestyle","productCategory":null,"productDetail":"","hook":"lifestyle","confidence":0.85,"reasoning":"高对比黑白调，工作台散落设备→工作室日常","emotion":"satisfying","style":"high_contrast","audio":"","technique":"","tattooStyle":"","placement":"","colorScheme":"monochrome","size":"","skinTone":"unknown","photoQuality":"phone_average","healingStage":"","lineQuality":"","saturationLevel":"high","designComplexity":"","colorPalette":"monochrome","contrastLevel":"high","compositionQuality":"balanced","anatomyAccuracy":"","shadingTechnique":"","lightingStyle":"dramatic","perspective":"basic","packaging":"","cartridgeColor":""}
product_shot_needle: {"contentType":"product_shot","productCategory":"needle","productDetail":"1003RL_LT","hook":"needle_macro","confidence":0.9,"reasoning":"针头微距，黑色外壳金色标签→Kwadron RL 10号0.30mm 3针长taper","emotion":"satisfying","style":"dark_mood","audio":"","technique":"","tattooStyle":"","placement":"","colorScheme":"monochrome","size":"","skinTone":"","photoQuality":"studio","healingStage":"","lineQuality":"","saturationLevel":"","designComplexity":"","colorPalette":"neutral","contrastLevel":"high","compositionQuality":"balanced","anatomyAccuracy":"","shadingTechnique":"","lightingStyle":"dramatic","perspective":"basic","packaging":"黑色磨砂针头+金色标签环+塑料密封盒","cartridgeColor":"black_gold"}
promotional: {"contentType":"promotional","productCategory":null,"productDetail":"","hook":"lifestyle","confidence":0.8,"reasoning":"展位横幅+brand logo墙+多人围观→品牌推广活动现场","emotion":"prestige","style":"bright_clean","audio":"","technique":"","tattooStyle":"","placement":"","colorScheme":"color","size":"","skinTone":"unknown","photoQuality":"phone_good","healingStage":"","lineQuality":"","saturationLevel":"high","designComplexity":"","colorPalette":"warm","contrastLevel":"medium","compositionQuality":"balanced","anatomyAccuracy":"","shadingTechnique":"","lightingStyle":"natural","perspective":"basic","packaging":"","cartridgeColor":""}

第一层 — 内容类型（contentType）:
- finished_tattoo: 成品纹身展示（已完成的作品，无操作过程）
- product_shot: 产品本身展示（针/墨水/机器等产品的特写或陈列）
- process_shot: 纹身操作过程（正在纹身、擦拭、准备等）
- lifestyle: 工作室环境/日常生活/幕后花絮
- promotional: 营销推广/活动/折扣/合作宣传/比赛

productCategory（仅 contentType=product_shot 时有值，否则 null）:
- needle: 纹身针（包括针头/cartridge中的针）
- cartridge: 针嘴/针头/cartridge外壳
- machine: 纹身机器/笔
- ink: 墨水/色料瓶
- grip: 手柄
- power_supply: 电源/适配器
- paper: 转印纸/耗材
- other_accessory: 其他配件

productDetail（格式标准）:
当 productCategory=needle 时，尽量识别出具体规格，格式：{gauge}{count}{type}_{taper}
- gauge: 08(0.25mm) / 10(0.30mm) / 12(0.35mm) / 14(0.40mm)
- count: 针的数量（1/3/5/7/9/11/14等）
- type: RL(勾线) / RS(shading) / M1(平马格南上色) / CM(弧形马格南) / F(平针) / Bugpin(超细) / OpenLiner(宽平行针)
- taper: ST(短) / MT(中) / LT(长) / XLT(特长)

packaging（仅 product_shot 时填写）: 描述产品包装设计

品牌识别 — 针/cartridge（抓取 cartridgeColor）:
- Kwadron: 黑色+金色标签 → black_gold
- Cheyenne: 半透明彩色外壳 → translucent_blue/pink/purple
- BigWasp: 透明外壳 Gen 3 → clear
- BlackClaw: 金属/黑色阳极氧化 → black/metal
- TATSoul: 透明+彩色标签环 → clear
- CNC: 黑色 → black | MagicMoon: 磨砂 → frosted
- Dragonhawk: 彩色阳极氧化 → rainbow
- FK Irons: 白/黑 → white/black | Bishop: 白 → white | Stigma: 透明 → clear

墨水品牌: Dynamic(白瓶红标)/Eternal(矮胖深色)/Panthera(黑磨砂金标)/World Famous(骷髅logo)/Intenze(方瓶小圆标)/Starbrite(黑白瓶)/Radiant Colors(彩虹环)/Unistar(黑瓶彩色块)/Wormhole(白/银瓶)

机器品牌: FK Irons(Spektra Xion/Flux/ONE) / Cheyenne(Hawk/Sol Nova/Thunder) / Bishop Rotary(Wand/Power Wand/Packer) / Kwadron Equalizer / Dragonhawk / Vlad Blad / Peak

cartridgeColor 取值: black_gold/black/white/clear/translucent_blue/translucent_pink/translucent_purple/frosted/rainbow/metal/other
注意膜类型(membrane)、连接方式(connection)、外壳设计特征

Hook类型: needle_macro/skin_texture/machine_closeup/black_background/wipe_shot/artist_face/finished_result/dramatic_zoom/setup_process/tutorial_demo/before_after/lifestyle/ink_flow/color_saturation/bottle_macro/machine_sound/grip_closeup/hand_motion/skin_entry/line_precision/wipe_reveal/other

emotion: prestige/underground/luxury/satisfying/educational/trendy/funny
style: dark_mood/bright_clean/high_contrast/soft_natural/colorful/minimal
audio: 歌名+艺人名，仅Reel且可见音乐信息时填写，否则留空

technique: shading/pack/line/pointillism/realism/color_pack（不含纹身内容留空）
tattooStyle: realism/traditional/blackwork/geometric/dotwork/watercolor/japanese/neotrad/trash_polka/lettering
placement: full_sleeve/half_sleeve/forearm/upper_arm/leg/thigh/calf/back/chest/ribs/hand/neck/face/other
colorScheme: black_grey/color/watercolor/negative_space/selective_color
size: micro/small/medium/large/full
skinTone: fair/medium/olive/dark/black/unknown
photoQuality: studio/professional/phone_good/phone_average/phone_blurry
healingStage: fresh/healing/fully_healed/unknown
lineQuality: crisp/uneven/masterful/geometric_precision
saturationLevel: low/medium/high/dense
designComplexity: simple/moderate/complex/masterpiece
colorPalette: warm/cool/neutral/monochrome/complementary/contrasting
contrastLevel: low/medium/high
compositionQuality: weak/balanced/strong/masterful
anatomyAccuracy: poor/fair/good/excellent
shadingTechnique: smooth/stippled/crosshatch/dynamic
lightingStyle: flat/natural/dramatic/artistic
perspective: flat/basic/advanced

返回 JSON 格式，该填的填，不适用留空串，不准省略任何字段。



===== NEEDLE/CARTRIDGE GRANULARITY DETECTION (新增字段) =====
当 productCategory=needle 或 cartridge 时，提取以下视觉特征字段：

--- 针型识别（从针尖形状，微距/特写可见）---
RL = 圆形紧排列汇聚成一点 / RS = 圆形松排列有小间隙
RM = 圆形介于RL和RS之间 / M1 = 两排平列扁平椭圆形
CM = 弧形排列比M1平滑 / F = 单排直线排列
Bugpin = 针明显比普通针细 (<0.30mm)
OpenLiner = 平行不聚拢宽排列(Cheyenne特有)

--- 品牌识别（从外壳颜色，高置信度线索）---
黑+金色标签环 = Kwadron（高置信度）
半透明蓝 = Cheyenne Safety / 半透明粉 = Cheyenne Craft / 半透明紫 = Cheyenne Capillary
透明壳 = BigWasp/TATSoul/Stigma（需标签区分）
金属/彩虹金属 = BlackClaw / 彩色阳极氧化 = Dragonhawk
纯黑壳(无金标签) = CNC / 磨砂壳 = MagicMoon / 白壳 = FK Irons 贴牌

--- 膜识别（从针壳底部，侧视/俯视可见）---
白色不透明橡胶 = 标准膜 / 透明薄膜 = Kwadron 特色
白色半透明硅胶 = Cheyenne Safety 高性能膜

--- 包装形式 ---
独立泡壳(高端) / 多联泡壳(性价比) / 盒装(套装) / 散装(批量)

--- 输出新增字段（独立于 productDetail）---
- "cartridgeColor": "black_gold/translucent_blue/translucent_pink/translucent_purple/clear/metal/rainbow/black/frosted/white/other"
- "membraneType": "white_standard/clear_thin/silicone_high/none_visible/unknown"
- "connectionType": "screw_long/screw_short/bayonet/magnetic/push_fit/unknown"
- "packagingFormat": "individual_blister/multi_blister/box_set/loose_display/bulk_tray/unknown"
- "needleTypeDetected": "RL/RS/RM/M1/CM/F/Bugpin/OpenLiner/unknown"
- "needleBrandPrediction": "kwadron/cheyenne/bigwasp/blackclaw/dragonhawk/tatsoul/cnc/magicmoon/unknown"
不确定的字段填 "unknown"，不要编造。

--- 膜/流道识别（从针壳底部和侧面，决定出墨特性）---
流道 = 内径间隙 + 内锥角度，决定墨水流速和集中度

膜类型（从针壳底部看）:
- 白色不透明橡胶膜 = 标准膜，通用兼容
- 透明薄膜 = Kwadron Hybrid 特色膜，回弹好
- 白色半透明硅胶膜 = Cheyenne Safety 高性能膜，ISO 13485

内径间隙（从侧面看针束与壳壁空隙，需要透明/半透明壳）:
- 间隙大 → 墨水流速快、出墨足，适合 M1/CM 大面积上色（但可能飞墨）
- 间隙小 → 墨水流速慢、出墨精准，适合 RL 精细勾线（但可能供墨不足）
- 间隙适中 → 均衡兼顾

内锥角度（从侧面看壳尖端内部收口角度，需要透明壳）:
- 大角度内锥 → 墨水集中针尖，适合 RL/RS 精细控制
- 平缓/小角度内锥 → 墨水分散广，适合 M1/CM 大面积填充
- 多段式内锥 → 前端集中+后端增速复合设计（高端品牌特色，如 Kwadron Hybrid）

透明/半透明壳才能观察流道。金属壳（BlackClaw）无法直接看流道。

--- 输出新增字段补充 ---
- "membraneType": "white_standard/clear_thin/silicone_high/none_visible/unknown"
- "flowChannelVisible": "yes_wide_gap/yes_tight_gap/yes_moderate_gap/no_opaque_housing/unknown"
- "internalTaperVisible": "steep_angle/shallow_angle/multi_stage/not_visible/unknown"
`;
function geminiCurl(imageB64: string, caption: string): VisionResult {
  const body = JSON.stringify({
    contents: [{ parts: [
      { text: VISION_PROMPT + (caption ? "\nCaption: " + caption.slice(0,1000) : "") },
      { inline_data: { mime_type: "image/jpeg", data: imageB64 } }
    ] }]
  });

  const proxyFlag = PROXY ? `-x "${PROXY}"` : "";
  const cmd = `curl -s --connect-timeout 15 --max-time 25 ${proxyFlag} "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}" -H "Content-Type: application/json" -d @-`;



  try {
    const proc = execSync(cmd, { input: body, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 10 * 1024 * 1024, shell: true });
    return parseVision(proc || '');
  } catch (e: any) {
    const msg = e.message?.slice(0, 80) || 'unknown error';
    if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) return { ...EMPTY_RESULT, reasoning: 'timeout' };
    if (msg.includes('ENOTFOUND') || msg.includes('resolve')) return { ...EMPTY_RESULT, reasoning: 'dns_fail' };
    return { ...EMPTY_RESULT, reasoning: msg };
  }
}

// ======================== VISION API VIA RELAY (OpenAI-compatible) ========================
function visionViaRelay(imageUrlOrB64: string, caption: string, isUrl: boolean): VisionResult {
  if (!RELAY_BASE_URL || !RELAY_KEY || !PROXY) return { ...EMPTY_RESULT, reasoning: 'no_relay_config' };

  const imageUrl = isUrl ? imageUrlOrB64 : `data:image/jpeg;base64,${imageUrlOrB64}`;
  const body = JSON.stringify({
    model: RELAY_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROMPT + (caption ? `\nCaption: ${caption.slice(0,1000)}` : '') },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }],
    max_tokens: 2048,
    temperature: 0.3,
  });

  const proxyFlag = PROXY ? `-x "${PROXY}"` : '';
  const cmd = `curl -s --connect-timeout 20 --max-time 40 ${proxyFlag} "${RELAY_BASE_URL}/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer ${RELAY_KEY}" -d @-`;

  try {
    const proc = execSync(cmd, { input: body, encoding: 'utf8', timeout: 60000, maxBuffer: 10 * 1024 * 1024, shell: true });
    const text = proc || '';
    const parsed = JSON.parse(text);
    const content = parsed?.choices?.[0]?.message?.content || '';
    if (!content) return { ...EMPTY_RESULT, reasoning: 'empty_response' };
    return parseVision(content);
  } catch (e: any) {
    const msg = e.message?.slice(0, 80) || 'unknown error';
    if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) return { ...EMPTY_RESULT, reasoning: 'timeout' };
    return { ...EMPTY_RESULT, reasoning: msg };
  }
}

// ======================== VISION API VIA SILICONFLOW (Qwen3-VL) ========================
function visionViaSiliconFlow(imageB64: string, caption: string): VisionResult {
  if (!SILICON_KEY) return { ...EMPTY_RESULT, reasoning: 'no_silicon_key' };
  try {
    const body = JSON.stringify({
      model: SILICON_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT + (caption ? `\nCaption: ${caption.slice(0,1000)}` : '') },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
        ]
      }],
      max_tokens: 2000
    });
    const r = execSync(
      `curl -s --connect-timeout 30 --max-time 180 "${SILICON_BASE}/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer ${SILICON_KEY}" -d @-`,
      { input: body, encoding: 'utf8', timeout: 185000, maxBuffer: 10 * 1024 * 1024 }
    );
    const j = JSON.parse(r);
    if (j.error) return { ...EMPTY_RESULT, reasoning: j.error.message?.slice(0,80) || 'api_error' };
    const txt = j.choices?.[0]?.message?.content || '';
    if (!txt) return { ...EMPTY_RESULT, reasoning: 'empty_response' };
    // Thinking models may wrap the answer in  tags — strip them
    let clean = txt.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').replace(/<answer>[\s\S]*?<\/answer>/g, '').trim();
    if (!clean) clean = txt;
    const parsed = parseVision(clean);
    if (parsed.confidence === 0 && !parsed.reasoning) parsed.reasoning = 'parse_fail:' + clean.slice(0,80);
    return parsed;
  } catch (e: any) {
    const msg = e.message?.slice(0, 80) || 'error';
    if (msg.includes('ETIMEDOUT')) return { ...EMPTY_RESULT, reasoning: 'timeout' };
    return { ...EMPTY_RESULT, reasoning: msg };
  }
}

/** Check which vision API is available: SiliconFlow first, then Gemini/relay fallback */
function testVisionAvailable(): 'siliconflow' | 'gemini' | 'relay' | false {
  // 1) SiliconFlow (domestic, no proxy needed)
  if (SILICON_KEY) {
    try {
      const r = execSync(
        `curl -s --connect-timeout 10 --max-time 15 "${SILICON_BASE}/models" -H "Authorization: Bearer ${SILICON_KEY}"`,
        { encoding: 'utf8', timeout: 20000 }
      );
      if (r.includes(SILICON_MODEL)) {
        console.log(`  ✓ SiliconFlow OK (${SILICON_MODEL})\n`);
        return 'siliconflow';
      }
      console.log('  ⚠️  SiliconFlow model not found\n');
    } catch { console.log('  ⚠️  SiliconFlow unreachable\n'); }
  }

  // 2) Relay (lemonapi via proxy)
  if (RELAY_BASE_URL && RELAY_KEY && PROXY) {
    try {
      const testBody = JSON.stringify({
        model: RELAY_MODEL,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 5,
      });
      const r = execSync(
        `curl -s --connect-timeout 10 --max-time 20 -x "${PROXY}" "${RELAY_BASE_URL}/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer ${RELAY_KEY}" -d @-`,
        { input: testBody, encoding: 'utf8', timeout: 30000 }
      );
      if (r.includes('choices') && !r.includes('error')) {
        console.log(`  ✓ Relay API OK (${RELAY_BASE_URL})\n`);
        return 'relay';
      }
    } catch {}
  }

  // 3) Gemini direct (via proxy)
  if (PROXY && GEMINI_KEY) {
    try {
      const r = execSync(
        `curl -s --connect-timeout 10 --max-time 15 -x "${PROXY}" "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash-001:generateContent?key=${GEMINI_KEY}" -H "Content-Type: application/json" -d '{"contents":[{"parts":[{"text":"ok"}]}]}'`,
        { encoding: 'utf8', timeout: 20000 }
      );
      if (r.includes('candidates') && !r.includes('quota')) {
        console.log('  ✓ Gemini API OK\n');
        return 'gemini';
      }
    } catch {}
  }

  return false;
}

// ======================== COLLECT POSTS ========================
async function collectPosts(page: any, handle: string, category?: string) {
  const posts: any[] = [];
  const isProductBrand = category && PRODUCT_BRAND_CATS.includes(category);

  await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { state: 'visible', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(jitter(3000, 5000));

  const sel = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
  for (let s = 0; s < MAX_SCROLLS; s++) {
    if ((await page.locator(sel).count().catch(() => 0)) >= COLLECT_TARGET) break;
    // Human-like scrolling: mouse wheel, small increments, random delays
    const scrollSteps = jitter(2, 4);
    for (let step = 0; step < scrollSteps; step++) {
      await page.mouse.wheel(0, jitter(250, 400));
      await sleep(jitter(400, 800));
    }
    await sleep(jitter(1500, 2500));
  }

  const total = Math.min(COLLECT_TARGET, await page.locator(sel).count().catch(() => 0));
  if (total === 0) return [];

  for (let i = 0; i < total; i++) {
    process.stdout.write(`  [${i+1}/${total}] `);
    try {
      const tiles = page.locator(sel);
      await tiles.nth(i).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(500,1000));

      // Grab tile href + thumbnail BEFORE clicking
      let tileImg = '';
      let postUrl = '';
      try {
        await page.waitForTimeout(200);
        const info = await page.evaluate((idx) => {
          const sel = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
          const tiles = document.querySelectorAll(sel);
          const t = tiles[idx] as HTMLElement;
          if (!t) return { img: '', url: '' };
          const href = (t.getAttribute('href') || '').split('?')[0];
          const url = href.startsWith('http') ? href : 'https://www.instagram.com' + href;
          const img = t.querySelector('img');
          if (!img) return { img: '', url };
          const i = img as HTMLImageElement;
          let src = '';
          if (i.currentSrc && i.currentSrc.startsWith('http') && !i.currentSrc.includes('profile')) src = i.currentSrc;
          else {
            const ss = img.getAttribute('srcset') || '';
            if (ss) {
              const urls = ss.split(',').map(s => s.trim().split(/\s+/)[0]).filter(u => u.startsWith('http'));
              if (urls.length > 0) src = urls[urls.length - 1];
            } else if (i.src && i.src.startsWith('http') && !i.src.includes('profile')) src = i.src;
          }
          return { img: src, url };
        }, i);
        tileImg = info.img;
        postUrl = info.url;
      } catch {}
      if (tileImg) process.stdout.write(`📎`);

      const tile = tiles.nth(i);
      // Mouse hover before click (human-like)
      await tile.hover({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(jitter(800, 1500));
      await tile.click({ timeout: 10000 });
      await page.waitForTimeout(jitter(2000,3500));

      const info = await page.evaluate(() => {
        const d = document.querySelector('div[role="dialog"]');
        const text = d ? (d as HTMLElement).innerText||'' : '';
        const l = text.match(/([\d,.]+[万wW]?)\s*(?:次赞|likes?|赞)/i);
        const likes = l ? (() => {
          const s = l[1].replace(/,/g, '').toLowerCase().trim();
          if (s.endsWith('万') || s.endsWith('w')) return Math.round(parseFloat(s) * 10000);
          return parseInt(s) || 0;
        })() : 0;
        // Comment count — multiple patterns
        const commentCount = (() => {
          const c1 = text.match(/view\s+all\s+([\d,.]+)\s*comments?/i);
          if (c1) return parseInt(c1[1].replace(/,/g, '')) || 0;
          const c2 = text.match(/([\d,.]+)\s*comments?(?:\s|$)/i);
          if (c2) return parseInt(c2[1].replace(/,/g, '')) || 0;
          const c3 = text.match(/([\d,.]+)\s*(?:个)?评论/i);
          if (c3) return parseInt(c3[1].replace(/,/g, '')) || 0;
          return 0;
        })();
        const cap = text.match(/(?:^|\n)([^\n]{15,500}?)(?:\n|$)/);
        const imgs = d?.querySelectorAll<HTMLImageElement>('img[src*="cdninstagram"]') || [];
        let coverUrl = '';
        for (const img of imgs) {
          const src = img.src || '';
          if (src.includes('s150x150') || src.includes('profile')) continue;
          if (src.includes('cdninstagram')) { coverUrl = src; break; }
        }
        const video = d?.querySelector('video');
        const timeEl = document.querySelector('time');
        // Extract top comments — try multiple DOM selectors
        const commentSelectors = [
          'div[role="comment"]',
          'article[role="comment"]',
          'ul li span[dir="auto"]',
        ];
        let commentEls: NodeListOf<HTMLElement> | null = null;
        for (const sel of commentSelectors) {
          const found = d?.querySelectorAll<HTMLElement>(sel);
          if (found && found.length > 0) { commentEls = found; break; }
        }
        let topComments: string[] = [];
        if (commentEls) {
          const seen = new Set<string>();
          for (const el of commentEls) {
            const t = (el.textContent || '').trim();
            if (!t || t.length < 2 || seen.has(t)) continue;
            seen.add(t);
            if (/(?:likes?|赞|回复|reply|view|更多)/i.test(t)) continue;
            topComments.push(t.slice(0, 300));
            if (topComments.length >= 10) break;
          }
        }
        return { likes, commentCount, topComments, caption: cap ? cap[1].trim().slice(0,2000) : '', mediaUrl: coverUrl, isVideo: !!video, postedAt: timeEl?.getAttribute('datetime')||'' };
      });

      if (!info.mediaUrl && tileImg) info.mediaUrl = tileImg;

      // Skip promo/interview posts during collection (relaxed for product brands — they post mostly promo)
      const skipCol = SKIP_CAPTION_PATTERNS.some(re => re.test(info.caption || '')) && !isProductBrand;
      if (skipCol) { process.stdout.write(`⏭️ skip\n`); } else {
        posts.push({ index: i, postUrl, ...info });
        if (tileImg) {
          const lastPost = posts[posts.length - 1];
          if (!lastPost.mediaUrl) {
            posts[posts.length - 1].mediaUrl = tileImg;
          }
        }
        process.stdout.write(`❤️${info.likes} ${info.isVideo ? '🎬' : '📷'} ${info.caption.slice(0,40)}\n`);
      }
    } catch { process.stdout.write(`⏭️\n`); }

    try {
      const cb = page.locator('svg[aria-label="Close"], svg[aria-label="关闭"]').first();
      if (await cb.count() > 0) await cb.click({ timeout: 5000 });
      else await page.keyboard.press('Escape');
    } catch { await page.keyboard.press('Escape').catch(() => {}); }
    await page.waitForTimeout(jitter(1500,2500));
  }
  return posts;
}

// ======================== DOWNLOAD IMAGE ========================
async function downloadImgViaBrowser(page: any, url: string, dest: string): Promise<boolean> {
  // Element screenshot — works at browser compositor level, no CORS issues.
  // Try selectors from most specific to most general, including video posters.
  const trySelectors = async (): Promise<boolean> => {
    const selectors = [
      'div[role="dialog"] video[poster]',         // reel video poster in dialog
      'div[role="dialog"] video',                  // video without poster (lazy load)
      'div[role="dialog"] img[src*="cdn"]:not([width="32"]):not([width="44"])', // img in dialog
      'div[role="dialog"] img:not([width="44"])',  // any dialog image (not avatar)
      'article video[poster]',                     // reel poster not in dialog
      'article img[src*="cdn"]:not([width="32"])', // article image
      'video[poster]',                             // any video poster
    ];
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        await el.waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        const box = await el.boundingBox();
        if (!box || box.width < 100) continue;
        await el.screenshot({ path: dest, type: 'jpeg', quality: 90, timeout: 10000 });
        if (fs.existsSync(dest) && fs.statSync(dest).size > 500) return true;
      } catch {}
    }
    return false;
  };
  if (await trySelectors()) return true;
  // Fallback: screenshot the entire dialog
  try {
    const dialog = page.locator('div[role="dialog"]').first();
    if (await dialog.count() > 0) {
      await page.waitForTimeout(1000);
      const box = await dialog.boundingBox();
      if (box && box.width > 200) {
        await page.screenshot({ path: dest, type: 'jpeg', quality: 85, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
        if (fs.existsSync(dest) && fs.statSync(dest).size > 500) return true;
      }
    }
  } catch {}
  // Retry once after a longer wait
  await page.waitForTimeout(3000);
  if (await trySelectors()) return true;
  try {
    const dialog = page.locator('div[role="dialog"]').first();
    if (await dialog.count() > 0) {
      const box = await dialog.boundingBox();
      if (box && box.width > 200) {
        await page.screenshot({ path: dest, type: 'jpeg', quality: 85, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
        if (fs.existsSync(dest) && fs.statSync(dest).size > 500) return true;
      }
    }
  } catch {}
  return false;
}

// ======================== MAIN ========================
async function main() {
  console.log(`=== Hook Vision AI v4 ===\n`);
  console.log(`Proxy: ${PROXY || 'none (Gemini unavailable)'}`);
  if (PROXY) console.log(`Gemini: will use proxy`);
  console.log();

  if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const candidates = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8'));
  const handleFilter = process.argv.find(a => a.startsWith('--handles='))?.split('=')[1]?.split(',') || [];
  const targets = (handleFilter.length ? candidates.filter((c:any) => handleFilter.includes(c.handle)) : candidates)
    .filter((c:any) => c.type !== 'B_artist');
  console.log(`Targets: ${targets.length} accounts\n`);

  // Clean lock files if previous run left them
  for (const f of ['SingletonLock','SingletonSocket','SingletonCookie']) {
    const p = path.join(PROFILE_DIR, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  console.log('Launching Chromium...');
  const chromeArgs = ['--disable-blink-features=AutomationControlled','--disable-infobars','--no-sandbox'];
  if (PROXY && PROXY.length > 0) chromeArgs.push(`--proxy-server=${PROXY}`);
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: chromeArgs,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  page.setDefaultTimeout(15000);

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('login')) {
    console.log('⚠️  Login required. Press Enter.');
    await new Promise<void>(r => { process.stdin.once('data', () => r()); });
    await page.waitForTimeout(3000);
  }
  console.log('Logged in!\n');

  let visionMode: 'siliconflow' | 'gemini' | 'relay' | false = false;
  console.log('Testing vision API...');
  visionMode = testVisionAvailable();
  if (!visionMode) {
    console.log('  ⚠️  No vision API available. Will collect data and save images for later analysis.\n');
  }

  let results: any[] = [];
  if (fs.existsSync(OUTPUT_FILE)) results = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  const doneHandles = new Set(results.map((r:any) => r.handle));

  for (const acct of targets) {
    if (doneHandles.has(acct.handle)) { console.log(`  ⏭️  @${acct.handle}`); continue; }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  [${acct.type}] ${acct.name} (@${acct.handle})`);
    const fTxt = acct.followers >= 10000 ? (acct.followers/10000).toFixed(1)+'万' : String(acct.followers);
    console.log(`  👤 ${fTxt}粉 | ${acct.category}`);

    // STEP 1: Collect posts
    let posts: any[] = [];
    try { posts = await collectPosts(page, acct.handle, acct.category); } catch (e: any) {
      console.log(`  ⚠️  collectPosts error: ${e.message?.slice(0,80) || e}`);
      await sleep(jitter(3000,5000));
      continue;
    }
    const withData = posts.filter(p => p.likes > 0);
    if (withData.length < 5) { console.log('  ⚠️  Too few posts'); continue; }

    // STEP 2: Baseline + RP
    const avgLikes = Math.round(withData.reduce((s,p) => s+p.likes, 0) / withData.length);
    for (const p of posts) p.rp = avgLikes > 0 ? p.likes / avgLikes : 0;

    // Filter out promotional/interview posts from analysis candidates
    const candidates = withData.filter(p => {
      const cap = (p.caption || '').toLowerCase();
      return !SKIP_CAPTION_PATTERNS.some(re => re.test(cap));
    });
    // Dynamic count: product brands get more analyses to ensure product shot coverage
    const batchSize = PRODUCT_BRAND_CATS.includes(acct.category) ? PRODUCT_TOP_RP_COUNT : TOP_RP_COUNT;
    const fallback = candidates.length < batchSize;
    const pool = fallback ? withData : candidates;

    // Content-type boost: for product brands, force-include product posts even if low RP
    const isProductBrand = PRODUCT_BRAND_CATS.includes(acct.category);
    const productKeywords = /cartridge|needle|rl|rs|m1|cm|bugpin|gauge|taper|ink|bottle|machine|pen|rotary|coil|stroke|balm|lotion|sterile|pack|unbox|hybrid|membrane|equalizer|spektra|cheyenne/i;

    let topRP: any[];
    if (isProductBrand) {
      const allEligible = pool.filter(p => p.likes >= RP_MIN_LIKES);
      // Detect product-like posts: keyword match OR very short caption (brand tag)
      const productPosts = pool.filter(p => {
        const cap = (p.caption || '');
        if (productKeywords.test(cap)) return true;
        // Short captions that are just @mentions (common for product shots)
        if (cap.length < 30 && /@[\w.-]+/.test(cap)) return true;
        // Captions mentioning a brand name or model
        if (/\b(?:new|available|now|launch|drop|arrival|cartridge|needle|grip|machine|bundle|kit)\b/i.test(cap)) return true;
        return false;
      });
      // Top high-performers (tattoos/art, for copywriting reference)
      allEligible.sort((a,b) => b.rp - a.rp);
      const topCount = Math.ceil(batchSize * 0.5); // 5 from top RP
      const topPerformers = allEligible.slice(0, topCount);
      // Force-include product posts (no RP minimum), fill remaining slots
      productPosts.sort((a,b) => b.rp - a.rp);
      const seen = new Set<string>();
      topRP = [...topPerformers, ...productPosts].filter(p => {
        if (seen.has(p.postUrl)) return false;
        seen.add(p.postUrl);
        return true;
      }).slice(0, batchSize);
    } else {
      topRP = pool.filter(p => p.likes >= RP_MIN_LIKES).sort((a,b) => b.rp - a.rp).slice(0, batchSize);
    }
    if (topRP.length < batchSize && pool.length >= batchSize) {
      topRP = pool.sort((a,b) => b.rp - a.rp).slice(0, batchSize);
    }
    console.log(`  📊 Baseline avg❤️=${avgLikes} (${withData.length} posts)`);
    if (!fallback) console.log(`  📋 Filtered ${withData.length - candidates.length} promo/interview posts`);
    console.log(`  📊 Top ${batchSize} by RP:`);
    for (const p of topRP) console.log(`    RP ${p.rp.toFixed(2)}x ❤️${p.likes} | ${p.caption.slice(0,50)}`);

    // STEP 3: Vision analysis
    const analyses: any[] = [];
    const batchTotal = topRP.length;
    for (const [i, post] of topRP.entries()) {
      let a: VisionResult | null = null;
      let hasImage = false;

      if (visionMode === 'siliconflow') {
        const imgPath = path.join(FRAMES_DIR, acct.handle, `rp${i}.jpg`);
        // Reuse cached image if exists
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 500) {
          hasImage = true;
          process.stdout.write(`cached `);
        } else {
          // Reload profile page fresh, scroll to load enough tiles, click dialog, screenshot
          try {
            await page.goto(`https://www.instagram.com/${acct.handle}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(jitter(3000, 5000));
            // Scroll until the needed tile is visible
            const tileSel = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
            let tileCount = await page.locator(tileSel).count();
            let scrollAttempts = 0;
            while (post.index >= tileCount && scrollAttempts < 20) {
              await page.mouse.wheel(0, jitter(300, 500));
              await page.waitForTimeout(jitter(1500, 2500));
              tileCount = await page.locator(tileSel).count();
              scrollAttempts++;
            }
            if (post.index < tileCount) {
              const tile = page.locator(tileSel).nth(post.index);
              await tile.scrollIntoViewIfNeeded();
              await page.waitForTimeout(jitter(1500, 2500));
              await tile.hover().catch(() => {});
              await page.waitForTimeout(jitter(500, 1000));
              await tile.click({ timeout: 15000 });
              await page.waitForTimeout(jitter(3000, 5000));
              process.stdout.write(`tile[${post.index}] `);
              hasImage = await downloadImgViaBrowser(page, '', imgPath);
              if (!hasImage) process.stdout.write(`dl_fail `);
            } else {
              process.stdout.write(`tile_oob(${tileCount}) `);
            }
          } catch (e: any) { process.stdout.write(`[click_err ${(e.message||'').slice(0,20)}] `); }
          // Close dialog with human-like pause
          try { await page.keyboard.press('Escape'); await page.waitForTimeout(jitter(1500, 3000)); } catch {}
        }
        if (!hasImage) hasImage = fs.existsSync(imgPath) && fs.statSync(imgPath).size > 500;
        if (hasImage) {
          process.stdout.write(`  [${i+1}/${batchTotal}] SF... `);
          const b = b64(imgPath);
          if (b) a = visionViaSiliconFlow(b, post.caption);
        }
      } else if (visionMode === 'relay' && post.mediaUrl) {
        process.stdout.write(`  [${i+1}/${batchTotal}] Relay URL... `);
        a = visionViaRelay(post.mediaUrl, post.caption, true);
      } else {
        const imgPath = path.join(FRAMES_DIR, acct.handle, `rp${i}.jpg`);
        if (post.mediaUrl) hasImage = await downloadImgViaBrowser(page, post.mediaUrl, imgPath);
        if (!hasImage) hasImage = fs.existsSync(imgPath) && fs.statSync(imgPath).size > 500;

        if (hasImage && visionMode) {
          const b = b64(imgPath);
          if (b) a = visionMode === 'relay'
            ? visionViaRelay(b, post.caption, false)
            : geminiCurl(b, post.caption);
        }
      }

      if (a) {
        analyses.push({
          handle: acct.handle, accountName: acct.name, accountType: acct.type,
          category: acct.category, followers: acct.followers,
          postIndex: post.index, postUrl: post.postUrl, likes: post.likes, commentCount: post.commentCount || 0,
          relativePerformance: post.rp, avgLikes, caption: post.caption.slice(0,500),
          topComments: (post.topComments || []).slice(0,10),
          isVideo: post.isVideo, postedAt: post.postedAt,
          contentType: a.contentType,
          productCategory: a.productCategory,
          productDetail: a.productDetail,
          needleSpec: a.needleSpec,
          packaging: a.packaging || '',
          cartridgeColor: a.cartridgeColor || '',
          audio: a.audio || '',
          technique: a.technique || '',
          tattooStyle: a.tattooStyle || '',
          placement: a.placement || '',
          colorScheme: a.colorScheme || '',
          size: a.size || '',
          skinTone: a.skinTone || '',
          photoQuality: a.photoQuality || '',
          healingStage: a.healingStage || '',
          lineQuality: a.lineQuality || '',
          saturationLevel: a.saturationLevel || '',
          designComplexity: a.designComplexity || '',
          colorPalette: a.colorPalette || '',
          contrastLevel: a.contrastLevel || '',
          compositionQuality: a.compositionQuality || '',
          anatomyAccuracy: a.anatomyAccuracy || '',
          shadingTechnique: a.shadingTechnique || '',
          lightingStyle: a.lightingStyle || '',
          perspective: a.perspective || '',
          hook: a.hook, confidence: a.confidence, reasoning: a.reasoning,
          emotion: a.emotion, style: a.style,
          analyzedAt: new Date().toISOString(),
        });
        const modeLabel = visionMode === 'siliconflow' ? 'SF' : visionMode === 'relay' ? 'Relay' : 'Gemini';
        const prodInfo = a.productCategory ? ` | ${a.productCategory}${a.productDetail ? `:${a.productDetail}` : ''}` : '';
        const specInfo = a.needleSpec ? ` [${a.needleSpec.gaugeMm} ${a.needleSpec.typeName} x${a.needleSpec.count}${a.needleSpec.taper ? ' '+a.needleSpec.taper : ''}]` : '';
        const pkgInfo = a.packaging ? ` 📦${a.packaging.slice(0,40)}` : '';
        const audInfo = a.audio ? ` 🎵${a.audio.slice(0,30)}` : '';
        const techInfo = a.technique ? ` 📝${a.technique}` : '';
        const styleInfo = a.tattooStyle ? ` 🎨${a.tattooStyle}` : '';
        const szInfo = a.size ? ` 📐${a.size}` : '';
        const skinInfo = a.skinTone ? ` 🏽${a.skinTone}` : '';
        const healInfo = a.healingStage ? ` 🩹${a.healingStage}` : '';
        const ccInfo = a.cartridgeColor ? ` 🎨${a.cartridgeColor}` : '';
        const lineInfo = a.lineQuality ? ` ✏️${a.lineQuality}` : '';
        const compInfo = a.compositionQuality ? ` 🖼️${a.compositionQuality}` : '';
        const cmtInfo = post.commentCount ? ` 💬${post.commentCount}` : '';
        console.log(`→ [${modeLabel}] ${a.contentType}${prodInfo}${specInfo}${pkgInfo}${ccInfo}${audInfo}${techInfo}${styleInfo}${szInfo}${skinInfo}${healInfo}${lineInfo}${compInfo}${cmtInfo} | ${a.hook} (${(a.confidence*100).toFixed(0)}%) | ${a.emotion} | ${a.style}`);
      } else if (hasImage || post.mediaUrl) {
        analyses.push({
          handle: acct.handle, accountName: acct.name, accountType: acct.type,
          category: acct.category, followers: acct.followers,
          postIndex: post.index, postUrl: post.postUrl, likes: post.likes, relativePerformance: post.rp,
          avgLikes, caption: post.caption.slice(0,500),
          isVideo: post.isVideo, postedAt: post.postedAt,
          contentType: null, productCategory: null, productDetail: '',
          packaging: '',
          hook: 'pending', confidence: 0, reasoning: hasImage ? 'awaiting_vision' : 'download_failed',
          emotion: 'unknown', style: 'unknown',
          analyzedAt: new Date().toISOString(),
        });
        console.log(`  ⚠️  [${i+1}] ${hasImage ? 'Image saved, pending' : 'Download failed'}`);
      } else {
        console.log(`  ⚠️  [${i+1}] No image URL`);
      }
      await sleep(jitter(3000,5000));
    }

    if (analyses.length > 0) {
      results.push({
        handle: acct.handle, name: acct.name, type: acct.type, category: acct.category,
        followers: acct.followers, baseline: { avgLikes, totalPosts: posts.length },
        analyses, scrapedAt: new Date().toISOString(),
      });
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf8');
    }
    console.log(`  ✅ ${analyses.filter((a:any) => a.hook !== 'pending').length} analyzed, ${analyses.filter((a:any) => a.hook === 'pending').length} pending`);

    await sleep(jitter(2000,3000));
  }

  // ── SUMMARY ──
  console.log(`\n${'═'.repeat(55)}`);
  const all = results.flatMap((r:any) => r.analyses||[]).filter((a:any) => a.hook !== 'pending');

  if (all.length > 0) {
    // Content type ranking (overall)
    const byCT: Record<string,{c:number;rp:number;lk:number;rps:number[]}> = {};
    for (const a of all) {
      const ct = a.contentType || 'unknown';
      if (!byCT[ct]) byCT[ct] = { c:0, rp:0, lk:0, rps:[] };
      byCT[ct].c++; byCT[ct].rp += a.relativePerformance; byCT[ct].lk += a.likes; byCT[ct].rps.push(a.relativePerformance);
    }
    const ctRanked = Object.entries(byCT).map(([ct,d]) => ({ ct, c:d.c, avgRP:d.rp/d.c, avgLk:Math.round(d.lk/d.c), maxRP:Math.max(...d.rps) })).sort((a,b) => b.avgRP - a.avgRP);
    console.log(`\n  📊 内容类型 RP Ranking`);
    console.log(`  ${'─'.repeat(60)}`);
    console.log(`  # │ Content Type      │ Count │ Avg RP │ Avg❤️  │ Max RP │`);
    console.log(`  ${'─'.repeat(60)}`);
    for (const [i,ct] of ctRanked.entries()) {
      console.log(`  ${(i+1).toString().padStart(2)} │ ${ct.ct.padEnd(18).slice(0,18)} │ ${ct.c.toString().padStart(4)}  │ ${ct.avgRP.toFixed(2).padStart(6)}x │ ${ct.avgLk.toString().padStart(6)} │ ${ct.maxRP.toFixed(2).padStart(6)}x │`);
    }

    // Product sub-category ranking (if any product_shot exists)
    const products = all.filter((a:any) => a.contentType === 'product_shot' && a.productCategory);
    if (products.length > 0) {
      const byPC: Record<string,{c:number;rp:number;lk:number;rps:number[];details:string[]}> = {};
      for (const a of products) {
        const pc = a.productCategory || 'unknown';
        if (!byPC[pc]) byPC[pc] = { c:0, rp:0, lk:0, rps:[], details:[] };
        byPC[pc].c++; byPC[pc].rp += a.relativePerformance; byPC[pc].lk += a.likes; byPC[pc].rps.push(a.relativePerformance);
        if (a.productDetail) byPC[pc].details.push(a.productDetail);
      }
      const pcRanked = Object.entries(byPC).map(([pc,d]) => ({ pc, c:d.c, avgRP:d.rp/d.c, avgLk:Math.round(d.lk/d.c), maxRP:Math.max(...d.rps), details:[...new Set(d.details)] })).sort((a,b) => b.avgRP - a.avgRP);
      console.log(`\n  📊 产品子类 RP Ranking`);
      console.log(`  ${'─'.repeat(60)}`);
      console.log(`  # │ Product           │ Count │ Avg RP │ Avg❤️  │ Max RP │ Details`);
      console.log(`  ${'─'.repeat(60)}`);
      for (const [i,pc] of pcRanked.entries()) {
        const det = pc.details.length > 0 ? pc.details.join(',') : '';
        console.log(`  ${(i+1).toString().padStart(2)} │ ${pc.pc.padEnd(18).slice(0,18)} │ ${pc.c.toString().padStart(4)}  │ ${pc.avgRP.toFixed(2).padStart(6)}x │ ${pc.avgLk.toString().padStart(6)} │ ${pc.maxRP.toFixed(2).padStart(6)}x │ ${det.slice(0,20)}`);
      }
    }

    // Hook ranking (within each content type)
    console.log(`\n  📋 详细分析 (点击链接核实):`);
    for (const a of all) {
      const prod = a.productCategory ? ` [${a.productCategory}${a.productDetail ? '/'+a.productDetail : ''}]` : '';
      const url = a.postUrl || '';
      console.log(`  ${a.handle} ${a.contentType}${prod} | RP ${a.relativePerformance.toFixed(2)}x ❤️${a.likes} | ${a.hook} ${(a.confidence*100).toFixed(0)}% | ${a.emotion}`);
      if (url) console.log(`    🔗 ${url}`);
    }
  }
  console.log(`\n  Done.`);

  // Browser stays open — user closes manually or next run cleans up
  // await browser.close();
}

main().catch(e => { console.error('Fatal:', e?.message||e); process.exit(1); });
