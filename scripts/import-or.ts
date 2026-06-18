/** 一次性: 导入 OR 数据到 Neon */
import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const env = fs.readFileSync('.env', 'utf-8');
env.split('\n').forEach(l => { const i = l.indexOf('='); if(i > 0 && l.trim()) process.env[l.slice(0,i).trim()] = l.slice(i+1).trim(); });
const sql = neon(process.env.NEON_DATABASE_URL || '');
const csvPath = process.argv[2] || 'C:\\harvests\\data\\scrape_output\\OR_Raw.csv';

async function main() {
  const csv = fs.readFileSync(csvPath, 'utf-8');
  const lines = csv.split('\n').filter(Boolean);
  const h = lines[0].split(',').map(x => x.trim().replace(/^"|"$/g,''));
  const idx = (name: string) => { const i = h.findIndex(x => x.toLowerCase() === name.toLowerCase()); return i >= 0 ? i : null; };
  const si = idx('Shop Name'), ii = idx('Instagram'), ai = idx('Address'), ci = idx('City'), pi = idx('Phone'), wi = idx('Website'), ei = idx('Email'), ri = idx('Rating'), rvi = idx('Reviews');

  let ok = 0, err = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',').map(x => x.trim().replace(/^"|"$/g,''));
    const name = si != null ? c[si] || '' : '';
    let ig = ii != null ? c[ii] || '' : '';
    if (ig && ig !== 'N/A') ig = ig.replace(/^https?:\/\/(www\.)?instagram\.com\//,'').replace(/\/$/,'').replace(/^@/,'');
    else ig = '';
    if (!name && !ig) { err++; continue; }
    const addr = ai != null ? c[ai] || '' : '';
    const city = ci != null ? c[ci] || '' : '';
    const phone = pi != null ? c[pi] || '' : '';
    const web = wi != null ? c[wi] || '' : '';
    const email = ei != null ? c[ei] || '' : '';
    const rating = ri != null ? parseFloat(c[ri]) || 0 : 0;
    const reviews = rvi != null ? parseInt(c[rvi]) || 0 : 0;

    const id = name ? `${name.replace(/[^a-z0-9]/gi,'_').toLowerCase()}_${addr.replace(/[^a-z0-9]/gi,'_').toLowerCase()}_${phone.replace(/\D/g,'')}`.slice(0,120) : `ig_${ig}`;
    try {
      await sql`INSERT INTO artists (id, shop_name, ig_handle, address, city, state, phone, website, email, rating, reviews, import_region, last_updated)
        VALUES (${id}, ${name}, ${ig}, ${addr}, ${city}, 'OR', ${phone}, ${web||null}, ${email||null}, ${rating}, ${reviews}, 'OR', NOW())
        ON CONFLICT (id) DO UPDATE SET ig_handle = COALESCE(NULLIF(EXCLUDED.ig_handle,''), artists.ig_handle)`;
      ok++;
    } catch(e: any) { err++; if (err <= 3) console.error('  ERR:', name||ig, e.message?.slice(0,80)); }
  }
  console.log(`\n✅ 导入完成: ${ok} 成功, ${err} 跳过`);
}

main().catch(console.error);
