/**
 * Pipeline Orchestrator — 内容管线编排器
 *
 * 串联全流程：抓取 → 分析 → 生成 → 发布 + 自学习反馈
 *
 * 用法: npx tsx scripts/pipeline-orchestrator.ts
 *
 * ENV:
 *   PIPELINE_STAGES=scrape,create,publish   (逗号分隔，默认全部)
 *   PIPELINE_RUN_ONCE=true                   (单次运行 vs 持续运行，默认 true)
 *   CONTENT_SCRAPE_MIN_POST_SCORE=40         (降低门槛获取更多素材)
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, ChildProcess } from 'node:child_process';

// ============ Config ============
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const STAGES = (process.env.PIPELINE_STAGES || 'scrape,create,publish').split(',').map(s => s.trim());
const RUN_ONCE = String(process.env.PIPELINE_RUN_ONCE || 'true').toLowerCase() === 'true';
const SCRAPE_POSTS_PER_HANDLE = Number(process.env.CONTENT_SCRAPE_POSTS_PER_HANDLE || 3);
const MIN_SAMPLE_SCORE = Number(process.env.CONTENT_CREATOR_MIN_SCORE || 40);
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============ API Helpers ============
const postJson = async (p: string, body: Record<string, any>) => {
  const resp = await fetch(`${API_BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const getJson = async (p: string) => {
  const resp = await fetch(`${API_BASE}${p}`);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

// ============ DB Helpers ============
const openDb = () => {
  const Database = require('better-sqlite3');
  return new Database(DB_PATH);
};

const getPipelineStats = () => {
  const db = openDb();
  try {
    const competitors = db.prepare('SELECT COUNT(*) as c FROM content_competitors WHERE active = 1').get() as any;
    const samples = db.prepare('SELECT COUNT(*) as c, AVG(quality_score) as avg FROM content_samples').get() as any;
    const goodSamples = db.prepare('SELECT COUNT(*) as c FROM content_samples WHERE quality_score >= ?').get(MIN_SAMPLE_SCORE) as any;
    const publishTasks = db.prepare("SELECT COUNT(*) as c FROM content_publish_tasks WHERE status = 'pending'").get() as any;
    const published = db.prepare("SELECT COUNT(*) as c FROM content_publish_tasks WHERE status = 'done'").get() as any;
    const engagement = db.prepare('SELECT COUNT(*) as c, AVG(likes) as avgLikes FROM content_engagement').get() as any;
    return {
      activeCompetitors: competitors?.c || 0,
      totalSamples: samples?.c || 0,
      avgSampleScore: Math.round((samples?.avg || 0) * 10) / 10,
      usableSamples: goodSamples?.c || 0,
      pendingPublishTasks: publishTasks?.c || 0,
      totalPublished: published?.c || 0,
      engagementEntries: engagement?.c || 0,
      avgLikes: Math.round((engagement?.avgLikes || 0) * 10) / 10,
    };
  } finally {
    db.close();
  }
};

// ============ Stage Runners ============
const runScraper = async (): Promise<{ ok: boolean; output: string }> => {
  return new Promise((resolve) => {
    console.log('\n[orchestrator] Stage 1: Content Scraper');
    const child = execFile('npx', ['tsx', 'scripts/content-scraper.ts'], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 600000, // 10 min timeout for scraping
      env: {
        ...process.env,
        CONTENT_SCRAPE_POSTS_PER_HANDLE: String(SCRAPE_POSTS_PER_HANDLE),
        CONTENT_SCRAPE_MIN_POST_SCORE: String(MIN_SAMPLE_SCORE),
      },
    }, (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).slice(-3000);
      if (err && (err as any).killed) {
        console.log('[orchestrator] Scraper completed (timeout or killed)');
        resolve({ ok: true, output });
      } else if (err) {
        console.error('[orchestrator] Scraper error:', err.message?.slice(0, 200));
        resolve({ ok: false, output });
      } else {
        console.log('[orchestrator] Scraper completed');
        resolve({ ok: true, output });
      }
    });

    if (child.stdout) child.stdout.pipe(process.stdout);
    if (child.stderr) child.stderr.pipe(process.stderr);
  });
};

const runCreator = async (): Promise<{ ok: boolean; output: string }> => {
  return new Promise((resolve) => {
    console.log('\n[orchestrator] Stage 2: Content Creator');
    const child = execFile('npx', ['tsx', 'scripts/content-creator.ts'], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300000,
      env: {
        ...process.env,
        CONTENT_CREATOR_MIN_SCORE: String(MIN_SAMPLE_SCORE),
      },
    }, (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).slice(-3000);
      if (err && (err as any).killed) {
        resolve({ ok: true, output });
      } else if (err) {
        console.error('[orchestrator] Creator error:', err.message?.slice(0, 200));
        resolve({ ok: false, output });
      } else {
        console.log('[orchestrator] Creator completed');
        resolve({ ok: true, output });
      }
    });

    if (child.stdout) child.stdout.pipe(process.stdout);
    if (child.stderr) child.stderr.pipe(process.stderr);
  });
};

const runPublisher = async (): Promise<{ ok: boolean; output: string }> => {
  return new Promise((resolve) => {
    console.log('\n[orchestrator] Stage 3: Publish Worker');
    const child = execFile('npx', ['tsx', 'scripts/publish-worker.ts'], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 300000,
      env: process.env,
    }, (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).slice(-3000);
      if (err && (err as any).killed) {
        resolve({ ok: true, output });
      } else if (err) {
        console.error('[orchestrator] Publisher error:', err.message?.slice(0, 200));
        resolve({ ok: false, output });
      } else {
        resolve({ ok: true, output });
      }
    });

    if (child.stdout) child.stdout.pipe(process.stdout);
    if (child.stderr) child.stderr.pipe(process.stderr);
  });
};

// ============ Self-Learning Report ============
const generateLearningReport = () => {
  const stats = getPipelineStats();
  console.log('\n═══════════════════════════════════════');
  console.log('  Pipeline Self-Learning Report');
  console.log('═══════════════════════════════════════');
  console.log(`  Active Competitors:     ${stats.activeCompetitors}`);
  console.log(`  Content Samples:        ${stats.totalSamples} (avg score: ${stats.avgSampleScore}/100)`);
  console.log(`  Usable Samples:         ${stats.usableSamples} (score >= ${MIN_SAMPLE_SCORE})`);
  console.log(`  Pending Publish Tasks:  ${stats.pendingPublishTasks}`);
  console.log(`  Total Published:        ${stats.totalPublished}`);
  console.log(`  Engagement Entries:     ${stats.engagementEntries}`);
  console.log(`  Avg Likes:              ${stats.avgLikes}`);

  // Recommendations
  console.log('\n  Recommendations:');
  if (stats.usableSamples < 5) {
    console.log('  ⚠  Low usable samples — lower MIN_SCORE or add more competitors');
  }
  if (stats.pendingPublishTasks === 0 && stats.usableSamples > 0) {
    console.log('  ⚠  No pending publish tasks — creator may need to run');
  }
  if (stats.totalPublished > 0 && stats.engagementEntries === 0) {
    console.log('  ⚠  No engagement data — enable engagement tracking');
  }
  if (stats.avgSampleScore < 20) {
    console.log('  ⚠  Very low sample scores — caption extraction may need fix');
  }
  if (stats.activeCompetitors < 3) {
    console.log('  ℹ  Consider adding more competitors for better content variety');
  }
  console.log('═══════════════════════════════════════\n');

  return stats;
};

// ============ Main ============
const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  InkFlow Content Pipeline           ║');
  console.log('║  Orchestrator v1.0                  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Stages: ${STAGES.join(' → ')}`);
  console.log(`  Mode: ${RUN_ONCE ? 'single run' : 'continuous'}`);

  // Verify server
  try {
    const health = await getJson('/api/automation/tasks');
    console.log(`  Server: OK (${(health as any)?.total || '?'} tasks)`);
  } catch {
    console.error('  Server NOT reachable. Start with: npx tsx server.ts');
    process.exit(1);
  }

  // Pre-run stats
  console.log('\n  Pre-run pipeline state:');
  const preStats = getPipelineStats();
  console.log(`    ${preStats.totalSamples} samples, ${preStats.usableSamples} usable, ${preStats.pendingPublishTasks} pending`);

  // Run stages
  const results: Record<string, { ok: boolean }> = {};

  if (STAGES.includes('scrape')) {
    results.scrape = await runScraper();
    await sleep(2000);
  }

  if (STAGES.includes('create')) {
    const postScrapeStats = getPipelineStats();
    if (postScrapeStats.usableSamples > 0) {
      results.create = await runCreator();
    } else {
      console.log('[orchestrator] Stage 2 (Creator): SKIPPED — no usable samples');
    }
    await sleep(2000);
  }

  if (STAGES.includes('publish')) {
    const postCreateStats = getPipelineStats();
    if (postCreateStats.pendingPublishTasks > 0) {
      results.publish = await runPublisher();
    } else {
      console.log('[orchestrator] Stage 3 (Publisher): SKIPPED — no pending publish tasks');
    }
  }

  // Post-run learning report
  console.log('\n  Post-run pipeline state:');
  const postStats = generateLearningReport();

  // Summary
  console.log('Pipeline run complete.');
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  if (failed.length > 0) {
    console.log(`  ${failed.length} stage(s) had issues: ${failed.map(([k]) => k).join(', ')}`);
  }

  // Suggest next actions
  console.log('\n  Next actions:');
  if (postStats.pendingPublishTasks > 0) {
    console.log('  → Start publish worker: npx tsx scripts/publish-worker.ts');
  }
  if (postStats.usableSamples < 5) {
    console.log('  → Add competitors: POST /api/content/competitors');
    console.log('  → Run scraper again: PIPELINE_STAGES=scrape npx tsx scripts/pipeline-orchestrator.ts');
  }
  console.log('  → View stats: GET /api/content/samples');
};

main().catch((e) => {
  console.error('[orchestrator] Fatal:', e?.message || e);
  process.exit(1);
});
