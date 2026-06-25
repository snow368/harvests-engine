/**
 * Backlink Automation Worker v1
 * ==============================
 * 多项目通用外链提交 Worker
 *
 * 依赖：
 *   - Chrome CDP (port 9222)
 *   - backlink-platforms.yaml
 *   - project-configs.yaml
 *   - SQLite database (复用 deep_scan_tasks.db 或新建 backlinks.db)
 *
 * 运行方式：
 *   npx tsx scripts/backlink-worker.ts              # 跑一次
 *   npx tsx scripts/backlink-worker.ts --loop       # 循环跑
 *   npx tsx scripts/backlink-worker.ts --project inkflow  # 指定项目
 *
 * 环境变量：
 *   BOT_CDP_URL=http://localhost:9222                # Chrome CDP 地址
 *   BOT_BACKLINK_QUOTA=10                            # 每次最大提交数
 */

import { chromium, type Browser, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// --- 类型定义 ---

interface BacklinkPlatform {
  name: string;
  url: string;
  submit_url: string | null;
  type: string;
  dr: number;
  difficulty: string;
  registration: boolean;
  paywall: boolean;
  captcha: boolean | string;
  approval: string;
  method: string;
  description: string;
  form_fields: FormField[];
  success_indicators: string[];
  suitable_for: string[];
  notes?: string;
}

interface FormField {
  name: string;
  type: string;
  label: string;
  placeholder?: string;
  options?: string[];
}

interface ProjectConfig {
  name: string;
  domain: string;
  industry: string;
  tagline: string;
  description: string;
  preferred_anchor_texts: string[];
  exclude_platforms: string[];
  preferred_types: string[];
  daily_quota: number;
  priority: string;
}

// --- 配置加载 ---

const BASE_DIR = 'F:/SEO_Project';
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_PATH = path.join(BASE_DIR, 'data/backlinks.db'); // 可改为复用 deep_scan_tasks.db

function loadPlatforms(): Record<string, BacklinkPlatform> {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'backlink-platforms.yaml'), 'utf-8');
  const parsed = yaml.load(raw) as any;
  return parsed.platforms || {};
}

function loadProjects(): Record<string, ProjectConfig> {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'project-configs.yaml'), 'utf-8');
  const parsed = yaml.load(raw) as any;
  return parsed.projects || {};
}

// --- SQLite 初始化 ---

import Database from 'better-sqlite3';

let db: Database.Database;

function initDB() {
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS submission_tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      platform_id   TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      priority      INTEGER DEFAULT 0,
      created_at    INTEGER,
      started_at    INTEGER,
      completed_at  INTEGER,
      result        TEXT,
      error_log     TEXT,
      UNIQUE(project_id, platform_id)
    );

    CREATE TABLE IF NOT EXISTS backlink_submissions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      platform_id   TEXT NOT NULL,
      target_url    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      submitted_at  INTEGER,
      checked_at    INTEGER,
      indexed       INTEGER DEFAULT 0,
      link_url      TEXT,
      anchor_text   TEXT,
      notes         TEXT,
      UNIQUE(project_id, platform_id)
    );

    CREATE TABLE IF NOT EXISTS backlink_assets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      platform_id   TEXT NOT NULL,
      link_url      TEXT NOT NULL,
      target_url    TEXT NOT NULL,
      dr            INTEGER DEFAULT 0,
      anchor_text   TEXT,
      status        TEXT DEFAULT 'active',
      first_seen    INTEGER,
      last_checked  INTEGER,
      UNIQUE(link_url, target_url)
    );

    CREATE TABLE IF NOT EXISTS scheduler_state (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      last_run_at   INTEGER,
      tasks_created INTEGER DEFAULT 0,
      UNIQUE(project_id)
    );
  `);
}

// --- 任务生成（调度器逻辑）---

function generateTasks(projectId: string, quota: number) {
  const projects = loadProjects();
  const platforms = loadPlatforms();
  const project = projects[projectId];

  if (!project) {
    console.error(`❌ Project "${projectId}" not found in project-configs.yaml`);
    return [];
  }

  // 获取已提交过的平台（避免重复）
  const submitted = db.prepare(
    `SELECT platform_id FROM backlink_submissions WHERE project_id = ?`
  ).all(projectId).map((r: any) => r.platform_id);

  // 获取已有任务
  const existingTasks = db.prepare(
    `SELECT platform_id FROM submission_tasks WHERE project_id = ? AND status != 'done'`
  ).all(projectId).map((r: any) => r.platform_id);

  // 筛选可用平台
  const candidates: Array<{ platform: BacklinkPlatform; key: string }> = [];

  for (const [key, platform] of Object.entries(platforms)) {
    // 排除项目黑名单
    if (project.exclude_platforms.includes(key)) continue;
    // 排除已提交的
    if (submitted.includes(key)) continue;
    // 排除已有任务的
    if (existingTasks.includes(key)) continue;
    // 检查是否适合该项目类型
    if (!platform.suitable_for.includes(project.industry)) continue;

    candidates.push({ platform, key });
  }

  // 按难度排序：easy → medium → hard
  const difficultyOrder = { easy: 0, medium: 1, hard: 2 };
  candidates.sort((a, b) => {
    const aDiff = difficultyOrder[a.platform.difficulty] ?? 99;
    const bDiff = difficultyOrder[b.platform.difficulty] ?? 99;
    return aDiff - bDiff;
  });

  // 按配额截取
  const selected = candidates.slice(0, quota);
  const now = Math.floor(Date.now() / 1000);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO submission_tasks (project_id, platform_id, status, priority, created_at)
    VALUES (?, ?, 'pending', ?, ?)
  `);

  for (const { key } of selected) {
    insert.run(projectId, key, 0, now);
  }

  console.log(`📋 ${projectId}: 生成了 ${selected.length} 个提交任务`);
  return selected;
}

// --- Worker 核心 ---

async function submitBacklink(
  page: Page,
  platform: BacklinkPlatform,
  project: ProjectConfig
): Promise<{ success: boolean; status: string; notes?: string }> {
  const submitUrl = platform.submit_url;
  if (!submitUrl) {
    return { success: false, status: 'no_submit_url', notes: '平台无提交 URL' };
  }

  console.log(`  🌐 打开 ${platform.name}: ${submitUrl}`);

  try {
    await page.goto(submitUrl, { waitUntil: 'networkidle', timeout: 15000 });
  } catch (err) {
    return { success: false, status: 'timeout', notes: '页面加载超时' };
  }

  // 检测付费墙
  const paywallKeywords = ['pricing', 'payment', 'subscribe', 'upgrade', 'pro', 'premium', 'pay'];
  const pageText = await page.textContent('body').catch(() => '');
  const pageLower = pageText?.toLowerCase() || '';

  if (paywallKeywords.some(k => pageLower.includes(k)) &&
      (pageLower.includes('$') || pageLower.includes('€') || pageLower.includes('£'))) {
    // 检测是否真的付费墙（有提交表单的同时有推广链接不算）
    const hasForm = await page.$('form input[type="text"], form input[type="url"], form textarea');
    if (!hasForm) {
      return { success: false, status: 'paywall', notes: '页面需要付费才能提交' };
    }
  }

  // 检测验证码
  const captchaKeywords = ['captcha', 'recaptcha', 'i\'m not a robot', 'verify you are human'];
  if (captchaKeywords.some(k => pageLower.includes(k))) {
    console.log('  ⚠️ 检测到验证码，尝试自动处理...');
    // 当前策略：跳过验证码（后续可集成 2captcha）
    const hasOtherFields = await page.$('input[type="text"], input[type="url"], textarea');
    if (!hasOtherFields) {
      return { success: false, status: 'captcha', notes: '验证码无法自动处理' };
    }
  }

  // 检测是否已存在（重复提交检测）
  const duplicateKeywords = ['already', 'exists', 'duplicate', 'already submitted'];
  if (duplicateKeywords.some(k => pageLower.includes(k))) {
    return { success: false, status: 'duplicate', notes: '该站点已在该平台提交过' };
  }

  // 填写表单
  for (const field of platform.form_fields) {
    try {
      await fillFormField(page, field, project);
      // 短延迟，模拟真人
      await page.waitForTimeout(500 + Math.random() * 1000);
    } catch (err) {
      console.log(`  ⚠️ 字段 "${field.name}" 填写失败: ${err}`);
    }
  }

  // 查找并点击提交按钮
  const submitBtn = await findSubmitButton(page);
  if (!submitBtn) {
    return { success: false, status: 'no_submit_button', notes: '找不到提交按钮' };
  }

  try {
    await submitBtn.click();
    await page.waitForTimeout(2000 + Math.random() * 2000);
  } catch (err) {
    return { success: false, status: 'click_failed', notes: `提交按钮点击失败: ${err}` };
  }

  // 检测提交结果
  const resultText = await page.textContent('body').catch(() => '');
  const resultLower = resultText?.toLowerCase() || '';

  // 成功检测
  for (const indicator of platform.success_indicators) {
    if (resultLower.includes(indicator.toLowerCase())) {
      console.log(`  ✅ 提交成功 (匹配: "${indicator}")`);
      return { success: true, status: 'success', notes: `匹配成功关键词: ${indicator}` };
    }
  }

  // 失败检测
  const failKeywords = ['error', 'invalid', 'required', 'please fix', 'try again'];
  for (const kw of failKeywords) {
    if (resultLower.includes(kw)) {
      console.log(`  ❌ 提交可能失败 (匹配: "${kw}")`);
      return { success: false, status: 'error', notes: `页面显示错误: ${kw}` };
    }
  }

  // 不确定，标记为需审核
  console.log(`  🤔 状态不确定，标记为 pending_review`);
  return { success: true, status: 'pending_review', notes: '提交成功但需人工确认' };
}

async function fillFormField(page: Page, field: FormField, project: ProjectConfig) {
  const fieldValue = getFieldValue(field, project);

  if (field.type === 'select') {
    const select = await page.$(`select[name="${field.name}"], select#${field.name}`);
    if (select) {
      await select.selectOption(fieldValue);
      return;
    }
    // 尝试按 label 匹配
    const labelOptions = await page.$$('select option');
    for (const opt of labelOptions) {
      const text = await opt.textContent();
      if (text && field.options?.some(o => text.toLowerCase().includes(o.toLowerCase()))) {
        await opt.evaluate((el: any) => { el.selected = true; });
        return;
      }
    }
  }

  if (field.type === 'checkbox') {
    const checkbox = await page.$(`input[name="${field.name}"][type="checkbox"], input#${field.name}[type="checkbox"]`);
    if (checkbox) {
      const isChecked = await checkbox.isChecked();
      if (!isChecked) await checkbox.check();
    }
    return;
  }

  if (field.type === 'image') {
    // 图片上传跳过（需要文件）
    return;
  }

  // text / url / textarea / tel
  const input = await page.$(`input[name="${field.name}"], input#${field.name}, textarea[name="${field.name}"], textarea#${field.name}`);
  if (input) {
    // 先清空再填
    await input.click();
    await input.fill(fieldValue);
  }

  // fallback: 按 placeholder 匹配
  if (!input && field.placeholder) {
    const placeholderInput = await page.$(`input[placeholder*="${field.placeholder}"], textarea[placeholder*="${field.placeholder}"]`);
    if (placeholderInput) {
      await placeholderInput.click();
      await placeholderInput.fill(fieldValue);
    }
  }
}

function getFieldValue(field: FormField, project: ProjectConfig): string {
  switch (field.name) {
    case 'product_name':
    case 'name':
    case 'business_name':
    case 'startup_name':
      return project.name;
    case 'url':
    case 'website':
    case 'host':
      return `https://${project.domain}`;
    case 'description':
    case 'short_description':
      return project.description.substring(0, 500);
    case 'tagline':
    case 'elevator_pitch':
      return project.tagline.substring(0, 60);
    case 'category':
    case 'platform':
      return field.options?.[0] || '';
    case 'phone':
      return '';
    case 'address':
      return '';
    case 'thumbnail':
      return '';
    default:
      return '';
  }
}

async function findSubmitButton(page: Page) {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("submit")',
    'button:has-text("Add")',
    'button:has-text("add")',
    'button:has-text("Create")',
    'button:has-text("create")',
    'button:has-text("Save")',
    'button:has-text("save")',
    'a:has-text("Submit")',
  ];

  for (const selector of selectors) {
    const btn = await page.$(selector);
    if (btn) return btn;
  }

  return null;
}

// --- 主流程 ---

async function main() {
  const args = process.argv.slice(2);
  const isLoop = args.includes('--loop');
  const projectFilter = args.find(a => a.startsWith('--project='))?.split('=')[1];

  const cdpUrl = process.env.BOT_CDP_URL || 'http://localhost:9222';
  const quota = parseInt(process.env.BOT_BACKLINK_QUOTA || '8', 10);

  console.log(`╔════════════════════════════════════════╗`);
  console.log(`║   Backlink Automation Worker v1       ║`);
  console.log(`║   CDP: ${cdpUrl.padEnd(30)}║`);
  console.log(`║   Quota: ${String(quota).padEnd(27)}║`);
  console.log(`╚════════════════════════════════════════╝`);

  // 初始化
  initDB();
  const platforms = loadPlatforms();
  const projects = loadProjects();

  console.log(`📂 已加载 ${Object.keys(platforms).length} 个平台, ${Object.keys(projects).length} 个项目`);

  // 确定要执行的项目
  let projectIds = Object.keys(projects).filter(k => !k.startsWith('_'));
  if (projectFilter) {
    projectIds = projectFilter.split(',').filter(p => projects[p]);
  }

  // 生成任务
  for (const projectId of projectIds) {
    generateTasks(projectId, quota);
  }

  // 获取待执行任务
  const tasks = db.prepare(`
    SELECT st.*, p.name as platform_name
    FROM submission_tasks st
    JOIN (SELECT DISTINCT project_id, platform_id FROM backlink_submissions) bs ON 1=0
    LEFT JOIN json_each((SELECT json_group_array(platform_id) FROM backlink_submissions WHERE project_id = st.project_id)) sq ON sq.value = st.platform_id
    WHERE st.status = 'pending'
      AND st.project_id IN (${projectIds.map(() => '?').join(',')})
    ORDER BY st.priority ASC, st.created_at ASC
    LIMIT ?
  `).all(...projectIds, quota);

  if (tasks.length === 0) {
    console.log('✅ 没有待执行的任务');
    return;
  }

  console.log(`🎯 本次执行 ${tasks.length} 个任务`);

  // 连接 Chrome
  console.log('🔗 连接 Chrome...');
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();

  try {
    for (const task of tasks) {
      const project = projects[task.project_id as string];
      const platform = platforms[task.platform_id as string];

      if (!project || !platform) {
        console.log(`⚠️ 跳过 ${task.project_id}/${task.platform_id}: 配置不存在`);
        db.prepare(`UPDATE submission_tasks SET status = 'failed', error_log = 'config_missing' WHERE id = ?`).run(task.id);
        continue;
      }

      console.log(`\n📌 [${project.name}] → ${platform.name} (DR ${platform.dr})`);

      db.prepare(`UPDATE submission_tasks SET status = 'running', started_at = ? WHERE id = ?`)
        .run(Math.floor(Date.now() / 1000), task.id);

      const result = await submitBacklink(page, platform, project);

      // 记录结果
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`
        UPDATE submission_tasks SET status = 'done', completed_at = ?, result = ?, error_log = ?
        WHERE id = ?
      `).run(now, result.status, result.notes || null, task.id);

      // 如果成功，也写入 submissions 表
      if (result.success) {
        db.prepare(`
          INSERT OR IGNORE INTO backlink_submissions (project_id, platform_id, target_url, status, submitted_at, notes)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          task.project_id,
          task.platform_id,
          `https://${project.domain}`,
          result.status,
          now,
          result.notes || null
        );
      }

      console.log(`  ${result.success ? '✅' : '❌'} ${result.status}${result.notes ? ': ' + result.notes : ''}`);

      // 任务间隔（防封）
      const delay = 3000 + Math.random() * 4000;
      await page.waitForTimeout(delay);
    }
  } finally {
    await page.close();
    // 不断开 Chrome 连接（其他 worker 可能在使用）
  }

  // 汇总
  const successCount = tasks.filter((t: any) => {
    const r = db.prepare(`SELECT result FROM submission_tasks WHERE id = ?`).get(t.id) as any;
    return r?.result === 'success' || r?.result === 'pending_review';
  }).length;

  console.log(`\n📊 汇总: ${successCount}/${tasks.length} 成功`);
}

main().catch(err => {
  console.error('❌ Worker 异常退出:', err);
  process.exit(1);
});
