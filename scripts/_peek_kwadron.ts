import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const URLS = [
  'https://www.instagram.com/kwadron/p/DXGspjMjTS1/',
  'https://www.instagram.com/kwadron/p/DT-FEWoikH8/',
  'https://www.instagram.com/kwadron/p/DTmyIOGCZDH/',
  'https://www.instagram.com/kwadron/p/DSAbiYJj_Zw/',
];

const OUT = 'F:/inkflow app/InkFlow_Project/inkflow_harvests/data/generated_samples/kwadron_refs';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.contexts()[0].newPage();

for (let i = 0; i < URLS.length; i++) {
  try {
    await page.goto(URLS[i], { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Take screenshot of the post
    await page.screenshot({ path: path.join(OUT, `kwadron_${i+1}.png`), fullPage: false });
    console.log(`OK ${i+1}: ${URLS[i].substring(0,50)}`);

    // Get image info
    const info = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img[src*="cdn"]')];
      return imgs.slice(0,3).map(i => ({ w: i.width, h: i.height, src: i.src.substring(0,60) }));
    });
    console.log(`  imgs: ${JSON.stringify(info)}`);
  } catch(e) {
    console.log(`FAIL ${i+1}: ${e.message.substring(0,60)}`);
  }
}

console.log('DONE');
