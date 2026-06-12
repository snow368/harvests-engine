import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
const sql = neon(process.env.NEON_DATABASE_URL);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'deep_scan_tasks.db'));

// Fetch shops with IG handles from Neon
const rows = await sql`
  SELECT instagram, shop_name, city FROM scraped_shops
  WHERE instagram IS NOT NULL AND instagram != '' AND instagram != 'N/A'
  ORDER BY scraped_at DESC
`;

const parseHandle = (v) => {
  const x = String(v || '').trim();
  if (!x || x === 'N/A') return '';
  const m = x.match(/instagram\.com\/([a-zA-Z0-9._-]+)/i);
  if (m?.[1]) return m[1].toLowerCase();
  return x.replace(/^@/, '').trim().toLowerCase();
};

const handles = rows.map(r => parseHandle(r.instagram)).filter(Boolean);
const unique = [...new Set(handles)];
console.log(`Found ${unique.length} unique IG handles from ${rows.length} shops`);

// Deduplicate against existing tasks (7 day window)
const now = Date.now();
const DEDUP_WINDOW = 7 * 24 * 60 * 60 * 1000;
let created = 0, skipped = 0;

const existsStmt = db.prepare(`SELECT id FROM automation_tasks WHERE json_extract(payload, '$.artistHandle') = ? AND created_at > ? LIMIT 1`);
const insertStmt = db.prepare(`INSERT INTO automation_tasks (id, payload, status, run_at, lease_until, leased_by, attempts, max_attempts, error_reason, created_at, updated_at) VALUES (?, ?, 'pending', ?, NULL, NULL, 0, 3, NULL, ?, ?)`);

for (let i = 0; i < unique.length; i++) {
  const handle = unique[i];
  if (existsStmt.get(handle, now - DEDUP_WINDOW)) { skipped++; continue; }

  const commandId = `ig_outreach_${handle}_${Date.now()}`;
  const staggerMs = i * (45 + Math.floor(Math.random() * 90)) * 1000;
  const runAt = now + staggerMs;

  const payload = {
    id: commandId,
    taskType: 'ig_outreach',
    artistHandle: handle,
    accountType: 'tattoo_shop',
    behaviorProfile: 'warmup',
    source: 'outreach_auto',
    suggestedExecMode: 'browse_like',
    timestamp: new Date().toISOString(),
    protocol: {
      steps: [
        { action: 'browse_feed', delay: 45 },
        { action: 'enter_profile', target: handle, delay: 60 },
        { action: 'browse_posts', count: 6, delay: 30 },
        { action: 'like_recent', max_likes: 3, delay: 45 }
      ]
    }
  };
  insertStmt.run(commandId, JSON.stringify(payload), runAt, now, now);
  created++;
}

console.log(`Done: ${created} created, ${skipped} skipped (already in tasks)`);

// Show current task stats
const stats = db.prepare('SELECT status, COUNT(*) as cnt FROM automation_tasks GROUP BY status').all();
console.log('\nTask stats:');
stats.forEach(s => console.log(`  ${s.status}: ${s.cnt}`));

db.close();
