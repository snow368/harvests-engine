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

  // 查账号首次使用时间，按天数自动算阶段、日限额、行为模式
  const accts = await sql`SELECT stage, daily_task_limit, speed_factor, first_used_at FROM bot_accounts WHERE bot_id = ${BOT_ID} LIMIT 1`;
  let dbStage = 'new', dbSpeed = 2.5, dbLimit = 0, acctAgeDays = 0;
  if (accts.length > 0 && accts[0].first_used_at) {
    acctAgeDays = Math.floor((Date.now() - new Date(accts[0].first_used_at).getTime()) / 86400000);
    dbStage = accts[0].stage || 'new';
    dbSpeed = Number(accts[0].speed_factor) || 2.5;
    dbLimit = Number(accts[0].daily_task_limit) || 0;
  }

  // 根据天数自动算（硬编码规则）
  const autoStage =
    acctAgeDays < 7   ? 'new'        // 萌芽期 0-7天
    : acctAgeDays < 14 ? 'transition' // 幼苗期 7-14天
    : acctAgeDays < 30 ? 'growing'    // 成长期 14-30天
    : acctAgeDays < 60 ? 'stable'     // 稳定期 30-60天
    : 'mature';                        // 成熟期 60天+

  const autoLimit =
    acctAgeDays < 7   ? 5
    : acctAgeDays < 14 ? 10
    : acctAgeDays < 30 ? 20
    : acctAgeDays < 60 ? 30
    : 50;

  const autoSpeed =
    acctAgeDays < 7   ? 2.5
    : acctAgeDays < 14 ? 1.8
    : acctAgeDays < 30 ? 1.2
    : acctAgeDays < 60 ? 1.0
    : 0.8;

  // 最终值：环境变量 > DB字段(手动覆盖) > 自动按天算
  const acctStage = process.env.SCHEDULER_STAGE || dbStage || autoStage;
  const effectiveLimit = Number(process.env.SCHEDULER_DAILY_LIMIT) || dbLimit || autoLimit;
  const acctSpeed = Number(process.env.SCHEDULER_SPEED_FACTOR) || dbSpeed || autoSpeed;

  const today = new Date().toISOString().slice(0, 10);
  const startOfDay = new Date(today).getTime();
  const endOfDay = startOfDay + 86_400_000;

  // 今日已完成的配额
  const [{ c: todayCount }] = await sql`
    SELECT COUNT(*) as c FROM automation_tasks
    WHERE created_at >= ${startOfDay} AND created_at < ${endOfDay}
      AND status IN ('pending', 'done', 'leased')
  `;
  const remaining = effectiveLimit - (todayCount as number);
  if (remaining <= 0) {
    console.log(`[ig-scheduler] Quota used (${todayCount}/${effectiveLimit}, stage=${acctStage})`);
    return;
  }

  // 从 artists 表找未处理过的店铺
  const stateFilter = TARGET_STATE === 'ALL'
    ? sql`1=1`
    : sql`state = ${TARGET_STATE}`;

  // 从 ig_handle 或 website 列提取 Instagram 用户名
  // OR 数据因为 CSV 映射问题，IG handle 可能在 website 列
  const extractHandle = (ig_handle: string, website: string): string => {
    const src = String(ig_handle || website || '');
    return src
      .replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?instagram\.com\//, '')
      .replace(/\/$/, '')
      .trim().toLowerCase();
  };
  const isValidHandle = (h: string) => /^[a-z][a-z0-9._]{1,29}$/.test(h);

  // SQL 只做基本过滤，handle 提取+校验在 JS 做
  const artists = await sql`
    SELECT ig_handle, website, shop_name, city, rating, reviews, followers
    FROM artists
    WHERE ${stateFilter}
      AND (ig_handle IS NOT NULL AND ig_handle != '' AND ig_handle != 'N/A' AND ig_handle != 'NA'
           OR website IS NOT NULL AND website != '' AND website != 'N/A')
      AND id NOT IN (
        SELECT DISTINCT payload->>'artistHandle' FROM automation_tasks
        WHERE payload->>'artistHandle' IS NOT NULL AND status != 'failed'
      )
    ORDER BY RANDOM()
    LIMIT ${Math.min(remaining * 3, 50)}
  `;

  if (!artists.length) {
    console.log(`[ig-scheduler] No new artists available for ${TARGET_STATE}`);
    return;
  }

  const now = Date.now();
  let created = 0;

  for (const artist of artists) {
    const handle = extractHandle(artist.ig_handle, artist.website);
    if (!handle || !isValidHandle(handle)) continue;

    const taskId = `ig_scheduled_${handle}_${now}_${Math.random().toString(36).slice(2, 6)}`;
    // new 阶段的号只浏览不互动
    const execMode = acctStage === 'new' ? 'browse_only' : 'browse_like';
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
      accountStage: acctStage,
      accountAgeDays: acctAgeDays,
      dailyTaskLimit: effectiveLimit,
      speedFactor: acctSpeed,
      mode: execMode,
      suggestedExecMode: execMode,
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

  console.log(`[ig-scheduler] Created ${created} tasks (${todayCount}/${effectiveLimit} today) for bot=${BOT_ID} state=${TARGET_STATE} age=${acctAgeDays}d`);

  // 自动更新 DB 的阶段和日限额
  if (accts.length > 0 && (accts[0].stage !== autoStage || Number(accts[0].daily_task_limit || 0) !== autoLimit)) {
    sql`UPDATE bot_accounts SET stage=${autoStage}, daily_task_limit=${autoLimit} WHERE bot_id=${BOT_ID}`.then(() =>
      console.log(`[ig-scheduler] Auto-updated ${BOT_ID}: stage ${accts[0].stage}→${autoStage}, limit ${accts[0].daily_task_limit}→${autoLimit}`)
    ).catch(() => {});
  }
}

console.log(`[ig-scheduler] Running every 5 mins (bot=${BOT_ID}, state=${TARGET_STATE}, daily=${DAILY_LIMIT}, auto=${effectiveLimit})`);
main().catch(e => console.error('[ig-scheduler] first run error:', e));
setInterval(() => main().catch(e => console.error('[ig-scheduler] error:', e)), 5 * 60 * 1000);
