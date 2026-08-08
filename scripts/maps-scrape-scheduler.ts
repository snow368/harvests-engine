/**
 * Maps Scrape Scheduler — 消费 maps_scrape_jobs 队列（Maps Scrape 页面「加入队列」）
 *
 * 闭环：
 *   前端选州/城市 → POST /api/maps-scrape/jobs (status=pending)
 *   → 本调度器每 N 秒轮询 pending job
 *   → 该州无城市列表则先 fetch_cities.py 现生成
 *   → 拉起 python_scraper.py 子进程（headless 自起浏览器，不抢 IG bot 的 Chrome）
 *   → scraper 自己调 cloud_status 回报 running→completed，前端进度条(cities_done/total)实时更新
 *
 * 串行处理（一次一个州），避免 Chrome / Neon 争用。
 *
 * ENV:
 *   CLOUD_API_BASE          — cloud-api Worker 地址（默认 https://harvests-cloud-api.inkflowapp.workers.dev）
 *   BOT_API_TOKEN           — VPS bot 密钥（默认 vps-bot-secret-2024，须与 cloud-api 一致）
 *   SCRAPE_POLL_INTERVAL_MS — 轮询间隔（默认 60000）
 *   SCRAPE_PYTHON           — python 可执行名（默认 python）
 *   SCRAPE_MAX_RUNTIME_MS   — 单州看门狗（默认 6h，超时强杀防挂死）
 *   SCRAPE_CDP_URL          — 传空=headless 自起浏览器（默认空）；填 http://127.0.0.1:9222 则复用外部 Chrome
 *   SCRAPE_COUNTRY          — 默认国家（默认 USA）
 *   NEON_DATABASE_URL       — 透传给 scraper（写 artists 到 Neon）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
// 防御：清掉本地代理 env（本机/VPS 的 127.0.0.1:10808 代理端口在沙箱里不存在，会让 node fetch / python urllib 失败）
for (const k of ['HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy','ALL_PROXY','all_proxy','NODE_USE_ENV_PROXY']) {
  delete process.env[k];
}
const ENGINE_DIR = __dirname; // scripts/
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

// scraper 子进程环境：继承本进程（含 .env 注入的 NEON_DATABASE_URL / CLOUD_API_BASE 等），并剔掉代理 env
const SCRAPER_ENV: Record<string, string> = { ...(process.env as Record<string, string>) };
for (const k of ['HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy','ALL_PROXY','all_proxy','NODE_USE_ENV_PROXY']) {
  delete (SCRAPER_ENV as any)[k];
}
// 关键：scraper 的 stdout 被管道接管时是块缓冲，progress JSON 不会实时刷出，
// 导致调度器解析不到进度。设 PYTHONUNBUFFERED=1 强制行缓冲，进度条才能实时走动。
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

async function setJobStatus(id: any, status: string, error?: string, extra?: Record<string, any>): Promise<void> {
  try {
    const payload: Record<string, any> = { status, ...(extra || {}) };
    if (error) payload.error = error;
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

// 美国州缩写 → 全名（fetch_cities.py 走 Wikipedia，必须全名）
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

// cloud-api 已按 (country, state) 缓存了全球城市清单，与前端选择器同源
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

// 城市列表：优先 job 自带 → cloud-api → 本地缓存文件 → fetch_cities.py
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

function runScraper(state: string, country: string, citiesFile: string, jobId: any): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      'python_scraper.py',
      '--state', state,
      '--country', country,
      '--keyword', 'Tattoo Shops',
      '--cities-file', citiesFile,
      '--cloud-base', CLOUD_API_BASE, // worker 根域名；scraper 内部会再拼 /api/...
      '--cloud-token', BOT_API_TOKEN,
      '--job-id', String(jobId), // 透传 job id，scraper 据此回报 progress（否则 cloud_status 是 no-op）
      '--cdp-url', CDP_URL, // 空=headless 自起；非空前复用外部 Chrome
      // 显式指定输出目录 = 引擎根/data/scrape_output（与桥接脚本 _import_maps_to_d1.py 读取路径一致）。
      // ⚠️ 2026-08-06 修复：ENGINE_DIR=__dirname=scripts/，若不传 --output-dir，scraper 的 cwd 相对路径
      //    会写到 scripts/data/scrape_output/，与桥接读的 data/scrape_output/ 分裂，导致桥接读不到新数据。
      '--output-dir', path.join(path.resolve(__dirname, '..'), 'data', 'scrape_output'),
    ];
    console.log(`[maps-scrape-sched] ▶ launching scraper ${state} (${country}) [cdp=${CDP_URL || 'headless'}]`);
    const child = spawn(PYTHON, args, { cwd: ENGINE_DIR, env: SCRAPER_ENV });
    const watchdog = setTimeout(() => {
      console.error(`[maps-scrape-sched] ${state} exceeded MAX_RUNTIME (${(MAX_RUNTIME_MS / 3600000)}h), killing`);
      child.kill('SIGKILL');
    }, MAX_RUNTIME_MS);
    // 解析 scraper 的进度输出，实时更新云端进度条（scraper 自身 cloud_status 偶发 403，这里兜底）
    child.stdout.on('data', (d) => {
      process.stdout.write(`[scraper:${state}] ${d}`);
      const str = d.toString();
      for (const raw of str.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j && j.type === 'progress' && j.phase === 'end' && typeof j.current === 'number') {
            setJobStatus(jobId, 'running', undefined, {
              cities_done: j.current,
              cities_total: j.total,
              artists_found: j.shops_found || 0,
            });
          }
        } catch { /* not a json progress line */ }
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[scraper:${state}|err] ${d}`));
    child.on('close', (code) => { clearTimeout(watchdog); resolve(code ?? -1); });
    child.on('error', (err) => { clearTimeout(watchdog); console.error(`[maps-scrape-sched] spawn error ${state}:`, err.message); resolve(-1); });
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
  // 让前端进度条从一开始就有分母；断点续跑时保留已有 cities_done，避免进度条回跳归零
  await setJobStatus(id, 'running', undefined, {
    cities_total: cities.length,
    cities_done: Number(job.cities_done) || 0,
  });

  // 写入临时城市文件（供 --cities-file 使用）
  const queueDir = path.join(ENGINE_DIR, 'data', 'scrape_queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const citiesFile = path.join(queueDir, `${state}_cities.txt`);
  fs.writeFileSync(citiesFile, cities.join('\n'), 'utf-8');

  const code = await runScraper(state, country, citiesFile, id);
  console.log(`[maps-scrape-sched] ${state} scraper exited code=${code}`);
  // scraper 自身已回报 completed/failed；若异常退出(-1/非0)且仍 pending，标 failed 防死循环
  if (code !== 0) {
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
      // 自恢复：崩溃后残留的 running 任务（cities_done < total 且无人接管）重新接手，避免卡死
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

// ============ 定时桥接：CSV → D1(前台可见) + bot 任务队列（2026-08-06 新增）============
// scraper 把数据写进 Neon + CSV，但前台(Analyzer/Outreach)与 bot 队列读的是 D1 artists。
// 这里周期性调用 _import_maps_to_d1.py <STATE>，把新抓数据 upsert 进 D1 并补齐 ig_browse 任务。
// 幂等：bulk-import 是 upsert，create-from-artists 只入队新 artist → 重复跑无害（系统自治，零手动）。
const BRIDGE_INTERVAL_MS = Number(process.env.SCRAPE_BRIDGE_INTERVAL_MS) || 30 * 60 * 1000; // 默认 30 分钟
const BRIDGE_SCRIPT = path.resolve(ENGINE_DIR, '_import_maps_to_d1.py');
let bridgeRunning = false;

async function runBridgeOnce(): Promise<void> {
  if (bridgeRunning) return;
  bridgeRunning = true;
  try {
    // 只桥接「有抓取产出」的州：CSV 存在且有数据行
    const csvDir = path.resolve(ENGINE_DIR, '..', 'data', 'scrape_output');
    const files = fs.existsSync(csvDir) ? fs.readdirSync(csvDir).filter((f) => /^[A-Z]{2}_Raw\.csv$/.test(f)) : [];
    for (const f of files) {
      const state = f.slice(0, 2);
      try {
        const stat = fs.statSync(path.join(csvDir, f));
        if (stat.size < 200) continue; // 只有表头/空文件跳过
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
