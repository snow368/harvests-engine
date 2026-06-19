/**
 * 清理 OR 数据：删脏 + 去 URL 前缀
 */
import { neon } from '@neondatabase/serverless';

const DB_URL = 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DB_URL);

async function main() {
  // 1. 删脏数据（ig_handle 是 ZIP 码）
  const d1 = await sql`DELETE FROM artists WHERE import_region = 'OR' AND ig_handle LIKE 'OR %'`;
  console.log('已删除 ZIP 脏数据:', d1.length);

  // 2. 去 IG URL 前缀
  const d2 = await sql`UPDATE artists SET ig_handle = replace(replace(ig_handle, 'https://www.instagram.com/', ''), 'http://www.instagram.com/', '') WHERE import_region = 'OR' AND ig_handle LIKE '%instagram.com%'`;
  console.log('已清理 URL 前缀:', d2.length);

  // 3. N/A 置空
  await sql`UPDATE artists SET ig_handle = NULL WHERE import_region = 'OR' AND ig_handle = 'N/A'`;
  console.log('已清理 N/A');

  // 4. 统计
  const c = await sql`SELECT COUNT(*) as cnt FROM artists WHERE import_region = 'OR' AND ig_handle IS NOT NULL AND ig_handle != ''`;
  console.log('最终有效 handle:', c[0].cnt, '条');
}

main().catch(e => console.error('Error:', e.message));
