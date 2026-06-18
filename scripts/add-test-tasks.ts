import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('.env', 'utf-8');
env.split('\n').forEach(l => { const i = l.indexOf('='); if(i > 0 && l.trim()) process.env[l.slice(0,i).trim()] = l.slice(i+1).trim(); });
const sql = neon(process.env.NEON_DATABASE_URL || '');
async function run() {
  const shops = await sql`SELECT ig_handle FROM artists WHERE state='OR' AND ig_handle IS NOT NULL AND ig_handle != '' LIMIT 5`;
  const now = Date.now();
  for (const s of shops) {
    const id = `ig_scheduled_${s.ig_handle}_${now}`;
    const payload = JSON.stringify({id,taskType:'ig_outreach',botId:'bot_ig_01',artistHandle:s.ig_handle,handle:s.ig_handle,mode:'browse_only',suggestedExecMode:'browse_like',desiredOpenCount:3,scheduledAt:new Date().toISOString()});
    await sql`INSERT INTO automation_tasks (id, payload, status, run_at, attempts, max_attempts, created_at, updated_at) VALUES (${id}, ${payload}::jsonb, 'pending', ${now}, 0, 3, ${now}, ${now}) ON CONFLICT (id) DO NOTHING`;
    console.log('Created:', s.ig_handle);
  }
}
run().catch(console.error);
