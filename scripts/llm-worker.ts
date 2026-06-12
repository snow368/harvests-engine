/* eslint-disable no-console */

type LlmTask = {
  id: string;
  pipeline: 'comment_pipeline' | 'content_pipeline';
  payload: any;
  attempts?: number;
  max_attempts?: number;
};

const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const POLL_INTERVAL_MS = Math.max(1500, Number(process.env.LLM_POLL_INTERVAL_MS || 4000));
const LLM_WORKER_ID = (process.env.LLM_WORKER_ID || 'llm_worker_01').trim();
const LLM_LEASE_MS = Math.max(10000, Number(process.env.LLM_LEASE_MS || 90000));

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const LLM_API_BASE = (process.env.LLM_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL_COMMENT = (process.env.LLM_MODEL_COMMENT || process.env.LLM_MODEL || 'gpt-4.1-mini').trim();
const MODEL_CONTENT = (process.env.LLM_MODEL_CONTENT || process.env.LLM_MODEL || 'gpt-4.1').trim();

let running = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const postJson = async (path: string, body: Record<string, any>) => {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`);
  return payload;
};

const getJson = async (path: string) => {
  const resp = await fetch(`${API_BASE}${path}`);
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`);
  return payload;
};

const callOpenAIText = async (model: string, prompt: string, temperature = 0.7) => {
  const resp = await fetch(`${LLM_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: 'You are a strict marketing assistant. Follow constraints exactly.' },
        { role: 'user', content: prompt }
      ]
    })
  });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`openai_${resp.status}: ${JSON.stringify(payload)}`);
  return String(payload?.choices?.[0]?.message?.content || '').trim();
};

const getBrandProfile = async () => {
  const data = await getJson('/api/llm/brand-profile');
  return data?.profile || {};
};

const containsBanned = (text: string, bannedWords: string[]) => {
  const lower = String(text || '').toLowerCase();
  return bannedWords.find((w) => lower.includes(String(w || '').toLowerCase())) || null;
};

const fallbackComment = (payload: any) => {
  const handle = String(payload?.artistHandle || 'artist');
  const lines = [
    'Clean linework and solid detail control on this piece.',
    'Great composition and very polished execution.',
    'Strong result. Really nice work.'
  ];
  return { artistHandle: handle, comment: lines[Math.floor(Math.random() * lines.length)], cta: 'soft' };
};

const generateComment = async (payload: any, brand: any) => {
  if (!OPENAI_API_KEY) return fallbackComment(payload);
  const banned = Array.isArray(brand?.bannedWords) ? brand.bannedWords : [];
  const prompt = `Write ONE concise Instagram comment for a tattoo shop post.
Rules:
- 8 to 22 words.
- Positive, specific, professional-friendly tone.
- No links, no contact info, no hard selling.
- No banned words: ${JSON.stringify(banned)}
Context:
- artistHandle: ${payload?.artistHandle || ''}
- postContext: ${payload?.postContext || ''}
Return JSON only: {"comment":"...","cta":"soft"}`;

  const out = await callOpenAIText(MODEL_COMMENT, prompt, 0.7);
  let parsed: any = {};
  try { parsed = JSON.parse(out); } catch {
    parsed = { comment: out.replace(/\s+/g, ' ').trim(), cta: 'soft' };
  }
  const comment = String(parsed?.comment || '').trim();
  if (!comment) throw new Error('empty_comment');
  if (comment.split(/\s+/).length > 28) throw new Error('comment_too_long');
  const bad = containsBanned(comment, banned);
  if (bad) throw new Error(`comment_contains_banned_${bad}`);
  return { artistHandle: payload?.artistHandle || '', comment, cta: 'soft' };
};

const fallbackContentPlan = (payload: any, brand: any) => {
  const days = Math.max(1, Math.min(30, Number(payload?.days || 7)));
  const primary = String(brand?.primaryLine || 'cartridge');
  const plan = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    platform: payload?.platform || 'instagram',
    topic: payload?.topic || 'showcase',
    format: i % 3 === 0 ? 'reel' : 'image_carousel',
    hook: `${primary} quick pro tip #${i + 1}`,
    cta: brand?.ctaStyle || 'soft_dm'
  }));
  return { days, plan };
};

const generateContent = async (payload: any, brand: any) => {
  if (!OPENAI_API_KEY) return fallbackContentPlan(payload, brand);
  const banned = Array.isArray(brand?.bannedWords) ? brand.bannedWords : [];
  const lines = Array.isArray(brand?.valueProps) ? brand.valueProps : [];
  const prompt = `Create a ${payload?.days || 7}-day content plan for ${payload?.platform || 'instagram'}.
Brand:
- name: ${brand?.brandName || ''}
- primaryLine: ${brand?.primaryLine || ''}
- productLines: ${JSON.stringify(brand?.productLines || [])}
- valueProps: ${JSON.stringify(lines)}
- tone: ${brand?.tone || 'professional_friendly'}
- ctaStyle: ${brand?.ctaStyle || 'soft_dm'}
Constraints:
- avoid banned words ${JSON.stringify(banned)}
- focus on tattoo cartridge buyers
- return concise actionable plan
Return JSON only:
{"days":number,"plan":[{"day":1,"platform":"instagram","topic":"...","format":"reel|image_carousel","hook":"...","caption":"...","cta":"..."}]}`;

  const out = await callOpenAIText(MODEL_CONTENT, prompt, 0.6);
  let parsed: any = {};
  try { parsed = JSON.parse(out); } catch {
    return fallbackContentPlan(payload, brand);
  }
  const plan = Array.isArray(parsed?.plan) ? parsed.plan : [];
  if (!plan.length) throw new Error('content_plan_empty');
  const textBlob = JSON.stringify(plan).toLowerCase();
  const bad = containsBanned(textBlob, banned);
  if (bad) throw new Error(`content_contains_banned_${bad}`);
  return { days: Number(parsed?.days || payload?.days || 7), plan };
};

const processTask = async (task: LlmTask) => {
  const brand = await getBrandProfile();
  if (task.pipeline === 'comment_pipeline') {
    const result = await generateComment(task.payload || {}, brand);
    await postJson('/api/llm/tasks/report', { taskId: task.id, status: 'done', result });
    return;
  }
  if (task.pipeline === 'content_pipeline') {
    const result = await generateContent(task.payload || {}, brand);
    await postJson('/api/llm/tasks/report', { taskId: task.id, status: 'done', result });
    return;
  }
  await postJson('/api/llm/tasks/report', { taskId: task.id, status: 'failed', reason: 'unknown_pipeline' });
};

const workerLoop = async (pipeline: 'comment_pipeline' | 'content_pipeline') => {
  while (running) {
    try {
      const next = await postJson('/api/llm/tasks/next', {
        pipeline,
        workerId: `${LLM_WORKER_ID}_${pipeline}`,
        leaseMs: LLM_LEASE_MS
      });
      const task = next?.task as LlmTask | null;
      if (!task) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      try {
        await processTask(task);
        console.log(`[llm-worker] done ${task.id} (${pipeline})`);
      } catch (e: any) {
        const reason = String(e?.message || 'llm_task_failed');
        await postJson('/api/llm/tasks/report', { taskId: task.id, status: 'failed', reason });
        console.error(`[llm-worker] failed ${task.id} (${pipeline}): ${reason}`);
      }
    } catch (e: any) {
      console.error(`[llm-worker] poll error (${pipeline}):`, e?.message || e);
      await sleep(POLL_INTERVAL_MS);
    }
  }
};

const shutdown = async (signal: string) => {
  console.log(`[llm-worker] shutdown on ${signal}`);
  running = false;
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

const main = async () => {
  console.log('[llm-worker] starting with config:', {
    API_BASE,
    LLM_WORKER_ID,
    POLL_INTERVAL_MS,
    LLM_LEASE_MS,
    modelComment: MODEL_COMMENT,
    modelContent: MODEL_CONTENT,
    hasOpenAiKey: Boolean(OPENAI_API_KEY)
  });
  await Promise.all([
    workerLoop('comment_pipeline'),
    workerLoop('content_pipeline')
  ]);
};

main().catch((e) => {
  console.error('[llm-worker] fatal:', e);
  process.exit(1);
});
