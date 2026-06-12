/**
 * 用 DeepSeek 把竞对帖子按产品品类分类
 *
 * 分类: needles, machines, ink, aftercare, accessories, pmu, other
 *
 * 用法: npx tsx scripts/_categorize_posts.ts
 */
import fs from 'node:fs';
import 'dotenv/config';

const API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const INPUT = 'data/brand_captions_dataset.json';
const OUTPUT = 'data/brand_posts_categorized.json';

const CATEGORIES = [
  'needles_cartridges',
  'machines_pens',
  'ink',
  'aftercare',
  'accessories',
  'pmu_microblading',
  'printer_transfer',
  'general_supply',
  'other',
];

async function classifyPost(content: string): Promise<{ category: string; product: string }> {
  const prompt = `Classify this Instagram caption into ONE product category for a tattoo supply brand.

Categories:
- needles_cartridges: Tattoo needles, cartridges, needle sets
- machines_pens: Tattoo machines, pens, power supplies, coils, rotary
- ink: Tattoo ink, pigment
- aftercare: Tattoo aftercare, lotion, balm, healing
- accessories: Grips, tubes, ink cups, transfer gel, gloves, hygiene
- pmu_microblading: Permanent makeup, microblading tools
- printer_transfer: Thermal printers, stencil paper, transfer supplies
- general_supply: General shop post, not product-specific
- other: None of the above

Return JSON only: {"category": "category_name", "product": "specific product mentioned or empty string"}

Caption: "${content.slice(0, 300)}"`;

  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You classify tattoo supply Instagram posts by product category. Output valid JSON only.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 80,
    }),
  });

  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data: any = await resp.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { category: 'other', product: '' };
  }
}

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error('Input not found:', INPUT);
    process.exit(1);
  }

  const posts = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  console.log(`Classifying ${posts.length} posts...\n`);

  const categorized: any[] = [];
  const stats: Record<string, number> = {};

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const content = post.content || post.caption || '';
    process.stdout.write(`  [${i + 1}/${posts.length}] ${post.brand || '?'}... `);

    try {
      const result = await classifyPost(content);
      post.productCategory = result.category;
      post.productName = result.product;
      categorized.push(post);
      stats[result.category] = (stats[result.category] || 0) + 1;
      console.log(result.category);
    } catch (e: any) {
      post.productCategory = 'other';
      categorized.push(post);
      console.error('error:', e.message.slice(0, 60));
    }

    // Small delay to avoid rate limits
    if (i < posts.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(categorized, null, 2), 'utf8');

  console.log('\n--- Results ---');
  for (const [cat, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count} posts`);
  }
  console.log(`\nSaved: ${OUTPUT}`);
}

main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
