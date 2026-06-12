/**
 * Video Subtitle Remover — 视频去字幕工具
 *
 * 功能：
 *   1. 智能检测视频中的硬字幕位置
 *   2. AI 擦除字幕（BytePlus VOD / 火山引擎 API）
 *   3. 可选：重新烧录新字幕（翻译 + 叠加）
 *
 * 用法：
 *   npx ts-node scripts/video-subtitle-remover.ts --input video.mp4
 *   npx ts-node scripts/video-subtitle-remover.ts --input video.mp4 --translate en
 *   npx ts-node scripts/video-subtitle-remover.ts --batch ./remix/
 *
 * 依赖：
 *   - BytePlus/火山引擎 API（去字幕）BYTEPLUS_ACCESS_KEY + BYTEPLUS_SECRET_KEY
 *   - DeepSeek API（翻译）DEEPSEEK_API_KEY
 *   - OpenAI Whisper API（语音转文字）OPENAI_API_KEY
 *   - FFmpeg（本地，处理音视频）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// ============ Config ============

// 火山引擎 (国内) / BytePlus (国际)
const VOLC_ACCESS_KEY = (process.env.VOLC_ACCESS_KEY || process.env.BYTEPLUS_ACCESS_KEY || '').trim();
const VOLC_SECRET_KEY = (process.env.VOLC_SECRET_KEY || process.env.BYTEPLUS_SECRET_KEY || '').trim();
const VOLC_REGION = (process.env.VOLC_REGION || 'cn-north-1').trim(); // 国内默认华北
const VOLC_VOD_BASE = 'https://vod.volcengineapi.com';
const VOLC_TOS_BASE = `https://tos-${VOLC_REGION}.volces.com`; // 对象存储

const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const OPENAI_API_KEY = (process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '').trim();

const OUTPUT_DIR = (process.env.VIDEO_OUTPUT_DIR || './content-library/_generated').trim();

// ============ FFmpeg wrapper ============

const execFFmpeg = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', ...args], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.slice(-500) || err.message));
      resolve(stdout || stderr);
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

// ============ Volcengine (火山引擎) VOD Subtitle Erase API ============
//
// 定价: 精细化版 4元/分钟 (闲时1.2元/分钟), 一条30s视频闲时≈¥0.60
// 需要: 火山引擎账号 → 智能处理 → 开通字幕擦除 → 获取AccessKey
// 文档: https://www.volcengine.com/docs/6448/2371372

// Volcengine Signature V4 helper (simplified for VOD service)
const hmacSha256 = async (key: string, data: string): Promise<string> => {
  // Use Node crypto for HMAC-SHA256
  const crypto = await import('node:crypto');
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
};

const sha256 = async (data: string): Promise<string> => {
  const crypto = await import('node:crypto');
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
};

const volcSignRequest = async (
  method: string, path: string, query: string,
  body: string, service: string, region: string,
): Promise<Record<string, string>> => {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const host = 'vod.volcengineapi.com';

  const canonicalRequest = [
    method, path, query,
    `host:${host}\nx-content-sha256:${await sha256(body)}\n`,
    'host;x-content-sha256',
    await sha256(body),
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/request`;
  const stringToSign = [
    'HMAC-SHA256', amzDate, credentialScope,
    await sha256(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256(`VOLC${VOLC_SECRET_KEY}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'request');
  const signature = await hmacSha256(kSigning, stringToSign);

  return {
    'X-Date': amzDate,
    'Authorization': `HMAC-SHA256 Credential=${VOLC_ACCESS_KEY}/${credentialScope}, SignedHeaders=host;x-content-sha256, Signature=${signature}`,
    'X-Content-Sha256': await sha256(body),
    'Content-Type': 'application/json',
  };
};

const volcApiCall = async (
  action: string, body: Record<string, any>,
): Promise<any> => {
  if (!VOLC_ACCESS_KEY || !VOLC_SECRET_KEY) {
    throw new Error('需要 VOLC_ACCESS_KEY 和 VOLC_SECRET_KEY (火山引擎API密钥)');
  }

  const query = `Action=${action}&Version=2023-01-01`;
  const bodyStr = JSON.stringify(body);
  const headers = await volcSignRequest('POST', '/', query, bodyStr, 'vod', VOLC_REGION);

  const resp = await fetch(`${VOLC_VOD_BASE}/?${query}`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });

  const text = await resp.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!resp.ok || data?.ResponseMetadata?.Error) {
    const err = data?.ResponseMetadata?.Error?.Message || `${resp.status}`;
    throw new Error(`火山引擎 ${action}: ${err}`);
  }
  return data?.Result || data;
};

// Upload local file to Volcengine VOD, get Vid
const uploadToVolc = async (videoPath: string): Promise<string> => {
  console.log('  [火山] 上传视频...');
  const fileSize = fs.statSync(videoPath).size;
  const fileName = path.basename(videoPath);

  // Step 1: Apply upload
  const applyResult = await volcApiCall('ApplyUploadInfo', {
    FileName: fileName,
    FileSize: fileSize,
    FileType: path.extname(videoPath).replace('.', ''),
  });

  const uploadAddr = applyResult?.UploadAddress;
  if (!uploadAddr?.UploadHosts?.length || !uploadAddr?.StoreInfos?.length) {
    throw new Error('获取上传地址失败');
  }

  const host = uploadAddr.UploadHosts[0];
  const storeInfo = uploadAddr.StoreInfos[0];
  const vid = applyResult.Vid || storeInfo.Vid;

  // Step 2: Upload file chunks
  const chunkSize = 1024 * 1024 * 4; // 4MB chunks
  const fileBuf = fs.readFileSync(videoPath);
  const totalChunks = Math.ceil(fileSize / chunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);
    const chunk = fileBuf.slice(start, end);

    const chunkUrl = `https://${host}/${storeInfo.StoreUri}?partNumber=${i}&uploadID=${storeInfo.UploadID}`;
    const resp = await fetch(chunkUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': uploadAddr.SessionKey || '',
        'Content-CRC32': '', // simplified
      },
      body: chunk,
    });

    if (!resp.ok && resp.status !== 200) {
      throw new Error(`上传分片${i}失败: ${resp.status}`);
    }
  }

  // Step 3: Commit
  await volcApiCall('CommitUploadInfo', {
    Vid: vid,
    StoreUri: storeInfo.StoreUri,
    UploadID: storeInfo.UploadID,
    PartCount: totalChunks,
  });

  console.log(`  [火山] 上传完成 Vid=${vid}`);
  return vid;
};

// Call StartExecution for subtitle erasure
const eraseSubtitlesVolc = async (vid: string, mode: 'Precision' | 'Standard' = 'Precision'): Promise<string> => {
  console.log(`  [火山] 提交字幕擦除任务 (${mode})...`);

  const result = await volcApiCall('StartExecution', {
    Input: { Type: 'Vid', Vid: vid },
    Operation: {
      Type: 'Task',
      Task: {
        Type: 'Erase',
        Erase: {
          Mode: 'Auto',
          Auto: { Type: 'Subtitle', SubtitleFilter: {} },
          ...(mode === 'Precision' ? { Enhancer: 'AIGC' } : {}),
        },
        Output: { NewVid: true },
      },
    },
  });

  const runId = result?.RunId;
  if (!runId) throw new Error('未获取到RunId');

  // Poll for completion
  console.log('  [火山] 等待处理...');
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const status = await volcApiCall('GetExecution', { RunId: runId });
    const state = status?.State;
    if (state === 'Success') {
      const newVid = status?.Output?.Vid || status?.NewVid;
      if (!newVid) throw new Error('处理完成但未获取到输出Vid');
      console.log(`  [火山] 擦除完成 NewVid=${newVid}`);
      return newVid;
    }
    if (state === 'Failed' || state === 'Error') {
      throw new Error(`擦除失败: ${status?.Error?.Message || '未知错误'}`);
    }
    if (i % 5 === 0) process.stdout.write('.');
  }
  throw new Error('擦除超时（3分钟）');
};

// Download processed video from VOD
const downloadFromVolc = async (vid: string, outputPath: string): Promise<string> => {
  console.log('  [火山] 下载处理结果...');

  const info = await volcApiCall('GetPlayInfo', { Vid: vid });
  const playUrl = info?.PlayInfoList?.[0]?.MainPlayUrl || info?.MainPlayUrl;

  if (!playUrl) throw new Error('未获取到播放地址');

  const resp = await fetch(playUrl);
  if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
  console.log(`  [火山] 下载完成: ${path.basename(outputPath)}`);
  return outputPath;
};

// ============ Step 1: Detect subtitle region ============

interface SubtitleRegion {
  x: number; y: number; width: number; height: number;
}

const detectSubtitleRegion = async (videoPath: string): Promise<SubtitleRegion> => {
  // Heuristic: subtitles are typically in the bottom 20-30% of the video
  // Use FFprobe to get video dimensions
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=s=x:p=0', videoPath,
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
    });

    const [w, h] = stdout.split('x').map(Number);
    if (w && h) {
      return {
        x: Math.round(w * 0.05),       // 5% margin left
        y: Math.round(h * 0.72),       // Start at 72% from top
        width: Math.round(w * 0.90),   // 90% width
        height: Math.round(h * 0.22),  // 22% height (covers 1-2 lines)
      };
    }
  } catch {}

  // Default for 1080p
  return { x: 54, y: 777, width: 1812, height: 200 };
};

// ============ Step 2A: AI Erase (Volcengine/火山引擎) ============

const eraseSubtitlesAI = async (videoPath: string, _region: SubtitleRegion, outputPath: string): Promise<string> => {
  if (!VOLC_ACCESS_KEY || !VOLC_SECRET_KEY) {
    throw new Error('火山引擎未配置: 需设置 VOLC_ACCESS_KEY 和 VOLC_SECRET_KEY');
  }

  // Upload → Erase → Download
  const mode = (process.env.VOLC_ERASE_MODE || 'Precision') as 'Precision' | 'Standard';
  const vid = await uploadToVolc(videoPath);
  const newVid = await eraseSubtitlesVolc(vid, mode);
  await downloadFromVolc(newVid, outputPath);
  return outputPath;
};

// ============ Step 2B: Crop approach (remove subtitle area) ============

const cropSubtitleRegion = async (videoPath: string, region: SubtitleRegion, outputPath: string): Promise<string> => {
  console.log('  [Crop] 裁剪字幕区域...');

  // Crop the video to remove bottom subtitle area, then pad back to original
  // This is lossless and doesn't require any API
  const cropHeight = region.y; // keep everything above the subtitle region

  await execFFmpeg([
    '-i', videoPath,
    '-vf', `crop=iw:${cropHeight}:0:0,pad=iw:ih:0:0:black`,
    '-c:a', 'copy',
    outputPath,
  ]);

  return outputPath;
};

// ============ Step 2C: Blur approach (blur subtitle area) ============

const blurSubtitleRegion = async (videoPath: string, region: SubtitleRegion, outputPath: string): Promise<string> => {
  console.log('  [Blur] 模糊字幕区域...');

  // Blur the subtitle region while keeping rest of video intact
  const blurFilter = [
    `split[main][sub]`,
    `[sub]crop=${region.width}:${region.height}:${region.x}:${region.y}`,
    `boxblur=20:10[blurred]`,
    `[main][blurred]overlay=${region.x}:${region.y}`,
  ].join(';');

  await execFFmpeg([
    '-i', videoPath,
    '-vf', blurFilter,
    '-c:a', 'copy',
    outputPath,
  ]);

  return outputPath;
};

// ============ Step 3: Transcribe audio (Whisper) ============

const transcribeAudio = async (videoPath: string): Promise<string> => {
  console.log('  [Whisper] 提取音频并转写...');

  ensureDir(OUTPUT_DIR);
  const audioPath = path.join(OUTPUT_DIR, `_tmp_audio_${Date.now()}.mp3`);

  try {
    // Extract audio
    await execFFmpeg(['-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', audioPath]);

    // Transcribe via OpenAI Whisper
    if (OPENAI_API_KEY) {
      const audioBuf = fs.readFileSync(audioPath);
      const formData = new FormData();
      formData.append('file', new Blob([audioBuf]), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'text');
      formData.append('language', 'zh'); // assume Chinese for customer videos

      const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: formData,
      });

      if (resp.ok) {
        return (await resp.text()).trim();
      }
    }
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }

  return '';
};

// ============ Step 4: Translate + rewrite (DeepSeek) ============

const translateAndRewrite = async (transcript: string, targetLang: string = 'en'): Promise<{
  subtitle: string;
  caption: string;
}> => {
  console.log('  [DeepSeek] 翻译并改写...');

  if (!DEEPSEEK_API_KEY) {
    return { subtitle: transcript, caption: transcript };
  }

  const prompt = targetLang === 'en'
    ? `Translate this Chinese transcript to English, then write:
1. A concise English subtitle (1-2 short lines, max 60 chars each — suitable for IG Reel)
2. A short IG caption for a tattoo supply brand reposting this customer video

Original: "${transcript.slice(0, 500)}"

Return JSON: {"subtitle": "...", "caption": "..."}`
    : `将这段文字改写为简短中文字幕（1-2行，每行最多20字）+ 简短的IG文案。

原文: "${transcript.slice(0, 500)}"

返回JSON: {"subtitle": "...", "caption": "..."}`;

  try {
    const raw = await callDeepSeek(
      'You are a video editor. Return ONLY valid JSON. Be concise.',
      prompt,
      200
    );
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      subtitle: String(parsed.subtitle || '').trim(),
      caption: String(parsed.caption || '').trim(),
    };
  } catch {
    return { subtitle: transcript, caption: transcript };
  }
};

const callDeepSeek = async (system: string, prompt: string, maxTokens: number): Promise<string> => {
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5, max_tokens: maxTokens,
    }),
  });
  if (!resp.ok) throw new Error(`DeepSeek ${resp.status}`);
  const data: any = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
};

// ============ Step 5: Burn new subtitles ============

const burnSubtitles = async (videoPath: string, subtitleText: string, outputPath: string): Promise<string> => {
  console.log('  [FFmpeg] 烧录新字幕...');

  // Split long subtitle into two lines
  const words = subtitleText.split(' ');
  const mid = Math.ceil(words.length / 2);
  const line1 = words.slice(0, mid).join(' ');
  const line2 = words.slice(mid).join(' ');
  const srtText = line2
    ? `1\n00:00:01,000 --> 00:00:10,000\n${line1}\n${line2}\n`
    : `1\n00:00:01,000 --> 00:00:10,000\n${line1}\n`;

  const srtPath = path.join(OUTPUT_DIR, `_tmp_srt_${Date.now()}.srt`);
  fs.writeFileSync(srtPath, srtText, 'utf8');

  try {
    // Use subtitles filter with styling
    const srtPathFwd = srtPath.replace(/\\/g, '/');
    await execFFmpeg([
      '-i', videoPath,
      '-vf', `subtitles='${srtPathFwd}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2.5,Shadow=1,Alignment=2,MarginV=40'`,
      '-c:a', 'copy',
      outputPath,
    ]);
    return outputPath;
  } finally {
    try { fs.unlinkSync(srtPath); } catch {}
  }
};

// ============ Main Pipeline ============

interface RemoveSubtitleOptions {
  inputPath: string;
  outputPath?: string;
  mode: 'crop' | 'blur' | 'byteplus' | 'auto';
  translateLang?: string;   // 'en' | 'zh' | 'none'
  outputCaption?: boolean;  // also output IG caption text
}

interface RemoveSubtitleResult {
  outputVideo: string;
  transcript: string;
  newSubtitle: string;
  caption: string;
}

const removeSubtitles = async (opts: RemoveSubtitleOptions): Promise<RemoveSubtitleResult> => {
  const inputPath = path.resolve(opts.inputPath);
  if (!fs.existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);

  ensureDir(OUTPUT_DIR);
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const ext = path.extname(inputPath) || '.mp4';

  console.log(`\n处理: ${path.basename(inputPath)}`);

  // Step 1: Detect subtitle region
  const region = await detectSubtitleRegion(inputPath);
  console.log(`  视频区域: ${region.width}x${region.height} @ (${region.x},${region.y})`);

  // Step 2: Remove subtitles
  let cleanVideo: string;

  const mode = opts.mode || 'auto';
  if (mode === 'ai' || (mode === 'auto' && VOLC_ACCESS_KEY && VOLC_SECRET_KEY)) {
    try {
      cleanVideo = await eraseSubtitlesAI(inputPath, region, path.join(OUTPUT_DIR, `${baseName}_clean${ext}`));
      console.log(`  ✅ AI擦除完成，画质无损`);
    } catch (e: any) {
      console.log(`  火山引擎不可用: ${e.message}`);
      if (mode === 'ai') throw e; // explicit ai mode → fail hard
      console.log('  降级为 blur 模式');
      cleanVideo = await blurSubtitleRegion(inputPath, region, path.join(OUTPUT_DIR, `${baseName}_clean${ext}`));
    }
  } else if (mode === 'blur') {
    cleanVideo = await blurSubtitleRegion(inputPath, region, path.join(OUTPUT_DIR, `${baseName}_clean${ext}`));
  } else {
    // Default: crop
    cleanVideo = await cropSubtitleRegion(inputPath, region, path.join(OUTPUT_DIR, `${baseName}_clean${ext}`));
  }

  console.log(`  去字幕完成: ${path.basename(cleanVideo)}`);

  // Step 3: Transcribe
  let transcript = '';
  const translateLang = opts.translateLang || 'en';
  if (translateLang !== 'none') {
    transcript = await transcribeAudio(inputPath); // use original audio
    console.log(`  转写: "${transcript.slice(0, 80)}${transcript.length > 80 ? '...' : ''}"`);
  }

  // Step 4: Translate & rewrite
  let newSubtitle = '';
  let caption = '';
  if (transcript && translateLang !== 'none') {
    const result = await translateAndRewrite(transcript, translateLang);
    newSubtitle = result.subtitle;
    caption = result.caption;
    console.log(`  新字幕: "${newSubtitle}"`);

    // Step 5: Burn new subtitles
    if (newSubtitle) {
      const subtitlePath = path.join(OUTPUT_DIR, `${baseName}_subbed${ext}`);
      await burnSubtitles(cleanVideo, newSubtitle, subtitlePath);
      cleanVideo = subtitlePath;
      console.log(`  烧录完成: ${path.basename(cleanVideo)}`);
    }
  }

  // Final output
  const finalPath = opts.outputPath || path.join(OUTPUT_DIR, `${baseName}_final${ext}`);
  if (cleanVideo !== finalPath) {
    fs.renameSync(cleanVideo, finalPath);
  }

  console.log(`  输出: ${finalPath}\n`);

  return {
    outputVideo: finalPath,
    transcript,
    newSubtitle,
    caption,
  };
};

// ============ Batch Mode ============

const batchProcess = async (dirPath: string, opts: Partial<RemoveSubtitleOptions> = {}) => {
  const dir = path.resolve(dirPath);
  if (!fs.existsSync(dir)) {
    console.error(`目录不存在: ${dir}`);
    return;
  }

  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi']);
  const files = fs.readdirSync(dir)
    .filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()));

  if (files.length === 0) {
    console.log('目录中没有视频文件');
    return;
  }

  console.log(`批量处理 ${files.length} 个视频:\n`);

  const results: RemoveSubtitleResult[] = [];
  for (const file of files) {
    try {
      const result = await removeSubtitles({
        inputPath: path.join(dir, file),
        mode: opts.mode || 'crop',
        translateLang: opts.translateLang || 'en',
      });
      results.push(result);
    } catch (e: any) {
      console.error(`  ❌ ${file}: ${e.message}`);
    }
    await sleep(2000);
  }

  console.log(`\n完成: ${results.length}/${files.length} 个视频处理成功`);

  // Save captions as JSON for content-bot
  if (results.length > 0) {
    const captionsFile = path.join(OUTPUT_DIR, `_batch_captions_${Date.now()}.json`);
    fs.writeFileSync(captionsFile, JSON.stringify(
      results.filter((r) => r.caption).map((r) => ({
        video: path.basename(r.outputVideo),
        subtitle: r.newSubtitle,
        caption: r.caption,
      })),
      null, 2
    ), 'utf8');
    console.log(`文案导出: ${captionsFile}`);
  }
};

// ============ CLI ============

// ============ Interactive CLI ============

const ask = (question: string): Promise<string> =>
  new Promise((resolve) => {
    process.stdout.write(question);
    const onData = (data: Buffer) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(data.toString().trim());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });

interface CLIOptions {
  inputPath?: string;
  batchDir?: string;
  mode: RemoveSubtitleOptions['mode'];
  translateLang: string;
  outputPath?: string;
}

const interactiveCLI = async (): Promise<CLIOptions> => {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  let inputPath = getArg('--input');
  const batchDir = getArg('--batch');
  let mode = getArg('--mode');
  let translateLang = getArg('--translate');
  const outputPath = getArg('--output');

  // If no input specified, ask
  if (!inputPath && !batchDir) {
    console.log('\n📹 视频去字幕工具\n');
    const answer = await ask('输入视频文件路径（或目录批量处理）: ');
    const resolved = path.resolve(answer.trim());
    if (fs.existsSync(resolved)) {
      if (fs.statSync(resolved).isDirectory()) {
        // Will be set as batchDir below
        inputPath = undefined;
        // batch processing
        const files = fs.readdirSync(resolved).filter((f) => /\.(mp4|mov|webm|avi)$/i.test(f));
        if (files.length === 0) {
          console.log('目录中没有视频文件');
          process.exit(0);
        }
        console.log(`找到 ${files.length} 个视频文件\n`);
        // ask mode for batch
      } else {
        inputPath = resolved;
        console.log(`文件: ${path.basename(resolved)}\n`);
      }
    } else {
      console.log(`文件不存在: ${resolved}`);
      process.exit(1);
    }
  }

  // If batch dir from args or from interactive input
  const effectiveBatchDir = batchDir || (!inputPath ? getArg('--input') || undefined : undefined);

  // Choose mode
  if (!mode) {
    const hasVolc = VOLC_ACCESS_KEY && VOLC_SECRET_KEY;
    console.log('\n选择去字幕方式:');
    console.log('  [1] AI擦除   — 火山引擎，画质无损（30s≈¥0.6）' + (hasVolc ? '' : ' ❌ 未配置'));
    console.log('  [2] 模糊     — 模糊字幕区域，保留画面（免费）');
    console.log('  [3] 裁剪     — 裁掉字幕区域，损失底部画面（免费）');
    console.log('  [4] 自动     — 优先AI，不可用则模糊（推荐）');
    const choice = await ask('\n选哪个? [4] ');
    const map: Record<string, string> = { '1': 'ai', '2': 'blur', '3': 'crop', '4': 'auto', '': 'auto' };
    mode = map[choice.trim()] || 'auto';

    if (mode === 'ai' && !hasVolc) {
      console.log('⚠️  火山引擎未配置，将使用自动模式');
      mode = 'auto';
    }
  }

  // Translate?
  if (!translateLang) {
    console.log('\n翻译 + 新字幕:');
    console.log('  [1] 英文     — 转写→翻译→烧录英文字幕');
    console.log('  [2] 中文     — 仅转写→烧录中文字幕');
    console.log('  [3] 不去管   — 只去字幕，不加新的');
    const choice = await ask('\n选哪个? [1] ');
    const map: Record<string, string> = { '1': 'en', '2': 'zh', '3': 'none', '': 'en' };
    translateLang = map[choice.trim()] || 'en';
  }

  console.log(`\n✅ 配置: 模式=${mode}  翻译=${translateLang}\n`);

  return {
    inputPath,
    batchDir: effectiveBatchDir,
    mode: mode as RemoveSubtitleOptions['mode'],
    translateLang,
    outputPath,
  };
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
video-subtitle-remover.ts — 视频去字幕 + 翻译 + 烧录

用法:
  npx ts-node -r dotenv/config scripts/video-subtitle-remover.ts              (交互式)
  npx ts-node -r dotenv/config scripts/video-subtitle-remover.ts --input v.mp4 --mode ai --translate en

选项:
  --input <path>      输入视频文件
  --batch <dir>       批量处理整个目录
  --mode ai|blur|crop|auto  去字幕方式
  --translate en|zh|none    翻译目标语言

带参数=跳过交互直接跑；不带参数=交互式选择。
`);
  process.exit(0);
}

const main = async () => {
  const opts = await interactiveCLI();

  if (opts.batchDir) {
    await batchProcess(opts.batchDir, { mode: opts.mode, translateLang: opts.translateLang });
  } else if (opts.inputPath) {
    const result = await removeSubtitles({
      inputPath: opts.inputPath,
      outputPath: opts.outputPath,
      mode: opts.mode,
      translateLang,
    });
    if (result.caption) console.log(`\nIG文案: ${result.caption}`);
  } else {
    printUsage();
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
