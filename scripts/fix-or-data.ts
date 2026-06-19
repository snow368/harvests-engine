/**
 * 清理 OR 数据：删脏 + 去 URL 前缀
 */
import { neon } from '@neondatabase/serverless';

const DB_URL = 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DB_URL);

async function main() {
  // 1. 删 ZIP 码脏数据
  const d1 = await sql`DELETE FROM artists WHERE import_region = 'OR' AND ig_handle LIKE 'OR %'`;
  console.log('已删除 ZIP 脏数据:', d1.length);

  // 2. 去 IG URL 前缀
  let d2 = await sql`UPDATE artists SET ig_handle = replace(ig_handle, 'https://www.instagram.com/', '') WHERE import_region = 'OR' AND ig_handle LIKE 'https://www.instagram.com/%'`;
  // 针对 http://www. 少个 s 的情况
  d2 = await sql`UPDATE artists SET ig_handle = replace(ig_handle, 'http://www.instagram.com/', '') WHERE import_region = 'OR' AND ig_handle LIKE 'http://www.instagram.com/%'`;
  console.log('已清理 URL 前缀:', d2.length);

  // 3. N/A 置空
  await sql`UPDATE artists SET ig_handle = NULL WHERE import_region = 'OR' AND ig_handle = 'N/A'`;
  console.log('已清理 N/A');

  // 4. 统计
  const c = await sql`SELECT COUNT(*) as cnt FROM artists WHERE import_region = 'OR' AND ig_handle IS NOT NULL AND ig_handle != ''`;
  console.log('最终有效 handle:', c[0].cnt, '条');

  // 5. 看看还有哪些问题 handle
  const bad = await sql`SELECT ig_handle, shop_name FROM artists WHERE import_region = 'OR' AND ig_handle IS NOT NULL AND ig_handle != '' AND ig_handle !~ '^[a-zA-Z][a-zA-Z0-9._]{2,29}$'`;
  if (bad.length > 0) {
    console.log('还有', bad.length, '条问题 handle:');
    for (const b of bad) console.log('  ', b.ig_handle, '→', b.shop_name);
  }
}

main().catch(e => console.error('Error:', e.message));
