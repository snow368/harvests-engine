import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'deep_scan_tasks.db'));

// Check what competitors/accounts are available
const competitors = db.prepare("SELECT handle, account_type, source, active FROM content_competitors LIMIT 30").all();
console.log('=== COMPETITORS ===');
competitors.forEach(c => console.log(`  @${c.handle} type=${c.account_type} source=${c.source} active=${c.active}`));

// Check shops table
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log('\n=== TABLES ===');
tables.forEach(t => console.log(`  ${t.name}`));

// Check if there's a tattoo shop table
['shops', 'ig_shops', 'tattoo_shops', 'outreach', 'scraped_shops'].forEach(name => {
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${name}`).get();
    console.log(`  ${name}: ${row.cnt} rows`);
  } catch(e) {}
});

db.close();
