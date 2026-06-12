/**
 * Brand Caption + Comment Scraper
 *
 * 从品牌 IG 主页采集帖子 caption（JSON 内嵌数据）+ 评论区（DOM）
 * 连桌面2 Chrome (port 9222)
 * 运行: npx tsx scripts/bot-comments-scraper.ts
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const BRANDS = [
  'kwadron','cheyennetattoo','fkirons','bishoprotary','dragonhawktattoo',
  'stigmarotary','workhorseirons','masttattoo','solongtattoo','needlejig',
  'blackclawtattoo','criticaltattoo','eikondevice',
  'worldfamousink','eternalink','solidinktattoo','radiantcolorsink',
  'kurosumi_ink','wickedink','intenzetattooink',
  'hkmachines','zeus_tattoo_machines','wand_tattoo','inkmachines_official',
  'tatsoul','painfulpleasures','bnbtattoo','truetattoosupply',
  'fytsupplies','papatattoosupply','mavericktattoomercantile',
  'disruptivetattoosupply','goodguysupply','berlintattoosupply',
  'tattoogoo','drmpickle','madrabbit','recoverytattoo','hustlebutter',
  'zoraypt','inkintattoosupply','inksoultattoosupply',
];

const DATA_FILE = 'data/brand_captions_dataset.json';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function categorizeCaption(text: string): string {
  const lower = text.toLowerCase();
  if (/new|launch|introducing|available now|shop|pre.order|coming soon|drop|release|just dropped/i.test(lower)) return 'product_launch';
  if (/feature|spotlight|repost|artist.?spotlight|meet.?.artist|ambassador|pro team/i.test(lower)) return 'artist_feature';
  if (/tip|guide|how.to|care|aftercare|advice|recommend|pro.tip|tutorial/i.test(lower)) return 'educational';
  if (/thank|grateful|appreciate|honored|excited|blessed/i.test(lower)) return 'gratitude';
  if (/sale|discount|code|% off|free shipping|bundle|deal/i.test(lower)) return 'promotion';
  if (/convention|expo|booth|event|show|seminar|workshop/i.test(lower)) return 'event';
  if (/quality|craftsmanship|premium|built to|designed for|engineered/i.test(lower)) return 'brand_story';
  if (/flash|design|sheet|art|drawing|sketch/i.test(lower)) return 'art_share';
  return 'general_update';
}

/** 从 JSON script tag 提取 caption text + post info */
const EXTRACT_POST_FN = `
  let found = null;
  const scripts = document.querySelectorAll('script[type="application/json"]');
  for (const s of scripts) {
    const t = s.textContent || '';
    if (!t.includes('xdt_api__v1__media__shortcode__web_info')) continue;
    try {
      const d = JSON.parse(t);
      const raw = JSON.stringify(d);
      const textMatch = raw.match(/"text":"((?:[^"\\\\]|\\\\.)*)"/);
      const caption = textMatch ? textMatch[1] : '';
      const userMatch = raw.match(/"username":"([^"]+)"/);
      const username = userMatch ? userMatch[1] : '';
      found = { caption, username };
    } catch {}
    break;
  }
  found;
`;

/** 从 DOM 提取评论列表 */
const EXTRACT_COMMENTS_FN = `
  const cs = [];
  document.querySelectorAll('span').forEach(span => {
    if (span.textContent?.trim() !== 'Reply') return;
    const c = span.parentElement?.parentElement?.parentElement;
    if (!c || c.children.length < 2) return;
    if (!c.querySelector('._ap3a')) return;
    const c0 = c.children[0], c1 = c.children[1];
    const username = c0.querySelector('._ap3a')?.textContent?.trim() || '';
    const timeEl = c0.querySelector('time');
    const timestamp = timeEl?.textContent?.trim() || '';
    const c0Text = c0.textContent || '';
    const afterUser = c0Text.replace(username, '').replace('Verified', '').trim();
    const text = afterUser.replace(/^\\d+[dwmyh]\\s*/, '').trim();
    const c1Text = c1.textContent || '';
    let likes = 0;
    if (c1Text.includes('1 like')) likes = 1;
    else { const m = c1Text.match(/(\\d+)\\s+likes/); if (m) likes = parseInt(m[1]) || 0; }
    if (username && text && !cs.some(x => x.username === username && x.text === text)) {
      cs.push({ username, text, likes, timestamp });
    }
  });
  cs;
`;

async function main() {
  let dataset: any[] = [];
  if (fs.existsSync(DATA_FILE)) {
    try { dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  console.log(`Existing: ${dataset.length} posts`);

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  let totalNew = 0;

  for (let bi = 0; bi < BRANDS.length; bi++) {
    const brand = BRANDS[bi];
    const existing = dataset.filter(d => d.brand === brand).length;
    if (existing >= 20) {
      console.log(`[${bi+1}/${BRANDS.length}] @${brand} — skip (${existing})`);
      continue;
    }

    console.log(`[${bi+1}/${BRANDS.length}] @${brand} — browsing...`);
    try {
      await page.goto(`https://www.instagram.com/${brand}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000 + Math.random() * 2000);

      const urls = [...new Set(await page.$$eval('a[href*="/p/"]', els =>
        els.map(e => (e as HTMLAnchorElement).href).filter(Boolean)
      ))].slice(0, 20);
      console.log(`  Posts: ${urls.length}`);

      for (const url of urls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(1500 + Math.random() * 1000);

          // --- Extract caption from JSON script tag ---
          const postInfo = await page.evaluate(EXTRACT_POST_FN) || {};
          const caption = (postInfo.caption || '').trim();
          if (caption.length <= 10) {
            console.log(`  Skip: caption too short (${caption.length} chars)`);
            continue;
          }

          const dupKey = `${brand}:${caption}`;
          if (dataset.some(d => d.brand === brand && d.content === caption)) continue;

          // --- Extract comments from DOM ---
          let comments: any[] = [];
          try {
            comments = await page.evaluate(EXTRACT_COMMENTS_FN);
          } catch {}

          dataset.push({
            brand,
            content: caption.slice(0, 2000),
            category: categorizeCaption(caption),
            wordCount: caption.split(/\s+/).length,
            hasEmoji: /[\u{1F300}-\u{1FAFF}]/u.test(caption),
            postUrl: url,
            comments,
            commentCount: comments.length,
            scrapedAt: new Date().toISOString(),
          });
          totalNew++;
          console.log(`  [${dataset[dataset.length-1].category}] "${caption.slice(0, 60)}" (${comments.length} comments)`);

          if (totalNew % 10 === 0) {
            fs.writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2), 'utf8');
          }
          await sleep(1000 + Math.random() * 1500);
        } catch (err: any) {
          console.log(`  Post err: ${err.message?.slice(0, 80)}`);
        }
      }
    } catch (err: any) {
      console.log(`  Profile err: ${err.message?.slice(0, 80)}`);
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2), 'utf8');
    console.log(`  Saved: ${dataset.length} total`);
    await sleep(2000 + Math.random() * 3000);
  }

  console.log(`\nDone. New: ${totalNew}, Total: ${dataset.length}`);
  const byCat: Record<string,number> = {};
  dataset.forEach(d => { byCat[d.category] = (byCat[d.category] || 0) + 1; });
  console.log('By category:', byCat);
  const withComments = dataset.filter(d => d.commentCount > 0).length;
  console.log(`Posts with comments: ${withComments}/${dataset.length}`);

  await page.close();
  await browser.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
