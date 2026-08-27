/** Controlled technical tattoo analysis for posts already approved by A+B. */
import 'dotenv/config';

export type TechnicalField = { value: string; confidence: number; evidence: string };
export type TechnicalSlide = {
  index: number;
  palette: TechnicalField;
  linework: TechnicalField;
  shading: TechnicalField;
  composition: TechnicalField;
  motif: TechnicalField;
};
export type TechnicalVisionResult = {
  ok: boolean;
  reason: string;
  mediaCount: number;
  slides: TechnicalSlide[];
  safeTechnicalFacts: string[];
};

const API_KEY = (process.env.SILICON_KEY || process.env.QWEN_API_KEY || '').trim();
const BASE_URL = (process.env.VISION_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const MODEL = (process.env.VISION_MODEL_C || process.env.VISION_MODEL || 'Qwen/Qwen3-VL-32B-Instruct').trim();
const MIN_CONFIDENCE = Math.min(1, Math.max(0.75, Number(process.env.TECH_VISION_MIN_CONFIDENCE || '0.85')));
const TIMEOUT_MS = Math.max(10_000, Number(process.env.VISION_TIMEOUT || '120') * 1000);
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.VISION_SLIDE_CONCURRENCY || '2')));

const VALUES = {
  palette: new Set(['black_and_grey', 'full_color', 'mixed', 'not_clear']),
  linework: new Set(['fine_line', 'bold_line', 'mixed_lineweight', 'outline_dominant', 'not_clear']),
  shading: new Set(['smooth_gradient', 'whip_shading', 'stipple_dotwork', 'solid_fill', 'mixed', 'none_visible', 'not_clear']),
  composition: new Set(['vertical_flow', 'horizontal_flow', 'wraparound', 'centered', 'not_clear']),
  motif: new Set(['portrait', 'animal', 'floral_botanical', 'lettering', 'geometric_ornamental', 'skull', 'abstract', 'object', 'other', 'not_clear']),
} as const;

const PROMPT = `You are reviewer C, a conservative tattoo-technique visual extractor. The post has already passed a
separate real-skin tattoo safety gate. Identify only technique or subject properties clearly visible in this ONE image.
Do not judge quality, artist skill, healing, safety, sterility, pain, age, or hidden process. Do not infer a named tattoo
style. Use not_clear whenever an item cannot be determined from visible pixels with high confidence.

Allowed values:
palette: black_and_grey | full_color | mixed | not_clear
linework: fine_line | bold_line | mixed_lineweight | outline_dominant | not_clear
shading: smooth_gradient | whip_shading | stipple_dotwork | solid_fill | mixed | none_visible | not_clear
composition: vertical_flow | horizontal_flow | wraparound | centered | not_clear
motif: portrait | animal | floral_botanical | lettering | geometric_ornamental | skull | abstract | object | other | not_clear

Return STRICT JSON only and include every field:
{"slides":[{"index":1,
"palette":{"value":"not_clear","confidence":0.0,"evidence":"visible evidence"},
"linework":{"value":"not_clear","confidence":0.0,"evidence":"visible evidence"},
"shading":{"value":"not_clear","confidence":0.0,"evidence":"visible evidence"},
"composition":{"value":"not_clear","confidence":0.0,"evidence":"visible evidence"},
"motif":{"value":"not_clear","confidence":0.0,"evidence":"visible evidence"}}]}`;

const clamp = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

const extractJson = (text: string): any => {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('tech_parse_fail');
  return JSON.parse(match[0]);
};

const normalizeField = (raw: any, allowed: Set<string>): TechnicalField => ({
  value: allowed.has(String(raw?.value || '')) ? String(raw.value) : 'not_clear',
  confidence: clamp(raw?.confidence),
  evidence: String(raw?.evidence || '').slice(0, 180),
});

const normalizeSlide = (raw: any, index: number): TechnicalSlide => ({
  index,
  palette: normalizeField(raw?.palette, VALUES.palette),
  linework: normalizeField(raw?.linework, VALUES.linework),
  shading: normalizeField(raw?.shading, VALUES.shading),
  composition: normalizeField(raw?.composition, VALUES.composition),
  motif: normalizeField(raw?.motif, VALUES.motif),
});

async function reviewOne(image: string, index: number): Promise<TechnicalSlide> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze this single already-approved tattoo image. Return one slide result with index 1.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
          ] },
        ],
        temperature: 0,
        max_tokens: 900,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`tech_api_${response.status}`);
    const payload: any = await response.json();
    const parsed = extractJson(String(payload?.choices?.[0]?.message?.content || ''));
    if (!Array.isArray(parsed?.slides) || parsed.slides.length !== 1) throw new Error('tech_invalid_slide_count');
    return normalizeSlide(parsed.slides[0], index);
  } finally { clearTimeout(timer); }
}

const FACT_LABELS: Record<string, Record<string, string>> = {
  palette: { black_and_grey: 'a black-and-grey palette is clearly visible', full_color: 'a full-color palette is clearly visible', mixed: 'both black-and-grey and color are clearly visible' },
  linework: { fine_line: 'fine linework is clearly visible', bold_line: 'bold linework is clearly visible', mixed_lineweight: 'mixed line weights are clearly visible', outline_dominant: 'the design is visibly outline-dominant' },
  // none_visible is deliberately omitted: absence is useful analysis metadata,
  // but it is not a natural or positive fact for a public comment.
  shading: { smooth_gradient: 'smooth gradient shading is clearly visible', whip_shading: 'whip shading is clearly visible', stipple_dotwork: 'stipple or dotwork shading is clearly visible', solid_fill: 'solid fill areas are clearly visible', mixed: 'multiple shading approaches are clearly visible' },
  composition: { vertical_flow: 'the visible composition has a vertical flow', horizontal_flow: 'the visible composition has a horizontal flow', wraparound: 'the visible composition wraps around the body area', centered: 'the visible composition is centered' },
  motif: { portrait: 'a portrait motif is clearly visible', animal: 'an animal motif is clearly visible', floral_botanical: 'a floral or botanical motif is clearly visible', lettering: 'lettering is clearly visible', geometric_ornamental: 'a geometric or ornamental motif is clearly visible', skull: 'a skull motif is clearly visible', abstract: 'an abstract motif is clearly visible', object: 'an object-based motif is clearly visible', other: 'the main motif is clearly visible but does not fit a supported category' },
};

/** Only facts consistent across every slide are safe for a whole-post comment. */
const buildSafeFacts = (slides: TechnicalSlide[]): string[] => {
  if (!slides.length) return [];
  const facts: string[] = [];
  for (const fieldName of ['palette', 'linework', 'shading', 'composition', 'motif'] as const) {
    const fields = slides.map((slide) => slide[fieldName]);
    const first = fields[0];
    if (first.value === 'not_clear' || first.confidence < MIN_CONFIDENCE) continue;
    if (!fields.every((field) => field.value === first.value && field.confidence >= MIN_CONFIDENCE)) continue;
    const label = FACT_LABELS[fieldName]?.[first.value];
    if (label) facts.push(label);
  }
  return facts;
};

export async function analyzeTattooTechnique(base64Images: string[]): Promise<TechnicalVisionResult> {
  const images = base64Images.filter((image) => typeof image === 'string' && image.length > 100);
  if (!API_KEY) return { ok: false, reason: 'no_api_key', mediaCount: images.length, slides: [], safeTechnicalFacts: [] };
  if (!images.length || images.length !== base64Images.length) return { ok: false, reason: 'invalid_media', mediaCount: base64Images.length, slides: [], safeTechnicalFacts: [] };
  const slides: TechnicalSlide[] = [];
  try {
    for (let start = 0; start < images.length; start += CONCURRENCY) {
      const batch = images.slice(start, start + CONCURRENCY);
      const results = await Promise.all(batch.map((image, offset) => reviewOne(image, start + offset + 1)));
      slides.push(...results);
    }
  } catch (error: any) {
    return { ok: false, reason: String(error?.name === 'AbortError' ? 'tech_timeout' : error?.message || 'tech_error'), mediaCount: images.length, slides, safeTechnicalFacts: [] };
  }
  if (slides.length !== images.length) return { ok: false, reason: 'tech_incomplete', mediaCount: images.length, slides, safeTechnicalFacts: [] };
  return { ok: true, reason: 'technical_review_complete', mediaCount: images.length, slides, safeTechnicalFacts: buildSafeFacts(slides) };
}
