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
import * as yamlModule from 'js-yaml';
import Database from 'better-sqlite3';

// 2026-09-17：js-yaml 4.x 的 package.json 用 "exports" 把 `import` 条件指向 dist/js-yaml.mjs，
// 那份 ESM 构建**只有具名导出**（load/dump/…）、没有 default，于是 ESM 下
//     import yaml from 'js-yaml'
// 必抛 SyntaxError: The requested module 'js-yaml' does not provide an export named 'default'
// （该 import 由 2026-09-02 的 64e93c0 引入，此后这两个 app 一次都没成功跑起来过 →
//   pm2 每 30s 重启一次 → Windows 每次重启新分配一个可见控制台窗口 = 弹窗刷屏的真凶之一）
// 改法：命名空间导入 + 兼容取值。ESM 构建取命名空间本身，CJS 构建取 .default。
const yaml: any = (yamlModule as any).default ?? yamlModule;

// ── 路径 ──
// 2026-09-16：原来硬编码 'F:/SEO_Project' —— VPS 没有 F 盘，new Database() 直接抛错，
// 于是 pm2 每 30 秒重启一次（每次都闪一个控制台窗口）。改为 env 可配。
const BASE_DIR = process.env.SEO_PROJECT_DIR || 'F:/SEO_Project';
const DATA_DIR = path.join(BASE_DIR, 'data');
const DB_PATH = process.env.BACKLINK_DB_PATH || path.join(BASE_DIR, 'data/backlinks.db');

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

// ── 预检：依赖目录缺失时进入待机，而不是崩溃 ──
// 崩溃 → pm2 无限重启 → Windows 上每次重启弹一个控制台窗口。缺依赖时保持 online 空转更安全。
function missingDeps(): string[] {
  return [
    DATA_DIR,
    path.join(DATA_DIR, 'backlink-platforms.yaml'),
    path.join(DATA_DIR, 'project-configs.yaml'),
  ].filter(p => !fs.existsSync(p));
}

const _missing = missingDeps();
if (_missing.length) {
  console.warn('[backlink-scheduler] 依赖缺失 → 待机（进程保持 online，不退出、不重启）：');
  for (const m of _missing) console.warn('   ✗ ' + m);
  console.warn('   修复：设 SEO_PROJECT_DIR=<SEO_Project 路径> 后重启本进程，或把缺失文件放到位。');
  setInterval(() => {}, 1 << 30);
} else {
  // 2026-09-17：main() 也必须兜住。曾实测到「依赖都在、但 backlink-platforms.yaml 解析失败」
  // → 抛 YAMLException → 进程退出 → pm2 重启 → 无限崩溃循环。
  // pm2 托管的进程在 Windows 上「退出」是最贵的行为（重启 + 刷窗口），所以一律兜住并保活。
  try {
    main();
  } catch (e: any) {
    console.error('[backlink-scheduler] main() 异常 → 待机（不退出，避免 pm2 崩溃重启）：');
    console.error('   ' + (e?.message || e));
    setInterval(() => {}, 1 << 30);
  }
}
