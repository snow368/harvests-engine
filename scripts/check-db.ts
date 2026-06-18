import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('.env', 'utf-8');
env.split('\n').forEach(l => { const i = l.indexOf('='); if(i > 0 && l.trim()) process.env[l.slice(0,i).trim()] = l.slice(i+1).trim(); });
const sql = neon(process.env.NEON_DATABASE_URL || '');
async function run() {
  const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  console.log('Tables:', tables.map(t => t.table_name));
  if (tables.find(t => t.table_name === 'artists')) {
    const r = await sql`SELECT COUNT(*) as c FROM artists`;
    console.log('artists total:', r[0].c);
  }
}
run().catch(console.error);
