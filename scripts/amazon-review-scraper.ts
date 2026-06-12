/**
 * Amazon Review Scraper — 竞品差评抓取 + DeepSeek 主题提取
 *
 * 抓取竞品 ASIN 的 1-3 星评论，过滤噪音，提取产品差评主题入库 competitor_reviews。
 *
 * 用法: npx tsx scripts/amazon-review-scraper.ts
 *
 * ENV:
 *   AMAZON_ASINS=B0XXX,B0YYY        (逗号分隔的 ASIN 列表)
 *   AMAZON_MAX_PAGES=5              (每个 ASIN 最多翻页数，默认 3)
 *   AMAZON_MIN_STARS=1              (最低星级，默认 1)
 *   AMAZON_MAX_STARS=3              (最高星级，默认 3)
 *   AMAZON_OUTPUT=./data            (输出目录)
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');
const ASINS = (process.env.AMAZON_ASINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_PAGES = Math.max(1, Number(process.env.AMAZON_MAX_PAGES || 3));
const MIN_STARS = Math.max(1, Number(process.env.AMAZON_MIN_STARS || 1));
const MAX_STARS = Math.min(3, Number(process.env.AMAZON_MAX_STARS || 3));
const OUTPUT_DIR = process.env.AMAZON_OUTPUT || path.join(process.cwd(), 'data', 'amazon_reviews');

const AMAZON_DOMAIN = process.env.AMAZON_DOMAIN || 'www.amazon.com';
const AMAZON_BASE = `https://${AMAZON_DOMAIN}`;

// Tattoo supply competitor ASINs (pre-mapped)
// These are popular Amazon-listed tattoo supply products
const DEFAULT_ASINS: Record<string, string> = {
  // Dragonhawk machines
  'B0C1G6J5DT': 'Ambition Paco Wireless Tattoo Machine',
  'B099RPL364': 'Mast Tour Wireless Tattoo Pen Kit',
  'B07Y877SWW': 'Mast Tour Cordless Tattoo Pen Kit',
  // Aftercare
  'B0029K18XE': 'Tattoo Goo Aftercare Kit',
  'B0056G23ZU': 'Hustle Butter Deluxe',
  // Ink
  'B00E9ZGK3W': 'World Famous Tattoo Ink',
  'B07PFDS2JW': 'Dragonhawk Cartridge Needles',
};

// ---- Noise filters ----
const NOISE_PATTERNS = {
  shipping: /\b(shipping|delivery|arrived? late|took.*(week|day|month)|lost.*package|damaged.*box|packaging)\b/i,
  seller: /\b(seller|customer.?service|refund|return.?policy|wrong.*item)\b/i,
  irrelevant: /\b(gift|birthday|christmas|anniversary)\b/i,
  shortNoise: /^(ok|nice|good|bad|fine|ye[s]?|no|nah|meh|.)$/i,
  emojiOnly: /^[\s\p{Emoji}‍]+$/u,
};

const isNoise = (text: string): { noisy: boolean; reason: string } => {
  if (!text || text.length < 30) return { noisy: true, reason: 'too_short' };
  if (NOISE_PATTERNS.emojiOnly.test(text)) return { noisy: true, reason: 'emoji_only' };
  if (NOISE_PATTERNS.shortNoise.test(text.trim())) return { noisy: true, reason: 'no_substance' };
  if (NOISE_PATTERNS.shipping.test(text) && !/quality|broke|leak|fade|dull|performance/i.test(text))
    return { noisy: true, reason: 'shipping_only' };
  if (NOISE_PATTERNS.seller.test(text) && !/product|quality|item.*defect/i.test(text))
    return { noisy: true, reason: 'seller_service_only' };
  if (NOISE_PATTERNS.irrelevant.test(text) && !/tattoo|machine|needle|ink|aftercare/i.test(text))
    return { noisy: true, reason: 'gift_context' };
  return { noisy: false, reason: '' };
};

// ---- Types ----
interface AmazonReview {
  asin: string;
  productName: string;
  reviewerName: string;
  rating: number;
  title: string;
  text: string;
  date: string;
  verified: boolean;
  helpfulCount: number;
  url: string;
}

// ---- Scraper ----
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

const scrapeReviewsForAsin = async (asin: string, productName: string): Promise<AmazonReview[]> => {
  const reviews: AmazonReview[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const starFilter = `&filterByStar=${MIN_STARS === 1 && MAX_STARS === 3 ? 'critical' : 'one_star'}`;
    const url = `${AMAZON_BASE}/product-reviews/${asin}/ref=cm_cr_arp_d_paging_btm_${page}?ie=UTF8&reviewerType=all_reviews${starFilter}&pageNumber=${page}&sortBy=recent`;
    try {
      const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      const resp = await fetch(url, {
        headers: {
          'User-Agent': ua,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });
      if (!resp.ok) {
        console.warn(`  [amazon] ${asin} page ${page} HTTP ${resp.status}`);
        if (resp.status === 503 || resp.status === 429) break; // blocked
        continue;
      }
      const html = await resp.text();

      // Parse reviews from HTML using regex (avoid Cheerio dependency)
      const reviewBlocks = html.split(/data-hook="review"/g).slice(1);
      if (!reviewBlocks.length) break; // no more reviews

      for (const block of reviewBlocks) {
        try {
          const ratingMatch = block.match(/(\d+\.?\d*) out of 5/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;
          if (rating < MIN_STARS || rating > MAX_STARS) continue;

          const titleMatch = block.match(/data-hook="review-title"[^>]*>([^<]+)/);
          const title = titleMatch ? titleMatch[1].trim() : '';

          const textMatch = block.match(/data-hook="review-body"[^>]*>([\s\S]*?)<\/span>/);
          const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          const authorMatch = block.match(/class="a-profile-name"[^>]*>([^<]+)/);
          const reviewerName = authorMatch ? authorMatch[1].trim() : 'anonymous';

          const dateMatch = block.match(/data-hook="review-date"[^>]*>([^<]+)/);
          const date = dateMatch ? dateMatch[1].trim() : '';

          const verified = block.includes('avp-badge') || block.includes('Verified Purchase');

          const helpfulMatch = block.match(/(\d+)\s+people found this helpful/);
          const helpfulCount = helpfulMatch ? parseInt(helpfulMatch[1]) : 0;

          const { noisy, reason } = isNoise(text);
          if (noisy) {
            console.log(`  [amazon] filtered: "${text.slice(0, 60)}..." (${reason})`);
            continue;
          }

          reviews.push({
            asin, productName, reviewerName, rating,
            title, text, date, verified, helpfulCount,
            url: `${AMAZON_BASE}/gp/customer-reviews/${asin}/`,
          });
        } catch { continue; }
      }
      console.log(`  [amazon] ${asin} page ${page}: ${reviewBlocks.length} blocks → ${reviews.length} valid reviews`);
      await sleep(2000 + Math.random() * 4000); // polite delay
    } catch (e: any) {
      console.warn(`  [amazon] ${asin} page ${page} error: ${e.message}`);
      break;
    }
  }
  return reviews;
};

// ---- DeepSeek Analysis ----
const analyzeReviews = async (reviews: AmazonReview[]): Promise<any[]> => {
  if (!reviews.length || !DEEPSEEK_API_KEY) return [];
  // Batch: 10 reviews per API call
  const results: any[] = [];
  for (let i = 0; i < reviews.length; i += 10) {
    const batch = reviews.slice(i, i + 10);
    const reviewTexts = batch.map((r, j) =>
      `[${i + j}] Rating: ${r.rating}/5 | Verified: ${r.verified ? 'yes' : 'no'} | "${r.title}": ${r.text.slice(0, 400)}`
    ).join('\n');

    try {
      const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{
            role: 'user',
            content: `You are analyzing Amazon reviews for tattoo supply products. For each review, extract product defects, quality issues, and specific complaints. Ignore shipping/delivery/service complaints — focus ONLY on the PRODUCT itself.

For each review, return:
- index: the review number
- is_product_issue: true ONLY if complaint is about product quality/defect/performance/durability/design (NOT shipping/service/price)
- product_name: specific product mentioned (if any)
- defect_type: "quality" | "durability" | "performance" | "design" | "compatibility" | "safety" | "missing_parts" | "false_advertising" | "other"
- severity: "high" (broken/unusable) | "medium" (significant flaw) | "low" (minor annoyance)
- summary: one-sentence summary of the product issue
- themes: array of keywords (e.g., ["motor_failure", "battery_life", "ink_fading"])

Return JSON array. Only include reviews where is_product_issue is true.\n\nReviews:\n${reviewTexts}`
          }],
          temperature: 0.1, max_tokens: 2000,
        }),
      });
      if (!resp.ok) { await sleep(2000); continue; }
      const data: any = await resp.json();
      const raw = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) results.push(...parsed);
      } catch {}
    } catch {}
    await sleep(1500);
  }
  return results;
};

// ---- Storage ----
const storeReviews = (reviews: AmazonReview[], analysis: any[]) => {
  const db = new Database(DB_PATH);
  try {
    const insertReview = db.prepare(`
      INSERT INTO competitor_reviews (product_name, source, source_url, reviewer_name, rating, review_text, sentiment, key_themes, reviewed_at, scraped_at)
      VALUES (?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAlert = db.prepare(`
      INSERT INTO competitor_alerts (brand_name, alert_type, title, details, source_url, created_at)
      VALUES (?, 'amazon_review', ?, ?, ?, ?)
    `);
    const now = Date.now();

    for (const a of analysis) {
      const idx = Number(a.index);
      const review = reviews[idx];
      if (!review || !a.is_product_issue) continue;

      insertReview.run(
        review.productName,
        review.url,
        review.reviewerName,
        review.rating,
        review.text,
        'negative',
        JSON.stringify(a.themes || []),
        review.date,
        now
      );

      // Alert for high-severity issues
      if (a.severity === 'high' || a.severity === 'medium') {
        insertAlert.run(
          review.productName,
          `[${review.rating}/5] ${a.defect_type}: ${a.summary || review.title}`,
          `${review.text.slice(0, 300)} | Themes: ${(a.themes || []).join(', ')}`,
          review.url,
          now
        );
      }
    }
    console.log(`  [amazon] stored ${analysis.filter((a: any) => a.is_product_issue).length} product issues → competitor_reviews`);
  } finally {
    db.close();
  }
};

// ---- Main ----
const main = async () => {
  const targetAsins = ASINS.length > 0
    ? Object.fromEntries(ASINS.map(a => [a, a]))
    : DEFAULT_ASINS;

  console.log('╔══════════════════════════════════════╗');
  console.log('║  Amazon Review Scraper              ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  ASINs: ${Object.keys(targetAsins).length} | Pages: ${MAX_PAGES} | Stars: ${MIN_STARS}-${MAX_STARS}`);
  console.log(`  Filters: min 30 chars, no shipping-only, no emoji-only, product keywords required\n`);

  const allReviews: AmazonReview[] = [];
  for (const [asin, name] of Object.entries(targetAsins)) {
    console.log(`[amazon] Scraping ${asin} — ${name}...`);
    const reviews = await scrapeReviewsForAsin(asin, name);
    console.log(`  → ${reviews.length} valid reviews after noise filtering`);
    allReviews.push(...reviews);
  }

  console.log(`\n[amazon] Total: ${allReviews.length} reviews across ${Object.keys(targetAsins).length} products`);

  if (allReviews.length > 0 && DEEPSEEK_API_KEY) {
    console.log('[amazon] Running DeepSeek analysis...');
    const analysis = await analyzeReviews(allReviews);
    console.log(`[amazon] Analysis: ${analysis.length} product issues identified`);
    storeReviews(allReviews, analysis);
  }

  // Save raw reviews
  const outDir = path.join(OUTPUT_DIR);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `amazon_reviews_${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ scrapedAt: new Date().toISOString(), reviews: allReviews }, null, 2), 'utf8');
  console.log(`\n✅ Reviews saved: ${outFile}`);
};

main().catch(e => {
  console.error('[amazon-review-scraper] Fatal:', e?.message || e);
  process.exit(1);
});
