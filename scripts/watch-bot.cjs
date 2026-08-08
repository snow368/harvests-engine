#!/usr/bin/env node
/**
 * watch-bot.cjs — 前台可见模式启动器（仅用于「看」bot 跑，非生产）
 *
 * 为什么需要它：
 *   pm2 把 bot 跑在 Windows 服务会话（Session 0，非交互桌面），即便 headless:false，
 *   Chrome 窗口也渲染在你看不到的桌面。本脚本在「你当前的交互桌面（RDP/控制台会话）」里
 *   直接拉起 bot 进程，Chromium 窗口会弹到你眼前，可实时看到点赞/评论/关注/DM。
 *
 * 用法（务必在 RDP/控制台会话里跑，不要经 pm2 服务）：
 *   1. 先停掉后台服务 bot，避免重复进程+profile 锁冲突：
 *        pm2 stop bot-worker      （或 pm2 delete bot-worker）
 *   2. 前台运行（窗口会弹出来）：
 *        node scripts/watch-bot.cjs
 *      要看其它号：WATCH_BOT_ID=bot-worker-02 node scripts/watch-bot.cjs
 *   3. 看完 Ctrl+C 退出，再恢复生产：
 *        pm2 start ecosystem.matrix.config.cjs --only bot-worker
 *
 * 注意：前台模式进程绑定你的 RDP 会话，RDP 断开可能让它退出，仅用于观察。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

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

console.log('────────────────────────────────────────────────────');
console.log(`[watch-bot] 前台可见模式启动: ${app.name}`);
console.log(`[watch-bot] BOT_ID=${env.BOT_ID}  ACCOUNT=${env.BOT_ACCOUNT_IDS}  LAUNCH_MODE=${env.BOT_LAUNCH_MODE}`);
console.log(`[watch-bot] 这是真实有头 Chromium，窗口会弹到你的桌面 —— 直接看它点赞/评论/关注/DM`);
console.log(`[watch-bot] 退出请按 Ctrl+C（RDP 断开可能导致本进程退出，仅用于观察）`);
console.log('────────────────────────────────────────────────────');

const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });

const forward = (sig) => () => {
  if (!child.killed) child.kill(sig);
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code, signal) => {
  console.log(`[watch-bot] 子进程退出 code=${code} signal=${signal}`);
  process.exit(code || 0);
});
