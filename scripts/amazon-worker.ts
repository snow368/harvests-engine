/**
 * Amazon Worker — VPS 端守护进程，轮询 Cloud API 执行 Amazon 搜索/评论抓取
 *
 * PM2 启动:
 *   pm2 start scripts/amazon-worker.ts --interpreter tsx --name amazon-worker
 *
 * 环境变量:
 *   AMAZON_API_URL      - Cloud API 地址 (默认 https://harvests-cloud-api.snow368.workers.dev)
 *   AMAZON_BOT_TOKEN    - bot 令牌 (默认 vps-bot-secret-2024)
 *   AMAZON_POLL_INTERVAL- 轮询间隔秒数 (默认 60)
 *   AMAZON_USE_BROWSER  - 是否使用 Playwright (默认 false，设为 true 需 Chrome)
 *   AMAZON_CHROME_CDP   - Chrome CDP 地址 (默认 http://localhost:9222)
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import {
  searchProducts,
  scrapeReviews,
  extractAsinFromUrl,
} from './amazon-scraper-engine';

// ── Config ──
const API_URL = (process.env.AMAZON_API_URL || 'https://harvests-cloud-api.snow368.workers.dev').replace(/\/+$/, '');
const BOT_TOKEN = process.env.AMAZON_BOT_TOKEN || process.env.BOT_SECRET || 'vps-bot-secret-2024';
const POLL_INTERVAL = Math.max(10, Number(process.env.AMAZON_POLL_INTERVAL || 60));
const USE_BROWSER = process.env.AMAZON_USE_BROWSER === 'true';
const CHROME_CDP = process.env.AMAZON_CHROME_CDP || 'http://localhost:9222';

let browser: any = null;

// ── Logger ──
function log(msg: string) {
  console.log(`[amazon-worker] ${msg}`);
}

// ── API helpers ──
async function apiGet(path: string): Promise<any> {
  const url = `${API_URL}${path}${path.includes('?') ? '&' : '?'}token=${BOT_TOKEN}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`API GET ${path}: ${resp.status}`);
  return resp.json();
}

async function apiPost(path: string, body: any): Promise<any> {
  const resp = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API POST ${path}: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Connect to Chrome (for Playwright mode) ──
async function connectBrowser() {
  if (!USE_BROWSER) return null;
  try {
    browser = await chromium.connectOverCDP(CHROME_CDP);
    log(`Connected to Chrome CDP: ${CHROME_CDP}`);
    return browser;
  } catch (e: any) {
    log(`Failed to connect Chrome CDP (${e.message}), falling back to HTTP mode`);
    return null;
  }
}

async function disconnectBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

// ── Process a search task ──
async function processSearchTask(task: any): Promise<{ status: string; products: any[]; error?: string }> {
  const params = task.params || {};
  const keyword = params.keyword;
  const domain = params.domain || 'www.amazon.com';

  if (!keyword) return { status: 'failed', products: [], error: 'Missing keyword' };

  log(`Searching: "${keyword}" on ${domain}`);

  try {
    const products = await searchProducts(keyword, {
      browser,
      domain,
      maxResults: 20,
      log,
    });

    if (products.length === 0) {
      return { status: 'completed', products: [],
        error: 'No products found' };
    }

    // Add search keyword to each product
    const enriched = products.map(p => ({ ...p, searchKeyword: keyword }));

    log(`Found ${enriched.length} products for "${keyword}"`);
    return { status: 'completed', products: enriched };
  } catch (e: any) {
    log(`Search error: ${e.message}`);
    return { status: 'failed', products: [], error: e.message };
  }
}

// ── Process a scrape task ──
async function processScrapeTask(task: any): Promise<{ status: string; reviews: any[]; error?: string }> {
  const params = task.params || {};
  const asin = params.asin;
  const productName = params.productName || asin;
  const domains = params.domains || ['www.amazon.com'];
  const minStars = params.minStars ?? 1;
  const maxStars = params.maxStars ?? 5;
  const maxPages = params.maxPages ?? 3;

  if (!asin) return { status: 'failed', reviews: [], error: 'Missing ASIN' };

  log(`Scraping ${asin} (${productName}) | stars ${minStars}-${maxStars} | ${domains.length} domains | ${maxPages} pages`);

  try {
    const reviews = await scrapeReviews(asin, {
      browser,
      productName,
      domains,
      minStars,
      maxStars,
      maxPages,
      log,
    });

    log(`Scraped ${reviews.length} reviews for ${asin}`);
    return { status: 'completed', reviews };
  } catch (e: any) {
    log(`Scrape error: ${e.message}`);
    return { status: 'failed', reviews: [], error: e.message };
  }
}

// ── Process one task ──
async function processTask(task: any): Promise<void> {
  const taskId = task.id;
  const type = task.type;

  log(`Processing task ${taskId} (${type})`);

  try {
    // Mark as running
    await apiPost('/api/amazon/report', {
      taskId, status: 'running',
    });

    let result: { status: string; products?: any[]; reviews?: any[]; error?: string };

    if (type === 'search') {
      result = await processSearchTask(task);
    } else if (type === 'scrape') {
      result = await processScrapeTask(task);
    } else {
      result = { status: 'failed', error: `Unknown task type: ${type}` };
    }

    // Report result
    await apiPost('/api/amazon/report', {
      taskId,
      status: result.status,
      products: result.products || [],
      reviews: result.reviews || [],
      error: result.error,
    });

    log(`Done ${taskId}: ${result.status}${result.error ? ' (' + result.error + ')' : ''}`);
  } catch (e: any) {
    log(`Failed to process task ${taskId}: ${e.message}`);
    try {
      await apiPost('/api/amazon/report', {
        taskId, status: 'failed', error: e.message,
      });
    } catch {}
  }
}

// ── Main loop ──
async function mainLoop() {
  log(`Amazon Worker started (interval=${POLL_INTERVAL}s, browser=${USE_BROWSER})`);

  // Connect browser once if needed
  if (USE_BROWSER) {
    await connectBrowser();
  }

  let consecutiveErrors = 0;

  while (true) {
    try {
      // Poll for pending tasks
      const data = await apiGet('/api/amazon/pending?limit=3');
      const tasks = data.items || [];

      if (tasks.length === 0) {
        log('No pending tasks, sleeping...');
        consecutiveErrors = 0;
      } else {
        log(`Found ${tasks.length} pending task(s)`);

        // Process each task
        for (const task of tasks) {
          // Re-check if still pending (might have been picked up by another worker)
          const checkData = await apiGet(`/api/amazon/tasks?type=${task.type}&status=pending&limit=10`);
          const stillPending = (checkData.items || []).find((t: any) => t.id === task.id);
          if (!stillPending) {
            log(`Task ${task.id} already taken, skipping`);
            continue;
          }

          await processTask(task);
        }

        consecutiveErrors = 0;
      }
    } catch (e: any) {
      consecutiveErrors++;
      log(`Poll error (${consecutiveErrors}): ${e.message}`);
      if (consecutiveErrors >= 5) {
        log('Too many consecutive errors, reconnecting browser...');
        await disconnectBrowser();
        if (USE_BROWSER) await connectBrowser();
        consecutiveErrors = 0;
      }
    }

    // Sleep until next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL * 1000));
  }
}

// ── Startup ──
mainLoop().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  log('Shutting down...');
  await disconnectBrowser();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  log('Shutting down...');
  await disconnectBrowser();
  process.exit(0);
});
