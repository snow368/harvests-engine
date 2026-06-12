/**
 * 一次性抓取所有竞对品类帖子 — 增强版
 * 抓取文案、图片、评论、发布时间、互动率
 *
 * 用法: npx tsx scripts/_scrape_brand_posts.ts
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import 'dotenv/config';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';
const BRAND_DB = 'data/brand_database.json';
const OUTPUT = 'data/brand_posts_categorized.json';
const SUPPLY_BOT_OUTPUT = 'data/brand_captions_dataset.json';
const MIN_FOLLOWERS = 5000;
const MAX_POSTS_PER_BRAND = 10;
const MAX_SCROLL_ATTEMPTS = 8;

// Read brand database & group by category
const brandDb: any[] = JSON.parse(fs.readFileSync(BRAND_DB, 'utf8'));
const TARGET_BRANDS: Record<string, string[]> = {};
for (const b of brandDb) {
  if (!b.verified) continue;
  if (!TARGET_BRANDS[b.category]) TARGET_BRANDS[b.category] = [];
  TARGET_BRANDS[b.category].push({ handle: b.handle, name: b.name });
}

function jitter(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseCompactNumber(text: string): number {
  const cleaned = String(text || '').trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const wanM = cleaned.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wanM) return Math.round(Number(wanM[1]) * 10000);
  const yiM = cleaned.match(/(\d+(?:\.\d+)?)\s*亿/);
  if (yiM) return Math.round(Number(yiM[1]) * 100000000);
  const m = cleaned.match(/(\d+(?:\.\d+)?)([kmb])?/);
  if (!m) return 0;
  const base = Number(m[1] || 0);
  const unit = String(m[2] || '').toLowerCase();
  if (unit === 'k') return Math.round(base * 1000);
  if (unit === 'm') return Math.round(base * 1000000);
  if (unit === 'b') return Math.round(base * 1000000000);
  return Math.round(base);
}

async function scrapeProfile(page: any, brand: string): Promise<{
  followers: number; tileUrls: string[]; website: string;
  displayName: string; bio: string; avatarUrl: string;
}> {
  await page.goto(`https://www.instagram.com/${brand}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(jitter(3000, 5000));

  let followers = 0;
  let website = '';
  let displayName = '';
  let bio = '';
  let avatarUrl = '';

  // Follower count: Strategy 1 - a[href*="followers"] span
  try {
    const text = await page.evaluate(() => {
      const els = document.querySelectorAll<HTMLElement>('a[href*="/followers"] span, a[href*="followers"] span');
      for (const el of els) {
        const t = el.getAttribute('title') || el.textContent || '';
        if (/\d/.test(t)) return t.trim();
      }
      return '';
    });
    if (text) followers = parseCompactNumber(text);
  } catch {}

  // Strategy 2: og:description
  if (followers === 0) {
    try {
      const og = await page.evaluate(() => {
        const m = document.querySelector('meta[property="og:description"]');
        return m?.getAttribute('content') || '';
      });
      if (og) {
        const m = og.match(/([\d,.]+[kKmM万]?)\s*[Ff]ollowers/);
        if (m) followers = parseCompactNumber(m[1]);
      }
    } catch {}
  }

  // Strategy 3: body text
  if (followers === 0) {
    try {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      const m = bodyText.match(/([\d,.]+\s*[kKmM万]?)\s*(?:followers|follower|粉丝|粉)/i);
      if (m) followers = parseCompactNumber(m[1]);
    } catch {}
  }

  // Display name & bio
  try {
    const info = await page.evaluate(() => {
      const nameEl = document.querySelector('header h2, header h1');
      const dName = nameEl?.textContent?.trim() || '';

      // Bio text
      const spans = document.querySelectorAll('header span, section span');
      let bioText = '';
      for (const s of spans) {
        const t = s.textContent?.trim() || '';
        if (t.length > 15 && !t.includes(' followers') && !t.includes(' following') && !t.includes(' posts')) {
          bioText = t;
          break;
        }
      }

      // Avatar
      const img = document.querySelector('header img[alt*="profile"], header img[alt*="photo"]');
      const avatar = (img as HTMLImageElement)?.src || '';

      return { dName, bioText, avatar };
    });
    displayName = info.dName;
    bio = info.bioText;
    avatarUrl = info.avatar;
  } catch {}

  // Extract website from bio
  try {
    website = await page.evaluate(() => {
      const links = document.querySelectorAll<HTMLAnchorElement>('header a[href], section a[href]');
      for (const a of links) {
        const h = a.href;
        if (h.startsWith('http') && !h.includes('instagram.com') && !h.includes('facebook.com') && !h.includes('twitter.com') && !h.includes('tiktok.com') && !h.includes('youtube.com') && !h.includes('wa.me') && !h.includes('line.me')) {
          return h;
        }
      }
      const spans = document.querySelectorAll('header span');
      for (const s of spans) {
        const t = s.textContent || '';
        const dm = t.match(/(?:https?:\/\/)?(?:www\.)?([\w-]+\.\w{2,})(?:\/\S*)?/);
        if (dm && !dm[1].includes('instagram')) return dm[0].startsWith('http') ? dm[0] : 'https://' + dm[0];
      }
      return '';
    });
  } catch {}

  // Collect post tiles with aggressive scroll
  const tileSelector = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
  const seen = new Set<string>();

  for (let attempt = 0; attempt < MAX_SCROLL_ATTEMPTS; attempt++) {
    const tiles = await page.locator(tileSelector).all().catch(() => []);
    for (const tile of tiles) {
      const href = await tile.getAttribute('href').catch(() => '');
      if (href) seen.add(href.startsWith('http') ? href : `https://www.instagram.com${href}`);
    }
    if (seen.size >= MAX_POSTS_PER_BRAND * 2) break;
    await page.mouse.wheel(0, 600 + attempt * 100);
    await page.waitForTimeout(jitter(1200, 2500));
  }

  return {
    followers, tileUrls: [...seen].slice(0, MAX_POSTS_PER_BRAND * 2),
    website, displayName, bio, avatarUrl,
  };
}

async function scrapePost(page: any, url: string, brand: string): Promise<{
  caption: string; likes: number; comments: number; views: number;
  imageUrl: string; postedAt: string; topComments: string[];
  engagementRate: number; isVideo: boolean;
}> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
  await page.waitForTimeout(jitter(1500, 2500));

  let caption = '', imageUrl = '', postedAt = '';
  let likes = 0, comments = 0, views = 0;
  let isVideo = false;
  const topComments: string[] = [];

  // Method 1: JSON script tags (most reliable)
  const jsonData = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    for (const s of scripts) {
      try {
        const d = JSON.parse(s.textContent || '{}');
        const str = JSON.stringify(d);
        const result: any = {};

        const capMatch = str.match(/"text":"((?:[^"\\]|\\.)*)"/);
        if (capMatch) result.caption = capMatch[1].replace(/\\n/g, '\n');

        result.likes = parseInt(str.match(/"count":(\d+),/)?.[1] || '0');
        result.comments = parseInt(str.match(/"comment_count":(\d+)/)?.[1] || '0');

        // Video views
        const vMatch = str.match(/"video_view_count":(\d+)/);
        if (vMatch) result.views = parseInt(vMatch[1]);

        // Image URL
        const imgMatch = str.match(/"display_url":"([^"]+)"/);
        if (imgMatch) result.imageUrl = imgMatch[1].replace(/\\u0026/g, '&');

        // Post time
        const timeMatch = str.match(/"taken_at_timestamp":(\d+)/);
        if (timeMatch) result.postedAt = new Date(parseInt(timeMatch[1]) * 1000).toISOString();

        // Is video
        if (str.includes('"is_video":true')) result.isVideo = true;

        // Comments - extract from edges
        const commentEdits = str.match(/"text":"((?:[^"\\]|\\.)*)","comment_like_count":/g);
        if (commentEdits) {
          result.topComments = commentEdits.slice(0, 20).map((c: string) => {
            const m = c.match(/"text":"((?:[^"\\]|\\.)*)"/);
            return m ? m[1].replace(/\\n/g, ' ') : '';
          }).filter(Boolean);
        }

        if (result.caption || result.likes) return result;
      } catch {}
    }
    return null;
  });

  if (jsonData) {
    caption = jsonData.caption || '';
    likes = jsonData.likes || 0;
    comments = jsonData.comments || 0;
    views = jsonData.views || 0;
    imageUrl = jsonData.imageUrl || '';
    postedAt = jsonData.postedAt || '';
    isVideo = jsonData.isVideo || false;
    if (jsonData.topComments) topComments.push(...jsonData.topComments);
  }

  // Method 2: meta tags for image (fallback)
  if (!imageUrl) {
    try {
      imageUrl = await page.evaluate(() => {
        const og = document.querySelector('meta[property="og:image"]');
        return og?.getAttribute('content') || '';
      });
    } catch {}
  }

  // Method 2b: visible img element
  if (!imageUrl) {
    try {
      imageUrl = await page.evaluate(() => {
        const imgs = document.querySelectorAll<HTMLImageElement>('article img[src*="cdninstagram"], main img[src*="cdninstagram"]');
        for (const img of imgs) {
          if (img.src && img.src.includes('cdninstagram')) return img.src;
        }
        return '';
      });
    } catch {}
  }

  // Method 2c: video poster
  if (!imageUrl && isVideo) {
    try {
      imageUrl = await page.evaluate(() => {
        const v = document.querySelector('video[poster]');
        return (v as HTMLVideoElement)?.poster || '';
      });
    } catch {}
  }

  // Method 3: visible DOM for caption (fallback)
  if (!caption) {
    try { caption = await page.locator('div[role="dialog"] ul > li').first().innerText().catch(() => ''); } catch {}
    if (!caption) { caption = await page.locator('article h1, h1').first().innerText().catch(() => ''); }
    if (!caption) { caption = await page.locator('span[dir="auto"]').first().innerText().catch(() => ''); }
  }

  // Post time from time element (fallback)
  if (!postedAt) {
    try {
      postedAt = await page.evaluate(() => {
        const t = document.querySelector('time[datetime]');
        return t?.getAttribute('datetime') || '';
      });
    } catch {}
  }

  // Likes/comments from body text (fallback)
  if (likes === 0 || comments === 0) {
    try {
      const txt = await page.locator('body').innerText().catch(() => '');
      const lm = txt.match(/([\d,.]+[kKmM]?)\s*(?:likes?|views?)/i);
      if (lm) likes = parseCompactNumber(lm[1]);
      const cm = txt.match(/([\d,.]+[kKmM]?)\s*comments?/i);
      if (cm) comments = parseCompactNumber(cm[1]);
    } catch {}
  }

  // Visible comments (fallback - scroll comment section)
  if (topComments.length === 0) {
    try {
      const visibleComments = await page.evaluate(() => {
        const items = document.querySelectorAll<HTMLElement>('ul[role="tablist"] li span, div[role="dialog"] ul li span');
        const texts: string[] = [];
        for (const item of items) {
          const t = item.innerText?.trim();
          if (t && t.length > 2 && t.length < 500) texts.push(t);
          if (texts.length >= 20) break;
        }
        return texts;
      });
      topComments.push(...visibleComments);
    } catch {}
  }

  caption = caption.replace(/\s+/g, ' ').trim().slice(0, 2000);

  return {
    caption, likes, comments, views,
    imageUrl, postedAt, topComments: topComments.slice(0, 20),
    engagementRate: 0, // Will be calculated after we know followers
    isVideo,
  };
}

async function main() {
  console.log('=== Brand Post Scraper (Enhanced) ===');
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Min followers: ${MIN_FOLLOWERS}`);
  console.log(`Max posts per brand: ${MAX_POSTS_PER_BRAND}`);

  // Load existing posts with dedup
  let existingPosts: any[] = [];
  if (fs.existsSync(OUTPUT)) {
    existingPosts = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    console.log(`Existing posts: ${existingPosts.length}`);
  }

  console.log('\nLaunching Chromium...');
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = browser.pages()[0] || await browser.newPage();
  page.setDefaultTimeout(10000);

  // Login check once
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('accounts/login') || page.url().includes('accounts/signup')) {
    console.log('⚠️  Not logged in! Please log in manually, then press Enter.');
    await new Promise<void>(resolve => { process.stdin.once('data', () => resolve()); });
    await page.waitForTimeout(3000);
  }
  console.log('Logged in!\n');

  const seenUrls = new Set(existingPosts.map((p: any) => p.postUrl).filter(Boolean));

  // Track stats
  const summary: Record<string, { ok: number; skip: number; fail: number }> = {};
  let totalNew = 0;

  for (const [category, brands] of Object.entries(TARGET_BRANDS) as [string, { handle: string; name: string }[]][]) {
    console.log(`\n═══════════════════════════════════════`);
    console.log(`  CATEGORY: ${category} (${brands.length} brands)`);
    console.log(`═══════════════════════════════════════`);
    summary[category] = { ok: 0, skip: 0, fail: 0 };

    for (const brand of brands) {
      process.stdout.write(`\n  @${brand.handle} ... `);

      // Scrape profile
      let profile;
      try {
        profile = await scrapeProfile(page, brand.handle);
      } catch (e: any) {
        console.log(`❌ ${e.message.slice(0, 60)}`);
        summary[category].fail++;
        continue;
      }

      process.stdout.write(`${profile.followers}粉, ${profile.tileUrls.length}帖 — `);

      if (profile.followers > 0 && profile.followers < MIN_FOLLOWERS) {
        console.log('⏭️  跳过(粉丝少)');
        summary[category].skip++;
        continue;
      }
      if (profile.tileUrls.length === 0) {
        console.log('⏭️  无帖子');
        summary[category].skip++;
        continue;
      }

      // Scrape posts
      let brandOk = 0;
      for (let i = 0; i < Math.min(profile.tileUrls.length, MAX_POSTS_PER_BRAND); i++) {
        const url = profile.tileUrls[i];
        if (seenUrls.has(url)) continue;

        try {
          const data = await scrapePost(page, url, brand.handle);

          if (data.caption && data.caption.length > 10) {
            const engagementRate = profile.followers > 0
              ? Math.round(((data.likes + data.comments) / profile.followers) * 10000) / 100
              : 0;

            const post = {
              brand: brand.handle,
              brandName: brand.name,
              content: data.caption,
              category,
              likes: data.likes,
              comments: data.comments,
              views: data.views,
              engagementRate,
              postUrl: url,
              imageUrl: data.imageUrl || '',
              postedAt: data.postedAt,
              topComments: data.topComments,
              isVideo: data.isVideo,
              scrapedAt: new Date().toISOString(),
            };

            existingPosts.push(post);
            seenUrls.add(url);
            brandOk++;
            totalNew++;
          }
        } catch {}
        await new Promise(r => setTimeout(r, jitter(1000, 2000)));
      }
      console.log(`✅ ${brandOk}条`);
      summary[category].ok += brandOk;

      // Save incrementally
      fs.writeFileSync(OUTPUT, JSON.stringify(existingPosts, null, 2), 'utf8');

      await new Promise(r => setTimeout(r, jitter(1000, 3000)));
    }
  }

  // Final save
  fs.writeFileSync(OUTPUT, JSON.stringify(existingPosts, null, 2), 'utf8');

  // Supply-bot compatible output
  const supplyBotFields = existingPosts.map((p: any) => ({
    brand: p.brand, content: p.content, category: p.category,
    postUrl: p.postUrl, comments: p.comments || 0,
    likes: p.likes || 0,
    engagementRate: p.engagementRate || 0,
    postedAt: p.postedAt || '',
    topComments: p.topComments || [],
    scrapedAt: p.scrapedAt,
  }));
  fs.writeFileSync(SUPPLY_BOT_OUTPUT, JSON.stringify(supplyBotFields, null, 2), 'utf8');

  console.log(`\n\n═══════════════════════════════════════`);
  console.log(`  DONE — Total: ${existingPosts.length} posts`);
  console.log(`  New this run: ${totalNew}`);
  console.log(`═══════════════════════════════════════`);
  for (const [cat, s] of Object.entries(summary)) {
    console.log(`  ${cat}: +${s.ok} new, ${s.skip} skipped, ${s.fail} failed`);
  }
  console.log(`\nSaved: ${OUTPUT}`);
  console.log(`Merged: ${SUPPLY_BOT_OUTPUT} (${supplyBotFields.length} posts)`);

  await browser.close();
}

main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
