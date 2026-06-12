/**
 * Intel Classifier — shared AI classification + routing for all intel sources.
 *
 * Used by: forum-intel-pipeline.ts, reddit-monitor.ts, forum-monitor.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ============ Types ============

export type RawThread = {
  forum: string;
  title: string;
  content: string;
  author: string;
  date: string;
  url: string;
  replies: string[];
};

export type ThreadClassification = {
  index: number;
  is_product_related: boolean;
  product_category: 'machine' | 'needle' | 'ink' | 'aftercare' | 'power_supply' | 'other_accessory' | 'none';
  discussion_type: 'review' | 'problem' | 'comparison' | 'recommendation' | 'wishlist' | 'technique' | 'off_topic';
  mentioned_brands: string[];
  mentioned_products: string[];
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  pain_points: string[];
  praise_points: string[];
  wishlist_items: string[];
  feature_requests: string[];
  key_insight: string;
  confidence: 'high' | 'medium' | 'low';
  artist_skill_level: 'beginner' | 'intermediate' | 'professional' | 'unknown';
  usage_context: 'lining' | 'shading' | 'color_packing' | 'cover_up' | 'all_around' | 'unknown';
  purchase_intent: 'browsing' | 'researching' | 'ready_to_buy' | 'just_bought' | 'not_applicable';
  comparison_verdict: string | null;
  price_sensitivity: 'budget_conscious' | 'mid_range' | 'premium_only' | 'not_discussed';
};

// ============ URL Cache ============

const STATE_DIR = path.join(process.env.BOT_STATE_DIR || './data/bot_state', 'forum_intel');
const CACHE_FILE = path.join(STATE_DIR, 'seen_urls.json');

let _seenUrls: Set<string> | null = null;

export const loadSeenUrls = (): Set<string> => {
  if (_seenUrls) return _seenUrls;
  try {
    if (!fs.existsSync(CACHE_FILE)) { _seenUrls = new Set(); return _seenUrls; }
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    _seenUrls = new Set(data.urls || []);
    return _seenUrls;
  } catch { _seenUrls = new Set(); return _seenUrls; }
};

export const saveSeenUrls = (urls: Set<string>) => {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    urls: [...urls].slice(-5000),
    updatedAt: new Date().toISOString(),
  }), 'utf8');
};

// ============ Few-shot Feedback Learning ============

const loadReviewExamples = (limit: number = 4): { original: string; corrected: any }[] => {
  try {
    const db = new Database(DB_PATH);
    const rows = db.prepare(`
      SELECT original_text, ai_classification
      FROM review_queue
      WHERE review_status IN ('approved', 'corrected')
        AND original_text IS NOT NULL
        AND ai_classification IS NOT NULL
      ORDER BY reviewed_at DESC
      LIMIT ?
    `).all(limit) as any[];
    db.close();
    return rows.map((r: any) => {
      try { return { original: r.original_text?.slice(0, 300) || '', corrected: JSON.parse(r.ai_classification) }; }
      catch { return { original: '', corrected: null }; }
    }).filter(e => e.original && e.corrected);
  } catch { return []; }
};

// ============ AI Classification ============

const CLASSIFICATION_PROMPT = `You are a competitive intelligence analyst specializing in the tattoo supply industry. Your job is to read forum posts by tattoo artists and extract actionable product intelligence.

CRITICAL RULES:
1. SEMANTIC understanding only — never keyword-match. Read the post like a human tattoo artist would.
2. Artists often use slang, informal language, or indirect descriptions. "My pen" = tattoo machine. "Spits ink" = inconsistent needle depth or ink flow. "Bogs down" = underpowered motor. "Chews up skin" = needle quality issue. "Doesn't heal right" = aftercare or ink problem. "Cord gets in the way" = wants wireless.
3. WISHLIST + FEATURE_REQUESTS are the highest-value signals. Distinguish them:
   - wishlist_items: "I wish someone made a cordless rotary under $200" = new product category gap
   - feature_requests: "I wish my Bishop had USB-C charging" = specific feature missing in existing product
4. Distinguish TECHNIQUE from PRODUCT. "How do I shade better" with no equipment discussion = technique. "My Bishop packs color better than my Dragonhawk" = product comparison.
5. Be specific in pain_points and praise_points. Not "bad quality" but "motor overheats after 2 hours of lining".
6. Extract brands even when misspelled or abbreviated (e.g., "FK" = FK Irons, "dhawk" = Dragonhawk, "Chey" = Cheyenne).
7. Infer artist_skill_level from language: beginners ask about "starter kits", "first machine", "learning to line"; pros discuss nuanced performance, multiple machines, high-volume workflow.
8. Infer usage_context from what the artist is doing: lining, shading, color packing, cover-ups, or all-around.
9. Infer purchase_intent: "thinking about buying" = researching, "which one should I get" = ready_to_buy, "just got my new X" = just_bought, just discussing experience = browsing.
10. For comparison posts, comparison_verdict should state which brand/product won and WHY in one sentence.
11. price_sensitivity: if they mention "$200 budget" or "cheap" or "worth the money" = budget_conscious; if they say "money no object" or "best regardless of price" = premium_only.
12. If the post is purely social/art-sharing/off-topic, mark is_product_related: false confidently.`;

const BATCH_USER_PROMPT = (batch: RawThread[], startIndex: number, feedbackBlock: string) => {
  const batchText = batch.map((t, j) => {
    const repliesStr = t.replies.length > 0
      ? `\nReplies (${t.replies.length}): ${t.replies.map(r => r.slice(0, 200)).join(' | ')}`
      : '';
    return `[${startIndex + j}] Platform: ${t.forum} | Author: ${t.author} | Date: ${t.date}\nTitle: ${t.title}\nContent: ${t.content.slice(0, 800)}${repliesStr}`;
  }).join('\n---\n');

  return `Analyze these ${batch.length} tattoo forum posts. Return ONLY a JSON array — no markdown, no explanation.${feedbackBlock}

Schema per post:
{
  "index": <number>,
  "is_product_related": <boolean>,
  "product_category": "machine" | "needle" | "ink" | "aftercare" | "power_supply" | "other_accessory" | "none",
  "discussion_type": "review" | "problem" | "comparison" | "recommendation" | "wishlist" | "technique" | "off_topic",
  "mentioned_brands": <string[]>,
  "mentioned_products": <string[]>,
  "sentiment": "positive" | "negative" | "neutral" | "mixed",
  "pain_points": <string[]>,
  "praise_points": <string[]>,
  "wishlist_items": <string[]>,
  "feature_requests": <string[]>,
  "key_insight": <string — one sentence, most actionable intel>,
  "confidence": "high" | "medium" | "low",
  "artist_skill_level": "beginner" | "intermediate" | "professional" | "unknown",
  "usage_context": "lining" | "shading" | "color_packing" | "cover_up" | "all_around" | "unknown",
  "purchase_intent": "browsing" | "researching" | "ready_to_buy" | "just_bought" | "not_applicable",
  "comparison_verdict": <string or null>,
  "price_sensitivity": "budget_conscious" | "mid_range" | "premium_only" | "not_discussed"
}

Example posts and correct classifications:
1. "my pen feels weird after like 30 min of lining, starts to vibrate differently" → is_product_related: true, category: machine, type: problem, pain_points: ["vibration changes after 30 min use"], usage_context: "lining", artist_skill_level: "intermediate", purchase_intent: "browsing", feature_requests: [], comparison_verdict: null, price_sensitivity: "not_discussed"
2. "wish someone made a wireless battery that lasts a full day session without swapping" → is_product_related: true, category: power_supply, type: wishlist, wishlist_items: ["all-day wireless battery for tattoo machines"], feature_requests: [], purchase_intent: "not_applicable"
3. "check out this sleeve I finished yesterday, 6 sessions 🙌" → is_product_related: false, type: off_topic, purchase_intent: "not_applicable", price_sensitivity: "not_discussed"
4. "thinking about switching from Cheyenne to Bishop, anyone used both? Budget around $400" → is_product_related: true, category: machine, type: comparison, brands: ["Cheyenne", "Bishop"], comparison_verdict: null, purchase_intent: "ready_to_buy", price_sensitivity: "budget_conscious"
5. "just got my FK Irons Xion, the USB-C charging is great but wish it had battery level indicator" → is_product_related: true, category: machine, type: review, brands: ["FK Irons"], products: ["Xion"], feature_requests: ["battery level indicator"], purchase_intent: "just_bought", sentiment: "mixed"

Posts to classify:\n${batchText}`;
};

export const classifyThreads = async (threads: RawThread[]): Promise<ThreadClassification[]> => {
  if (!threads.length || !DEEPSEEK_API_KEY) return [];

  const reviewExamples = loadReviewExamples(4);
  const feedbackBlock = reviewExamples.length > 0
    ? `\n\nHUMAN-VERIFIED EXAMPLES (use these as a reference for correct classification):\n${
      reviewExamples.map((ex, i) =>
        `Example ${i + 1}:\nPost: "${ex.original}"\nCorrect classification: ${JSON.stringify(ex.corrected)}`
      ).join('\n')
    }\n\nApply the same judgment standards from these human-verified examples to the new posts below.`
    : '';

  const results: ThreadClassification[] = [];
  for (let i = 0; i < threads.length; i += 10) {
    const batch = threads.slice(i, i + 10);
    try {
      const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: CLASSIFICATION_PROMPT },
            { role: 'user', content: BATCH_USER_PROMPT(batch, i, feedbackBlock) },
          ],
          temperature: 0.1, max_tokens: 3000,
        }),
      });
      if (!resp.ok) { await sleep(2000); continue; }
      const data: any = await resp.json();
      const raw = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) results.push(...parsed);
      } catch { console.warn('[classifier] JSON parse failed'); }
    } catch (e: any) { console.warn(`[classifier] API error: ${e.message}`); }
    await sleep(2000);
  }
  return results;
};

// ============ Routing ============

export interface RouteStats {
  productDiscussions: number;
  reviews: number; problems: number; wishlists: number; features: number; comparisons: number; buyers: number;
  skippedLowConf: number; skippedMediumConf: number;
  typeDist: Record<string, number>;
  confDist: Record<string, number>;
  catDist: Record<string, number>;
  skillDist: Record<string, number>;
}

export const routeToDatabase = (
  threads: RawThread[],
  classifications: ThreadClassification[],
  platform: 'forum' | 'reddit' = 'forum'
): RouteStats => {
  const db = new Database(DB_PATH);
  const now = Date.now();

  const insertMention = db.prepare(`
    INSERT OR IGNORE INTO brand_mentions
      (platform, subreddit_or_forum, post_title, post_url, author, content, mentioned_brands, sentiment,
       discussion_type, artist_skill_level, purchase_intent, price_sensitivity, engagement_score, posted_at, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const insertReview = db.prepare(`
    INSERT INTO competitor_reviews
      (product_name, source, source_url, reviewer_name, review_text, sentiment, key_themes,
       artist_skill_level, usage_context, purchase_intent, comparison_verdict, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAlert = db.prepare(`
    INSERT INTO competitor_alerts
      (brand_name, alert_type, title, details, source_url, severity, opportunity_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReviewQueue = db.prepare(`
    INSERT INTO review_queue (source_type, source_url, original_title, original_text, ai_classification, confidence, review_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

  const stats: RouteStats = {
    productDiscussions: 0, reviews: 0, problems: 0, wishlists: 0, features: 0, comparisons: 0, buyers: 0,
    skippedLowConf: 0, skippedMediumConf: 0,
    typeDist: {}, confDist: {}, catDist: {}, skillDist: {},
  };

  for (const c of classifications) {
    const thread = threads[c.index];
    if (!thread || !c.is_product_related) {
      stats.typeDist[c.discussion_type] = (stats.typeDist[c.discussion_type] || 0) + 1;
      stats.confDist[c.confidence] = (stats.confDist[c.confidence] || 0) + 1;
      continue;
    }
    stats.productDiscussions++;
    stats.typeDist[c.discussion_type] = (stats.typeDist[c.discussion_type] || 0) + 1;
    stats.confDist[c.confidence] = (stats.confDist[c.confidence] || 0) + 1;
    stats.catDist[c.product_category] = (stats.catDist[c.product_category] || 0) + 1;
    stats.skillDist[c.artist_skill_level] = (stats.skillDist[c.artist_skill_level] || 0) + 1;

    // Confidence-gated routing
    if (c.confidence === 'low') {
      stats.skippedLowConf++;
      insertReviewQueue.run(
        thread.forum, thread.url, thread.title, thread.content.slice(0, 2000),
        JSON.stringify(c), 'low', now
      );
      continue;
    }
    const fullRoute = c.confidence === 'high';

    // Medium: 10% sampled to review_queue for spot-check
    if (!fullRoute && Math.random() < 0.1) {
      insertReviewQueue.run(
        thread.forum, thread.url, thread.title, thread.content.slice(0, 2000),
        JSON.stringify(c), 'medium', now
      );
    }

    // 1. brand_mentions with full dimensions
    insertMention.run(
      platform, thread.forum, thread.title.slice(0, 300), thread.url,
      thread.author, thread.content.slice(0, 2000),
      JSON.stringify(c.mentioned_brands),
      c.sentiment,
      c.discussion_type,
      c.artist_skill_level || 'unknown',
      c.purchase_intent || 'not_applicable',
      c.price_sensitivity || 'not_discussed',
      thread.date || new Date().toISOString(), now
    );

    if (!fullRoute) { stats.skippedMediumConf++; continue; }

    // 2. Reviews & problems → competitor_reviews
    if (c.discussion_type === 'review' || c.discussion_type === 'problem') {
      const brand = c.mentioned_brands[0] || thread.forum;
      const themes = [
        ...c.pain_points.map(p => `PAIN: ${p}`),
        ...c.praise_points.map(p => `PRAISE: ${p}`),
      ];
      if (c.comparison_verdict) themes.push(`VERDICT: ${c.comparison_verdict}`);

      insertReview.run(
        brand, thread.url, thread.author, thread.content.slice(0, 1000),
        c.sentiment, JSON.stringify(themes),
        c.artist_skill_level || 'unknown', c.usage_context || 'unknown',
        c.purchase_intent || 'not_applicable', c.comparison_verdict || null, now
      );
      if (c.discussion_type === 'review') stats.reviews++;
      else stats.problems++;
    }

    // 3. Comparisons → competitor_reviews
    if (c.discussion_type === 'comparison') {
      stats.comparisons++;
      const brand = c.mentioned_brands[0] || 'unknown';
      const themes = c.comparison_verdict ? [`VERDICT: ${c.comparison_verdict}`] : [];
      for (const b of c.mentioned_brands) themes.push(`mentioned: ${b}`);

      insertReview.run(
        brand, thread.url, thread.author, thread.content.slice(0, 1000),
        c.sentiment, JSON.stringify(themes),
        c.artist_skill_level || 'unknown', c.usage_context || 'unknown',
        c.purchase_intent || 'not_applicable', c.comparison_verdict || null, now
      );

      if (c.comparison_verdict) {
        insertAlert.run(
          brand, 'comparison_insight',
          `Comparison: ${c.mentioned_brands.join(' vs ')} `.slice(0, 200),
          c.comparison_verdict, thread.url, null, null, now
        );
      }
    }

    // 4. Problems → alerts
    if (c.discussion_type === 'problem' && c.pain_points.length > 0) {
      insertAlert.run(
        c.mentioned_brands[0] || 'unknown', 'forum_problem',
        c.pain_points[0]?.slice(0, 200) || thread.title.slice(0, 200),
        `${c.key_insight}\n\nPain points: ${c.pain_points.join(', ')}`,
        thread.url, c.confidence, null, now
      );
    }

    // 5. Wishlist → alerts
    if (c.discussion_type === 'wishlist' || c.wishlist_items.length > 0) {
      stats.wishlists++;
      insertAlert.run(
        c.mentioned_brands[0] || 'market_opportunity', 'product_opportunity',
        `Artist wishlist: ${c.wishlist_items[0]?.slice(0, 150) || c.key_insight}`,
        `Source: ${thread.forum}\n${c.key_insight}\nWishlist: ${c.wishlist_items.join(' | ')}`,
        thread.url, null, 'wishlist', now
      );
    }

    // 6. Feature requests → alerts
    if (c.feature_requests?.length > 0) {
      stats.features++;
      insertAlert.run(
        c.mentioned_brands[0] || 'unknown', 'feature_request',
        `Feature request: ${c.feature_requests[0]?.slice(0, 150)}`,
        `Source: ${thread.forum}\nBrand: ${c.mentioned_brands.join(', ') || 'unspecified'}\nFeature requests: ${c.feature_requests.join(' | ')}\nContext: ${c.key_insight}`,
        thread.url, null, 'feature_request', now
      );
    }

    // 7. Ready-to-buy → alerts
    if (c.purchase_intent === 'ready_to_buy') {
      stats.buyers++;
      insertAlert.run(
        c.mentioned_brands.join(', ') || 'unknown', 'purchase_intent',
        `Ready to buy: ${thread.title.slice(0, 150)}`,
        `Artist level: ${c.artist_skill_level || 'unknown'} | Context: ${c.usage_context || 'unknown'} | Budget: ${c.price_sensitivity || 'unknown'}\n${c.key_insight}`,
        thread.url, null, null, now
      );
    }
  }

  console.log(`\n[route] ${stats.productDiscussions} product discussions →`);
  console.log(`  High conf (full route): ${stats.reviews} reviews + ${stats.problems} problems + ${stats.comparisons} comparisons`);
  console.log(`  ${stats.wishlists} wishlist items + ${stats.features} feature requests`);
  console.log(`  ${stats.buyers} ready-to-buy signals`);
  if (stats.skippedLowConf > 0) console.log(`  ⚠ ${stats.skippedLowConf} low-confidence → review_queue`);
  if (stats.skippedMediumConf > 0) console.log(`  ⚠ ${stats.skippedMediumConf} medium-confidence → brand_mentions only`);

  db.close();
  return stats;
};

export const printClassificationSummary = (
  threads: RawThread[],
  classifications: ThreadClassification[]
) => {
  const productCount = classifications.filter(c => c.is_product_related).length;
  const typeDist: Record<string, number> = {};
  const confDist: Record<string, number> = {};
  const catDist: Record<string, number> = {};
  const skillDist: Record<string, number> = {};
  for (const c of classifications) {
    typeDist[c.discussion_type] = (typeDist[c.discussion_type] || 0) + 1;
    confDist[c.confidence] = (confDist[c.confidence] || 0) + 1;
    if (c.is_product_related) {
      catDist[c.product_category] = (catDist[c.product_category] || 0) + 1;
      skillDist[c.artist_skill_level] = (skillDist[c.artist_skill_level] || 0) + 1;
    }
  }
  console.log(`[ai] ${productCount}/${classifications.length} product-related`);
  console.log(`  Confidence: ${JSON.stringify(confDist)}`);
  console.log(`  Types: ${JSON.stringify(typeDist)}`);
  if (Object.keys(catDist).length) console.log(`  Categories: ${JSON.stringify(catDist)}`);
  if (Object.keys(skillDist).length) console.log(`  Skill levels: ${JSON.stringify(skillDist)}`);

  const wishlists = classifications.filter(c => c.wishlist_items.length > 0);
  if (wishlists.length > 0) {
    console.log(`\n✨ Wishlist Items (${wishlists.length}):`);
    for (const w of wishlists) {
      const t = threads[w.index];
      console.log(`  💡 ${w.wishlist_items.join(' | ')}`);
      console.log(`     ${t?.forum}: "${t?.title?.slice(0, 80)}"`);
    }
  }

  const featReqs = classifications.filter(c => c.feature_requests?.length > 0);
  if (featReqs.length > 0) {
    console.log(`\n🔧 Feature Requests (${featReqs.length}):`);
    for (const f of featReqs) {
      const t = threads[f.index];
      console.log(`  ⚙ ${f.feature_requests.join(' | ')}`);
      console.log(`     ${t?.forum}: ${f.mentioned_brands.join(', ') || 'unspecified brand'}`);
    }
  }

  const verdicts = classifications.filter(c => c.comparison_verdict);
  if (verdicts.length > 0) {
    console.log(`\n⚖ Comparison Verdicts (${verdicts.length}):`);
    for (const v of verdicts) {
      const t = threads[v.index];
      console.log(`  🏆 ${v.mentioned_brands.join(' vs ')}: ${v.comparison_verdict}`);
      console.log(`     ${t?.forum}: "${t?.title?.slice(0, 80)}"`);
    }
  }

  const buyers = classifications.filter(c => c.purchase_intent === 'ready_to_buy');
  if (buyers.length > 0) {
    console.log(`\n🛒 Ready-to-Buy Signals (${buyers.length}):`);
    for (const b of buyers) {
      const t = threads[b.index];
      console.log(`  💰 ${b.artist_skill_level} artist | ${b.usage_context} | ${b.price_sensitivity}`);
      console.log(`     ${t?.forum}: "${t?.title?.slice(0, 80)}"`);
    }
  }
};
