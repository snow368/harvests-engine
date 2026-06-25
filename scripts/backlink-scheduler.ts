/**
 * Backlink Automation Scheduler v1
 * ================================
 * 每日/定时运行，自动生成外链提交任务
 *
 * 运行方式：
 *   npx tsx scripts/backlink-scheduler.ts              # 生成任务（不执行）
 *   npx tsx scripts/backlink-scheduler.ts --run         # 生成 + 执行
 *   npx tsx scripts/backlink-scheduler.ts --project inkflow  # 只针对某个项目
 *
 * 环境变量：
 *   BOT_BACKLINK_DAILY_QUOTA=20     # 每日总提交上限
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';

// ── 路径 ──
const BASE_DIR = 'F:/SEO_Project';
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_PATH = path.join(BASE_DIR, 'data/backlinks.db');

// ── DB ──
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

// ── 配置加载 ──

interface FormField {
  name: string; type: string; label: string;
  placeholder?: string; options?: string[];
}

interface Platform {
  name: string; url: string; submit_url: string | null;
  type: string; dr: number; difficulty: string;
  registration: boolean; paywall: boolean;
  captcha: boolean | string; approval: string;
  method: string; description: string;
  form_fields: FormField[]; success_indicators: string[];
  suitable_for: string[]; notes?: string;
}

interface Project {
  name: string; domain: string; industry: string;
  tagline: string; description: string;
  preferred_anchor_texts: string[];
  exclude_platforms: string[]; preferred_types: string[];
  daily_quota: number; priority: string;
}

function loadPlatforms(): Record<string, Platform> {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'backlink-platforms.yaml'), 'utf-8');
  return (yaml.load(raw) as any).platforms || {};
}

function loadProjects(): Record<string, Project> {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'project-configs.yaml'), 'utf-8');
  return (yaml.load(raw) as any).projects || {};
}

// ── 核心调度逻辑 ──

interface TaskCandidate {
  platformKey: string;
  platform: Platform;
  priority: number;
}

function generateTasks(projectId: string, project: Project): TaskCandidate[] {
  const platforms = loadPlatforms();
  const now = Math.floor(Date.now() / 1000);

  // 获取已提交 + 已有任务的平台
  const submitted = new Set(
    (db.prepare(`SELECT platform_id FROM backlink_submissions WHERE project_id = ?`)
      .all(projectId) as any[]).map(r => r.platform_id)
  );
  const existingTasks = new Set(
    (db.prepare(`SELECT platform_id FROM submission_tasks WHERE project_id = ? AND status != 'done'`)
      .all(projectId) as any[]).map(r => r.platform_id)
  );
  const doneTasks = new Set(
    (db.prepare(`SELECT platform_id FROM submission_tasks WHERE project_id = ? AND status = 'done' AND result IN ('success','pending_review')`)
      .all(projectId) as any[]).map(r => r.platform_id)
  );

  // 筛选
  const candidates: TaskCandidate[] = [];
  const diffOrder: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

  for (const [key, p] of Object.entries(platforms)) {
    if (project.exclude_platforms.includes(key)) continue;
    if (submitted.has(key)) continue;        // 已提交过
    if (doneTasks.has(key)) continue;        // 已成功
    if (existingTasks.has(key)) continue;    // 已有待处理任务
    if (!p.suitable_for.includes(project.industry)) continue;

    const pri = diffOrder[p.difficulty] ?? 99;
    candidates.push({ platformKey: key, platform: p, priority: pri });
  }

  // 按难度排序
  candidates.sort((a, b) => a.priority - b.priority);

  // 按配额截取
  const selected = candidates.slice(0, project.daily_quota);

  // 批量插入
  const insert = db.prepare(`
    INSERT OR IGNORE INTO submission_tasks (project_id, platform_id, status, priority, created_at)
    VALUES (?, ?, 'pending', ?, ?)
  `);

  for (const c of selected) {
    insert.run(projectId, c.platformKey, c.priority, now);
  }

  return selected;
}

// ── 报告生成 ──

function generateReport(projectIds: string[]) {
  console.log(`\n📊 Backlink 自动化状态报告`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  for (const pid of projectIds) {
    const project = loadProjects()[pid];
    if (!project) continue;

    const totalTasks = (db.prepare(
      `SELECT COUNT(*) as c FROM submission_tasks WHERE project_id = ?`
    ).get(pid) as any).c;

    const pendingTasks = (db.prepare(
      `SELECT COUNT(*) as c FROM submission_tasks WHERE project_id = ? AND status = 'pending'`
    ).get(pid) as any).c;

    const successCount = (db.prepare(
      `SELECT COUNT(*) as c FROM backlink_submissions WHERE project_id = ? AND status IN ('success','pending_review')`
    ).get(pid) as any).c;

    const assetCount = (db.prepare(
      `SELECT COUNT(*) as c FROM backlink_assets WHERE project_id = ? AND status = 'active'`
    ).get(pid) as any).c;

    console.log(`\n  📁 ${project.name} (${pid})`);
    console.log(`    提交任务: ${totalTasks} (待执行: ${pendingTasks})`);
    console.log(`    提交成功: ${successCount}`);
    console.log(`    外链资产: ${assetCount}`);
  }

  // 汇总
  const totalAll = (db.prepare(`SELECT COUNT(*) as c FROM backlink_submissions`).get() as any).c;
  console.log(`\n  📈 总计提交: ${totalAll}`);
}

// ── 主入口 ──

function main() {
  const args = process.argv.slice(2);
  const shouldRun = args.includes('--run');
  const projectFilter = args.find(a => a.startsWith('--project='))?.split('=')[1];

  // 从环境变量读取配额，不传则用项目配置
  const globalQuota = process.env.BOT_BACKLINK_DAILY_QUOTA
    ? parseInt(process.env.BOT_BACKLINK_DAILY_QUOTA, 10)
    : null;

  initDB();

  const projects = loadProjects();
  const now = Math.floor(Date.now() / 1000);

  // 确定项目列表
  let projectIds = Object.keys(projects).filter(k => !k.startsWith('_'));
  if (projectFilter) {
    projectIds = projectFilter.split(',').filter(p => projects[p]);
  }

  console.log(`╔═══════════════════════════════════════╗`);
  console.log(`║  Backlink Scheduler v1               ║`);
  console.log(`║  ${new Date().toISOString()}     ║`);
  console.log(`╚═══════════════════════════════════════╝`);

  let totalGenerated = 0;

  for (const pid of projectIds) {
    const project = projects[pid];
    if (!project) continue;

    // 支持环境变量覆盖配额
    const quota = globalQuota ?? project.daily_quota;
    const adjustedProject = { ...project, daily_quota: quota };

    const selected = generateTasks(pid, adjustedProject);
    totalGenerated += selected.length;

    if (selected.length > 0) {
      console.log(`\n📋 [${project.name}] 生成 ${selected.length} 个任务 (配额: ${quota}):`);
      for (const c of selected) {
        const diffIcon = c.platform.difficulty === 'easy' ? '🟢' : c.platform.difficulty === 'medium' ? '🟡' : '🔴';
        console.log(`  ${diffIcon} ${c.platform.name.padEnd(20)} DR ${c.platform.dr}  (${c.platformKey})`);
      }
    } else {
      console.log(`\n✅ [${project.name}] 无可生成的新任务`);
    }

    // 更新调度状态
    db.prepare(`
      INSERT OR REPLACE INTO scheduler_state (id, project_id, last_run_at, tasks_created)
      VALUES ((SELECT id FROM scheduler_state WHERE project_id = ?), ?, ?, ?)
    `).run(pid, pid, now, selected.length);
  }

  console.log(`\n📊 本次共生成 ${totalGenerated} 个提交任务`);

  // 生成状态报告
  generateReport(projectIds);

  console.log(`\n💡 运行 npx tsx scripts/backlink-worker.ts 来执行任务`);
}

main();
