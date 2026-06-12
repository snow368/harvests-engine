/**
 * Test FLUX Pro Ultra — 生成一张产品场景图
 *
 * 用法: npx tsx scripts/_test-flux.ts
 * 环境变量: REPLICATE_API_KEY, PROXY (optional, default socks5://127.0.0.1:7890)
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
        // Follow redirect via get
        https.get(res.headers.location, { agent }, r2 => {
          r2.pipe(file);
          file.on('finish', () => {
            file.close();
            const kb = fs.statSync(dest).size / 1024;
            console.log(`Saved: ${dest} (${kb.toFixed(0)} KB)`);
            resolve();
          });
        });
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const kb = fs.statSync(dest).size / 1024;
        console.log(`Saved: ${dest} (${kb.toFixed(0)} KB)`);
        resolve();
      });
    });
    req.on('error', reject);
    req.setTimeout(60000);
  });
}

async function poll(getUrl: string) {
  const u = new URL(getUrl);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const result: any = await apiRequest({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    console.log(`  [${i+1}] ${result.status}`);
    if (result.status === 'succeeded') {
      const url = Array.isArray(result.output) ? result.output[0] : result.output;
      console.log('Image URL:', url);
      await download(url, 'output/flux_test/flux_ultra_1.png');
      return;
    }
    if (result.status === 'failed') {
      console.error('Failed:', JSON.stringify(result).slice(0, 400));
      return;
    }
  }
  console.error('Timeout');
}

async function main() {
  const prompt = process.argv[2] || [
    'Professional product photography of a single tattoo cartridge on a wooden workbench.',
    'Ultra detailed black housing with visible needle tip, premium metal and plastic textures.',
    'Soft overhead studio lighting, shallow depth of field, dark moody aesthetic.',
    'Clean composition, true-to-life colors, photorealistic, no text, no label, no watermark.',
    'Flagship brand product shot style — minimalist, premium, cinematic.',
    'hyper realistic, 8k, intricate detail, sharp focus.'
  ].join(' ');

  console.log('Generating with FLUX 1.1 Pro Ultra (via Clash proxy)...');
  console.log('Proxy:', PROXY);
  console.log('Prompt:', prompt.slice(0, 130) + '...\n');

  const postData = JSON.stringify({
    input: { prompt, aspect_ratio: '1:1', safety_tolerance: 5, raw: false, output_format: 'png' },
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

    if (result.status === 'succeeded' && result.output) {
      const url = Array.isArray(result.output) ? result.output[0] : result.output;
      console.log('Done!');
      console.log('Image URL:', url);
      await download(url, 'output/flux_test/flux_ultra_1.png');
    } else if (result.urls?.get) {
      console.log('Queued. Polling (status=' + result.status + ')...');
      await poll(result.urls.get);
    } else {
      console.log('Response:', JSON.stringify(result, null, 2).slice(0, 1000));
    }
  } catch (err: any) {
    console.error('Error:', err.message);
    // Retry logic or fallback
    if (err.message === 'Timeout') {
      console.log('Request timed out. The proxy might need different configuration.');
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
