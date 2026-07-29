import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { chromium } from 'playwright';
import fs from 'fs';

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const p = await b.contexts()[0].newPage();

await p.goto('https://www.instagram.com/stigmarotary/', { timeout: 15000, waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

// Scroll
for (let i = 0; i < 5; i++) {
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(1000);
}

const result = {
    links: await p.evaluate(() => [...document.querySelectorAll('a[href*="/p/"]')].map(a => a.href.substring(0,70))),
    articles: await p.evaluate(() => document.querySelectorAll('article').length),
    imgs: await p.evaluate(() => [...document.querySelectorAll('img')].filter(i => i.width > 100).slice(0,5).map(i => ({src: i.src.substring(0,60), w: i.width})))
};

fs.writeFileSync('C:/Users/snow3/debug_ig.json', JSON.stringify(result, null, 2));
console.log('done, wrote debug_ig.json');
