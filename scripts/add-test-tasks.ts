import { neon } from '@neondatabase/serverless';
const DB_URL = 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DB_URL);
async function run() {
  const r = await sql`SELECT COUNT(*) as c FROM artists`;
  console.log('artists count:', r[0].c);
  const shops = await sql`SELECT ig_handle FROM artists WHERE state='OR' AND ig_handle IS NOT NULL AND ig_handle != '' LIMIT 5`;
  console.log('sample shops:', shops.map(s=>s.ig_handle));
  const now = Date.now();
  for (const s of shops) {
    const id = `ig_scheduled_${s.ig_handle}_${now}`;
    const payload = JSON.stringify({id,taskType:'ig_outreach',botId:'bot_ig_01',artistHandle:s.ig_handle,handle:s.ig_handle,mode:'browse_only',suggestedExecMode:'browse_like',desiredOpenCount:3,scheduledAt:new Date().toISOString()});
    await sql`INSERT INTO automation_tasks (id, payload, status, run_at, attempts, max_attempts, created_at, updated_at) VALUES (${id}, ${payload}::jsonb, 'pending', ${now}, 0, 3, ${now}, ${now}) ON CONFLICT (id) DO NOTHING`;
    console.log('created task:', s.ig_handle);
  }
}
run().catch(console.error);
