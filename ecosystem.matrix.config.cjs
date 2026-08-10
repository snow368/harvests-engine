/**
 * PM2 Ecosystem — Bot Workers 矩阵版（1 SUPPLY 号 + N 触达号）
 *
 * 架构（2026-08-07 用户拍板）：
 *   1 个 SUPPLY 号（bot_ig_01 / raiha8833）= 信任背书 + 承接询价（发内容、bio 正规）
 *   N 个触达小号（bot_ig_02~05）          = 跑 bot 主动联系纹身师（关注/点赞/评论）
 *   触达号 bio 挂 SUPPLY 号、评论 @SUPPLY 号 → 流量导向主号
 *
 * 部署（VPS，Windows）— 自运维模式（BOT_LAUNCH_MODE=persistent，bot 自己开浏览器）：
 *   1. 首登（每号仅一次）：手动开 Chrome 登录 IG 保留登录态到 profile：
 *        chrome.exe --remote-debugging-port=922x --user-data-dir=C:\harvests\profiles\bot_ig_0x
 *      （9222=主号，9223~9226=触达号，端口/profile 一一对应，勿混用）
 *   2. 装一次 chromium（VPS 缺这个，装完 bot 才能自起浏览器）：
 *        cd C:\harvests\harvests-engine && npx playwright install chromium
 *   3. 填下方 TOUCH_ACCOUNTS 里各号的 ig 用户名（CHANGE_ME_x）
 *   4. 启动 + 开机自启（之后 VPS 重启全自动，无需手动开 Chrome）：
 *        pm2 delete all
 *        pm2 start ecosystem.matrix.config.cjs
 *        pm2 save
 *        pm2 startup
 *   5. 验证：pm2 logs bot-worker --lines 5  → "launched persistent browser" / "profile ready"
 *
 * 注意：
 *   - persistent 模式：bot 自己 launchPersistentContext 打开 profile 里的已登录 IG，
 *     外部 922x Chrome 不再需要，关掉也无所谓；profile 登录态跨启动保留。
 *   - BOT_ID 全局唯一；bot_ig_01 是 SUPPLY 主号，勿删
 *   - 新号先养 7-14 天再跑 bot（防关联封号）；5 个号分批登录，别同一 IP 批量操作
 *   - 本文件基于 VPS 线上 cdp 版（commit 5617c66）扩展；outreach 主号+触达号已转 persistent
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

// ── 触达号清单（填用户名后启用）────────────────
// port 与 profile 一一对应：9223→bot_ig_02，9224→bot_ig_03 …
const TOUCH_ACCOUNTS = [
  { botId: 'bot_ig_02', ig: 'CHANGE_ME_2', port: 9223, profile: 'bot_ig_02' },
  { botId: 'bot_ig_03', ig: 'CHANGE_ME_3', port: 9224, profile: 'bot_ig_03' },
  { botId: 'bot_ig_04', ig: 'CHANGE_ME_4', port: 9225, profile: 'bot_ig_04' },
  { botId: 'bot_ig_05', ig: 'CHANGE_ME_5', port: 9226, profile: 'bot_ig_05' },
];

// 触达号 worker 生成器：与主号 bot-worker 同配置，仅账号/端口/profile 不同
const makeTouchWorker = ({ botId, ig, port, profile }) => ({
  name: `bot-worker-${botId.replace('bot_ig_', '')}`,
  cwd: ENGINE_DIR,
  script: './scripts/bot-worker-real.ts',
  interpreter: 'node.exe',
  node_args: '--import tsx',
  ...DEFAULTS,
  restart_delay: 15_000,
  kill_timeout: 30_000,
  env: {
    ...COMMON_ENV,
    BOT_API_BASE: 'https://harvests.pages.dev',
    BOT_ACCOUNT_IDS: ig,
    BOT_ID: botId,
    BOT_CDP_URL: `http://localhost:${port}`,
    BOT_PROFILE_DIR: `C:\\harvests\\profiles\\${profile}`,
    HUMAN_MIMICRY_ENABLED: 'true',
    BOT_LAUNCH_MODE: 'persistent',
    BOT_EXEC_MODE: 'browse_like',
    BOT_POLL_INTERVAL_MS: '4000',
    BOT_HEARTBEAT_INTERVAL_MS: '15000',
    BOT_HUMAN_BREAK_MIN_MS: '300000',
    BOT_HUMAN_BREAK_MAX_MS: '900000',
    BOT_BREAK_EVERY_N: '4',
    // 引流节奏（安全版）：先保守跑一周，确认无 action block 再逐步加量
    BOT_LIKE_MIN_PER_VISIT: '2',
    BOT_LIKE_MAX_PER_VISIT: '3',
    BOT_LIKE_INTERVAL_MIN_SEC: '45',
    BOT_LIKE_INTERVAL_MAX_SEC: '120',
    BOT_DAILY_LIKE_OVERRIDE: '0',
    BOT_LIKE_COOLDOWN_MIN_HOURS: '24',
    BOT_LIKE_COOLDOWN_MAX_HOURS: '72',
    BOT_COMMENT_ENABLED: 'true',
    BOT_COMMENT_CHANCE: '0.4',
    BOT_COMMENT_DAILY_MAX: '15',
    BOT_FOLLOW_ENABLED: 'true',
    BOT_FOLLOW_DAILY_MIN: '15',
    BOT_FOLLOW_DAILY_MAX: '40',
    BOT_FOLLOW_MIN_TOUCHES: '1',
    BOT_SKIP_OLD_POST_DAYS: '60',
    BOT_PREFER_RECENT_DAYS: '30',
    BOT_ACCOUNT_BOUND_AT: '2026-06-19T00:00:00Z',
  },
  error_file: path.join(LOGS_DIR, `${botId}-error.log`),
  out_file: path.join(LOGS_DIR, `${botId}-out.log`),
});

// ── 应用列表 ────────────────────────────────────
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
      CLOUD_API_BASE: 'https://harvests.pages.dev',
      SCHEDULER_BOT_ID: 'bot_ig_01',
      SCHEDULER_DAILY_LIMIT: '50',
      SCHEDULER_STATE: 'ALL',
    },
    error_file: path.join(LOGS_DIR, 'scheduler-error.log'),
    out_file: path.join(LOGS_DIR, 'scheduler-out.log'),
  },

  // ── 1b. Maps Scrape Scheduler ───────────────────
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
      CLOUD_API_BASE: 'https://harvests.pages.dev',
      SCRAPE_POLL_INTERVAL_MS: '60000',
      SCRAPE_MAX_RUNTIME_MS: '21600000',
      SCRAPE_CDP_URL: '',
      SCRAPE_COUNTRY: 'USA',
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
    cron_restart: '0 9 * * *',
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

  // ── 2. Bot Worker（SUPPLY 主号 = 信任背书 + 承接）────
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
      BOT_API_BASE: 'https://harvests.pages.dev',
      BOT_ACCOUNT_IDS: 'raiha8833',
      BOT_ID: 'bot_ig_01',
      BOT_CDP_URL: 'http://localhost:9222',
      BOT_PROFILE_DIR: 'C:\\harvests\\profiles\\bot_ig_01',
      HUMAN_MIMICRY_ENABLED: 'true',
      BOT_LAUNCH_MODE: 'persistent',
      BOT_EXEC_MODE: 'browse_like',
      BOT_POLL_INTERVAL_MS: '4000',
      BOT_HEARTBEAT_INTERVAL_MS: '15000',
      BOT_HUMAN_BREAK_MIN_MS: '300000',
      BOT_HUMAN_BREAK_MAX_MS: '900000',
      BOT_BREAK_EVERY_N: '4',
      BOT_LIKE_MIN_PER_VISIT: '2',
      BOT_LIKE_MAX_PER_VISIT: '3',
      BOT_LIKE_INTERVAL_MIN_SEC: '45',
      BOT_LIKE_INTERVAL_MAX_SEC: '120',
      BOT_DAILY_LIKE_OVERRIDE: '0',
      BOT_LIKE_COOLDOWN_MIN_HOURS: '24',
      BOT_LIKE_COOLDOWN_MAX_HOURS: '72',
      BOT_COMMENT_ENABLED: 'true',
      BOT_COMMENT_CHANCE: '0.4',
      BOT_COMMENT_DAILY_MAX: '15',
      BOT_FOLLOW_ENABLED: 'true',
      BOT_FOLLOW_DAILY_MIN: '15',
      BOT_FOLLOW_DAILY_MAX: '40',
      BOT_FOLLOW_MIN_TOUCHES: '1',
      // 关注优先级闸门：'*' = 所有任务层级都允许关注（scheduler 当前不注入 followPriority，留空即放行；
      //   '*' 为未来按优先级排程留余地，同时避免误设为仅 high 卡住关注量）。
      BOT_FOLLOW_PRIORITIES: '*',
      // 放宽 round 1（Stage B，待观察 Stage A 后 push）：点赞目标降到 2 篇（DM 闸门本就需 ≥2 赞）、
      //   点赞间隔降到 4h、评论间隔降到 4h → 回关号 ~4h 即攒够 ≥2 赞 + 1 评跨过 DM-able 门槛（Stage A 为 ~8h）
      RAPPORT_LIKE_TARGET: '2',
      RAPPORT_LIKE_GAP_HOURS: '4',
      RAPPORT_COMMENT_AFTER_HOURS: '4',
      // 回关后 DM 预热窗：默认 4h，降到 1h 让回关号更快收到开场白（仍拟人）
      BOT_DM_WARMUP_HOURS: '1',
      BOT_SKIP_OLD_POST_DAYS: '60',
      BOT_PREFER_RECENT_DAYS: '30',
      BOT_ACCOUNT_BOUND_AT: '2026-06-19T00:00:00Z',
    },
    error_file: path.join(LOGS_DIR, 'bot-worker-error.log'),
    out_file: path.join(LOGS_DIR, 'bot-worker-out.log'),
  },

  // ── 2b. 触达号矩阵（生成）──────────────────────
  ...TOUCH_ACCOUNTS.map(makeTouchWorker),

  // ── 5. Competitor IG Monitor ──────────────────
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
    args: ['--loop', '--interval-min', '360'],
    error_file: path.join(LOGS_DIR, 'competitor-ig-monitor-error.log'),
    out_file: path.join(LOGS_DIR, 'competitor-ig-monitor-out.log'),
  },

  // ── 5b. 通用行业情报机器人 ──────────────────
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
