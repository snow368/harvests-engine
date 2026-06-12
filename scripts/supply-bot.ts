/**
 * supply-bot — 品牌情报 + 评论生成管道
 *
 * 模块 A: 评论生成器
 *   generateSupplyComment() → bot-worker 调用，替代 comment-generator.ts
 *   抓取竞对品牌数据训练 → 品牌口吻评论
 *
 * 模块 B: 品牌推新分析 (CLI 模式)
 *   分析竞对品牌推新策略/内容方向 → 报告
 */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

// ────────────────────────────────────────────────────────────
// 模块 A — 评论生成器
// ────────────────────────────────────────────────────────────

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const BRAND_DATASET_FILE = 'data/brand_captions_dataset.json';
const ARTIST_DATASET_FILE = 'data/artist_captions_dataset.json';

interface BrandPost {
  brand: string;
  content: string;
  category: string;
  comments: Array<{ username: string; text: string; likes: number }>;
}

// 品牌 few-shot 样本
function loadBrandDataset(): BrandPost[] {
  if (!fs.existsSync(BRAND_DATASET_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(BRAND_DATASET_FILE, 'utf8')); }
  catch { return []; }
}

function pickFewShot(brand: string, count = 3): BrandPost[] {
  const all = loadBrandDataset();
  const brandPosts = all.filter(p => p.brand === brand);
  const shuffled = [...brandPosts].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// 4 种评论风格
const STYLE_GUIDES: Record<string, string> = {
  technical: `Comment style: PROFESSIONAL CRAFTSMANSHIP
- Focus on technique: linework, shading, saturation, contrast, composition
- Sound like a knowledgeable industry professional`,
  praise: `Comment style: SHORT ENTHUSIASTIC PRAISE
- Quick, energetic compliment
- 4-15 words, punchy
- Sound genuinely excited`,
  engagement: `Comment style: ENGAGEMENT QUESTION
- Structure: Start with brief compliment, then ask a natural question
- Choose ONE question type below based on the post caption context:

  TYPE A — Process/Time: when caption mentions complexity, size, or multiple sessions
    "How many hours did this take?"
    "How many sessions for this piece?"
    "The detail is incredible — how long did this one take?"

  TYPE B — Technique/Materials: when caption mentions specific techniques or gear
    "What needle grouping did you use for the shading?"
    "What machine did you run this with?"
    "What colors did you use for that gradient? Looks amazing"

  TYPE C — Design/Inspiration: when caption describes the subject or style
    "Is this your own design?"
    "What inspired this piece?"
    "Love the composition — did you reference anything specific?"

  TYPE D — Artist/Background: default when caption has little specific info
    "How long have you been working in this style?"
    "Do you have a favorite type of piece to tattoo?"
    "This is 🔥 How long have you been tattooing?"

Rules:
- Start with a genuine compliment, THEN ask the question
- Sound conversational, not like a survey
- Never ask generic questions like "where are you based" or "link in bio"
- 0-1 emoji only (question carries the engagement)`,
  design_ref: `Comment style: DESIGN-FOCUSED
- Reference the specific tattoo subject/design if mentioned in caption
- If caption doesn't describe the subject, fall back to technical instead`,
};

function pickEngagementType(caption: string): string {
  const lower = caption.toLowerCase();
  // Type A — process/time
  if (/\b(hour|session|day|sitting|first|cover.up|blast|laser|removal|rework|touch.up)\b/.test(lower)) return 'A';
  // Type B — technique/materials
  if (/\b(machine|needle|cartridge|color|shade|linework|packing|stretch|brand|grip|stencil|transfer|pigment|rotary|coil|liner|shader|grouping|voltage)\b/.test(lower)) return 'B';
  // Type C — design/inspiration
  if (/\b(design|sketch|drawing|flash|inspired|original|custom|idea|concept|meaning|cover|reference|style|traditional|realism|geometric|mandala|tribal|blackwork|dotwork|watercolor|surreal|biomech)\b/.test(lower)) return 'C';
  // Type D — default
  return 'D';
}

const STYLE_WEIGHTS: [string, number][] = [
  ['engagement', 0.35],
  ['technical', 0.25],
  ['praise', 0.20],
  ['design_ref', 0.20],
];

function pickStyle(forced?: string): string {
  if (forced && STYLE_GUIDES[forced]) return forced;
  const r = Math.random();
  let acc = 0;
  for (const [style, weight] of STYLE_WEIGHTS) {
    acc += weight;
    if (r <= acc) return style;
  }
  return 'technical';
}

function buildPrompt(
  artistHandle: string,
  postCaption: string,
  postCategory: string,
  style: string,
): string {
  // Pick few-shot from random brand for voice reference
  const allBrands = loadBrandDataset();
  const brandMap = new Map<string, BrandPost[]>();
  allBrands.forEach(p => {
    if (!brandMap.has(p.brand)) brandMap.set(p.brand, []);
    brandMap.get(p.brand)!.push(p);
  });
  const brandKeys = [...brandMap.keys()];
  const randomBrand = brandKeys[Math.floor(Math.random() * brandKeys.length)];
  const examples = (brandMap.get(randomBrand) || []).sort(() => Math.random() - 0.5).slice(0, 2);

  const fewShotBlock = examples.length > 0
    ? `Reference brand voice (${randomBrand}):\n${examples.map((ex, i) =>
        `Post ${i+1}: "${(ex.content || '').slice(0, 150)}"`
      ).join('\n')}`
    : '';

  const styleGuide = STYLE_GUIDES[style] || STYLE_GUIDES.technical;
  const engagementHint = style === 'engagement'
    ? `Caption analysis: this post suggests question TYPE ${pickEngagementType(postCaption)} — use the matching type from the style guide above.`
    : '';

  return `You are a tattoo supply brand commenting on an artist's Instagram post.

Artist: @${artistHandle}
Caption: "${(postCaption || '').slice(0, 300)}"
Category: ${postCategory || 'general'}

${fewShotBlock}

${styleGuide}

${engagementHint}

Rules:
- Read the CAPTION carefully — if artist describes their design (e.g. "snake and rose", "lion portrait"), you CAN reference it
- If caption doesn't describe the subject, stick to technique comments only
- 6-30 words
- Include exactly 1 relevant emoji (can be 0 for engagement questions)
- NEVER sound like a bot, sales pitch, or generic brand reply
- Sound human — like a brand rep who genuinely appreciates tattoo art

Return ONLY JSON: {"text": "your comment", "style": "${style}"}`;
}

async function callDeepSeek(prompt: string): Promise<string> {
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You generate Instagram comments for tattoo brands. Output valid JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.85,
      max_tokens: 120,
      top_p: 0.95,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`DeepSeek API ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

function safeJsonParse(text: string, fallback: any) {
  try {
    return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
  } catch { return fallback; }
}

const FALLBACKS = [
  'This piece is incredibly clean, the saturation is flawless 🔥',
  'Love the contrast and depth in this work 🔥',
  'Really clean execution, the detail speaks for itself 🖤',
  'The shading on this is beautifully smooth 🔥',
  'Solid craftsmanship, the composition flows perfectly 🔥',
  'Clean work, love seeing artists push their craft 🔥',
  // Engagement fallbacks
  'Beautiful work! How many hours did this take? 🔥',
  'The saturation is incredible — what colors did you use?',
  'Really clean linework! What needle grouping did you run?',
  'This is stunning 🔥 How many sessions for this piece?',
  'Love the depth in this! What machine did you use?',
];

export type SupplyCommentInput = {
  brand?: string;
  artistHandle: string;
  postCaption?: string;
  postCategory?: string;
  style?: string;
};

export type SupplyCommentResult = {
  text: string;
  style: string;
};

/**
 * 生成品牌口吻评论 — 被 bot-worker 调用
 */
export async function generateSupplyComment(input: SupplyCommentInput): Promise<SupplyCommentResult> {
  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY not set');
  }
  if (!input.artistHandle) {
    throw new Error('artistHandle required');
  }

  const style = pickStyle(input.style);
  const prompt = buildPrompt(
    input.artistHandle,
    input.postCaption || '',
    input.postCategory || 'general',
    style,
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await callDeepSeek(prompt);
      const parsed = safeJsonParse(raw, { text: raw.slice(0, 100), style });
      let text = String(parsed.text || '').trim();
      text = text.replace(/^(here's|here is|sure|okay|of course|absolutely)[,:!. ]+/i, '').slice(0, 150);
      if (text && text.length >= 3) {
        return { text, style };
      }
    } catch { /* retry */ }
  }

  return { text: FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)], style };
}

// ────────────────────────────────────────────────────────────
// 模块 B — 品牌推新分析 (CLI 模式)
// ────────────────────────────────────────────────────────────

function analyzeBrandPush() {
  const all = loadBrandDataset();
  if (all.length === 0) {
    console.log('⚠️  brand_captions_dataset.json 为空，先跑采集');
    return;
  }

  // 按品牌分组
  const byBrand = new Map<string, BrandPost[]>();
  all.forEach(p => {
    if (!byBrand.has(p.brand)) byBrand.set(p.brand, []);
    byBrand.get(p.brand)!.push(p);
  });

  console.log('\n═══ 品牌推新分析报告 ═══');
  console.log(`总品牌数: ${byBrand.size} | 总帖子数: ${all.length}\n`);

  for (const [brand, posts] of byBrand) {
    const cats: Record<string, number> = {};
    posts.forEach(p => { cats[p.category] = (cats[p.category] || 0) + 1; });
    const catStr = Object.entries(cats)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    const totalComments = posts.reduce((s, p) => s + (p.comments?.length || 0), 0);
    const avgComments = (totalComments / posts.length).toFixed(1);
    const maxComments = Math.max(...posts.map(p => p.comments?.length || 0));

    // 最新帖子
    const sorted = [...posts].sort((a, b) =>
      new Date(b.scrapedAt || 0).getTime() - new Date(a.scrapedAt || 0).getTime()
    );
    const latest = sorted.slice(0, 3).map(p =>
      `  └─ [${p.category}] "${(p.content || '').slice(0, 100)}" (${p.comments?.length || 0} comments)`
    ).join('\n');

    console.log(`【${brand}】${posts.length} posts`);
    console.log(`  内容方向: ${catStr}`);
    console.log(`  平均互动: ${avgComments} comments | 最高: ${maxComments}`);
    console.log(`  最新帖子:\n${latest}\n`);
  }

  // 整体趋势
  const allCats: Record<string, number> = {};
  all.forEach(p => { allCats[p.category] = (allCats[p.category] || 0) + 1; });
  console.log('═══ 全品牌内容分布 ═══');
  Object.entries(allCats)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => {
      const pct = ((v / all.length) * 100).toFixed(1);
      console.log(`  ${k}: ${v} (${pct}%)`);
    });
}

// ─── 品牌发现 — 从 artist 帖子里找新品牌 ──────────────

function discoverNewBrands(threshold = 5) {
  const artistFile = 'data/artist_captions_dataset.json';
  const brandFile = 'data/brand_captions_dataset.json';

  if (!fs.existsSync(artistFile)) {
    console.log('⚠️  artist_captions_dataset.json 不存在');
    return;
  }

  const existingBrands = new Set(
    (fs.existsSync(brandFile) ? JSON.parse(fs.readFileSync(brandFile, 'utf8')) : [])
      .map((b: any) => b.brand?.toLowerCase())
      .filter(Boolean)
  );

  const artistData = JSON.parse(fs.readFileSync(artistFile, 'utf8'));
  const mentions: Record<string, number> = {};

  artistData.forEach((p: any) => {
    const content = p.content || '';
    const matches = content.match(/@[a-zA-Z0-9._]+/g) || [];
    matches.forEach((m: string) => {
      const h = m.replace('@', '').toLowerCase().trim();
      if (!h || h.length < 3) return;
      if (existingBrands.has(h)) return;
      if (/(instagram|facebook|tiktok|twitter|youtube|shopify|paypal|gmail|hotmail|outlook|yahoo|gmx)/i.test(h)) return;
      mentions[h] = (mentions[h] || 0) + 1;
    });
  });

  const sorted = Object.entries(mentions)
    .sort((a, b) => b[1] - a[1])
    .filter(([_, count]) => count >= threshold);

  console.log('\n═══ 新品牌发现报告 ═══');
  console.log(`已有品牌: ${existingBrands.size}`);
  console.log(`候选新品牌（≥${threshold}次提及）: ${sorted.length}\n`);

  if (sorted.length === 0) {
    console.log('没有发现足够高频的新品牌，降低 threshold 试试');
    return;
  }

  const supplyKeywords = /supply|ink|needle|cartridge|machine|aftercare|derm|tattoo.?goo|grip|stencil|cap|pigment|color|rotary|power|glove|soap|lotion|cream|ointment|wash|wrap|film|bottle|tube|band|tip|grip|stabilizer|transfer/i;
  const likelySupply = sorted.filter(([h]) => supplyKeywords.test(h));
  const other = sorted.filter(([h]) => !supplyKeywords.test(h));

  console.log('🔧 疑似供应链品牌:');
  likelySupply.slice(0, 20).forEach(([h, c]) => console.log(`  @${h} (${c}次)`));

  if (other.length > 0) {
    console.log('\n📌 其他高频提及（可能是门店/艺术家）:');
    other.slice(0, 10).forEach(([h, c]) => console.log(`  @${h} (${c}次)`));
  }

  const verifiedFile = 'data/verified_supply_brands.json';
  if (fs.existsSync(verifiedFile)) {
    const verified = JSON.parse(fs.readFileSync(verifiedFile, 'utf8'));
    const verifiedHandles = new Set(
      (Array.isArray(verified) ? verified : []).map((v: any) => (v.handle || v).toLowerCase())
    );
    const inVerified = likelySupply.filter(([h]) => verifiedHandles.has(h));
    if (inVerified.length > 0) {
      console.log(`\n✅ 已验证的品牌（在 verified_supply_brands.json 中）:`);
      inVerified.forEach(([h, c]) => console.log(`  @${h} (${c}次)`));
    }
  }

  console.log(`\n提示: 运行 npx tsx scripts/brand_scraper.ts --handle @xxx 采集新品牌帖子`);
}

// ─── 训练: 分析数据 → 提取风格特征 ──────────────────

function hasEmoji(text: string): boolean {
  return /[\u{1F300}-\u{1FAFF}]/u.test(text);
}

function trainFromData() {
  const brandData = loadBrandDataset();
  if (brandData.length === 0) {
    console.log('⚠️  brand_captions_dataset.json 为空');
    return;
  }

  console.log('\n═══ 训练模式：品牌口吻 + 评论风格分析 ═══\n');

  // 1. 品牌 caption 口吻分析
  const byBrand = new Map<string, BrandPost[]>();
  brandData.forEach(p => {
    if (!byBrand.has(p.brand)) byBrand.set(p.brand, []);
    byBrand.get(p.brand)!.push(p);
  });

  const brandProfiles: Record<string, any> = {};

  for (const [brand, posts] of byBrand) {
    const captions = posts.map(p => p.content).filter(Boolean);
    const lengths = captions.map(c => c.split(/\s+/).length);
    const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const emojiRate = captions.filter(c => hasEmoji(c)).length / captions.length;
    const questionRate = captions.filter(c => c.includes('?')).length / captions.length;
    const exclaimRate = captions.filter(c => c.includes('!')).length / captions.length;

    // 高频词（去掉停用词）
    const stopWords = new Set('the a an and or but in on at to for of with is are was this that it be we you your our from by as all no not if so up out do does did has have had get got just like can will about into over after also more some their them they what when where how which who its'.split(' '));
    const wordFreq: Record<string, number> = {};
    captions.forEach(c => {
      c.toLowerCase().split(/\s+/).forEach(w => {
        const clean = w.replace(/[^a-z]/g, '');
        if (clean.length > 3 && !stopWords.has(clean)) wordFreq[clean] = (wordFreq[clean] || 0) + 1;
      });
    });
    const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w, c]) => `${w}(${c})`);

    // 评论风格分类
    const allComments = posts.flatMap(p => p.comments || []);
    const commentTexts = allComments.map(c => c.text).filter(Boolean);

    console.log(`【${brand}】${posts.length} posts, avg ${avgLen.toFixed(0)} words`);
    console.log(`  Voice: emoji ${(emojiRate*100).toFixed(0)}% | questions ${(questionRate*100).toFixed(0)}% | excitement ${(exclaimRate*100).toFixed(0)}%`);
    console.log(`  Keywords: ${topWords.join(', ')}`);
    console.log(`  Categories: ${[...new Set(posts.map(p => p.category))].join(', ')}`);
    console.log(`  Comments on posts: ${commentTexts.length} total`);
    console.log();

    brandProfiles[brand] = {
      avgLength: Math.round(avgLen),
      emojiRate: +emojiRate.toFixed(2),
      questionRate: +questionRate.toFixed(2),
      exclaimRate: +exclaimRate.toFixed(2),
      topWords: topWords.slice(0, 5),
      postCount: posts.length,
    };
  }

  // 2. Artist dataset 评论效果分析
  console.log('═══ Artist 帖子评论分析（什么风格的评论互动最高）═══\n');

  let totalComments = 0;
  const styleHits: Record<string, { count: number; totalLikes: number; samples: string[] }> = {
    technical: { count: 0, totalLikes: 0, samples: [] },
    praise: { count: 0, totalLikes: 0, samples: [] },
    engagement: { count: 0, totalLikes: 0, samples: [] },
    design_ref: { count: 0, totalLikes: 0, samples: [] },
  };

  if (fs.existsSync(ARTIST_DATASET_FILE)) {
    try {
      const artistData = JSON.parse(fs.readFileSync(ARTIST_DATASET_FILE, 'utf8'));
      for (const post of artistData) {
        for (const c of (post.comments || [])) {
          totalComments++;
          const text = (c.text || '').trim();
          const likes = c.likes || 0;
          if (!text || text.length < 3) continue;

          let style = 'praise';
          if (text.includes('?')) style = 'engagement';
          else if (/linework|shading|saturat|contrast|composit|technique|craft|precision|smooth|clean|crisp|blend|depth|detail|execution|placement|stencil|packing|stretch/i.test(text)) style = 'technical';
          else if (/\b(snake|rose|skull|dragon|portrait|flower|mandala|geometric|lettering|tribal|anchor|dagger|wolf|lion|eagle|owl|butterfly|spider|scorpion|koi|cyber|biomech|trash|polka|watercolor|surreal|blackwork|dotwork)\b/i.test(text)) style = 'design_ref';

          if (styleHits[style]) {
            styleHits[style].count++;
            styleHits[style].totalLikes += likes;
            if (likes >= 2 && styleHits[style].samples.length < 5) {
              styleHits[style].samples.push(`"${text.slice(0, 80)}" (${likes}❤️)`);
            }
          }
        }
      }
    } catch {}
  }

  console.log(`Artist dataset comments: ${totalComments}`);
  for (const [style, s] of Object.entries(styleHits)) {
    const avgLikes = s.count > 0 ? (s.totalLikes / s.count).toFixed(1) : '-';
    const pct = totalComments > 0 ? ((s.count / totalComments) * 100).toFixed(1) : '0';
    console.log(`  ${style}: ${s.count} (${pct}%) | avg ${avgLikes} likes`);
    if (s.samples.length > 0) {
      s.samples.forEach(sm => console.log(`    └─ ${sm}`));
    }
  }

  // 3. 保存 profile
  const outFile = 'data/style_profiles.json';
  const output = {
    brands: brandProfiles,
    styleDistribution: Object.fromEntries(
      Object.entries(styleHits).map(([k, v]) => [k, { count: v.count, avgLikes: v.count > 0 ? +((v.totalLikes / v.count).toFixed(1)) : 0 }])
    ),
    trainingDate: new Date().toISOString(),
    totalBrandPosts: brandData.length,
    totalArtistComments: totalComments,
    brandsCount: byBrand.size,
    styleWeights: STYLE_WEIGHTS,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n✅ 已保存 style profiles → ${outFile}`);
  console.log(`   (供 generateSupplyComment 做风格参考)`);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--help';

  switch (mode) {
    case '--analyze':
    case '-a':
      analyzeBrandPush();
      break;

    case '--discover':
    case '-d': {
      const threshold = parseInt(args[1] || '5');
      discoverNewBrands(threshold);
      break;
    }

    case '--comment':
    case '-c': {
      const brand = args[1] || 'kwadron';
      // Pick random artist from dataset
      let handle = 'test_artist';
      let caption = '';
      let category = '';
      if (fs.existsSync(ARTIST_DATASET_FILE)) {
        try {
          const data = JSON.parse(fs.readFileSync(ARTIST_DATASET_FILE, 'utf8'));
          const pick = data[Math.floor(Math.random() * data.length)];
          handle = pick.handle || handle;
          caption = (pick.content || '').slice(0, 200);
          category = pick.category || 'general';
        } catch {}
      }
      console.log(`Generating ${brand} comment for @${handle}...`);
      const result = await generateSupplyComment({ artistHandle: handle, postCaption: caption, postCategory: category });
      console.log(`[${result.style}] ${result.text}`);
      break;
    }

    case '--train':
    case '-t':
      trainFromData();
      break;

    default:
      console.log(`
supply-bot — 品牌情报 + 评论生成管道

用法:
  npx tsx scripts/supply-bot.ts --comment [brand]   生成测试评论
  npx tsx scripts/supply-bot.ts --analyze           品牌推新分析报告
  npx tsx scripts/supply-bot.ts --discover [min]    发现新品牌（最低提及次数，默认5）
  npx tsx scripts/supply-bot.ts --train             训练：分析数据生成风格特征

导出 (给 bot-worker 调用):
  import { generateSupplyComment } from './supply-bot';
`);
  }
}

if (process.argv[1]?.includes('supply-bot')) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
