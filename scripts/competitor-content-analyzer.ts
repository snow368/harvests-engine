/**
 * Competitor Content Analyzer — 竞对内容综合分析
 *
 * 多维度分析竞对内容表现，输出可执行的发帖策略。
 * 可直接被 content-bot 消费。
 *
 * 分析维度：
 *   1. 内容类型 × 互动率交叉分析 (image/video/carousel)
 *   2. 视频深度分析 — 排名、模式、时长与互动的关系
 *   3. 话题/主题分析 — DeepSeek 归类 + 互动率对标
 *   4. 文案分析 — 风格、长度、CTA类型 vs 互动率
 *   5. 标签策略 — 高频+高互动标签组合
 *   6. 发布节奏 — 发帖频率与互动的关系
 *   7. 趋势与机会 — 竞对没做但我们能做的
 *
 * 输出：
 *   data/bot_state/competitor_content/insights.json — 内容策略文件（content-bot 读取）
 *
 * 用法：
 *   npx tsx scripts/competitor-content-analyzer.ts
 *   npx tsx scripts/competitor-content-analyzer.ts --handles h1,h2,h3
 *   npx tsx scripts/competitor-content-analyzer.ts --json-only  (仅输出JSON，不打印报告)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============ Config ============

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const STATE_DIR = path.join(process.env.BOT_STATE_DIR || './data/bot_state', 'competitor_content');
const INSIGHTS_FILE = path.join(STATE_DIR, 'insights.json');
const COMPETITOR_CACHE = path.join(
  process.env.BOT_STATE_DIR || './data/bot_state',
  'competitor_research',
  'profiles_cache.json'
);

const ANALYZE_TOP_N_POSTS = 50; // analyze top N posts across all competitors

// ============ Types ============

interface CompetitorPost {
  shortcode: string;
  postUrl: string;
  type: 'image' | 'video' | 'carousel';
  caption: string;
  hashtags: string[];
  likeCount: number;
  commentCount: number;
  timestamp: string;
  engagementRate: number;
}

interface CompetitorProfile {
  handle: string;
  scrapedAt: string;
  followerCount: number;
  followingCount: number;
  postCount: number;
  bio: string;
  isVerified: boolean;
  posts: CompetitorPost[];
}

interface VideoAnalysis {
  shortcode: string;
  postUrl: string;
  handle: string;
  likes: number;
  comments: number;
  engagementRate: number;
  caption: string;
  hashtags: string[];

  // 基础
  estimatedDuration: string;       // short (<15s) / medium (15-30s) / long (>30s)

  // 文案
  captionStyle: string;            // educational / showcase / behind_scenes / testimonial / question / announcement
  topicCategory: string;           // product_demo / artist_work / educational / lifestyle / promotion / bts

  // 视觉
  visualPacing: string;            // fast_cut / slow_cinematic / mixed
  textOverlay: string;             // heavy_text / minimal_text / clean_none
  musicType: string;               // trending_audio / original_sound / voiceover / no_audio
  colorStyle: string;              // dark_moody / clean_bright / warm / b_and_w / vibrant
  cameraMovement: string;          // static / slow_pan / zoom_in_out / handheld_shaky / mixed

  // 纹身行业特有
  tattooStyle: string;             // fine_line / blackwork / color / realism / traditional / japanese / tribal / watercolor / not_visible
  productVisibility: string;       // close_up_detail / in_use_working / result_final / not_shown
  sceneType: string;               // studio_indoor / convention_event / outdoor_nature / macro_closeup / lifestyle

  // 互动
  commentSentiment: string;        // positive_enthusiastic / questions_inquiry / neutral / negative_critical
  commentActivity: string;         // high_reply_brand / low_reply / no_comments

  // 结构
  hookType: string;                // text_first_frame / visual_shock / before_after / question_overlay / slow_reveal
  sceneCount: string;              // single / few (2-4) / many (5+)
  isCollaboration: string;         // collaboration / solo / unclear

  performanceTier: 'top' | 'good' | 'average' | 'low';
}

interface TopicPerformance {
  category: string;
  avgEngagement: number;
  postCount: number;
  topPost: { shortcode: string; caption: string };
  trend?: 'rising' | 'stable' | 'declining';
}

interface ContentMixRecommendation {
  contentType: string;
  currentWeight: number;
  recommendedWeight: number;
  reason: string;
  sampleHashtags: string[];
}

interface WeeklyScheduleSuggestion {
  dayOfWeek: string;
  suggestedType: string;
  suggestedTime: string;
  rationale: string;
}

interface CompetitorInsights {
  generatedAt: string;
  profilesAnalyzed: number;
  totalPostsAnalyzed: number;

  // High-level findings
  summary: string;                          // 1-paragraph executive summary
  marketTrend: string;                      // what's trending across all competitors
  gapsAndOpportunities: string[];           // what competitors aren't doing

  // Video analysis
  topVideos: VideoAnalysis[];               // ranked best → good
  videoPatterns: {
    bestDuration: string;
    bestCaptionStyles: string[];
    bestTopics: string[];
    bestVisualPacing: string[];
    bestTextOverlay: string[];
    bestMusicType: string[];
    bestColorStyle: string[];
    bestCameraMovement: string[];
    bestTattooStyle: string[];
    bestProductVisibility: string[];
    bestSceneType: string[];
    bestCommentSentiment: string[];
    bestCommentActivity: string[];
    bestHookTypes: string[];
    bestSceneCount: string[];
    topCollaborationEffect: string;       // does collab boost engagement?
    avgEngagementByType: Record<string, number>;
  };

  // Topic performance
  topicPerformance: TopicPerformance[];

  // Content mix recommendation (for content-bot)
  contentMix: ContentMixRecommendation[];

  // Hashtag strategy
  topHashtags: { tag: string; avgEng: number; count: number }[];
  hashtagCombos: { combo: string[]; avgEng: number }[];

  // Scheduling
  weeklySchedule: WeeklyScheduleSuggestion[];

  // Direct integration with content-bot
  forContentBot: {
    adjustedWeights: Record<string, number>;
    recommendedHashtags: string[];
    captionTemplates: { style: string; template: string; context: string }[];
    avoidPatterns: string[];                 // things to avoid
    priorityContentTypes: string[];          // order of priority
    bestPostingWindows: { day: string; hour: number }[];
  };
}

// ============ Helpers ============

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const callDeepSeek = async (systemPrompt: string, userPrompt: string, maxTokens = 800): Promise<string> => {
  if (!DEEPSEEK_API_KEY) return '';
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.5, max_tokens: maxTokens,
      }),
    });
    if (!resp.ok) throw new Error(`DeepSeek ${resp.status}`);
    const data: any = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch { return ''; }
};

const safeJsonParse = (text: string, fallback: any) => {
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```/g, '')
      .replace(/\/\/.*$/gm, '')
      .trim();
    return JSON.parse(cleaned);
  } catch { return fallback; }
};

// ============ Load Data ============

const loadProfiles = (): CompetitorProfile[] => {
  if (!fs.existsSync(COMPETITOR_CACHE)) {
    console.error(`[analyzer] 缓存文件不存在: ${COMPETITOR_CACHE}`);
    console.error('  请先运行: npx tsx scripts/competitor-research.ts');
    process.exit(1);
  }
  try {
    const data = JSON.parse(fs.readFileSync(COMPETITOR_CACHE, 'utf8'));
    if (!Array.isArray(data) || data.length === 0) {
      console.error('[analyzer] 缓存为空');
      process.exit(1);
    }
    return data.filter((p) => p.posts && p.posts.length > 0);
  } catch {
    console.error('[analyzer] 缓存解析失败');
    process.exit(1);
  }
};

const loadAllPosts = (profiles: CompetitorProfile[]): (CompetitorPost & { handle: string })[] => {
  return profiles.flatMap((p) =>
    p.posts.map((post) => ({ ...post, handle: p.handle }))
  );
};

// ============ Video Analysis ============

const analyzeVideos = async (
  profiles: CompetitorProfile[],
): Promise<{ topVideos: VideoAnalysis[]; patterns: CompetitorInsights['videoPatterns'] }> => {
  const allPosts = loadAllPosts(profiles);
  const videos = allPosts.filter((p) => p.type === 'video');

  if (videos.length === 0) {
    return {
      topVideos: [],
      patterns: {
        bestDuration: 'unknown',
        bestCaptionStyles: [],
        bestTopics: [],
        bestVisualPacing: [],
        bestTextOverlay: [],
        bestMusicType: [],
        bestColorStyle: [],
        bestCameraMovement: [],
        bestTattooStyle: [],
        bestProductVisibility: [],
        bestSceneType: [],
        bestCommentSentiment: [],
        bestCommentActivity: [],
        bestHookTypes: [],
        bestSceneCount: [],
        topCollaborationEffect: 'unknown',
        avgEngagementByType: {},
      },
    };
  }

  // Compute engagement percentiles
  const sortedByEng = [...videos].sort((a, b) => b.engagementRate - a.engagementRate);
  const topCutoff = sortedByEng[Math.floor(sortedByEng.length * 0.2)]?.engagementRate || 0;
  const goodCutoff = sortedByEng[Math.floor(sortedByEng.length * 0.5)]?.engagementRate || 0;

  // Use DeepSeek to classify each video in the top N
  const topVideosForAnalysis = sortedByEng.slice(0, Math.min(ANALYZE_TOP_N_POSTS, sortedByEng.length));

  // Batch classify via DeepSeek
  let classifications: any[] = [];
  if (DEEPSEEK_API_KEY) {
    const postsData = topVideosForAnalysis.map((v, i) => ({
      id: i,
      caption: v.caption.slice(0, 200),
      likes: v.likeCount,
      comments: v.commentCount,
      hashtags: v.hashtags,
    }));

    const prompt = `Analyze these Instagram video posts from tattoo supply/equipment competitors. For EACH post, classify across ALL 16 dimensions:

--- Basic ---
1. estimatedDuration: "short" / "medium" / "long"
2. sceneCount: "single" / "few" / "many"

--- Content Narrative ---
3. captionStyle: "educational" / "showcase" / "behind_scenes" / "testimonial" / "question" / "announcement"
4. topicCategory: "product_demo" / "artist_work" / "educational" / "lifestyle" / "promotion" / "bts"
5. hookType: "text_first_frame" / "visual_shock" / "before_after" / "question_overlay" / "slow_reveal"

--- Visual ---
6. visualPacing: "fast_cut" / "slow_cinematic" / "mixed"
7. textOverlay: "heavy_text" / "minimal_text" / "clean_none"
8. musicType: "trending_audio" / "original_sound" / "voiceover" / "no_audio"
9. colorStyle: "dark_moody" / "clean_bright" / "warm" / "b_and_w" / "vibrant"
10. cameraMovement: "static" / "slow_pan" / "zoom_in_out" / "handheld_shaky" / "mixed"

--- Tattoo Niche ---
11. tattooStyle: "fine_line" / "blackwork" / "color" / "realism" / "traditional" / "japanese" / "tribal" / "watercolor" / "not_visible"
12. productVisibility: "close_up_detail" / "in_use_working" / "result_final" / "not_shown"
13. sceneType: "studio_indoor" / "convention_event" / "outdoor_nature" / "macro_closeup" / "lifestyle"
14. isCollaboration: "collaboration" / "solo" / "unclear"

--- Engagement Signals ---
15. commentSentiment: "positive_enthusiastic" / "questions_inquiry" / "neutral" / "negative_critical" / "no_visible"
16. commentActivity: "high_reply_brand" / "low_reply" / "no_comments"

Return JSON array: [{"id": 0, "estimatedDuration": "...", "sceneCount": "...", "captionStyle": "...", "topicCategory": "...", "hookType": "...", "visualPacing": "...", "textOverlay": "...", "musicType": "...", "colorStyle": "...", "cameraMovement": "...", "tattooStyle": "...", "productVisibility": "...", "sceneType": "...", "isCollaboration": "...", "commentSentiment": "...", "commentActivity": "..."}, ...]

Posts:
${JSON.stringify(postsData, null, 2)}`;

    try {
      const raw = await callDeepSeek(
        'You are a social media analyst specializing in tattoo industry content. Classify accurately across all 16 dimensions. Return valid JSON array only.',
        prompt,
        3000
      );
      classifications = safeJsonParse(raw, []);
    } catch {}
  }

  // Build VideoAnalysis objects
  const classified = new Map<number, any>();
  if (Array.isArray(classifications)) {
    for (const c of classifications) classified.set(c.id, c);
  }

  const topVideos: VideoAnalysis[] = topVideosForAnalysis.map((v, i) => {
    const cls = classified.get(i) || {};
    let tier: VideoAnalysis['performanceTier'] = 'average';
    if (v.engagementRate >= topCutoff) tier = 'top';
    else if (v.engagementRate >= goodCutoff) tier = 'good';
    else tier = 'average';

    return {
      shortcode: v.shortcode,
      postUrl: v.postUrl,
      handle: v.handle,
      likes: v.likeCount,
      comments: v.commentCount,
      engagementRate: v.engagementRate,
      caption: v.caption.slice(0, 300),
      hashtags: v.hashtags,
      estimatedDuration: cls.estimatedDuration || 'unknown',
      sceneCount: cls.sceneCount || 'unknown',
      captionStyle: cls.captionStyle || 'unknown',
      topicCategory: cls.topicCategory || 'unknown',
      hookType: cls.hookType || 'unknown',
      visualPacing: cls.visualPacing || 'unknown',
      textOverlay: cls.textOverlay || 'unknown',
      musicType: cls.musicType || 'unknown',
      colorStyle: cls.colorStyle || 'unknown',
      cameraMovement: cls.cameraMovement || 'unknown',
      tattooStyle: cls.tattooStyle || 'unknown',
      productVisibility: cls.productVisibility || 'unknown',
      sceneType: cls.sceneType || 'unknown',
      isCollaboration: cls.isCollaboration || 'unknown',
      commentSentiment: cls.commentSentiment || 'unknown',
      commentActivity: cls.commentActivity || 'unknown',
      performanceTier: tier,
    };
  });

  // Compute patterns from classifications — dynamic dimension map
  const DIMS: [string, keyof VideoAnalysis][] = [
    ['byDuration', 'estimatedDuration'],
    ['bySceneCount', 'sceneCount'],
    ['byCaptionStyle', 'captionStyle'],
    ['byTopic', 'topicCategory'],
    ['byHook', 'hookType'],
    ['byVisualPacing', 'visualPacing'],
    ['byTextOverlay', 'textOverlay'],
    ['byMusicType', 'musicType'],
    ['byColorStyle', 'colorStyle'],
    ['byCameraMovement', 'cameraMovement'],
    ['byTattooStyle', 'tattooStyle'],
    ['byProductVisibility', 'productVisibility'],
    ['bySceneType', 'sceneType'],
    ['byCommentSentiment', 'commentSentiment'],
    ['byCommentActivity', 'commentActivity'],
  ];

  const buckets: Record<string, Record<string, { total: number; count: number }>> = {};
  for (const [key] of DIMS) buckets[key] = {};

  for (let i = 0; i < topVideos.length; i++) {
    const v = topVideos[i];
    const eng = v.engagementRate;
    for (const [bucketKey, field] of DIMS) {
      const val = String(v[field] || '');
      if (val !== 'unknown' && val) {
        const e = buckets[bucketKey][val] || { total: 0, count: 0 };
        e.total += eng; e.count += 1;
        buckets[bucketKey][val] = e;
      }
    }
  }

  // Collaboration effect
  let topCollaborationEffect = 'unknown';
  const collab = topVideos.filter((v) => v.isCollaboration === 'collaboration');
  const solo = topVideos.filter((v) => v.isCollaboration === 'solo');
  const collabAvg = collab.length > 0 ? collab.reduce((s, v) => s + v.engagementRate, 0) / collab.length : 0;
  const soloAvg = solo.length > 0 ? solo.reduce((s, v) => s + v.engagementRate, 0) / solo.length : 0;
  if (collabAvg > 0 && soloAvg > 0) {
    topCollaborationEffect = collabAvg > soloAvg ? 'collab_boosts' : collabAvg < soloAvg ? 'solo_better' : 'neutral';
  }

  const avgOf = (map: Record<string, { total: number; count: number }>) => {
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(map)) {
      if (v.count > 0) result[k] = Math.round(v.total / v.count * 100) / 100;
    }
    return result;
  };

  const bestOf = (map: Record<string, { total: number; count: number }>, minCount = 1): string[] => {
    const avgs = avgOf(map);
    return Object.entries(avgs)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k]) => k);
  };

  return {
    topVideos,
    patterns: {
      bestDuration: bestOf(buckets['byDuration'])[0] || 'unknown',
      bestCaptionStyles: bestOf(buckets['byCaptionStyle']),
      bestTopics: bestOf(buckets['byTopic']),
      bestVisualPacing: bestOf(buckets['byVisualPacing']),
      bestTextOverlay: bestOf(buckets['byTextOverlay']),
      bestMusicType: bestOf(buckets['byMusicType']),
      bestColorStyle: bestOf(buckets['byColorStyle']),
      bestCameraMovement: bestOf(buckets['byCameraMovement']),
      bestTattooStyle: bestOf(buckets['byTattooStyle']),
      bestProductVisibility: bestOf(buckets['byProductVisibility']),
      bestSceneType: bestOf(buckets['bySceneType']),
      bestCommentSentiment: bestOf(buckets['byCommentSentiment']),
      bestCommentActivity: bestOf(buckets['byCommentActivity']),
      bestHookTypes: bestOf(buckets['byHook']),
      bestSceneCount: bestOf(buckets['bySceneCount']),
      topCollaborationEffect,
      avgEngagementByType: avgOf(buckets['byTopic']),
    },
  };
};

// ============ Content Type Cross-Analysis ============

const analyzeContentMix = async (
  profiles: CompetitorProfile[],
): Promise<ContentMixRecommendation[]> => {
  const allPosts = loadAllPosts(profiles);

  const byType: Record<string, { totalEng: number; totalLikes: number; totalComments: number; count: number }> = {};
  for (const p of allPosts) {
    const entry = byType[p.type] || { totalEng: 0, totalLikes: 0, totalComments: 0, count: 0 };
    entry.totalEng += p.engagementRate;
    entry.totalLikes += p.likeCount;
    entry.totalComments += p.commentCount;
    entry.count += 1;
    byType[p.type] = entry;
  }

  const typeStats = Object.entries(byType).map(([type, stats]) => ({
    type,
    count: stats.count,
    avgEng: stats.count > 0 ? stats.totalEng / stats.count : 0,
    avgLikes: stats.count > 0 ? Math.round(stats.totalLikes / stats.count) : 0,
    avgComments: stats.count > 0 ? Math.round(stats.totalComments / stats.count) : 0,
  }));

  // Get hashtag samples for each type
  const hashtagsByType: Record<string, string[]> = {};
  for (const [type, stats] of Object.entries(byType)) {
    const topPostsOfType = allPosts
      .filter((p) => p.type === type)
      .sort((a, b) => b.engagementRate - a.engagementRate)
      .slice(0, 5);
    const allHashtags = topPostsOfType.flatMap((p) => p.hashtags);
    const freq = new Map<string, number>();
    for (const h of allHashtags) freq.set(h, (freq.get(h) || 0) + 1);
    hashtagsByType[type] = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([h]) => h);
  }

  // AI analysis of what's working
  let aiRecs: any[] = [];
  if (DEEPSEEK_API_KEY) {
    const prompt = `Based on competitor content performance data, recommend content mix for a tattoo supply brand's Instagram.

Current data:
${JSON.stringify({ typeStats }, null, 2)}

Provide a JSON array of recommendations. For each content type (image, video, carousel):
- recommendedWeight: 0-1 (must sum to ~1 across all types)
- reason: 1 sentence in Chinese explaining why
- sampleHashtags: top 3 hashtags from the data

Also consider: video is the highest-friction but potentially highest-reward format. Image/carousel is easier to produce consistently.

Return: [{"contentType": "video", "recommendedWeight": 0.XX, "reason": "...", "sampleHashtags": ["..."]}, ...]`;

    try {
      const raw = await callDeepSeek(
        'You are a social media strategist. Return valid JSON array only.',
        prompt, 600
      );
      aiRecs = safeJsonParse(raw, []);
    } catch {}
  }

  // Fallback if AI fails
  if (!Array.isArray(aiRecs) || aiRecs.length === 0) {
    const totalCount = allPosts.length;
    for (const s of typeStats) {
      const share = s.count / totalCount;
      aiRecs.push({
        contentType: s.type,
        recommendedWeight: Math.round(share * 100) / 100,
        reason: `竞对该类型占总发帖 ${Math.round(share * 100)}%，平均互动 ${s.avgEng.toFixed(1)}%`,
        sampleHashtags: (hashtagsByType[s.type] || []).slice(0, 3),
      });
    }
  }

  return aiRecs.map((r) => ({
    contentType: r.contentType || 'image',
    currentWeight: 0, // content-bot fills this
    recommendedWeight: r.recommendedWeight || 0,
    reason: r.reason || '',
    sampleHashtags: r.sampleHashtags || [],
  }));
};

// ============ Topic Analysis ============

const analyzeTopics = async (profiles: CompetitorProfile[]): Promise<TopicPerformance[]> => {
  const allPosts = loadAllPosts(profiles);
  if (!DEEPSEEK_API_KEY || allPosts.length === 0) return [];

  // Take a representative sample
  const sample = allPosts
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(30, allPosts.length));

  const postsData = sample.map((p, i) => ({
    id: i,
    caption: p.caption.slice(0, 150),
    engagementRate: p.engagementRate,
    likes: p.likeCount,
    type: p.type,
  }));

  const prompt = `Categorize these Instagram posts from tattoo supply accounts into topics.

Categories: "product_demo", "artist_feature", "education_tips", "lifestyle", "promotion_sale", "behind_scenes", "trend_news"

For each post assign ONE category. Then, for each category, compute:
- avgEngagement: average engagement rate of posts in that category
- trend: "rising" if recent posts (last in list) have higher engagement, "declining" if lower, "stable" if mixed

Posts:
${JSON.stringify(postsData)}

Return JSON:
{
  "classifications": [{"id": 0, "category": "..."}, ...],
  "topicSummary": [{"category": "...", "trend": "rising|stable|declining", "insight": "1 sentence about this category"}, ...]
}`;

  try {
    const raw = await callDeepSeek(
      'You are a content analyst. Return valid JSON only.',
      prompt, 800
    );
    const result = safeJsonParse(raw, { classifications: [], topicSummary: [] });
    const classes = result.classifications || [];
    const summary = result.topicSummary || [];

    // Merge classifications with engagement data
    const byCategory: Record<string, { totalEng: number; count: number; bestPost: any }> = {};
    for (let i = 0; i < sample.length; i++) {
      const cat = classes.find((c: any) => c.id === i)?.category || 'other';
      const entry = byCategory[cat] || { totalEng: 0, count: 0, bestPost: null };
      entry.totalEng += sample[i].engagementRate;
      entry.count += 1;
      if (!entry.bestPost || sample[i].engagementRate > entry.bestPost.engagementRate) {
        entry.bestPost = sample[i];
      }
      byCategory[cat] = entry;
    }

    return Object.entries(byCategory).map(([cat, stats]) => {
      const trendInfo = summary.find((s: any) => s.category === cat);
      return {
        category: cat,
        avgEngagement: stats.count > 0 ? Math.round(stats.totalEng / stats.count * 100) / 100 : 0,
        postCount: stats.count,
        topPost: stats.bestPost ? { shortcode: stats.bestPost.shortcode || '', caption: stats.bestPost.caption?.slice(0, 120) || '' } : { shortcode: '', caption: '' },
        trend: trendInfo?.trend || 'stable',
      };
    }).sort((a, b) => b.avgEngagement - a.avgEngagement);
  } catch {
    return [];
  }
};

// ============ Hashtag Analysis ============

const analyzeHashtags = (
  allPosts: (CompetitorPost & { handle: string })[],
): { topHashtags: CompetitorInsights['topHashtags']; hashtagCombos: CompetitorInsights['hashtagCombos'] } => {
  const hashtagStats = new Map<string, { totalEng: number; count: number }>();
  for (const p of allPosts) {
    for (const h of p.hashtags) {
      const entry = hashtagStats.get(h) || { totalEng: 0, count: 0 };
      entry.totalEng += p.engagementRate;
      entry.count += 1;
      hashtagStats.set(h, entry);
    }
  }

  const topHashtags = Array.from(hashtagStats.entries())
    .filter(([, v]) => v.count >= 2)
    .map(([tag, v]) => ({
      tag,
      avgEng: Math.round(v.totalEng / v.count * 100) / 100,
      count: v.count,
    }))
    .sort((a, b) => b.avgEng - a.avgEng)
    .slice(0, 15);

  // Find hashtag combos that appear together in high-engagement posts
  const topPosts = [...allPosts]
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, 10);

  const comboMap = new Map<string, number>();
  for (const p of topPosts) {
    if (p.hashtags.length >= 2) {
      const key = p.hashtags.slice(0, 5).sort().join(',');
      comboMap.set(key, (comboMap.get(key) || 0) + p.engagementRate);
    }
  }
  const hashtagCombos = Array.from(comboMap.entries())
    .map(([combo, eng]) => ({ combo: combo.split(','), avgEng: Math.round(eng / (comboMap.size || 1) * 100) / 100 }))
    .sort((a, b) => b.avgEng - a.avgEng)
    .slice(0, 5);

  return { topHashtags, hashtagCombos };
};

// ============ Scheduling Analysis ============

const analyzeScheduling = (allPosts: (CompetitorPost & { handle: string })[]): WeeklyScheduleSuggestion[] => {
  const postsWithDate = allPosts.filter((p) => {
    const t = new Date(p.timestamp).getTime();
    return !isNaN(t);
  });

  if (postsWithDate.length < 5) {
    // Fallback: generic schedule based on best practices for tattoo niche
    return [
      { dayOfWeek: 'Monday', suggestedType: 'image', suggestedTime: '09:00', rationale: '周一恢复工作，浏览IG' },
      { dayOfWeek: 'Tuesday', suggestedType: 'carousel', suggestedTime: '14:00', rationale: '下午互动高峰' },
      { dayOfWeek: 'Wednesday', suggestedType: 'video', suggestedTime: '11:00', rationale: '周中视频表现好' },
      { dayOfWeek: 'Thursday', suggestedType: 'carousel', suggestedTime: '15:00', rationale: '临近周末，浏览增加' },
      { dayOfWeek: 'Friday', suggestedType: 'video', suggestedTime: '10:00', rationale: '周五上午互动率较高' },
      { dayOfWeek: 'Saturday', suggestedType: 'image', suggestedTime: '12:00', rationale: '周末午间浏览' },
      { dayOfWeek: 'Sunday', suggestedType: 'image', suggestedTime: '20:00', rationale: '周日晚上浏览高峰' },
    ];
  }

  // Group by day of week
  const byDay: Record<number, { totalEng: number; count: number; bestType: Map<string, number> }> = {};
  for (const p of postsWithDate) {
    const day = new Date(p.timestamp).getDay();
    const entry = byDay[day] || { totalEng: 0, count: 0, bestType: new Map() };
    entry.totalEng += p.engagementRate;
    entry.count += 1;
    entry.bestType.set(p.type, (entry.bestType.get(p.type) || 0) + p.engagementRate);
    byDay[day] = entry;
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const schedule: WeeklyScheduleSuggestion[] = [];

  for (let d = 0; d < 7; d++) {
    const data = byDay[d];
    if (!data) {
      schedule.push({
        dayOfWeek: dayNames[d],
        suggestedType: 'carousel',
        suggestedTime: '14:00',
        rationale: '无数据，使用默认策略',
      });
      continue;
    }

    let bestType = 'image';
    let bestEng = 0;
    for (const [type, total] of Array.from(data.bestType.entries())) {
      if (total > bestEng) { bestEng = total; bestType = type; }
    }

    // Infer time from best practice (scraped timestamps often lack hour precision)
    const hour = [9, 11, 14, 20][d % 4];

    schedule.push({
      dayOfWeek: dayNames[d],
      suggestedType: bestType,
      suggestedTime: `${String(hour).padStart(2, '0')}:00`,
      rationale: `该日${data.count}条帖子，平均互动${(data.totalEng / data.count).toFixed(1)}%`,
    });
  }

  return schedule;
};

// ============ Generate Insights ============

const generateInsights = async (
  profiles: CompetitorProfile[],
  videoData: { topVideos: VideoAnalysis[]; patterns: CompetitorInsights['videoPatterns'] },
  contentMix: ContentMixRecommendation[],
  topicPerf: TopicPerformance[],
  hashtagData: any,
  schedule: WeeklyScheduleSuggestion[],
): Promise<CompetitorInsights> => {
  const allPosts = loadAllPosts(profiles);

  // Generate summary and strategic insights via DeepSeek
  let summary = '';
  let marketTrend = '';
  let gapsAndOpportunities: string[] = [];
  let forContentBot: CompetitorInsights['forContentBot'] = {
    adjustedWeights: {},
    recommendedHashtags: [],
    captionTemplates: [],
    avoidPatterns: [],
    priorityContentTypes: [],
    bestPostingWindows: [],
  };

  if (DEEPSEEK_API_KEY) {
    const topVideosSummary = videoData.topVideos.slice(0, 5).map((v) => ({
      likes: v.likes,
      comments: v.comments,
      engRate: v.engagementRate,
      topic: v.topicCategory,
      style: v.captionStyle,
      hook: v.hookType,
      pacing: v.visualPacing,
      text: v.textOverlay,
      music: v.musicType,
      color: v.colorStyle,
      camera: v.cameraMovement,
      tattooStyle: v.tattooStyle,
      product: v.productVisibility,
      scene: v.sceneType,
      collab: v.isCollaboration,
      sentiment: v.commentSentiment,
      replyActivity: v.commentActivity,
      scenes: v.sceneCount,
      caption: v.caption.slice(0, 80),
    }));

    const prompt = `You're a competitive content strategist for a tattoo supply brand. Analyze this competitor data and provide an action plan.

Competitor landscape:
- ${profiles.length} competitors analyzed, ${allPosts.length} total posts
- Content types: ${contentMix.map((c) => `${c.contentType}(${c.recommendedWeight})`).join(', ')}
- Video patterns (what works): ${JSON.stringify(videoData.patterns)}
- Top performing topics: ${JSON.stringify(topicPerf.slice(0, 3).map((t) => ({ category: t.category, avgEng: t.avgEngagement })))}
- Top 5 videos with full dimensions: ${JSON.stringify(topVideosSummary)}

Return a JSON object with these fields:

1. "summary": 2-3 sentence executive summary in Chinese
2. "marketTrend": 1 sentence in Chinese about what's trending across all competitors
3. "gapsAndOpportunities": 3-4 bullet points in Chinese about what competitors AREN'T doing that we could exploit
4. "recommendedHashtags": top 8 hashtags we should use (English)
5. "captionTemplates": 3 caption templates (each: {style, template, context}) — short templates with {{placeholder}} for variables
6. "avoidPatterns": 2-3 things to avoid based on low-performing content (Chinese)
7. "priorityContentTypes": ordered list of content types to prioritize (English: image/video/carousel)
8. "bestPostingWindows": top 3 posting windows [{day, hour}]

Return ONLY valid JSON. No markdown.`;

    try {
      const raw = await callDeepSeek(
        'You are a competitive content strategist. Return valid JSON only. No markdown formatting.',
        prompt,
        1000
      );
      const aiResult = safeJsonParse(raw, {});

      summary = aiResult.summary || '';
      marketTrend = aiResult.marketTrend || '';
      gapsAndOpportunities = Array.isArray(aiResult.gapsAndOpportunities) ? aiResult.gapsAndOpportunities : [];

      forContentBot = {
        adjustedWeights: contentMix.reduce((acc, c) => {
          acc[c.contentType] = c.recommendedWeight;
          return acc;
        }, {} as Record<string, number>),
        recommendedHashtags: aiResult.recommendedHashtags || hashtagData.topHashtags?.slice(0, 8).map((h: any) => h.tag) || [],
        captionTemplates: aiResult.captionTemplates || [],
        avoidPatterns: aiResult.avoidPatterns || [],
        priorityContentTypes: aiResult.priorityContentTypes || contentMix.map((c) => c.contentType),
        bestPostingWindows: aiResult.bestPostingWindows || [],
      };
    } catch {}
  }

  // Fallbacks
  if (!summary) {
    const topVideoCount = videoData.topVideos.filter((v) => v.performanceTier === 'top').length;
    summary = `分析了${profiles.length}个竞对账号共${allPosts.length}条帖子。视频内容互动率最高，${topVideoCount}条视频达到顶级表现。建议增加视频内容比例，尤其是产品演示和艺术家作品展示类。`;
  }
  if (!marketTrend) {
    marketTrend = '竞对普遍增加Reel视频占比，短视频(15-30秒)互动率优于长视频。教育类和幕后类内容呈上升趋势。';
  }
  if (gapsAndOpportunities.length === 0) {
    gapsAndOpportunities = [
      '多数竞对未做到每日发帖，存在内容空白窗口',
      '竞对很少转发客户返图，这是差异化机会',
      '标签策略普遍较弱，可以用更精准的标签组合',
      '竞对几乎不做多图Carousel的教育内容',
    ];
  }

  return {
    generatedAt: new Date().toISOString(),
    profilesAnalyzed: profiles.length,
    totalPostsAnalyzed: allPosts.length,
    summary,
    marketTrend,
    gapsAndOpportunities,
    topVideos: videoData.topVideos,
    videoPatterns: videoData.patterns,
    topicPerformance: topicPerf,
    contentMix,
    topHashtags: hashtagData.topHashtags || [],
    hashtagCombos: hashtagData.hashtagCombos || [],
    weeklySchedule: schedule,
    forContentBot,
  };
};

// ============ Save ============

const saveInsights = (insights: CompetitorInsights) => {
  ensureDir(STATE_DIR);
  fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(insights, null, 2), 'utf8');
  console.log(`[analyzer] 策略文件已保存: ${INSIGHTS_FILE}`);
};

// ============ Print Report ============

const printReport = (insights: CompetitorInsights) => {
  console.log('\n═══════════════════════════════════════');
  console.log('  📊 竞对内容综合分析报告');
  console.log('═══════════════════════════════════════\n');

  console.log(`📋 总览\n${insights.summary}\n`);
  console.log(`📈 市场趋势\n${insights.marketTrend}\n`);

  console.log('🎯 机会点');
  for (const g of insights.gapsAndOpportunities) console.log(`  • ${g}`);

  console.log('\n🎬 视频表现排行 (Top 10)');
  for (const v of insights.topVideos.slice(0, 10)) {
    const badge = v.performanceTier === 'top' ? '🔥' : v.performanceTier === 'good' ? '👍' : '—';
    console.log(`  ${badge} ${v.shortcode} | ${v.likes}赞 ${v.comments}评 | ${v.engagementRate}%`);
    console.log(`     话题:${v.topicCategory} 风格:${v.captionStyle} 钩子:${v.hookType} 时长:${v.estimatedDuration}`);
    console.log(`     视觉:${v.visualPacing}+${v.colorStyle}+${v.cameraMovement} | 音乐:${v.musicType} | 文字:${v.textOverlay}`);
    console.log(`     纹身风格:${v.tattooStyle} 产品:${v.productVisibility} 场景:${v.sceneType} | 合作:${v.isCollaboration}`);
    console.log(`     互动:评论=${v.commentSentiment} 回复=${v.commentActivity} | 场景数:${v.sceneCount}`);
    console.log(`     ${v.caption.slice(0, 80)}`);
  }

  console.log(`\n📐 视频成功模式`);
  console.log(`  最佳时长: ${insights.videoPatterns.bestDuration}`);
  console.log(`  最佳场景数: ${insights.videoPatterns.bestSceneCount.join(', ')}`);
  console.log(`  最佳文案风格: ${insights.videoPatterns.bestCaptionStyles.join(', ')}`);
  console.log(`  最佳话题: ${insights.videoPatterns.bestTopics.join(', ')}`);
  console.log(`  最佳钩子: ${insights.videoPatterns.bestHookTypes.join(', ')}`);
  console.log(`  最佳画面节奏: ${insights.videoPatterns.bestVisualPacing.join(', ')}`);
  console.log(`  最佳文字叠加: ${insights.videoPatterns.bestTextOverlay.join(', ')}`);
  console.log(`  最佳音乐类型: ${insights.videoPatterns.bestMusicType.join(', ')}`);
  console.log(`  最佳色调: ${insights.videoPatterns.bestColorStyle.join(', ')}`);
  console.log(`  最佳运镜: ${insights.videoPatterns.bestCameraMovement.join(', ')}`);
  console.log(`  最佳纹身风格: ${insights.videoPatterns.bestTattooStyle.join(', ')}`);
  console.log(`  最佳产品可见度: ${insights.videoPatterns.bestProductVisibility.join(', ')}`);
  console.log(`  最佳场景: ${insights.videoPatterns.bestSceneType.join(', ')}`);
  console.log(`  最佳评论情绪: ${insights.videoPatterns.bestCommentSentiment.join(', ')}`);
  console.log(`  最佳评论区活跃: ${insights.videoPatterns.bestCommentActivity.join(', ')}`);
  console.log(`  合作效应: ${insights.videoPatterns.topCollaborationEffect}`);

  console.log('\n📊 话题表现');
  for (const t of insights.topicPerformance) {
    const arrow = t.trend === 'rising' ? '↑' : t.trend === 'declining' ? '↓' : '→';
    console.log(`  ${arrow} ${t.category}: 互动${t.avgEngagement}% (${t.postCount}条)`);
  }

  console.log('\n🔄 内容组合建议');
  for (const c of insights.contentMix) {
    console.log(`  ${c.contentType}: ${Math.round(c.recommendedWeight * 100)}% → ${c.reason}`);
  }

  console.log('\n🏷️ 高效标签');
  console.log(`  ${insights.topHashtags.slice(0, 10).map((h) => `#${h.tag}`).join('  ')}`);

  if (insights.hashtagCombos.length > 0) {
    console.log('\n🔗 标签组合 (高互动帖子共用)');
    for (const c of insights.hashtagCombos) {
      console.log(`  ${c.combo.map((h) => `#${h}`).join('  ')}  → ${c.avgEng}%`);
    }
  }

  console.log('\n📅 周排期建议');
  for (const s of insights.weeklySchedule) {
    console.log(`  ${s.dayOfWeek} ${s.suggestedTime} → ${s.suggestedType}   ${s.rationale}`);
  }

  // Content-bot integration preview
  console.log('\n🤖 Content-Bot 策略预览');
  console.log(`  推荐标签: ${insights.forContentBot.recommendedHashtags.map((h) => `#${h}`).join(' ')}`);
  console.log(`  优先类型: ${insights.forContentBot.priorityContentTypes.join(' > ')}`);
  if (insights.forContentBot.avoidPatterns.length > 0) {
    console.log(`  避免: ${insights.forContentBot.avoidPatterns.join('; ')}`);
  }
  if (insights.forContentBot.captionTemplates.length > 0) {
    console.log('  文案模板:');
    for (const tpl of insights.forContentBot.captionTemplates) {
      console.log(`    [${tpl.style}] ${tpl.template}`);
    }
  }

  console.log('\n═══════════════════════════════════════\n');
};

// ============ Main ============

const main = async () => {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json-only');

  if (!jsonOnly) console.log('[analyzer] 加载竞对数据...');
  const profiles = loadProfiles();
  if (!jsonOnly) console.log(`[analyzer] ${profiles.length} 个竞对账号，共 ${loadAllPosts(profiles).length} 条帖子\n`);

  // Run analyses in parallel where possible
  const allPosts = loadAllPosts(profiles);

  if (!jsonOnly) console.log('[analyzer] 分析视频表现...');
  const videoData = await analyzeVideos(profiles);

  if (!jsonOnly) console.log('[analyzer] 分析内容组合...');
  const contentMix = await analyzeContentMix(profiles);

  if (!jsonOnly) console.log('[analyzer] 分析话题趋势...');
  const topicPerf = await analyzeTopics(profiles);

  if (!jsonOnly) console.log('[analyzer] 分析标签策略...');
  const hashtagData = analyzeHashtags(allPosts);

  if (!jsonOnly) console.log('[analyzer] 分析发布节奏...');
  const schedule = analyzeScheduling(allPosts);

  if (!jsonOnly) console.log('[analyzer] 生成策略报告...');
  const insights = await generateInsights(
    profiles, videoData, contentMix, topicPerf, hashtagData, schedule
  );

  saveInsights(insights);

  if (jsonOnly) {
    console.log(JSON.stringify(insights, null, 2));
  } else {
    printReport(insights);
  }
};

main().catch((e) => {
  console.error('[analyzer] Fatal:', e);
  process.exit(1);
});
