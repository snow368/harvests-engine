#!/bin/bash
# 重新导入 OR_Raw.csv（修复列错位后）
# 用法: bash scripts/reimport-all.sh [csv路径]

CSV="${1:-../inkflow_harvests/data/OR_Raw.csv}"

echo "========== 1. 清除旧数据（OR 州） =========="
npx tsx -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL || 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require');
const r = await sql\`DELETE FROM artists WHERE import_region = 'OR'\`;
console.log('已删除', r.length, '条 OR 数据');
"

echo ""
echo "========== 2. 重新导入（正确解析CSV） =========="
npx tsx scripts/import-or-final.ts "$CSV"

echo ""
echo "========== 3. 清理之前创建的脏任务 =========="
npx tsx -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.NEON_DATABASE_URL || 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require');
await sql\`DELETE FROM automation_tasks WHERE payload->>'artistHandle' LIKE 'OR %' OR payload->>'artistHandle' IN ('aloha','corvallis','florence','milwaukie','portland','albany','redmond')\`;
console.log('已清理脏任务');
"

echo ""
echo "========== 4. 清理残留脏 handle（popular/tiktok/单字母等） =========="
npx tsx scripts/fix-or-data.ts

echo ""
echo "========== DONE =========="
