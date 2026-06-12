/**
 * Hook Vision Prompt Test Harness
 *
 * Usage:
 *   npx tsx scripts/_test_vision_prompt.ts                              # test all cached
 *   npx tsx scripts/_test_vision_prompt.ts --images=rp0.jpg,rp3.jpg     # test specific
 *
 * Reads images from data/hook_frames/cheyenne_tattooequipment/,
 * sends to SiliconFlow with the current VISION_PROMPT,
 * and shows parsed output + diff from known results.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

const SILICON_KEY = 'sk-xmbcggfeukuoaklrikpetpcvjsogvlauydikcufjhdaijtzt';
const SILICON_MODEL = 'Qwen/Qwen3-VL-32B-Thinking';
const SILICON_BASE = 'https://api.siliconflow.cn/v1';

const FRAMES_DIR = 'data/hook_frames/cheyenne_tattooequipment';
const HOOK_ANALYSIS = 'data/hook_analysis.json';
const HANDLE = 'cheyenne_tattooequipment';

// Mirror of parseVision from _hook_vision_ai.ts
const CONTENT_TYPES = ['finished_tattoo','product_shot','process_shot','lifestyle','promotional'];
const PRODUCT_CATEGORIES = ['needle','cartridge','machine','ink','grip','power_supply','paper','other_accessory'];
const HOOK_LABELS = ['needle_macro','skin_texture','machine_closeup','black_background','wipe_shot','artist_face','finished_result','dramatic_zoom','setup_process','tutorial_demo','before_after','lifestyle','ink_flow','color_saturation','bottle_macro','machine_sound','grip_closeup','hand_motion','skin_entry','line_precision','wipe_reveal','other'];

function isRef<T>(arr: readonly T[], v: unknown): v is T {
  return arr.includes(v as T);
}

function parseVision(text: string): any {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: 'no_json_in_response', raw: text.slice(0,200) };
  try {
    const p = JSON.parse(m[0]);
    return {
      contentType: isRef(CONTENT_TYPES, p.contentType) ? p.contentType : 'INVALID:' + p.contentType,
      productCategory: p.productCategory === null ? null : (isRef(PRODUCT_CATEGORIES, p.productCategory) ? p.productCategory : 'INVALID'),
      productDetail: p.productDetail || '',
      hook: isRef(HOOK_LABELS, p.hook) ? p.hook : 'INVALID',
      confidence: p.confidence ?? 0,
      reasoning: p.reasoning || '',
      emotion: p.emotion || '',
      style: p.style || '',
      technique: p.technique || '',
      tattooStyle: p.tattooStyle || '',
      placement: p.placement || '',
      colorScheme: p.colorScheme || '',
      size: p.size || '',
      skinTone: p.skinTone || '',
      photoQuality: p.photoQuality || '',
      healingStage: p.healingStage || '',
      lineQuality: p.lineQuality || '',
      saturationLevel: p.saturationLevel || '',
      designComplexity: p.designComplexity || '',
      colorPalette: p.colorPalette || '',
      contrastLevel: p.contrastLevel || '',
      compositionQuality: p.compositionQuality || '',
      anatomyAccuracy: p.anatomyAccuracy || '',
      shadingTechnique: p.shadingTechnique || '',
      lightingStyle: p.lightingStyle || '',
      perspective: p.perspective || '',
      packaging: p.packaging || '',
      cartridgeColor: p.cartridgeColor || '',
    };
  } catch {
    return { error: 'json_parse_fail', raw: m[0].slice(0,200) };
  }
}

function callSiliconFlow(imageB64: string, caption: string): any {
  const prompt = VISION_PROMPT + (caption ? `\nCaption: ${caption.slice(0,1000)}` : '');
  const body = JSON.stringify({
    model: SILICON_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } }
      ]
    }],
    max_tokens: 2000
  });
  try {
    const r = execSync(
      `curl -s --connect-timeout 30 --max-time 180 "${SILICON_BASE}/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer ${SILICON_KEY}" -d @-`,
      { input: body, encoding: 'utf8', timeout: 185000, maxBuffer: 10 * 1024 * 1024 }
    );
    const j = JSON.parse(r);
    if (j.error) return { error: j.error.message?.slice(0,80) || 'api_error' };
    const txt = j.choices?.[0]?.message?.content || '';
    if (!txt) return { error: 'empty_response' };
    let clean = txt.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').replace(/<answer>[\s\S]*?<\/answer>/g, '').trim();
    if (!clean) clean = txt;
    const parsed = parseVision(clean);
    if (parsed.error) parsed.raw = clean.slice(0,200);
    return parsed;
  } catch (e: any) {
    return { error: e.message?.slice(0,80) || 'exception' };
  }
}

function b64(filePath: string): string | null {
  try {
    const d = fs.readFileSync(filePath);
    return d.toString('base64');
  } catch { return null; }
}

const FIELD_ORDER = [
  'contentType','productCategory','productDetail','hook','confidence','reasoning',
  'emotion','style','technique','tattooStyle','placement','colorScheme','size',
  'skinTone','photoQuality','healingStage','lineQuality','saturationLevel',
  'designComplexity','colorPalette','contrastLevel','compositionQuality',
  'anatomyAccuracy','shadingTechnique','lightingStyle','perspective',
  'packaging','cartridgeColor'
];

function fmtVal(v: any, width: number): string {
  const s = v === null ? 'null' : String(v).slice(0, width - 2);
  return s.padEnd(width);
}

function main() {
  console.log('=== Vision Prompt Test Harness ===\n');

  // Load known results from hook_analysis.json for comparison
  const analyses = JSON.parse(fs.readFileSync(HOOK_ANALYSIS, 'utf8'));
  const cheyenne = analyses.find((h: any) => h.handle === HANDLE);
  if (!cheyenne) { console.log('No Cheyenne data found'); return; }

  const imageFilter = process.argv.find(a => a.startsWith('--images='))?.split('=')[1]?.split(',') || [];
  const allImages = imageFilter.length
    ? imageFilter
    : fs.readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg') && fs.statSync(path.join(FRAMES_DIR, f)).size > 500);

  console.log(`Testing ${allImages.length} images from ${FRAMES_DIR}\n`);

  // Map known analyses by postIndex
  const knownMap: Record<number, any> = {};
  for (const a of cheyenne.analyses) {
    if (a.postIndex !== undefined) knownMap[a.postIndex] = a;
  }

  for (const imgFile of allImages) {
    const idxMatch = imgFile.match(/rp(\d+)\.jpg/);
    const rpIdx = idxMatch ? parseInt(idxMatch[1]) : -1;
    const known = knownMap[rpIdx];
    const caption = known?.caption || '';

    const imgB64 = b64(path.join(FRAMES_DIR, imgFile));
    if (!imgB64) { console.log(`  ⚠️  ${imgFile}: read fail\n`); continue; }

    process.stdout.write(`  ${imgFile}${rpIdx >= 0 ? ` (RP${rpIdx})` : ''}... `);
    const result = callSiliconFlow(imgB64, caption);

    if (result.error) {
      console.log(`ERROR: ${result.error}\n`);
      if (result.raw) console.log(`  raw: ${result.raw}\n`);
      continue;
    }

    // Compare with known
    const knownFields = known ? {
      contentType: known.contentType,
      productCategory: known.productCategory,
      productDetail: known.productDetail,
      hook: known.hook,
      emotion: known.emotion,
      technique: known.technique,
      tattooStyle: known.tattooStyle,
      placement: known.placement,
    } : null;

    const diffCount = knownFields
      ? FIELD_ORDER.slice(0, 9).filter(f => String(result[f] || '') !== String((knownFields as any)[f] || '')).length
      : 0;

    console.log(`done (${diffCount} diffs in key fields)\n`);

    // Print key fields comparison
    console.log(`  ${'Field'.padEnd(20)} ${'Result'.padEnd(22)} ${'Known'.padEnd(22)}`);
    console.log(`  ${'─'.repeat(65)}`);
    for (const f of FIELD_ORDER) {
      const resultVal = f === 'confidence' ? result[f]?.toFixed(2) : result[f] === '' ? '(empty)' : String(result[f]||'');
      const knownVal = known
        ? (f === 'confidence' ? (known as any)[f]?.toFixed(2) : (known as any)[f] === '' ? '(empty)' : String((known as any)[f]||''))
        : '—';
      if (resultVal !== knownVal || f === 'contentType' || f === 'hook') {
        const marker = resultVal !== knownVal ? ' ⬅' : '';
        console.log(`  ${f.padEnd(20)} ${resultVal.padEnd(22)} ${knownVal.padEnd(22)}${marker}`);
      }
    }

    // Show empty fields warning
    const emptyFields = FIELD_ORDER.filter(f => result[f] === '');
    if (emptyFields.length > 0) {
      console.log(`  ⚠️  Empty fields: ${emptyFields.join(', ')}`);
    }

    // Show reasoning
    if (result.reasoning) {
      console.log(`  💬 ${result.reasoning.slice(0, 150)}`);
    }

    console.log();
  }

  console.log('=== Done ===');
}

// Load the VISION_PROMPT from the main script
const mainScript = fs.readFileSync('scripts/_hook_vision_ai.ts', 'utf8');
const promptMatch = mainScript.match(/const VISION_PROMPT = `([\s\S]*?)`;/);
if (!promptMatch) {
  console.error('ERROR: Could not extract VISION_PROMPT from _hook_vision_ai.ts');
  process.exit(1);
}
const VISION_PROMPT = promptMatch[1];

main();
