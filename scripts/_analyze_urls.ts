/**
 * Direct URL analysis — skip collection, just visit + download + analyze
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';
const OUTPUT_FILE = 'data/kwadron_curated.json';

const SILICON_KEY = 'sk-xmbcggfeukuoaklrikpetpcvjsogvlauydikcufjhdaijtzt';
const SILICON_MODEL = 'Qwen/Qwen3-VL-30B-A3B-Instruct';
const SILICON_BASE = 'https://api.siliconflow.cn/v1';

const URLS = [
  'https://www.instagram.com/kwadron/p/DYCKPh1Ck6-/',
  'https://www.instagram.com/kwadron/reel/DXjBXb0iFli/',
  'https://www.instagram.com/kwadron/p/DXGspjMjTS1/',
  'https://www.instagram.com/kwadron/reel/DXHAEdoiZLi/',
  'https://www.instagram.com/kwadron/reel/DW8qBB_Deca/',
  'https://www.instagram.com/kwadron/p/DWvcpSAjQij/',
  'https://www.instagram.com/kwadron/reel/DWs8rx6DVnV/',
  'https://www.instagram.com/kwadron/p/DWjDJbmCgdx/',
  'https://www.instagram.com/kwadron/reel/DVyPmI6gSd5/',
  'https://www.instagram.com/kwadron/p/DV_Ay0wimMK/',
  'https://www.instagram.com/kwadron/reel/DVdeKlRERPa/',
  'https://www.instagram.com/kwadron/reel/DUtzufVCHde/',
  'https://www.instagram.com/kwadron/p/DUaa989Ci63/',
  'https://www.instagram.com/kwadron/p/DUDNbZ5Co0f/',
  'https://www.instagram.com/kwadron/p/DUK1RYmlQRo/',
  'https://www.instagram.com/kwadron/p/DT-FEWoikH8/',
  'https://www.instagram.com/kwadron/p/DTmyIOGCZDH/',
  'https://www.instagram.com/kwadron/reel/DTfSWiPiYCn/',
  'https://www.instagram.com/kwadron/reel/DTKrJmtgvp0/',
  'https://www.instagram.com/kwadron/reel/DS4pmMsgqNr/',
  'https://www.instagram.com/kwadron/reel/DTC82MPFdS3/',
  'https://www.instagram.com/kwadron/reel/DSKu0ehDbOd/',
  'https://www.instagram.com/kwadron/p/DSAbiYJj_Zw/',
  'https://www.instagram.com/kwadron/reel/DR7R8NJCLkp/',
  'https://www.instagram.com/black.minimal.tattoo/reel/DRXhV1eDUYQ/',
  'https://www.instagram.com/kwadron/reel/DRFh-pMD1jX/',
  'https://www.instagram.com/kwadron/p/DQEg82DiLPs/',
];

const VISION_PROMPT = `你是一个纹身行业内容分析专家。分析这张图片和文案，输出结构化分类。

第一层 — 内容类型（contentType）:
- finished_tattoo: 成品纹身展示
- product_shot: 产品本身展示
- process_shot: 纹身操作过程
- lifestyle: 工作室环境/日常生活
- promotional: 营销推广

第二层 — productCategory:
- needle / cartridge / machine / ink / grip / power_supply / paper / other_accessory

第三层 — productDetail:
当 productCategory=needle/cartridge 时，识别规格: {gauge}{count}{type}_{taper}
例: 1003RL_LT

cartridgeColor: 针头外壳配色
- black_gold(黑金)/black/white/clear/translucent_blue/translucent_pink/frosted/rainbow/metal/other

hook（视觉构图）: needle_macro / machine_closeup / finished_result / skin_entry / setup_process / color_saturation / wipe_reveal / artist_face / tutorial_demo / dramatic_zoom / lifestyle / other

emotion: prestige / underground / luxury / satisfying / educational / trendy / funny
style: dark_mood / bright_clean / high_contrast / soft_natural / colorful / minimal

audio（可见音乐信息）: 歌名+艺人，不可见留空。

technique: shading / pack / line / pointillism / realism / color_pack / unknown

tattooStyle: realism / traditional / blackwork / geometric / dotwork / watercolor / japanese / neotrad / trash_polka / lettering / unknown

placement: full_sleeve / half_sleeve / forearm / upper_arm / leg / thigh / calf / back / chest / ribs / hand / neck / face / other

colorScheme: black_grey / color / watercolor / negative_space / selective_color

size: micro / small / medium / large / full

skinTone: fair / medium / olive / dark / black / unknown

photoQuality: studio / professional / phone_good / phone_average / phone_blurry

healingStage: fresh / healing / fully_healed / unknown

lineQuality（线条功底）: crisp / uneven / masterful / geometric_precision
saturationLevel: low / medium / high / dense
designComplexity: simple / moderate / complex / masterpiece
colorPalette: warm / cool / neutral / monochrome / complementary / contrasting
contrastLevel: low / medium / high

compositionQuality: weak / balanced / strong / masterful
anatomyAccuracy: poor / fair / good / excellent
shadingTechnique: smooth / stippled / crosshatch / dynamic
lightingStyle: flat / natural / dramatic / artistic
perspective: flat / basic / advanced

返回JSON: {"contentType":"","productCategory":null,"productDetail":"","cartridgeColor":"","hook":"","confidence":0,"reasoning":"","emotion":"","style":"","audio":"","technique":"","tattooStyle":"","placement":"","colorScheme":"","size":"","skinTone":"","photoQuality":"","healingStage":"","lineQuality":"","saturationLevel":"","designComplexity":"","colorPalette":"","contrastLevel":"","compositionQuality":"","anatomyAccuracy":"","shadingTechnique":"","lightingStyle":"","perspective":""}`;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function visionViaSiliconFlow(base64Image: string, caption: string): any {
  try {
    const body = JSON.stringify({
      model: SILICON_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT + (caption ? `\nCaption: ${caption.slice(0,1000)}` : '') },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ]
      }],
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    });
    const r = execSync(
      `curl -s --connect-timeout 30 --max-time 60 "${SILICON_BASE}/chat/completions" -H "Content-Type: application/json" -H "Authorization: Bearer ${SILICON_KEY}" -d @-`,
      { input: body, encoding: 'utf8', timeout: 65000, maxBuffer: 10 * 1024 * 1024 }
    );
    const j = JSON.parse(r);
    if (j.error) return { hook: 'pending', reasoning: j.error.message?.slice(0,80) || 'api_error' };
    const txt = j.choices?.[0]?.message?.content || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { hook: 'pending', reasoning: 'no_json' };
    return JSON.parse(m[0]);
  } catch (e: any) {
    return { hook: 'pending', reasoning: e.message?.slice(0,80) || 'error' };
  }
}

async function main() {
  console.log(`=== Custom URL Analysis ===`);
  console.log(`Model: ${SILICON_MODEL}`);
  console.log(`Target: ${URLS.length} Kwadron posts\n`);

  // Kill any hanging Chrome
  try { execSync('taskkill /F /IM chrome.exe 2>nul', { stdio:'ignore' }); } catch {}
  try { execSync('taskkill /F /IM chromium.exe 2>nul', { stdio:'ignore' }); } catch {}
  await sleep(3000);

  // Clean profile locks
  for (const f of ['SingletonLock','SingletonSocket','SingletonCookie']) {
    const p = path.join(PROFILE_DIR, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true, args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setDefaultTimeout(15000);

  // Check login
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const loggedIn = !(await page.locator('input[name="username"]').count().catch(() => 0));
  if (!loggedIn) {
    console.log('❌ Not logged in.');
    await browser.close();
    return;
  }
  console.log('Logged in!\n');

  const results: any[] = [];

  for (const [i, url] of URLS.entries()) {
    const slug = url.match(/\/p\/([\w-]+)/)?.[1] || url.match(/\/reel\/([\w-]+)/)?.[1] || `post_${i}`;
    process.stdout.write(`[${i+1}/${URLS.length}] ${slug}... `);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      // Get caption
      let caption = '';
      try {
        const capEl = page.locator('h1').or(page.locator('span._ap3a')).or(page.locator('div._a9zr')).first();
        if (await capEl.count()) caption = (await capEl.textContent()) || '';
      } catch {}

      // Get image URL
      let imgUrl = '';
      try {
        const og = page.locator('meta[property="og:image"]');
        if (await og.count()) imgUrl = (await og.getAttribute('content')) || '';
        if (!imgUrl) {
          imgUrl = await page.evaluate(() => {
            const imgs = document.querySelectorAll<HTMLImageElement>('img[src*="cdninstagram"], img[src*="fbcdn"]');
            for (const img of imgs) {
              const s = img.src || img.getAttribute('data-src') || '';
              if (s) return s;
            }
            return '';
          });
        }
        if (!imgUrl) {
          const poster = page.locator('video[poster]').first();
          if (await poster.count()) imgUrl = (await poster.getAttribute('poster')) || '';
        }
      } catch {}

      if (!imgUrl) {
        console.log('⚠️ no image');
        results.push({ url, slug, error: 'no_image' });
        continue;
      }

      // Download image via browser fetch (uses Instagram login cookies)
      let base64 = '';
      try {
        base64 = await page.evaluate(async (imageUrl) => {
          const resp = await fetch(imageUrl);
          const blob = await resp.blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result as string;
              resolve(result.split(',')[1]); // strip data:image/...;base64,
            };
            reader.readAsDataURL(blob);
          });
        }, imgUrl);
      } catch {}

      if (!base64) {
        console.log('⚠️ download failed');
        results.push({ url, slug, error: 'download_failed' });
        continue;
      }

      // Analyze via SiliconFlow
      const a = visionViaSiliconFlow(base64, caption);
      if (a.hook === 'pending') {
        console.log(`⚠️ ${a.reasoning?.slice(0,40)}`);
        results.push({ url, slug, error: a.reasoning });
      } else {
        console.log(`→ ${a.contentType} | ${a.hook} (${((a.confidence||0)*100).toFixed(0)}%) | cc=${a.cartridgeColor||'-'}`);
        results.push({ url, slug, ...a });
      }
    } catch (e: any) {
      console.log(`⚠️ ${e.message?.slice(0,40)}`);
      results.push({ url, slug, error: e.message?.slice(0,80) });
    }

    await sleep(1500);
  }

  await browser.close();

  // Save results
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\n✅ Saved ${results.length} results to ${OUTPUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
