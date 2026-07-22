/**
 * IG Scheduler Lite — Cloud D1 版（无 Neon 依赖）
 * 从 Cloud API (D1) 读取 artists → 创建任务到 Cloud API Worker (D1)
 * Bot worker 直接从 D1 poll 任务，不再需要本地 server / Neon。
 * 用法: npx tsx scripts/ig-scheduler-lite.ts
 *
 * ENV:
 *   CLOUD_API_BASE        — Cloud API Worker 地址（默认 https://harvests-cloud-api.inkflowapp.workers.dev）
 *   BOT_API_TOKEN         — VPS bot 密钥（须与 cloud-api 的 BOT_API_TOKEN 一致）
 *   SCHEDULER_DAILY_LIMIT — 日配额（默认 50）
 *   SCHEDULER_BOT_ID      — 目标 bot（默认 bot_ig_01）
 *   SCHEDULER_STATE       — 目标州代码（默认 ALL=不限；设 'OR' 等则只排该州 artists）
 *   SCHEDULER_BATCH_SIZE  — 每批抓取数（默认 10）
 */

import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
const BOT_ID = process.env.SCHEDULER_BOT_ID || 'bot_ig_01';
const DAILY_LIMIT = Number(process.env.SCHEDULER_DAILY_LIMIT) || 50;
const BATCH_SIZE = Math.min(20, Math.max(1, Number(process.env.SCHEDULER_BATCH_SIZE) || 10));
const TARGET_STATE = (process.env.SCHEDULER_STATE || 'ALL').trim().toUpperCase();
const CLOUD_API_BASE = (process.env.CLOUD_API_BASE || 'https://harvests-cloud-api.inkflowapp.workers.dev').replace(/\/+$/, '');
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
    // 可选州过滤（state 列）：ALL 不过滤；否则只保留该州
    const filtered = TARGET_STATE === 'ALL'
      ? items
      : items.filter((a: any) => String(a.state || '').toUpperCase() === TARGET_STATE);
    return filtered;
  } catch (e: any) {
    console.error('[ig-scheduler] fetch artists failed:', e?.message?.slice(0, 80));
    return [];
  }
}

async function main() {
  // 账号阶段：bot_accounts 在 D1，但 cloud-api 暂无安全的「只读」端点
  // （GET /api/automation/bot-account 是带副作用的 upsert），这里按新账号保守默认。
  const acctAgeDays = 0;
  const dbStage = 'new';
  const dbSpeed = 2.5;

  const autoStage = 'new';
  const autoLimit = DAILY_LIMIT;
  const autoSpeed = 2.5;

  const acctStage = process.env.SCHEDULER_STAGE || dbStage || autoStage;
  const effectiveLimit = Number(process.env.SCHEDULER_DAILY_LIMIT) || autoLimit;
  const acctSpeed = Number(process.env.SCHEDULER_SPEED_FACTOR) || dbSpeed || autoSpeed;

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
    console.log(`[ig-scheduler] No new artists available${TARGET_STATE !== 'ALL' ? ' for ' + TARGET_STATE : ''}`);
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
    const execMode = acctStage === 'new' ? 'browse_only' : 'browse_like';
    const payload = {
      id: taskId, taskType: 'ig_outreach', botId: BOT_ID,
      artistHandle: handle, shopName: String(artist.shop_name || ''),
      city: String(artist.city || ''),
      rating: artist.rating ? Number(artist.rating) : null,
      reviews: artist.reviews ? Number(artist.reviews) : null,
      followers: artist.followers ? Number(artist.followers) : null,
      accountStage: acctStage, accountAgeDays: acctAgeDays,
      dailyTaskLimit: effectiveLimit, speedFactor: acctSpeed,
      mode: execMode, suggestedExecMode: execMode, desiredOpenCount: 3,
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

  console.log(`[ig-scheduler] Created ${created}/${batch.length} tasks (${todayCount}/${effectiveLimit} today) for bot=${BOT_ID} state=${TARGET_STATE} age=${acctAgeDays}d`);
}

console.log(`[ig-scheduler] Running every 5 mins (bot=${BOT_ID}, state=${TARGET_STATE}, daily=${DAILY_LIMIT})`);
main().catch(e => console.error('[ig-scheduler] first run error:', e));
setInterval(() => main().catch(e => console.error('[ig-scheduler] error:', e)), 5 * 60 * 1000);
