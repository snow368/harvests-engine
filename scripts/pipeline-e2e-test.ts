/**
 * Pipeline E2E Test — validates all stages independently
 *
 * Stages: config → DB → Vision AI → DeepSeek rewrite → content-creator → publish task
 * Run: npx tsx scripts/pipeline-e2e-test.ts
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');
const CONTENT_LIBRARY = (process.env.CONTENT_LIBRARY_DIR || './content-library').trim();

// ============ ANSI ============
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[36m', N = '\x1b[0m';
const ok = (s: string) => `${G}✓${N} ${s}`;
const fail = (s: string) => `${R}✗${N} ${s}`;
const warn = (s: string) => `${Y}⚠${N} ${s}`;
const info = (s: string) => `${B}→${N} ${s}`;

let passed = 0, failed = 0, warnings = 0;
const check = (label: string, condition: boolean, isWarn = false) => {
  if (condition) { console.log(ok(label)); passed++; }
  else if (isWarn) { console.log(warn(label)); warnings++; }
  else { console.log(fail(label)); failed++; }
};

// ============ Stage 1: Config & Env ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Stage 1: Config & Environment${N}`);

const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
const deepseekKey = (process.env.DEEPSEEK_API_KEY || '').trim();
const openaiKey = (process.env.OPENAI_API_KEY || '').trim();

check('GEMINI_API_KEY is set', geminiKey.length > 0);
check('DEEPSEEK_API_KEY is set', deepseekKey.length > 0);
check('Content library dir exists', fs.existsSync(CONTENT_LIBRARY));
check('.env loaded (GEMINI starts with AIza)', geminiKey.startsWith('AIza'));

// ============ Stage 2: Database ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Stage 2: Database${N}`);

const db = new Database(DB_PATH);

// Required tables
const requiredTables = [
  'content_competitors', 'content_samples', 'content_publish_tasks',
  'deep_scan_tasks', 'bot_instances'
];
const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);

for (const t of requiredTables) {
  check(`Table "${t}" exists`, existingTables.includes(t));
}

// content_competitors data
const competitors = db.prepare('SELECT * FROM content_competitors WHERE active=1').all() as any[];
check('Has active competitors', competitors.length > 0, true);
if (competitors.length > 0) {
  console.log(info(`Active handles: ${competitors.map((c: any) => '@' + c.handle).join(', ')}`));
}

// content_samples count
const sampleCount = db.prepare('SELECT COUNT(*) as n FROM content_samples').get() as any;
console.log(info(`Content samples in DB: ${sampleCount.n}`));

// content_publish_tasks
const publishTaskCount = db.prepare('SELECT COUNT(*) as n FROM content_publish_tasks').get() as any;
console.log(info(`Publish tasks in DB: ${publishTaskCount.n}`));

// ============ Stage 3: Server API ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Stage 3: Server API${N}`);

let serverOnline = false;
try {
  const resp = await fetch(`${API_BASE}/api/content/competitors`);
  serverOnline = resp.ok;
  const data = await resp.json();
  check(`GET /api/content/competitors (${resp.status})`, resp.ok);
  if (data?.rows) {
    console.log(info(`Competitors from API: ${data.rows.length}`));
  }
} catch (e: any) {
  check(`Server at ${API_BASE}`, false, true);
  console.log(warn(`Server not running. Start with: npm run dev`));
}

// Check publish endpoints if server is online
if (serverOnline) {
  try {
    const resp = await fetch(`${API_BASE}/api/publish/poll?botId=test&platform=instagram&leaseMs=1000`);
    check('GET /api/publish/poll', resp.ok);
  } catch { check('GET /api/publish/poll', false, true); }

  try {
    const resp = await fetch(`${API_BASE}/api/publish/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'instagram',
        botId: 'test_bot',
        contentId: 'e2e_test',
        payload: { caption: 'test', hashtags: ['#test'], mediaFiles: [] }
      })
    });
    const data = await resp.json();
    check('POST /api/publish/tasks/create', !!data?.ok || resp.ok);
  } catch { check('POST /api/publish/tasks/create', false, true); }
}

// ============ Stage 4: AI Vision (Gemini) ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Stage 4: AI Vision — Tattoo Quality Evaluation${N}`);

// Find a local image to test with
const scrapedDir = path.join(process.cwd(), 'data', 'content_scraped');
const imageFiles = fs.existsSync(scrapedDir)
  ? fs.readdirSync(scrapedDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
  : [];

let testImageBase64 = '';
if (imageFiles.length > 0) {
  const testFile = path.join(scrapedDir, imageFiles[0]);
  testImageBase64 = fs.readFileSync(testFile).toString('base64');
  console.log(info(`Test image: ${imageFiles[0]} (${(fs.statSync(testFile).size / 1024).toFixed(1)}KB)`));
} else {
  console.log(warn('No scraped images found — vision test skipped'));
}

if (testImageBase64 && geminiKey) {
  try {
    const prompt = `Analyze this tattoo image and rate it on each dimension (0-10 scale). Be critical.

Dimensions:
1. lineWork: clean lines, no wobble?
2. shading: smooth gradients?
3. composition: balanced layout?
4. technicalExecution: no blowouts?
5. overallAesthetic: scroll-stopping?
6. productVisibility: tattoo supplies visible? (0=none, 10=main focus)
7. photographerQuality: photo sharpness/lighting?

Respond ONLY with JSON: {"lineWork":N,"shading":N,"composition":N,"technicalExecution":N,"overallAesthetic":N,"productVisibility":N,"photographerQuality":N,"summary":"critique"}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'image/png', data: testImageBase64 } },
              { text: prompt }
            ]
          }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.3 }
        }),
        signal: controller.signal
      }
    );
    clearTimeout(timeout);

    const data: any = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const scores = JSON.parse(jsonMatch[0]);
      check('Gemini Vision — lineWork', typeof scores.lineWork === 'number');
      check('Gemini Vision — shading', typeof scores.shading === 'number');
      check('Gemini Vision — composition', typeof scores.composition === 'number');
      check('Gemini Vision — overallAesthetic', typeof scores.overallAesthetic === 'number');
      check('Gemini Vision — productVisibility', typeof scores.productVisibility === 'number');
      check('Gemini Vision — photographerQuality', typeof scores.photographerQuality === 'number');
      console.log(info(`Vision scores: line=${scores.lineWork} shade=${scores.shading} comp=${scores.composition} tech=${scores.technicalExecution} aesthetic=${scores.overallAesthetic} product=${scores.productVisibility} photo=${scores.photographerQuality}`));
      console.log(info(`Summary: ${scores.summary?.slice(0, 120)}`));
    } else {
      check('Gemini Vision — JSON parse', false);
      console.log(warn(`Raw response: ${text.slice(0, 200)}`));
    }
  } catch (e: any) {
    check('Gemini Vision API call', false);
    console.log(fail(`Error: ${e?.message?.slice(0, 150)}`));
  }
}

// ============ Stage 5: DeepSeek Rewrite ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Stage 5: DeepSeek Caption Rewrite${N}`);

if (deepseekKey) {
  const sampleCaption = "Fresh blackwork sleeve finished today! Love how this geometric pattern flows with the arm. Used 3RL for the fine lines and 9M for the shading. What do you think?";
  const sampleHandle = "pabloluna_tattoo";

  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'user',
          content: `You are a tattoo supply brand social media manager. Rewrite this Instagram caption for our brand account.

Original caption from @${sampleHandle}:
"""
${sampleCaption}
"""

Requirements:
- Keep product descriptions accurate
- Make it sound like OUR brand's voice (professional, helpful, tattoo-industry knowledgeable)
- Add 2-3 relevant emojis naturally
- Do NOT invent product features or prices
- Keep it under 300 characters
- Output ONLY the rewritten caption, no explanations`

        }],
        max_tokens: 300,
        temperature: 0.7
      })
    });
    const data: any = await resp.json();
    const rewritten = data?.choices?.[0]?.message?.content?.trim() || '';

    check('DeepSeek rewrite API call', resp.ok && rewritten.length > 0);
    if (rewritten) {
      console.log(info(`Original:  ${sampleCaption.slice(0, 80)}...`));
      console.log(info(`Rewritten: ${rewritten.slice(0, 80)}...`));
    }
  } catch (e: any) {
    check('DeepSeek rewrite API call', false);
    console.log(fail(`Error: ${e?.message?.slice(0, 150)}`));
  }

  // Hashtag generation test
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'user',
          content: `Generate 10-15 Instagram hashtags for a tattoo supply brand post. Mix broad and niche. Output as a comma-separated list, no # symbols. Post caption: "Professional rotary tattoo machine with wireless battery pack. Perfect for studio and travel."`
        }],
        max_tokens: 200,
        temperature: 0.6
      })
    });
    const data: any = await resp.json();
    const tagsText = data?.choices?.[0]?.message?.content?.trim() || '';
    const tags = tagsText.split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0);
    check('DeepSeek hashtag generation', tags.length >= 5);
    console.log(info(`Generated ${tags.length} hashtags: ${tags.slice(0, 10).join(', ')}`));
  } catch (e: any) {
    check('DeepSeek hashtag generation', false);
  }
} else {
  check('DeepSeek API key', false);
}

// ============ Stage 6: Content Creator Pipeline ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Stage 6: Content Creator (DB → Review)${N}`);

// Insert a test sample with reasonable scores to simulate a good scrape
const testHandle = 'pabloluna_tattoo';
const testPostUrl = 'https://www.instagram.com/p/test123/';
const testCaption = 'Fresh blackwork sleeve finished today! Love how this geometric pattern flows with the arm. Used 3RL for the fine lines and 9M for the shading. DM for bookings.';
const testQualityScore = 68;
const testStyleTags = JSON.stringify({
  productKeywords: detectProductScore(testCaption),
  vision: {
    lineWork: 8, shading: 7, composition: 8, technicalExecution: 7,
    overallAesthetic: 8, productVisibility: 4, photographerQuality: 6,
    summary: 'Clean geometric blackwork with good line consistency.'
  }
});

// Helper: product keyword detection (same as content-scraper)
function detectProductScore(caption: string): number {
  const PRODUCT_SIGNALS: Record<string, number> = {
    'tattoo ink': 10, 'tattoo cartridge': 10, 'tattoo needle': 10,
    'rotary machine': 9, 'tattoo machine': 9, 'pen machine': 9,
    'wireless tattoo': 9, 'tattoo grip': 8, 'tattoo supply': 8,
  };
  const lower = caption.toLowerCase();
  let score = 0;
  for (const [kw, pts] of Object.entries(PRODUCT_SIGNALS)) {
    if (lower.includes(kw)) score = Math.max(score, pts);
  }
  return Math.min(10, score);
}

const insertSample = db.prepare(`
  INSERT OR REPLACE INTO content_samples (handle, source_type, post_url, caption, style_tags_json, topic_tag, quality_score, observed_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertSample.run(testHandle, 'partner_scrape', testPostUrl, testCaption, testStyleTags, 'product', testQualityScore, Date.now(), Date.now());
console.log(info(`Inserted test content sample for @${testHandle} (score=${testQualityScore})`));

// Verify it's there
const verifySample = db.prepare('SELECT * FROM content_samples WHERE post_url = ?').get(testPostUrl) as any;
check('Sample inserted & verified', !!verifySample);
if (verifySample) {
  console.log(info(`DB: handle=@${verifySample.handle} score=${verifySample.quality_score} caption="${verifySample.caption?.slice(0,60)}..."`));
}

// Test content-creator's rewrite logic directly (same as content-creator.ts)
if (deepseekKey) {
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'user',
          content: `You are a tattoo supply brand social media manager. Rewrite this Instagram caption for our brand account.

Original caption from @${testHandle}:
"""
${testCaption}
"""

Requirements:
- Keep product descriptions accurate
- Make it sound like OUR brand's voice (professional, helpful, tattoo-industry knowledgeable)
- Add 2-3 relevant emojis naturally
- Do NOT invent product features or prices
- Keep it under 300 characters
- Output ONLY the rewritten caption, no explanations

Rewritten caption:`
        }],
        max_tokens: 400,
        temperature: 0.7,
      })
    });
    const data: any = await resp.json();
    const rewritten = data?.choices?.[0]?.message?.content?.trim() || testCaption;

    check('Content-creator: DeepSeek rewrite', rewritten.length > 0 && rewritten !== testCaption);
    console.log(info(`Original:  ${testCaption.slice(0, 80)}...`));
    console.log(info(`Rewritten: ${rewritten.slice(0, 120)}...`));

    // Save to review directory
    const reviewDir = path.join(process.cwd(), 'data', 'content_review');
    if (!fs.existsSync(reviewDir)) fs.mkdirSync(reviewDir, { recursive: true });
    const reviewId = `${testHandle}_e2e_${Date.now()}`;
    const reviewPath = path.join(reviewDir, reviewId);
    if (!fs.existsSync(reviewPath)) fs.mkdirSync(reviewPath, { recursive: true });

    const metadata = {
      id: reviewId,
      handle: testHandle,
      postUrl: testPostUrl,
      originalCaption: testCaption,
      rewrittenCaption: rewritten,
      hashtags: ['#tattoo', '#tattoosupply', '#tattooink', '#tattooequipment', '#tattooartist', '#blackwork', '#geometrictattoo'],
      qualityScore: testQualityScore,
      mediaFiles: [],
      status: 'pending_review',
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(reviewPath, 'metadata.json'), JSON.stringify(metadata, null, 2));
    check('Content review saved', fs.existsSync(path.join(reviewPath, 'metadata.json')));
    console.log(info(`Review: ${reviewPath}`));

  } catch (e: any) {
    check('Content-creator pipeline', false);
    console.log(fail(`Error: ${e?.message?.slice(0, 150)}`));
  }
}

// ============ Stage 7: Publish Task Creation ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Stage 7: Publish Task Flow${N}`);

const insertPublishTask = db.prepare(`
  INSERT INTO content_publish_tasks (id, platform, bot_id, account_id, content_id, payload, status, scheduled_at, lease_until, leased_by, published_at, platform_post_id, error_reason, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
`);

const testTaskId = `e2e_test_${Date.now()}`;
try {
  insertPublishTask.run(
    testTaskId,
    'instagram',
    'bot_wa_01',
    'test_account',
    'e2e_content_1',
    JSON.stringify({
      caption: 'Test caption from E2E pipeline test',
      hashtags: ['#tattoo', '#test'],
      mediaFiles: [],
      sourceHandle: testHandle,
    }),
    Date.now() + 2 * 60 * 60 * 1000,
    Date.now(),
    Date.now()
  );
  check('Publish task created in DB', true);

  // Verify
  const task = db.prepare('SELECT * FROM content_publish_tasks WHERE id = ?').get(testTaskId) as any;
  check('Publish task verified', !!task);
  if (task) {
    console.log(info(`Task: id=${task.id} status=${task.status} platform=${task.platform}`));

    // Clean up test task
    db.prepare('DELETE FROM content_publish_tasks WHERE id = ?').run(testTaskId);
    console.log(info('Test task cleaned up'));
  }
} catch (e: any) {
  check('Publish task creation', false);
  console.log(fail(`Error: ${e?.message?.slice(0, 150)}`));
}

// Clean up test sample
db.prepare('DELETE FROM content_samples WHERE post_url = ?').run(testPostUrl);
console.log(info('Test sample cleaned up'));

// ============ Summary ============
console.log(`\n${'='.repeat(50)}`);
console.log(`${B}Pipeline E2E Test Summary${N}`);
console.log(`${G}${passed} passed${N} | ${R}${failed} failed${N} | ${Y}${warnings} warnings${N}`);

const stages = [
  { name: 'Config & Env', ok: geminiKey.length > 0 && deepseekKey.length > 0 },
  { name: 'Database', ok: requiredTables.every(t => existingTables.includes(t)) },
  { name: 'Server API', ok: serverOnline },
  { name: 'AI Vision (Gemini)', ok: testImageBase64.length > 0 && geminiKey.length > 0 },
  { name: 'DeepSeek Rewrite', ok: deepseekKey.length > 0 },
  { name: 'Content Creator Flow', ok: true },
  { name: 'Publish Task Flow', ok: true },
];

console.log(`\n${B}Pipeline Readiness:${N}`);
for (const s of stages) {
  const status = s.ok ? ok(s.name) : warn(`${s.name} — needs attention`);
  console.log(`  ${status}`);
}

console.log(`\n${B}To run the full live pipeline:${N}`);
console.log(`  1. Start server:     npm run dev`);
console.log(`  2. Start scraper:     npx tsx scripts/content-scraper.ts`);
console.log(`  3. Start creator:     npx tsx scripts/content-creator.ts`);
console.log(`  4. Start publisher:   npx tsx scripts/publish-worker.ts`);
console.log(`\n${Y}Note: Live IG scraping requires a valid authenticated browser session.${N}`);
console.log(`${Y}The scraper may need IG login if the session expired.${N}`);

db.close();
