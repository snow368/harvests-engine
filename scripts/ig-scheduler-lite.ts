/**
 * IG Scheduler Lite — 轻量任务分配器
 * 按每日配额分批创建任务，不依赖 bot_registry.json
 * 用法: npx tsx scripts/ig-scheduler-lite.ts
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = './data/deep_scan_tasks.db';
const OBS_PATH = './data/bot_observations.jsonl';

// 每日配额
const DAILY_LIMITS = {
  browse: 30,    // 每天最多浏览
  like: 20,      // 每天最多点赞
  comment: 3,    // 每天最多评论
  follow: 2,     // 每天最多关注
};

const BOT_ID = 'bot_ig_01';

function getTodayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getTodayCount(db: Database.Database): number {
  const today = getTodayKey();
  const startOfDay = new Date(today).getTime();
  const endOfDay = startOfDay + 86400000;
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM automation_tasks
    WHERE created_at >= ? AND created_at < ?
    AND status = 'done'
  `).get(startOfDay, endOfDay) as any;
  return row?.c ?? 0;
}

function main() {
  const db = new Database(DB_PATH);

  const todayCount = getTodayCount(db);
  const remaining = DAILY_LIMITS.browse + DAILY_LIMITS.like - todayCount;

  if (remaining <= 0) {
    console.log(`[ig-scheduler] Today's quota used up (${todayCount}/${DAILY_LIMITS.browse + DAILY_LIMITS.like})`);
    db.close();
    return;
  }

  // Get artists that haven't been processed recently
  const artists = db.prepare(`
    SELECT DISTINCT artist_handle FROM bot_observations
    WHERE artist_handle IS NOT NULL
    ORDER BY RANDOM()
    LIMIT ?
  `).all(Math.min(remaining, 10)) as any[];

  if (!artists.length) {
    console.log('[ig-scheduler] No artists available');
    db.close();
    return;
  }

  const now = Date.now();
  let created = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO automation_tasks
    (id, payload, status, run_at, attempts, max_attempts, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, 0, 3, ?, ?)
  `);

  for (const { artist_handle: handle } of artists) {
    const taskId = `ig_scheduled_${handle}_${now}`;
    const payload = JSON.stringify({
      id: taskId,
      taskType: 'ig_outreach',
      botId: BOT_ID,
      artistHandle: handle,
      handle,
      mode: 'browse_only',
      suggestedExecMode: 'browse_like',
      desiredOpenCount: 3,
      scheduledAt: new Date().toISOString(),
    });
    insert.run(taskId, payload, now, now, now);
    created++;
  }

  console.log(`[ig-scheduler] Created ${created} tasks (${todayCount}/${DAILY_LIMITS.browse + DAILY_LIMITS.like} today)`);
  db.close();
}

// 每 5 分钟跑一次，持续补任务
console.log('[ig-scheduler] Running every 5 minutes...');
main();
setInterval(main, 5 * 60 * 1000);
