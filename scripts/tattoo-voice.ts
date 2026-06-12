/**
 * 纹身行业语料库 — 专业纹身师评论风格参考
 * 作为 DeepSeek 生成评论的知识基础，让评论听起来像真同行而不是路人
 */

// ========== 风格专用点评词汇 ==========
export const STYLE_CRITIQUE: Record<string, string[]> = {
  'fine line': [
    'clean needle weight on those micro lines',
    'single pass look',
    'no blowouts at all on those thin sections',
    'consistency of line weight across the whole piece',
    'great tension control for fine line',
  ],
  'realism': [
    'contrast range on this is proper',
    'smooth value transitions',
    'the soft edge vs hard edge balance is dialed in',
    'midtones are packed nicely, not muddy',
    'the light source reads really clearly',
  ],
  'blackwork': [
    'solid saturation, no holidays',
    'black is packed evenly',
    'nice negative space use',
    'the dotwork shading gradient is smooth',
    'bold will hold',
  ],
  'traditional': [
    'clean bold lines, classic weight',
    'color saturation is spot on for traditional',
    'perfect skin breaks in the right spots',
    'that spit shading is crispy',
    'nice whip on those trad fades',
  ],
  'neo traditional': [
    'illustrative line quality is perfect for this',
    'color palette choice is really thoughtful',
    'the decorative elements read well against the main subject',
    'line weight variation adds nice depth',
  ],
  'japanese': [
    'background is composed perfectly, not distracting from the main motif',
    'nice mikiri edges',
    'the flow with the body contour is proper',
    'scale and placement work beautifully together',
  ],
  'geometric': [
    'symmetry is locked in',
    'dot precision is on point',
    'the mandala layering reads clearly',
    'clean intersection points throughout',
  ],
  'watercolor': [
    'color bleeds are controlled well',
    'nice saturation without overworking',
    'the soft transitions read naturally',
  ],
  'ornamental': [
    'flow follows the body nicely',
    'consistent spacing between elements',
    'nice rhythm in the pattern work',
  ],
  'microrealism': [
    'insane detail at this scale',
    'needle control at micro level is impressive',
    'reads clearly even at small size',
  ],
};

// ========== 技法术语词汇表 ==========
export const TECHNIQUE_TERMS = {
  shading: [
    'whip shading', 'stipple shading', 'pepper shading', 'smooth blend',
    'soft edge', 'hard edge', 'gradient', 'value range', 'tonal transition',
    'packing', 'saturation', 'layering', 'crosshatch', 'dotwork',
  ],
  linework: [
    'line weight', 'line consistency', 'clean pull', 'single pass',
    'bold line', 'crispy lines', 'needle depth', 'line tension',
    'varying weight', 'tapered end', 'steady hand',
  ],
  color: [
    'color saturation', 'color palette', 'color theory', 'complementary',
    'analogous', 'vibrant', 'muted', 'skin tone contrast', 'healed color',
    'color packing', 'color blend', 'wash', 'opacity',
  ],
  composition: [
    'placement', 'flow', 'negative space', 'skin breaks', 'composition',
    'balance', 'scale', 'body contour', 'focal point', 'framing',
    'background', 'foreground', 'depth', 'dimension',
  ],
  execution: [
    'needle control', 'hand speed', 'machine speed', 'voltage',
    'stretch', 'pull', 'whip', 'pendulum', 'circular',
    'pass', 'overwork', 'trauma', 'healing', 'settled',
  ],
};

// ========== 真实评论句式模板 ==========
export const COMMENT_PATTERNS = [
  // 具体技法赞美
  'The {technique} on that {element} is {quality}.',
  '{quality} {technique} throughout. {followup}',
  'Love how you handled the {element} — {observation}.',
  'That {style} {technique} is dialed in. {followup}',
  // 好奇提问（显示专业度）
  'What {tool} are you using for those {technique}?',
  '{quality} result. How long did this sit take?',
  'That {element} reads so well. {question}',
  // 简短有力
  '{quality}.',
  'That {technique} though.',
  'Proper {style} execution.',
  // 比较和共鸣
  'Way harder than it looks. {technique} is not easy.',
  'Respect the patience on this one. {followup}',
  'This is the kind of {style} I love seeing.',
];

// ========== 行业语境词汇 ==========
export const DOMAIN_PHRASES = {
  qualities: [
    'crispy', 'clean', 'solid', 'proper', 'tight', 'smooth',
    'buttery', 'dialed in', 'locked in', 'on point', 'polished',
    'packed well', 'reads clearly', 'holds well', 'settled nice',
  ],
  elements: [
    'shading', 'linework', 'color packing', 'whip', 'blend',
    'saturation', 'contrast', 'edge', 'gradient', 'composition',
    'placement', 'flow', 'negative space', 'skin breaks', 'detail',
    'texture', 'highlights', 'midtones', 'darks', 'value range',
    'needle work', 'hand control', 'pulling lines', 'color choice',
  ],
  tools: [
    'liner', 'shader', 'mag', 'round liner', 'curved mag',
    'cartridge', 'needle grouping', 'machine', 'rotary', 'coil',
    '3RL', '5RS', '7M1', 'tight liner', 'bugpin',
  ],
  styles: [
    'fine line', 'fineline', 'micro-realism', 'realism', 'black and grey',
    'blackwork', 'traditional', 'neo-traditional', 'japanese', 'irezumi',
    'geometric', 'dotwork', 'watercolor', 'illustrative', 'ornamental',
    'american traditional', 'new school', 'tribal', 'trash polka',
  ],
  contexts: [
    'healed', 'fresh', 'settled', 'touch-up', 'cover-up',
    'custom piece', 'walk-in', 'flash', 'sleeve', 'back piece',
    'one-shot', 'session', 'sit', 'consultation',
  ],
};

// ========== 帖子类型识别 ==========
export const detectPostType = (caption: string, alts: string[]): string => {
  const text = `${caption} ${alts.join(' ')}`.toLowerCase();
  if (/\b(healed|months old|years? old|aged|settled)\b/.test(text)) return 'healed';
  if (/\b(wip|in progress|session|outline|lining|shading today)\b/.test(text)) return 'wip';
  if (/\b(flash|available|pre-drawn|get what you see)\b/.test(text)) return 'flash';
  if (/\b(before|after|cover|covered up|transformation)\b/.test(text)) return 'before_after';
  if (/\b(available|booking|dm|book now|open|taking appointments)\b/.test(text)) return 'booking';
  return 'fresh';
};

// ========== 根据帖子类型生成合适的评论角度 ==========
export const getCommentAngle = (postType: string): string => {
  const angles: Record<string, string[]> = {
    fresh: ['fresh application quality', 'technique execution', 'design and composition'],
    healed: ['how well it held up', 'color retention', 'line integrity over time'],
    wip: ['progress so far', 'anticipation for the finish', 'current stage quality'],
    flash: ['design appeal', 'style consistency', 'flash sheet composition'],
    before_after: ['transformation impact', 'technique in the cover', 'result vs original'],
    booking: ['work quality attracting clients', 'portfolio strength', 'client experience'],
  };
  const options = angles[postType] || angles.fresh;
  return options[Math.floor(Math.random() * options.length)];
};

// ========== 构建专业纹身师 context ==========
export const buildTattooArtistContext = (postType: string, style?: string): string => {
  const styleTerms = style ? STYLE_CRITIQUE[style.toLowerCase()] || [] : [];
  const angle = getCommentAngle(postType);

  return `You are a professional tattoo artist with 8+ years of experience. You know needles, machines, techniques, and styles inside out.

Your voice:
- You notice technical details non-artists miss
- You use industry shorthand naturally ("clean pull", "smooth whip", "packed well")
- You're respectful — you know how hard the craft is
- You occasionally ask technical questions like a real peer
- You never sound like a fan or a customer
- You never mention supplies, products, or anything commercial

Comment angle: ${angle}
${styleTerms.length > 0 ? `\nStyle-specific things to consider mentioning:\n${styleTerms.slice(0, 3).map((s) => '- ' + s).join('\n')}\n` : ''}
Key terminology to draw from naturally: ${DOMAIN_PHRASES.qualities.slice(0, 8).join(', ')}

IMPORTANT: Pick ONE specific thing to comment on. Be concise (6-20 words). Sound like you're scrolling Instagram and leaving a quick genuine comment — not writing a critique.`;
};

// ========== 西班牙语支持（备选） ==========
export const SPANISH_PATTERNS: Record<string, string[]> = {
  praise: [
    'Líneas muy limpias.',
    'Buen manejo de las sombras.',
    'La saturación está perfecta.',
    'Detalles muy bien cuidados.',
    'Composición muy sólida.',
  ],
  questions: [
    'Qué aguja usaste para las líneas finas?',
    'Cuánto tiempo tomó esta pieza?',
    'Es sanado o fresco?',
  ],
  short: [
    'Buen trabajo.',
    'Impecable.',
    'Muy limpio.',
    '🔥🔥🔥',
  ],
};

export const getSpanishFallback = (): string => {
  const all = [...SPANISH_PATTERNS.praise, ...SPANISH_PATTERNS.short];
  return all[Math.floor(Math.random() * all.length)];
};
