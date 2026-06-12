import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'deep_scan_tasks.db'));

const fails = db.prepare("SELECT id, payload, error_reason FROM automation_tasks WHERE status='failed' AND json_extract(payload, '$.taskType') = 'ig_outreach' LIMIT 15").all();
fails.forEach(t => {
  const p = JSON.parse(t.payload || '{}');
  console.log(`  @${p.artistHandle}: ${t.error_reason?.slice(0, 100) || 'no reason'}`);
});

const botLog = db.prepare("SELECT * FROM bot_observations WHERE command_id LIKE 'ig_outreach_%' ORDER BY id DESC LIMIT 5").all();
console.log('\nlast 5 outreach observations:');
botLog.forEach(o => {
  const sf = JSON.parse(o.summary_json || '{}');
  console.log(`  @${o.artist_handle} mode=${o.mode} totalMedia=${sf.totalMedia}`);
});

db.close();
