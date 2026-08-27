/**
 * Fail-closed Instagram comment vision gate.
 *
 * A and B independently make a simple per-image decision: a clear tattoo on
 * real human skin, or not. Non-tattoo carousel attachments do not invalidate a
 * post; only facts from mutually approved tattoo images reach the writer.
 */

import 'dotenv/config';

export type VisionCategory =
  | 'finished_tattoo'
  | 'tattoo_in_progress'
  | 'drawing_or_flash'
  | 'practice_skin_or_object'
  | 'shop_or_staff'
  | 'product_or_brand'
  | 'portrait_or_lifestyle'
  | 'other'
  | 'uncertain';

export type PostImageCategory = 'tattoo_artwork' | 'blocked' | 'unrelated';

export interface ModelASlideResult {
  index: number;
  category: VisionCategory;
  confidence: number;
  tattooOnRealHumanSkin: boolean;
  tattooIsPrimarySubject: boolean;
  evidence: string;
  safeFacts: string[];
}

export interface ModelBSlideResult {
  index: number;
  decision: 'approve' | 'block';
  confidence: number;
  riskFlags: string[];
  reason: string;
}

export interface VisionGateResult {
  category: PostImageCategory;
  confidence: number;
  reason: string;
  ok: boolean;
  mediaCount: number;
  modelA: ModelASlideResult[];
  modelB: ModelBSlideResult[];
  tattooMediaIndexes: number[];
  safeFacts: string[];
}

export type VisionMediaKind = 'single' | 'carousel' | 'reel';

const API_KEY = (process.env.SILICON_KEY || process.env.QWEN_API_KEY || '').trim();
const BASE_URL = (process.env.VISION_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const MODEL_A = (process.env.VISION_MODEL_A || process.env.VISION_MODEL || 'Qwen/Qwen3-VL-32B-Instruct').trim();
const MODEL_B = (process.env.VISION_MODEL_B || process.env.VISION_MODEL || 'Qwen/Qwen3-VL-32B-Instruct').trim();
const TIMEOUT_MS = Math.max(10_000, Number(process.env.VISION_TIMEOUT || '120') * 1000);
const MIN_CONFIDENCE = Math.min(1, Math.max(0.5, Number(process.env.VISION_MIN_CONFIDENCE || '0.90')));
const SLIDE_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.VISION_SLIDE_CONCURRENCY || '2')));
const ALLOWED_CATEGORIES = new Set<VisionCategory>(['finished_tattoo', 'tattoo_in_progress']);

const MODEL_A_PROMPT = `You are reviewer A, a conservative binary tattoo-presence identifier.
For each supplied image, decide whether a clear tattoo is visibly present on real human skin.
Mark tattooIsPrimarySubject true when the tattoo is a meaningful visible subject that a normal viewer could comment
on, not merely a tiny, distant, cropped, or incidental tattoo in a portrait or staff photo.
Fresh, healed, or actively tattooed real skin may qualify. A tattoo merely visible on a person does not qualify when
the post is mainly a portrait, staff photo, lifestyle scene, studio, product, promotion, drawing, print, clothing,
tattoo practice skin, mannequin, sculpture, screen, or other object.

Allowed category values:
finished_tattoo, tattoo_in_progress, drawing_or_flash, practice_skin_or_object, shop_or_staff,
product_or_brand, portrait_or_lifestyle, other, uncertain.

Return STRICT JSON only:
{"slides":[{"index":1,"category":"...","confidence":0.0,"tattooOnRealHumanSkin":false,
"tattooIsPrimarySubject":false,"evidence":"short visible evidence","safeFacts":["only facts clearly visible"]}]}
Never infer hidden details. When uncertain, use uncertain.`;

const MODEL_B_PROMPT = `You are reviewer B, an independent binary tattoo-presence auditor. Independently inspect
every supplied image; do not assume reviewer A approved it.
Block a slide if the tattoo is not clearly on real human skin, is not the main subject, is ambiguous, is a drawing,
print, practice skin, product, logo, promotion, shop/staff image, portrait/lifestyle image, or if the visible evidence
is insufficient. Judge each image independently. Tattoos incidentally visible on a person are not enough.

Return STRICT JSON only:
{"slides":[{"index":1,"decision":"approve","confidence":0.95,
"riskFlags":[],"reason":"short visible reason"}]}
The riskFlags property is REQUIRED on every result. For approve it MUST be an empty array []. For block it MUST
contain at least one short risk flag. Never omit riskFlags and never return null. Return exactly one ordered result
per supplied slide. Prefer block when uncertain.`;

const clampConfidence = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

const failResult = (reason: string, mediaCount = 0, modelA: ModelASlideResult[] = [], modelB: ModelBSlideResult[] = []): VisionGateResult => ({
  category: 'blocked',
  confidence: 0,
  reason,
  ok: false,
  mediaCount,
  modelA,
  modelB,
  tattooMediaIndexes: [],
  safeFacts: [],
});

const extractJson = (text: string): any => {
  const fenced = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const match = fenced.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('parse_fail');
  return JSON.parse(match[0]);
};

async function callReviewer(prompt: string, images: string[], model: string, label: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const content: any[] = [{ type: 'text', text: `Review all ${images.length} media items. Return exactly ${images.length} ordered slide results.` }];
    images.forEach((base64, idx) => {
      content.push({ type: 'text', text: `SLIDE ${idx + 1}` });
      content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } });
    });
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content },
        ],
        temperature: 0,
        max_tokens: 3500,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${label}_api_${response.status}`);
    const payload = await response.json();
    const text = String(payload?.choices?.[0]?.message?.content || '');
    return extractJson(text);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModelA(raw: any): ModelASlideResult[] {
  if (!Array.isArray(raw?.slides)) return [];
  return raw.slides.map((slide: any) => ({
    index: Number(slide?.index || 0),
    category: String(slide?.category || 'uncertain') as VisionCategory,
    confidence: clampConfidence(slide?.confidence),
    tattooOnRealHumanSkin: slide?.tattooOnRealHumanSkin === true,
    tattooIsPrimarySubject: slide?.tattooIsPrimarySubject === true,
    evidence: String(slide?.evidence || '').slice(0, 240),
    safeFacts: Array.isArray(slide?.safeFacts)
      ? slide.safeFacts.map((fact: unknown) => String(fact).slice(0, 160)).filter(Boolean).slice(0, 6)
      : [],
  }));
}

function normalizeModelB(raw: any): ModelBSlideResult[] {
  if (!Array.isArray(raw?.slides)) return [];
  return raw.slides.map((slide: any) => ({
    index: Number(slide?.index || 0),
    decision: slide?.decision === 'approve' ? 'approve' : 'block',
    confidence: clampConfidence(slide?.confidence),
    riskFlags: Array.isArray(slide?.riskFlags)
      ? slide.riskFlags.map((flag: unknown) => String(flag).slice(0, 80)).filter(Boolean).slice(0, 8)
      : ['invalid_response'],
    reason: String(slide?.reason || '').slice(0, 240),
  }));
}

function hasCompleteOrderedResults(results: Array<{ index: number }>, expected: number): boolean {
  return results.length === expected && results.every((result, idx) => result.index === idx + 1);
}

/** Review all media belonging to one post and retain only mutually approved tattoo images. */
export async function classifyPostMedia(
  base64Images: string[],
  options: { kind?: VisionMediaKind } = {},
): Promise<VisionGateResult> {
  const images = base64Images.filter((image) => typeof image === 'string' && image.length > 100);
  if (!images.length || images.length !== base64Images.length) return failResult('missing_or_invalid_media', base64Images.length);
  if (!API_KEY) return failResult('no_api_key', images.length);

  let modelA: ModelASlideResult[] = [];
  let modelB: ModelBSlideResult[] = [];
  try {
    // Review each slide separately because the provider may reject multi-image requests.
    // A and B are still independent calls and B never receives A's answer.
    for (let start = 0; start < images.length; start += SLIDE_CONCURRENCY) {
      const batch = images.slice(start, start + SLIDE_CONCURRENCY);
      const reviewed = await Promise.all(batch.map(async (image, offset) => {
        const postIndex = start + offset + 1;
        const [rawA, rawB] = await Promise.all([
          callReviewer(MODEL_A_PROMPT, [image], MODEL_A, `model_a_slide_${postIndex}`),
          callReviewer(MODEL_B_PROMPT, [image], MODEL_B, `model_b_slide_${postIndex}`),
        ]);
        const a = normalizeModelA(rawA)[0];
        const b = normalizeModelB(rawB)[0];
        return {
          a: a ? { ...a, index: postIndex } : null,
          b: b ? { ...b, index: postIndex } : null,
        };
      }));
      for (const item of reviewed) {
        if (item.a) modelA.push(item.a);
        if (item.b) modelB.push(item.b);
      }
    }
  } catch (error: any) {
    const reason = String(error?.name === 'AbortError' ? 'vision_timeout' : error?.message || 'vision_exception');
    console.warn(`[vision-gate] ${reason}; block post`);
    return failResult(reason, images.length, modelA, modelB);
  }

  if (!hasCompleteOrderedResults(modelA, images.length)) return failResult('model_a_incomplete', images.length, modelA, modelB);
  if (!hasCompleteOrderedResults(modelB, images.length)) return failResult('model_b_incomplete', images.length, modelA, modelB);

  const tattooMediaIndexes: number[] = [];
  for (let idx = 0; idx < images.length; idx++) {
    const a = modelA[idx];
    const b = modelB[idx];
    const mutuallyApproved = ALLOWED_CATEGORIES.has(a.category)
      && a.tattooOnRealHumanSkin
      && a.tattooIsPrimarySubject
      && a.confidence >= MIN_CONFIDENCE
      && b.decision === 'approve'
      && b.confidence >= MIN_CONFIDENCE
      && b.riskFlags.length === 0;
    if (mutuallyApproved) tattooMediaIndexes.push(idx + 1);
  }

  const kind: VisionMediaKind = options.kind || (images.length === 1 ? 'single' : 'carousel');
  const requiredTattooImages = 1;
  if (tattooMediaIndexes.length < requiredTattooImages) {
    return failResult(kind === 'reel' ? 'reel_no_clear_tattoo' : 'no_clear_tattoo', images.length, modelA, modelB);
  }

  const approvedSet = new Set(tattooMediaIndexes);
  const safeFacts = [...new Set(modelA
    .filter((slide) => approvedSet.has(slide.index))
    .flatMap((slide) => slide.safeFacts))].slice(0, 12);
  if (!safeFacts.length) return failResult('no_safe_visual_facts', images.length, modelA, modelB);
  const approvedA = modelA.filter((slide) => approvedSet.has(slide.index));
  const approvedB = modelB.filter((slide) => approvedSet.has(slide.index));
  return {
    category: 'tattoo_artwork',
    confidence: Math.min(...approvedA.map((slide) => slide.confidence), ...approvedB.map((slide) => slide.confidence)),
    reason: 'clear_tattoo_detected',
    ok: true,
    mediaCount: images.length,
    modelA,
    modelB,
    tattooMediaIndexes,
    safeFacts,
  };
}

/** Backward-compatible single-image entry point. */
export async function classifyPostImage(base64Image: string): Promise<VisionGateResult> {
  return classifyPostMedia([base64Image]);
}

async function main() {
  const paths = process.argv.slice(2).filter((arg) => /\.(?:jpe?g|png|webp)$/i.test(arg));
  if (!paths.length) {
    console.log('Usage: npx tsx scripts/comment-vision-gate.ts <slide1.jpg> [slide2.png ...]');
    process.exitCode = 1;
    return;
  }
  const fs = await import('node:fs');
  const result = await classifyPostMedia(paths.map((file) => fs.readFileSync(file).toString('base64')));
  console.log(JSON.stringify(result, null, 2));
}

if (/comment-vision-gate\.(?:ts|js)$/i.test(process.argv[1] || '')) main();
