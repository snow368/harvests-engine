/**
 * dispatch-scheduler.ts — 调度中枢
 *
 * 每2小时运行一次（或手动 npx tsx scripts/dispatch-scheduler.ts）
 *
 * 流程:
 *   1. 加载产品线配置
 *   2. 对每个 bot: 拉目标 → 算分 → 查阶段 → 配动作 → 写任务
 *   3. 处理反馈：更新关系阶段
 *
 * ENV:
 *   SCHEDULER_PRODUCT_LINE=con    (只跑指定产品线)
 *   SCHEDULER_DRY_RUN=true        (试跑不写任务)
 *   SCHEDULER_BOT_IDS=bot_wa_01   (只跑指定 bot)
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';

// ============ Config ============
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');
const BOT_REGISTRY_PATH = path.join(process.cwd(), 'data', 'bot_registry.json');
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const PRODUCT_LINE = (process.env.SCHEDULER_PRODUCT_LINE || '').trim().toLowerCase() || 'con';
const DRY_RUN = String(process.env.SCHEDULER_DRY_RUN || 'false').toLowerCase() === 'true';
const BOT_IDS_FILTER = (process.env.SCHEDULER_BOT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TASKS_PER_BOT = Math.max(1, Number(process.env.SCHEDULER_TASKS_PER_BOT || 8));
const RUN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h

const sql = neon(process.env.NEON_DATABASE_URL || process.env.VITE_NEON_DATABASE_URL || '');

// ============ Product Line Configs ============
interface ProductLineConfig {
  name: string;
  entityTypes: string[];
  scoring: {
    ratingHigh: number; ratingMid: number; ratingLow: number; ratingDefault: number;
    followersSweetSpotMin: number; followersSweetSpotMax: number;
    followersLowMax: number; followersIgnoreMin: number;
    engagementHigh: number; engagementMid: number; engagementLow: number;
    newTargetBonus: number; untouchedBonus: number;
  };
  actions: {
    likeDailyMin: number; likeDailyMax: number;
    commentDailyMin: number; commentDailyMax: number;
    followDailyMin: number; followDailyMax: number;
  };
}

const PRODUCT_LINE_CONFIGS: Record<string, ProductLineConfig> = {
  con: {
    name: 'con',
    entityTypes: ['tattoo_shop', 'tattoo_artist'],
    scoring: {
      ratingHigh: 25, ratingMid: 20, ratingLow: 15, ratingDefault: 10,
      followersSweetSpotMin: 1000, followersSweetSpotMax: 10000,
      followersLowMax: 999, followersIgnoreMin: 10000,
      engagementHigh: 20, engagementMid: 15, engagementLow: 10,
      newTargetBonus: 15, untouchedBonus: 15,
    },
    actions: {
      likeDailyMin: 15, likeDailyMax: 40,
      commentDailyMin: 1, commentDailyMax: 5,
      followDailyMin: 1, followDailyMax: 5,
    },
  },
  // AES/Dental 后面加
};

// ============ Bot Config ============
interface BotConfig {
  botId: string;
  accountId: string;
  tier: string;
  timezone: string;
  proxy: string;
  profileDir: string;
  enabled: boolean;
  role: string;
  productLine?: string;
  igAccount?: string;
  speedFactor?: number;
  variance?: number;
}

interface BotWithQuota extends BotConfig {
  dailyUsage: {
    likesGiven: number;
    commentsGiven: number;
    followsDone: number;
  };
  lastSessionAt: number;
}

// ============ DB Setup ============
const db = new Database(DB_PATH);

// Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS target_stages (
    ig_handle TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    stage INTEGER DEFAULT 0,
    touch_count INTEGER DEFAULT 0,
    last_action TEXT,
    last_action_at INTEGER,
    priority_score REAL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (ig_handle, bot_id)
  );

  CREATE TABLE IF NOT EXISTS bot_daily_usage (
    bot_id TEXT NOT NULL,
    date TEXT NOT NULL,
    likes_given INTEGER DEFAULT 0,
    comments_given INTEGER DEFAULT 0,
    follows_done INTEGER DEFAULT 0,
    last_action_at INTEGER,
    PRIMARY KEY (bot_id, date)
  );
`);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const today = () => new Date().toISOString().slice(0, 10);

// ============ Load Config ============
function loadBotRegistry(): BotConfig[] {
  try {
    const content = fs.readFileSync(BOT_REGISTRY_PATH, 'utf-8').replace(/^﻿/, '');
    const raw = JSON.parse(content);
    const bots: BotConfig[] = Array.isArray(raw.bots) ? raw.bots : [];
    return bots.filter(b => b.enabled !== false);
  } catch {
    console.warn('[scheduler] bot_registry.json not found or invalid');
    return [];
  }
}

function getBotQuota(bot: BotConfig, config: ProductLineConfig) {
  // Bot-specific overrides or default from product line
  return {
    likesGiven: 0,
    commentsGiven: 0,
    followsDone: 0,
  };
}

function getDailyUsage(botId: string): { likesGiven: number; commentsGiven: number; followsDone: number } {
  const row = db.prepare(`SELECT likes_given, comments_given, follows_done FROM bot_daily_usage WHERE bot_id = ? AND date = ?`)
    .get(botId, today()) as any;
  return row
    ? { likesGiven: row.likes_given, commentsGiven: row.comments_given, followsDone: row.follows_done }
    : { likesGiven: 0, commentsGiven: 0, followsDone: 0 };
}

function checkCooldown(botId: string, igHandle: string): number {
  // 返回距离可以再次互动还剩多少 ms, 0 = 可互动
  const row = db.prepare(`
    SELECT MAX(created_at) as lastAt
    FROM automation_tasks
    WHERE leased_by = ?
      AND json_extract(payload, '$.artistHandle') = ?
      AND status IN ('done','leased')
  `).get(botId, igHandle) as any;

  if (!row?.lastAt) return 0;
  const elapsed = now() - row.lastAt;
  const cooldownMs = 24 * 60 * 60 * 1000; // 24h cooldown per target
  return Math.max(0, cooldownMs - elapsed);
}

function isInActiveWindow(timezone: string): boolean {
  // 根据 timezone 判断当地是否在活跃窗口 (9:00-22:00)
  try {
    const localHour = new Date().toLocaleString('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
    const hour = parseInt(localHour);
    return hour >= 9 && hour < 22;
  } catch {
    return true; // 不确定时默认可以
  }
}

function getLastActionTime(botId: string): number {
  const row = db.prepare(`
    SELECT MAX(created_at) as lastAt FROM automation_tasks WHERE leased_by = ? AND created_at > ?
  `).get(botId, now() - 7 * 86400000) as any;
  return row?.lastAt || 0;
}

// ============ Target Scoring ============
interface Target {
  id: string;
  igHandle: string;
  shopName: string;
  city: string;
  rating: number | null;
  reviews: number | null;
  followers: number | null;
  importRegion: string;
  createdAt: string;
}

interface ScoredTarget extends Target {
  priorityScore: number;
  stage: number;
  touchCount: number;
  lastAction: string | null;
  lastActionAt: number | null;
  cooldownMs: number;
}

function computeScore(target: Target, stage: number, config: ProductLineConfig): number {
  const s = config.scoring;
  let score = 0;

  // 1. Maps rating (0-25)
  const rating = target.rating ?? 0;
  if (rating >= 4.8) score += s.ratingHigh;
  else if (rating >= 4.5) score += s.ratingMid;
  else if (rating >= 4.0) score += s.ratingLow;
  else if (rating >= 3.5) score += 10;
  else if (rating > 0) score += 5;
  else score += s.ratingDefault;

  // 2. Followers (0-25) — 1000-10000 sweet spot
  const followers = target.followers ?? 0;
  if (followers >= s.followersSweetSpotMin && followers < s.followersSweetSpotMax) {
    // 1000-10000: 越高分越高
    const ratio = (followers - s.followersSweetSpotMin) / (s.followersSweetSpotMax - s.followersSweetSpotMin);
    score += 15 + Math.round(ratio * 10); // 15-25
  } else if (followers > 0 && followers <= s.followersLowMax) {
    score += 10; // < 1000
  } else if (followers >= s.followersIgnoreMin) {
    score += 5; // >= 10000，低优先级
  } else {
    score += 10; // 无数据
  }

  // 3. New target bonus
  if (stage === 0) score += s.untouchedBonus;

  // 4. Recency bonus — 凑整到15分
  score += s.newTargetBonus;

  return Math.min(100, Math.max(0, score));
}

// ============ Stage Management ============
function getStage(igHandle: string, botId: string): { stage: number; touchCount: number; lastAction: string | null; lastActionAt: number | null } {
  const row = db.prepare(`SELECT stage, touch_count, last_action, last_action_at FROM target_stages WHERE ig_handle = ? AND bot_id = ?`)
    .get(igHandle, botId) as any;
  return row
    ? { stage: row.stage, touchCount: row.touch_count, lastAction: row.last_action, lastActionAt: row.last_action_at }
    : { stage: 0, touchCount: 0, lastAction: null, lastActionAt: null };
}

function computeStageFromActions(igHandle: string, botId: string): number {
  // 从 ig_follow_actions 推导当前阶段
  const actions = db.prepare(`
    SELECT action_type, COUNT(*) as cnt FROM ig_follow_actions
    WHERE target_handle = ? AND bot_id = ? AND created_at > ?
    GROUP BY action_type
  `).all(igHandle, botId, now() - 90 * 86400000) as any[];

  const hasFollow = actions.find((a: any) => a.action_type === 'follow');
  const hasComment = actions.find((a: any) => a.action_type === 'comment');
  const hasLike = actions.find((a: any) => (a.action_type === 'like') && a.cnt >= 2);

  if (hasFollow) return 3;
  if (hasComment) return 2;
  if (hasLike) return 1;
  return 0;
}

function updateStage(igHandle: string, botId: string, actionType: string, success: boolean) {
  if (!success) return;
  const current = getStage(igHandle, botId);
  let newStage = current.stage;

  // 阶段提升
  if (actionType === 'like' && current.stage < 1) newStage = 1;
  else if (actionType === 'comment' && current.stage < 2) newStage = 2;
  else if (actionType === 'follow' && current.stage < 3) newStage = 3;

  db.prepare(`
    INSERT INTO target_stages (ig_handle, bot_id, stage, touch_count, last_action, last_action_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ig_handle, bot_id) DO UPDATE SET
      stage = MAX(stage, excluded.stage),
      touch_count = touch_count + 1,
      last_action = excluded.last_action,
      last_action_at = excluded.last_action_at,
      updated_at = excluded.updated_at
  `).run(igHandle, botId, newStage, current.touchCount + 1, actionType, now(), now(), now());
}

// ============ Action Matching ============
interface ActionPlan {
  igHandle: string;
  actionType: 'like' | 'comment' | 'follow';
  stage: number;
  priorityScore: number;
}

function matchActions(targets: ScoredTarget[], quota: { likesLeft: number; commentsLeft: number; followsLeft: number }): ActionPlan[] {
  const plans: ActionPlan[] = [];
  const used = new Set<string>();

  // Round 1: comment 配额 — 给 stage 1-2 中评分最高的
  if (quota.commentsLeft > 0) {
    const candidates = targets
      .filter(t => !used.has(t.igHandle) && t.stage >= 1 && t.stage <= 2 && t.cooldownMs === 0)
      .sort((a, b) => b.priorityScore - a.priorityScore);
    for (const t of candidates.slice(0, quota.commentsLeft)) {
      plans.push({ igHandle: t.igHandle, actionType: 'comment', stage: t.stage, priorityScore: t.priorityScore });
      used.add(t.igHandle);
    }
  }

  // Round 2: follow 配额 — 给 stage 2 中评分最高的
  if (quota.followsLeft > 0) {
    const candidates = targets
      .filter(t => !used.has(t.igHandle) && t.stage === 2 && t.cooldownMs === 0)
      .sort((a, b) => b.priorityScore - a.priorityScore);
    for (const t of candidates.slice(0, quota.followsLeft)) {
      plans.push({ igHandle: t.igHandle, actionType: 'follow', stage: t.stage, priorityScore: t.priorityScore });
      used.add(t.igHandle);
    }
  }

  // Round 3: like 配额 — 未接触的优先
  if (quota.likesLeft > 0) {
    const candidates = targets
      .filter(t => !used.has(t.igHandle) && t.cooldownMs === 0)
      .sort((a, b) => {
        // 未接触的优先
        if (a.stage === 0 && b.stage !== 0) return -1;
        if (a.stage !== 0 && b.stage === 0) return 1;
        return b.priorityScore - a.priorityScore;
      });
    for (const t of candidates.slice(0, quota.likesLeft)) {
      plans.push({ igHandle: t.igHandle, actionType: 'like', stage: t.stage, priorityScore: t.priorityScore });
      used.add(t.igHandle);
    }
  }

  return plans;
}

// ============ Task Creation ============
function createAutomationTask(botId: string, plan: ActionPlan) {
  const commandId = `cmd_${now()}_${botId}_${plan.igHandle}_${Math.random().toString(36).slice(2, 6)}`;
  const runAt = now() + 30_000 + Math.floor(Math.random() * 180_000); // 30s-3.5min 内执行

  // Decide execMode based on action type
  let suggestedExecMode = 'browse_only';
  if (plan.actionType === 'like' || plan.actionType === 'comment') suggestedExecMode = 'browse_like';

  const payload = {
    id: commandId,
    taskType: 'ig_outreach',
    artistHandle: plan.igHandle,
    botId,
    actionType: plan.actionType,
    stage: plan.stage,
    behaviorProfile: plan.stage <= 1 ? 'warmup' : 'active',
    source: 'scheduler_auto',
    suggestedExecMode,
    productLine: PRODUCT_LINE,
    priorityScore: plan.priorityScore,
    timestamp: new Date().toISOString(),
    protocol: {
      steps: [
        { action: 'browse_feed', delay: 30 + Math.floor(Math.random() * 60) },
        { action: 'enter_profile', target: plan.igHandle, delay: 45 + Math.floor(Math.random() * 60) },
        { action: plan.actionType === 'comment' ? 'comment' : 'browse_posts', count: plan.actionType === 'like' ? 3 : 6, delay: 30 },
      ],
    },
  };

  db.prepare(`
    INSERT INTO automation_tasks (id, payload, status, run_at, lease_until, leased_by, attempts, max_attempts, error_reason, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, NULL, NULL, 0, 3, NULL, ?, ?)
  `).run(commandId, JSON.stringify(payload), runAt, now(), now());

  return commandId;
}

// ============ Load Targets from Neon ============
async function loadTargets(productLine: string): Promise<Target[]> {
  try {
    const config = PRODUCT_LINE_CONFIGS[productLine];
    if (!config) throw new Error(`Unknown product line: ${productLine}`);

    // 先用 entity_types 过滤，后面 product_line 字段完善了再加
    const entityTypes = config.entityTypes.map(t => `'${t}'`).join(',');

    // 先用现有的 artists 表，后续分表后改这里
    const rows = await sql`
      SELECT id, ig_handle, shop_name, city, rating, reviews, followers, import_region, last_updated
      FROM artists
      WHERE ig_handle IS NOT NULL AND ig_handle != ''
        AND ig_handle NOT LIKE '%.com%'
        AND ig_handle NOT LIKE '%.net%'
        AND (followers IS NULL OR followers < 10000)
      ORDER BY rating DESC NULLS LAST, reviews DESC NULLS LAST
      LIMIT 200
    `;

    return rows.map((r: any) => ({
      id: String(r.id || ''),
      igHandle: String(r.ig_handle || '').replace(/^@/, '').trim().toLowerCase(),
      shopName: String(r.shop_name || ''),
      city: String(r.city || ''),
      rating: r.rating !== null ? Number(r.rating) : null,
      reviews: r.reviews !== null ? Number(r.reviews) : null,
      followers: r.followers !== null ? Number(r.followers) : null,
      importRegion: String(r.import_region || ''),
      createdAt: String(r.last_updated || ''),
    }));
  } catch (e: any) {
    console.error(`[scheduler] loadTargets error:`, e?.message);
    return [];
  }
}

// ============ Process Feedback ============
function processFeedback() {
  const since = now() - RUN_INTERVAL_MS;
  const doneTasks = db.prepare(`
    SELECT id, payload, status, leased_by, updated_at
    FROM automation_tasks
    WHERE status = 'done' AND updated_at > ?
      AND json_extract(payload, '$.productLine') = ?
  `).all(since, PRODUCT_LINE) as any[];

  for (const task of doneTasks) {
    try {
      const payload = JSON.parse(task.payload);
      const igHandle = payload.artistHandle;
      const botId = task.leased_by;
      const actionType = payload.actionType || 'like';

      updateStage(igHandle, botId, actionType, true);

      // 更新 bot_daily_usage
      const key = actionType === 'like' ? 'likes_given'
        : actionType === 'comment' ? 'comments_given'
        : 'follows_done';
      db.prepare(`
        INSERT INTO bot_daily_usage (bot_id, date, ${key}, last_action_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(bot_id, date) DO UPDATE SET
          ${key} = ${key} + 1,
          last_action_at = excluded.last_action_at
      `).run(botId, today(), now());
    } catch {}
  }

  return doneTasks.length;
}

// ============ Main Dispatch ============
async function dispatchProductLine(productLine: string) {
  const config = PRODUCT_LINE_CONFIGS[productLine];
  if (!config) {
    console.error(`[scheduler] Unknown product line: ${productLine}`);
    return;
  }

  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Scheduler: ${productLine.toUpperCase()}`);
  console.log(`║  ${new Date().toISOString()}`);
  console.log(`╚══════════════════════════════════════╝`);

  // 1. Load bots
  const allBots = loadBotRegistry();
  let bots: BotConfig[] = allBots;

  // Filter by product line (if bot has productLine field, match it)
  const productBots = bots.filter(b => !b.productLine || b.productLine === productLine);
  if (productBots.length === 0) {
    console.log(`[scheduler] No bots for product line "${productLine}"`);
    return;
  }

  console.log(`  Bots: ${productBots.map(b => b.botId).join(', ')}`);

  // 2. Load targets from Neon
  const targets = await loadTargets(productLine);
  if (targets.length === 0) {
    console.log(`[scheduler] No targets found`);
    return;
  }
  console.log(`  Targets loaded: ${targets.length}`);

  // 3. Process feedback first (update stages from recent tasks)
  const feedbackCount = processFeedback();
  console.log(`  Feedback processed: ${feedbackCount} tasks`);

  // 4. For each bot, score targets and generate tasks
  let totalTasks = 0;

  for (const bot of productBots) {
    if (BOT_IDS_FILTER.length > 0 && !BOT_IDS_FILTER.includes(bot.botId)) {
      continue;
    }

    console.log(`\n── Bot: ${bot.botId} ──`);

    // Check bot online
    const botStatus = db.prepare(`SELECT status, last_heartbeat_at FROM bot_instances WHERE bot_id = ?`).get(bot.botId) as any;
    if (!botStatus || botStatus.status === 'offline') {
      console.log(`  SKIP: bot offline (not registered / no heartbeat)`);
      // 还是允许创建任务（bot 随时可能上线）
    }

    // Check active window
    if (!isInActiveWindow(bot.timezone)) {
      console.log(`  SKIP: outside active window (tz: ${bot.timezone})`);
      continue;
    }

    // Check minimum interval between sessions
    const lastSession = getLastActionTime(bot.botId);
    if (lastSession > 0 && now() - lastSession < 30 * 60 * 1000) {
      console.log(`  SKIP: too soon since last session (${Math.round((now() - lastSession) / 60000)}min ago)`);
      continue;
    }

    // Check daily usage
    const usage = getDailyUsage(bot.botId);
    const likesLeft = Math.max(0, config.actions.likeDailyMax - usage.likesGiven);
    const commentsLeft = Math.max(0, config.actions.commentDailyMax - usage.commentsGiven);
    const followsLeft = Math.max(0, config.actions.followDailyMax - usage.followsDone);
    console.log(`  Quota remaining: ${likesLeft} likes, ${commentsLeft} comments, ${followsLeft} follows`);

    if (likesLeft === 0 && commentsLeft === 0 && followsLeft === 0) {
      console.log(`  SKIP: all quotas exhausted for today`);
      continue;
    }

    // Score targets
    const scoredTargets: ScoredTarget[] = targets.map(t => {
      const stageInfo = getStage(t.igHandle, bot.botId);
      const stage = stageInfo.stage || computeStageFromActions(t.igHandle, bot.botId);
      const cooldownMs = checkCooldown(bot.botId, t.igHandle);
      const score = computeScore(t, stage, config);

      return {
        ...t,
        priorityScore: score,
        stage,
        touchCount: stageInfo.touchCount,
        lastAction: stageInfo.lastAction,
        lastActionAt: stageInfo.lastActionAt,
        cooldownMs,
      };
    });

    // Sort by score
    scoredTargets.sort((a, b) => b.priorityScore - a.priorityScore);

    // Top N 用于本次分配（取评分最高的 50 个）
    const pool = scoredTargets.slice(0, Math.max(50, TASKS_PER_BOT * 3));

    // Match actions
    const plans = matchActions(pool, { likesLeft, commentsLeft, followsLeft });
    console.log(`  Planned: ${plans.length} actions (${plans.filter(p => p.actionType === 'like').length} like, ${plans.filter(p => p.actionType === 'comment').length} comment, ${plans.filter(p => p.actionType === 'follow').length} follow)`);

    // Show top targets
    plans.slice(0, 5).forEach(p => {
      console.log(`    → @${p.igHandle}: ${p.actionType} (stage ${p.stage}, score ${p.priorityScore})`);
    });

    // Write tasks
    if (!DRY_RUN) {
      for (const plan of plans) {
        createAutomationTask(bot.botId, plan);
        totalTasks++;
      }
    }
  }

  console.log(`\n  Total tasks created: ${DRY_RUN ? '(DRY RUN) ' : ''}${totalTasks}`);
  return totalTasks;
}

// ============ Continuous Loop ============
async function mainLoop() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Dispatch Scheduler v1.0                ║');
  console.log(`║  Product line: ${PRODUCT_LINE}`);
  console.log(`║  Dry run: ${DRY_RUN}`);
  console.log(`║  Bot filter: ${BOT_IDS_FILTER.join(', ') || 'all'}`);
  console.log('╚══════════════════════════════════════════╝');

  // Single run mode (for cron/ PM2)
  await dispatchProductLine(PRODUCT_LINE);

  // Show task queue stats
  const stats = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM automation_tasks WHERE created_at > ? GROUP BY status
  `).all(now() - 3600000) as any[];
  console.log(`\nTask queue (last hour):`);
  stats.forEach((s: any) => console.log(`  ${s.status}: ${s.cnt}`));
  const pending = db.prepare(`SELECT COUNT(*) as c FROM automation_tasks WHERE status = 'pending' AND run_at <= ?`).get(now() + 3600000) as any;
  console.log(`  Total pending (next hour): ${pending?.c || 0}`);
}

mainLoop().catch(e => {
  console.error('[scheduler] fatal:', e?.message || e);
  process.exit(1);
});
