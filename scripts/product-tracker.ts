/**
 * Product Tracker — 新品追踪 + 变更提醒
 *
 * 聚合 IG + 论坛 + Reddit 数据，检测竞品新品发布/下架/变更。
 *
 * 用法: npx tsx scripts/product-tracker.ts
 *
 * ENV:
 *   PRODUCT_TRACKER_SOURCES=ig,forum,reddit  (数据源)
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// ============ Config ============
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');
const STATE_DIR = path.join(process.env.BOT_STATE_DIR || './data/bot_state', 'product_tracker');
const CACHE_FILE = path.join(STATE_DIR, 'product_tracker_cache.json');
const SOURCES = (process.env.PRODUCT_TRACKER_SOURCES || 'forum,reddit').split(',').map(s => s.trim());

const COMPETITOR_CACHE = path.join(
  process.env.BOT_STATE_DIR || './data/bot_state',
  'competitor_research',
  'profiles_cache.json'
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

// ============ DB ============
const openDb = () => new Database(DB_PATH);

const upsertProduct = (db: Database.Instance, product: {
  id: string; brand_name: string; product_name: string; product_url: string;
  price: string; currency: string; source: string; image_urls: string; status: string;
}) => {
  const now = Date.now();
  const existing = db.prepare('SELECT first_seen_at FROM competitor_products WHERE id = ?').get(product.id) as any;
  const firstSeen = existing?.first_seen_at || now;
  return db.prepare(`INSERT OR REPLACE INTO competitor_products
    (id, brand_name, product_name, product_url, price, currency, first_seen_at, last_seen_at, source, image_urls, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(product.id, product.brand_name, product.product_name, product.product_url,
      product.price, product.currency, firstSeen, now,
      product.source, product.image_urls, product.status);
};

const createAlert = (db: Database.Instance, alert: {
  brand_name: string; alert_type: string; title: string; details: string; source_url: string;
}) => {
  return db.prepare(`INSERT INTO competitor_alerts (brand_name, alert_type, title, details, source_url, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)`)
    .run(alert.brand_name, alert.alert_type, alert.title, alert.details, alert.source_url, Date.now());
};

// ============ AI Product Detection ============
const detectNewProducts = async (posts: { caption: string; url: string; handle: string; date: string }[]): Promise<{
  product_name: string; brand_name: string; product_type: string; confidence: number; source_url: string; source_date: string;
}[]> => {
  if (!DEEPSEEK_API_KEY || posts.length === 0) return [];

  const postsData = posts.map((p, i) => ({
    id: i, handle: p.handle, caption: p.caption.slice(0, 300), date: p.date,
  }));

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'system',
          content: `You detect new tattoo equipment/aftercare product announcements from social media posts.
For each post that mentions a NEW product, product launch, or product update, extract:
- product_name: the specific product name
- brand_name: the brand that makes it
- product_type: machine / needle / cartridge / ink / aftercare / power_supply / furniture / accessory / apparel / other
- confidence: 0-1 how likely this is a real new product (vs just mentioning an existing product)

NOT a new product if: they're just using the product, showing tattoo work, or mentioning a well-known existing product casually.
Only flag: "just launched", "new release", "coming soon", "now available", first-time reveals, product announcements.

Return JSON array: [{"id": <post_id>, "product_name": "...", "brand_name": "...", "product_type": "...", "confidence": 0.X}, ...]
Empty array [] if no new products detected.`,
        }, {
          role: 'user',
          content: JSON.stringify(postsData),
        }],
        temperature: 0.3, max_tokens: 1000,
      }),
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    const text = data?.choices?.[0]?.message?.content || '';
    try {
      const cleaned = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      const results = JSON.parse(cleaned);
      if (!Array.isArray(results)) return [];
      return results.map((r: any) => ({
        product_name: r.product_name || '',
        brand_name: r.brand_name || '',
        product_type: r.product_type || 'other',
        confidence: Number(r.confidence) || 0,
        source_url: posts[r.id]?.url || '',
        source_date: posts[r.id]?.date || '',
      })).filter((r) => r.product_name && r.brand_name && r.confidence >= 0.6);
    } catch { return []; }
  } catch { return []; }
};

// ============ Source: brand_mentions table ============
const analyzeMentions = async (db: Database.Instance): Promise<number> => {
  console.log('\n--- Analyzing forum/reddit mentions ---');

  // Get recent mentions not yet analyzed for products
  const since = Date.now() - 30 * 24 * 3600 * 1000; // last 30 days
  const mentions = db.prepare(`
    SELECT bm.* FROM brand_mentions bm
    WHERE bm.scraped_at > ?
      AND bm.id NOT IN (
        SELECT CAST(json_extract(cache.value, '$.mention_id') AS INTEGER)
        FROM product_tracker_cache cache WHERE cache.key = 'analyzed_mention'
      )
    ORDER BY bm.scraped_at DESC LIMIT 50
  `).all(since) as any[];

  if (mentions.length === 0) {
    console.log('  No new mentions to analyze');
    return 0;
  }

  const posts = mentions.map((m: any) => ({
    caption: `${m.post_title} ${m.content || ''}`,
    url: m.post_url || '',
    handle: m.author || '',
    date: m.posted_at || '',
    mention_id: m.id,
  }));

  const detected = await detectNewProducts(posts);
  let added = 0;

  for (const d of detected) {
    const post = posts.find(p => p.caption.includes(d.product_name.slice(0, 10)));
    const productId = `${d.brand_name.toLowerCase().replace(/\s+/g, '_')}_${d.product_name.toLowerCase().replace(/\s+/g, '_').slice(0, 40)}`;

    upsertProduct(db, {
      id: productId,
      brand_name: d.brand_name,
      product_name: d.product_name,
      product_url: d.source_url,
      price: '',
      currency: 'USD',
      source: 'social_mention',
      image_urls: '[]',
      status: 'active',
    });

    createAlert(db, {
      brand_name: d.brand_name,
      alert_type: 'new_product',
      title: `${d.brand_name} — ${d.product_name}`,
      details: `Detected from social mention. Type: ${d.product_type}. Confidence: ${Math.round(d.confidence * 100)}%`,
      source_url: d.source_url,
    });

    console.log(`  🆕 ${d.brand_name}: ${d.product_name} (${d.product_type}, ${Math.round(d.confidence * 100)}%)`);
    added++;
  }

  return added;
};

// ============ Source: IG profiles_cache.json ============
const analyzeIGProfiles = async (db: Database.Instance): Promise<number> => {
  console.log('\n--- Analyzing IG competitor profiles ---');

  if (!fs.existsSync(COMPETITOR_CACHE)) {
    console.log('  No profiles_cache.json yet (run competitor-research first)');
    return 0;
  }

  let profiles: any[];
  try {
    profiles = JSON.parse(fs.readFileSync(COMPETITOR_CACHE, 'utf8'));
  } catch {
    console.log('  Failed to parse profiles_cache.json');
    return 0;
  }

  // Extract posts with captions from all profiles
  const posts: { caption: string; url: string; handle: string; date: string }[] = [];
  for (const profile of profiles) {
    for (const post of (profile.posts || [])) {
      posts.push({
        caption: post.caption || '',
        url: post.postUrl || '',
        handle: profile.handle || '',
        date: post.timestamp || '',
      });
    }
  }

  console.log(`  ${profiles.length} profiles, ${posts.length} posts to analyze`);
  const detected = await detectNewProducts(posts);
  let added = 0;

  for (const d of detected) {
    const productId = `${d.brand_name.toLowerCase().replace(/\s+/g, '_')}_${d.product_name.toLowerCase().replace(/\s+/g, '_').slice(0, 40)}`;

    upsertProduct(db, {
      id: productId,
      brand_name: d.brand_name,
      product_name: d.product_name,
      product_url: d.source_url,
      price: '',
      currency: 'USD',
      source: 'ig',
      image_urls: '[]',
      status: 'active',
    });

    createAlert(db, {
      brand_name: d.brand_name,
      alert_type: 'new_product',
      title: `${d.brand_name} — ${d.product_name}`,
      details: `New product detected from IG post. Type: ${d.product_type}. Confidence: ${Math.round(d.confidence * 100)}%`,
      source_url: d.source_url,
    });

    console.log(`  🆕 ${d.brand_name}: ${d.product_name} (${d.product_type})`);
    added++;
  }

  return added;
};

// ============ Generate status change alerts ============
const detectStatusChanges = (db: Database.Instance): number => {
  console.log('\n--- Checking product status changes ---');
  let changes = 0;

  // Products not seen in 60+ days → potentially discontinued
  const staleThreshold = Date.now() - 60 * 24 * 3600 * 1000;
  const stale = db.prepare(`
    SELECT * FROM competitor_products
    WHERE status = 'active' AND last_seen_at < ? AND last_seen_at > 0
  `).all(staleThreshold) as any[];

  for (const p of stale) {
    db.prepare('UPDATE competitor_products SET status = ? WHERE id = ?').run('discontinued', p.id);
    createAlert(db, {
      brand_name: p.brand_name,
      alert_type: 'discontinued',
      title: `${p.brand_name} — ${p.product_name} may be discontinued`,
      details: `Last seen ${Math.round((Date.now() - p.last_seen_at) / (24 * 3600 * 1000))} days ago. Status changed to discontinued.`,
      source_url: p.product_url || '',
    });
    console.log(`  ⚠ ${p.brand_name}: ${p.product_name} → discontinued`);
    changes++;
  }

  return changes;
};

// ============ Social Heat Tracking ============

interface SocialHeatScore {
  product_id: string;
  product_name: string;
  brand_name: string;
  heatScore: number;         // 0-100 social media buzz level
  mentionCount: number;      // total mentions in last 90d
  sentimentRatio: string;    // positive/negative ratio
  trend: string;             // rising / stable / cooling / new
  lastUpdated: number;
}

const computeSocialHeat = async (db: Database.Instance): Promise<SocialHeatScore[]> => {
  console.log('\n--- Computing social media heat ---');

  const products = db.prepare('SELECT * FROM competitor_products WHERE status = ?').all('active') as any[];
  if (products.length === 0) {
    console.log('  No active products to score');
    return [];
  }

  const results: SocialHeatScore[] = [];

  for (const product of products) {
    // Total brand mentions
    const mentionCount = (db.prepare(`
      SELECT COUNT(*) as c FROM brand_mentions
      WHERE mentioned_brands LIKE ? AND scraped_at > ?
    `).get(`%${product.brand_name}%`, Date.now() - 90 * 24 * 3600 * 1000) as any)?.c || 0;

    // Sentiment ratio
    const sentimentRows = db.prepare(`
      SELECT sentiment, COUNT(*) as c FROM brand_mentions
      WHERE mentioned_brands LIKE ? AND scraped_at > ?
      GROUP BY sentiment
    `).all(`%${product.brand_name}%`, Date.now() - 90 * 24 * 3600 * 1000) as any[];

    let pos = 0, neg = 0;
    for (const row of sentimentRows) {
      if (row.sentiment === 'positive') pos = row.c;
      if (row.sentiment === 'negative') neg = row.c;
    }
    const sentimentRatio = pos + neg > 0 ? `${pos}:${neg}` : '0:0';

    // Recent trend (last 30d vs 30-60d ago)
    const recentCount = (db.prepare(`
      SELECT COUNT(*) as c FROM brand_mentions
      WHERE mentioned_brands LIKE ? AND scraped_at > ?
    `).get(`%${product.brand_name}%`, Date.now() - 30 * 24 * 3600 * 1000) as any)?.c || 0;

    const olderCount = mentionCount - recentCount;
    let trend = 'new';
    if (mentionCount === 0) trend = 'new';
    else if (olderCount > 0 && recentCount > olderCount * 1.3) trend = 'rising';
    else if (olderCount > 0 && recentCount < olderCount * 0.7) trend = 'cooling';
    else trend = 'stable';

    // Heat score: log-scale mentions + sentiment bonus
    let heatScore = Math.min(60, Math.round(Math.log2(mentionCount + 1) * 10));
    if (pos > neg * 2) heatScore = Math.min(100, heatScore + 20);
    if (trend === 'rising') heatScore = Math.min(100, heatScore + 15);
    if (trend === 'cooling') heatScore = Math.max(5, heatScore - 10);

    const result: SocialHeatScore = {
      product_id: product.id,
      product_name: product.product_name,
      brand_name: product.brand_name,
      heatScore,
      mentionCount,
      sentimentRatio,
      trend,
      lastUpdated: Date.now(),
    };

    results.push(result);
    if (mentionCount > 0) {
      console.log(`  🔥 ${product.brand_name}: heat=${heatScore}/100 (${mentionCount} mentions, ${trend}, ${sentimentRatio} pos:neg)`);
    }
  }

  // Save to DB
  db.exec(`CREATE TABLE IF NOT EXISTS product_social_heat (
    product_id TEXT PRIMARY KEY,
    heat_score INTEGER,
    mention_count INTEGER,
    sentiment_ratio TEXT,
    trend TEXT,
    last_updated INTEGER
  )`);

  const upsert = db.prepare(`INSERT OR REPLACE INTO product_social_heat
    (product_id, heat_score, mention_count, sentiment_ratio, trend, last_updated)
    VALUES (?, ?, ?, ?, ?, ?)`);

  for (const r of results) {
    upsert.run(r.product_id, r.heatScore, r.mentionCount, r.sentimentRatio, r.trend, r.lastUpdated);
  }

  return results;
};

// ============ Main ============
const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Product Tracker                    ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Sources: ${SOURCES.join(', ')}`);

  ensureDir(STATE_DIR);
  const db = openDb();
  let totalAdded = 0;

  try {
    // Initialize cache table if needed
    db.exec(`CREATE TABLE IF NOT EXISTS product_tracker_cache (
      key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
    )`);

    if (SOURCES.includes('forum') || SOURCES.includes('reddit')) {
      totalAdded += await analyzeMentions(db);
    }

    if (SOURCES.includes('ig')) {
      totalAdded += await analyzeIGProfiles(db);
    }

    const statusChanges = detectStatusChanges(db);
    const heatScores = await computeSocialHeat(db);

    // Summary
    const products = db.prepare('SELECT COUNT(*) as c FROM competitor_products WHERE status = ?').get('active') as any;
    const alerts = db.prepare('SELECT COUNT(*) as c FROM competitor_alerts WHERE is_read = 0').get() as any;

    console.log(`\n═══════════════════════════════════════`);
    console.log(`  New products added: ${totalAdded}`);
    console.log(`  Status changes: ${statusChanges}`);
    console.log(`  Social heat scored: ${heatScores.length} products`);
    console.log(`  Active products tracked: ${products?.c || 0}`);
    console.log(`  Unread alerts: ${alerts?.c || 0}`);
    console.log(`═══════════════════════════════════════`);

  } finally {
    db.close();
  }
};

main().catch((e) => {
  console.error('[product-tracker] Fatal:', e?.message || e);
  process.exit(1);
});
