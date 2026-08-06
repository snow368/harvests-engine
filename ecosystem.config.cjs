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
      // pages.dev 同源代理（→ cloud-api Worker），VPS 国内/海外都能通；workers.dev 子域国内被 GFW 屏蔽
      CLOUD_API_BASE: 'https://harvests.pages.dev',
      SCHEDULER_BOT_ID: 'bot_ig_01',
      SCHEDULER_DAILY_LIMIT: '50',
      SCHEDULER_STATE: 'ALL',
    },
    error_file: path.join(LOGS_DIR, 'scheduler-error.log'),
    out_file: path.join(LOGS_DIR, 'scheduler-out.log'),
  },

  // ── 1b. Maps Scrape Scheduler ───────────────────
  // 消费 Maps Scrape 页面「加入队列」产生的 maps_scrape_jobs (pending)。
  // 串行拉起 python_scraper.py（headless 自起浏览器），scraper 自己回报 running→completed。
  // 让「前端选州 → 加入队列 → 系统自动抓取」闭环。
  {
    name: 'maps-scrape-scheduler',
    cwd: ENGINE_DIR,
    script: './scripts/maps-scrape-scheduler.ts',
    interpreter: 'node.exe',
    node_args: '--import tsx',
    ...DEFAULTS,
    restart_delay: 10_000,
    env: {
      ...COMMON_ENV,
      CLOUD_API_BASE: 'https://harvests-cloud-api.inkflowapp.workers.dev',
      SCRAPE_POLL_INTERVAL_MS: '60000',
      SCRAPE_MAX_RUNTIME_MS: '21600000', // 6h 单州看门狗
      SCRAPE_CDP_URL: '',                // 空=headless 自起浏览器（不抢 IG bot 的 Chrome）
      SCRAPE_COUNTRY: 'USA',
      // NEON_DATABASE_URL 由 VPS 系统环境 / .env 透传，无需在此硬编码
    },
    error_file: path.join(LOGS_DIR, 'maps-scrape-scheduler-error.log'),
    out_file: path.join(LOGS_DIR, 'maps-scrape-scheduler-out.log'),
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
      // BOT_API_BASE 用 pages.dev（同源 /api/* 代理到 Worker），VPS/本机/国内都能通；
      // workers.dev 子域在国内被 GFW 屏蔽，VPS 海外虽可直连但 pages.dev 更稳。
      BOT_API_BASE: 'https://harvests.pages.dev',
      BOT_ACCOUNT_IDS: 'raiha8833',
      BOT_ID: 'bot_ig_01',
      BOT_CDP_URL: 'http://localhost:9222', // 仅 CDP 模式使用；persistent 模式忽略
      BOT_PROFILE_DIR: 'C:\\harvests\\profiles\\bot_ig_01', // 含 raiha8833 IG 登录态的 profile 目录
      HUMAN_MIMICRY_ENABLED: 'true',
      BOT_LAUNCH_MODE: 'cdp', // 自起浏览器，不再依赖外部 Chrome / 9222，避免崩溃循环
      BOT_EXEC_MODE: 'browse_like',
      BOT_POLL_INTERVAL_MS: '4000',
      BOT_HEARTBEAT_INTERVAL_MS: '15000',
      BOT_HUMAN_BREAK_MIN_MS: '300000',
      BOT_HUMAN_BREAK_MAX_MS: '900000',
      BOT_BREAK_EVERY_N: '4',
      // ── 引流节奏（2026-08-06 安全版：先保守跑一周，确认无 action block 再逐步加量）──
      // 点赞：每次访问 2-3 个，间隔 45-120s（拟人节奏，过快是 IG 检测 bot 最高信号），
      //       每日总量由 bot 内置逻辑自动算（6-20/天×20%比率），单账号最多 2 赞，冷却 24-72h
      BOT_LIKE_MIN_PER_VISIT: '2',
      BOT_LIKE_MAX_PER_VISIT: '3',
      BOT_LIKE_INTERVAL_MIN_SEC: '45',
      BOT_LIKE_INTERVAL_MAX_SEC: '120',
      // 今日已点赞数强制覆盖（0=清零，让今天能继续点赞；不设=读本地状态文件）。
      // 2026-08-06: 旧 bot 把今天点赞额度刷满导致新任务被 like_skip_daily_limit 拦，
      // 用环境变量清零，避免改 VPS 本地 json。
      BOT_DAILY_LIKE_OVERRIDE: '0',
      BOT_LIKE_COOLDOWN_MIN_HOURS: '24',
      BOT_LIKE_COOLDOWN_MAX_HOURS: '72',
      // 评论：概率 0.2，每日上限 3 条（评论是最危险动作，先保守）
      BOT_COMMENT_ENABLED: 'true',
      BOT_COMMENT_CHANCE: '0.2',
      BOT_COMMENT_DAILY_MAX: '3',
      // 关注：每日 3-5 个，需同账号访问 ≥2 次后才关注（不冲动关注防反噬）
      BOT_FOLLOW_ENABLED: 'true',
      BOT_FOLLOW_DAILY_MIN: '3',
      BOT_FOLLOW_DAILY_MAX: '5',
      BOT_FOLLOW_MIN_TOUCHES: '2',
      // 只互动近 60 天内的新帖（引流价值高 + 显得活跃）
      BOT_SKIP_OLD_POST_DAYS: '60',
      BOT_PREFER_RECENT_DAYS: '30',
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
