/**
 * Content Creator — 学习同行思路，自创品牌内容
 *
 * 流程:
 *   1. 分析 content_samples（同行帖子）提取模式（文案结构、标签策略、风格）
 *   2. 从 content-library/{category}/ 选品牌自己的图
 *   3. DeepSeek 按学习到的模式生成原创文案
 *   4. 创建 content_publish_tasks → publish-worker 自动发帖
 *
 * ENV:
 *   DEEPSEEK_API_KEY=xxx
 *   PUBLISH_BOT=bot_publish_01
 *   CONTENT_CREATOR_MIN_SCORE=30   (同行样本的最低质量分)
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
const API_BASE = (process.env.BOT_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');
const PUBLISH_BOT = (process.env.PUBLISH_BOT || 'bot_publish_01').trim();
const CONTENT_LIBRARY = (process.env.CONTENT_LIBRARY_DIR || './content-library').trim();
const MIN_SAMPLE_SCORE = Math.max(0, Number(process.env.CONTENT_CREATOR_MIN_SCORE || 30));

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

const CHECK_INTERVAL_MS = Math.max(30000, Number(process.env.CONTENT_CREATOR_CHECK_MS || 120000));
const POSTS_PER_CYCLE = Math.max(1, Number(process.env.POSTS_PER_CYCLE || 2));
const MIN_POST_INTERVAL_HOURS = Math.max(4, Number(process.env.MIN_POST_INTERVAL_HOURS || 12));

const db = new Database(DB_PATH);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============ Content Categories ============
// Each category has a directory in content-library/ and a content strategy prompt
const CONTENT_CATEGORIES: Array<{ dir: string; strategy: string }> = [
  {
    dir: 'products',
    strategy: '产品展示 — 展示 tattoo 设备/耗材，突出产品特点和优势。专业、实用、让纹身师知道这个产品能解决什么问题。'
  },
  {
    dir: 'results',
    strategy: '作品效果 — 展示使用品牌产品完成的作品。重点在最终效果、细节、对比。让观众看到产品的实际价值。'
  },
  {
    dir: 'education',
    strategy: '纹身教育 — 分享纹身知识：针型选择、色料特性、保养方法、不同风格技巧。建立专业权威形象。'
  },
  {
    dir: 'behind_scenes',
    strategy: '幕后花絮 — 工作室日常、制作过程、打包发货、团队工作。增加品牌温度和人味。'
  },
];

// ============ Load Competitor Patterns ============
function loadCompetitorPatterns(): string {
  const samples = db.prepare(`
    SELECT caption, style_tags_json, topic_tag, cta_tag, engagement_hint, quality_score
    FROM content_samples
    WHERE quality_score >= ? AND caption IS NOT NULL AND caption != ''
      AND LENGTH(caption) > 20
    ORDER BY quality_score DESC, engagement_hint DESC
    LIMIT 20
  `).all(MIN_SAMPLE_SCORE) as any[];

  if (samples.length === 0) {
    return '暂无同行样本数据，按照 tattoo 行业最佳实践生成。';
  }

  const patterns = samples.map((s: any, i: number) => {
    let styleTags = '';
    try { styleTags = JSON.parse(s.style_tags_json || '[]').join(', '); } catch {}
    return `[样本${i + 1}] 风格:${styleTags} 主题:${s.topic_tag || '未知'} CTA:${s.cta_tag || '无'} 互动分:${s.engagement_hint || 0}
  文案: ${(s.caption || '').slice(0, 200)}`;
  }).join('\n');

  return `以下是同行高互动帖子的特征分析:\n${patterns}\n\n从这些样本中总结出: 什么样的标题结构受欢迎、话题标签怎么组合、CTA怎么引导互动。然后应用到下面的原创内容中。`;
}

// ============ DeepSeek Generation ============
async function generateCaption(categoryStrategy: string, competitorPatterns: string, imageFilename: string): Promise<{ caption: string; hashtags: string[] }> {
  if (!DEEPSEEK_API_KEY) {
    // Fallback: template-based
    const fallbacks: Record<string, { caption: string; hashtags: string[] }> = {
      products: {
        caption: `Precision tools for precision work. ${imageFilename.replace(/\.[^.]+$/, '')} — engineered for the artists who demand more.`,
        hashtags: ['#tattoosupply', '#tattooequipment', '#tattooink', '#tattooartist', '#tattooshop']
      },
      results: {
        caption: `When quality tools meet skilled hands. Another piece brought to life with our products.`,
        hashtags: ['#tattoo', '#tattooart', '#tattoowork', '#tattoosupply', '#inked']
      }
    };
    const key = categoryStrategy.includes('产品') ? 'products' : 'results';
    return fallbacks[key] || fallbacks.products;
  }

  const prompt = `你是一个 tattoo 耗材品牌的社交媒体经理。你需要创建一篇 Instagram 帖子的原创内容。

## 品牌调性
- 专业、实用、行业洞察
- 面向 tattoo artist（纹身师），不是普通消费者
- 展示你对行业的理解，建立权威感
- 语言简洁有力，不要空洞的营销话术

## 同行学习分析
${competitorPatterns}

## 本帖子类型
${categoryStrategy}

## 图片名称
${imageFilename}

## 要求
1. 写一段原创 Instagram 文案（50-120字），不要提及具体竞品
2. 用中文写，但保留英文专业术语（如 liner, shader, cartridge 等）
3. 自然地加 1-2 个 emoji
4. 最后生成 8-12 个 hashtag（中英混合，tattoo 行业精准标签）
5. 输出格式: 文案内容(换行)-----(换行)hashtags(逗号分隔，不带#)`;

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.8,
      })
    });
    const data: any = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';

    const parts = text.split('-----');
    const caption = parts[0]?.trim() || '';
    const hashtagStr = parts[1]?.trim() || '';
    const hashtags = hashtagStr
      .split(/[,，\s]+/)
      .map((t: string) => `#${t.trim().replace(/^#/, '')}`)
      .filter((t: string) => t.length > 2)
      .slice(0, 15);

    return { caption, hashtags: hashtags.length > 0 ? hashtags : ['#tattoo', '#tattoosupply', '#tattooink'] };
  } catch (e: any) {
    console.warn('[content-creator] DeepSeek failed:', e?.message);
    return { caption: '', hashtags: ['#tattoo', '#tattoosupply'] };
  }
}

// ============ Pick Media Files ============
function pickMediaFiles(category: string, usedFiles: Set<string>): string[] {
  const dir = path.join(CONTENT_LIBRARY, category);
  try {
    const allFiles = fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|webp|mp4)$/i.test(f))
      .map(f => path.join(dir, f));
    // Prefer unused files
    const unused = allFiles.filter(f => !usedFiles.has(f));
    const pool = unused.length > 0 ? unused : allFiles;
    // Pick 1-3 random files
    const count = Math.min(pool.length, 1 + Math.floor(Math.random() * 2));
    const picked: string[] = [];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    for (let i = 0; i < count && i < shuffled.length; i++) {
      picked.push(shuffled[i]);
      usedFiles.add(shuffled[i]);
    }
    return picked;
  } catch {
    return [];
  }
}

// ============ Create Publish Task ============
async function createPublishTask(caption: string, hashtags: string[], mediaFiles: string[], category: string, imageHint: string) {
  const fullCaption = caption || `Precision tools for tattoo artists. ${imageHint}`;
  const payload = {
    caption: fullCaption,
    hashtags,
    mediaFiles,
    category,
    createdAt: new Date().toISOString()
  };

  try {
    const resp = await fetch(`${API_BASE}/api/publish/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'instagram',
        botId: PUBLISH_BOT,
        contentId: `brand_${Date.now()}`,
        scheduledAt: Date.now() + 2 * 60 * 60 * 1000,
        payload
      })
    });
    const data: any = await resp.json();
    if (data?.ok) {
      console.log(`[content-creator] publish task created: ${data.taskId}`);
      console.log(`   Caption: ${fullCaption.slice(0, 60)}...`);
      console.log(`   Media: ${mediaFiles.length} file(s)`);
      return true;
    }
  } catch (e: any) {
    console.warn('[content-creator] create task failed:', e?.message);
  }
  return false;
}

// ============ Main Loop ============
async function mainLoop() {
  console.log('[content-creator] starting:', {
    deepseek: !!DEEPSEEK_API_KEY,
    publishBot: PUBLISH_BOT,
    categories: CONTENT_CATEGORIES.map(c => c.dir).join(','),
    postsPerCycle: POSTS_PER_CYCLE,
    minScore: MIN_SAMPLE_SCORE
  });

  const usedFiles = new Set<string>();
  let cycleCount = 0;

  while (true) {
    try {
      cycleCount++;

      // 1. Load competitor patterns
      const competitorPatterns = loadCompetitorPatterns();
      const sampleCount = (competitorPatterns.match(/样本\d+/g) || []).length;
      console.log(`[content-creator] cycle ${cycleCount}: ${sampleCount} competitor samples loaded`);

      // 2. Pick category (round-robin)
      const category = CONTENT_CATEGORIES[(cycleCount - 1) % CONTENT_CATEGORIES.length];

      // 3. Pick media files
      const mediaFiles = pickMediaFiles(category.dir, usedFiles);
      if (mediaFiles.length === 0) {
        console.log(`[content-creator] no media in ${category.dir}, skipping cycle`);
        await sleep(CHECK_INTERVAL_MS);
        continue;
      }

      // 4. Generate caption
      const imageHint = path.basename(mediaFiles[0]).replace(/\.[^.]+$/, '');
      const { caption, hashtags } = await generateCaption(category.strategy, competitorPatterns, imageHint);

      // 5. Create publish task
      if (mediaFiles.length > 0) {
        await createPublishTask(caption, hashtags, mediaFiles, category.dir, imageHint);
      }

      // 6. Wait before next post
      const waitHours = MIN_POST_INTERVAL_HOURS + Math.floor(Math.random() * 6);
      console.log(`[content-creator] next post in ~${waitHours}h`);
      await sleep(waitHours * 60 * 60 * 1000);

    } catch (e: any) {
      console.error('[content-creator] loop error:', e?.message?.slice(0, 200));
      await sleep(CHECK_INTERVAL_MS);
    }
  }
}

// ============ Shutdown ============
const shutdown = (signal: string) => {
  console.log(`[content-creator] shutdown on ${signal}`);
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

mainLoop().catch((e) => {
  console.error('[content-creator] fatal:', e?.message || e);
  db.close();
  process.exit(1);
});
