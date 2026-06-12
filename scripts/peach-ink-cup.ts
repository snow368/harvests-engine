/**
 * Peach Ink Cup — 空色料杯 → 装满墨水 + Kwadron 风格背景
 *
 * 用法: npx tsx scripts/peach-ink-cup.ts
 *
 * 输出: output/peach_ink_cup/kwadron_pink.jpg
 *
 * 流程:
 * 1. 提示 Flux 生成一个装满 Peach 粉色墨水的色料杯
 * 2. 背景自动套 Kwadron 风格（深色渐变、硬光、工业美学）
 * 3. 生成 3 个配色变体（粉/绿/PMU透明）
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import 'dotenv/config';

const API_KEY = (process.env.REPLICATE_API_KEY || '').trim();
const MODEL = 'black-forest-labs/flux-1.1-pro-ultra';
const PROXY = process.env.PROXY || 'socks5://127.0.0.1:7890';
const agent = new SocksProxyAgent(PROXY);

const OUTPUT_DIR = 'F:/inkflow app/InkFlow_Project/Peach_AI_System/engine/output/peach_ink_cup';

function apiRequest(options: any, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, agent }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { agent }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        https.get(res.headers.location, { agent }, r2 => {
          r2.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        });
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', reject);
    req.setTimeout(60000);
  });
}

async function poll(getUrl: string, dest: string) {
  const u = new URL(getUrl);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const result: any = await apiRequest({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    console.log(`  [${i+1}] ${result.status}`);
    if (result.status === 'succeeded') {
      const url = Array.isArray(result.output) ? result.output[0] : result.output;
      await download(url, dest);
      return;
    }
    if (result.status === 'failed') {
      console.error('Failed:', JSON.stringify(result).slice(0, 400));
      return;
    }
  }
  console.error('Timeout');
}

async function generate(prompt: string, name: string) {
  console.log(`\n=== ${name} ===`);
  console.log('Prompt:', prompt.slice(0, 100) + '...');

  const postData = JSON.stringify({
    input: { prompt, aspect_ratio: '4:3', safety_tolerance: 5, raw: false, output_format: 'png' },
  });

  try {
    const result: any = await apiRequest({
      hostname: 'api.replicate.com',
      path: `/v1/models/${MODEL}/predictions`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData).toString(),
        'Prefer': 'wait',
      },
    }, postData);

    const dest = path.join(OUTPUT_DIR, name.replace(/\s+/g, '_') + '.png');

    if (result.status === 'succeeded' && result.output) {
      const url = Array.isArray(result.output) ? result.output[0] : result.output;
      await download(url, dest);
      console.log(`✓ Saved: ${dest}`);
    } else if (result.urls?.get) {
      console.log('Queued. Polling...');
      await poll(result.urls.get, dest);
    } else {
      console.log('Response:', JSON.stringify(result, null, 2).slice(0, 500));
    }
  } catch (err: any) {
    console.error('Error:', err.message);
  }
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Kwadron 风格通用后缀
  const kwadronStyle = [
    'Professional product photography',
    'Hard light from upper left, sharp highlights on edges',
    'Pure black to dark blue gradient background, no texture',
    'High contrast cool tones, precision industrial aesthetic',
    'Shallow depth of field, studio quality, photorealistic',
    'No text, no watermark, no labels.',
  ].join(', ');

  const prompts = [
    {
      name: 'pink_ink_kwadron',
      prompt: [
        `A small silicone ink cup filled with vibrant peach pink liquid tattoo ink,`,
        `matte white silicone material, ink surface with soft reflection`,
        `${kwadronStyle}`,
      ].join(' '),
    },
    {
      name: 'green_ink_kwadron',
      prompt: [
        `A small silicone ink cup filled with vibrant mint green liquid tattoo ink,`,
        `matte white silicone material, ink surface with soft reflection`,
        `${kwadronStyle}`,
      ].join(' '),
    },
    {
      name: 'pmu_clear_ink_kwadron',
      prompt: [
        `A small silicone ink cup filled with translucent light pink PMU pigment ink,`,
        `matte white silicone material, ink appears delicate and sheer`,
        `${kwadronStyle}`,
      ].join(' '),
    },
    {
      name: 'black_ink_kwadron',
      prompt: [
        `A small silicone ink cup filled with deep black tattoo ink,`,
        `matte white silicone material, ink surface glossy and reflective`,
        `${kwadronStyle}`,
      ].join(' '),
    },
  ];

  for (const p of prompts) {
    await generate(p.prompt, p.name);
    await sleep(2000); // 避免太快
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
