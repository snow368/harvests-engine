/**
 * 配置 Bot IG 账号信息
 * 运行一次记录账号创建时间，后续调度器自动按号龄调整行为
 *
 * 用法: npx tsx scripts/setup-accounts.ts
 *
 * 账号阶段与行为:
 *   0-3天   萌芽期  → browse_only, 每天5任务
 *   4-7天   过渡期  → browse_like, 每天10任务
 *   1-4周   成长期  → browse_like+轻comment, 每天20任务
 *   1-3月   稳定期  → 正常互动, 每天30任务
 *   3月+    成熟期  → 全量互动, 每天50任务
 */
import { neon } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';

const DB_URL = 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DB_URL);

// 账号配置 — 手动填写你的 IG 账号
// 第一次使用日期越准确，bot 行为越自然
const ACCOUNTS = [
  {
    accountId: 'acc_ig_01',
    igHandle: 'raiha8833',           // 你的 IG 用户名
    botId: 'bot_ig_01',
    firstUsedAt: '2026-06-19',       // 第一次用这个号跑 bot 的日期
    notes: '主号 - IG outreach',
  },
  // 以后加新号就在这里加：
  // {
  //   accountId: 'acc_ig_02',
  //   igHandle: 'your_second_account',
  //   botId: 'bot_ig_02',
  //   firstUsedAt: '2026-06-15',
  //   notes: '备用号',
  // },
];

function calcStage(firstUsed: string): string {
  const days = Math.floor((Date.now() - new Date(firstUsed).getTime()) / 86400000);
  if (days <= 3) return 'new';
  if (days <= 7) return 'transition';
  if (days <= 28) return 'growing';
  if (days <= 90) return 'stable';
  return 'mature';
}

function dailyLimit(stage: string): number {
  const map: Record<string, number> = { new: 5, transition: 10, growing: 20, stable: 30, mature: 50 };
  return map[stage] || 10;
}

function speedFactor(stage: string): number {
  const map: Record<string, number> = { new: 2.5, transition: 1.8, growing: 1.2, stable: 1.0, mature: 0.8 };
  return map[stage] || 1.0;
}

async function main() {
  console.log('=== Bot 账号配置 ===\n');

  for (const acct of ACCOUNTS) {
    const stage = calcStage(acct.firstUsedAt);
    const limit = dailyLimit(stage);
    const speed = speedFactor(stage);

    await sql`
      INSERT INTO bot_accounts (account_id, ig_handle, bot_id, created_at, first_used_at, stage, daily_task_limit, speed_factor, notes)
      VALUES (${acct.accountId}, ${acct.igHandle}, ${acct.botId}, NOW(), ${new Date(acct.firstUsedAt).toISOString()}, ${stage}, ${limit}, ${speed}, ${acct.notes})
      ON CONFLICT (account_id) DO UPDATE SET
        ig_handle = EXCLUDED.ig_handle,
        stage = EXCLUDED.stage,
        daily_task_limit = EXCLUDED.daily_task_limit,
        speed_factor = EXCLUDED.speed_factor
    `;

    const days = Math.floor((Date.now() - new Date(acct.firstUsedAt).getTime()) / 86400000);
    console.log(`  ${acct.igHandle} (${acct.accountId})`);
    console.log(`    号龄: ${days}天 → 阶段: ${stage}`);
    console.log(`    日任务: ${limit} | 速度: ${speed}x`);
    console.log('');
  }

  // 查看所有账号
  const all = await sql`SELECT account_id, ig_handle, stage, daily_task_limit, speed_factor, first_used_at FROM bot_accounts ORDER BY first_used_at`;
  console.log('---');
  for (const a of all) {
    const days = a.first_used_at ? Math.floor((Date.now() - new Date(a.first_used_at).getTime()) / 86400000) : '?';
    console.log(`  ${a.ig_handle} | 号龄${days}天 | ${a.stage} | 日${a.daily_task_limit}任务 | 速度${a.speed_factor}x`);
  }
}

main().catch(e => console.error('Error:', e.message));
