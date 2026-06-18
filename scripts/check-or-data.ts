import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('.env', 'utf-8');
env.split('\n').forEach(l => { const i = l.indexOf('='); if(i > 0 && l.trim()) process.env[l.slice(0,i).trim()] = l.slice(i+1).trim(); });
const sql = neon(process.env.NEON_DATABASE_URL || '');
async function check() {
  const r = await sql('SELECT COUNT(*) as c FROM artists WHERE state = $1', ['OR']);
  console.log('OR total:', r[0].c);
  const r2 = await sql("SELECT COUNT(*) as c FROM artists WHERE state = $1 AND ig_handle IS NOT NULL AND ig_handle != $2", ['OR', '']);
  console.log('OR with IG:', r2[0].c);
}
check().catch(console.error);
