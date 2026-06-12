/**
 * Reddit Monitor — AI-powered brand/product mention detection on Reddit.
 *
 * No keyword matching — all posts go through AI semantic classification.
 *
 * 用法: npx tsx scripts/reddit-monitor.ts
 *
 * ENV:
 *   REDDIT_SUBREDDITS=tattoo,tattoos,tattooartists  (逗号分隔)
 *   REDDIT_POSTS_PER_SUB=25                           (每个 subreddit 拉取数)
 *   REDDIT_SCAN_MODE=both                             (hot | new | both)
 */

import 'dotenv/config';
import {
  type RawThread,
  classifyThreads,
  routeToDatabase,
  printClassificationSummary,
  loadSeenUrls,
  saveSeenUrls,
} from './intel-classifier';

const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');

// Proxy auto-detection
const COMMON_PROXY_PORTS = [10809, 7890, 1080, 1087, 8118, 7891, 9090];
let PROXY_URL = (process.env.REDDIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
if (!PROXY_URL) {
  PROXY_URL = `http://127.0.0.1:10809`;
  console.log(`[reddit-monitor] Auto-detected proxy: ${PROXY_URL} (set REDDIT_PROXY to override)`);
}

const fetchWithProxy = async (url: string, opts: RequestInit = {}): Promise<Response> => {
  try {
    const { ProxyAgent } = await import('undici');
    const agent = new ProxyAgent(PROXY_URL);
    return fetch(url, { ...opts, dispatcher: agent } as any);
  } catch {
    return fetch(url, opts);
  }
};

const SUBREDDITS = (process.env.REDDIT_SUBREDDITS || 'tattoo,tattoos,tattooartists,irezumi,tattooapprentice').split(',').map(s => s.trim().replace(/^r\//, ''));
const POSTS_PER_SUB = Number(process.env.REDDIT_POSTS_PER_SUB || 25);
const SCAN_MODE = process.env.REDDIT_SCAN_MODE || 'both';

const REDDIT_USER_AGENT = 'InkFlow-CompetitiveMonitor/1.0 (by /u/tattoo_research_bot)';
const SEEN_URLS = loadSeenUrls();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  author: string;
  permalink: string;
  url: string;
  created_utc: number;
  score: number;
  num_comments: number;
  subreddit: string;
}

// ============ Reddit API ============

const fetchSubredditPosts = async (subreddit: string, sort: 'hot' | 'new'): Promise<RedditPost[]> => {
  const apiUrl = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${POSTS_PER_SUB}`;
  try {
    const resp = await fetchWithProxy(apiUrl, {
      headers: { 'User-Agent': REDDIT_USER_AGENT },
    });
    if (!resp.ok) {
      console.error(`  Reddit API ${resp.status} for r/${subreddit}`);
      return [];
    }
    const data: any = await resp.json();
    const children = data?.data?.children || [];
    return children.map((c: any) => {
      const d = c.data;
      return {
        id: d.id,
        title: d.title || '',
        selftext: d.selftext || '',
        author: d.author || '[deleted]',
        permalink: `https://www.reddit.com${d.permalink}`,
        url: d.url || '',
        created_utc: d.created_utc || 0,
        score: d.score || 0,
        num_comments: d.num_comments || 0,
        subreddit: d.subreddit || subreddit,
      };
    });
  } catch (e: any) {
    console.error(`  Reddit fetch error: ${e.message}`);
    return [];
  }
};

// ============ Noise Filters ============

const isNoiseContent = (text: string): { noisy: boolean; reason: string } => {
  const t = text.trim();
  if (!t || t.length < 30) return { noisy: true, reason: 'too_short' };
  if (/<[a-zA-Z]+\b[^>]*>/.test(t) || /\.load\(|googletagmanager|\.js\b/.test(t))
    return { noisy: true, reason: 'html_or_script' };
  if (/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}🔥❤️💯]+$/u.test(t))
    return { noisy: true, reason: 'emoji_only' };
  if (/^https?:\/\/\S+$/.test(t))
    return { noisy: true, reason: 'link_only' };
  if (/^\[removed\]$|^\[deleted\]$/i.test(t))
    return { noisy: true, reason: 'removed_or_deleted' };
  return { noisy: false, reason: '' };
};

// ============ Main ============

const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Reddit Brand Monitor (AI-Powered)  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Subreddits: r/${SUBREDDITS.join(', r/')}`);
  console.log(`  Mode: ${SCAN_MODE} | Posts/sub: ${POSTS_PER_SUB}`);

  let allThreads: RawThread[] = [];

  for (const sub of SUBREDDITS) {
    console.log(`\n--- r/${sub} ---`);

    const allPosts: RedditPost[] = [];

    if (SCAN_MODE === 'both' || SCAN_MODE === 'hot') {
      const hotPosts = await fetchSubredditPosts(sub, 'hot');
      allPosts.push(...hotPosts);
    }
    if (SCAN_MODE === 'both' || SCAN_MODE === 'new') {
      const newPosts = await fetchSubredditPosts(sub, 'new');
      allPosts.push(...newPosts);
    }

    // Deduplicate by post id
    const seen = new Set<string>();
    const uniquePosts = allPosts.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    console.log(`  Fetched ${uniquePosts.length} unique posts`);

    let skippedNoise = 0;
    for (const post of uniquePosts) {
      // Skip already-seen URLs
      if (SEEN_URLS.has(post.permalink)) continue;

      const contentText = post.selftext || post.title;
      const noise = isNoiseContent(contentText);
      if (noise.noisy) { skippedNoise++; continue; }

      SEEN_URLS.add(post.permalink);

      allThreads.push({
        forum: `reddit_r/${post.subreddit}`,
        title: post.title,
        content: contentText.slice(0, 2000),
        author: post.author,
        date: new Date(post.created_utc * 1000).toISOString(),
        url: post.permalink,
        replies: [],
      });
    }
    if (skippedNoise > 0) console.log(`  ⊘ ${skippedNoise} noise-filtered`);

    await sleep(1500); // Between subreddits
  }

  if (!allThreads.length) {
    console.log('\n⚠ No new posts to classify.');
    saveSeenUrls(SEEN_URLS);
    return;
  }

  console.log(`\n[ai] Classifying ${allThreads.length} posts...`);
  const classifications = await classifyThreads(allThreads);

  printClassificationSummary(allThreads, classifications);

  routeToDatabase(allThreads, classifications, 'reddit');

  saveSeenUrls(SEEN_URLS);
  console.log(`\n  Cache: ${SEEN_URLS.size} URLs saved`);
};

main().catch((e) => {
  console.error('[reddit-monitor] Fatal:', e?.message || e);
  process.exit(1);
});
