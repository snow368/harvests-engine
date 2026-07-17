import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

/** IG 抓图 — 点击 tile → 弹窗截图，不关浏览器 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const HANDLES = ['woohootattoo', 'maxtattooneedle', 'chiyoda_tattoo', 'stigmarotary'];
const FRAMES_DIR = 'F:/inkflow app/InkFlow_Project/inkflow_harvests/data/hook_frames';
const TARGET = 30;

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 1800 });

for (const handle of HANDLES) {
    const brandDir = path.join(FRAMES_DIR, handle);
    fs.mkdirSync(brandDir, { recursive: true });
    const existing = fs.readdirSync(brandDir).filter(f => f.endsWith('.jpg')).length;
    if (existing >= TARGET) { console.log(`  SKIP @${handle}`); continue; }

    console.log(`\n  @${handle}`);
    try {
        await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Scroll to load enough posts
        for (let s = 0; s < 8; s++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1500);
        }

        // Click each post tile → dialog opens → screenshot → close
        let count = existing;
        while (count < TARGET) {
            const tiles = await page.$$('article a[href*="/p/"]');
            const idx = count - existing;
            if (idx >= tiles.length) break;

            try {
                await tiles[idx].click();
                await page.waitForTimeout(2000);

                // Method 1 from memory: find img in dialog, use element.screenshot()
                const dialog = await page.$('div[role="dialog"]');
                if (dialog) {
                    // Try to find the post image (exclude avatar - small 32/44px icons)
                    const img = await dialog.$('img[src*="cdn"]:not([width="32"]):not([width="44"]), img[src*="cdn"]:not([height="32"]):not([height="44"])');
                    if (img) {
                        await img.screenshot({ path: path.join(brandDir, `rp${count}.jpg`), type: 'jpeg', quality: 90 });
                        count++;
                        if (count % 5 === 0) process.stdout.write('.');
                    } else {
                        // Fallback: screenshot the entire dialog
                        await dialog.screenshot({ path: path.join(brandDir, `rp${count}.jpg`), type: 'jpeg', quality: 85 });
                        count++;
                    }
                }

                // Close dialog
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
            } catch (e) {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(1000);
            }
        }
        console.log(` → ${count - existing} new (${count} total)`);
    } catch (e) {
        console.log(`  FAIL: ${e}`);
    }
}

console.log('\nDONE — browser left open');
