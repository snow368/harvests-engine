/**
 * Publish Worker — Playwright Chromium persistent 自动发帖到 Instagram
 *
 * 轮询 content_publish_tasks，用系统 Chrome 登录态发帖。
 * 发帖后回调 /api/publish/report 更新 platform_post_id。
 *
 * ENV:
 *   BOT_ID=bot_wa_01
 *   BOT_API_KEY=xxx
 *   PUBLISH_PLATFORM=instagram
 *   PUBLISH_POLL_INTERVAL_MS=30000
 *   PUBLISH_LEASE_MS=300000
 *   BOT_HEADLESS=false
 *   BOT_PROXY_SERVER=socks5://...
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const BOT_ID = (process.env.BOT_ID || 'bot_publish_01').trim();
const BOT_API_KEY = (process.env.BOT_API_KEY || '').trim();
const PLATFORM = (process.env.PUBLISH_PLATFORM || 'instagram').trim().toLowerCase();
const HEADLESS = String(process.env.BOT_HEADLESS || 'false').toLowerCase() === 'true';
const PROXY_SERVER = (process.env.BOT_PROXY_SERVER || '').trim();
const POLL_INTERVAL_MS = Math.max(10000, Number(process.env.PUBLISH_POLL_INTERVAL_MS || 30000));
const LEASE_MS = Math.max(60000, Number(process.env.PUBLISH_LEASE_MS || 300000));
const HEARTBEAT_INTERVAL_MS = Math.max(5000, Number(process.env.HEARTBEAT_INTERVAL_MS || 15000));
const HASHTAGS_DEFAULT = '#tattoo #tattooink #tattoosupply #tattooequipment #tattooartist #tattooshop';

// Persistent Chrome profile (same as other bot workers)
const CHROME_DATA_DIR = process.env.CHROME_DATA_DIR || path.join('F:/inkflow/bot_profiles', `${BOT_ID}_chrome_data`);

let running = true;
let browser: any = null;
let context: any = null;
let page: any = null;

type PublishTask = {
  id: string;
  platform: string;
  bot_id?: string | null;
  account_id?: string | null;
  content_id?: string | null;
  payload?: any;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number, range: number) => base + Math.floor(Math.random() * range);

// ============ Per-Bot Typing Profile ============
const hashBot = (id: string): number => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
};
const botHash = hashBot(BOT_ID);
const TYPO_SPEED_MS = 40 + (botHash % 80);
const TYPO_PAUSE_CHANCE = 0.03 + ((botHash % 10) / 100);
const TYPO_PAUSE_MS = 300 + (botHash % 1200);
const TYPO_MISTAKE_CHANCE = 0.01 + ((botHash % 5) / 100);
const TYPO_BACKSPACE_MS = 80 + (botHash % 150);

const humanTypeInto = async (el: any, text: string) => {
  await el.click({ timeout: 5000 });
  await sleep(jitter(400, 1000));
  for (let i = 0; i < text.length; i++) {
    if (Math.random() < TYPO_PAUSE_CHANCE) await sleep(jitter(TYPO_PAUSE_MS, 500));
    if (Math.random() < TYPO_MISTAKE_CHANCE) {
      const nearbyKeys = 'asdfghjklqwertyuiopzxcvbnm,.';
      const wrongChar = nearbyKeys[Math.floor(Math.random() * nearbyKeys.length)];
      await el.type(wrongChar, { delay: jitter(TYPO_SPEED_MS, 20) });
      await sleep(jitter(TYPO_BACKSPACE_MS, 50));
      await el.press('Backspace');
      await sleep(jitter(TYPO_BACKSPACE_MS, 50));
    }
    await el.type(text[i], { delay: jitter(TYPO_SPEED_MS, 15) });
  }
};

// ============ API ============
const headers = () => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BOT_API_KEY) h['x-bot-key'] = BOT_API_KEY;
  return h;
};

const getJson = async (p: string) => {
  const resp = await fetch(`${API_BASE}${p}`, { headers: headers() });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const postJson = async (p: string, body: Record<string, any>) => {
  const resp = await fetch(`${API_BASE}${p}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

// ============ Browser (Persistent Chromium) ============
const ensureBrowser = async () => {
  if (context && page) {
    try {
      await page.evaluate(() => document.title);
      return;
    } catch {
      console.log('[publish-worker] dead context, re-launching...');
      try { await context.close(); } catch {}
      context = null; page = null; browser = null;
    }
  }
  if (!fs.existsSync(CHROME_DATA_DIR)) fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });

  const proxyConfig = PROXY_SERVER ? { server: PROXY_SERVER } : undefined;
  console.log('[publish-worker] launching persistent Chromium...');
  browser = await chromium.launchPersistentContext(CHROME_DATA_DIR, {
    headless: HEADLESS,
    channel: 'chrome',
    viewport: { width: 1280, height: 900, deviceScaleFactor: 2 },
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
    args: ['--disable-blink-features=AutomationControlled'],
  });
  context = browser;

  const pages = context.pages?.() || [];
  page = pages.find((p: any) => {
    try { return p.url()?.includes('instagram.com'); } catch { return false; }
  }) || pages[0] || await context.newPage();

  if (!page.url()?.includes('instagram.com')) {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  console.log('[publish-worker] browser ready');
};

// ============ Register & Heartbeat ============
const registerBot = async () => {
  await postJson('/api/bot/register', { botId: BOT_ID, host: 'local-dev', version: '1.0.0-publish', meta: { mode: 'persistent' } });
};

const heartbeatBot = async () => {
  await postJson('/api/bot/heartbeat', { botId: BOT_ID, host: 'local-dev', version: '1.0.0-publish' });
};

// ============ Core: Publish to Instagram ============
const publishToInstagram = async (task: PublishTask): Promise<{ ok: boolean; postId?: string; error?: string }> => {
  const payload = task.payload || {};
  const caption = payload.caption || '';
  const hashtags = Array.isArray(payload.hashtags) ? payload.hashtags.join(' ') : (payload.hashtags || HASHTAGS_DEFAULT);
  const fullCaption = `${caption}\n.\n${hashtags}`;
  const mediaFiles: string[] = Array.isArray(payload.mediaFiles)
    ? payload.mediaFiles
    : (payload.mediaFile ? [payload.mediaFile] : []);

  if (mediaFiles.length === 0) return { ok: false, error: 'no_media_files' };
  for (const f of mediaFiles) {
    if (!fs.existsSync(f)) return { ok: false, error: `media_not_found: ${f}` };
  }

  await ensureBrowser();

  try {
    // Click "+" create button
    const createSelectors = [
      'svg[aria-label="New post"]',
      'a[href="/create"]',
      'div[role="button"] svg[aria-label="New post"]',
    ];
    let clickedCreate = false;
    for (const sel of createSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) { await btn.click({ timeout: 5000 }); clickedCreate = true; break; }
      } catch {}
    }
    if (!clickedCreate) {
      await page.goto('https://www.instagram.com/create/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForTimeout(jitter(2000, 4000));

    // Upload media via file input
    const fileInput = page.locator('input[type="file"]').first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(mediaFiles);
      console.log(`[publish-worker] uploaded ${mediaFiles.length} media file(s)`);
    } else {
      return { ok: false, error: 'file_input_not_found' };
    }
    await page.waitForTimeout(jitter(3000, 6000));

    // Click "Next" through crop/filter screens
    for (let step = 0; step < 2; step++) {
      try {
        const nextBtn = page.locator('div[role="button"]').filter({ hasText: /Next|下一步/i }).first();
        if ((await nextBtn.count()) > 0) { await nextBtn.click({ timeout: 10000 }); await page.waitForTimeout(jitter(1500, 3000)); }
      } catch {}
    }

    // Type caption
    await page.waitForTimeout(jitter(1000, 2500));
    const captionArea = page.locator('div[aria-label*="caption" i], div[role="textbox"]').first();
    if ((await captionArea.count()) > 0) {
      await captionArea.click({ timeout: 5000 });
      await page.waitForTimeout(jitter(500, 1500));
      await humanTypeInto(captionArea, fullCaption);
    }
    await page.waitForTimeout(jitter(1000, 3000));

    // Click Share
    const shareBtn = page.locator('div[role="button"]').filter({ hasText: /Share|分享|发布/i }).first();
    if ((await shareBtn.count()) > 0) {
      await shareBtn.click({ timeout: 10000 });
      console.log('[publish-worker] clicked Share');
    } else {
      return { ok: false, error: 'share_button_not_found' };
    }

    await page.waitForTimeout(jitter(5000, 10000));
    const currentUrl = page.url();
    const postIdMatch = currentUrl.match(/\/p\/([^/]+)/);
    const postId = postIdMatch ? postIdMatch[1] : `ig_${Date.now()}`;

    console.log(`[publish-worker] post published: ${postId}`);
    return { ok: true, postId };
  } catch (e: any) {
    return { ok: false, error: e?.message?.slice(0, 200) || 'unknown' };
  }
};

// ============ Poll & Execute ============
const pollTask = async (): Promise<PublishTask | null> => {
  const data = await getJson(`/api/publish/poll?botId=${encodeURIComponent(BOT_ID)}&platform=${encodeURIComponent(PLATFORM)}&leaseMs=${LEASE_MS}`);
  return (data?.task || null) as PublishTask | null;
};

const reportResult = async (taskId: string, status: 'done' | 'failed', result?: any) => {
  await postJson('/api/publish/report', { taskId, status, ...(result || {}) });
};

const workerLoop = async () => {
  console.log('[publish-worker] starting:', { API_BASE, BOT_ID, PLATFORM, POLL_INTERVAL_MS, LEASE_MS, CHROME_DATA_DIR });

  await registerBot().catch(e => console.warn('[publish-worker] register failed:', e?.message));

  let consecutiveFailures = 0;

  while (running) {
    try {
      const task = await pollTask();
      if (!task) {
        consecutiveFailures = 0;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      console.log(`[publish-worker] executing task ${task.id}`);
      const result = await publishToInstagram(task);

      if (result.ok) {
        consecutiveFailures = 0;
        await reportResult(task.id, 'done', { platformPostId: result.postId, publishedAt: new Date().toISOString() });
        console.log(`[publish-worker] done ${task.id} → ${result.postId}`);
      } else if (result.error === 'no_media_files' || result.error?.startsWith('media_not_found:')) {
        await reportResult(task.id, 'pending_media', { reason: result.error });
        console.warn(`[publish-worker] task ${task.id}: ${result.error}`);
      } else {
        await reportResult(task.id, 'failed', { errorReason: result.error });
        console.error(`[publish-worker] failed ${task.id}: ${result.error}`);
      }

      const cooldownMs = jitter(300000, 600000);
      console.log(`[publish-worker] cooldown ${Math.round(cooldownMs / 60000)}min`);
      await sleep(cooldownMs);
    } catch (e: any) {
      consecutiveFailures++;
      const errMsg = e?.message?.slice(0, 200) || '';
      console.error('[publish-worker] loop error:', errMsg);
      await sleep(Math.min(10 * 60 * 1000, consecutiveFailures * 30 * 1000));
    }
  }
};

// ============ Heartbeat Loop ============
const heartbeatLoop = async () => {
  while (running) {
    try { await heartbeatBot(); } catch {}
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
};

// ============ Shutdown ============
const shutdown = async (signal: string) => {
  console.log(`[publish-worker] shutdown on ${signal}`);
  running = false;
  try { if (context) await context.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

Promise.all([workerLoop(), heartbeatLoop()]).catch((e) => {
  console.error('[publish-worker] fatal:', e?.message || e);
  process.exit(1);
});
