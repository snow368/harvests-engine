/**
 * IG Scheduler Lite — Neon 版
 * 从 Neon artists 表读取纹身店 → 创建 automation_tasks 到 Neon
 * server.ts 的 /api/automation/poll 会同步 Neon 任务到本地 SQLite
 * 用法: npx tsx scripts/ig-scheduler-lite.ts
 *
 * ENV:
 *   NEON_DATABASE_URL     — Neon 数据库 URL
 *   SCHEDULER_DAILY_LIMIT — 日配额（默认 50）
 *   SCHEDULER_BOT_ID      — 目标 bot（默认 bot_ig_01）
 *   SCHEDULER_STATE       — 目标州代码（默认 OR，ALL=不限）
 *   SCHEDULER_BATCH_SIZE  — 每批抓取数（默认 10）
 */

import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
const BOT_ID = process.env.SCHEDULER_BOT_ID || 'bot_ig_01';
const DAILY_LIMIT = Number(process.env.SCHEDULER_DAILY_LIMIT) || 50;
const BATCH_SIZE = Math.min(20, Math.max(1, Number(process.env.SCHEDULER_BATCH_SIZE) || 10));
const TARGET_STATE = (process.env.SCHEDULER_STATE || 'OR').trim().toUpperCase();

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

const sql = neon(process.env.NEON_DATABASE_URL || process.env.VITE_NEON_DATABASE_URL || '');

async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS automation_tasks (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      run_at BIGINT,
      lease_until BIGINT,
      leased_by TEXT,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      error_reason TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `;
}

async function main() {
  await ensureTables();

  const today = new Date().toISOString().slice(0, 10);
  const startOfDay = new Date(today).getTime();
  const endOfDay = startOfDay + 86_400_000;

  // 今日已完成的配额
  const [{ c: todayCount }] = await sql`
    SELECT COUNT(*) as c FROM automation_tasks
    WHERE created_at >= ${startOfDay} AND created_at < ${endOfDay}
      AND status IN ('pending', 'done', 'leased')
  `;
  const remaining = DAILY_LIMIT - (todayCount as number);
  if (remaining <= 0) {
    console.log(`[ig-scheduler] Quota used (${todayCount}/${DAILY_LIMIT})`);
    return;
  }

  // 从 artists 表找未处理过的店铺
  const stateFilter = TARGET_STATE === 'ALL'
    ? sql`1=1`
    : sql`state = ${TARGET_STATE}`;

  // SQL 只做基本过滤（IG handle 非空），handle 提取+校验在 JS 做
  const artists = await sql`
    SELECT ig_handle, shop_name, city, rating, reviews, followers
    FROM artists
    WHERE ${stateFilter}
      AND ig_handle IS NOT NULL AND ig_handle != ''
      AND ig_handle != 'N/A'
      AND ig_handle != 'NA'
      AND id NOT IN (
        SELECT DISTINCT payload->>'artistHandle' FROM automation_tasks
        WHERE payload->>'artistHandle' IS NOT NULL AND status != 'failed'
      )
    ORDER BY RANDOM()
    LIMIT ${Math.min(remaining, BATCH_SIZE)}
  `;

  if (!artists.length) {
    console.log(`[ig-scheduler] No new artists available for ${TARGET_STATE}`);
    return;
  }

  const now = Date.now();
  let created = 0;

  for (const artist of artists) {
    const handle = String(artist.ig_handle || '')
      // Strip @ prefix, full URL (with or without www.), and trailing slash
      .replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
      .replace(/\/$/, '')
      .replace(/\/$/, '')
      .trim().toLowerCase();
    // Second line of defense: verify valid IG handle format
    if (!handle || !/^[a-z][a-z0-9._]{1,29}$/.test(handle)) continue;

    const taskId = `ig_scheduled_${handle}_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const payload = JSON.stringify({
      id: taskId,
      taskType: 'ig_outreach',
      botId: BOT_ID,
      artistHandle: handle,
      shopName: String(artist.shop_name || ''),
      city: String(artist.city || ''),
      rating: artist.rating ? Number(artist.rating) : null,
      reviews: artist.reviews ? Number(artist.reviews) : null,
      followers: artist.followers ? Number(artist.followers) : null,
      mode: 'browse_only',
      suggestedExecMode: 'browse_like',
      desiredOpenCount: 3,
      source: 'ig_scheduler_lite',
      state: TARGET_STATE,
      scheduledAt: new Date().toISOString(),
    });
    const runAt = now + 10_000 + Math.floor(Math.random() * 120_000); // 10s~2min 内执行

    try {
      await sql`
        INSERT INTO automation_tasks (id, payload, status, run_at, attempts, max_attempts, created_at, updated_at)
        VALUES (${taskId}, ${payload}::jsonb, 'pending', ${runAt}, 0, 3, ${now}, ${now})
        ON CONFLICT (id) DO NOTHING
      `;
      created++;
    } catch (e: any) {
      console.error(`  [ERROR] ${handle}: ${e?.message?.slice(0, 80)}`);
    }
  }

  console.log(`[ig-scheduler] Created ${created} tasks (${todayCount}/${DAILY_LIMIT} today) for bot=${BOT_ID} state=${TARGET_STATE}`);
}

console.log(`[ig-scheduler] Running every 5 mins (bot=${BOT_ID}, state=${TARGET_STATE}, daily=${DAILY_LIMIT})`);
main().catch(e => console.error('[ig-scheduler] first run error:', e));
setInterval(() => main().catch(e => console.error('[ig-scheduler] error:', e)), 5 * 60 * 1000);
