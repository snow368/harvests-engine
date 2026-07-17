import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

/**
 * Artist Caption + Comment Scraper
 *
 * 从 discovered_artists.json 读取赞助纹身师 → 采集帖子 caption + 评论区
 * 连桌面2 Chrome (port 9222)
 * 运行: npx tsx scripts/bot-artist-scraper.ts
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs';

const ARTISTS_FILE = 'data/discovered_artists.json';
const DATA_FILE = 'data/artist_captions_dataset.json';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface ArtistEntry { handle: string; source: string }

function categorize(text: string): string {
  const lower = text.toLowerCase();
  if (/sponsored|ambassador|pro.team|partner|grateful.*@|honored.*@|excited.*@|thank.*@/i.test(lower)) return 'brand_partnership';
  if (/@[a-z]/.test(lower) && /needle|machine|ink|supply|cartridge|aftercare|tattoo.?supply/i.test(lower)) return 'product_mention';
  if (/flash|design|sheet|art|drawing|sketch|painting/i.test(lower)) return 'art_share';
  if (/booking|opening|available|dm|link in bio|schedule|session|appointment/i.test(lower)) return 'booking';
  if (/convention|expo|guest.spot|traveling|tour|event/i.test(lower)) return 'event';
  if (/new|fresh|latest|recent|just finished|done today/i.test(lower)) return 'new_work';
  return 'general';
}

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
  const raw = fs.readFileSync(ARTISTS_FILE, 'utf8');
  const brandData: Record<string, ArtistEntry[]> = JSON.parse(raw);

  // Flatten to unique artists with brand associations
  const artistMap = new Map<string, string[]>();
  for (const [brand, artists] of Object.entries(brandData)) {
    for (const a of artists) {
      const h = (typeof a === 'string' ? a : a.handle).toLowerCase().trim();
      if (!h) continue;
      if (!artistMap.has(h)) artistMap.set(h, []);
      artistMap.get(h)!.push(brand);
    }
  }

  const allArtists = [...artistMap.entries()].map(([handle, brands]) => ({ handle, brands }));
  console.log(`Total unique artists: ${allArtists.length}`);

  // Load existing data
  let dataset: any[] = [];
  if (fs.existsSync(DATA_FILE)) {
    try { dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  console.log(`Existing captions: ${dataset.length}`);
  const doneHandles = new Set(dataset.map((d: any) => d.handle));

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  let totalNew = 0;

  for (let ai = 0; ai < allArtists.length; ai++) {
    const { handle, brands } = allArtists[ai];
    if (doneHandles.has(handle)) {
      console.log(`[${ai+1}/${allArtists.length}] @${handle} — skip`);
      continue;
    }

    console.log(`[${ai+1}/${allArtists.length}] @${handle} [${brands.join(',')}] — browsing...`);
    try {
      await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(5000 + Math.random() * 3000);

      const urls = [...new Set(await page.$$eval('a[href*="/p/"]', els =>
        els.map(e => (e as HTMLAnchorElement).href).filter(Boolean)
      ))].slice(0, 10);
      console.log(`  Posts: ${urls.length}`);

      for (const url of urls) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await sleep(4000 + Math.random() * 2000);

          // Extract caption from JSON script tag
          const postInfo = await page.evaluate(EXTRACT_POST_FN) || {};
          const caption = (postInfo.caption || '').trim();
          if (caption.length <= 10) continue;
          if (dataset.some((d: any) => d.handle === handle && d.content === caption)) continue;

          // Extract comments
          let comments: any[] = [];
          try { comments = await page.evaluate(EXTRACT_COMMENTS_FN); } catch {}

          // Clean \\n to actual newlines
          const cleanCaption = caption.replace(/\\n/g, '\n');

          dataset.push({
            handle,
            brands,
            content: cleanCaption.slice(0, 2000),
            category: categorize(cleanCaption),
            wordCount: cleanCaption.split(/\s+/).length,
            hasEmoji: /[\u{1F300}-\u{1FAFF}]/u.test(cleanCaption),
            postUrl: url,
            comments,
            commentCount: comments.length,
            scrapedAt: new Date().toISOString(),
          });
          totalNew++;
          if (totalNew <= 5) console.log(`  [${dataset[dataset.length-1].category}] ${cleanCaption.slice(0, 80)}`);

          await sleep(3000 + Math.random() * 2000);
        } catch (err: any) {
          console.log(`  Post err: ${err.message?.slice(0, 60)}`);
        }
      }

      doneHandles.add(handle);
      if (totalNew % 10 === 0 && totalNew > 0) {
        fs.writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2), 'utf8');
      }
    } catch (err: any) {
      console.log(`  Profile err: ${err.message?.slice(0, 80)}`);
    }

    await sleep(5000 + Math.random() * 5000);
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2), 'utf8');
  console.log(`\nDone. New: ${totalNew}, Total: ${dataset.length}`);
  const byCat: Record<string,number> = {};
  dataset.forEach((d: any) => { byCat[d.category] = (byCat[d.category] || 0) + 1; });
  console.log('By category:', byCat);
  const withComments = dataset.filter((d: any) => d.commentCount > 0).length;
  console.log(`Posts with comments: ${withComments}/${dataset.length}`);

  await page.close();
  await browser.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
