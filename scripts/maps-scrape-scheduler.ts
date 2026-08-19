/**
 * Maps Scrape Scheduler â€” æ¶ˆè´¹ maps_scrape_jobs é˜Ÿåˆ—ï¼ˆMaps Scrape é¡µé¢ã€ŒåŠ å…¥é˜Ÿåˆ—ã€ï¼‰
 *
 * é—­çŽ¯ï¼š
 *   å‰ç«¯é€‰å·ž/åŸŽå¸‚ â†’ POST /api/maps-scrape/jobs (status=pending)
 *   â†’ æœ¬è°ƒåº¦å™¨æ¯ N ç§’è½®è¯¢ pending job
 *   â†’ è¯¥å·žæ— åŸŽå¸‚åˆ—è¡¨åˆ™å…ˆ fetch_cities.py çŽ°ç”Ÿæˆ
 *   â†’ æ‹‰èµ· python_scraper.py å­è¿›ç¨‹ï¼ˆheadless è‡ªèµ·æµè§ˆå™¨ï¼Œä¸æŠ¢ IG bot çš„ Chromeï¼‰
 *   â†’ scraper è‡ªå·±è°ƒ cloud_status å›žæŠ¥ runningâ†’completedï¼Œå‰ç«¯è¿›åº¦æ¡(cities_done/total)å®žæ—¶æ›´æ–°
 *
 * ä¸²è¡Œå¤„ç†ï¼ˆä¸€æ¬¡ä¸€ä¸ªå·žï¼‰ï¼Œé¿å… Chrome / Neon äº‰ç”¨ã€‚
 *
 * ENV:
 *   CLOUD_API_BASE          â€” cloud-api Worker åœ°å€ï¼ˆé»˜è®¤ https://harvests-cloud-api.inkflowapp.workers.devï¼‰
 *   BOT_API_TOKEN           â€” VPS bot å¯†é’¥ï¼ˆé»˜è®¤ vps-bot-secret-2024ï¼Œé¡»ä¸Ž cloud-api ä¸€è‡´ï¼‰
 *   SCRAPE_POLL_INTERVAL_MS â€” è½®è¯¢é—´éš”ï¼ˆé»˜è®¤ 60000ï¼‰
 *   SCRAPE_PYTHON           â€” python å¯æ‰§è¡Œåï¼ˆé»˜è®¤ pythonï¼‰
 *   SCRAPE_MAX_RUNTIME_MS   â€” å•å·žçœ‹é—¨ç‹—ï¼ˆé»˜è®¤ 6hï¼Œè¶…æ—¶å¼ºæ€é˜²æŒ‚æ­»ï¼‰
 *   SCRAPE_CDP_URL          â€” ä¼ ç©º=headless è‡ªèµ·æµè§ˆå™¨ï¼ˆé»˜è®¤ç©ºï¼‰ï¼›å¡« http://127.0.0.1:9222 åˆ™å¤ç”¨å¤–éƒ¨ Chrome
 *   SCRAPE_COUNTRY          â€” é»˜è®¤å›½å®¶ï¼ˆé»˜è®¤ USAï¼‰
 *   NEON_DATABASE_URL       â€” é€ä¼ ç»™ scraperï¼ˆå†™ artists åˆ° Neonï¼‰
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============ Config ============
// é˜²å¾¡ï¼šæ¸…æŽ‰æœ¬åœ°ä»£ç† envï¼ˆæœ¬æœº/VPS çš„ 127.0.0.1:10808 ä»£ç†ç«¯å£åœ¨æ²™ç®±é‡Œä¸å­˜åœ¨ï¼Œä¼šè®© node fetch / python urllib å¤±è´¥ï¼‰
for (const k of ['HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy','ALL_PROXY','all_proxy','NODE_USE_ENV_PROXY']) {
  delete process.env[k];
}
const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url)); // scripts/
const CLOUD_API_BASE = (process.env.CLOUD_API_BASE || 'https://harvests-cloud-api.inkflowapp.workers.dev').replace(/\/+$/, '');
const BOT_API_TOKEN = (process.env.BOT_API_TOKEN || 'vps-bot-secret-2024').trim();
const POLL_INTERVAL_MS = Number(process.env.SCRAPE_POLL_INTERVAL_MS) || 60_000;
const PYTHON = process.env.SCRAPE_PYTHON || 'python';
const MAX_RUNTIME_MS = Number(process.env.SCRAPE_MAX_RUNTIME_MS) || 6 * 60 * 60 * 1000;
const CDP_URL = process.env.SCRAPE_CDP_URL !== undefined ? process.env.SCRAPE_CDP_URL : '';
const COUNTRY_DEFAULT = (process.env.SCRAPE_COUNTRY || 'USA').toUpperCase();

// ============ Load .env (parent dir, same as other schedulers) ============
const ENV_PATH = path.resolve(ENGINE_DIR, '..', '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) {
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (k && v && !(k in process.env)) process.env[k] = v;
    }
  }
}

// scraper å­è¿›ç¨‹çŽ¯å¢ƒï¼šç»§æ‰¿æœ¬è¿›ç¨‹ï¼ˆå« .env æ³¨å…¥çš„ NEON_DATABASE_URL / CLOUD_API_BASE ç­‰ï¼‰ï¼Œå¹¶å‰”æŽ‰ä»£ç† env
const SCRAPER_ENV: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const k of ['HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy','ALL_PROXY','all_proxy','NODE_USE_ENV_PROXY']) {
  delete (SCRAPER_ENV as any)[k];
}
// å…³é”®ï¼šscraper çš„ stdout è¢«ç®¡é“æŽ¥ç®¡æ—¶æ˜¯å—ç¼“å†²ï¼Œprogress JSON ä¸ä¼šå®žæ—¶åˆ·å‡ºï¼Œ
// å¯¼è‡´è°ƒåº¦å™¨è§£æžä¸åˆ°è¿›åº¦ã€‚è®¾ PYTHONUNBUFFERED=1 å¼ºåˆ¶è¡Œç¼“å†²ï¼Œè¿›åº¦æ¡æ‰èƒ½å®žæ—¶èµ°åŠ¨ã€‚
SCRAPER_ENV.PYTHONUNBUFFERED = '1';

// ============ in-memory lock ============
let running = false;
const launched = new Set<string>();

// ============ API helpers ============
async function fetchJobs(): Promise<any[]> {
  try {
    const resp = await fetch(`${CLOUD_API_BASE}/api/maps-scrape/jobs`, {
      headers: { Authorization: `Bearer ${BOT_API_TOKEN}` },
    });
    if (!resp.ok) { console.error(`[maps-scrape-sched] jobs API ${resp.status}`); return []; }
    const data = await resp.json() as any;
    return data?.items || [];
  } catch (e: any) {
    console.error('[maps-scrape-sched] fetch jobs failed:', e?.message?.slice(0, 80));
    return [];
  }
}

async function setJobStatus(id: any, status: string, error?: string | null, extra?: Record<string, any>): Promise<void> {
  try {
    const payload: Record<string, any> = { status, ...(extra || {}) };
    if (error !== undefined) payload.error = error;
    await fetch(`${CLOUD_API_BASE}/api/maps-scrape/jobs/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BOT_API_TOKEN}` },
      body: JSON.stringify(payload),
    });
  } catch (e: any) {
    console.error(`[maps-scrape-sched] setJobStatus ${id} failed:`, e?.message?.slice(0, 60));
  }
}

function parseJobCities(job: any): string[] {
  const c = job?.cities;
  if (Array.isArray(c)) return c.map((x: any) => String(x).trim()).filter(Boolean);
  if (typeof c === 'string' && c.trim()) {
    try {
      const arr = JSON.parse(c);
      if (Array.isArray(arr)) return arr.map((x: any) => String(x).trim()).filter(Boolean);
    } catch { /* not json */ }
    return c.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  return [];
}

// ç¾Žå›½å·žç¼©å†™ â†’ å…¨åï¼ˆfetch_cities.py èµ° Wikipediaï¼Œå¿…é¡»å…¨åï¼‰
const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

// cloud-api å·²æŒ‰ (country, state) ç¼“å­˜äº†å…¨çƒåŸŽå¸‚æ¸…å•ï¼Œä¸Žå‰ç«¯é€‰æ‹©å™¨åŒæº
async function fetchCitiesFromCloud(country: string, state: string): Promise<string[]> {
  try {
    const cc = country === 'USA' ? 'US' : country;
    const url = `${CLOUD_API_BASE}/api/maps-scrape/cities?country=${encodeURIComponent(cc)}&state=${encodeURIComponent(state)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${BOT_API_TOKEN}` } });
    if (!resp.ok) return [];
    const j = await resp.json() as any;
    return Array.isArray(j?.cities) ? j.cities.map((x: any) => String(x).trim()).filter(Boolean) : [];
  } catch (e: any) {
    console.error('[maps-scrape-sched] cloud cities failed:', e?.message?.slice(0, 60));
    return [];
  }
}

// åŸŽå¸‚åˆ—è¡¨ï¼šä¼˜å…ˆ job è‡ªå¸¦ â†’ cloud-api â†’ æœ¬åœ°ç¼“å­˜æ–‡ä»¶ â†’ fetch_cities.py
async function resolveCities(state: string, country: string): Promise<string[]> {
  const cloud = await fetchCitiesFromCloud(country, state);
  if (cloud.length) {
    console.log(`[maps-scrape-sched] ${state}: ${cloud.length} cities from cloud-api`);
    return cloud;
  }
  const stateName = US_STATE_NAMES[state.toUpperCase()] || state;
  const file = path.join(ENGINE_DIR, `${stateName}_cities.txt`);
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length) return lines;
  }
  console.log(`[maps-scrape-sched] generating cities for ${stateName} via fetch_cities.py`);
  await new Promise<void>((resolve) => {
    const p = spawn(PYTHON, ['fetch_cities.py', stateName], { cwd: ENGINE_DIR, env: SCRAPER_ENV });
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => process.stderr.write(`[fetch_cities:${state}] ${d}`));
    p.on('close', () => resolve());
    p.on('error', (err) => { console.error(`[fetch_cities:${state}] spawn error:`, err.message); resolve(); });
  });
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf-8').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function runScraper(state: string, country: string, citiesFile: string, jobId: any): Promise<{ code: number; lastFound: number; complete: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let lastFound = 0;
    let complete = false;
    let timedOut = false;
    let stdoutBuffer = '';
    const args = [
      'python_scraper.py',
      '--state', state,
      '--country', country,
      '--keyword', 'Tattoo Shops',
      '--cities-file', citiesFile,
      '--cloud-base', CLOUD_API_BASE, // worker æ ¹åŸŸåï¼›scraper å†…éƒ¨ä¼šå†æ‹¼ /api/...
      '--cloud-token', BOT_API_TOKEN,
      '--job-id', String(jobId), // é€ä¼  job idï¼Œscraper æ®æ­¤å›žæŠ¥ progressï¼ˆå¦åˆ™ cloud_status æ˜¯ no-opï¼‰
      '--cdp-url', CDP_URL, // ç©º=headless è‡ªèµ·ï¼›éžç©ºå‰å¤ç”¨å¤–éƒ¨ Chrome
      // æ˜¾å¼æŒ‡å®šè¾“å‡ºç›®å½• = å¼•æ“Žæ ¹/data/scrape_outputï¼ˆä¸Žæ¡¥æŽ¥è„šæœ¬ _import_maps_to_d1.py è¯»å–è·¯å¾„ä¸€è‡´ï¼‰ã€‚
      // âš ï¸ 2026-08-06 ä¿®å¤ï¼šENGINE_DIR=__dirname=scripts/ï¼Œè‹¥ä¸ä¼  --output-dirï¼Œscraper çš„ cwd ç›¸å¯¹è·¯å¾„
      //    ä¼šå†™åˆ° scripts/data/scrape_output/ï¼Œä¸Žæ¡¥æŽ¥è¯»çš„ data/scrape_output/ åˆ†è£‚ï¼Œå¯¼è‡´æ¡¥æŽ¥è¯»ä¸åˆ°æ–°æ•°æ®ã€‚
      '--output-dir', path.join(path.resolve(ENGINE_DIR, '..'), 'data', 'scrape_output'),
    ];
    console.log(`[maps-scrape-sched] â–¶ launching scraper ${state} (${country}) [cdp=${CDP_URL || 'headless'}]`);
    const child = spawn(PYTHON, args, { cwd: ENGINE_DIR, env: SCRAPER_ENV });
    const watchdog = setTimeout(() => {
      timedOut = true;
      console.error(`[maps-scrape-sched] ${state} exceeded MAX_RUNTIME (${(MAX_RUNTIME_MS / 3600000)}h), killing`);
      child.kill('SIGKILL');
    }, MAX_RUNTIME_MS);
    // è§£æž scraper çš„è¿›åº¦è¾“å‡ºï¼Œå®žæ—¶æ›´æ–°äº‘ç«¯è¿›åº¦æ¡ï¼ˆscraper è‡ªèº« cloud_status å¶å‘ 403ï¼Œè¿™é‡Œå…œåº•ï¼‰
    const processOutputLine = (line: string) => {
      if (!line) return;
      try {
        const j = JSON.parse(line);
        if (j && j.type === 'progress' && j.phase === 'end' && typeof j.current === 'number') {
          lastFound = Number(j.shops_found) || lastFound;
          setJobStatus(jobId, 'running', undefined, {
            cities_done: j.current,
            cities_total: j.total,
            artists_found: j.shops_found || 0,
          });
        } else if (j && j.type === 'done' && typeof j.complete === 'boolean') {
          complete = j.complete;
          lastFound = Number(j.total_shops) || lastFound;
        }
      } catch { /* not a json progress line */ }
    };
    child.stdout.on('data', (d) => {
      process.stdout.write(`[scraper:${state}] ${d}`);
      stdoutBuffer += d.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const raw of lines) processOutputLine(raw.trim());
    });
    child.stderr.on('data', (d) => process.stderr.write(`[scraper:${state}|err] ${d}`));
    child.on('close', (code) => {
      clearTimeout(watchdog);
      processOutputLine(stdoutBuffer.trim());
      resolve({ code: code ?? -1, lastFound, complete, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(watchdog);
      console.error(`[maps-scrape-sched] spawn error ${state}:`, err.message);
      resolve({ code: -1, lastFound, complete: false, timedOut: false });
    });
  });
}

async function processOne(job: any): Promise<void> {
  const id = job.id;
  const state = String(job.state || '').toUpperCase();
  const country = String(job.country || COUNTRY_DEFAULT).toUpperCase();
  if (!state) { console.error('[maps-scrape-sched] job missing state, skip'); return; }

  let cities = parseJobCities(job);
  if (!cities.length) cities = await resolveCities(state, country);
  if (!cities.length) {
    console.error(`[maps-scrape-sched] ${state}: no cities available, marking failed`);
    await setJobStatus(id, 'failed', 'no cities resolved (cloud-api + fetch_cities.py both empty)');
    return;
  }
  // è®©å‰ç«¯è¿›åº¦æ¡ä»Žä¸€å¼€å§‹å°±æœ‰åˆ†æ¯ï¼›æ–­ç‚¹ç»­è·‘æ—¶ä¿ç•™å·²æœ‰ cities_doneï¼Œé¿å…è¿›åº¦æ¡å›žè·³å½’é›¶
  await setJobStatus(id, 'running', null, {
    cities_total: cities.length,
    cities_done: Number(job.cities_done) || 0,
  });

  // å†™å…¥ä¸´æ—¶åŸŽå¸‚æ–‡ä»¶ï¼ˆä¾› --cities-file ä½¿ç”¨ï¼‰
  const queueDir = path.join(ENGINE_DIR, 'data', 'scrape_queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const citiesFile = path.join(queueDir, `${state}_cities.txt`);
  fs.writeFileSync(citiesFile, cities.join('\n'), 'utf-8');

  const { code, lastFound, complete, timedOut } = await runScraper(state, country, citiesFile, id);
  console.log(`[maps-scrape-sched] ${state} scraper exited code=${code} timedOut=${timedOut}`);
  // scraper æ­£å¸¸é€€å‡º(code 0)ï¼šä¸»åŠ¨ç½® completedï¼ˆä¸ä¾èµ– scraper è‡ªèº« cloud_status ä¸ŠæŠ¥ï¼Œ
  // å…¶ urllib å¶å‘è¢« Cloudflare æ‹¦ 403 å¯¼è‡´ completed æ¼æŠ¥ï¼Œä»»åŠ¡å¡åœ¨ runningï¼‰
  if (timedOut) {
    await setJobStatus(id, 'running', `runtime slice ${Math.round(MAX_RUNTIME_MS / 3600000)}h ended; scheduler will resume`, {
      cities_total: cities.length,
      artists_found: lastFound,
    });
    console.warn(`[maps-scrape-sched] ${state} runtime slice ended; keeping job running for checkpoint resume`);
  } else if (code === 0 && complete) {
    await setJobStatus(id, 'completed', undefined, {
      cities_done: cities.length,
      cities_total: cities.length,
      artists_found: lastFound,
    });
    console.log(`[maps-scrape-sched] ${state} marked completed (cities=${cities.length}, artists=${lastFound})`);
  } else if (code === 0) {
    await setJobStatus(id, 'running', 'incomplete cities remain; scheduler will resume', {
      cities_total: cities.length,
      artists_found: lastFound,
    });
    console.warn(`[maps-scrape-sched] ${state} has incomplete cities; leaving job running for resume`);
  } else {
    // å¼‚å¸¸é€€å‡º(-1/éž0)ä¸”ä» pending/runningï¼Œæ ‡ failed é˜²æ­»å¾ªçŽ¯
    const jobs = await fetchJobs();
    const still = jobs.find((j) => String(j.id) === String(id));
    if (still && (still.status === 'pending' || still.status === 'running')) {
      await setJobStatus(id, 'failed', `scraper exited code=${code}`);
    }
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const jobs = await fetchJobs();
    const isEligible = (j: any) => {
      if (launched.has(String(j.id))) return false;
      if (j.status === 'pending') return true;
      // è‡ªæ¢å¤ï¼šå´©æºƒåŽæ®‹ç•™çš„ running ä»»åŠ¡ï¼ˆcities_done < total ä¸”æ— äººæŽ¥ç®¡ï¼‰é‡æ–°æŽ¥æ‰‹ï¼Œé¿å…å¡æ­»
      if (j.status === 'running' && (Number(j.cities_done) || 0) < (Number(j.cities_total) || 1)) return true;
      return false;
    };
    const pending = jobs.filter(isEligible);
    if (pending.length) {
      const job = pending[0];
      launched.add(String(job.id));
      try {
        await processOne(job);
      } finally {
        launched.delete(String(job.id));
      }
    }
  } catch (e: any) {
    console.error('[maps-scrape-sched] tick error:', e?.message?.slice(0, 100));
  } finally {
    running = false;
  }
}

setInterval(tick, POLL_INTERVAL_MS);
tick();
console.log(`[maps-scrape-sched] started; poll=${CLOUD_API_BASE} every ${POLL_INTERVAL_MS}ms; headless=${!CDP_URL}`);

// ============ å®šæ—¶æ¡¥æŽ¥ï¼šCSV â†’ D1(å‰å°å¯è§) + bot ä»»åŠ¡é˜Ÿåˆ—ï¼ˆ2026-08-06 æ–°å¢žï¼‰============
// scraper æŠŠæ•°æ®å†™è¿› Neon + CSVï¼Œä½†å‰å°(Analyzer/Outreach)ä¸Ž bot é˜Ÿåˆ—è¯»çš„æ˜¯ D1 artistsã€‚
// è¿™é‡Œå‘¨æœŸæ€§è°ƒç”¨ _import_maps_to_d1.py <STATE>ï¼ŒæŠŠæ–°æŠ“æ•°æ® upsert è¿› D1 å¹¶è¡¥é½ ig_browse ä»»åŠ¡ã€‚
// å¹‚ç­‰ï¼šbulk-import æ˜¯ upsertï¼Œcreate-from-artists åªå…¥é˜Ÿæ–° artist â†’ é‡å¤è·‘æ— å®³ï¼ˆç³»ç»Ÿè‡ªæ²»ï¼Œé›¶æ‰‹åŠ¨ï¼‰ã€‚
const BRIDGE_INTERVAL_MS = Number(process.env.SCRAPE_BRIDGE_INTERVAL_MS) || 30 * 60 * 1000; // é»˜è®¤ 30 åˆ†é’Ÿ
const BRIDGE_SCRIPT = path.resolve(ENGINE_DIR, '_import_maps_to_d1.py');
let bridgeRunning = false;

async function runBridgeOnce(): Promise<void> {
  if (bridgeRunning) return;
  bridgeRunning = true;
  try {
    // åªæ¡¥æŽ¥ã€Œæœ‰æŠ“å–äº§å‡ºã€çš„å·žï¼šCSV å­˜åœ¨ä¸”æœ‰æ•°æ®è¡Œ
    const csvDir = path.resolve(ENGINE_DIR, '..', 'data', 'scrape_output');
    const files = fs.existsSync(csvDir) ? fs.readdirSync(csvDir).filter((f) => /^[A-Z]{2}_Raw\.csv$/.test(f)) : [];
    for (const f of files) {
      const state = f.slice(0, 2);
      try {
        const stat = fs.statSync(path.join(csvDir, f));
        if (stat.size < 200) continue; // åªæœ‰è¡¨å¤´/ç©ºæ–‡ä»¶è·³è¿‡
      } catch { continue; }
      console.log(`[maps-scrape-sched] bridge ${state} -> D1 + queue`);
      await new Promise<void>((resolve) => {
        const child = spawn(PYTHON, [BRIDGE_SCRIPT, state], { cwd: path.resolve(ENGINE_DIR, '..'), env: SCRAPER_ENV });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); process.stdout.write(`[bridge:${state}] ${d}`); });
        child.stderr.on('data', (d) => process.stderr.write(`[bridge:${state}|err] ${d}`));
        child.on('close', (code) => { if (code !== 0) console.error(`[maps-scrape-sched] bridge ${state} exit=${code}`); resolve(); });
        child.on('error', (err) => { console.error(`[maps-scrape-sched] bridge ${state} spawn error:`, err.message); resolve(); });
      });
    }
  } catch (e: any) {
    console.error('[maps-scrape-sched] bridge error:', e?.message?.slice(0, 120));
  } finally {
    bridgeRunning = false;
  }
}

setInterval(() => { void runBridgeOnce(); }, BRIDGE_INTERVAL_MS);
console.log(`[maps-scrape-sched] auto-bridge enabled every ${Math.round(BRIDGE_INTERVAL_MS / 60000)}min`);
