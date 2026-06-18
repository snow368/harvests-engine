import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const DB_URL = 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DB_URL);
const csvPath = 'C:\\harvests\\data\\scrape_output\\OR_Raw.csv';

async function main() {
  const csv = fs.readFileSync(csvPath, 'utf-8');
  const lines = csv.split('\n').filter(Boolean);
  const h = lines[0].split(',').map(x => x.trim().replace(/^"|"$/g,''));
  const col = (name: string) => { const i = h.findIndex(x => x.toLowerCase() === name.toLowerCase()); return i >= 0 ? i : null; };
  const [si, ii, ai, ci, pi, wi, ei, ri, rvi] = ['shop name','instagram','address','city','phone','website','email','rating','reviews'].map(col);

  let ok = 0, err = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',').map(x => x.trim().replace(/^"|"$/g,''));
    const name = si != null ? c[si] || '' : '';
    let ig = ii != null ? c[ii] || '' : '';
    if (ig && ig !== 'N/A') ig = ig.replace(/^https?:\/\/(www\.)?instagram\.com\//,'').replace(/\/$/,'').replace(/^@/,''); else ig = '';
    if (!name && !ig) { err++; continue; }
    const id = name ? `${name.replace(/[^a-z0-9]/gi,'_').toLowerCase()}_${(ai!=null?c[ai]:'').replace(/[^a-z0-9]/gi,'_').toLowerCase()}_${(pi!=null?c[pi]:'').replace(/\D/g,'')}`.slice(0,120) : `ig_${ig}`;
    try {
      await sql`INSERT INTO artists (id, uid, shop_name, ig_handle, address, city, state, phone, website, email, rating, reviews, import_region, last_updated)
        VALUES (${id}, ${id}, ${name}, ${ig}, ${ai!=null?c[ai]:''}, ${ci!=null?c[ci]:''}, 'OR', ${pi!=null?c[pi]:''}, ${wi!=null?c[wi]||null:null}, ${ei!=null?c[ei]||null:null}, ${ri!=null?parseFloat(c[ri])||0:0}, ${rvi!=null?parseInt(c[rvi])||0:0}, 'OR', NOW())
        ON CONFLICT (id) DO UPDATE SET ig_handle = COALESCE(NULLIF(EXCLUDED.ig_handle,''), artists.ig_handle)`;
      ok++;
    } catch(e: any) { err++; if (err <= 3) console.error('ERR:', (e.message||'').slice(0,80)); }
  }
  console.log(`\nDone: ${ok} ok, ${err} err`);

  // verify
  const r = await sql`SELECT COUNT(*) as c FROM artists WHERE state='OR'`;
  console.log('OR in DB now:', r[0].c);
}
main().catch(console.error);
