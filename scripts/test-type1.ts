/**
 * Quick test: Type 1 static_post generation (product image + DeepSeek caption)
 * npx ts-node -r dotenv/config scripts/test-type1.ts
 */

import fs from 'node:fs';
import path from 'node:path';

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const PRODUCTS_DIR = './content-library/products';

const callDeepSeek = async (systemPrompt: string, userPrompt: string, maxTokens = 150): Promise<string> => {
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.85, max_tokens: maxTokens, top_p: 0.95,
    }),
  });
  if (!resp.ok) throw new Error(`DeepSeek ${resp.status}: ${await resp.text().catch(() => '')}`);
  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
};

const safeJsonParse = (text: string, fallback: any) => {
  try { return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim()); }
  catch { return fallback; }
};

async function main() {
  if (!DEEPSEEK_API_KEY) {
    console.error('❌ DEEPSEEK_API_KEY not set');
    process.exit(1);
  }

  const dir = PRODUCTS_DIR;
  if (!fs.existsSync(dir)) {
    console.error(`❌ ${dir} not found`);
    process.exit(1);
  }

  const images = fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  console.log(`📦 Found ${images.length} product images\n`);

  if (images.length === 0) {
    console.error('❌ No images in product library');
    process.exit(1);
  }

  // Pick 3 random images and generate captions
  const picked = images.sort(() => Math.random() - 0.5).slice(0, 3);

  const variations = ['professional', 'casual', 'question'];

  for (let i = 0; i < picked.length; i++) {
    const image = picked[i];
    const variant = variations[i];

    const variantGuide = variant === 'professional'
      ? 'Use a professional, knowledgeable tone. Comment on quality and craftsmanship.'
      : variant === 'casual'
      ? 'Use a casual, friendly tone. Short and natural.'
      : 'Ask a soft question to engage followers. Keep it authentic.';

    const prompt = `Write a short Instagram caption for a tattoo supply brand selling PMU/AES cartridges.

Brand: AES Tattoo Supply | Product: PMU cartridges & needles
Value props: precision, quality, safety

${variantGuide}

Rules: You are a tattoo supplier. Sound like a real industry person, not a marketer.
NO hard selling, NO prices, NO "DM for info". 1-3 short sentences. Max 1 emoji.
Write in English.

Return JSON: {"caption": "...", "hashtags": ["..."]}`;

    try {
      console.log(`\n🖼️  ${image} [${variant}]`);
      console.log(`   Calling DeepSeek...`);
      const raw = await callDeepSeek(
        'You create authentic Instagram captions for a tattoo supply brand. Respond ONLY with valid JSON.',
        prompt, 150
      );

      const parsed = safeJsonParse(raw, { caption: raw.trim().slice(0, 300), hashtags: [] });
      const caption = String(parsed.caption || '').trim();
      const hashtags: string[] = Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 10) : [];

      console.log(`   📝 ${caption}`);
      if (hashtags.length) console.log(`   🏷️  ${hashtags.map(h => `#${h.replace(/^#/, '')}`).join(' ')}`);
      console.log(`   ✅ OK`);
    } catch (e: any) {
      console.log(`   ❌ ${e.message}`);
    }
  }

  console.log('\n✅ Done\n');
}

main();
