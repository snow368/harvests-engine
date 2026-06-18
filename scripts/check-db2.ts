import { neon } from '@neondatabase/serverless';
const sql = neon('postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require');
async function run() {
  const r = await sql`SELECT state, COUNT(*) as c FROM artists GROUP BY state ORDER BY c DESC`;
  for (const row of r) console.log(`${row.state}: ${row.c}`);
}
run().catch(console.error);
