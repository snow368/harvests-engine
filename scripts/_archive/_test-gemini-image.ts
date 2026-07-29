/**
 * Test Gemini Imagen — 产品图生成场景图
 *
 * 用法: npx tsx scripts/_test-gemini-image.ts
 *
 * 用 Gemini 2.0 Flash (native image output)：
 * 给一张产品 reference 图，生成专业场景图，不加任何文字。
 */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const MODEL = 'models/gemini-2.0-flash-exp';
const API = `https://generativelanguage.googleapis.com/v1beta/${MODEL}:generateContent?key=${API_KEY}`;

async function imageToBase64(filePath: string): Promise<string> {
  const data = fs.readFileSync(filePath);
  return data.toString('base64');
}

async function main() {
  const productImage = process.argv[2] || 'data/product_images/peach-cartridges-limited-time-discount-all-models-15-99-per-box-20-pieces_0.jpg';
  const outDir = 'output/gemini_test';
  fs.mkdirSync(outDir, { recursive: true });

  const imagePath = path.resolve(productImage);
  if (!fs.existsSync(imagePath)) {
    console.error('File not found:', imagePath);
    process.exit(1);
  }

  console.log('Input:', imagePath);
  const b64 = await imageToBase64(imagePath);
  const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const prompt = `Create a professional tattoo supply product photo.

The attached image shows a tattoo cartridge product. Generate a high-end product scene image that:
- Shows the product in a professional tattoo studio setting (on a wooden workbench, with soft overhead lighting)
- Clean, premium look — like a flagship brand product shot
- Realistic lighting, shallow depth of field
- Dark / moody aesthetic (like Bishop Rotary or Kwadron product shots)
- DO NOT add any text, logos, watermarks, or labels on the image
- The product should be the clear focal point

Make it look like it belongs on a premium tattoo supply brand's Instagram feed.`;

  console.log('\nCalling Gemini 2.0 Flash (native image output)...');
  console.log('Prompt:', prompt.slice(0, 80) + '...');

  const resp = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mime, data: b64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 1.0,
        topP: 0.95,
        responseModalities: ['Text', 'Image'],
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`API error ${resp.status}:`, errText.slice(0, 500));
    process.exit(1);
  }

  const data: any = await resp.json();
  const candidates = data?.candidates || [];
  if (candidates.length === 0) {
    console.error('No candidates returned');
    console.error(JSON.stringify(data, null, 2).slice(0, 1000));
    process.exit(1);
  }

  const parts = candidates[0]?.content?.parts || [];
  let imageSaved = false;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
      const imgB64 = part.inlineData.data;
      const ext = part.inlineData.mimeType === 'image/png' ? 'png' : 'jpg';
      const outPath = path.join(outDir, `cartridge_scene_${i}.${ext}`);
      fs.writeFileSync(outPath, Buffer.from(imgB64, 'base64'));
      console.log(`  Saved: ${outPath} (${(imgB64.length * 0.75 / 1024).toFixed(0)} KB)`);
      imageSaved = true;
    } else if (part.text) {
      console.log(`  Gemini says: ${part.text.slice(0, 200)}`);
    }
  }

  if (!imageSaved) {
    console.log('No image returned. Full response:');
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
  } else {
    console.log('\nDone. Check output/gemini_test/');
  }
}

main().catch(e => {
  console.error('Fatal:', e?.message || e);
  process.exit(1);
});
