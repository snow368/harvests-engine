/** Periodically imports Maps CSV output into D1 and creates missing bot tasks. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'data', 'scrape_output');
const BRIDGE_SCRIPT = path.join(__dirname, '_import_maps_to_d1.py');
const PYTHON = process.env.PYTHON || 'python';
const INTERVAL_MS = Math.max(60_000, Number(process.env.SCRAPE_BRIDGE_INTERVAL_MS || 30 * 60_000));
let running = false;

async function importState(state: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`[maps-d1-bridge] ${state} -> D1 + tasks`);
    const child = spawn(PYTHON, [BRIDGE_SCRIPT, state], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data) => process.stdout.write(`[bridge:${state}] ${data}`));
    child.stderr.on('data', (data) => process.stderr.write(`[bridge:${state}|err] ${data}`));
    child.on('error', (error) => {
      console.error(`[maps-d1-bridge] ${state} spawn failed: ${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      if (code !== 0) console.error(`[maps-d1-bridge] ${state} exit=${code}`);
      resolve(code === 0);
    });
  });
}

async function runOnce() {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let succeeded = 0;
  let failed = 0;
  try {
    const files = fs.existsSync(OUTPUT_DIR)
      ? fs.readdirSync(OUTPUT_DIR).filter((name) => /^[A-Z]{2}_Raw\.csv$/.test(name))
      : [];
    for (const file of files) {
      try {
        if (fs.statSync(path.join(OUTPUT_DIR, file)).size < 200) continue;
      } catch { continue; }
      if (await importState(file.slice(0, 2))) succeeded += 1;
      else failed += 1;
    }
    console.log(`[maps-d1-bridge] cycle done: ok=${succeeded} failed=${failed} duration=${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (error: any) {
    console.error(`[maps-d1-bridge] cycle failed: ${error?.message || error}`);
  } finally {
    running = false;
  }
}

console.log(`[maps-d1-bridge] started; interval=${Math.round(INTERVAL_MS / 60000)}min output=${OUTPUT_DIR}`);
void runOnce();
setInterval(() => void runOnce(), INTERVAL_MS);
