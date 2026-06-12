/**
 * Content Calendar — 周内容排期生成器
 *
 * 按周生成内容日历：每天发什么、什么类型、什么主题。
 * 结合内容类型权重 + 最佳时段 + 热点事件。
 *
 * 用法: npx tsx scripts/content-calendar.ts
 *
 * ENV:
 *   CALENDAR_WEEKS=4           (生成几周)
 *   CALENDAR_CITY=Seattle      (目标城市，影响本地标签和时段)
 *   CALENDAR_OUTPUT=./data/bot_state/content_calendar/
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// ============ Config ============
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');
const OUTPUT_DIR = process.env.CALENDAR_OUTPUT || path.join(process.cwd(), 'data', 'bot_state', 'content_calendar');
const WEEKS = Number(process.env.CALENDAR_WEEKS || 4);
const CITY = (process.env.CALENDAR_CITY || 'Seattle').trim();

const CONTENT_TYPES = ['static_post', 'slideshow_reel', 'ai_animation', 'video_remix', 'voiceover_reel', 'artist_feature'] as const;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Best posting times by day (IG general data, tattoo niche)
const DEFAULT_BEST_TIMES: Record<string, string> = {
  Monday: '09:00', Tuesday: '14:00', Wednesday: '11:00',
  Thursday: '15:00', Friday: '10:00', Saturday: '12:00', Sunday: '20:00',
};

// Tattoo industry event months (US/EU)
const INDUSTRY_EVENTS: { month: number; name: string; themes: string[] }[] = [
  { month: 1, name: 'New Year', themes: ['new year goals', 'fresh start tattoos', 'resolution'] },
  { month: 2, name: 'Valentines', themes: ['couple tattoos', 'love symbols', 'matching tattoos'] },
  { month: 3, name: 'Spring / St. Patricks', themes: ['spring renewal', 'floral', 'green'] },
  { month: 4, name: 'Tattoo Convention Season', themes: ['convention prep', 'guest spots', 'travel'] },
  { month: 5, name: 'Memorial Day / Summer Prep', themes: ['summer body', 'visible tattoos', 'vacation'] },
  { month: 6, name: 'Summer Peak', themes: ['beach ready', 'color tattoos', 'summer vibe'] },
  { month: 7, name: 'Summer / Independence', themes: ['patriotic', 'festival', 'outdoor'] },
  { month: 8, name: 'Late Summer', themes: ['back to school', 'last chance summer', 'bold'] },
  { month: 9, name: 'Fall / Labor Day', themes: ['autumn', 'cover up', 'transition'] },
  { month: 10, name: 'Halloween', themes: ['spooky', 'dark art', 'skull', 'horror'] },
  { month: 11, name: 'Thanksgiving / Black Friday', themes: ['gratitude', 'gift cards', 'sale'] },
  { month: 12, name: 'Christmas / New Year', themes: ['gift', 'winter', 'year in review'] },
];

const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============ DB ============
const openDb = () => new Database(DB_PATH);

const getContentStats = (): any => {
  const db = openDb();
  try {
    const samples = db.prepare('SELECT COUNT(*) as c, AVG(quality_score) as avg FROM content_samples').get() as any;
    const byType = db.prepare(`
      SELECT source_type, COUNT(*) as c, AVG(quality_score) as avg
      FROM content_samples GROUP BY source_type
    `).all() as any[];
    const publishTasks = db.prepare("SELECT COUNT(*) as c FROM content_publish_tasks WHERE status = 'pending'").get() as any;
    const published = db.prepare("SELECT COUNT(*) as c FROM content_publish_tasks WHERE status = 'done'").get() as any;

    return {
      totalSamples: samples?.c || 0,
      avgScore: Math.round(samples?.avg || 0),
      byType,
      pendingPublish: publishTasks?.c || 0,
      totalPublished: published?.c || 0,
    };
  } finally {
    db.close();
  }
};

// ============ Calendar Generation ============

interface DaySlot {
  dayOfWeek: string;
  date: string;
  contentType: string;
  theme: string;
  suggestedTime: string;
  rationale: string;
  hashtagFocus: string;
}

interface WeekCalendar {
  weekLabel: string;
  startDate: string;
  endDate: string;
  seasonalTheme: string;
  industryEvent: string;
  days: DaySlot[];
}

const generateCalendar = async (stats: any): Promise<WeekCalendar[]> => {
  const today = new Date();
  const weeks: WeekCalendar[] = [];

  if (!DEEPSEEK_API_KEY) {
    // Fallback: simple rotation calendar
    for (let w = 0; w < WEEKS; w++) {
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() + w * 7);
      const monthNum = weekStart.getMonth() + 1;
      const event = INDUSTRY_EVENTS.find(e => e.month === monthNum);

      const days: DaySlot[] = DAY_NAMES.map((day, i) => {
        const date = new Date(weekStart);
        date.setDate(date.getDate() + i);
        const dateStr = date.toISOString().slice(0, 10);
        const typeIdx = (w * 7 + i) % CONTENT_TYPES.length;
        return {
          dayOfWeek: day,
          date: dateStr,
          contentType: CONTENT_TYPES[typeIdx],
          theme: event?.themes[i % event.themes.length] || 'general',
          suggestedTime: DEFAULT_BEST_TIMES[day] || '14:00',
          rationale: 'Rotating content mix for variety',
          hashtagFocus: `${CITY.toLowerCase()}tattoo`,
        };
      });

      weeks.push({
        weekLabel: `Week ${w + 1}`,
        startDate: days[0].date,
        endDate: days[6].date,
        seasonalTheme: event?.name || '',
        industryEvent: event ? `${event.name}: ${event.themes.join(', ')}` : '',
        days,
      });
    }
    return weeks;
  }

  // AI-generated calendar
  const context = {
    city: CITY,
    weeks: WEEKS,
    currentMonth: today.getMonth() + 1,
    currentYear: today.getFullYear(),
    stats: {
      totalSamples: stats.totalSamples,
      avgScore: stats.avgScore,
      pendingPublish: stats.pendingPublish,
    },
    industryEvents: INDUSTRY_EVENTS.filter(e => e.month >= today.getMonth() + 1 && e.month <= today.getMonth() + WEEKS + 1),
    contentTypes: CONTENT_TYPES,
    bestPractices: {
      weekday_morning: 'static_post, artist_feature (9-11am) — visual, low effort to consume',
      weekday_afternoon: 'slideshow_reel, voiceover_reel (2-4pm) — mid engagement, swipe/audio',
      weekday_evening: 'ai_animation, video_remix (7-9pm) — highest reach, video priority',
      weekend: 'artist_feature, slideshow_reel (12-8pm) — relaxed, browse-friendly',
    },
  };

  // Generate week by week for better quality
  for (let w = 0; w < WEEKS; w++) {
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() + w * 7);

    const prompt = `Generate a weekly Instagram content calendar for a tattoo studio/supply brand in ${CITY}.

${JSON.stringify(context, null, 2)}

Return JSON for ONE week:
{
  "weekLabel": "Week X (MM/DD - MM/DD)",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD",
  "seasonalTheme": "overall theme for this week",
  "industryEvent": "relevant industry event or none",
  "days": [
    {
      "dayOfWeek": "Monday",
      "date": "YYYY-MM-DD",
      "contentType": "${CONTENT_TYPES.join('|')}",
      "theme": "specific content theme for this day",
      "suggestedTime": "HH:MM (local time)",
      "rationale": "why this type+theme+time combination",
      "hashtagFocus": "primary hashtag strategy for this post"
    }
  ]
}

Content type guide:
- static_post: AI-generated hero image (Midjourney/SD), editorial quality, product or tattoo design showcase
- slideshow_reel: 3-6 AI image sequence (Midjourney → Shotstack), "swipe to see" narrative, consistent visual palette
- ai_animation: 5-8s AI video (Runway/Kling), motion visuals, "watch it come to life"
- video_remix: 15-30s artist clip repurposed (Whisper → DeepSeek → FFmpeg), translated/remixed with brand context
- voiceover_reel: 15-25s AI image + ElevenLabs TTS script, hook + benefit + CTA structure
- artist_feature: partner artist showcase (DeepSeek caption), celebrate artist + subtle product tie-in

Rules:
- Mix content types across the week (don't repeat same type 2 days in a row)
- Include seasonal themes from industry events
- Weekends = lighter, more visual content (artist_feature, slideshow_reel)
- Include 1-2 ai_animation or video_remix per week (highest reach video)
- Include 1-2 voiceover_reel or slideshow_reel per week (educational/authority)
- Avoid posting at :00 or :30 (IG algorithm preference for non-round times)
- Use ${CITY}-specific hashtags
- Vary AI tools across posts (don't use Midjourney for everything)`;

    try {
      const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7, max_tokens: 1500,
        }),
      });

      if (resp.ok) {
        const data: any = await resp.json();
        const text = (data?.choices?.[0]?.message?.content || '')
          .replace(/```json\n?/g, '').replace(/```/g, '').trim();

        try {
          const parsed = JSON.parse(text);
          weeks.push(parsed);
        } catch {
          console.warn(`  Week ${w + 1} JSON parse failed, using fallback`);
        }
      }
    } catch (e: any) {
      console.warn(`  Week ${w + 1} API error: ${e.message}`);
    }

    await sleep(1000);
  }

  return weeks;
};

// ============ Print & Save ============
const printCalendar = (weeks: WeekCalendar[]) => {
  for (const week of weeks) {
    console.log(`\n━━━ ${week.weekLabel} (${week.startDate} → ${week.endDate}) ━━━`);
    if (week.seasonalTheme) console.log(`  🎯 Theme: ${week.seasonalTheme}`);
    if (week.industryEvent) console.log(`  📅 Event: ${week.industryEvent}`);

    for (const day of week.days) {
      const emoji = day.contentType === 'ai_animation' ? '✨' :
        day.contentType === 'video_remix' ? '🎬' :
        day.contentType === 'slideshow_reel' ? '🖼️' :
        day.contentType === 'voiceover_reel' ? '🎙️' :
        day.contentType === 'artist_feature' ? '👨‍🎨' : '📝';
      console.log(`  ${day.dayOfWeek.slice(0, 3)} ${day.date.slice(5)} | ${day.suggestedTime} | ${emoji} ${day.contentType}`);
      console.log(`    ${day.theme}`);
      console.log(`    #${day.hashtagFocus}`);
    }
  }
};

const saveCalendar = (weeks: WeekCalendar[]) => {
  ensureDir(OUTPUT_DIR);
  const file = path.join(OUTPUT_DIR, `calendar_${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), city: CITY, weeks }, null, 2), 'utf8');
  return file;
};

// ============ Main ============
const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  Content Calendar Generator         ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  City: ${CITY} | Weeks: ${WEEKS}`);

  const stats = getContentStats();
  console.log(`  DB: ${stats.totalSamples} samples, ${stats.totalPublished} published`);

  console.log('\nGenerating calendar...');
  const weeks = await generateCalendar(stats);

  if (weeks.length > 0) {
    printCalendar(weeks);
    const file = saveCalendar(weeks);
    console.log(`\n✅ Calendar saved: ${file}`);
  } else {
    console.log('No calendar generated.');
  }
};

main().catch((e) => {
  console.error('[content-calendar] Fatal:', e?.message || e);
  process.exit(1);
});
