import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'deep_scan_tasks.db'));

const stats = db.prepare("SELECT status, COUNT(*) as cnt FROM automation_tasks WHERE json_extract(payload, '$.taskType') = 'ig_outreach' GROUP BY status").all();
console.log('outreach tasks:', stats.map(s => `${s.status}=${s.cnt}`).join(', '));

const recent = db.prepare("SELECT id, status, updated_at FROM automation_tasks WHERE json_extract(payload, '$.taskType') = 'ig_outreach' ORDER BY updated_at DESC LIMIT 5").all();
console.log('\nrecent:');
recent.forEach(t => console.log(`  ${t.id.slice(0,40)} ${t.status} ${new Date(t.updated_at).toLocaleTimeString()}`));

const totalDone = db.prepare("SELECT COUNT(*) as cnt FROM automation_tasks WHERE status='done'").get();
const total = db.prepare("SELECT COUNT(*) as cnt FROM automation_tasks").get();
console.log(`\ntotal done: ${totalDone.cnt} / ${total.cnt}`);

db.close();
