/**
 * 从 Peach Shopify 抓产品图 → data/product_images/
 * 用法: npx tsx scripts/peach-fetch.ts
 */
import https from 'https';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const STORE = 'https://peachtattoosupplies.com';
const OUT = 'data/product_images';

async function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(data.slice(0,100)); }});
    }).on('error', reject);
  });
}

async function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); })
      .on('error', () => { file.close(); resolve(); });
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // Fetch all products (handle pagination)
  let allProducts: any[] = [];
  let page = 1;
  while (page <= 10) {
    const data = await fetchJSON(`${STORE}/products.json?page=${page}&limit=250`);
    if (!data.products || data.products.length === 0) break;
    allProducts = allProducts.concat(data.products);
    if (data.products.length < 250) break; // last page
    page++;
  }

  console.log(`Products: ${allProducts.length}`);

  let downloaded = 0;
  for (const product of allProducts) {
    const images = (product.images || []).map((i: any) => i.src || i).filter(Boolean);
    for (const url of images) {
      // Get original size (remove Shopify size params)
      const cleanUrl = url.replace(/_(small|compact|medium|large|grande|original|master)\.[a-z]+/i, '.') + '.jpg';
      // Actually just use the URL as-is, Shopify CDN is fine
      const ext = path.extname(url.split('?')[0]) || '.jpg';
      const name = `${product.handle}_${downloaded}${ext}`;
      const dest = path.join(OUT, name);
      if (!fs.existsSync(dest)) {
        await download(url, dest);
        downloaded++;
      }
    }
  }

  // List what we got
  const files = fs.readdirSync(OUT).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
  console.log(`Downloaded: ${downloaded} new | Total: ${files.length} images`);

  // Show a few products for reference
  console.log('\nSample products:');
  allProducts.slice(0, 8).forEach(p => console.log(`  ${p.handle} — ${p.title.slice(0, 50)}`));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
