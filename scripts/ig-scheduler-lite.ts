/**
 * IG Scheduler Lite — Neon 版
 * 从 artists 表读取，创建 automation_tasks 到 Neon
 * 用法: npx tsx scripts/ig-scheduler-lite.ts
 */

import { neon } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';

// 加载 .env
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const sql = neon(process.env.NEON_DATABASE_URL || process.env.VITE_NEON_DATABASE_URL || '');

const BOT_ID = 'bot_ig_01';
const DAILY_LIMIT = 50;

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
  const endOfDay = startOfDay + 86400000;

  // 今天已完成的任务数
  const [{ c: todayCount }] = await sql`
    SELECT COUNT(*) as c FROM automation_tasks
    WHERE created_at >= ${startOfDay} AND created_at < ${endOfDay}
    AND status = 'done'
  `;
  const remaining = DAILY_LIMIT - (todayCount as number);
  if (remaining <= 0) {
    console.log(`[ig-scheduler] Quota used (${todayCount}/${DAILY_LIMIT})`);
    return;
  }

  // 从 artists 表找未处理过的 OR 州店铺（有 IG 的）
  const artists = await sql`
    SELECT ig_handle FROM artists
    WHERE state = 'OR'
    AND ig_handle IS NOT NULL AND ig_handle != ''
    AND id NOT IN (
      SELECT DISTINCT payload->>'handle' FROM automation_tasks
      WHERE payload->>'handle' IS NOT NULL
    )
    ORDER BY RANDOM()
    LIMIT ${Math.min(remaining, 10)}
  `;

  if (!artists.length) {
    console.log('[ig-scheduler] No new artists available');
    return;
  }

  const now = Date.now();
  let created = 0;

  for (const { ig_handle } of artists) {
    const handle = ig_handle.trim();
    if (!handle) continue;
    const taskId = `ig_scheduled_${handle}_${now}`;
    const payload = JSON.stringify({
      id: taskId, taskType: 'ig_outreach', botId: BOT_ID,
      artistHandle: handle, handle, mode: 'browse_only',
      suggestedExecMode: 'browse_like', desiredOpenCount: 3,
      scheduledAt: new Date().toISOString(),
    });
    try {
      await sql`
        INSERT INTO automation_tasks (id, payload, status, run_at, attempts, max_attempts, created_at, updated_at)
        VALUES (${taskId}, ${payload}::jsonb, 'pending', ${now}, 0, 3, ${now}, ${now})
        ON CONFLICT (id) DO NOTHING
      `;
      created++;
    } catch (e: any) {
      console.error(`  [ERROR] ${handle}: ${e?.message?.slice(0, 80)}`);
    }
  }

  console.log(`[ig-scheduler] Created ${created} tasks (${todayCount}/${DAILY_LIMIT} today)`);
}

console.log('[ig-scheduler] Running every 5 minutes (Neon)...');
main().catch(e => console.error(e));
setInterval(() => main().catch(e => console.error(e)), 5 * 60 * 1000);
