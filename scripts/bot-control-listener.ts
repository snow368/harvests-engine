/**
 * bot-control-listener.ts
 * ─────────────────────────────────────────────────────────────────────────
 * VPS 控制平面 listener：把 cloud-api 的 bot 指令队列翻译成 pm2 启停。
 *
 * 链路：前端「Run/Stop」→ cloud-api POST /api/bot/worker/start|stop
 *       → 写 D1 bot_commands(pending) → 本 listener 轮询 GET /api/bot/commands
 *       → 执行 pm2 start/stop <进程> → POST /api/bot/commands/report 回写结果。
 *
 * 这样前台无需直连 VPS，只需 cloud-api 一个出口即可远程操控 pm2 守护的 bot。
 *
 * 环境变量：
 *   CLOUD_API_BASE  默认 https://harvests-cloud-api.inkflowapp.workers.dev
 *   BOT_API_TOKEN   必须与 cloud-api 的 BOT_API_TOKEN 一致（默认 vps-bot-secret-2024）
 *   LISTENER_INTERVAL_MS  轮询间隔，默认 10000
 *
 * 启动：npx tsx scripts/bot-control-listener.ts   （或加入 ecosystem.config.cjs）
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execAsync = promisify(exec);

const CLOUD_API_BASE = (process.env.CLOUD_API_BASE || 'https://harvests-cloud-api.inkflowapp.workers.dev').replace(/\/+$/, '');
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || 'vps-bot-secret-2024';
const INTERVAL_MS = Number(process.env.LISTENER_INTERVAL_MS || '10000');

// functionId → pm2 进程名（与 ecosystem.config.cjs 的 name 对齐）
const FUNCTION_TO_PM2: Record<string, string> = {
  ig_outreach: 'bot-worker',
  competitor_ig: 'competitor-ig-monitor',
  supply_analysis: 'backlink-worker',
  reddit_intel: 'backlink-worker',
  content_pipeline: 'bot-worker',
  general_intel: 'general-intel',
};

// 前端配置落盘路径（与 bot-general-intel.ts 约定一致）：listener 在 start 时把
// 前端卡片的 env 写入该文件，worker 启动时读取并合并（前端配置优先于 ecosystem.env）。
const CONFIG_DIR = path.resolve(__dirname, '..', 'data');
const GENERAL_INTEL_CONFIG = path.join(CONFIG_DIR, 'general-intel.config.json');

interface Cmd { id: string; functionId: string; action: 'start' | 'stop'; pm2: string | null; }

async function fetchCommands(): Promise<Cmd[]> {
  const url = `${CLOUD_API_BASE}/api/bot/commands?token=${encodeURIComponent(BOT_API_TOKEN)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[listener] GET /api/bot/commands FAILED ${res.status}`);
    return [];
  }
  const data = await res.json().catch(() => ({ ok: false, commands: [] }));
  if (!data.ok) return [];
  return (data.commands || []) as Cmd[];
}

async function runPm2(pm2Name: string, action: 'start' | 'stop'): Promise<{ ok: boolean; error?: string }> {
  try {
    if (action === 'start') {
      // 若已运行则 restart，否则 start；统一用 restart 最稳
      await execAsync(`pm2 restart ${pm2Name} || pm2 start ${pm2Name}`);
    } else {
      await execAsync(`pm2 stop ${pm2Name}`);
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

async function report(id: string, ok: boolean, error?: string) {
  try {
    await fetch(`${CLOUD_API_BASE}/api/bot/commands/report?token=${encodeURIComponent(BOT_API_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ok, error }),
    });
  } catch (e: any) {
    console.warn(`[listener] report failed for ${id}: ${e.message}`);
  }
}

async function tick() {
  const cmds = await fetchCommands();
  if (cmds.length === 0) return;
  console.log(`[listener] ${cmds.length} 条指令`);
  for (const cmd of cmds) {
    if (!cmd.pm2) {
      console.warn(`[listener] ${cmd.functionId} 无对应 pm2 进程，跳过`);
      await report(cmd.id, false, `no pm2 mapping for ${cmd.functionId}`);
      continue;
    }
    // 通用情报机器人：start 时把前端配置(env)落盘，供 worker 启动读取
    if (cmd.action === 'start' && cmd.functionId === 'general_intel' && cmd.env && Object.keys(cmd.env).length > 0) {
      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(GENERAL_INTEL_CONFIG, JSON.stringify(cmd.env, null, 2), 'utf8');
        console.log(`[listener] 写入通用情报配置 → ${GENERAL_INTEL_CONFIG}`);
      } catch (e: any) {
        console.warn(`[listener] 写通用情报配置失败: ${e.message}`);
      }
    }
    const r = await runPm2(cmd.pm2, cmd.action);
    console.log(`[listener] ${cmd.action} ${cmd.pm2} → ${r.ok ? 'OK' : 'ERR ' + r.error}`);
    await report(cmd.id, r.ok, r.error);
  }
}

async function main() {
  console.log(`=== Bot Control Listener ===`);
  console.log(`cloud-api: ${CLOUD_API_BASE}`);
  console.log(`interval: ${INTERVAL_MS}ms`);
  // 立即跑一轮，再进入循环
  while (true) {
    try { await tick(); } catch (e: any) { console.warn(`[listener] tick error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

const invoked = process.argv[1]?.replace(/\\/g, '/').endsWith('bot-control-listener.ts');
if (invoked) {
  main().catch((e) => { console.error('Fatal:', e?.message || e); process.exit(1); });
}
