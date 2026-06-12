/**
 * content-pipeline — Peach 纹身针 IG 发布管线
 *
 * 功能：
 *   1. 从 bot_registry.json 读取启用的 bot（默认全部，可 --bots N 限制数量）
 *   2. 从 data/product_images/ 取纹身针类图片
 *   3. 用 DeepSeek 生成 caption + hashtag
 *   4. 为每个 bot 创建 1 条 content_publish_tasks，bot_id 写死
 *   5. scheduled_at 按 bot timezone 的活跃窗口时间戳计算
 *   6. INSERT 到 deep-scan.db content_publish_tasks 表（直连 SQLite via better-sqlite3）
 *      如果 better-sqlite3 不可用，fallback 到 HTTP API（需要 server 在跑）
 *
 * 用法：
 *   npx tsx scripts/content-pipeline-needle.ts              # 默认所有 bot，生成今天的任务
 *   npx tsx scripts/content-pipeline-needle.ts --bots 3     # 只取前 3 个 bot
 *   npx tsx scripts/content-pipeline-needle.ts --list       # 列出 bot 和活跃窗口
 *   npx tsx scripts/content-pipeline-needle.ts --queue      # 查看今天已有的 publish tasks
 *   npx tsx scripts/content-pipeline-needle.ts --dry        # 模拟生成，不插入 DB
 *
 * 产品：只发纹身针（needle cartridges）
 * 每天每个 bot 1 条任务，安排在 bot 的活跃窗口内
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// ────────────────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve('F:/inkflow app/InkFlow_Project/inkflow_harvests');
const REGISTRY_PATH = path.join(PROJECT_ROOT, 'data', 'bot_registry.json');
const IMAGE_DIR = path.join(PROJECT_ROOT, 'data', 'product_images');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'deep-scan.db');
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

// 活跃窗口（与 bot-worker-cloak.ts 一致）
const ACTIVE_WINDOWS: Record<string, [number, number][]> = {
  'Asia/Shanghai':      [[8, 11], [19, 22]],
  'Asia/Hong_Kong':     [[8, 11], [19, 22]],
  'Asia/Singapore':     [[10, 12], [19, 21]],
  'Asia/Seoul':         [[9, 11], [19, 22]],
  'Asia/Tokyo':         [[9, 11], [19, 22]],
  'Australia/Sydney':   [[9, 11], [19, 21]],
  'America/New_York':   [[8, 10], [18, 21]],
  'America/Chicago':    [[9, 11], [18, 21]],
  'America/Los_Angeles':[[9, 11], [19, 22]],
  'Europe/London':      [[9, 12], [18, 20]],
  'Europe/Paris':       [[9, 12], [18, 21]],
  'Europe/Berlin':      [[9, 12], [18, 21]],
};

// 纹身针类图片关键词（文件名包含这些关键词的算纹身针）
const NEEDLE_KEYWORDS = [
  'needle', 'cartridge', 'liner', 'shader', 'maggpin', 'rotary',
  'tattoo-pen', 'microblading', 'needle-set', 'needle-tip',
  'needle-3d', 'needle-round', 'needle-flat', 'needle-magnum',
  'black-friday', 'special-needle', 'peach-needle', 'peach-con',
  'peach-cog', 'peach-aes', '18u', '32m', '5m', '12m', '15m',
];

// ────────────────────────────────────────────────────────────
// Bot Registry 读取
// ────────────────────────────────────────────────────────────

interface BotEntry {
  botId: string;
  accountId: string;
  tier: string;
  timezone: string;
  proxy: string;
  profileDir: string;
  enabled: boolean;
  role: string;
}

function loadBots(): BotEntry[] {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const bots = Array.isArray(data.bots) ? data.bots : [];
    return bots.filter((b: any) => b.enabled !== false);
  } catch (e: any) {
    console.error(`Failed to read bot registry: ${e.message}`);
    return [];
  }
}

// ────────────────────────────────────────────────────────────
// 图片管理
// ────────────────────────────────────────────────────────────

interface ImageEntry {
  filename: string;
  fullPath: string;
  isNeedle: boolean;
}

function listImages(): ImageEntry[] {
  if (!fs.existsSync(IMAGE_DIR)) {
    console.log(`Image dir not found: ${IMAGE_DIR}`);
    return [];
  }

  const files = fs.readdirSync(IMAGE_DIR);
  const entries: ImageEntry[] = [];

  for (const file of files) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(file)) continue;
    const isNeedle = NEEDLE_KEYWORDS.some(kw => file.toLowerCase().includes(kw));
    entries.push({
      filename: file,
      fullPath: path.join(IMAGE_DIR, file),
      isNeedle,
    });
  }

  return entries;
}

function pickNeedleImages(count: number): ImageEntry[] {
  const needleImages = listImages().filter(img => img.isNeedle);
  const allImages = listImages().filter(img => !img.isNeedle);
  const pool = [...needleImages, ...allImages];

  if (pool.length === 0) {
    console.log('No images found in product_images/');
    return [];
  }

  const picked: ImageEntry[] = [];
  const usedFilenames = new Set<string>();

  // 优先选纹身针图片
  for (let i = 0; i < count && i < pool.length; i++) {
    // 从池中随机取，不重复
    const idx = Math.floor(Math.random() * pool.length);
    const img = pool[idx];
    if (usedFilenames.has(img.filename)) {
      // 跳过已选的
      const other = pool.filter(p => !usedFilenames.has(p.filename) && p.isNeedle);
      if (other.length > 0) {
        const altIdx = Math.floor(Math.random() * other.length);
        picked.push(other[altIdx]);
        usedFilenames.add(other[altIdx].filename);
      }
      continue;
    }
    picked.push(img);
    usedFilenames.add(img.filename);
  }

  return picked;
}

// ────────────────────────────────────────────────────────────
// 时间调度
// ────────────────────────────────────────────────────────────

/**
 * 为给定的 timezone 和活跃窗口，生成今天的一个 scheduled_at 时间戳（毫秒 Unix）。
 * 选第一个窗口 [start, start+2) 的中间时刻。
 * 如果已经过了今天的窗口，往后推一天。
 */
function pickScheduleTimestamp(timezone: string): number | null {
  const windows = ACTIVE_WINDOWS[timezone];
  if (!windows || windows.length === 0) return null;

  // 取第一个窗口的中间时刻
  const [startHour, endHour] = windows[0];
  const targetHour = startHour + Math.floor((endHour - startHour) / 2);

  // 创建今天的这个时间点，用 UTC 表示
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // 用 UTC 方式设置，然后转 Unix 时间戳
  // 注意：我们需要的是"这个 bot 的本地时区时间"，但 scheduled_at 是 Unix 时间戳（UTC）
  // 所以要用 Intl.DateTimeFormat 或手动转换
  // 简单方式：用 dayjs 或 moment？没有这些依赖的话，手动算

  // 获取 timezone 的 UTC offset（小时）
  const utcString = new Date(today.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDateStr = new Date(today.toLocaleString('en-US', { timeZone: timezone }));
  const utcOffsetMs = tzDateStr.getTime() - new Date(utcString).getTime();

  // 目标时间戳 = today 的本地时间 targetHour:00 + utcOffset
  const targetMs = today.getTime() + utcOffsetMs + targetHour * 3600000;
  const targetDate = new Date(targetMs);

  // 如果今天的目标时间已经过了，推到明天同一时间
  if (targetDate.getTime() < now.getTime()) {
    return targetMs + 86400000; // +1 day
  }

  return targetMs;
}

function formatTimezone(timezone: string): string {
  const windows = ACTIVE_WINDOWS[timezone];
  if (!windows) return `${timezone} (unknown)`;
  return `${timezone} → ${windows.map(([s, e]) => `${String(s).padStart(2, '0')}-${String(e).padStart(2, '0')}`).join(' | ')}`;
}

// ────────────────────────────────────────────────────────────
// 文案生成（DeepSeek）
// ────────────────────────────────────────────────────────────

async function generateCaption(image: ImageEntry): Promise<{ caption: string; hashtag: string }> {
  if (!DEEPSEEK_API_KEY) {
    // Fallback：固定模板
    return {
      caption: 'Premium tattoo needles, precision you can trust. 🖤 Order now.',
      hashtag: '#peachtattoo #tattooneedles #tattoosupply #tattooartist',
    };
  }

  const prompt = `You are a social media copywriter for Peach Tattoo Supplies.
Write an Instagram post for a tattoo needle product photo.

Product image: ${image.filename}

Rules:
- 2-3 sentences max
- Professional but friendly tone
- Include 1-2 emojis naturally
- Mention quality/precision/artist trust
- End with a subtle CTA (shop now / order today / link in bio)
- Include 3-5 hashtags at the end, space-separated (no # in caption text, only in hashtag field)

Output ONLY valid JSON (no markdown, no backticks):
{"caption": "...", "hashtag": "#tag1 #tag2 #tag3"}`;

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
          { role: 'system', content: 'You write Instagram captions for a tattoo supply brand. Output ONLY valid JSON.' },
          { role: 'user', content: prompt },
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
      hashtag: String(parsed.hashtag || '#tattoo #tattoosupply').slice(0, 200),
    };
  } catch (err: any) {
    console.log(`  DeepSeek failed: ${err.message || err}`);
    return {
      caption: 'Precision tattoo needles for professionals. 🖤',
      hashtag: '#peachtattoo #tattooneedles #tattoosupply',
    };
  }
}

// ────────────────────────────────────────────────────────────
// SQLite INSERT（直连 DB）
// ────────────────────────────────────────────────────────────

let db: any = null;

function openDb(): any | null {
  if (db) return db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    return db;
  } catch (e: any) {
    console.log(`better-sqlite3 unavailable: ${e.message}`);
    console.log('Falling back to HTTP API (server must be running)');
    return null;
  }
}

function insertTaskViaSqlite(
  botId: string,
  accountId: string,
  imageRelPath: string,
  caption: string,
  hashtag: string,
  scheduledAt: number
): { ok: boolean; taskId?: string; error?: string } {
  const d = openDb();
  if (!d) {
    // Fallback: HTTP API
    return insertTaskViaAPIFallback(botId, accountId, imageRelPath, caption, hashtag, scheduledAt);
  }

  const now = Date.now();
  const id = `pub_ig_${now}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const stmt = d.prepare(`
      INSERT INTO content_publish_tasks (
        id, platform, bot_id, account_id, content_id, payload, status, scheduled_at,
        lease_until, leased_by, published_at, platform_post_id, error_reason,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `);

    const contentId = `content_${botId}_${Math.floor(now / 1000)}`;
    const payload = JSON.stringify({
      image_path: imageRelPath,
      caption,
      hashtag,
      source: 'peach_needle_auto',
      productType: 'needle_cartridge',
    });

    stmt.run(
      id, 'instagram', botId, accountId, contentId, payload,
      scheduledAt, now, now
    );

    console.log(`  SQLite insert: task ${id}`);
    return { ok: true, taskId: id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// Fallback: HTTP API（当 better-sqlite3 不可用时）
async function insertTaskViaAPIFallback(
  botId: string,
  accountId: string,
  imageRelPath: string,
  caption: string,
  hashtag: string,
  scheduledAt: number
): Promise<{ ok: boolean; taskId?: string; error?: string }> {
  const baseUrl = 'http://localhost:3000';
  const payload = {
    platform: 'instagram',
    botId,
    accountId,
    scheduledAt,
    payload: {
      image_path: imageRelPath,
      caption,
      hashtag,
      source: 'peach_needle_auto',
      productType: 'needle_cartridge',
    },
  };

  try {
    const resp = await fetch(`${baseUrl}/api/publish/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, error: errText };
    }

    const data = await resp.json();
    return { ok: true, taskId: data.taskId };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--run';

  // --list: 列出 bot 和活跃窗口
  if (mode === '--list') {
    const bots = loadBots();
    console.log('\n=== Bot Registry ===\n');
    for (const bot of bots) {
      console.log(`  ${bot.botId} (tier=${bot.tier}, role=${bot.role})`);
      console.log(`    TZ: ${formatTimezone(bot.timezone)}`);
      console.log(`    Account: ${bot.accountId}`);
      console.log();
    }
    console.log(`Total: ${bots.length} bots, ${bots.filter(b => b.enabled !== false).length} enabled`);
    return;
  }

  // --queue: 查看今天已有的 publish tasks（需要先跑 server，用 API）
  if (mode === '--queue') {
    try {
      const resp = await fetch('http://localhost:3000/api/content/pipeline/queue');
      const data = await resp.json();
      console.log(`\n=== Today's Publish Queue (${data.total} tasks) ===\n`);
      for (const t of data.tasks) {
        console.log(`  [${t.status}] ${t.id} | ${t.scheduledAt ? new Date(t.scheduledAt).toISOString() : 'N/A'}`);
      }
    } catch (err: any) {
      console.log('Cannot connect to server. Make sure server.ts is running.');
    }
    return;
  }

  // --dry: 模拟模式
  const dryRun = mode === '--dry';

  // 读 bot 列表
  const allBots = loadBots();
  if (allBots.length === 0) {
    console.log('No bots found in registry. Add bots to data/bot_registry.json');
    return;
  }

  // 不检查 bot 可用性 — 配置是流动的（IP/指纹/IG 号会轮换）
  // 只管生成任务写入 DB，bot 配好了自然会来取
  // 如果 bot 没配好，任务会留在 pending 状态，不会丢失
  console.log(`\n=== Peach Needle Content Pipeline ===`);
  console.log(`Date: ${new Date().toLocaleDateString('zh-CN')}`);
  console.log(`Total bots in registry: ${allBots.length}`);

  const botCountArg = args.find(a => a.startsWith('--bots='));
  let botCount = botCountArg ? parseInt(botCountArg.split('=')[1], 10) : allBots.length;
  botCount = Math.max(1, Math.min(botCount, allBots.length));

  const bots = allBots.slice(0, botCount);
  console.log(`Bots selected: ${botCount}`);

  // 读图片
  const images = pickNeedleImages(botCount);
  if (images.length === 0) {
    console.log('No images available. Add product images to data/product_images/');
    return;
  }
  console.log(`Images: ${images.length} loaded`);

  // 生成任务
  const tasks: Array<{ bot: BotEntry; image: ImageEntry; caption: string; hashtag: string; scheduledAt: number }> = [];

  for (let i = 0; i < botCount; i++) {
    const bot = bots[i];
    const image = images[i % images.length];

    console.log(`\n[${i + 1}/${botCount}] Processing ${bot.botId}...`);
    console.log(`  Image: ${image.filename}`);
    console.log(`  TZ: ${bot.timezone}`);

    // 计算 scheduled_at
    let scheduledAt = pickScheduleTimestamp(bot.timezone);
    if (!scheduledAt) {
      // 如果 timezone 没有活跃窗口，用默认 UTC 下午 2 点
      scheduledAt = Date.now() + 4 * 3600000; // +4 hours from now
      console.log(`  Note: no active window for ${bot.timezone}, using default`);
    }
    console.log(`  Scheduled: ${new Date(scheduledAt).toISOString()}`);

    // 生成文案
    const { caption, hashtag } = await generateCaption(image);
    console.log(`  Caption: ${caption.slice(0, 80)}...`);
    console.log(`  Hashtags: ${hashtag}`);

    tasks.push({ bot, image, caption, hashtag, scheduledAt });
  }

  // 写入 DB
  if (dryRun) {
    console.log('\n(Dry run — no DB writes)');
    return;
  }

  // 批量 INSERT
  console.log('\n=== Writing to DB ===\n');

  for (const task of tasks) {
    const result = insertTaskViaSqlite(
      task.bot.botId,
      task.bot.accountId,
      task.image.filename,
      task.caption,
      task.hashtag,
      task.scheduledAt
    );

    if (result.ok) {
      console.log(`  ✓ ${task.bot.botId} → task ${result.taskId} → ${new Date(task.scheduledAt).toISOString()}`);
    } else {
      console.log(`  ✗ ${task.bot.botId} → ${result.error}`);
    }
  }

  console.log('\nDone.');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
