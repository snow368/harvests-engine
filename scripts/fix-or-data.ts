/**
 * 清理 OR 数据：删脏 + 去 URL 前缀
 * 最后一步修复：处理 http://instagram.com/（无www）、单字母、城市名
 */
import { neon } from '@neondatabase/serverless';

const DB_URL = 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DB_URL);

async function main() {
  // 1. 去所有形式的 IG URL 前缀
  await sql`UPDATE artists SET ig_handle = replace(ig_handle, 'https://www.instagram.com/', '') WHERE import_region = 'OR' AND ig_handle LIKE '%instagram.com%'`;
  await sql`UPDATE artists SET ig_handle = replace(ig_handle, 'http://www.instagram.com/', '') WHERE import_region = 'OR' AND ig_handle LIKE '%instagram.com%'`;
  await sql`UPDATE artists SET ig_handle = replace(ig_handle, 'http://instagram.com/', '') WHERE import_region = 'OR' AND ig_handle LIKE '%instagram.com%'`;
  await sql`UPDATE artists SET ig_handle = replace(ig_handle, 'https://instagram.com/', '') WHERE import_region = 'OR' AND ig_handle LIKE '%instagram.com%'`;
  // 再去一次尾部斜杠
  await sql`UPDATE artists SET ig_handle = regexp_replace(ig_handle, '/+$', '') WHERE import_region = 'OR'`;
  console.log('✅ URL 前缀已清理');

  // 2. 删明显不是 handle 的脏数据（单字母、城市名、地址、电话、假 IG 路径等）
  const d1 = await sql`DELETE FROM artists WHERE import_region = 'OR' AND ig_handle IS NOT NULL AND (
    ig_handle = 'p' OR ig_handle = 'N/A' OR ig_handle = ''
    OR ig_handle = 'popular'                          -- instagram.com/popular
    OR ig_handle = 'tiktok'                           -- instagram.com/tiktok
    OR ig_handle = 'explore'                          -- instagram.com/explore
    OR ig_handle ~ '^[0-9]+'                          -- 数字开头
    OR ig_handle ~ '^[a-z]+ [a-z]+'                   -- 多个单词（城市名）
    OR ig_handle ~ '\\(|\\)'                          -- 含括号（电话）
    OR ig_handle ~ '^[0-9]{3,}'                       -- 纯数字
  )`;
  console.log('已删除明显脏数据:', d1.length, '条');

  // 3. 统计
  const valid = await sql`SELECT COUNT(*) as cnt FROM artists WHERE import_region = 'OR' AND ig_handle IS NOT NULL AND ig_handle != ''`;
  const total = await sql`SELECT COUNT(*) as cnt FROM artists WHERE import_region = 'OR'`;
  console.log('OR 最终: 总数', total[0].cnt, '| 有效handle', valid[0].cnt);
}

main().catch(e => console.error('Error:', e.message));
