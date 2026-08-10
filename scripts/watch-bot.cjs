#!/usr/bin/env node
/**
 * watch-bot.cjs — 前台可见模式启动器（仅用于「看」bot 跑，非生产）
 *
 * 两种模式：
 *   WATCH_MODE=cdp（默认）：本脚本先起一个【长命、可见】的 Chrome（--remote-debugging-port=9222），
 *       bot 通过 connectOverCDP 连上去复用它。Chrome 由本脚本持有，不会在 bot 逻辑崩时反复
 *       被 tear down/重建，因此不会再出现 SingletonLock 之战 / 冻屏孤儿窗 —— 以前稳定运行就是这套。
 *       窗口是你眼前真实有头 Chrome，可直接看到点赞/评论/关注/DM。
 *
 *   WATCH_MODE=persistent（旧行为兜底）：bot 自己 launch Chromium。仅在 CDP 模式跑不通时临时用。
 *
 * 用法（务必在 RDP/控制台交互会话里跑，不要经 pm2 服务）：
 *   1. 先停掉后台服务 bot，避免重复进程 + profile 锁冲突：
 *        pm2 stop bot-worker      （或 pm2 delete bot-worker）
 *   2. 前台运行（Chrome 窗口会弹出来）：
 *        node scripts/watch-bot.cjs
 *      要看其它号：WATCH_BOT_ID=bot-worker-02 node scripts/watch-bot.cjs
 *      已有 Chrome 开着 9222 想直接复用：WATCH_SKIP_CHROME=1 node scripts/watch-bot.cjs
 *   3. 看完按 Ctrl+C 退出（会一并关掉 Chrome），再恢复生产：
 *        pm2 start ecosystem.matrix.config.cjs --only bot-worker
 *
 * 注意：前台模式进程绑定你的 RDP 会话，RDP 断开可能让它退出，仅用于观察。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// 加载 ecosystem 配置，取出目标 app 的 env（模板字符串已在 module 执行时求值完成）
const cfg = require(path.join(__dirname, '..', 'ecosystem.matrix.config.cjs'));
const target = process.env.WATCH_BOT_ID || 'bot-worker';
const app = (cfg.apps || []).find((a) => a.name === target);

if (!app) {
  console.error(`[watch-bot] 找不到名为 "${target}" 的 app。可用:`, (cfg.apps || []).map((a) => a.name).join(', '));
  process.exit(1);
}

const env = { ...process.env, ...(app.env || {}) };
const cwd = app.cwd || __dirname;
const script = app.script || './scripts/bot-worker-real.ts';
// 与 ecosystem 保持一致：node --import tsx <script>
// ⚠️ node_args 是单个字符串("--import tsx")，必须按空格拆成独立 argv 元素，
//    否则 node 会把整串当成一个未知选项："bad option: --import tsx"
const nodeArgs = app.node_args ? app.node_args.trim().split(/\s+/) : ['--import', 'tsx'];
const args = [...nodeArgs, script];

const WATCH_MODE = (process.env.WATCH_MODE || 'cdp').toLowerCase();
const CDP_PORT = parseInt(process.env.WATCH_CDP_PORT || '9222', 10);
const PROFILE_DIR = path.resolve(cwd, env.BOT_PROFILE_DIR || `./data/bot_profiles/${env.BOT_ID || 'bot_ig_01'}`);

// ── 定位 Chrome 可执行文件（优先用 Playwright 自带的 chromium，版本无关）─────────
function findChrome() {
  if (process.env.WATCH_CHROME_BIN && fs.existsSync(process.env.WATCH_CHROME_BIN)) {
    return process.env.WATCH_CHROME_BIN;
  }
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const base = path.join(local, 'ms-playwright');
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base)
      .filter((d) => /^chromium(-\d+)?$/.test(d))
      .sort();
    // 取版本号最大的那个
    for (const d of dirs.reverse()) {
      const p = path.join(base, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// ── 轮询 CDP 端口就绪 ───────────────────────────────────────────────
function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() < deadline) setTimeout(tick, 500);
        else resolve(false);
      });
      req.setTimeout(1000, () => { req.destroy(); if (Date.now() < deadline) setTimeout(tick, 500); else resolve(false); });
    };
    tick();
  });
}

console.log('────────────────────────────────────────────────────');
console.log(`[watch-bot] 前台可见模式启动: ${app.name}  (mode=${WATCH_MODE})`);
console.log(`[watch-bot] BOT_ID=${env.BOT_ID}  ACCOUNT=${env.BOT_ACCOUNT_IDS}`);
console.log(`[watch-bot] PROFILE_DIR=${PROFILE_DIR}`);
if (WATCH_MODE === 'cdp') {
  console.log(`[watch-bot] CDP 模式：本脚本先起一个长命可见 Chrome(:${CDP_PORT})，bot 连上去复用`);
} else {
  console.log(`[watch-bot] persistent 模式：bot 自己 launch Chromium（旧行为）`);
}
console.log(`[watch-bot] 退出请按 Ctrl+C（RDP 断开可能导致本进程退出，仅用于观察）`);
console.log('────────────────────────────────────────────────────');

// 子进程句柄
let chromeProc = null;
let botProc = null;
let shuttingDown = false;

// 仅清我们自己的 profile 锁（不误杀别的 chrome）
function clearOwnProfileLock() {
  try {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'SingletonTimedLock']) {
      try { fs.rmSync(path.join(PROFILE_DIR, f), { force: true }); } catch {}
    }
  } catch {}
}

// 启动 Chrome（CDP 模式）。返回 child process。
function launchChrome() {
  const chromeBin = findChrome();
  if (!chromeBin) {
    console.error(`[watch-bot] 找不到 Chrome（ms-playwright/chromium）。请用 WATCH_CHROME_BIN 指定，或先 npm i -D playwright + npx playwright install chromium`);
    process.exit(1);
  }
  console.log(`[watch-bot] 启动可见 Chrome: ${chromeBin}`);
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--start-maximized',
  ];
  const p = spawn(chromeBin, chromeArgs, {
    cwd,
    env: { ...env, BOT_LAUNCH_MODE: 'cdp', BOT_CDP_URL: `http://127.0.0.1:${CDP_PORT}` },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  p.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.warn(`[watch-bot] ⚠ Chrome 退出 code=${code} signal=${signal} —— 5s 后自动重起（同一 profile，不会锁冲突）`);
    setTimeout(() => {
      if (!shuttingDown) chromeProc = launchChrome();
    }, 5000);
  });
  return p;
}

// 启动 bot worker
function launchBot() {
  const botEnv = { ...env };
  if (WATCH_MODE === 'cdp') {
    // 强制走 CDP 分支：任何非 'persistent' 的值都会触发 connectOverCDP，且需要 BOT_CDP_URL
    botEnv.BOT_LAUNCH_MODE = 'cdp';
    botEnv.BOT_CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
  }
  console.log(`[watch-bot] 启动 bot worker: ${process.execPath} ${args.join(' ')}`);
  const p = spawn(process.execPath, args, { cwd, env: botEnv, stdio: 'inherit' });
  p.on('exit', (code, signal) => {
    console.log(`[watch-bot] bot 子进程退出 code=${code} signal=${signal}`);
    shutdown(code || 0);
  });
  return p;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (botProc && !botProc.killed) botProc.kill('SIGTERM'); } catch {}
  try { if (chromeProc && !chromeProc.killed) chromeProc.kill('SIGTERM'); } catch {}
  setTimeout(() => process.exit(code), 1500);
}

const forward = (sig) => () => {
  if (!shuttingDown) {
    try { if (botProc && !botProc.killed) botProc.kill(sig); } catch {}
    try { if (chromeProc && !chromeProc.killed) chromeProc.kill(sig); } catch {}
  }
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

// ── 主流程 ──────────────────────────────────────────────────────────
(async () => {
  if (WATCH_MODE === 'cdp') {
    if (process.env.WATCH_SKIP_CHROME === '1') {
      console.log('[watch-bot] WATCH_SKIP_CHROME=1：复用已有 Chrome（请确保它已在 :' + CDP_PORT + ' 开启）');
    } else {
      clearOwnProfileLock(); // 仅清我们 profile 的残留锁，避免上次异常退出留下
      chromeProc = launchChrome();
      const ok = await waitForCdp(CDP_PORT);
      if (!ok) {
        console.error(`[watch-bot] Chrome 在 :${CDP_PORT} 未在 20s 内就绪，退出`);
        shutdown(1);
        return;
      }
      console.log(`[watch-bot] ✅ Chrome CDP 已就绪 (http://127.0.0.1:${CDP_PORT})`);
    }
    botProc = launchBot();
  } else {
    botProc = launchBot();
  }
})();
