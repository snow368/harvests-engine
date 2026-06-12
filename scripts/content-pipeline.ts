/**
 * content-pipeline — 多平台内容生成管线
 *
 * 架构:
 *   内容计划器 (平台无关) → 生成器 (图/文) → 平台适配器 → 发布队列
 *
 * 用法:
 *   npx tsx scripts/content-pipeline.ts          # 今天的内容→队列
 *   npx tsx scripts/content-pipeline.ts --plan    # 查看本周计划
 *   npx tsx scripts/content-pipeline.ts --queue   # 查看队列
 *   npx tsx scripts/content-pipeline.ts --run     # 立即执行队列
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, exec } from 'node:child_process';
import 'dotenv/config';

// ────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────

type Platform = 'instagram' | 'youtube' | 'tiktok' | 'facebook';

type ContentType =
  | 'flash_design'       // AI flash sheet / 设计图
  | 'product_spotlight'  // 产品图换背景
  | 'tech_review'        // 技术评测
  | 'artist_feature'     // 转发纹身师作品
  | 'educational'        // 教育科普
  | 'promotion'          // 品牌推广
  | 'repost';            // 转载用户内容

interface AccountProfile {
  id: string;
  name: string;
  platform: Platform;
  contentTypes: ContentType[];
  brandTag: string;
  visualStyle: string;     // bg color / gradient ref
  template: string;        // visual template name
  accentColor?: string;    // accent hex color
}

interface PostTask {
  id: string;
  account: string;
  platform: Platform;
  contentType: ContentType;
  sourceImage?: string;
  outputImage: string;
  caption: string;
  hashtags: string[];
  scheduledAt: string;     // ISO datetime
  status: 'pending' | 'processing' | 'ready' | 'posted' | 'failed';
  createdAt: string;
}

// ────────────────────────────────────────────────────────────
// 账号配置
// ────────────────────────────────────────────────────────────

const ACCOUNTS: AccountProfile[] = [
  {
    id: 'A', name: 'flash_designs', platform: 'instagram',
    contentTypes: ['flash_design'],
    brandTag: '@flash_designs',
    visualStyle: '1a1a23-2a2a3a',
    template: 'dark_luxury',
    accentColor: 'c9a94e',
  },
  {
    id: 'B', name: 'tech_reviews', platform: 'instagram',
    contentTypes: ['tech_review', 'educational'],
    brandTag: '@tech_tattoo',
    visualStyle: '0d0d14-1a1a28',
    template: 'magazine',
    accentColor: '2563eb',  // blue accent
  },
  {
    id: 'D', name: 'brand_products', platform: 'instagram',
    contentTypes: ['product_spotlight', 'promotion'],
    brandTag: '@supply_brand',
    visualStyle: '23231a-3a3a2a',
    template: 'spotlight',
    accentColor: 'e63946',  // red accent
  },
];

// ─── 每周发布计划 ────────────────────────────────────────

const WEEKLY_SCHEDULE: Record<string, [number, ContentType][]> = {
  // [dayOfWeek, contentType]
  A: [
    [0, 'flash_design'],  // Sun
    [1, 'flash_design'],  // Mon
    [3, 'flash_design'],  // Wed
    [5, 'flash_design'],  // Fri
  ],
  B: [
    [2, 'tech_review'],    // Tue
    [4, 'educational'],    // Thu
  ],
  D: [
    [1, 'product_spotlight'],  // Mon
    [3, 'promotion'],          // Wed
    [5, 'product_spotlight'],  // Fri
  ],
};

// ────────────────────────────────────────────────────────────
// 内容计划器
// ────────────────────────────────────────────────────────────

function getTodayPlan(): { account: AccountProfile; contentType: ContentType }[] {
  const today = new Date().getDay();
  const plans: { account: AccountProfile; contentType: ContentType }[] = [];

  for (const account of ACCOUNTS) {
    const schedule = WEEKLY_SCHEDULE[account.id] || [];
    const todayItems = schedule.filter(([day]) => day === today);
    for (const [, contentType] of todayItems) {
      plans.push({ account, contentType });
    }
  }

  return plans;
}

function printWeeklyPlan(): void {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  console.log('\n=== 本周内容计划 ===\n');
  for (const account of ACCOUNTS) {
    const schedule = WEEKLY_SCHEDULE[account.id] || [];
    const dayMap = schedule.map(([d, ct]) => `${days[d]}:${ct}`);
    console.log(`  [${account.id}] ${account.name} (${account.platform})`);
    console.log(`    ${dayMap.join(' | ')}`);
    console.log();
  }
}

// ────────────────────────────────────────────────────────────
// 图片处理 — 调 Python 脚本
// ────────────────────────────────────────────────────────────

const PYTHON = 'C:/Users/snow3/AppData/Local/Programs/Python/Python312/python.exe';

async function processImage(options: {
  input: string;
  output: string;
  bgColor?: string;
  bgGradient?: string;
  title?: string;
  subtitle?: string;
  footer?: string;
  brand?: string;
  size?: string;
  noRembg?: boolean;
  template?: string;
  accentColor?: string;
}): Promise<void> {
  const script = path.resolve('scripts/image-processor.py');
  const args = [
    `--input "${options.input}"`,
    `--output "${options.output}"`,
    `--bg-gradient "${options.bgGradient || '1a1a23-2a2a3a'}"`,
    `--size "${options.size || '1080x1080'}"`,
    `--template "${options.template || 'spotlight'}"`,
  ];
  if (options.title) args.push(`--title "${options.title}"`);
  if (options.subtitle) args.push(`--subtitle "${options.subtitle}"`);
  if (options.footer) args.push(`--footer "${options.footer}"`);
  if (options.brand) args.push(`--brand "${options.brand}"`);
  if (options.accentColor) args.push(`--accent-color "${options.accentColor}"`);
  if (options.noRembg) args.push('--no-rembg');

  const cmd = `"${PYTHON}" "${script}" ${args.join(' ')}`;
  try {
    execSync(cmd, { cwd: process.cwd(), timeout: 120000 });
  } catch (err: any) {
    const msg = err.stderr?.toString() || err.message || '';
    throw new Error(`Image processing failed: ${msg.slice(0, 200)}`);
  }
}

// ────────────────────────────────────────────────────────────
// 文案生成 — DeepSeek
// ────────────────────────────────────────────────────────────

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

async function generateCaption(
  contentType: ContentType,
  account: AccountProfile,
  productName?: string,
): Promise<{ caption: string; hashtags: string[] }> {
  if (!DEEPSEEK_API_KEY) {
    return {
      caption: 'Check out our latest product! 🔥',
      hashtags: ['#tattoo', '#tattoosupply'],
    };
  }

  // Load competitor style data to inform caption generation
  let competitorStyles: string[] = [];
  try {
    const styleData = JSON.parse(fs.readFileSync('data/style_profiles.json', 'utf8'));
    const brands = styleData.brands || {};
    const entries = Object.entries(brands).slice(0, 6);
    competitorStyles = entries.map(([name, data]: [string, any]) =>
      `${name}: avgLen=${data.avgLength}chars, emoji=${Math.round(data.emojiRate*100)}%, questions=${Math.round(data.questionRate*100)}%, exclaims=${Math.round(data.exclaimRate*100)}%, topWords=[${(data.topWords||[]).slice(0,3).join(', ')}]`
    );
  } catch {}

  const styleHint = competitorStyles.length > 0
    ? `\nCompetitor style benchmarks:\n${competitorStyles.join('\n')}\n\nAim for similar length and tone to leading brands.`
    : '';

  const prompts: Record<string, string> = {
    flash_design: `Write an Instagram caption for a tattoo flash design post.
Style: Short, inspiring, encourages saves/bookmarks.
Tone: Artistic, minimal. 1-2 sentences. Include 1 emoji.${styleHint}
Example: "Traditional dagger flash for your next session 🔖 Save this for later"`,

    product_spotlight: `Write an Instagram caption for a tattoo supply product photo.
Style: Professional but not stiff. Highlight features and quality.
Tone: Confident brand voice. 2-3 sentences. 1-2 emojis.
Mention the product name naturally: "${productName || 'this product'}"
Include one specific feature or benefit.${styleHint}`,

    tech_review: `Write an Instagram caption for a tattoo equipment review.
Style: Informative, educational. Share a tip or comparison.
Tone: Expert voice. 2-3 sentences. 1 emoji.${styleHint}`,

    educational: `Write an Instagram caption for a tattoo education post (tips, knowledge).
Style: Helpful, shareable. Provide value to tattoo artists.
Tone: Friendly expert. 2-3 sentences. 1-2 emojis.${styleHint}`,

    promotion: `Write an Instagram caption for a promotion/sale post.
Style: Energetic, urgent but not pushy.
Tone: Excited brand. 1-2 sentences. 2 emojis. Include call to action.${styleHint}`,
  };

  const prompt = prompts[contentType] || prompts.product_spotlight;

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: `You write Instagram captions for a tattoo supply brand (@${account.id}). Output valid JSON only.` },
          { role: 'user', content: `${prompt}\n\nReturn ONLY JSON: {"caption": "your caption", "hashtags": ["#tag1", "#tag2", "#tag3"]}` },
        ],
        temperature: 0.8,
        max_tokens: 200,
      }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data: any = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      caption: String(parsed.caption || '').slice(0, 300),
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 10) : [],
    };
  } catch {
    // fallback
    const fallbacks: Record<string, [string, string[]]> = {
      flash_design: ['Save this flash for your next session 🔖', ['#tattooflash', '#tattoodesign', '#tattooideas']],
      product_spotlight: ['Premium quality you can count on. 🔥', ['#tattoosupply', '#tattooequipment']],
      tech_review: ['Built for precision. Built for artists. 🖤', ['#tattoomachines', '#tattooartist']],
      educational: ['Knowledge is power. 🧠', ['#tattooeducation', '#tattootips']],
      promotion: ['Limited stock — grab yours now! 🔥', ['#tattoosupply', '#tattoodeals']],
    };
    const fb = fallbacks[contentType] || fallbacks.product_spotlight;
    return { caption: fb[0], hashtags: fb[1] };
  }
}

// ────────────────────────────────────────────────────────────
// 发布队列
// ────────────────────────────────────────────────────────────

const QUEUE_FILE = 'data/post_queue.json';

function loadQueue(): PostTask[] {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

function saveQueue(queue: PostTask[]): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

function addToQueue(task: PostTask): void {
  const queue = loadQueue();
  queue.push(task);
  saveQueue(queue);
  console.log(`  Queued: [${task.account}] ${task.contentType} → ${task.scheduledAt}`);
}

function printQueue(): void {
  const queue = loadQueue();
  if (queue.length === 0) { console.log('\nQueue is empty.'); return; }
  console.log(`\n=== Post Queue (${queue.length} items) ===\n`);
  for (const task of queue) {
    const time = new Date(task.scheduledAt).toLocaleString('zh-CN');
    console.log(`  [${task.status}] ${task.account} | ${task.contentType} | ${time}`);
    if (task.caption) console.log(`    Caption: ${task.caption.slice(0, 80)}`);
  }
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────

async function runPipeline(dryRun = false): Promise<void> {
  const plans = getTodayPlan();
  if (plans.length === 0) {
    console.log('Nothing scheduled for today.');
    printWeeklyPlan();
    return;
  }

  console.log(`\n=== Content Pipeline — ${new Date().toLocaleDateString('zh-CN')} ===\n`);
  console.log(`Today's plan: ${plans.map(p => `[${p.account.id}] ${p.contentType}`).join(', ')}\n`);

  if (dryRun) {
    console.log('(dry run — queued 0)\n');
    return;
  }

  const outDir = 'output/content';
  fs.mkdirSync(outDir, { recursive: true });

  // Load product catalog for product-specific captions
  const catalog: Array<{ handle: string; title: string; description: string; images: string[]; price: string }> =
    fs.existsSync('data/product_catalog.json')
      ? JSON.parse(fs.readFileSync('data/product_catalog.json', 'utf8'))
      : [];

  for (const { account, contentType } of plans) {
    console.log(`[${account.id}] Processing ${contentType}...`);

    let sourceImage: string | undefined;
    let outputImage = '';
    let caption = '';
    let hashtags: string[] = [];
    let productName: string | undefined;

    try {
      // 1. Pick source image + matching product info
      const productImages = fs.existsSync('data/product_images')
        ? fs.readdirSync('data/product_images').filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        : [];

      if (productImages.length > 0) {
        // Pick a random image and find its product
        const randomFile = productImages[Math.floor(Math.random() * productImages.length)];
        sourceImage = path.resolve('data/product_images', randomFile);

        // Match to catalog by filename prefix (product handle)
        const handle = randomFile.split('_')[0];
        const product = catalog.find((p: any) => p.handle === handle);
        if (product) {
          productName = product.title;
          console.log(`  Product: ${product.title.slice(0, 60)}`);
        }
      }

      // 2. Process image
      const ts = Date.now();
      outputImage = path.resolve(outDir, `${account.id}_${contentType}_${ts}.png`);

      const titleMap: Record<string, string> = {
        flash_design: 'FLASH FRIDAY',
        product_spotlight: 'PRODUCT SPOTLIGHT',
        tech_review: 'TECH TALK',
        educational: 'TATTOO TIPS',
        promotion: 'NEW ARRIVAL',
        artist_feature: 'ARTIST SPOTLIGHT',
        repost: '#REPOST',
      };

      const subtitle: string = contentType === 'product_spotlight' && product?.price
        ? `From $${product.price}`
        : contentType === 'promotion' ? 'Limited Edition'
        : contentType === 'tech_review' ? 'In-Depth Review'
        : '';

      const footerMap: Record<string, string> = {
        flash_design: 'Save for your next session →',
        product_spotlight: 'Shop now →',
        tech_review: 'Tag a friend who needs this →',
        educational: 'Share with your team →',
        promotion: 'Limited time →',
      };

      if (sourceImage) {
        await processImage({
          input: sourceImage,
          output: outputImage,
          bgGradient: account.visualStyle,
          template: account.template,
          accentColor: account.accentColor,
          title: titleMap[contentType] || 'SPOTLIGHT',
          subtitle: subtitle,
          footer: footerMap[contentType] || '',
          brand: account.brandTag,
          size: '1080x1080',
        });
      } else {
        console.log(`  No source image for ${account.id}, skipping image processing`);
        outputImage = '';
      }

      // 3. Generate caption — product-specific
      const result = await generateCaption(contentType, account, productName || 'our product');
      caption = result.caption;
      hashtags = result.hashtags;

      // 4. Queue post
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      addToQueue({
        id: `${account.id}_${ts}`,
        account: account.id,
        platform: account.platform,
        contentType,
        sourceImage,
        outputImage,
        caption: `${caption}\n\n${hashtags.join(' ')}`,
        hashtags,
        scheduledAt: tomorrow.toISOString(),
        status: 'ready',
        createdAt: new Date().toISOString(),
      });

      console.log(`  Caption: ${caption.slice(0, 100)}`);
      console.log(`  Hashtags: ${hashtags.join(' ')}`);
      console.log();

    } catch (err: any) {
      console.error(`  Failed: ${err.message.slice(0, 100)}`);
    }
  }

  console.log('Done. Queue updated.');
}

// ────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--run';

  switch (mode) {
    case '--plan':
    case '-p':
      printWeeklyPlan();
      break;

    case '--queue':
    case '-q':
      printQueue();
      break;

    case '--dry':
    case '-d':
      await runPipeline(true);
      break;

    case '--run':
    case '-r':
    default:
      await runPipeline();
      break;
  }
}

if (process.argv[1]?.includes('content-pipeline')) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}

export { runPipeline, printWeeklyPlan, printQueue, generateCaption, processImage };
export type { PostTask, ContentType, AccountProfile };
