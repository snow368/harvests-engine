/**
 * vision-bench.ts — 识图模型盲测对比
 *
 * 同一批竞品 IG 图 + 同一 prompt，跑多个视觉模型，输出并排结果 + 打分表模板。
 * 设计原则：
 *  - provider 可插拔；缺 API key 的自动跳过（不报错）。
 *  - 图片先本地下载转 base64，避免各模型服务端拉 IG CDN 失败。
 *  - 5 维质量分（视觉风格准度/图中OCR/内容灵感可用度/中文输出/综合）由人眼填，
 *    脚本只自动记录 latency + 估算成本，方便横向比。
 *
 * 用法（VPS 海外，需先跑过 ig-monitor --baseline 灌 competitor_post）：
 *   npx tsx scripts/vision-bench.ts --n 8
 *
 * .env 里配哪些就比哪些：
 *   SENSENOVA_API_KEY        -> SenseNova 6.7-flash-lite
 *   GEMINI_API_KEY           -> Gemini 3 Flash
 *   OPENAI_API_KEY           -> GPT-5 mini
 *   DASHSCOPE_API_KEY        -> Qwen-VL (通义千问)
 *   AI_CORE_BASE / AI_CORE_AUTH -> 取竞品图（与 ig-monitor 同）
 */

import 'dotenv/config';
import fs from 'fs';

const AI_CORE_BASE = (process.env.AI_CORE_BASE || 'https://harvests-ai-core-api.inkflowapp.workers.dev').trim();
const AI_CORE_AUTH = (process.env.AI_CORE_AUTH || 'dev').trim();
const COMPETITOR_TENANT = process.env.COMPETITOR_TENANT || 'competitors:tattoo';
// 归一化：无论 .env 里写 "dev" 还是 "Bearer dev"，都拼成标准 "Bearer xxx"
const AI_CORE_AUTH_HEADER = 'Bearer ' + AI_CORE_AUTH.replace(/^Bearer\s+/i, '').trim();

const SENSENOVA_API_KEY = (process.env.SENSENOVA_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const DASHSCOPE_API_KEY = (process.env.DASHSCOPE_API_KEY || '').trim();

const SENSENOVA_MODEL = (process.env.SENSENOVA_VISION_MODEL || 'sensenova-6.7-flash-lite').trim();
const GEMINI_MODEL = (process.env.GEMINI_VISION_MODEL || 'gemini-3-flash').trim();
const OPENAI_MODEL = (process.env.OPENAI_VISION_MODEL || 'gpt-5-mini').trim();
const QWEN_MODEL = (process.env.QWEN_VL_MODEL || 'qwen-vl-plus').trim();

// 各模型每图粗略成本（USD），仅用于横向估算，按实际账单校准
const COST_PER_IMAGE: Record<string, number> = {
  sensenova: 0.0001,
  gemini: 0.0003,
  openai: 0.003,
  qwen: 0.0002,
};

const PROMPT = `You are a tattoo-supply brand content strategist. Analyze this competitor Instagram post image.
Output STRICTLY as a single JSON object (no markdown, no commentary) with these fields:
{
  "palette": ["up to 5 color names or hex"],
  "composition": "short description of layout / framing / how elements are arranged",
  "mood": "short vibe description (e.g. gritty, clean, playful)",
  "subject": "what is depicted (products / people / setting)",
  "brandingText": "any visible brand name / logo text / handle, or null if none",
  "contentInspiration": "2-3 sentence note on how we could draw inspiration for our own social posts"
}`;

type CallResult = { text: string; latencyMs: number };
type Provider = {
  id: string;
  label: string;
  enabled: boolean;
  model: string;
  costPerImage: number;
  call: (dataUrl: string, mime: string) => Promise<CallResult>;
};

// ── 图片下载（转 base64） ──────────────────────────────────────────────
async function fetchImageAsDataUrl(url: string): Promise<{ dataUrl: string; mime: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.instagram.com/' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get('content-type') || 'image/jpeg';
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime };
  } catch {
    return null;
  }
}

// ── 各 provider 实现 ──────────────────────────────────────────────────
async function postJson(url: string, headers: Record<string, string>, body: any): Promise<any> {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}

function makeSenseNova(): Provider {
  return {
    id: 'sensenova', label: `SenseNova (${SENSENOVA_MODEL})`, enabled: !!SENSENOVA_API_KEY,
    model: SENSENOVA_MODEL, costPerImage: COST_PER_IMAGE.sensenova,
    call: async (dataUrl) => {
      const t0 = Date.now();
      const d = await postJson('https://token.sensenova.cn/v1/chat/completions',
        { 'Content-Type': 'application/json', Authorization: `Bearer ${SENSENOVA_API_KEY}` },
        { model: SENSENOVA_MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }], max_tokens: 600 });
      return { text: d?.choices?.[0]?.message?.content || '', latencyMs: Date.now() - t0 };
    },
  };
}

function makeGemini(): Provider {
  return {
    id: 'gemini', label: `Gemini (${GEMINI_MODEL})`, enabled: !!GEMINI_API_KEY,
    model: GEMINI_MODEL, costPerImage: COST_PER_IMAGE.gemini,
    call: async (dataUrl, mime) => {
      const b64 = dataUrl.split(',')[1];
      const t0 = Date.now();
      const d = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        { 'Content-Type': 'application/json' },
        { contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }], generationConfig: { maxOutputTokens: 600 } });
      return { text: d?.candidates?.[0]?.content?.parts?.[0]?.text || '', latencyMs: Date.now() - t0 };
    },
  };
}

function makeOpenAI(base: string, key: string, id: string, label: string, model: string, cost: number): Provider {
  return {
    id, label, enabled: !!key, model, costPerImage: cost,
    call: async (dataUrl) => {
      const t0 = Date.now();
      const d = await postJson(`${base}/v1/chat/completions`,
        { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        { model, messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }], max_tokens: 600 });
      return { text: d?.choices?.[0]?.message?.content || '', latencyMs: Date.now() - t0 };
    },
  };
}

function buildProviders(): Provider[] {
  return [
    makeSenseNova(),
    makeGemini(),
    makeOpenAI('https://api.openai.com', OPENAI_API_KEY, 'openai', `GPT-5 (${OPENAI_MODEL})`, OPENAI_MODEL, COST_PER_IMAGE.openai),
    makeOpenAI('https://dashscope.aliyuncs.com/compatible-mode', DASHSCOPE_API_KEY, 'qwen', `Qwen-VL (${QWEN_MODEL})`, QWEN_MODEL, COST_PER_IMAGE.qwen),
  ];
}

// ── 取竞品图样本 ──────────────────────────────────────────────────────
async function fetchSampleImages(n: number): Promise<{ code: string; caption: string; imageUrl: string }[]> {
  const url = `${AI_CORE_BASE}/${encodeURIComponent(COMPETITOR_TENANT)}/memory?type=competitor_post&limit=200`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { headers: { Authorization: AI_CORE_AUTH_HEADER }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { console.warn(`[bench] AI Core ${r.status}，跳过取图`); return []; }
    const d: any = await r.json();
    const items: any[] = d?.items || [];
    const scored = items
      .map((it) => {
        const m = it.metadata || {};
        const imgs: string[] = m.image_urls || [];
        const eng = (Number(m.likes_count) || 0) + (Number(m.comments_count) || 0) * 3;
        return { eng, code: it.code, caption: m.caption || '', img: imgs[0] };
      })
      .filter((x) => x.img)
      .sort((a, b) => b.eng - a.eng)
      .slice(0, n);
    return scored.map((x) => ({ code: x.code, caption: x.caption, imageUrl: x.img }));
  } catch (e: any) {
    console.warn(`[bench] 取竞品图失败: ${e.message}，请确认 AI_CORE_BASE 可达且有 baseline 数据`);
    return [];
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main() {
  const n = parseInt(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] || '8', 10);
  const providers = buildProviders().filter((p) => p.enabled);
  const enabled = providers.map((p) => p.label);
  console.log(`[bench] enabled providers: ${enabled.length ? enabled.join(', ') : '(none — 配置 API key 后重跑)'}`);
  if (!providers.length) {
    console.log('[bench] 没有任何 provider 的 key，退出。');
    return;
  }

  console.log(`[bench] 拉取 top ${n} 竞品图...`);
  const samples = await fetchSampleImages(n);
  console.log(`[bench] 取到 ${samples.length} 张图`);
  if (!samples.length) {
    console.log('[bench] 没有 competitor_post 图片，请先在 VPS 跑 ig-monitor --baseline。');
    return;
  }

  const out: any = { generatedAt: new Date().toISOString(), prompt: PROMPT, results: [] };
  for (const s of samples) {
    console.log(`[bench] 处理 ${s.code} ...`);
    const img = await fetchImageAsDataUrl(s.imageUrl);
    const perProvider: Record<string, any> = {};
    if (img) {
      for (const p of providers) {
        try {
          const res = await p.call(img.dataUrl, img.mime);
          perProvider[p.id] = { text: res.text, latencyMs: res.latencyMs };
          console.log(`   ${p.label}: ${res.latencyMs}ms`);
        } catch (e: any) {
          perProvider[p.id] = { error: e.message };
          console.log(`   ${p.label}: ERROR ${e.message}`);
        }
      }
    } else {
      console.log(`   [skip] 图片下载失败`);
    }
    out.results.push({ code: s.code, caption: s.caption, imageUrl: s.imageUrl, providers: perProvider });
  }

  // 汇总表
  const summary = providers.map((p) => {
    const calls = out.results.map((r: any) => r.providers[p.id]).filter(Boolean);
    const ok = calls.filter((c: any) => c.latencyMs != null);
    const avgLat = ok.length ? Math.round(ok.reduce((a: number, c: any) => a + c.latencyMs, 0) / ok.length) : 0;
    return { provider: p.label, okCount: ok.length, avgLatencyMs: avgLat, estCostPer1k: `$${(p.costPerImage * 1000).toFixed(2)}` };
  });
  out.summary = summary;

  fs.mkdirSync('output', { recursive: true });
  fs.writeFileSync('output/vision_bench_output.json', JSON.stringify(out, null, 2));

  // 可读报告 + 人工打分表模板
  let md = `# 识图模型盲测报告\n\n生成时间: ${out.generatedAt}\n样本数: ${samples.length}\n\n`;
  md += `## 汇总（自动指标）\n\n| 模型 | 成功数 | 平均延迟 | 估算每千图成本 |\n|---|---|---|---|\n`;
  for (const s of summary) md += `| ${s.provider} | ${s.okCount} | ${s.avgLatencyMs}ms | ${s.estCostPer1k} |\n`;
  md += `\n## 人工打分表（请按 1-5 填写）\n\n| 图片 | ${providers.map((p) => p.label).join(' | ')} |\n`;
  md += `| --- | ${providers.map(() => '---').join(' | ')} |\n`;
  for (const r of out.results) {
    md += `| ${r.code} | ${providers.map((p) => `风格: / OCR: / 灵感: / 中文: / 综合:`).join(' | ')} |\n`;
  }
  md += `\n## 逐图原始输出\n\n`;
  for (const r of out.results) {
    md += `### ${r.code}\n${r.caption?.slice(0, 120) || ''}\n\n`;
    for (const p of providers) {
      const c = r.providers[p.id];
      md += `**${p.label}**\n\`\`\`json\n${c?.error ? 'ERROR: ' + c.error : c?.text || '(无输出)'}\n\`\`\`\n\n`;
    }
  }
  fs.writeFileSync('output/vision_bench_report.md', md);

  console.log('\n[bench] 完成 → output/vision_bench_output.json + output/vision_bench_report.md');
  console.log('[bench] 打开 report.md 按模板填 5 维打分，选出最佳模型后告诉我，我把它锁进 content_pipeline。');
}

main().catch((e) => { console.error('[bench] FATAL', e); process.exit(1); });
