/** Host-aware PM2 control listener. */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_API_BASE = (process.env.CLOUD_API_BASE || 'https://harvests-cloud-api.pages.dev').replace(/\/+$/, '');
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || 'vps-bot-secret-2024';
const INTERVAL_MS = Math.max(3000, Number(process.env.LISTENER_INTERVAL_MS || '10000'));
const CONTROL_HOST_ID = process.env.CONTROL_HOST_ID || 'vps-windows';
const CONTROL_HOST_LABEL = process.env.CONTROL_HOST_LABEL || CONTROL_HOST_ID;

const FUNCTION_TO_PM2: Record<string, string> = {
  ig_outreach: 'bot-worker',
  ig_scheduler: 'ig-scheduler',
  maps_scraper: 'maps-scrape-scheduler',
  maps_bridge: 'maps-d1-bridge',
  competitor_ig: 'competitor-ig-monitor',
  supply_analysis: 'backlink-worker',
  reddit_intel: 'backlink-worker',
  content_pipeline: 'bot-worker',
  general_intel: 'general-intel',
};

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const PAUSE_DIR = path.join(DATA_DIR, 'control-pause');
const GENERAL_INTEL_CONFIG = path.join(DATA_DIR, 'general-intel.config.json');

type ControlAction = 'start' | 'stop' | 'pause' | 'resume' | 'restart';
interface Cmd {
  id: string;
  functionId: string;
  action: ControlAction;
  pm2: string | null;
  env?: Record<string, unknown>;
}

async function api(pathname: string, init?: RequestInit) {
  return fetch(`${CLOUD_API_BASE}${pathname}`, init);
}

async function fetchCommands(): Promise<Cmd[]> {
  const query = new URLSearchParams({ token: BOT_API_TOKEN, hostId: CONTROL_HOST_ID });
  const res = await api(`/api/bot/commands?${query}`);
  if (!res.ok) {
    console.warn(`[listener] command poll failed: ${res.status}`);
    return [];
  }
  const data: any = await res.json().catch(() => ({}));
  return data.ok && Array.isArray(data.commands) ? data.commands : [];
}

async function pm2Snapshot(): Promise<Record<string, any>> {
  try {
    const { stdout } = await execAsync('pm2 jlist', { maxBuffer: 4 * 1024 * 1024 });
    const rows = JSON.parse(stdout || '[]');
    const snapshot: Record<string, any> = {};
    for (const row of rows) {
      const name = String(row?.name || '');
      if (!name) continue;
      snapshot[name] = {
        status: String(row?.pm2_env?.status || 'unknown'),
        pid: Number(row?.pid || 0),
        restarts: Number(row?.pm2_env?.restart_time || 0),
        uptime: Number(row?.pm2_env?.pm_uptime || 0),
      };
    }
    return snapshot;
  } catch (error: any) {
    return { _error: String(error?.message || error).slice(0, 240) };
  }
}

async function heartbeat() {
  const query = new URLSearchParams({ token: BOT_API_TOKEN });
  const res = await api(`/api/bot/control/heartbeat?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hostId: CONTROL_HOST_ID,
      label: CONTROL_HOST_LABEL,
      processes: await pm2Snapshot(),
      meta: { platform: process.platform, pid: process.pid },
    }),
  });
  if (!res.ok) console.warn(`[listener] heartbeat failed: ${res.status}`);
}

function pauseFile(pm2Name: string) {
  return path.join(PAUSE_DIR, `${pm2Name}.pause`);
}

async function runCommand(cmd: Cmd): Promise<{ ok: boolean; error?: string }> {
  const pm2Name = cmd.pm2 || FUNCTION_TO_PM2[cmd.functionId];
  if (!pm2Name) return { ok: false, error: `no pm2 mapping for ${cmd.functionId}` };
  try {
    if (cmd.action === 'pause') {
      fs.mkdirSync(PAUSE_DIR, { recursive: true });
      fs.writeFileSync(pauseFile(pm2Name), new Date().toISOString(), 'utf8');
      return { ok: true };
    }
    if (cmd.action === 'resume') {
      fs.rmSync(pauseFile(pm2Name), { force: true });
      return { ok: true };
    }
    if ((cmd.action === 'start' || cmd.action === 'restart') && cmd.functionId === 'general_intel' && cmd.env) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(GENERAL_INTEL_CONFIG, JSON.stringify(cmd.env, null, 2), 'utf8');
    }
    if (cmd.action === 'stop') {
      await execAsync(`pm2 stop ${pm2Name}`);
    } else if (cmd.action === 'restart') {
      await execAsync(`pm2 restart ${pm2Name} --update-env`);
    } else {
      await execAsync(`pm2 restart ${pm2Name} --update-env || pm2 start ecosystem.config.cjs --only ${pm2Name}`);
    }
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error).slice(0, 500) };
  }
}

async function report(id: string, result: { ok: boolean; error?: string }) {
  const query = new URLSearchParams({ token: BOT_API_TOKEN });
  await api(`/api/bot/commands/report?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ok: result.ok, error: result.error }),
  });
}

async function tick() {
  await heartbeat();
  const commands = await fetchCommands();
  for (const cmd of commands) {
    const result = await runCommand(cmd);
    console.log(`[listener:${CONTROL_HOST_ID}] ${cmd.action} ${cmd.pm2 || cmd.functionId}: ${result.ok ? 'ok' : result.error}`);
    await report(cmd.id, result);
  }
  if (commands.length) await heartbeat();
}

async function main() {
  console.log(`[listener] host=${CONTROL_HOST_ID} api=${CLOUD_API_BASE} interval=${INTERVAL_MS}ms`);
  while (true) {
    try { await tick(); }
    catch (error: any) { console.warn(`[listener] tick failed: ${error?.message || error}`); }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('bot-control-listener.ts')) {
  main().catch((error) => { console.error('[listener] fatal:', error); process.exit(1); });
}
