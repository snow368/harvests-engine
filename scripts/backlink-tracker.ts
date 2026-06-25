/**
 * Backlink Tracker v1
 * ===================
 * 巡检已提交外链的收录状态和存活情况
 *
 * 运行方式：
 *   npx tsx scripts/backlink-tracker.ts              # 全量巡检
 *   npx tsx scripts/backlink-tracker.ts --project inkflow  # 指定项目
 *   npx tsx scripts/backlink-tracker.ts --quick      # 只检查最近7天的
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const BASE_DIR = 'F:/SEO_Project';
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_PATH = path.join(BASE_DIR, 'data/backlinks.db');

let db: Database.Database;
const CDP_URL = process.env.BOT_CDP_URL || 'http://localhost:9222';

function initDB() {
  db = new Database(DB_PATH);
}

interface Submission {
  id: number;
  project_id: string;
  platform_id: string;
  target_url: string;
  status: string;
  link_url: string | null;
  submitted_at: number | null;
}

async function main() {
  const args = process.argv.slice(2);
  const projectFilter = args.find(a => a.startsWith('--project='))?.split('=')[1];
  const isQuick = args.includes('--quick');

  initDB();

  console.log(`🔍 Backlink Tracker v1 — 外链收录巡检`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // 获取待巡检的提交记录
  let query = `SELECT * FROM backlink_submissions WHERE status IN ('success','pending_review')`;
  const params: any[] = [];

  if (projectFilter) {
    query += ` AND project_id = ?`;
    params.push(projectFilter);
  }

  if (isQuick) {
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    query += ` AND submitted_at >= ?`;
    params.push(weekAgo);
  }

  // 按巡检时间排序（最久未巡检的优先）
  query += ` ORDER BY checked_at ASC NULLS FIRST LIMIT 20`;

  const submissions = db.prepare(query).all(...params) as Submission[];

  if (submissions.length === 0) {
    console.log('✅ 没有需要巡检的外链');
    return;
  }

  console.log(`📋 本次巡检 ${submissions.length} 条外链\n`);

  // 连接 Chrome
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();

  const now = Math.floor(Date.now() / 1000);
  let indexedCount = 0;

  try {
    for (const sub of submissions) {
      const linkUrl = sub.link_url || `https://google.com/search?q=site:${sub.target_url.replace('https://', '')}`;
      console.log(`  🌐 ${sub.platform_id} (${sub.project_id})`);

      // 检查 HTTP 状态（外链存活）
      let isAlive = false;
      if (sub.link_url) {
        try {
          const resp = await page.goto(sub.link_url, { waitUntil: 'domcontentloaded', timeout: 10000 });
          isAlive = resp?.ok() ?? false;

          // 检查页面是否包含我们的链接
          const bodyText = await page.textContent('body').catch(() => '');
          const hasOurLink = bodyText.includes(sub.target_url.replace('https://', ''));

          console.log(`    HTTP: ${resp?.status()} | 含我们的链接: ${hasOurLink ? '✅' : '❌'}`);
        } catch {
          console.log(`    HTTP: ❌ 无法访问`);
        }
      } else {
        // 没有 link_url，尝试 Google site 搜索
        try {
          const searchUrl = `https://www.google.com/search?q=site:${sub.target_url.replace('https://', '')}+${sub.platform_id}`;
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
          const results = await page.textContent('body').catch(() => '');
          const found = results.includes(sub.target_url.replace('https://', '')) ||
                        results.includes(sub.platform_id);
          console.log(`    Google site: 索引 ${found ? '✅' : '⏳ 未发现'}`);
          if (found) indexedCount++;
        } catch {
          console.log(`    Google site: ⚠️ 查询失败`);
        }
      }

      // 更新巡检记录
      db.prepare(`
        UPDATE backlink_submissions SET checked_at = ?, indexed = ?
        WHERE id = ?
      `).run(now, isAlive ? 1 : 0, sub.id);
    }
  } finally {
    await page.close();
  }

  console.log(`\n📊 巡检完成: ${indexedCount}/${submissions.length} 已收录`);
}

main().catch(err => {
  console.error('❌ Tracker 异常退出:', err);
  process.exit(1);
});
