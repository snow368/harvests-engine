/**
 * Content Creation Guide — AI 驱动的生成+编辑指导
 *
 * 不实拍，用 AI 生成/编辑内容。
 * 输入：纹身风格 + 内容类型 → 输出：AI prompt + 后期方案
 * 对接 content-bot.ts 的 6 种内容类型。
 *
 * 用法: npx tsx scripts/content-creation-guide.ts
 *
 * ENV:
 *   GUIDE_STYLE=fine_line,blackwork,color  (纹身风格)
 *   GUIDE_TYPES=static_post,ai_animation    (内容类型，逗号分隔，空=全部)
 *   GUIDE_OUTPUT=./data/bot_state/content_guides/  (输出目录)
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

// ============ Config ============
const DEEPSEEK_API_KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';
const REPLICATE_API_KEY = (process.env.REPLICATE_API_KEY || '').trim();
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY || '').trim();
const SHOTSTACK_API_KEY = (process.env.SHOTSTACK_API_KEY || '').trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

const OUTPUT_DIR = process.env.GUIDE_OUTPUT || path.join(process.cwd(), 'data', 'bot_state', 'content_guides');
const TARGET_STYLES = (process.env.GUIDE_STYLE || 'fine_line,blackwork,color,realism,traditional,geometric').split(',').map(s => s.trim());
const TARGET_TYPES = (process.env.GUIDE_TYPES || 'static_post,slideshow_reel,ai_animation,video_remix,voiceover_reel,artist_feature').split(',').map(s => s.trim());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

// ============ AI Platform Presets ============

interface AIPlatform {
  name: string;
  bestFor: string[];
  aspectRatios: string[];
  promptStyle: string;
  negativePromptDefaults: string;
}

const AI_PLATFORMS: Record<string, AIPlatform> = {
  midjourney: {
    name: 'Midjourney v6.1',
    bestFor: ['static_post', 'slideshow_reel', 'artist_feature'],
    aspectRatios: ['1:1', '4:5', '9:16'],
    promptStyle: 'descriptive natural language, comma-separated details, --style raw for tattoo realism',
    negativePromptDefaults: 'watermark, text, signature, low quality, distorted anatomy, bad hands, blurry',
  },
  stableDiffusion: {
    name: 'Stable Diffusion XL / Flux',
    bestFor: ['static_post', 'ai_animation'],
    aspectRatios: ['1:1', '4:5', '16:9'],
    promptStyle: 'tag-based, weighted tokens with (emphasis:1.2) syntax',
    negativePromptDefaults: 'watermark, text, signature, lowres, bad anatomy, bad hands, cropped, worst quality',
  },
  runway: {
    name: 'Runway Gen-4 Turbo',
    bestFor: ['ai_animation'],
    aspectRatios: ['16:9', '9:16', '1:1'],
    promptStyle: 'start frame description → motion description, cinematic terms',
    negativePromptDefaults: 'jerky motion, morphing, distortion, flickering, inconsistent lighting',
  },
  kling: {
    name: 'Kling v2.5 Turbo Pro',
    bestFor: ['ai_animation'],
    aspectRatios: ['16:9', '9:16'],
    promptStyle: 'Chinese or English, detailed scene + motion + camera movement',
    negativePromptDefaults: '变形, 抖动, 闪烁, 不连贯, distortion, flicker',
  },
};

// ============ Tattoo Style Visual Presets ============

interface TattooStylePromptKit {
  coreSubject: string;
  lighting: string;
  mood: string;
  colorPalette: string;
  skinTone: string;
  background: string;
  avoidTraits: string;
}

const TATTOO_STYLE_KITS: Record<string, TattooStylePromptKit> = {
  fine_line: {
    coreSubject: 'delicate fine line tattoo, single needle, hair-thin lines, precise dotwork, minimalist design',
    lighting: 'soft diffused window light, no harsh shadows, even illumination to show line weight',
    mood: 'elegant, refined, modern minimalism, editorial',
    colorPalette: 'black ink only, warm natural skin, neutral grey background',
    skinTone: 'clean smooth skin, no redness, healed tattoo',
    background: 'light neutral grey or cream seamless, clean and uncluttered',
    avoidTraits: 'bold lines, color ink, busy background, blood, swelling, stencil marks',
  },
  blackwork: {
    coreSubject: 'bold blackwork tattoo, solid black packing, high contrast, dramatic shading, dark art aesthetic',
    lighting: 'dramatic single source light, deep shadows, rim light for texture on black areas',
    mood: 'dark, powerful, gothic, sculptural',
    colorPalette: 'deep black, charcoal grey gradients, pale skin, dark or black background',
    skinTone: 'pale to medium skin to maximize contrast, healed',
    background: 'dark charcoal or black seamless, or industrial texture',
    avoidTraits: 'color ink, muddy greys, patchy fill, inconsistent saturation',
  },
  color: {
    coreSubject: 'vibrant color tattoo, smooth color blends, saturated pigments, neotraditional or illustrative style',
    lighting: '5600K daylight balanced, no warm tint, even wrap lighting to avoid color shift',
    mood: 'lively, artistic, bold, eye-catching',
    colorPalette: 'full spectrum, rich primaries, smooth gradients, no color banding',
    skinTone: 'clean healed skin, neutral tone, no tan lines',
    background: 'white or light grey seamless, zero color cast',
    avoidTraits: 'muddy blends, desaturated look, overexposed highlights hiding color, jaundiced skin tone',
  },
  realism: {
    coreSubject: 'photorealistic tattoo, portrait or nature realism, smooth grey wash, micro details, 3D depth',
    lighting: 'soft wrap lighting, low ratio fill, avoid specular highlights on curved body parts',
    mood: 'fine art, gallery quality, museum lighting',
    colorPalette: 'grey wash (warm or cool), subtle skin tones for B&G realism, controlled saturation for color realism',
    skinTone: 'even skin texture, minimal pores visible, healed 4+ weeks',
    background: 'deep black or dark grey, minimal distraction',
    avoidTraits: 'harsh flash lighting, cell phone flash, red/inflamed skin, stubble, lotion shine',
  },
  traditional: {
    coreSubject: 'American traditional tattoo, bold lines, limited color palette, classic flash designs, sailor jerry style',
    lighting: 'even broad light, slight warmth, saturated colors need accurate exposure',
    mood: 'classic, timeless, bold, Americana',
    colorPalette: 'red, yellow, green, black — classic 4-color palette, high saturation',
    skinTone: 'any skin tone, but color accuracy is priority',
    background: 'clean warm neutral, or vintage texture',
    avoidTraits: 'muted colors, thin lines, overworked shading, purple/blue tones in black',
  },
  geometric: {
    coreSubject: 'geometric tattoo, mandala, sacred geometry, dotwork, perfect symmetry, mathematical precision',
    lighting: 'flat even light, zero shadows that break symmetry perception, cross-polarized to kill reflections',
    mood: 'precise, meditative, architectural, clean',
    colorPalette: 'black + occasional gold or red accent, clean negative space',
    skinTone: 'smooth skin, minimal texture distraction',
    background: 'pure white or pure black, no texture',
    avoidTraits: 'asymmetric angles, uneven dot spacing, warped lines on curved body, reflections',
  },
};

// ============ Content Type AI Specs ============

interface ContentTypeAISpec {
  contentType: string;
  outputFormat: string;
  aiTools: string;
  promptFocus: string;
  postProduction: string;
  contentBotType: string;
}

const CONTENT_TYPE_AI_SPECS: Record<string, ContentTypeAISpec> = {
  static_post: {
    contentType: 'static_post',
    outputFormat: '1080x1080 or 1080x1350 PNG/JPEG',
    aiTools: 'Midjourney / Stable Diffusion / DALL-E 3',
    promptFocus: 'single hero image, product or tattoo design, editorial quality, high detail',
    postProduction: 'Lightroom color grade, watermark, resize to IG specs',
    contentBotType: 'static_post',
  },
  slideshow_reel: {
    contentType: 'slideshow_reel',
    outputFormat: '1080x1080 MP4 (Shotstack render), 3-6 image sequence',
    aiTools: 'Midjourney (generate 3-6 images) → Shotstack (render slideshow)',
    promptFocus: 'cohesive image set, consistent lighting and color palette, visual progression',
    postProduction: 'Shotstack transition timing, music sync, fade effects',
    contentBotType: 'slideshow_reel',
  },
  ai_animation: {
    contentType: 'ai_animation',
    outputFormat: '1080x1920 or 1920x1080 MP4, 5-8 seconds',
    aiTools: 'Runway Gen-4 Turbo / Kling v2.5 / Luma Dream Machine',
    promptFocus: 'start frame description + smooth motion direction + camera movement',
    postProduction: 'speed ramp, loop seam, color grade, music overlay, caption burn',
    contentBotType: 'ai_animation',
  },
  video_remix: {
    contentType: 'video_remix',
    outputFormat: '1080x1920 MP4, 15-30 seconds',
    aiTools: 'Whisper (transcribe) → DeepSeek (translate/rewrite) → FFmpeg (burn subs + reframe)',
    promptFocus: 'select best 15-30s clip, translate to English, add brand watermark, repurpose',
    postProduction: '9:16 reframe, subtitle burn, brand intro/outro 2s, audio normalization',
    contentBotType: 'video_remix',
  },
  voiceover_reel: {
    contentType: 'voiceover_reel',
    outputFormat: '1080x1080 MP4, 15-25 seconds',
    aiTools: 'Midjourney (image) → DeepSeek (script) → ElevenLabs (TTS) → FFmpeg (combine)',
    promptFocus: 'script first: hook + product benefit + CTA in 20s; image matches script topic',
    postProduction: 'audio ducking for music, waveform visualization optional, caption overlay',
    contentBotType: 'voiceover_reel',
  },
  artist_feature: {
    contentType: 'artist_feature',
    outputFormat: '1080x1350 PNG or 1080x1080 MP4 (with watermark)',
    aiTools: 'DeepSeek (caption only) + FFmpeg (watermark overlay on video)',
    promptFocus: 'caption writing: celebrate artist, subtly credit product, genuine tone',
    postProduction: 'watermark overlay bottom-right, optional before/after frame extraction',
    contentBotType: 'artist_feature',
  },
};

// ============ AI Prompt Generation ============

interface AIImagePrompt {
  platform: string;
  positivePrompt: string;
  negativePrompt: string;
  aspectRatio: string;
  styleReference: string;
  parameters: string;
}

interface AIAnimationPrompt {
  platform: string;
  startFrameDescription: string;
  motionDescription: string;
  duration: number;
  cameraMovement: string;
  negativePrompt: string;
  parameters: string;
}

interface VoiceoverSpec {
  script: string;
  voiceId: string;
  voiceSettings: { stability: number; similarity_boost: number };
  musicMood: string;
  timing: string;
}

interface CaptionKit {
  captionTemplate: string;
  captionVariations: string[];
  hashtagStrategy: { broad: string[]; niche: string[]; local: string[] };
  hook: string;
  cta: string;
}

interface AIGenerationGuide {
  generatedAt: string;
  targetStyle: string;
  targetType: string;
  imagePrompt: AIImagePrompt | null;
  animationPrompt: AIAnimationPrompt | null;
  voiceover: VoiceoverSpec | null;
  caption: CaptionKit | null;
  coverDesign: string;
  musicMood: string;
  postProductionSteps: string[];
  contentBotMapping: string;
}

// ============ AI Prompt Builders ============

const buildImagePrompt = async (style: string, contentType: string): Promise<AIImagePrompt | null> => {
  if (!DEEPSEEK_API_KEY) return null;

  const kit = TATTOO_STYLE_KITS[style] || TATTOO_STYLE_KITS.fine_line;
  const spec = CONTENT_TYPE_AI_SPECS[contentType];
  if (!spec) return null;

  const platformInfo = AI_PLATFORMS.midjourney;

  const prompt = `You are an AI art director specializing in tattoo content. Generate a Midjourney v6.1 prompt.

Tattoo Style: ${style}
Content Type: ${contentType}
What this content type needs: ${spec.promptFocus}

Visual reference for ${style} tattoos:
- Core subject: ${kit.coreSubject}
- Lighting: ${kit.lighting}
- Mood: ${kit.mood}
- Color palette: ${kit.colorPalette}
- Skin tone: ${kit.skinTone}
- Background: ${kit.background}
- Avoid: ${kit.avoidTraits}

Return JSON:
{
  "positivePrompt": "full Midjourney prompt, comma-separated, include camera/lens terms for photorealism, include lighting and composition details, end with --ar [ratio] --style raw --v 6.1",
  "negativePrompt": "things to exclude",
  "aspectRatio": "1:1 or 4:5 (IG optimal)",
  "styleReference": "what visual style this references (e.g. editorial photography, dark art, commercial product)",
  "parameters": "any additional MJ parameters like --stylize, --chaos, etc."
}

Rules:
- Be EXTREMELY specific about tattoo details (line weight, shading style, color saturation)
- For product-focused content, describe the tattoo equipment/supply in detail
- Include camera terms: macro lens, shallow depth of field, f/2.8, etc. for photorealism
- For fine_line/realism, emphasize precision and detail visibility
- For color tattoos, specify exact color transitions and saturation levels
- The image should look like a professional tattoo photo, not a digital illustration`;

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6, max_tokens: 600,
      }),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(text);
      return {
        platform: platformInfo.name,
        positivePrompt: parsed.positivePrompt || '',
        negativePrompt: parsed.negativePrompt || platformInfo.negativePromptDefaults,
        aspectRatio: parsed.aspectRatio || '1:1',
        styleReference: parsed.styleReference || '',
        parameters: parsed.parameters || '',
      };
    } catch { return null; }
  } catch { return null; }
};

const buildAnimationPrompt = async (style: string, contentType: string): Promise<AIAnimationPrompt | null> => {
  if (!DEEPSEEK_API_KEY || contentType !== 'ai_animation') return null;

  const kit = TATTOO_STYLE_KITS[style] || TATTOO_STYLE_KITS.fine_line;

  const prompt = `You are an AI motion designer. Generate a Runway Gen-4 / Kling image-to-video animation prompt.

Tattoo Style: ${style}
Visual details: ${kit.coreSubject}. ${kit.lighting}. ${kit.mood}.

The animation should bring a static tattoo image to life with subtle, professional motion.

Return JSON:
{
  "startFrameDescription": "detailed description of the starting still image",
  "motionDescription": "describe the motion: camera move, subject animation, lighting changes. Use cinematic terms like slow push-in, subtle parallax, gentle dolly. For tattoos: subtle skin breathing effect, light sweeping across to reveal detail, depth of field rack focus",
  "duration": 5,
  "cameraMovement": "e.g. slow push-in with slight parallax / orbital pan / tilt reveal / macro rack focus",
  "negativePrompt": "what to avoid in motion",
  "parameters": "model-specific parameters (e.g. motion_bucket_id, cfg_scale for Runway)"
}

Key rules for tattoo animation:
- NO morphing or distortion of the tattoo design
- Subtle motion only — this is a tattoo reveal, not an action scene
- Camera movement should reveal details progressively
- Lighting movement should highlight texture and depth
- Motion must loop naturally (seamless start/end)`;

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5, max_tokens: 500,
      }),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(text);
      return {
        platform: 'Runway Gen-4 Turbo / Kling v2.5',
        startFrameDescription: parsed.startFrameDescription || '',
        motionDescription: parsed.motionDescription || '',
        duration: parsed.duration || 5,
        cameraMovement: parsed.cameraMovement || 'slow push-in',
        negativePrompt: parsed.negativePrompt || AI_PLATFORMS.runway.negativePromptDefaults,
        parameters: parsed.parameters || '',
      };
    } catch { return null; }
  } catch { return null; }
};

const buildVoiceover = async (style: string, contentType: string): Promise<VoiceoverSpec | null> => {
  if (!DEEPSEEK_API_KEY || contentType !== 'voiceover_reel') return null;

  const kit = TATTOO_STYLE_KITS[style] || TATTOO_STYLE_KITS.fine_line;

  const prompt = `You are a short-form video scriptwriter for a tattoo supply brand. Write a 15-20 second voiceover script.

Tattoo Style: ${style}
Visual context: ${kit.coreSubject}
Mood: ${kit.mood}

Content type: Voiceover reel (image + AI voice narration → short video)

Return JSON:
{
  "script": "the full voiceover narration text, 15-20 seconds when spoken. Hook in first 3 seconds. Include product benefit naturally. End with soft CTA.",
  "voiceId": "best ElevenLabs voice: use '21m00Tcm4TlvDq8ikWAM' (Rachel - warm professional female) or '29vD33N1CtxCmqQRPOHJ' (Charlie - natural male) or 'EXAVITQu4vr4xnSDxMaL' (Bella - soft female)",
  "voiceSettings": {"stability": 0.5, "similarity_boost": 0.75},
  "musicMood": "background music mood that matches the ${style} tattoo aesthetic: ${kit.mood}",
  "timing": "approximate word timing breakdown"
}

Rules:
- Script must sound like a real person talking, not a commercial
- No "buy now", no "discount code", no hard sell
- If style is bold (traditional/blackwork): confident, punchy delivery
- If style is delicate (fine_line/geometric): calm, precise, appreciative
- Mention ONE product benefit naturally in context`;

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7, max_tokens: 500,
      }),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(text);
      return {
        script: parsed.script || '',
        voiceId: parsed.voiceId || '21m00Tcm4TlvDq8ikWAM',
        voiceSettings: parsed.voiceSettings || { stability: 0.5, similarity_boost: 0.75 },
        musicMood: parsed.musicMood || 'ambient electronic',
        timing: parsed.timing || '~3 words per second, 45-60 words total',
      };
    } catch { return null; }
  } catch { return null; }
};

const buildCaption = async (style: string, contentType: string): Promise<CaptionKit | null> => {
  if (!DEEPSEEK_API_KEY) return null;

  const kit = TATTOO_STYLE_KITS[style] || TATTOO_STYLE_KITS.fine_line;
  const spec = CONTENT_TYPE_AI_SPECS[contentType];
  if (!spec) return null;

  const prompt = `You are an Instagram content strategist for a tattoo supply brand. Generate caption + hashtag strategy.

Tattoo Style: ${style}
Content Type: ${contentType}
Content context: ${spec.promptFocus}
Mood: ${kit.mood}

Return JSON:
{
  "captionTemplate": "A fill-in-the-blank caption template with {{placeholders}} for artist name, style, product",
  "captionVariations": ["3 alternative captions with different tones: professional, casual, story-driven"],
  "hashtagStrategy": {
    "broad": ["2-3 broad tattoo hashtags with millions of posts"],
    "niche": ["3-5 style-specific hashtags for ${style}"],
    "local": ["2-3 local tattoo hashtags (use {{city}} as placeholder)"]
  },
  "hook": "one-line hook for the first line of the caption",
  "cta": "natural call to action (save, share, comment question, DM)"
}

Caption rules by type:
- static_post: hook + visual detail description + subtle product mention + CTA
- slideshow_reel: "swipe to see" style, each slide teased
- ai_animation: "watch it come to life" angle
- video_remix: artist credit first, then product context
- voiceover_reel: "volume on" + key takeaway
- artist_feature: celebration + artist credit + subtle product connection
- NO hard selling, no "DM for price", no emoji spam (max 1-2)
- Sound like a real industry person sharing something they genuinely find cool`;

  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.8, max_tokens: 600,
      }),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text = (data?.choices?.[0]?.message?.content || '').replace(/```json\n?/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(text);
      return {
        captionTemplate: parsed.captionTemplate || '',
        captionVariations: parsed.captionVariations || [],
        hashtagStrategy: parsed.hashtagStrategy || { broad: [], niche: [], local: [] },
        hook: parsed.hook || '',
        cta: parsed.cta || 'soft',
      };
    } catch { return null; }
  } catch { return null; }
};

// ============ Post-Production Steps ============

const getPostProductionSteps = (contentType: string): string[] => {
  const steps: Record<string, string[]> = {
    static_post: [
      'Generate image with AI (Midjourney/Stable Diffusion)',
      'Upscale to 2x with AI upscaler (Topaz/Real-ESRGAN)',
      'Lightroom/PS: adjust contrast, sharpen tattoo detail, clean background',
      'Add subtle brand watermark bottom-right (15% opacity)',
      'Export 1080x1080 or 1080x1350 PNG, sRGB color space',
      'Write caption via DeepSeek → schedule via content-bot',
    ],
    slideshow_reel: [
      'Generate 3-6 cohesive AI images in same style/lighting',
      'Upscale all images consistently',
      'Submit to Shotstack with fade transitions (2.5-3s per slide)',
      'Add royalty-free background music matching tattoo style mood',
      'Poll Shotstack render, download MP4',
      'Export 1080x1080 MP4, H.264, 30fps',
    ],
    ai_animation: [
      'Generate base image with Midjourney (high detail, clean background)',
      'Submit to Runway Gen-4 / Kling with animation prompt',
      'Poll until render complete (30-90s typical)',
      'Download MP4, check for morphing artifacts',
      'FFmpeg: add 2s fade in/out, normalize speed',
      'Add subtle background music (low volume, no vocals)',
      'Optional: burn caption text overlay for sound-off viewers',
      'Export 1080x1920 MP4, H.264, 30fps',
    ],
    video_remix: [
      'Select source video clip (15-30s best segment)',
      'Extract audio → Whisper transcription → DeepSeek translate to English',
      'Generate SRT subtitle file from translation',
      'FFmpeg: burn English subtitles (white text, black outline, 24px)',
      'FFmpeg: reframe to 9:16 if needed (center crop)',
      'Add brand watermark bottom-right (20% opacity, 3s fade in)',
      'Add 2s brand intro card + 2s outro card',
      'Audio normalize to -14 LUFS',
      'Export 1080x1920 MP4, H.264, 30fps',
    ],
    voiceover_reel: [
      'Generate base image with Midjourney (matches script topic)',
      'Generate voiceover script via DeepSeek',
      'Generate TTS audio via ElevenLabs (Eleven Flash 2.5 for speed)',
      'Download TTS audio, check pronunciation',
      'FFmpeg: combine still image + TTS audio',
      'Add low-volume background music (ducked under voice)',
      'Optional: add waveform animation overlay',
      'Export 1080x1080 MP4, H.264, 30fps',
    ],
    artist_feature: [
      'Repurpose existing artist-submitted photo or video',
      'For video: FFmpeg add brand watermark bottom-right',
      'For photo: add subtle frame/border with brand color',
      'Generate caption via DeepSeek (artist credit focus)',
      'No AI filter over artist work — keep authentic',
      'Export original resolution, sRGB, optimized for IG',
    ],
  };
  return steps[contentType] || [];
};

const getMusicMood = (style: string): string => {
  const moods: Record<string, string> = {
    fine_line: 'soft piano, ambient, lo-fi — 60-80 BPM, minimal',
    blackwork: 'dark electronic, industrial ambient, deep bass — 80-100 BPM',
    color: 'upbeat pop, chill house, warm synth — 100-120 BPM',
    realism: 'cinematic orchestral, ambient drone, subtle strings — 60-80 BPM',
    traditional: 'rock, blues, vintage guitar — 100-130 BPM',
    geometric: 'minimal techno, ambient electronic, clean sine tones — 90-110 BPM',
  };
  return moods[style] || 'ambient electronic — 80-100 BPM';
};

const getCoverDesign = (contentType: string, style: string): string => {
  const kit = TATTOO_STYLE_KITS[style];
  const designs: Record<string, string> = {
    static_post: `Close-up detail shot showing ${kit?.coreSubject?.split(',')[0] || 'tattoo detail'}, shallow depth of field`,
    slideshow_reel: 'Clean text overlay with slide count (1/4), consistent brand font, first image as background',
    ai_animation: `Freeze-frame of the most dramatic moment, play button overlay, "${style}" text badge`,
    video_remix: 'Before/after split frame or artist @ handle overlay on first frame',
    voiceover_reel: 'Headline text overlay (the hook) + sound-on indicator, clean typography',
    artist_feature: 'Artist @ handle + "Featured Work" badge, minimal overlay',
  };
  return designs[contentType] || 'Clean, minimal overlay, tattoo detail as hero';
};

// ============ Guide Generation ============

const generateGuide = async (style: string, contentType: string): Promise<AIGenerationGuide> => {
  const spec = CONTENT_TYPE_AI_SPECS[contentType];
  const guide: AIGenerationGuide = {
    generatedAt: new Date().toISOString(),
    targetStyle: style,
    targetType: contentType,
    imagePrompt: null,
    animationPrompt: null,
    voiceover: null,
    caption: null,
    coverDesign: getCoverDesign(contentType, style),
    musicMood: getMusicMood(style),
    postProductionSteps: getPostProductionSteps(contentType),
    contentBotMapping: spec?.contentBotType || contentType,
  };

  if (!DEEPSEEK_API_KEY) {
    guide.caption = {
      captionTemplate: '',
      captionVariations: [],
      hashtagStrategy: { broad: [], niche: [], local: [] },
      hook: '',
      cta: 'soft',
    };
    return guide;
  }

  // Generate all applicable guides in parallel
  const [imagePrompt, animationPrompt, voiceover, caption] = await Promise.all([
    // Image prompt for types that need AI images
    ['static_post', 'slideshow_reel', 'voiceover_reel', 'artist_feature'].includes(contentType)
      ? buildImagePrompt(style, contentType) : Promise.resolve(null),
    // Animation prompt only for ai_animation
    contentType === 'ai_animation'
      ? buildAnimationPrompt(style, contentType) : Promise.resolve(null),
    // Voiceover only for voiceover_reel
    contentType === 'voiceover_reel'
      ? buildVoiceover(style, contentType) : Promise.resolve(null),
    // Caption for all types
    buildCaption(style, contentType),
  ]);

  guide.imagePrompt = imagePrompt;
  guide.animationPrompt = animationPrompt;
  guide.voiceover = voiceover;
  guide.caption = caption;

  return guide;
};

// ============ Save & Print ============

const saveGuide = (guide: AIGenerationGuide) => {
  ensureDir(OUTPUT_DIR);
  const file = path.join(OUTPUT_DIR, `${guide.targetStyle}_${guide.targetType}.json`);
  fs.writeFileSync(file, JSON.stringify(guide, null, 2), 'utf8');
  return file;
};

const printGuide = (guide: AIGenerationGuide) => {
  console.log(`\n===== ${guide.targetStyle} / ${guide.targetType} =====`);
  console.log(`  → content-bot type: ${guide.contentBotMapping}`);

  if (guide.imagePrompt) {
    console.log(`\n🖼️  AI IMAGE PROMPT (${guide.imagePrompt.platform})`);
    console.log(`  Positive: ${guide.imagePrompt.positivePrompt.slice(0, 200)}...`);
    console.log(`  Negative: ${guide.imagePrompt.negativePrompt}`);
    console.log(`  Aspect: ${guide.imagePrompt.aspectRatio} | Style ref: ${guide.imagePrompt.styleReference}`);
    if (guide.imagePrompt.parameters) console.log(`  Params: ${guide.imagePrompt.parameters}`);
  }

  if (guide.animationPrompt) {
    console.log(`\n🎬 AI ANIMATION PROMPT (${guide.animationPrompt.platform})`);
    console.log(`  Start frame: ${guide.animationPrompt.startFrameDescription.slice(0, 150)}...`);
    console.log(`  Motion: ${guide.animationPrompt.motionDescription.slice(0, 150)}...`);
    console.log(`  Camera: ${guide.animationPrompt.cameraMovement} | Duration: ${guide.animationPrompt.duration}s`);
    if (guide.animationPrompt.parameters) console.log(`  Params: ${guide.animationPrompt.parameters}`);
  }

  if (guide.voiceover) {
    console.log(`\n🎙️  VOICEOVER SCRIPT`);
    console.log(`  Script: "${guide.voiceover.script.slice(0, 200)}..."`);
    console.log(`  Voice: ${guide.voiceover.voiceId} | Music: ${guide.voiceover.musicMood}`);
    console.log(`  Settings: stability=${guide.voiceover.voiceSettings.stability}, similarity=${guide.voiceover.voiceSettings.similarity_boost}`);
  }

  if (guide.caption) {
    console.log(`\n📝 CAPTION KIT`);
    if (guide.caption.hook) console.log(`  Hook: ${guide.caption.hook}`);
    if (guide.caption.captionTemplate) console.log(`  Template: ${guide.caption.captionTemplate.slice(0, 150)}`);
    if (guide.caption.captionVariations.length > 0) {
      console.log(`  Variations (${guide.caption.captionVariations.length}):`);
      for (const v of guide.caption.captionVariations.slice(0, 2)) console.log(`    - ${v.slice(0, 120)}`);
    }
    if (guide.caption.hashtagStrategy) {
      const hs = guide.caption.hashtagStrategy;
      console.log(`  Hashtags — Broad: ${hs.broad.map(h => '#' + h).join(' ')}`);
      console.log(`          — Niche: ${hs.niche.map(h => '#' + h).join(' ')}`);
      console.log(`          — Local: ${hs.local.map(h => '#' + h).join(' ')}`);
    }
    console.log(`  CTA: ${guide.caption.cta}`);
  }

  console.log(`\n✂️  POST-PRODUCTION (${guide.postProductionSteps.length} steps):`);
  for (let i = 0; i < guide.postProductionSteps.length; i++) {
    console.log(`  ${i + 1}. ${guide.postProductionSteps[i]}`);
  }

  console.log(`\n🎵 Music: ${guide.musicMood}`);
  console.log(`🖊️  Cover: ${guide.coverDesign}`);
};

// ============ Main ============
const main = async () => {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  AI Content Creation Guide          ║');
  console.log('║  (AI Generation Mode — No Camera)   ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Styles: ${TARGET_STYLES.join(', ')}`);
  console.log(`  Types: ${TARGET_TYPES.join(', ')}`);
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log(`  API Keys: DeepSeek=${DEEPSEEK_API_KEY ? '✓' : '✗'} Replicate=${REPLICATE_API_KEY ? '✓' : '✗'} ElevenLabs=${ELEVENLABS_API_KEY ? '✓' : '✗'} Shotstack=${SHOTSTACK_API_KEY ? '✓' : '✗'} OpenAI=${OPENAI_API_KEY ? '✓' : '✗'}`);

  let totalGuides = 0;

  for (const style of TARGET_STYLES) {
    for (const type of TARGET_TYPES) {
      console.log(`\nGenerating AI guide for ${style} / ${type}...`);
      const guide = await generateGuide(style, type);
      const file = saveGuide(guide);
      printGuide(guide);
      console.log(`  → Saved: ${file}`);
      totalGuides++;
      await sleep(1500); // rate limit
    }
  }

  console.log(`\n${totalGuides} AI guides generated → ${OUTPUT_DIR}`);
  console.log(`\n💡 Usage:`);
  console.log(`   — Feed image prompts to Midjourney/Stable Diffusion`);
  console.log(`   — Feed animation prompts to Runway/Kling via content-bot Type 3`);
  console.log(`   — Feed voiceover scripts to content-bot Type 5`);
  console.log(`   — Feed caption kits to all content-bot types`);
};

main().catch((e) => {
  console.error('[content-guide] Fatal:', e?.message || e);
  process.exit(1);
});
