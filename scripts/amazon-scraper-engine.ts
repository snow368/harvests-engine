/**
 * Amazon Scraper Engine v2 — 产品搜索 + 全星级评论抓取 + 多站点
 *
 * 双模式:
 *   - HTTP mode: 用 fetch + 正则解析 (快，无浏览器依赖)
 *   - Playwright mode: 用浏览器抓 (稳，抗封，更多字段)
 *
 * 用法:
 *   import { searchProducts, scrapeReviews } from './amazon-scraper-engine';
 *
 *   // 搜索产品
 *   const products = await searchProducts('tattoo machine wireless', { domain: 'www.amazon.com' });
 *
 *   // 抓评论
 *   const reviews = await scrapeReviews('B0C1G6J5DT', {
 *     productName: 'Ambition Paco',
 *     minStars: 1, maxStars: 5,
 *     maxPages: 5,
 *     domains: ['www.amazon.com', 'www.amazon.co.uk', 'www.amazon.de'],
 *   });
 */

// ── Types ──
export interface AmazonProduct {
  asin: string;
  title: string;
  price: string;
  currency: string;
  rating: number;
  reviewCount: number;
  imageUrl: string;
  productUrl: string;
  domain: string;
  category?: string;
}

export interface AmazonReview {
  asin: string;
  productTitle: string;
  domain: string;
  reviewerName: string;
  reviewerUrl: string;
  rating: number;
  title: string;
  text: string;
  date: string;
  verified: boolean;
  helpfulCount: number;
  images: string[];
  reviewUrl: string;
}

export interface ScraperOptions {
  /** Playwright browser instance (optional — uses HTTP mode if absent) */
  browser?: any;
  /** Amazon domain, default www.amazon.com */
  domain?: string;
  /** Request delay in ms (default 2000-4000) */
  delay?: { min: number; max: number };
  /** Log callback */
  log?: (msg: string) => void;
}

export interface ReviewScrapeOptions extends ScraperOptions {
  productName?: string;
  minStars?: number;
  maxStars?: number;
  maxPages?: number;
  /** Array of domains to scrape (e.g. ['.com', '.co.uk', '.de']) */
  domains?: string[];
}

// ── Helpers ──
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

function randUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay(opts?: ScraperOptions): Promise<void> {
  const min = opts?.delay?.min ?? 2000;
  const max = opts?.delay?.max ?? 4000;
  return sleep(min + Math.random() * (max - min));
}

function log(msg: string, opts?: ScraperOptions) {
  const fn = opts?.log ?? console.log;
  fn(`[amazon] ${msg}`);
}

function buildDomainUrl(domain: string): string {
  return `https://${domain}`;
}

// ── Amazon Product Search (Playwright) ──

/**
 * 在 Amazon 上按关键词搜索产品，返回产品列表
 * 需要 Playwright browser 实例
 */
export async function searchProducts(
  keyword: string,
  opts: ScraperOptions & { maxResults?: number } = {}
): Promise<AmazonProduct[]> {
  const domain = opts.domain || 'www.amazon.com';
  const baseUrl = buildDomainUrl(domain);
  const maxResults = opts.maxResults || 20;
  const results: AmazonProduct[] = [];

  if (!opts.browser) {
    log(`Search requires Playwright browser — use browser option`, opts);
    return results;
  }

  const context = opts.browser.contexts()[0] || await opts.browser.newContext();
  const page = await context.newPage();

  try {
    const searchUrl = `${baseUrl}/s?k=${encodeURIComponent(keyword)}&ref=nb_sb_noss`;
    log(`Searching: ${searchUrl}`, opts);

    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for results to load
    try {
      await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 10000 });
    } catch {
      // Try alternative selectors
      try {
        await page.waitForSelector('.s-result-item', { timeout: 5000 });
      } catch {
        log(`No search results found for "${keyword}"`, opts);
        return results;
      }
    }

    const items = await page.evaluate((max: number) => {
      const products: any[] = [];
      const cards = document.querySelectorAll('[data-component-type="s-search-result"], .s-result-item');

      for (const card of cards) {
        if (products.length >= max) break;

        const asinEl = card.querySelector('[data-asin]');
        const asin = asinEl?.getAttribute('data-asin');
        if (!asin || asin === '') continue;

        const titleEl = card.querySelector('h2 a, h2 span, .a-text-normal');
        const title = titleEl?.textContent?.trim() || '';

        const priceWhole = card.querySelector('.a-price-whole');
        const priceFraction = card.querySelector('.a-price-fraction');
        const priceSymbol = card.querySelector('.a-price-symbol');
        let price = '';
        if (priceWhole) {
          price = (priceSymbol?.textContent || '$') + priceWhole.textContent;
          if (priceFraction) price += priceFraction.textContent;
        }

        const ratingEl = card.querySelector('.a-star-small .a-icon-alt, i.a-star-small .a-icon-alt, .a-star-4');
        const ratingText = ratingEl?.textContent?.match(/(\d+\.?\d*)/);
        const rating = ratingText ? parseFloat(ratingText[1]) : 0;

        const countEl = card.querySelector('[data-csa-c-func-deps="aui-da-a-popover"] ~ span, .a-size-small .a-link-normal, .s-link-style .a-size-small');
        const countText = countEl?.textContent?.replace(/[^0-9]/g, '');
        const reviewCount = countText ? parseInt(countText) : 0;

        const imgEl = card.querySelector('img.s-image');
        const imageUrl = imgEl?.getAttribute('src') || '';

        const linkEl = card.querySelector('h2 a.a-link-normal');
        const href = linkEl?.getAttribute('href') || '';
        const productUrl = href.startsWith('http') ? href : `https://www.amazon.com${href}`;

        // Extract category from breadcrumbs if available
        const catEl = card.querySelector('.a-color-secondary .a-size-base');
        const category = catEl?.textContent?.trim() || '';

        products.push({ asin, title, price, rating, reviewCount, imageUrl, productUrl, category });
      }
      return products;
    }, maxResults);

    results.push(...items.map((p: any) => ({
      ...p,
      domain,
      currency: 'USD',
      productUrl: p.productUrl || `${baseUrl}/dp/${p.asin}`,
    })));

    log(`Found ${results.length} products for "${keyword}"`, opts);
  } catch (e: any) {
    log(`Search error: ${e.message}`, opts);
  } finally {
    await page.close().catch(() => {});
  }

  return results;
}

// ── HTTP-based Review Scraper (fast, no browser) ──

async function scrapeReviewsHttp(
  asin: string,
  productTitle: string,
  domain: string,
  opts: ReviewScrapeOptions
): Promise<AmazonReview[]> {
  const baseUrl = buildDomainUrl(domain);
  const minStars = opts.minStars ?? 1;
  const maxStars = opts.maxStars ?? 5;
  const maxPages = opts.maxPages ?? 3;
  const reviews: AmazonReview[] = [];

  for (let page = 1; page <= maxPages; page++) {
    // Build star filter param
    let starFilter = '';
    if (minStars === 1 && maxStars === 5) {
      starFilter = '&filterByStar=all_stars';
    } else if (minStars >= 4) {
      starFilter = '&filterByStar=four_star';
    } else if (minStars >= 3) {
      starFilter = '&filterByStar=three_star';
    } else if (minStars >= 2) {
      starFilter = '&filterByStar=two_star';
    } else {
      starFilter = '&filterByStar=critical';
    }

    const url = `${baseUrl}/product-reviews/${asin}/ref=cm_cr_arp_d_paging_btm_${page}?ie=UTF8&reviewerType=all_reviews${starFilter}&pageNumber=${page}&sortBy=recent`;

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': randUA(),
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });

      if (!resp.ok) {
        log(`  HTTP ${resp.status} for ${asin} page ${page}`, opts);
        if (resp.status === 503 || resp.status === 429) break;
        continue;
      }

      const html = await resp.text();

      // Parse with regex
      const reviewBlocks = html.split(/data-hook="review"/g).slice(1);
      if (!reviewBlocks.length) {
        // Fallback: try alternative parsing
        const altBlocks = html.split(/<div[^>]*id="customer_review[^"]*"[^>]*>/g).slice(1);
        if (!altBlocks.length) {
          log(`  No review blocks found on page ${page}`, opts);
          break;
        }
        for (const block of altBlocks) {
          const review = parseReviewBlockAlt(block, asin, productTitle, domain, baseUrl);
          if (review && review.rating >= minStars && review.rating <= maxStars) {
            reviews.push(review);
          }
        }
      } else {
        for (const block of reviewBlocks) {
          const review = parseReviewBlock(block, asin, productTitle, domain, baseUrl);
          if (review && review.rating >= minStars && review.rating <= maxStars) {
            reviews.push(review);
          }
        }
      }

      log(`  page ${page}: ${reviews.length} valid reviews so far`, opts);
      await sleep(2000 + Math.random() * 3000); // polite delay
    } catch (e: any) {
      log(`  Error page ${page}: ${e.message}`, opts);
      break;
    }
  }

  return reviews;
}

function parseReviewBlock(block: string, asin: string, productTitle: string, domain: string, baseUrl: string): AmazonReview | null {
  try {
    const ratingMatch = block.match(/(\d+\.?\d*) out of 5/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;
    if (!rating) return null;

    const titleMatch = block.match(/data-hook="review-title"[^>]*>([^<]+)/);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const textMatch = block.match(/data-hook="review-body"[^>]*>([\s\S]*?)<\/span>/);
    const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    if (!text || text.length < 20) return null;

    const authorMatch = block.match(/class="a-profile-name"[^>]*>([^<]+)/);
    const reviewerName = authorMatch ? authorMatch[1].trim() : 'anonymous';

    const dateMatch = block.match(/data-hook="review-date"[^>]*>([^<]+)/);
    const date = dateMatch ? dateMatch[1].trim() : '';

    const verified = block.includes('avp-badge') || block.includes('Verified Purchase');

    const helpfulMatch = block.match(/(\d+)\s+people found this helpful/);
    const helpfulCount = helpfulMatch ? parseInt(helpfulMatch[1]) : 0;

    // Extract images
    const images: string[] = [];
    const imgRegex = /data-hook="review-image"[^>]*src="([^"]+)"/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(block)) !== null) {
      if (imgMatch[1]) images.push(imgMatch[1]);
    }
    // Fallback image extraction
    if (!images.length) {
      const altImgRegex = /<img[^>]+class="review-image"[^>]+src="([^"]+)"/g;
      while ((imgMatch = altImgRegex.exec(block)) !== null) {
        if (imgMatch[1]) images.push(imgMatch[1]);
      }
    }

    // Reviewer URL
    const reviewerUrlMatch = block.match(/href="(\/gp\/profile\/[^"]+)"/);
    const reviewerUrl = reviewerUrlMatch ? `${baseUrl}${reviewerUrlMatch[1]}` : '';

    return {
      asin, productTitle, domain, reviewerName, reviewerUrl,
      rating, title, text, date, verified, helpfulCount, images,
      reviewUrl: `${baseUrl}/gp/customer-reviews/${asin}/`,
    };
  } catch {
    return null;
  }
}

function parseReviewBlockAlt(block: string, asin: string, productTitle: string, domain: string, baseUrl: string): AmazonReview | null {
  try {
    const ratingMatch = block.match(/class="a-star-[^"]*"[^>]*>([^<]+)/);
    const ratingText = ratingMatch ? ratingMatch[1].match(/(\d+\.?\d*)/) : null;
    const rating = ratingText ? parseFloat(ratingText[1]) : 0;
    if (!rating) return null;

    const titleMatch = block.match(/<a[^>]*class="review-title"[^>]*>([^<]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const textMatch = block.match(/<span[^>]*class="review-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const text = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    if (!text || text.length < 20) return null;

    const authorMatch = block.match(/<span[^>]*class="a-profile-name"[^>]*>([^<]+)/);
    const reviewerName = authorMatch ? authorMatch[1].trim() : 'anonymous';

    const dateMatch = block.match(/<span[^>]*class="review-date"[^>]*>([^<]+)/i);
    const date = dateMatch ? dateMatch[1].trim() : '';

    const verified = block.includes('Verified Purchase') || block.includes('avp-badge');

    const helpfulMatch = block.match(/(\d+)\s+(person|people)\s+found\s+this\s+helpful/i);
    const helpfulCount = helpfulMatch ? parseInt(helpfulMatch[1]) : 0;

    return {
      asin, productTitle, domain, reviewerName, reviewerUrl: '',
      rating, title, text, date, verified, helpfulCount, images: [],
      reviewUrl: `${baseUrl}/gp/customer-reviews/${asin}/`,
    };
  } catch {
    return null;
  }
}

// ── Playwright-based Review Scraper (more reliable, more fields) ──

async function scrapeReviewsPlaywright(
  asin: string,
  productTitle: string,
  domain: string,
  opts: ReviewScrapeOptions
): Promise<AmazonReview[]> {
  const baseUrl = buildDomainUrl(domain);
  const minStars = opts.minStars ?? 1;
  const maxStars = opts.maxStars ?? 5;
  const maxPages = opts.maxPages ?? 5;
  const reviews: AmazonReview[] = [];

  if (!opts.browser) {
    log(`Playwright mode requires browser instance`, opts);
    return reviews;
  }

  const context = opts.browser.contexts()[0] || await opts.browser.newContext();
  const page = await context.newPage();

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewportSize({ width: 1920, height: 1080 });

    for (let pg = 1; pg <= maxPages; pg++) {
      const url = `${baseUrl}/product-reviews/${asin}/ref=cm_cr_arp_d_paging_btm_${pg}?ie=UTF8&reviewerType=all_reviews&pageNumber=${pg}&sortBy=recent`;

      log(`  PW page ${pg}: ${url}`, opts);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      try {
        await page.waitForSelector('[data-hook="review"], .review', { timeout: 8000 });
      } catch {
        log(`  No reviews found on page ${pg}`, opts);
        break;
      }

      const pageReviews = await page.evaluate((minR, maxR, base, asin, pTitle, dom) => {
        const results: any[] = [];
        const blocks = document.querySelectorAll('[data-hook="review"], .review, [id^="customer_review"]');

        for (const block of blocks) {
          try {
            // Rating
            const ratingEl = block.querySelector('[data-hook="rating-out-of-text"], i.a-icon-star, .a-star-4, .a-star-5, .a-star-3');
            const ratingText = ratingEl?.textContent?.match(/(\d+\.?\d*)/);
            const rating = ratingText ? parseFloat(ratingText[1]) : 0;
            if (!rating || rating < minR || rating > maxR) continue;

            // Title
            const titleEl = block.querySelector('[data-hook="review-title"]');
            const title = titleEl?.textContent?.trim() || '';

            // Body text
            const textEl = block.querySelector('[data-hook="review-body"] span, .review-text');
            const text = textEl?.textContent?.trim() || '';
            if (text.length < 10) continue;

            // Author
            const authorEl = block.querySelector('.a-profile-name');
            const author = authorEl?.textContent?.trim() || 'anonymous';

            // Date
            const dateEl = block.querySelector('[data-hook="review-date"]');
            const date = dateEl?.textContent?.trim() || '';

            // Verified
            const verified = block.innerHTML.includes('avp-badge') || block.textContent?.includes('Verified Purchase') || false;

            // Helpful
            const helpfulEl = block.querySelector('[data-hook="helpful-vote-statement"]');
            const helpfulText = helpfulEl?.textContent?.match(/(\d+)/);
            const helpful = helpfulText ? parseInt(helpfulText[1]) : 0;

            // Images
            const images: string[] = [];
            block.querySelectorAll('[data-hook="review-image-tile"] img, .review-image img').forEach(img => {
              const src = img.getAttribute('src');
              if (src) images.push(src);
            });

            // Reviewer profile link
            const profileEl = block.querySelector('a.a-profile');
            const profileHref = profileEl?.getAttribute('href') || '';

            results.push({
              asin, productTitle: pTitle, domain: dom,
              reviewerName: author,
              reviewerUrl: profileHref ? `${base}${profileHref.startsWith('/') ? profileHref : '/' + profileHref}` : '',
              rating, title, text, date, verified,
              helpfulCount: helpful,
              images,
              reviewUrl: `${base}/gp/customer-reviews/${asin}/`,
            });
          } catch {}
        }
        return results;
      }, minStars, maxStars, baseUrl, asin, productTitle, domain);

      reviews.push(...pageReviews);
      log(`  PW page ${pg}: ${pageReviews.length} reviews (total ${reviews.length})`, opts);

      // Check for next page
      try {
        const nextBtn = await page.$('.a-pagination .a-last:not(.a-disabled) a');
        if (!nextBtn) break;
      } catch {
        break;
      }

      await sleep(3000 + Math.random() * 4000);
    }
  } catch (e: any) {
    log(`  PW error: ${e.message}`, opts);
  } finally {
    await page.close().catch(() => {});
  }

  return reviews;
}

// ── Noise filtering (from v1) ──

const NOISE_PATTERNS = {
  shipping: /\b(shipping|delivery|arrived? late|took.*(week|day|month)|lost.*package|damaged.*box|packaging)\b/i,
  seller: /\b(seller|customer.?service|refund|return.?policy|wrong.*item)\b/i,
  irrelevant: /\b(gift|birthday|christmas|anniversary)\b/i,
  shortNoise: /^(ok|nice|good|bad|fine|ye[s]?|no|nah|meh|great|awesome|love it|hate it|terrible|awful|perfect|amazing)$/i,
  emojiOnly: /^[\s\p{Emoji}‍]+$/u,
};

export function isNoiseReview(text: string): { noisy: boolean; reason: string } {
  if (!text || text.length < 20) return { noisy: true, reason: 'too_short' };
  if (NOISE_PATTERNS.emojiOnly.test(text)) return { noisy: true, reason: 'emoji_only' };
  if (NOISE_PATTERNS.shortNoise.test(text.trim())) return { noisy: true, reason: 'no_substance' };
  const hasProductContent = /quality|broke|leak|fade|dull|performance|work|issue|problem|defect|great|love|amazing|perfect|easy|use|product|item/i.test(text);
  if (NOISE_PATTERNS.shipping.test(text) && !hasProductContent)
    return { noisy: true, reason: 'shipping_only' };
  if (NOISE_PATTERNS.seller.test(text) && !hasProductContent)
    return { noisy: true, reason: 'seller_service_only' };
  return { noisy: false, reason: '' };
}

// ── Main scrape function (dual-mode) ──

/**
 * 抓取指定 ASIN 的评论
 * 自动选择模式: 有 browser → Playwright, 否则 HTTP
 */
export async function scrapeReviews(
  asin: string,
  opts: ReviewScrapeOptions = {}
): Promise<AmazonReview[]> {
  const productName = opts.productName || asin;
  const targetDomains = opts.domains || [opts.domain || 'www.amazon.com'];
  const allReviews: AmazonReview[] = [];

  // Detect mode
  const usePlaywright = !!opts.browser;
  log(`Scraping ${asin} (${productName}) across ${targetDomains.length} domains [${usePlaywright ? 'PW' : 'HTTP'} mode]`, opts);

  for (const domain of targetDomains) {
    log(`  Domain: ${domain}`, opts);
    const reviews = usePlaywright
      ? await scrapeReviewsPlaywright(asin, productName, domain, { ...opts, domain })
      : await scrapeReviewsHttp(asin, productName, domain, { ...opts, domain });

    // Apply noise filter
    const clean = reviews.filter(r => {
      const n = isNoiseReview(r.text);
      if (n.noisy) log(`    filtered: "${r.text.slice(0, 60)}..." (${n.reason})`, opts);
      return !n.noisy;
    });

    log(`  ${domain}: ${reviews.length} raw → ${clean.length} after filtering`, opts);
    allReviews.push(...clean);
  }

  return allReviews;
}

// ── DeepSeek Analysis (ported from v1) ──

export interface ReviewAnalysis {
  index: number;
  is_product_issue: boolean;
  product_name: string;
  defect_type: string;
  severity: string;
  summary: string;
  themes: string[];
  sentiment: 'positive' | 'negative' | 'neutral';
}

export async function analyzeReviews(
  reviews: AmazonReview[],
  apiKey: string,
  opts?: { log?: (msg: string) => void }
): Promise<ReviewAnalysis[]> {
  if (!reviews.length || !apiKey) return [];

  const logFn = opts?.log || console.log;
  const results: ReviewAnalysis[] = [];
  const BATCH_SIZE = 10;

  for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
    const batch = reviews.slice(i, i + BATCH_SIZE);
    const reviewTexts = batch.map((r, j) =>
      `[${i + j}] Rating: ${r.rating}/5 | Domain: ${r.domain} | Verified: ${r.verified ? 'yes' : 'no'} | "${r.title}": ${r.text.slice(0, 400)}`
    ).join('\n');

    try {
      const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{
            role: 'user',
            content: `You are analyzing Amazon customer reviews. For each review, extract:
- sentiment: "positive" | "negative" | "neutral"
- is_product_issue: true ONLY if complaint is about product quality/defect/performance/durability/design (NOT shipping/service/price)
- product_name: specific product mentioned (if any)
- defect_type: "quality" | "durability" | "performance" | "design" | "compatibility" | "safety" | "missing_parts" | "false_advertising" | "other" | ""
- severity: "high" | "medium" | "low" | "none"
- summary: one-sentence summary of the review
- themes: array of keywords (e.g., ["motor_failure", "battery_life", "easy_to_use", "great_value"])

Return JSON array. Include ALL reviews.\n\nReviews:\n${reviewTexts}`
          }],
          temperature: 0.1, max_tokens: 2000,
        }),
      });

      if (!resp.ok) { await sleep(2000); continue; }
      const data: any = await resp.json();
      const raw = (data?.choices?.[0]?.message?.content || '')
        .replace(/```json\n?/g, '').replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) results.push(...parsed);
      } catch {}
    } catch {}
    await sleep(1500);
  }

  logFn(`[amazon] DeepSeek analysis: ${results.length} reviews analyzed`);
  return results;
}

// ── Utility: Extract ASIN from URL ──

export function extractAsinFromUrl(url: string): string | null {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/gp\/aw\/d\/([A-Z0-9]{10})/i,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
