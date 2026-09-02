/**
 * IG Scheduler Lite — Cloud D1 版（无 Neon 依赖）
 * 从 Cloud API (D1) 读取 artists → 创建任务到 Cloud API Worker (D1)
 * Bot worker 直接从 D1 poll 任务，不再需要本地 server / Neon。
 * 用法: npx tsx scripts/ig-scheduler-lite.ts
 *
 * ENV:
 *   CLOUD_API_BASE        — Cloud API Worker 地址（默认 https://harvests-cloud-api.inkflowapp.workers.dev）
 *   BOT_API_TOKEN         — VPS bot 密钥（须与 cloud-api 的 BOT_API_TOKEN 一致）
 *   SCHEDULER_DAILY_LIMIT — 日配额（默认 80）
 *   SCHEDULER_BOT_ID      — 目标 bot（默认 bot_ig_01）
 *   SCHEDULER_STATE       — 目标州代码（默认 ALL=不限；设 'OR' 等则只排该州 artists）
 *   SCHEDULER_BATCH_SIZE  — 每批抓取数（默认 10）
 */

import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
const BOT_ID = process.env.SCHEDULER_BOT_ID || 'bot_ig_01';
const DAILY_LIMIT = Number(process.env.SCHEDULER_DAILY_LIMIT) || 80;
const BATCH_SIZE = Math.min(20, Math.max(1, Number(process.env.SCHEDULER_BATCH_SIZE) || 10));
const TARGET_STATE = (process.env.SCHEDULER_STATE || 'ALL').trim().toUpperCase();
// 多州定向（西语浓度高州测试用）：SCHEDULER_STATES='TX,CA,FL' 优先于单州 SCHEDULER_STATE
const TARGET_STATES = (process.env.SCHEDULER_STATES || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const CLOUD_API_BASE = (process.env.CLOUD_API_BASE || 'https://harvests.pages.dev').replace(/\/+$/, '');
const BOT_API_TOKEN = (process.env.BOT_API_TOKEN || 'vps-bot-secret-2024').trim();

const ENV_PATH = path.resolve(process.cwd(), '.env');

// ============ Load .env ============
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

// ============ Fetch artists from Cloud API (D1) ============
async function fetchArtists(limit = 200): Promise<any[]> {
  try {
    const resp = await fetch(`${CLOUD_API_BASE}/api/automation/artists?limit=${limit}`);
    if (!resp.ok) {
      console.error(`[ig-scheduler] artists API error ${resp.status}`);
      return [];
    }
    const data = await resp.json() as any;
    const items: any[] = data?.items || [];
    // 州过滤：SCHEDULER_STATES（多州，如 'TX,CA,FL'）优先；否则 SCHEDULER_STATE 单州；ALL 不过滤
    const filtered = (TARGET_STATE === 'ALL' && !TARGET_STATES.length)
      ? items
      : items.filter((a: any) => {
          const st = String(a.state || '').toUpperCase();
          if (TARGET_STATES.length) return TARGET_STATES.includes(st);
          return st === TARGET_STATE;
        });
    return filtered;
  } catch (e: any) {
    console.error('[ig-scheduler] fetch artists failed:', e?.message?.slice(0, 80));
    return [];
  }
}

async function main() {
  // Derive maturity from the real binding date. The old new/0d payload made
  // mature accounts pause after every profile.
  const boundAt = String(process.env.SCHEDULER_ACCOUNT_BOUND_AT || process.env.BOT_ACCOUNT_BOUND_AT || '').trim();
  const boundMs = boundAt ? Date.parse(boundAt) : NaN;
  const acctAgeDays = Number.isFinite(boundMs)
    ? Math.max(0, Math.floor((Date.now() - boundMs) / 86400_000))
    : 0;
  const inferredStage = acctAgeDays < 7 ? 'new' : acctAgeDays < 30 ? 'transition' : acctAgeDays < 60 ? 'growing' : 'mature';
  const dbStage = inferredStage;
  const dbSpeed = 2.5;

  const autoStage = 'new';
  const autoLimit = DAILY_LIMIT;
  const autoSpeed = 2.5;

  const acctStage = process.env.SCHEDULER_STAGE || dbStage || autoStage;
  const effectiveLimit = Number(process.env.SCHEDULER_DAILY_LIMIT) || autoLimit;
  const acctSpeed = Number(process.env.SCHEDULER_SPEED_FACTOR) || dbSpeed || autoSpeed;

  // 2026-08-06：从 D1 读该 bot 的用户动作偏好（前台「动作偏好」面板保存的），
  // 生成任务时写进 payload，bot 按 likes/comments/follows 次数执行 → 前台设置真正生效。
  // 读不到偏好时回退：likes=2, comments=1, follows=0（默认），且按账号阶段定模式。
  let prefs: any = null;
  try {
    const pRes = await fetch(`${CLOUD_API_BASE}/api/automation/bot-prefs/by-bot?botId=${encodeURIComponent(BOT_ID)}&token=${BOT_API_TOKEN}`);
    if (pRes.ok) {
      const pData = await pRes.json() as any;
      if (pData?.prefs) prefs = pData.prefs;
    }
  } catch (e: any) {
    console.error('[ig-scheduler] fetch bot-prefs failed:', e?.message?.slice(0, 80));
  }
  const likesPer = prefs ? (Number(prefs.likesPerSession) || 0) : 2;
  const commentsOverride = Number(process.env.SCHEDULER_COMMENTS_PER_SESSION);
  const commentsPer = Number.isFinite(commentsOverride)
    ? Math.max(0, Math.min(2, Math.round(commentsOverride)))
    : (prefs ? (Number(prefs.commentsPerSession) || 0) : 1);
  const followsPer = prefs ? (Number(prefs.followsPerSession) || 0) : 0;
  // 互动总开关：全 0 或未配置 → browse_only（只浏览）；任一 > 0 → browse_like（真互动）
  const hasInteraction = likesPer > 0 || commentsPer > 0 || followsPer > 0;
  console.log(`[ig-scheduler] bot-prefs: likes=${likesPer} comments=${commentsPer} follows=${followsPer} → ${hasInteraction ? 'browse_like' : 'browse_only'}`);

  const today = new Date().toISOString().slice(0, 10);
  const startOfDay = new Date(today).getTime();

  // 今日配额 — 从 Cloud API 读 D1 统计
  let todayCount = 0;
  try {
    const resp = await fetch(`${CLOUD_API_BASE}/api/tasks/count?botId=${encodeURIComponent(BOT_ID)}&token=${BOT_API_TOKEN}`);
    if (resp.ok) {
      const data = await resp.json() as any;
      todayCount = Number(data?.todayCount || 0);
    }
  } catch (e: any) {
    console.error('[ig-scheduler] quota check failed:', e?.message?.slice(0, 80));
  }
  const remaining = effectiveLimit - todayCount;
  if (remaining <= 0) {
    console.log(`[ig-scheduler] Quota used (${todayCount}/${effectiveLimit}, stage=${acctStage})`);
    return;
  }

  // 从 Cloud API (D1) 读 artists
  const artists = await fetchArtists(Math.min(remaining * 3, 200));
  if (!artists.length) {
    const scope = TARGET_STATES.length ? TARGET_STATES.join(',') : (TARGET_STATE !== 'ALL' ? TARGET_STATE : '');
    console.log(`[ig-scheduler] No new artists available${scope ? ' for ' + scope : ''}`);
    return;
  }

  const extractHandle = (ig_handle: string, website: string): string => {
    const src = String(ig_handle || website || '');
    return src
      .replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
      .replace(/\/$/, '')
      .trim().toLowerCase();
  };
  const isValidHandle = (h: string) => /^[a-z][a-z0-9._]{1,29}$/.test(h);

  const now = Date.now();
  const batch: Array<{ id: string; payload: any; runAt: number }> = [];

  for (const artist of artists) {
    const handle = extractHandle(artist.ig_handle, artist.website);
    if (!handle || !isValidHandle(handle)) continue;

    const taskId = `ig_scheduled_${handle}_${now}_${Math.random().toString(36).slice(2, 6)}`;
    // 模式由「前台偏好是否有互动」决定：全 0 → browse_only；任一 >0 → browse_like
    const execMode = hasInteraction ? 'browse_like' : 'browse_only';
    const payload = {
      id: taskId, taskType: 'ig_outreach', botId: BOT_ID,
      targetBotId: BOT_ID,
      artistHandle: handle, shopName: String(artist.shop_name || ''),
      category: String(artist.category || ''),
      city: String(artist.city || ''),
      rating: artist.rating ? Number(artist.rating) : null,
      reviews: artist.reviews ? Number(artist.reviews) : null,
      followers: artist.followers ? Number(artist.followers) : null,
      accountStage: acctStage, accountAgeDays: acctAgeDays,
      dailyTaskLimit: effectiveLimit, speedFactor: acctSpeed,
      mode: execMode, suggestedExecMode: execMode, desiredOpenCount: 3,
      // 前台动作偏好（bot-worker 按这些次数执行点赞/评论/关注）
      likesPerSession: likesPer, commentsPerSession: commentsPer, followsPerSession: followsPer,
      likePerVisitMin: Math.max(1, Math.min(5, likesPer || 2)),
      likePerVisitMax: Math.max(1, Math.min(5, Math.max(likesPer || 2, 2))),
      source: 'ig_scheduler_lite', state: String(artist.state || TARGET_STATE),
      scheduledAt: new Date().toISOString(),
    };
    const runAt = now + 10_000 + Math.floor(Math.random() * 120_000);
    batch.push({ id: taskId, payload, runAt });
  }

  // Batch POST to Cloud API Worker (D1)
  let created = 0;
  if (batch.length > 0) {
    try {
      const resp = await fetch(`${CLOUD_API_BASE}/api/tasks/create?token=${BOT_API_TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: batch }),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        created = Number(data?.created || 0);
      } else {
        const t = await resp.text();
        console.error(`[ig-scheduler] API error ${resp.status}: ${t.slice(0, 100)}`);
      }
    } catch (e: any) {
      console.error(`[ig-scheduler] POST failed: ${e?.message?.slice(0, 80)}`);
    }
  }

  const scope = TARGET_STATES.length ? TARGET_STATES.join(',') : TARGET_STATE;
  console.log(`[ig-scheduler] Created ${created}/${batch.length} tasks (${todayCount}/${effectiveLimit} today) for bot=${BOT_ID} state=${scope} age=${acctAgeDays}d`);
}

console.log(`[ig-scheduler] Running every 5 mins (bot=${BOT_ID}, state=${TARGET_STATES.length ? TARGET_STATES.join(',') : TARGET_STATE}, daily=${DAILY_LIMIT})`);
main().catch(e => console.error('[ig-scheduler] first run error:', e));
setInterval(() => main().catch(e => console.error('[ig-scheduler] error:', e)), 5 * 60 * 1000);
