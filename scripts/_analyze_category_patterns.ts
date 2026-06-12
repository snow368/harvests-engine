/**
 * 分析每个品类的文案模式 — 结构、亮点、hashtags
 *
 * 用法: npx tsx scripts/_analyze_category_patterns.ts
 */
import fs from 'node:fs';
import 'dotenv/config';

const INPUT = 'data/brand_posts_categorized.json';
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

const TARGET_CATEGORIES = ['needles_cartridges', 'machines_pens', 'ink', 'aftercare'];

async function analyzeCategory(posts: any[], category: string): Promise<any> {
  const captions = posts.map(p => p.content || p.caption || '').filter(Boolean);

  const prompt = `You are a tattoo industry marketing analyst. Analyze these ${captions.length} Instagram captions from tattoo supply brands in the "${category}" category.

For each caption, extract:
1. Opening hook type (question, statement, problem, trend, etc.)
2. Key selling points mentioned (quality, precision, innovation, comfort, etc.)
3. Call-to-action type (shop now, tag a friend, comment, etc.)
4. Emoji usage pattern
5. Hashtag strategy (branded, category, trending, etc.)
6. Tone (technical, emotional, urgent, educational, etc.)

Then provide a summary template with:
- Best performing opening hook
- Top 3 selling points to highlight
- Recommended caption structure (3-4 sentence format)
- Best CTA type
- Recommended emoji set
- Suggested hashtag mix (5-10 tags)
- Example caption

Format as JSON only.

Captions to analyze:
${captions.slice(0, 10).map((c, i) => `\n--- Post ${i+1} ---\n${c.slice(0, 400)}`).join('\n')}`;

  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You analyze tattoo supply Instagram content and output JSON templates.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 800,
    }),
  });

  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data: any = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
  try { return JSON.parse(cleaned); }
  catch { return { raw: cleaned.slice(0, 500) }; }
}

async function main() {
  const allPosts = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

  const categorized: Record<string, any[]> = {};
  for (const p of allPosts) {
    const cat = p.productCategory || 'other';
    if (!categorized[cat]) categorized[cat] = [];
    categorized[cat].push(p);
  }

  const results: Record<string, any> = {};
  for (const cat of TARGET_CATEGORIES) {
    const posts = categorized[cat] || [];
    console.log(`\n=== ${cat} (${posts.length} posts) ===`);
    try {
      const analysis = await analyzeCategory(posts, cat);
      results[cat] = analysis;
      console.log('Analysis:', JSON.stringify(analysis, null, 2).slice(0, 800));
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  fs.writeFileSync('data/category_templates.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('\nSaved: data/category_templates.json');
}

main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
