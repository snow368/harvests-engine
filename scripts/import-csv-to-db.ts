/**
 * CSV → Neon DB 导入脚本
 * 用法: npx ts-node scripts/import-csv-to-db.ts [csv路径]
 * 默认读取 D:\MyCrawler_System\Data\Raw_Leads\WA_Raw.csv
 */
import { neon } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 直接读 .env，不依赖 dotenv 包
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && val && !process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const DATABASE_URL = process.env.NEON_DATABASE_URL!;

const sql = neon(DATABASE_URL);

const CSV_PATH = process.argv[2] || 'D:\\MyCrawler_System\\Data\\Raw_Leads\\WA_Raw.csv';
const STATE = process.env.IMPORT_STATE || 'WA';
const COUNTRY = 'USA';

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += c;
  }
  result.push(current.trim());
  return result;
}

function generateShopId(name: string, address: string, phone: string): string {
  const raw = `${name}_${address}_${phone}`.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  return raw.slice(0, 120);
}

const IG_SYSTEM_PATHS = new Set([
  'meta', 'p', 'reel', 'reels', 'stories', 'tv', 'explore', 'about', 'ar',
  'api', 'developer', 'legal', 'accounts', 'business', 'help', 'settings',
]);

function extractIgHandle(url: string): string | null {
  if (!url || url === 'N/A') return null;
  const m = url.match(/instagram\.com\/([a-zA-Z0-9._-]+)/);
  if (!m) return null;
  const handle = m[1].toLowerCase();
  if (IG_SYSTEM_PATHS.has(handle) || handle.length <= 1) return null;
  return handle;
}

function normalizeSocialUrl(url: string): string {
  if (!url || url === 'N/A') return 'N/A';
  return url.replace(/^http:\/\//, 'https://').replace(/\/$/, '');
}

async function main() {
  console.log(`Reading: ${CSV_PATH}`);
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = raw.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  console.log(`Headers: ${headers.join(', ')}`);

  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => row[h.trim()] = (cols[idx] || '').trim());
    rows.push(row);
  }
  console.log(`Parsed ${rows.length} shops\n`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    try {
      const name = r['Shop Name'] || '';
      const city = (r['City'] || '').replace(/, WA$/, '').replace(/\s+(CDP|city|town)$/i, '');
      const address = r['Address'] || '';
      const phone = r['Phone'] || '';
      const igUrl = normalizeSocialUrl(r['Instagram'] || '');
      const fbUrl = normalizeSocialUrl(r['Facebook'] || '');
      const website = normalizeSocialUrl(r['Website'] || '');
      const email = (r['Email'] || '').replace(/^N\/A$/, '');
      const reviews = parseInt(r['Reviews'] || '0', 10) || 0;
      const shopId = generateShopId(name, address, phone);
      const igHandle = extractIgHandle(igUrl);

      if (!name) { skipped++; continue; }

      const existing = await sql`SELECT id FROM artists WHERE id = ${shopId}`;

      if (existing.length > 0) {
        await sql`
          UPDATE artists SET
            full_name = ${name},
            shop_name = ${name},
            address = ${address},
            phone = ${phone},
            website = ${website},
            ig_handle = ${igHandle},
            facebook = ${fbUrl !== 'N/A' ? fbUrl : null},
            email = ${email || null},
            rating = ${reviews > 0 ? reviews : null},
            reviews = ${reviews},
            last_updated = NOW()
          WHERE id = ${shopId}
        `;
        updated++;
      } else {
        await sql`
          INSERT INTO artists (id, uid, username, full_name, shop_name, stage,
            rating, reviews, address, phone, website, ig_handle, facebook,
            email, city, source_type, entity_type, import_region, last_updated)
          VALUES (${shopId}, ${shopId}, ${name.replace(/\s+/g, '_').toLowerCase()},
            ${name}, ${name}, 'outreach', ${reviews > 0 ? reviews : 0}, ${reviews},
            ${address}, ${phone}, ${website !== 'N/A' ? website : null},
            ${igHandle ? igHandle : null},
            ${fbUrl !== 'N/A' ? fbUrl : null},
            ${email || null}, ${city},
            'maps_scrape', 'tattoo_shop', ${STATE}, NOW())
        `;
        inserted++;
      }

      if ((inserted + updated) % 50 === 0) {
        console.log(`  Progress: ${inserted + updated}/${rows.length} (new: ${inserted}, updated: ${updated})`);
      }
    } catch (e: any) {
      console.error(`  Error on "${r['Shop Name']}": ${e.message?.slice(0, 100)}`);
      skipped++;
    }
  }

  console.log(`\nDone! Inserted: ${inserted}, Updated: ${updated}, Skipped: ${skipped}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
