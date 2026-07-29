/**
 * Deep competitor scraper v3 — 两阶段竞对内容采集
 *
 * 提取策略: DOM优先（profile stats + post URLs）+ 采样访问拿互动数据
 *           保证稳定性，不依赖JSON解析
 *
 * Phase 1: 快速筛选 → Content Efficiency Score（采样10条帖子）
 * Phase 2: 深度抓取（--phase2）→ top 50详情
 *
 * 用法:
 *   npx tsx scripts/_deep_competitor_scrape.ts
 *   npx tsx scripts/_deep_competitor_scrape.ts --phase2
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'child_process';

// ======================== CONFIG ========================
const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';
const OUTPUT = 'data/deep_competitor_data.json';
const CANDIDATES_OUTPUT = 'data/competitor_candidates.json';
const PHASE = process.argv.includes('--phase2') ? 2 : 1;
const P1_SCROLLS = 20;          // Phase 1 滚动次数
const P1_SAMPLE_SIZE = 8;       // 采样弹窗帖子数（用于算互动率）
const P2_MAX_DETAILS = 50;

// ======================== TARGETS ========================
const CLASS_A = [
  { handle: 'kwadron',              name: 'Kwadron',             cat: 'needles_cartridges', type: 'A_brand' },
  { handle: 'fkirons',              name: 'FK Irons',            cat: 'machines_pens',      type: 'A_brand' },
  { handle: 'bishoprotary',         name: 'Bishop Rotary',        cat: 'machines_pens',      type: 'A_brand' },
  { handle: 'cheyenne_tattooequipment', name: 'Cheyenne',         cat: 'needles_cartridges', type: 'A_brand' },
];
const CLASS_B = [
  { handle: 'bigwasp.official',     name: 'BigWasp',             cat: 'needles_cartridges', type: 'B_brand' },
  { handle: 'blackclaw',            name: 'Black Claw',          cat: 'needles_cartridges', type: 'B_brand' },
  { handle: 'tatsoul',              name: 'TATSoul',             cat: 'needles_cartridges', type: 'B_brand' },
  { handle: 'cnctattoo',            name: 'CNC Tattoo',          cat: 'needles_cartridges', type: 'B_brand' },
  { handle: 'magicmoon_tattoo_supply', name: 'Magic Moon',       cat: 'needles_cartridges', type: 'B_brand' },
  { handle: 'dragonhawkofficial',   name: 'Dragonhawk',          cat: 'machines_pens',      type: 'B_brand' },
  { handle: 'worldfamousink',       name: 'World Famous Ink',    cat: 'ink',                type: 'B_brand' },
  { handle: 'intenzetattooink',     name: 'Intenze Ink',         cat: 'ink',                type: 'B_brand' },
  { handle: 'eternalink',           name: 'Eternal Ink',         cat: 'ink',                type: 'B_brand' },
  { handle: 'inkjecta',             name: 'InkJecta',            cat: 'ink',                type: 'B_brand' },
  { handle: 'madrabbit',            name: 'Mad Rabbit',          cat: 'aftercare',          type: 'B_brand' },
  { handle: 'tattoogoo',            name: 'Tattoo Goo',          cat: 'aftercare',          type: 'B_brand' },
  { handle: 'hustlebutterdeluxe',   name: 'Hustle Butter',       cat: 'aftercare',          type: 'B_brand' },
  { handle: 'nissaco',              name: 'Nissaco',             cat: 'artist_fineline',    type: 'B_artist' },
  { handle: 'ryugotattoo',          name: 'Ryu Tattoo',          cat: 'artist_fineline',    type: 'B_artist' },
  { handle: 'sasha_unisex',         name: 'Sasha Unisex',        cat: 'artist_fineline',    type: 'B_artist' },
  { handle: 'benjamin_tattooist',   name: 'Benjamin',            cat: 'artist_blackwork',   type: 'B_artist' },
  { handle: 'lie_liangtattooer',    name: 'Lie Liang',           cat: 'artist_blackwork',   type: 'B_artist' },
  { handle: 'jondoom',              name: 'Jon Doom',            cat: 'artist_realism',     type: 'B_artist' },
  { handle: 'junior_tattooist',     name: 'Junior Tattooist',    cat: 'artist_realism',     type: 'B_artist' },
  { handle: 'horihiro_iii',         name: 'Horihiro III',        cat: 'artist_asian',       type: 'B_artist' },
  // { handle: 'ganjaking', name: 'Gakkin', cat: 'artist_asian', type: 'B_artist' }, // 非纹身号
];
const ALL = [...CLASS_A, ...CLASS_B];

// ======================== HELPERS ========================
function jitter(a: number, b: number) { return Math.floor(Math.random() * (b - a + 1)) + a; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function killBotChrome() {
  try {
    const out = execSync(`wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv`, { encoding: 'utf8', timeout: 8000 });
    for (const line of out.split('\n')) {
      if (!line.includes('bot_publish_01_chrome_data')) continue;
      const pid = line.trim().split(',').pop()?.trim();
      if (pid && /^\d+$/.test(pid)) try { execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8', timeout: 3000 }); } catch {}
    }
  } catch {}
}

function parseNum(s: string): number {
  s = String(s || '').trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  const w = s.match(/(\d+(?:\.\d+)?)\s*[万w]/); if (w) return Math.round(Number(w[1]) * 10000);
  const y = s.match(/(\d+(?:\.\d+)?)\s*亿/); if (y) return Math.round(Number(y[1]) * 100000000);
  const m = s.match(/(\d+(?:\.\d+)?)([kmb])?/); if (!m) return 0;
  const b = Number(m[1]), u = (m[2] || '').toLowerCase();
  if (u === 'k') return Math.round(b * 1000);
  if (u === 'm') return Math.round(b * 1000000);
  if (u === 'b') return Math.round(b * 1000000000);
  return Math.round(b);
}

function hts(c: string) {
  const m = c.match(/#[\w一-鿿]+/g);
  return m ? [...new Set(m.map(h => h.toLowerCase()))] : [];
}

// ======================== STEP 1: PROFILE FROM DOM ========================
async function scrapeProfile(page: any, handle: string) {
  const r: any = { followers: 0, following: 0, totalPosts: 0, bio: '', website: '', displayName: '', avatarUrl: '', succeeded: false };

  try {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('main', { state: 'visible', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(jitter(3000, 5000));

    const info = await page.evaluate(() => {
      const d: any = {};

      try {
        const body = document.body.innerText || '';
        const lines = body.split('\n').map(l => l.trim()).filter(Boolean);

        // Strategy 1: Look for number spans inside <a> tags containing 粉丝/关注/帖子
        for (const l of lines) {
          if (/[\d]/.test(l)) {
            if (l.includes('粉丝') || l.includes('follower')) d.followersLine = l;
            if (l.includes('关注') || l.includes('following')) d.followingLine = l;
            if (l.includes('帖子') || l.includes('posts')) d.postsLine = l;
          }
        }
      } catch {}

      // Fallback: og:description (always has all 3 numbers)
      if (!d.followersLine || !d.followingLine || !d.postsLine) {
        try {
          const og = document.querySelector('meta[property="og:description"]');
          const ogText = og?.getAttribute('content') || '';
          if (ogText && /\d/.test(ogText)) d.ogLine = ogText;
        } catch {}
      }

      // Display name
      try { const h1 = document.querySelector('h1, h2'); if (h1) d.displayName = h1.textContent?.trim() || ''; } catch {}

      // Bio
      try {
        const spans = document.querySelectorAll('span[dir="auto"]');
        for (const s of spans) {
          const t = s.textContent?.trim() || '';
          if (t.length > 15 && !t.includes(' followers') && !t.includes(' following') && !t.startsWith('@') && !t.startsWith('#') && !t.includes('粉丝') && !t.includes('帖子')) {
            d.bio = t.slice(0, 300); break;
          }
        }
      } catch {}

      // Website
      try {
        const links = document.querySelectorAll<HTMLAnchorElement>('a[href]');
        for (const a of links) {
          const h = a.href;
          if (h.startsWith('http') && !h.includes('instagram.com') && !h.startsWith('https://l.instagram') && !h.includes('threads.com')) {
            d.website = h; break;
          }
        }
      } catch {}

      // Avatar
      try {
        const imgs = document.querySelectorAll<HTMLImageElement>('img');
        for (const img of imgs) {
          if ((img.alt || '').toLowerCase().includes('profile') && img.src) { d.avatarUrl = img.src; break; }
        }
      } catch {}

      return d;
    });

    // Parse: try og:description first (cleanest format), then body lines
    if (info.ogLine) {
      // e.g., "212K 位粉丝、已关注 820 人、 5,071 篇帖子"
      const nums = info.ogLine.match(/[\d,]+[kKmM万]?/g) || [];
      if (nums.length >= 3) {
        r.followers = parseNum(nums[0]);
        r.following = parseNum(nums[1]);
        r.totalPosts = parseNum(nums[2]);
      }
    }

    // Fallback: individual body lines
    if (r.followers === 0 && info.followersLine) r.followers = parseNum(info.followersLine);
    if (r.following === 0 && info.followingLine) r.following = parseNum(info.followingLine);
    if (r.totalPosts === 0 && info.postsLine) r.totalPosts = parseNum(info.postsLine);

    if (info.displayName) r.displayName = info.displayName;
    if (info.bio) r.bio = info.bio;
    if (info.website) r.website = info.website;
    if (info.avatarUrl) r.avatarUrl = info.avatarUrl;
    r.succeeded = r.followers > 0 || info.displayName || info.bio;
  } catch (e: any) { console.log(`       ✗ ${e.message?.slice(0, 80)}`); }

  return r;
}

// ======================== STEP 2: COLLECT POST URLs ========================
async function collectPostUrls(page: any, minUrls: number, maxScrolls: number) {
  const seen = new Set<string>();

  for (let a = 0; a < maxScrolls; a++) {
    const urls = await page.evaluate(() => {
      const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]');
      return [...new Set([...links].map(a => {
        const h = a.href;
        return h.startsWith('http') ? h : `https://www.instagram.com${h}`;
      }))];
    });

    for (const u of urls) seen.add(u);
    if (seen.size >= minUrls) break;

    try { await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5)); }
    catch { await page.mouse.wheel(0, 500).catch(() => {}); }
    await sleep(jitter(800, 1500));
  }

  return [...seen];
}

// ======================== STEP 3: VISIT POST (used for sampling + Phase 2) ========================
async function clickPostAndReadDialog(page: any, tileSelector: string, tileIndex: number) {
  const r: any = { caption: '', likes: 0, comments: 0, views: 0, postedAt: '', isVideo: false, mediaUrl: '' };

  try {
    // Click tile to open dialog
    const tiles = page.locator(tileSelector);
    await tiles.nth(tileIndex).scrollIntoViewIfNeeded();
    await page.waitForTimeout(jitter(500, 1000));
    await tiles.nth(tileIndex).click({ timeout: 10000 });
    await page.waitForTimeout(jitter(1000, 2000));

    // Read dialog text
    const dialogText = await page.evaluate(() => {
      // Try dialog first, then article
      const dialog = document.querySelector('div[role="dialog"]');
      if (dialog) return (dialog as HTMLElement).innerText || '';
      const article = document.querySelector('article');
      if (article) return article.innerText || '';
      return '';
    });

    // Extract likes: "X 次赞" or "X likes" or just a number near "赞"
    const likeMatch = dialogText.match(/([\d,]+)\s*(?:次赞|次赞|likes?|赞)/i);
    if (likeMatch) r.likes = parseInt(likeMatch[1].replace(/,/g, ''));

    // Fallback: any large number near 赞
    if (!r.likes) {
      const fallback = dialogText.match(/(\d{2,})\s*次赞/i);
      if (fallback) r.likes = parseInt(fallback[1].replace(/,/g, ''));
    }

    // Comments: "view all X comments" or "X 条评论"
    const cmMatch = dialogText.match(/view all\s+(\d[\d,.]*)\s+comments?/i) ||
                    dialogText.match(/([\d,]+)\s*条评论/i);
    if (cmMatch) r.comments = parseInt(cmMatch[1].replace(/,/g, ''));

    // Views: "X 次播放" or "X views"
    const vMatch = dialogText.match(/([\d,]+)\s*(?:次播放|views?|plays?)/i);
    if (vMatch) r.views = parseInt(vMatch[1].replace(/,/g, ''));

    // Caption: first list item in dialog
    const capMatch = dialogText.match(/(?:^|\n)([^\n]{10,300}?)(?:\n|$)/);
    if (capMatch) r.caption = capMatch[1].trim().slice(0, 2000);

    // Time
    try {
      const dt = await page.locator('time').first().getAttribute('datetime').catch(() => null);
      if (dt) r.postedAt = dt;
    } catch {}

    // Media URL from the dialog image
    try {
      const imgSrc = await page.evaluate(() => {
        const img = document.querySelector('div[role="dialog"] img[src*="cdninstagram"], article img[src*="cdninstagram"]');
        return (img as HTMLImageElement)?.src || '';
      });
      if (imgSrc) r.mediaUrl = imgSrc;
    } catch {}

    // Detect video
    try {
      r.isVideo = await page.locator('div[role="dialog"] video, article video').count().then((c: number) => c > 0);
    } catch {}

    // Close dialog
    try {
      const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="关闭"]').first();
      if (await closeBtn.count() > 0) await closeBtn.click({ timeout: 5000 });
      else await page.keyboard.press('Escape');
    } catch { await page.keyboard.press('Escape').catch(() => {}); }
    await page.waitForTimeout(jitter(500, 1000));

  } catch {}
  r.hashtags = hts(r.caption);
  return r;
}

// ======================== MAIN ========================
async function main() {
  console.log(`=== Deep Competitor Intelligence v3 ===`);
  console.log(`Phase: ${PHASE === 1 ? '1 — 筛选（DOM+采样）' : '2 — 深度'}`);
  console.log(`Targets: ${ALL.length} accounts`);

  const dataFile = PHASE === 1 ? CANDIDATES_OUTPUT : OUTPUT;
  let existing: any[] = [];
  if (fs.existsSync(dataFile)) existing = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const doneHandles = new Set(existing.map((d: any) => d.handle));
  console.log(`Already done: ${doneHandles.size}/${ALL.length}\n`);

  // Cleanup
  console.log('Cleaning Chrome...');
  killBotChrome();
  await sleep(6000);
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const p = path.join(PROFILE_DIR, f);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  console.log('Launching Chromium...');
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  page.setDefaultTimeout(15000);

  // Login
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('login')) {
    console.log('⚠️  Login required. Login, then press Enter.');
    await new Promise<void>(r => { process.stdin.once('data', () => r()); });
    await page.waitForTimeout(3000);
  }
  console.log('Logged in!\n');

  let newCount = 0;

  for (const target of ALL) {
    if (doneHandles.has(target.handle)) { console.log(`  ⏭️  @${target.handle}`); continue; }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  [${target.type}] ${target.name} (@${target.handle})`);
    console.log(`  → Profile...`);

    const profile = await scrapeProfile(page, target.handle);
    if (!profile.succeeded) { console.log(`  ✗ Failed`); continue; }
    const fTxt = profile.followers >= 10000 ? `${(profile.followers / 10000).toFixed(1)}万` : `${profile.followers}`;
    console.log(`  👤 ${fTxt}粉 | ${profile.following}关注 | ${profile.totalPosts}帖`);

    if (profile.followers < 100) {
      console.log(`  ⚠️  <100 followers, likely wrong parse, skipping`);
      continue;
    }

    if (PHASE === 1) {
      // ── Phase 1: Scroll to load tiles, then sample via dialog clicks ──
      console.log(`  → Scrolling (${P1_SCROLLS}x) to load tiles...`);
      for (let s = 0; s < P1_SCROLLS; s++) {
        try { await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5)); }
        catch { await page.mouse.wheel(0, 500).catch(() => {}); }
        await sleep(jitter(600, 1200));
      }

      const tileSelector = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
      const sampleCount = Math.min(P1_SAMPLE_SIZE, await page.locator(tileSelector).count().catch(() => 0));
      console.log(`  🖼️  ${sampleCount} post tiles loaded`);

      if (sampleCount === 0) continue;

      let totalLikes = 0, totalComments = 0, totalViews = 0, postsWithData = 0;

      for (let i = 0; i < sampleCount; i++) {
        process.stdout.write(`  📝 [${i + 1}/${sampleCount}] tile ${i}... `);
        const post = await clickPostAndReadDialog(page, tileSelector, i);
        if (post.likes > 0 || post.comments > 0 || post.caption) {
          totalLikes += post.likes;
          totalComments += post.comments;
          if (post.views > 0) totalViews += post.views;
          postsWithData++;
          process.stdout.write(`❤️${post.likes} 💬${post.comments} 👁️${post.views}\n`);
        } else {
          process.stdout.write(`⏭️\n`);
        }
        await sleep(jitter(800, 1500));
      }

      // Calculate metrics (uses totalLikes/totalComments from dialog reads)
      const avgLikes = postsWithData > 0 ? Math.round(totalLikes / postsWithData) : 0;
      const avgComments = postsWithData > 0 ? Math.round(totalComments / postsWithData) : 0;
      const engagementRate = profile.followers > 0
        ? Math.round(((avgLikes + avgComments) / profile.followers) * 10000) / 100 : 0;
      const avgViews = totalViews > 0 && postsWithData > 0 ? Math.round(totalViews / postsWithData) : 0;
      const viewRate = profile.followers > 0 && avgViews > 0
        ? Math.round((avgViews / profile.followers) * 100) / 100 : 0;

      console.log(`  ──`);
      console.log(`  📊 Avg: ❤️${avgLikes} 💬${avgComments} 👁️${avgViews}`);
      console.log(`  📊 Efficiency: ER ${engagementRate}% | View/粉 ${viewRate}x`);
      console.log(`  📊 Sampled ${postsWithData}/${P1_SAMPLE_SIZE} posts`);

      existing.push({
        handle: target.handle, name: target.name, category: target.cat, type: target.type,
        followers: profile.followers, following: profile.following, totalPosts: profile.totalPosts,
        bio: profile.bio, website: profile.website, avatarUrl: profile.avatarUrl,
        avgEngagementRate: engagementRate, avgViewRate: viewRate,
        avgLikes, avgComments, avgViews,
        samplesCollected: postsWithData,
        scrapedAt: new Date().toISOString(),
      });

      fs.writeFileSync(dataFile, JSON.stringify(existing, null, 2), 'utf8');
      newCount++;
      console.log(`  ✅ Saved`);

    } else {
      // ── Phase 2: Deep scrape via dialog clicks ──
      console.log(`  → Scrolling to load tiles...`);
      for (let s = 0; s < 30; s++) {
        try { await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.5)); }
        catch { await page.mouse.wheel(0, 500).catch(() => {}); }
        await sleep(jitter(600, 1200));
      }

      const tileSelector = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
      console.log(`  → Phase 2: deep scrape via dialog...`);
      const totalTiles = await page.locator(tileSelector).count().catch(() => 0);
      const toVisit = Math.min(P2_MAX_DETAILS, totalTiles);
      console.log(`  🖼️  ${totalTiles} tiles, visiting ${toVisit}`);
      const posts: any[] = [];
      const tKeywords = ['setup','tutorial','how to','tip','guide','process','workflow','step','技巧','教程'];

      for (let i = 0; i < toVisit; i++) {
        process.stdout.write(`  [${i + 1}/${toVisit}] tile ${i}... `);
        const post = await clickPostAndReadDialog(page, tileSelector, i);
        if (post.likes > 0 || post.caption) {
          const er = profile.followers > 0 ? Math.round(((post.likes + post.comments) / profile.followers) * 10000) / 100 : 0;
          posts.push({
            postedAt: post.postedAt,
            postType: post.isVideo ? 'reel' : 'image',
            caption: post.caption,
            hashtags: post.hashtags,
            likes: post.likes, comments: post.comments, views: post.views,
            mediaUrl: post.mediaUrl,
            engagementRate: er,
            isTutorial: tKeywords.some(k => post.caption.toLowerCase().includes(k)),
            scrapedAt: new Date().toISOString(),
          });
          process.stdout.write(`❤️${post.likes} 💬${post.comments}\n`);
        } else { process.stdout.write(`⏭️\n`); }
      }

      existing.push({
        handle: target.handle, name: target.name, category: target.cat, type: target.type,
        followers: profile.followers, following: profile.following, totalPosts: profile.totalPosts,
        bio: profile.bio, website: profile.website, avatarUrl: profile.avatarUrl,
        totalScraped: totalTiles, posts, scrapedAt: new Date().toISOString(),
      });
      fs.writeFileSync(dataFile, JSON.stringify(existing, null, 2), 'utf8');
      newCount++;
      console.log(`  ✅ ${posts.length} posts saved`);
    }

    await sleep(jitter(2000, 3000));
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  DONE — ${newCount} new accounts`);

  if (PHASE === 1) {
    const ranked = existing.filter((d: any) => d.avgEngagementRate > 0 || d.avgLikes > 0)
      .sort((a: any, b: any) => (b.avgEngagementRate || 0) - (a.avgEngagementRate || 0));
    console.log(`\n  \u{1F4CA} ENGAGEMENT RANKING (by ER%)`);
    console.log(`  ${'─'.repeat(55)}`);
    console.log(`  # │ Account           │ ER%     │ Avg❤  │ 粉丝    │ 类型`);
    console.log(`  ${'─'.repeat(55)}`);
    ranked.forEach((d: any, i: number) => {
      console.log(`  ${(i + 1).toString().padStart(2)} │ ${(d.handle || '').padEnd(18).slice(0, 18)} │ ${(d.avgEngagementRate || 0).toFixed(2).padStart(6)}% │ ${(d.avgLikes || 0).toString().padStart(5)} │ ${(d.followers >= 10000 ? (d.followers / 10000).toFixed(1) + '万' : (d.followers || 0).toString()).padStart(7)} │ ${d.type}`);
    });
    console.log(`\n  \u{1F4CA} LIKES RANKING (by avg❤)`);
    const byLikes = [...ranked].sort((a: any, b: any) => (b.avgLikes || 0) - (a.avgLikes || 0));
    console.log(`  ${'─'.repeat(55)}`);
    console.log(`  # │ Account           │ Avg❤  │ ER%    │ 粉丝    │ 类型`);
    console.log(`  ${'─'.repeat(55)}`);
    byLikes.forEach((d: any, i: number) => {
      console.log(`  ${(i + 1).toString().padStart(2)} │ ${(d.handle || '').padEnd(18).slice(0, 18)} │ ${(d.avgLikes || 0).toString().padStart(5)} │ ${(d.avgEngagementRate || 0).toFixed(2).padStart(5)}% │ ${(d.followers >= 10000 ? (d.followers / 10000).toFixed(1) + '万' : (d.followers || 0).toString()).padStart(7)} │ ${d.type}`);
    });
    console.log(`\n  Run with --phase2 for deep scrape`);
  }

  await browser.close();
}

main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
