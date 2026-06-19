/**
 * 批量导入 OR_Raw.csv 到 Neon artists 表
 * 使用引号感知的 CSV 解析器，正确处理地址/邮箱内的逗号
 * 用法: npx tsx scripts/import-or-final.ts <csv路径>
 * 默认路径: C:\harvests\data\scrape_output\OR_Raw.csv
 */
import { neon } from '@neondatabase/serverless';
import fs from 'fs';

const DB_URL = 'postgresql://neondb_owner:npg_recAJm30vOWR@ep-patient-hill-antvzk6p.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DB_URL);
const csvPath = process.argv[2] || 'C:\\harvests\\data\\scrape_output\\OR_Raw.csv';

/**
 * 引号感知 CSV 行解析器
 * 正确拆分: "4035 SE Hawthorne Blvd, Portland, OR 97214" → 一个字段
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // 转义引号 ""
      if (i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim().replace(/^"|"$/g, ''));
  return fields;
}

async function main() {
  const csvRaw = fs.readFileSync(csvPath, 'utf-8');
  const lines = csvRaw.split('\n').filter(Boolean);

  // 解析头部
  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const colIndex = (name: string) => {
    const i = header.findIndex(h => h.toLowerCase() === name.toLowerCase());
    return i >= 0 ? i : null;
  };

  // 列索引
  const si = colIndex('shop name');
  const ii = colIndex('instagram');
  const ai = colIndex('address');
  const ci = colIndex('city');
  const pi = colIndex('phone');
  const wi = colIndex('website');
  const ei = colIndex('email');
  const ri = colIndex('rating');
  const rvi = colIndex('reviews');
  const fi = colIndex('facebook');
  const ti = colIndex('tiktok');
  const sti = colIndex('state');

  console.log(`CSV 共 ${lines.length - 1} 行`);
  console.log(`列映射: shop_name=${si} instagram=${ii} website=${wi} city=${ci}`);

  let ok = 0, err = 0;
  for (let l = 1; l < lines.length; l++) {
    const c = parseCSVLine(lines[l]);

    const name = si != null ? (c[si] || '').trim() : '';
    let ig = ii != null ? (c[ii] || '').trim() : '';
    const website = wi != null ? (c[wi] || '').trim() : '';
    const address = ai != null ? (c[ai] || '').trim() : '';
    const city = ci != null ? (c[ci] || '').trim() : '';
    const phone = pi != null ? (c[pi] || '').trim() : '';
    const email = ei != null ? (c[ei] || '').trim() : '';
    const rating = ri != null ? Math.round(parseFloat(c[ri])) || 0 : 0;
    const reviews = rvi != null ? parseInt(c[rvi]) || 0 : 0;
    const facebook = fi != null ? (c[fi] || '').trim() : '';
    const tiktok = ti != null ? (c[ti] || '').trim() : '';
    const state = sti != null ? (c[sti] || 'OR').trim().toUpperCase() : 'OR';

    // 提取纯净 IG handle
    if (ig && ig !== 'N/A') {
      ig = ig.replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '').replace(/^@/, '').trim();
    } else {
      ig = '';
    }

    if (!name && !ig) { err++; continue; }

    // 生成唯一 ID
    const cleanName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const cleanAddr = address.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const cleanPhone = phone.replace(/\D/g, '');
    const id = `${cleanName}_${cleanAddr}_${cleanPhone}`.slice(0, 120);

    try {
      await sql`
        INSERT INTO artists (id, uid, shop_name, ig_handle, address, city, state, phone, website, email, facebook, tiktok, rating, reviews, import_region, last_updated)
        VALUES (
          ${id}, ${id}, ${name},
          ${ig || null}, ${address || null}, ${city || null}, ${state},
          ${phone || null},
          ${website && website !== 'N/A' ? website : null},
          ${email || null},
          ${facebook && facebook !== 'N/A' ? facebook : null},
          ${tiktok && tiktok !== 'N/A' ? tiktok : null},
          ${rating}, ${reviews}, ${state}, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          ig_handle = COALESCE(NULLIF(EXCLUDED.ig_handle, ''), artists.ig_handle),
          website = COALESCE(NULLIF(EXCLUDED.website, ''), artists.website),
          facebook = COALESCE(NULLIF(EXCLUDED.facebook, ''), artists.facebook),
          tiktok = COALESCE(NULLIF(EXCLUDED.tiktok, ''), artists.tiktok)
      `;
      ok++;
      if (ok % 50 === 0) process.stdout.write(`  ${ok}/${lines.length - 1}...\r`);
    } catch (e: any) {
      err++;
      if (err <= 3) console.error(`ERR [${name || ig}]:`, (e.message || '').slice(0, 100));
    }
  }

  console.log(`\nDone: ${ok} ok, ${err} err`);
}

main().catch(e => console.error('FATAL:', e));
