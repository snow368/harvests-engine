/**
 * PM2 Ecosystem — Bot Workers（纯 Windows，路径自适应）
 *
 * 管理两个进程：
 *   1. ig-scheduler   — 从 Neon 读艺人 → 创建任务到 D1
 *   2. bot-worker     — 从 D1 poll 任务 → 用 CDP Chrome 操作 IG
 *
 * 路径自适应：基于 __dirname（本文件所在目录），在哪台 VPS 上 clone 都能跑。
 *   引擎目录 = ecosystem.config.js 所在目录
 *   日志目录 = 引擎目录的上层 /logs（即 {repo-root}/logs）
 *   如需覆盖，设置环境变量 HARVESTS_DIR（引擎目录的上层）
 *
 * Windows 专用。首次部署：
 *   cd C:\harvests\harvests-engine
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * 注意：
 *   - NEON_DATABASE_URL 通过 .env 文件读取（已在 gitignore）
 *   - 首次部署后先 pm2 start → pm2 save 建立快照
 */

// @ts-check
/* eslint-env node */

const path = require('node:path');

// ── 目录配置（__dirname 自适应，HARVESTS_DIR 可覆盖）─
const ENGINE_DIR = __dirname;   // 本文件在哪，引擎目录就在哪
const HARVESTS_DIR = process.env.HARVESTS_DIR || path.resolve(ENGINE_DIR, '..');
const LOGS_DIR = path.join(HARVESTS_DIR, 'logs');

// ── 公共 env ────────────────────────────────────
const COMMON_ENV = {
  NODE_ENV: 'production',
  CLOUD_API_BASE: 'https://harvests-cloud-api.inkflowapp.workers.dev',
  BOT_API_TOKEN: 'vps-bot-secret-2024',
};

// ── 进程默认配置 ──────────────────────────────
const DEFAULTS = {
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  max_restarts: 10,
  watch: false,
  merge_logs: true,
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
};

// ── 应用列表 ────────────────────────────────────
/** @type {import('pm2').StartOptions[]} */
const apps = [
  // ── 1. 调度器 ──────────────────────────────────
  {
    name: 'ig-scheduler',
    cwd: ENGINE_DIR,
    script: 'npx.cmd',
    args: 'tsx scripts/ig-scheduler-lite.ts',
    ...DEFAULTS,
    restart_delay: 10_000,
    env: {
      ...COMMON_ENV,
      SCHEDULER_BOT_ID: 'bot_ig_01',
      SCHEDULER_DAILY_LIMIT: '50',
      SCHEDULER_STATE: 'OR',
    },
    error_file: path.join(LOGS_DIR, 'scheduler-error.log'),
    out_file: path.join(LOGS_DIR, 'scheduler-out.log'),
  },

  // ── 2. Bot Worker ─────────────────────────────
  {
    name: 'bot-worker',
    cwd: ENGINE_DIR,
    script: 'npx.cmd',
    args: 'tsx scripts/bot-worker-real.ts',
    ...DEFAULTS,
    restart_delay: 15_000,
    kill_timeout: 30_000,
    env: {
      ...COMMON_ENV,
      BOT_ID: 'bot_ig_01',
      BOT_CDP_URL: 'http://localhost:9222',
      HUMAN_MIMICRY_ENABLED: 'true',
      BOT_LAUNCH_MODE: 'cdp',
      BOT_EXEC_MODE: 'browse_like',
      BOT_POLL_INTERVAL_MS: '4000',
      BOT_HEARTBEAT_INTERVAL_MS: '15000',
      BOT_HUMAN_BREAK_MIN_MS: '300000',
      BOT_HUMAN_BREAK_MAX_MS: '900000',
      BOT_BREAK_EVERY_N: '4',
    },
    error_file: path.join(LOGS_DIR, 'bot-worker-error.log'),
    out_file: path.join(LOGS_DIR, 'bot-worker-out.log'),
  },
];

module.exports = { apps };
