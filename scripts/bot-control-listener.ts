/**
 * bot-control-listener.ts
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * VPS æŽ§åˆ¶å¹³é¢ listenerï¼šæŠŠ cloud-api çš„ bot æŒ‡ä»¤é˜Ÿåˆ—ç¿»è¯‘æˆ pm2 å¯åœã€‚
 *
 * é“¾è·¯ï¼šå‰ç«¯ã€ŒRun/Stopã€â†’ cloud-api POST /api/bot/worker/start|stop
 *       â†’ å†™ D1 bot_commands(pending) â†’ æœ¬ listener è½®è¯¢ GET /api/bot/commands
 *       â†’ æ‰§è¡Œ pm2 start/stop <è¿›ç¨‹> â†’ POST /api/bot/commands/report å›žå†™ç»“æžœã€‚
 *
 * è¿™æ ·å‰å°æ— éœ€ç›´è¿ž VPSï¼Œåªéœ€ cloud-api ä¸€ä¸ªå‡ºå£å³å¯è¿œç¨‹æ“æŽ§ pm2 å®ˆæŠ¤çš„ botã€‚
 *
 * çŽ¯å¢ƒå˜é‡ï¼š
 *   CLOUD_API_BASE  é»˜è®¤ https://harvests-cloud-api.inkflowapp.workers.dev
 *   BOT_API_TOKEN   å¿…é¡»ä¸Ž cloud-api çš„ BOT_API_TOKEN ä¸€è‡´ï¼ˆé»˜è®¤ vps-bot-secret-2024ï¼‰
 *   LISTENER_INTERVAL_MS  è½®è¯¢é—´éš”ï¼Œé»˜è®¤ 10000
 *
 * å¯åŠ¨ï¼šnpx tsx scripts/bot-control-listener.ts   ï¼ˆæˆ–åŠ å…¥ ecosystem.config.cjsï¼‰
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execAsync = promisify(exec);

const CLOUD_API_BASE = (process.env.CLOUD_API_BASE || 'https://harvests-cloud-api.inkflowapp.workers.dev').replace(/\/+$/, '');
const BOT_API_TOKEN = process.env.BOT_API_TOKEN || 'vps-bot-secret-2024';
const INTERVAL_MS = Number(process.env.LISTENER_INTERVAL_MS || '10000');

// functionId â†’ pm2 è¿›ç¨‹åï¼ˆä¸Ž ecosystem.config.cjs çš„ name å¯¹é½ï¼‰
const FUNCTION_TO_PM2: Record<string, string> = {
  ig_outreach: 'bot-worker',
  competitor_ig: 'competitor-ig-monitor',
  supply_analysis: 'backlink-worker',
  reddit_intel: 'backlink-worker',
  content_pipeline: 'bot-worker',
  general_intel: 'general-intel',
};

// å‰ç«¯é…ç½®è½ç›˜è·¯å¾„ï¼ˆä¸Ž bot-general-intel.ts çº¦å®šä¸€è‡´ï¼‰ï¼šlistener åœ¨ start æ—¶æŠŠ
// å‰ç«¯å¡ç‰‡çš„ env å†™å…¥è¯¥æ–‡ä»¶ï¼Œworker å¯åŠ¨æ—¶è¯»å–å¹¶åˆå¹¶ï¼ˆå‰ç«¯é…ç½®ä¼˜å…ˆäºŽ ecosystem.envï¼‰ã€‚
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
      // è‹¥å·²è¿è¡Œåˆ™ restartï¼Œå¦åˆ™ startï¼›ç»Ÿä¸€ç”¨ restart æœ€ç¨³
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
  console.log(`[listener] ${cmds.length} æ¡æŒ‡ä»¤`);
  for (const cmd of cmds) {
    if (!cmd.pm2) {
      console.warn(`[listener] ${cmd.functionId} æ— å¯¹åº” pm2 è¿›ç¨‹ï¼Œè·³è¿‡`);
      await report(cmd.id, false, `no pm2 mapping for ${cmd.functionId}`);
      continue;
    }
    // é€šç”¨æƒ…æŠ¥æœºå™¨äººï¼šstart æ—¶æŠŠå‰ç«¯é…ç½®(env)è½ç›˜ï¼Œä¾› worker å¯åŠ¨è¯»å–
    if (cmd.action === 'start' && cmd.functionId === 'general_intel' && cmd.env && Object.keys(cmd.env).length > 0) {
      try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.writeFileSync(GENERAL_INTEL_CONFIG, JSON.stringify(cmd.env, null, 2), 'utf8');
        console.log(`[listener] å†™å…¥é€šç”¨æƒ…æŠ¥é…ç½® â†’ ${GENERAL_INTEL_CONFIG}`);
      } catch (e: any) {
        console.warn(`[listener] å†™é€šç”¨æƒ…æŠ¥é…ç½®å¤±è´¥: ${e.message}`);
      }
    }
    const r = await runPm2(cmd.pm2, cmd.action);
    console.log(`[listener] ${cmd.action} ${cmd.pm2} â†’ ${r.ok ? 'OK' : 'ERR ' + r.error}`);
    await report(cmd.id, r.ok, r.error);
  }
}

async function main() {
  console.log(`=== Bot Control Listener ===`);
  console.log(`cloud-api: ${CLOUD_API_BASE}`);
  console.log(`interval: ${INTERVAL_MS}ms`);
  // ç«‹å³è·‘ä¸€è½®ï¼Œå†è¿›å…¥å¾ªçŽ¯
  while (true) {
    try { await tick(); } catch (e: any) { console.warn(`[listener] tick error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

const invoked = process.argv[1]?.replace(/\\/g, '/').endsWith('bot-control-listener.ts');
if (invoked) {
  main().catch((e) => { console.error('Fatal:', e?.message || e); process.exit(1); });
}
