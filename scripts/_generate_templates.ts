/**
 * 为每个品类生成文案模板 + 话术亮点
 *
 * 用法: npx tsx scripts/_generate_templates.ts
 */
import fs from 'node:fs';
import 'dotenv/config';

const INPUT = 'data/brand_posts_categorized.json';
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const BASE = 'https://api.deepseek.com/v1';

const CATEGORIES: Record<string, string> = {
  needles_cartridges: 'Tattoo Needles & Cartridges',
  machines_pens: 'Tattoo Machines & Pens',
  ink: 'Tattoo Ink',
  aftercare: 'Tattoo Aftercare',
};

async function ask(prompt: string): Promise<string> {
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a tattoo industry marketing analyst. Output clean JSON only, no markdown.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 1500,
    }),
  });
  const data: any = await resp.json();
  return (data?.choices?.[0]?.message?.content || '').replace(/```json\n?|\n?```/g, '').trim();
}

async function main() {
  const allPosts = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

  // Group posts by category
  const grouped: Record<string, any[]> = {};
  for (const p of allPosts) {
    const cat = p.productCategory || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  }

  const templates: Record<string, any> = {};

  for (const [catKey, catLabel] of Object.entries(CATEGORIES)) {
    const posts = grouped[catKey] || [];
    if (posts.length === 0) continue;

    const examples = posts.slice(0, 8).map(p => (p.content || p.caption || '').slice(0, 300)).filter(Boolean);

    const prompt = `Analyze these ${catLabel} Instagram captions from top brands.
For each, extract: hook type, selling points, CTA, emoji usage, tone, hashtag strategy.

Then produce a TEMPLATE with:
1. best opening hook (write 2 examples)
2. top 5 selling points / features that get engagement
3. caption structure (template with slots)
4. best CTAs (write 2)
5. recommended emoji set (8-10 emojis)
6. hashtag strategy (write brand, category, and trending tags)
7. a complete example caption using the template

Captions:
${examples.map((c, i) => `\n[${i+1}] ${c}`).join('\n')}

Return JSON: {
  "category": "...",
  "hookTemplates": ["ex1", "ex2"],
  "sellingPoints": ["sp1", "sp2", ...],
  "captionStructure": "description",
  "ctaTemplates": ["cta1", "cta2"],
  "recommendedEmojis": ["emoji1", ...],
  "hashtagStrategy": {"branded": [...], "category": [...], "trending": [...]},
  "exampleCaption": "full example"
}`;

    console.log(`\nAnalyzing ${catKey} (${posts.length} posts)...`);
    try {
      const raw = await ask(prompt);
      templates[catKey] = JSON.parse(raw);
      console.log('OK');
    } catch (e: any) {
      templates[catKey] = { error: e.message, raw: raw?.slice(0, 500) };
      console.error('Parse error');
    }
    await new Promise(r => setTimeout(r, 500));
  }

  fs.writeFileSync('data/category_templates.json', JSON.stringify(templates, null, 2), 'utf8');

  console.log('\n=== SUMMARY ===');
  for (const [cat, t] of Object.entries(templates)) {
    if (t.error) { console.log(`\n${cat}: ERROR - ${t.error}`); continue; }
    console.log(`\n--- ${cat} ---`);
    console.log('Hooks:', t.hookTemplates?.join(' | '));
    console.log('Selling points:', t.sellingPoints?.slice(0, 3).join(', '));
    console.log('CTA:', t.ctaTemplates?.join(' | '));
    if (t.exampleCaption) console.log('Example:', t.exampleCaption.slice(0, 120) + '...');
  }
  console.log('\nSaved: data/category_templates.json');
}

main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
