/**
 * Brand Comments Collector — 采集 tattoo supply 品牌在纹身师帖子下的评论
 *
 * 流程：
 *   1. 遍历纹身师列表，打开其帖子
 *   2. 提取所有评论
 *   3. 匹配品牌账号 → 保存品牌评论 + 上下文
 *   4. 分类
 *
 * 运行: npx tsx scripts/_brand_comments_scraper.ts
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

// ========== Tattoo Supply Brands (IG handles) ==========
const BRAND_HANDLES = new Set([
  // Major Supply Brands
  'fkirons',
  'cheyennetattoo',
  'kwadron',
  'worldfamousink',
  'stigmarotary',
  'bishoprotary',
  'eztattoosupply',
  'dynamiccolor',
  'intenzetattoo',
  'tatsoul',
  'silverbacktattoo',
  'eternalink',
  'fusiontattoo',
  'criticaltattoo',
  'workhorseirons',
  'neotat',
  'inkjet',
  'hustlebutter',
  'dragonhawktattoo',
  'masttattoo',
  'solongtattoo',
  'peachtattoosupplies',

  // Ink Brands
  'intenzetattooink',
  'solidink',
  'kurosumi_ink',
  'radiantcolorsink',
  'wickedink',
  'dermaglo',

  // Machine Brands
  'inkmachines_official',
  'hkmachines',
  'zeus_tattoo_machines',
  'valhailajr',
  'wand_tattoo',

  // Needle / Cartridge Brands
  'cartridges_tattoo',
  'empire_tattoo_supply',
  'bnbtattoo',
  'truetattoosupply',
  'painfulpleasures',
  'killertattoosupply',

  // Aftercare / Other
  'drmpickle',
  'tattoogoo',
  'a_derma_official',
  'madrabbit',
  'recoverytattoo',

  // EU Brands
  'tommys_supplies',
  'berlintattoosupply',
  'monstersupplies',
  'barberdtssupply',
  'tattoosupply24_7',
]);

// ========== Popular Tattoo Artists (IG handles) ==========
const TATTOO_ARTISTS = [
  // High-profile
  'dr_woo_ssc',
  'bangbangnyc',
  'mr_kotow',
  'tatu_baby',
  'nikkohurtado',
  'dragonfx',
  'romes_',
  'jondibo',
  'ondrash',
  'basel_tattoo',
  'gakkin_tattoo',
  'rro_g',
  'trampt',
  'jun_cha_mp',
  'sakura_tattoo',
  'pion_gangsta',
  'chris_rigoni',
  'steve_rojas_art',
  'david_cote',
  'mike_derycke',
  'thomas_hooper',
  'sailorjerry',
  'don_ed_hardy',
  'paul_booth',
  'grime_',

  // Contemporary
  'dmitriy_tattoo',
  'sasha_unisex',
  'tattoo_otzi',
  'joe_ellis_tattoo',
  'soeymilk',
  'joeyhamilton',
  'elise_morrison_tattoo',
  'katie_rose_tattoo',
  'kelly_gannon',
  'jacob_lee_tattoo',
  'bones_tattoo',
  'russ_abbott',
  'tom_rooke_tattoo',
  'dominick_holmes',
  'wil_salinas',
  'shadydave',
  'danny_derrick',
  'darren_brade',
  'boog_tattoo',
  'peter_aurisch',
  'steve_moore_tattoo',
  'alex_de_la_paz',
  'jime_litwalk',
  'matt_curzon',
  'davee_tattoo',
  'stefano_tattoo',
  'luca_tattoo',
  'frank_tattoo',
  'alberto_tattoo',
  'marcos_tattoo',
];

const DATA_FILE = 'data/brand_comments_dataset.json';

// ========== Categories ==========
const COMMENT_CATEGORIES = [
  'compliment_work',       // "Stunning work!" "Beautiful piece!"
  'product_mention',       // "This looks amazing with our cartridges!"
  'technique_question',    // "What needle config did you use?"
  'feature_request',       // "We'd love to feature this!"
  'artist_appreciation',   // "Love seeing what you create."
  'community_engagement',  // 🔥👏 short emoji reactions
  'educational_tip',       // "For fine lines, try our round liners."
  'collaboration',         // "Let's work together on a project!"
  'event_promo',           // "We'll be at Tattoo Expo this weekend!"
  'other',
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  compliment_work: ['beautiful', 'stunning', 'amazing', 'incredible', 'gorgeous', 'love this', 'clean work', 'solid', 'crisp', 'nice work', 'great work', 'fire', 'insane', 'perfect', 'dope', 'sick', 'killer work', 'flawless', 'masterpiece', 'wow', 'impressive'],
  product_mention: ['our', 'with our', 'using our', 'try our', 'cartridge', 'machine', 'needle', 'ink', 'supply', 'product', 'check out our'],
  technique_question: ['what', 'which', 'how did', 'needle', 'configuration', 'setup', 'voltage', 'stretch', 'pack'],
  feature_request: ['feature', 'share', 'republish', 'tag us', 'submit', 'showcase', 'highlight'],
  artist_appreciation: ['love seeing', 'always inspired', 'love what you', 'keep creating', 'your art', 'your work is'],
  community_engagement: ['🔥', '❤️', '💪', '👏', '🙌', '✨', '!!', '!'],
  educational_tip: ['pro tip', 'recommend', 'suggestion', 'try using', 'for best', 'tip:', 'advice'],
  collaboration: ['collab', 'let\'s', 'reach out', 'partner', 'work together'],
  event_promo: ['expo', 'convention', 'booth', 'seminar', 'workshop', 'come see'],
};

function categorizeComment(text: string): string {
  const lower = text.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    scores[cat] = kws.filter(k => lower.includes(k)).length;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : 'other';
}

// ========== Scraper ==========
type CollectedComment = {
  brand: string;
  artist: string;
  postCaption: string;
  comment: string;
  category: string;
  timestamp: string;
  postUrl: string;
  likeCount?: number;
  wordCount: number;
  hasEmoji: boolean;
};

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  // Load existing data
  let dataset: CollectedComment[] = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`Loaded ${dataset.length} existing comments`);
    } catch {}
  }

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  let totalFound = 0;
  let skipCount = 0;

  for (let ai = 0; ai < TATTOO_ARTISTS.length; ai++) {
    const artist = TATTOO_ARTISTS[ai];
    console.log(`\n[${ai + 1}/${TATTOO_ARTISTS.length}] Artist: @${artist}`);

    // Check if we already have enough data from this artist
    const existingFromArtist = dataset.filter(d => d.artist === artist).length;
    if (existingFromArtist >= 10) {
      console.log(`  Already have ${existingFromArtist} comments, skip`);
      skipCount++;
      continue;
    }

    try {
      // Go to artist profile
      await page.goto(`https://www.instagram.com/${artist}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await sleep(3000);

      // Get post links
      const posts = await page.$$('article a[href*="/p/"]');
      if (posts.length === 0) {
        // Try alternative selector
        const links = await page.$$eval('a[href*="/p/"]', els =>
          els.map(e => (e as HTMLAnchorElement).href).slice(0, 12)
        );
        if (links.length === 0) {
          console.log('  No posts found (maybe private or rate-limited)');
          continue;
        }
        // Visit each post
        for (const url of links) {
          const found = await scrapePostComments(page, url, artist, dataset);
          totalFound += found;
          await sleep(2000 + Math.random() * 2000);
        }
      } else {
        // Click on each post
        for (let pi = 0; pi < Math.min(posts.length, 12); pi++) {
          try {
            const href = await posts[pi].getAttribute('href');
            if (!href) continue;
            const url = `https://www.instagram.com${href}`;
            const found = await scrapePostComments(page, url, artist, dataset);
            totalFound += found;
            await sleep(2000 + Math.random() * 2000);
          } catch (err: any) {
            console.log(`  Error on post ${pi}: ${err.message?.slice(0, 60)}`);
          }
        }
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message?.slice(0, 80)}`);
      await sleep(5000);
    }

    // Save periodically
    if (totalFound > 0) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2), 'utf8');
      console.log(`  Saved. Total dataset: ${dataset.length}`);
    }

    await sleep(3000 + Math.random() * 3000);
  }

  // Stats
  console.log('\n=== Done ===');
  console.log(`Total found: ${totalFound}`);
  console.log(`Dataset size: ${dataset.length}`);
  const byCategory: Record<string, number> = {};
  for (const d of dataset) {
    byCategory[d.category] = (byCategory[d.category] || 0) + 1;
  }
  console.log('\nBy category:');
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log(`\nSkipped artists (already enough): ${skipCount}`);

  await page.close();
  await browser.disconnect();
}

async function scrapePostComments(
  page: any,
  postUrl: string,
  artist: string,
  dataset: CollectedComment[]
): Promise<number> {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Get post caption
    const caption = await page.$eval('h1', (el: any) => el.textContent || '').catch(() => '');

    // Scroll down to load comments
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);

    // Get all comments
    const comments = await page.$$eval('ul li span', (els: any[]) =>
      els.map(el => el.textContent || '')
    ).catch(() => []);

    let found = 0;
    const seen = new Set(dataset.map(d => d.comment));

    // Attempt to extract username + text pairs
    const commentElements = await page.$$('ul li').catch(() => []);
    for (const el of commentElements) {
      try {
        const text = await el.$eval('span', (s: any) => s.textContent || '').catch(() => '');
        if (!text || text.length < 3) continue;

        // Extract the username (first span is usually the username)
        const username = await el.$eval('a', (a: any) => a.textContent || '').catch(() => '');
        if (!username) continue;

        const handle = username.replace('@', '').toLowerCase().trim();

        // Check if it's a brand comment
        if (BRAND_HANDLES.has(handle)) {
          if (seen.has(text)) continue;
          seen.add(text);

          const category = categorizeComment(text);
          const entry: CollectedComment = {
            brand: handle,
            artist,
            postCaption: caption.slice(0, 200),
            comment: text,
            category,
            timestamp: new Date().toISOString(),
            postUrl,
            wordCount: text.split(/\s+/).length,
            hasEmoji: /[\u{1F300}-\u{1FAFF}]/u.test(text),
          };
          dataset.push(entry);
          found++;
          console.log(`  [${category}] @${handle}: "${text.slice(0, 80)}..."`);
        }
      } catch {}
    }

    if (found > 0) {
      console.log(`  Found ${found} brand comments on this post`);
    }
    return found;
  } catch (err: any) {
    console.log(`  Error on post: ${err.message?.slice(0, 60)}`);
    return 0;
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
