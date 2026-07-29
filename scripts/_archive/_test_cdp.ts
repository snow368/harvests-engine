import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);
const url = page.url();
console.log('URL:', url);

if (!url.includes('login')) {
    console.log('LOGGED IN');
    // Try going to a brand page
    await page.goto('https://www.instagram.com/woohootattoo/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('Brand page loaded:', page.url());
    const h = await page.content();
    console.log('Page has', h.length, 'chars');
} else {
    console.log('NOT logged in');
}

await page.close();
browser.close();
