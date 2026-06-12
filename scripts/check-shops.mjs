import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });

const sql = neon(process.env.NEON_DATABASE_URL);

// Check Neon tables
const shops = await sql`SELECT instagram, shop_name, city FROM scraped_shops WHERE instagram IS NOT NULL AND instagram != '' LIMIT 20`;
console.log(`scraped_shops with IG: ${shops.length}`);
shops.forEach(s => console.log(`  ${s.shop_name} -> ${s.instagram} (${s.city || ''})`));

try {
  const artists = await sql`SELECT ig_handle, shop_name FROM artists LIMIT 20`;
  console.log(`\nartists table: ${artists.length}`);
  artists.forEach(a => console.log(`  ${a.ig_handle} - ${a.shop_name || ''}`));
} catch(e) {
  console.log('\nartists table not found or error:', e.message);
}
