/**
 * PM2 Ecosystem — Bot Workers（Windows）
 *
 * 用 Node.js `--import tsx` loader 运行 TypeScript 脚本。
 * 不需要 tsx.cmd 在 PATH 上，node.exe 足矣。
 *
 * 路径自适应：基于 __dirname（本文件所在目录），哪里 clone 都能跑。
 *
 * 首次部署：
 *   cd <引擎目录>
 *   npm install tsx --save-dev
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * 注意：
 *   - NEON_DATABASE_URL 通过 .env 文件读取（已在 gitignore）
 */

// @ts-check
/* eslint-env node */

const path = require('node:path');

// ── 目录配置 ────────────────────────────────────
const ENGINE_DIR = __dirname;
const HARVESTS_DIR = process.env.HARVESTS_DIR || path.resolve(ENGINE_DIR, '..');
const LOGS_DIR = path.join(HARVESTS_DIR, 'logs');

// ── 公共 env ────────────────────────────────────
const COMMON_ENV = {
  NODE_ENV: 'production',
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
    script: './scripts/ig-scheduler-lite.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 10_000,
    env: {
      ...COMMON_ENV,
      CLOUD_API_BASE: 'https://harvests-cloud-api.inkflowapp.workers.dev',
      SCHEDULER_BOT_ID: 'bot_ig_01',
      SCHEDULER_DAILY_LIMIT: '50',
      SCHEDULER_STATE: 'ALL',
    },
    error_file: path.join(LOGS_DIR, 'scheduler-error.log'),
    out_file: path.join(LOGS_DIR, 'scheduler-out.log'),
  },

  // ── 3. Backlink Scheduler ──────────────────────
  {
    name: 'backlink-scheduler',
    cwd: ENGINE_DIR,
    script: './scripts/backlink-scheduler.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 30_000,
    cron_restart: '0 9 * * *',  // 每天早上 9 点生成任务
    env: {
      ...COMMON_ENV,
      BOT_BACKLINK_DAILY_QUOTA: '20',
    },
    error_file: path.join(LOGS_DIR, 'backlink-scheduler-error.log'),
    out_file: path.join(LOGS_DIR, 'backlink-scheduler-out.log'),
  },

  // ── 4. Backlink Worker ──────────────────────────
  {
    name: 'backlink-worker',
    cwd: ENGINE_DIR,
    script: './scripts/backlink-worker.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 15_000,
    env: {
      ...COMMON_ENV,
      BOT_CDP_URL: 'http://localhost:9222',
      BOT_BACKLINK_QUOTA: '10',
      BOT_API_BASE: 'https://harvests-cloud-api.inkflowapp.workers.dev',
    },
    error_file: path.join(LOGS_DIR, 'backlink-worker-error.log'),
    out_file: path.join(LOGS_DIR, 'backlink-worker-out.log'),
  },

  // ── 2. Bot Worker ─────────────────────────────
  {
    name: 'bot-worker',
    cwd: ENGINE_DIR,
    script: './scripts/bot-worker-real.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 15_000,
    kill_timeout: 30_000,
    env: {
      ...COMMON_ENV,
      BOT_API_BASE: 'https://harvests-cloud-api.inkflowapp.workers.dev',
      BOT_ACCOUNT_IDS: 'raiha8833',
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
      BOT_COMMENT_ENABLED: 'true',
      BOT_COMMENT_CHANCE: '0.2',
      BOT_COMMENT_DAILY_MAX: '2',
    },
    error_file: path.join(LOGS_DIR, 'bot-worker-error.log'),
    out_file: path.join(LOGS_DIR, 'bot-worker-out.log'),
  },

  // ── 5. Competitor IG Monitor（B 渠道社媒采集） ──
  // 复用 bot-worker 已登录的 Chrome（CDP localhost:9222）抓竞品 IG 新品，
  // 写回 AI Core competitors:tattoo 租户 → 自动在「新品情报」板冒出。
  // 首次上线请在 VPS 先跑一次 --baseline 灌基线（见下方注释）。
  {
    name: 'competitor-ig-monitor',
    cwd: ENGINE_DIR,
    script: './scripts/bot-competitor-ig-monitor.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 30_000,
    env: {
      ...COMMON_ENV,
      BOT_CDP_URL: 'http://localhost:9222',
      AI_CORE_BASE: 'https://harvests-ai-core-api.inkflowapp.workers.dev',
      AI_CORE_AUTH: 'Bearer dev',
      IG_BASE: 'https://www.instagram.com',
    },
    // --loop 常驻：脚本自带每 6h 一轮的自循环；autorestart 保证崩溃后拉起。
    // 首次上线请先在 VPS 手动跑一次：npx tsx scripts/bot-competitor-ig-monitor.ts --baseline
    // （灌历史基线，first_seen=真实发帖时间，不当新品）
    args: ['--loop', '--interval-min', '360'],
    error_file: path.join(LOGS_DIR, 'competitor-ig-monitor-error.log'),
    out_file: path.join(LOGS_DIR, 'competitor-ig-monitor-out.log'),
  },

  // ── 5b. 通用行业情报机器人（通用款，不写死垂类） ──
  // 走「纹身机器人」同一套规则：配置(行业/品牌/URL/关键词/聚焦) → Playwright 抓取
  // → 本地关键词分类(新品/改进/抱怨/差评) → 写回 AI Core competitors:general 租户。
  // 配置优先级：前端卡片(env 落盘 data/general-intel.config.json) > 此处 env > 进程 env。
  // dev 可见卡片，普通用户不可见（BOT_FUNCTION_CATALOG 里 devOnly:true）。
  {
    name: 'general-intel',
    cwd: ENGINE_DIR,
    script: './scripts/bot-general-intel.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 30_000,
    env: {
      ...COMMON_ENV,
      AI_CORE_BASE: 'https://harvests-ai-core-api.inkflowapp.workers.dev',
      AI_CORE_AUTH: 'Bearer dev',
      BOT_CDP_URL: 'http://localhost:9222',
      // 通用默认配置（dev 可在前端卡片填写，或此处直接改）
      TARGET_INDUSTRY: '',
      TARGET_BRANDS: '',
      SOURCE_URLS: '',
      KEYWORDS: '',
      INTEL_FOCUS: 'all',
      GENERAL_TENANT: 'competitors:general',
    },
    args: ['--loop', '--interval-min', '360'],
    error_file: path.join(LOGS_DIR, 'general-intel-error.log'),
    out_file: path.join(LOGS_DIR, 'general-intel-out.log'),
  },

  // ── 6. Control-plane listener ──────────────────
  // 轮询 cloud-api /api/bot/commands，把前台的 start/stop 翻译成 pm2 启停。
  // 让前台（Bot Workers 页 Run/Stop）无需直连 VPS 即可远程操控本机 pm2。
  {
    name: 'bot-control-listener',
    cwd: ENGINE_DIR,
    script: './scripts/bot-control-listener.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 5000,
    env: {
      ...COMMON_ENV,
      CLOUD_API_BASE: 'https://harvests-cloud-api.inkflowapp.workers.dev',
      BOT_API_TOKEN: 'vps-bot-secret-2024',
      LISTENER_INTERVAL_MS: '10000',
    },
    error_file: path.join(LOGS_DIR, 'bot-control-listener-error.log'),
    out_file: path.join(LOGS_DIR, 'bot-control-listener-out.log'),
  },
];

module.exports = { apps };
