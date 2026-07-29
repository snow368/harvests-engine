import Database from 'better-sqlite3';

const db = new Database('data/deep_scan_tasks.db');
const now = Date.now();

const reset = db.prepare('UPDATE automation_tasks SET run_at = ? WHERE status = ?').run(now, 'pending');
console.log('Reset', reset.changes, 'tasks to immediate run');

const tasks = db.prepare('SELECT id, payload FROM automation_tasks WHERE status = ? LIMIT 5').all('pending') as any[];

// Enable browse_like (with like) for first 2 tasks, and enable comment for 1
for (let i = 0; i < Math.min(3, tasks.length); i++) {
  const payload = JSON.parse(tasks[i].payload);
  payload.suggestedExecMode = i < 2 ? 'browse_like' : 'browse_only';
  if (i === 0) {
    payload.protocol.warmupPolicy.commentEnabled = true;
    payload.protocol.warmupPolicy.commentDailyMax = 1;
    payload.protocol.warmupPolicy.commentChance = 0.3;
  }
  db.prepare('UPDATE automation_tasks SET payload = ? WHERE id = ?').run(JSON.stringify(payload), tasks[i].id);
  console.log('Task updated:', payload.artistHandle, '| mode:', payload.suggestedExecMode, i === 0 ? '| comment: ON' : '');
}

const total = db.prepare('SELECT COUNT(*) as c FROM automation_tasks WHERE status = ?').get('pending');
console.log('Total pending:', (total as any).c);
db.close();
console.log('DONE');
