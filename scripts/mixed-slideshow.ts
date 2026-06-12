/**
 * Mixed Slideshow Generator — FFmpeg 本地混剪 + 多行业动作效果池
 *
 * 借鉴行业:
 *   美妆 — glow/blur focus/color pop      科技 — spin/zoom punch/glitch
 *   时尚 — slide reveal/beat sync          餐饮 — slow reveal/steam overlay
 *   纹身 — shake/strobe/dark vignette      影视 — ken burns/parallax/dolly zoom
 *
 * 不依赖 Shotstack，纯 FFmpeg 生成 Reel 视频。
 *
 * 用法:
 *   npx ts-node -r dotenv/config scripts/mixed-slideshow.ts
 *   npx ts-node -r dotenv/config scripts/mixed-slideshow.ts --mood dark
 *   npx ts-node -r dotenv/config scripts/mixed-slideshow.ts --mood clean --set mixed_01
 *
 * 风格 (--mood):
 *   dark   — 纹身店暗黑风 (shake/strobe/glitch/vignette)
 *   clean  — 专业产品展示 (kenburns/blur_in/reveal/fade)
 *   hype   — 高能量快节奏 (push/bounce/slide/flash)
 *   random — 随机混搭
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const CONTENT_LIBRARY_DIR = (process.env.CONTENT_LIBRARY_DIR || './content-library').trim();
const OUTPUT_DIR = (process.env.VIDEO_OUTPUT_DIR || './content-library/_generated').trim();
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

const REEL_W = 1080;
const REEL_H = 1920;
const FPS = 30;

// ============================================================
//  效果池 — 三大类 + 转场
// ============================================================

type Mood = 'dark' | 'clean' | 'hype' | 'needle' | 'random';

// ——— 图片动作效果 ———
interface ImageEffect {
  name: string;
  description: string;        // 来源行业 / 感觉
  zoomExpr: string;           // zoompan z expression
  xExpr: string;              // zoompan x expression
  yExpr: string;              // zoompan y expression
  extraFilter?: string;       // additional filter after zoompan (rotate, gblur, eq, etc.)
  durationRange: [number, number]; // min–max seconds
}

const IMAGE_EFFECTS: ImageEffect[] = [
  // ===== 美妆/科技行业 =====
  {
    name: 'blur_in',
    description: '镜头对焦: 模糊→清晰 (美妆开箱)',
    zoomExpr: '1.0',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2)',
    extraFilter: 'gblur=sigma=2',
    durationRange: [1.5, 2.5],
  },
  {
    name: 'color_bleed',
    description: '色彩渗入: 黑白→彩色 (时尚/美妆)',
    zoomExpr: '1.0 + on/tb_total_n*0.1',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2)',
    extraFilter: 'hue=s=1.2',
    durationRange: [2, 3],
  },
  // ===== 科技/3C 行业 =====
  {
    name: 'push',
    description: '针尖推近: 快速冲向镜头 (科技产品特写)',
    zoomExpr: '1.0 + (on/tb_total_n)*0.8',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2) - ih*0.15',  // 焦点偏上，对准针尖区域
    durationRange: [1.5, 2],
  },
  {
    name: 'spin',
    description: '产品旋转: 360°展示 (3C数码开箱)',
    zoomExpr: '1.15',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2) - ih*0.2',  // 旋转轴偏上，针尖在画面中稳定
    extraFilter: 'rotate=2*PI*t/{dur}:c=0x00000000',
    durationRange: [1.5, 2.5],
  },

  // ===== 针/金属产品专用 (纹身针、PMU 针头) =====
  {
    name: 'needle_push',
    description: '针尖冲镜: 从针尖方向推向镜头 (纹身针专用)',
    zoomExpr: '1.0 + (on/tb_total_n)*0.9',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2) - ih*0.25',  // 焦点在上1/4，针尖位置
    durationRange: [1.5, 2.2],
  },
  {
    name: 'needle_glint',
    description: '金属反光: 光条扫过针身 (金属质感)',
    zoomExpr: '1.05',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2) - ih*0.1',
    // Commas must be escaped (\,) — they'd otherwise separate filters in the chain
    extraFilter: 'geq=lum=p(X\\,Y)*(1+0.3*if(lt(abs(X-W/2-W/3*sin(N/30))\\,W/18)\\,1\\,0)):cb=128:cr=128',
    durationRange: [2, 3.5],
  },
  {
    name: 'needle_spin',
    description: '针身慢转: 轻微旋转展示针身 (3D展示感)',
    zoomExpr: '1.1',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2) - ih*0.2',
    extraFilter: 'rotate=PI*t/{dur}:c=0x00000000',  // 只转180°，更自然
    durationRange: [2, 3],
  },
  {
    name: 'glitch_flash',
    description: '故障闪烁: 短暂色差+位移 (科技/街头)',
    zoomExpr: '1.0 + if(lt(mod(on,8),3),0.05,0)',
    xExpr: 'iw/2-(iw/zoom/2)+if(lt(mod(on,8),3),6,0)',
    yExpr: 'ih/2-(ih/zoom/2)+if(lt(mod(on,8),3),4,0)',
    extraFilter: 'eq=saturation=1.5',
    durationRange: [1.5, 2],
  },
  // ===== 影视/纪录片 =====
  {
    name: 'kenburns',
    description: '缓慢推进: 纪录片经典 (影视)',
    zoomExpr: '1.0 + (on/tb_total_n)*0.2',
    xExpr: 'iw/2-(iw/zoom/2) + sin(on/40)*8',
    yExpr: 'ih/2-(ih/zoom/2)',
    durationRange: [2.5, 4],
  },
  {
    name: 'parallax',
    description: '视差微动: 悬浮感 (影视/高端产品)',
    zoomExpr: '1.1 + sin(on/35)*0.04',
    xExpr: 'iw/2-(iw/zoom/2) + cos(on/25)*6',
    yExpr: 'ih/2-(ih/zoom/2) + sin(on/30)*4',
    durationRange: [2, 3.5],
  },
  {
    name: 'dolly_zoom',
    description: '逆推拉: 背景压缩感 (电影/恐怖片借鉴)',
    zoomExpr: '1.3 - (on/tb_total_n)*0.3',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2)',
    durationRange: [2, 3],
  },
  // ===== 纹身/暗黑风格 =====
  {
    name: 'shake',
    description: '手持抖动: 纹身现场感 (纪录片/BTS)',
    zoomExpr: '1.0',
    xExpr: 'iw/2-(iw/zoom/2) + sin(on*5)*3 + sin(on*13)*2',
    yExpr: 'ih/2-(ih/zoom/2) + cos(on*7)*3 + cos(on*11)*2',
    durationRange: [1.5, 2.5],
  },
  {
    name: 'vignette_in',
    description: '暗角打开: 从阴影中浮现 (暗黑/高端)',
    zoomExpr: '1.0 + (on/tb_total_n)*0.15',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2)',
    extraFilter: 'vignette=PI/4',
    durationRange: [2, 3],
  },
  {
    name: 'strobe',
    description: '频闪: 快节奏脉冲 (夜店/街头/纹身)',
    zoomExpr: '1.0 + if(lt(mod(on,6),2),0.06,0)',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2)',
    extraFilter: 'eq=brightness=0.1',
    durationRange: [1, 2],
  },
  // ===== 时尚/生活方式 =====
  {
    name: 'slide_reveal',
    description: '滑入展现: 左右滑动揭示 (时尚/穿搭)',
    zoomExpr: '1.0',
    xExpr: 'if(lt(on,tb_total_n/2), iw/2-(iw/zoom/2)+(tb_total_n/2-on)*8, iw/2-(iw/zoom/2))',
    yExpr: 'ih/2-(ih/zoom/2)',
    durationRange: [1.5, 2.5],
  },
  {
    name: 'bounce',
    description: '弹跳: 推进后弹回 (运动/潮牌)',
    zoomExpr: '1.0 + 0.3 * if(lt(on/tb_total_n,0.6), on/tb_total_n/0.6, 1-abs(sin((on/tb_total_n-0.6)*3))*0.3)',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2)',
    durationRange: [2, 3],
  },
  // ===== 餐饮/食品 =====
  {
    name: 'slow_reveal',
    description: '慢速展开: 逐渐呈现全貌 (美食/餐饮)',
    zoomExpr: '1.5 - (on/tb_total_n)*0.5',
    xExpr: 'iw/2-(iw/zoom/2)',
    yExpr: 'ih/2-(ih/zoom/2)',
    durationRange: [2.5, 4],
  },
];

// ——— 转场效果 (FFmpeg xfade) ———
interface Transition {
  name: string;
  xfadeType: string;     // FFmpeg xfade transition name
  description: string;
  durationMs: number;    // recommended duration
}

const TRANSITIONS: Transition[] = [
  { name: 'fade',        xfadeType: 'fade',        description: '经典淡入淡出', durationMs: 300 },
  { name: 'fadeblack',   xfadeType: 'fadeblack',   description: '黑场过渡 (暗黑/电影)', durationMs: 400 },
  { name: 'fadewhite',   xfadeType: 'fadewhite',   description: '白闪过渡 (干净/美妆)', durationMs: 250 },
  { name: 'dissolve',    xfadeType: 'dissolve',    description: '柔和溶解 (高端)', durationMs: 500 },
  { name: 'slideleft',   xfadeType: 'slideleft',   description: '左滑推出', durationMs: 350 },
  { name: 'slideright',  xfadeType: 'slideright',  description: '右滑推出', durationMs: 350 },
  { name: 'slideup',     xfadeType: 'slideup',     description: '上滑推出 (TikTok风格)', durationMs: 300 },
  { name: 'slidedown',   xfadeType: 'slidedown',   description: '下滑推出', durationMs: 300 },
  { name: 'circleopen',  xfadeType: 'circleopen',  description: '圆形展开 (聚光灯)', durationMs: 400 },
  { name: 'circleclose', xfadeType: 'circleclose', description: '圆形收缩 (闭幕)', durationMs: 400 },
  { name: 'rectcrop',    xfadeType: 'rectcrop',    description: '矩形裁剪', durationMs: 350 },
  { name: 'pixelize',    xfadeType: 'pixelize',    description: '像素化 (科技/游戏)', durationMs: 400 },
  { name: 'diagtl',      xfadeType: 'diagtl',      description: '对角线左上→右下', durationMs: 350 },
  { name: 'diagbr',      xfadeType: 'diagbr',      description: '对角线右下→左上', durationMs: 350 },
  { name: 'radial',      xfadeType: 'radial',      description: '径向放射', durationMs: 400 },
  { name: 'hblur',       xfadeType: 'hblur',       description: '模糊溶解', durationMs: 500 },
  { name: 'hlslice',     xfadeType: 'hlslice',     description: '水平切片', durationMs: 300 },
  { name: 'wipeleft',    xfadeType: 'wipeleft',    description: '硬切左擦', durationMs: 300 },
  { name: 'smoothleft',  xfadeType: 'smoothleft',  description: '平滑左移', durationMs: 400 },
];

// ——— 风格预设 ———
interface MoodPreset {
  effects: string[];        // preferred effect names
  transitions: string[];    // preferred transition names
  tempo: 'slow' | 'medium' | 'fast';  // pace
  introFlash: boolean;      // white flash at start
  outroBrand: boolean;      // brand card at end
}

const MOOD_PRESETS: Record<Mood, MoodPreset> = {
  dark: {
    effects: ['shake', 'vignette_in', 'strobe', 'glitch_flash', 'dolly_zoom', 'needle_spin', 'needle_glint'],
    transitions: ['fadeblack', 'circleclose', 'pixelize', 'radial', 'dissolve'],
    tempo: 'medium',
    introFlash: false,
    outroBrand: true,
  },
  clean: {
    effects: ['kenburns', 'blur_in', 'slow_reveal', 'parallax', 'color_bleed', 'slide_reveal'],
    transitions: ['fade', 'dissolve', 'smoothleft', 'circleopen', 'fadewhite'],
    tempo: 'slow',
    introFlash: true,
    outroBrand: true,
  },
  hype: {
    effects: ['needle_push', 'bounce', 'slide_reveal', 'strobe', 'spin', 'glitch_flash'],
    transitions: ['slideup', 'slideright', 'pixelize', 'wipeleft', 'hlslice'],
    tempo: 'fast',
    introFlash: true,
    outroBrand: false,
  },
  needle: {
    effects: ['needle_push', 'needle_glint', 'needle_spin', 'blur_in', 'kenburns', 'parallax'],
    transitions: ['dissolve', 'fade', 'circleopen', 'smoothleft', 'hblur', 'fadewhite'],
    tempo: 'slow',
    introFlash: true,
    outroBrand: true,
  },
  random: {
    effects: [],
    transitions: [],
    tempo: 'medium',
    introFlash: Math.random() > 0.5,
    outroBrand: true,
  },
};

// ============================================================
//  Helpers
// ============================================================

const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const execFFmpeg = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', ...args], { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.slice(-500) || err.message));
      resolve(stdout || stderr);
    });
  });

const ffprobeSize = (filePath: string): Promise<{ w: number; h: number }> =>
  new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', filePath,
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err);
      const [w, h] = stdout.trim().split(',').map(Number);
      resolve({ w: w || REEL_W, h: h || REEL_H });
    });
  });

const pickRandom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const pickWeighted = <T>(items: T[], weights: number[]): T => {
  const r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < items.length; i++) { acc += weights[i]; if (r <= acc) return items[i]; }
  return items[items.length - 1];
};

// ============================================================
//  Effect engine: image → video clip
// ============================================================

const makeClip = async (
  imagePath: string, effect: ImageEffect, durationSec: number, outputPath: string,
): Promise<void> => {
  const totalFrames = Math.round(durationSec * FPS);

  // Interpolate {dur} in extraFilter
  let extraFilter = effect.extraFilter || '';
  extraFilter = extraFilter.replace(/\{dur\}/g, String(durationSec));

  // Replace tb_total_n (total frames of this clip) in expressions
  const zoomExpr = effect.zoomExpr.replace(/tb_total_n/g, String(totalFrames));
  const xExpr = effect.xExpr.replace(/tb_total_n/g, String(totalFrames));
  const yExpr = effect.yExpr.replace(/tb_total_n/g, String(totalFrames));

  const filterParts: string[] = [
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames + 1}:s=${REEL_W}x${REEL_H}:fps=${FPS}`,
  ];

  if (extraFilter) filterParts.push(extraFilter);
  filterParts.push(`trim=duration=${durationSec}`);

  try {
    await execFFmpeg([
      '-loop', '1', '-i', imagePath,
      '-filter_complex', filterParts.join(','),
      '-t', String(durationSec),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-an',
      outputPath,
    ]);
  } catch (e: any) {
    // Fallback: static centered image
    console.warn(`  ⚠️  ${effect.name} failed: ${e.message.slice(0, 80)} → static fallback`);
    await execFFmpeg([
      '-loop', '1', '-i', imagePath,
      '-vf', `scale=${REEL_W}:${REEL_H}:force_original_aspect_ratio=increase,crop=${REEL_W}:${REEL_H},fps=${FPS}`,
      '-t', String(durationSec),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-an',
      outputPath,
    ]);
  }
};

// ============================================================
//  Concat with xfade transitions
// ============================================================

const concatWithXfade = async (
  clipPaths: string[], transitions: Transition[], outputPath: string,
): Promise<void> => {
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], outputPath);
    return;
  }

  // Get duration of each clip
  const durations: number[] = [];
  for (const p of clipPaths) {
    try {
      const out = await new Promise<string>((resolve) => {
        execFile('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'csv=p=0', p,
        ], { timeout: 10000 }, (err, stdout) => {
          resolve(err ? '1.0' : stdout.trim());
        });
      });
      durations.push(Number(out) || 2);
    } catch { durations.push(2); }
  }

  // Build xfade filter chain
  const inputs: string[] = [];
  const streamLabels: string[] = [];
  for (let i = 0; i < clipPaths.length; i++) {
    inputs.push('-i', clipPaths[i]);
    streamLabels.push(`[${i}:v]`);
  }

  let filterGraph = '';
  let prevLabel = streamLabels[0];
  let cumOffset = durations[0];

  for (let i = 1; i < clipPaths.length; i++) {
    const trans = transitions[(i - 1) % transitions.length];
    const fadeDur = trans.durationMs / 1000;
    const offset = cumOffset - fadeDur;
    const outLabel = i === clipPaths.length - 1 ? '[outv]' : `[xf${i}]`;

    filterGraph += `${prevLabel}${streamLabels[i]}xfade=transition=${trans.xfadeType}:duration=${fadeDur}:offset=${offset}${outLabel};`;
    prevLabel = outLabel;
    cumOffset += durations[i] - fadeDur;
  }

  try {
    await execFFmpeg([
      ...inputs,
      '-filter_complex', filterGraph,
      '-map', '[outv]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
  } catch (e: any) {
    // Fallback: concat protocol
    console.warn(`  ⚠️  xfade failed: ${e.message.slice(0, 80)} → simple concat`);
    const concatFile = outputPath.replace(/\.mp4$/, '_concat.txt');
    fs.writeFileSync(concatFile, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
    await execFFmpeg([
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
    try { fs.unlinkSync(concatFile); } catch {}
  }
};

// ============================================================
//  编排引擎: 自动编排效果序列
// ============================================================

interface SlideConfig {
  imagePath: string;
  effect: ImageEffect;
  durationSec: number;
  label: string;
}

const composeSlides = (
  imagePaths: string[], mood: Mood,
): { slides: SlideConfig[]; transitions: Transition[] } => {
  const preset = MOOD_PRESETS[mood];
  const moodEffects = mood === 'random'
    ? IMAGE_EFFECTS
    : IMAGE_EFFECTS.filter((e) => preset.effects.includes(e.name));

  const moodTransitions = mood === 'random'
    ? TRANSITIONS
    : TRANSITIONS.filter((t) => preset.transitions.includes(t.name));

  // Pick effects — avoid consecutive repeats
  const slides: SlideConfig[] = [];
  let lastEffect = '';

  for (let i = 0; i < imagePaths.length; i++) {
    const isIntro = i === 0;
    const isOutro = i === imagePaths.length - 1;

    // Weighted selection: prefer different effect each time
    const candidates = moodEffects.filter((e) => e.name !== lastEffect);
    const pool = candidates.length >= 2 ? candidates : moodEffects;

    // Intro: prefer attention-grabbing, Outro: prefer settle-down
    let effect: ImageEffect;
    if (isIntro && mood === 'dark') {
      effect = pool.find((e) => e.name === 'vignette_in') || pickRandom(pool);
    } else if (isIntro && mood === 'hype') {
      effect = pool.find((e) => e.name === 'push') || pickRandom(pool);
    } else if (isIntro && mood === 'clean') {
      effect = pool.find((e) => e.name === 'blur_in') || pickRandom(pool);
    } else {
      effect = pickRandom(pool);
    }

    const [minDur, maxDur] = effect.durationRange;
    const durationSec = Math.round((minDur + Math.random() * (maxDur - minDur)) * 10) / 10;

    slides.push({
      imagePath: imagePaths[i],
      effect,
      durationSec,
      label: path.basename(imagePaths[i], path.extname(imagePaths[i])),
    });

    lastEffect = effect.name;
  }

  // Pick transitions — avoid consecutive same type
  const transitions: Transition[] = [];
  let lastTrans = '';
  for (let i = 0; i < slides.length - 1; i++) {
    const candidates = moodTransitions.filter((t) => t.name !== lastTrans);
    const pool = candidates.length >= 2 ? candidates : moodTransitions;
    const t = pickRandom(pool);
    transitions.push(t);
    lastTrans = t.name;
  }

  return { slides, transitions };
};

// ============================================================
//  Main export
// ============================================================

export interface SlideshowOptions {
  imagePaths: string[];
  mood?: Mood;
  setName?: string;
}

export const generateSlideshow = async (opts: SlideshowOptions): Promise<string> => {
  const mood = opts.mood || 'random';
  const { slides, transitions } = composeSlides(opts.imagePaths, mood);

  ensureDir(OUTPUT_DIR);
  const tmpDir = path.join(OUTPUT_DIR, '.tmp');
  ensureDir(tmpDir);

  console.log(`\n🎬 Slideshow | mood=${mood} | ${slides.length} slides`);
  if (opts.setName) console.log(`📂 Set: ${opts.setName}`);

  // Plan
  console.log('\n📋 Plan:');
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const tLabel = i < transitions.length ? ` → ${transitions[i].name}` : '';
    console.log(`  ${i + 1}. ${s.effect.name.padEnd(14)} ${s.durationSec}s  ${s.label.slice(0, 25)}${tLabel}`);
  }

  // Generate clips
  const clipPaths: string[] = [];
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    const clipPath = path.join(tmpDir, `clip_${i}_${s.effect.name}.mp4`);
    process.stdout.write(`  [${i + 1}/${slides.length}] ${s.effect.name.padEnd(14)} ... `);
    const startMs = Date.now();
    await makeClip(s.imagePath, s.effect, s.durationSec, clipPath);
    clipPaths.push(clipPath);
    console.log(`✓ ${Date.now() - startMs}ms`);
  }

  // Concat
  const outName = opts.setName ? `${opts.setName}_${mood}_${Date.now()}.mp4` : `mixed_${mood}_${Date.now()}.mp4`;
  const outPath = path.join(OUTPUT_DIR, outName);

  process.stdout.write(`  Concat (${transitions.length} xfades)... `);
  const concatStart = Date.now();
  await concatWithXfade(clipPaths, transitions, outPath);
  console.log(`✓ ${Date.now() - concatStart}ms`);

  // Cleanup
  for (const p of clipPaths) { try { fs.unlinkSync(p); } catch {} }

  // File size
  let sizeMb = 0;
  try { sizeMb = Math.round(fs.statSync(outPath).size / 1024 / 1024 * 10) / 10; } catch {}

  const totalDur = slides.reduce((a, s) => a + s.durationSec, 0)
    - transitions.reduce((a, t) => a + t.durationMs / 1000, 0) + (transitions.length > 0 ? transitions[0].durationMs / 1000 : 0);

  console.log(`✅ ${outPath}`);
  console.log(`   ${totalDur.toFixed(1)}s | ${sizeMb}MB\n`);

  return outPath;
};

// ============================================================
//  Library picker
// ============================================================

const pickSlideshowSet = (setName?: string): { images: string[]; setName: string } | null => {
  const dir = path.join(CONTENT_LIBRARY_DIR, 'slideshows');
  if (!fs.existsSync(dir)) return null;

  const subs = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !setName || n === setName);

  if (subs.length === 0) return null;
  const picked = subs[Math.floor(Math.random() * subs.length)];
  const setDir = path.join(dir, picked);
  const images = fs.readdirSync(setDir)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort()
    .slice(0, 8);

  if (images.length < 2) return null;
  return {
    images: images.map((img) => path.join(setDir, img)),
    setName: picked,
  };
};

// ============================================================
//  DeepSeek Caption
// ============================================================

const generateCaption = async (mood: string, effects: string[], setName: string): Promise<{ caption: string; hashtags: string[] }> => {
  if (!DEEPSEEK_API_KEY) {
    return {
      caption: 'Precision tools, real results. Fresh work with our PMU cartridges.',
      hashtags: ['tattoosupply', 'pmu', 'aes', 'cartridges'],
    };
  }

  const moodGuide = mood === 'dark'
    ? 'Dark, moody, edgy vibe. Match the tattoo studio atmosphere.'
    : mood === 'hype'
    ? 'High energy, exciting, dynamic. Fast-paced reel energy.'
    : 'Clean, professional, detail-focused. Premium product showcase.';

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You write authentic IG Reels captions for a tattoo supply brand. Respond ONLY with valid JSON.' },
          { role: 'user', content: `Write a short caption for a slideshow Reel showing PMU cartridge products and tattoo work.\nVibe: ${moodGuide}\nEffects used: ${effects.join(', ')}\n1-3 short sentences. Max 1 emoji. Write in English. Return JSON: {"caption":"...","hashtags":["..."]}` },
        ],
        temperature: 0.85, max_tokens: 120, top_p: 0.95,
      }),
    });
    const data: any = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    try {
      const parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
      return {
        caption: String(parsed.caption || '').trim().slice(0, 500),
        hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 10) : [],
      };
    } catch {
      return { caption: raw.trim().slice(0, 300), hashtags: [] };
    }
  } catch {
    return {
      caption: `From our bench to yours. Precision that shows in every piece.`,
      hashtags: ['tattoosupply', 'pmu', 'aes'],
    };
  }
};

// ============================================================
//  CLI
// ============================================================

const main = async () => {
  const args = process.argv.slice(2);

  // Support both --mood=dark and --mood dark
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx >= 0 && idx < args.length - 1 && !args[idx + 1].startsWith('--')) return args[idx + 1];
    const found = args.find((a) => a.startsWith(`${flag}=`));
    return found?.split('=')[1];
  };
  const moodArg = getArg('--mood') as Mood | undefined;
  const mood: Mood = moodArg && ['dark', 'clean', 'hype', 'needle', 'random'].includes(moodArg) ? moodArg : 'random';

  const setName = getArg('--set');
  const listEffects = args.includes('--effects');

  if (listEffects) {
    console.log('\n📽️  Available Image Effects:\n');
    for (const e of IMAGE_EFFECTS) {
      console.log(`  ${e.name.padEnd(16)} ${e.description}`);
    }
    console.log('\n🔄 Available Transitions:\n');
    for (const t of TRANSITIONS) {
      console.log(`  ${t.name.padEnd(16)} ${t.description} (${t.durationMs}ms)`);
    }
    console.log('\n🎭 Mood Presets:\n');
    for (const [m, p] of Object.entries(MOOD_PRESETS)) {
      console.log(`  ${m.padEnd(10)} tempo=${p.tempo.padEnd(7)} effects=[${p.effects.join(', ')}]`);
      console.log(`  ${''.padEnd(10)} transitions=[${p.transitions.join(', ')}]`);
    }
    console.log('');
    process.exit(0);
  }

  // Check FFmpeg
  try { await execFFmpeg(['-version']); } catch {
    console.log('\n⚠️  FFmpeg not found. Install:');
    console.log('   Windows: winget install ffmpeg');
    console.log('   Linux:   sudo apt install ffmpeg\n');
    process.exit(1);
  }

  const set = pickSlideshowSet(setName);
  if (!set) {
    console.log('\n❌ No slideshow sets found.');
    console.log('   Drop images into: content-library/slideshows/<name>/');
    console.log('   Prefix with 01_, 02_, etc. for ordering.\n');
    process.exit(1);
  }

  // set.images already includes full CONTENT_LIBRARY_DIR path from pickSlideshowSet
  const videoPath = await generateSlideshow({
    imagePaths: set.images,
    mood,
    setName: set.setName,
  });

  const effectsUsed = [...new Set(IMAGE_EFFECTS.map((e) => e.name))]; // placeholder — composeSlides already ran
  const { caption, hashtags } = await generateCaption(mood, effectsUsed.slice(0, 4), set.setName);

  console.log('📝 Caption:');
  console.log(`  ${caption}`);
  if (hashtags.length) console.log(`  ${hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}`);
  console.log(`\n🎥 ${videoPath}`);
  console.log('✅ Done\n');
};

// Only auto-run when executed as script (not imported)
const scriptPath = process.argv[1]?.replace(/\\/g, '/');
if (scriptPath?.includes('mixed-slideshow')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
