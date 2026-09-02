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

// ========== 主题识别：纹身 / 穿孔（评论·点赞·关注闸门：穿孔整个不碰） ==========
export type SubjectKind = 'tattoo' | 'piercing' | 'unknown';
export interface SubjectResult {
  subject: SubjectKind;
  source: 'handle' | 'caption' | 'alt' | 'vision' | 'default';
  signals: string[];
  visionUsed: boolean;
}

// 仅用穿孔专属 token，避免误杀 "pierc_and_ink" 这类纹身工作室
const HANDLE_PIERCING_TOKENS = ['piercing', 'piercer', 'bodypierc', 'dermal', 'microdermal'];
export const isPiercingHandle = (handle: string): boolean => {
  const h = (handle || '').toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
  return HANDLE_PIERCING_TOKENS.some((k) => h.includes(k));
};

const STRONG_PIERCING = [
  'piercing', 'piercer', 'pierced', 'nose ring', 'belly ring', 'navel', 'industrial',
  'helix', 'labret', 'septum', 'daith', 'tragus', 'rook', 'conch', 'dermal', 'microdermal',
  'ear piercing', 'surface bar', 'nostril', 'forward helix', 'snug', 'orbital',
  'body jewelry', 'body jewellery', 'implant grade', 'barbell', 'stud', 'hoop',
  'cartilage', 'gauge', 'gauges', 'stretching', 'stretched', 'plug', 'plugs',
];
const TATTOO_SIGNALS = [
  'tattoo', 'tattooed', 'tattooer', 'tattooist', 'ink', 'flash sheet', 'sleeve',
  'blackwork', 'whip shading', 'linework', 'fineline', 'fine line',
];

export const detectSubject = (caption: string, alts: string[] = [], ownerHandle = ''): SubjectResult => {
  const text = `${caption} ${alts.join(' ')}`.toLowerCase();
  // 1) handle 优先：@bodypiercingbykayla / @dermal.decor.piercing 等信号在 handle 里
  if (isPiercingHandle(ownerHandle)) {
    return { subject: 'piercing', source: 'handle', signals: [`handle:${ownerHandle}`], visionUsed: false };
  }
  // 2) 文字强信号：穿孔解剖词直接判穿孔
  const pHit = STRONG_PIERCING.filter((k) => text.includes(k));
  if (pHit.length) {
    return { subject: 'piercing', source: 'caption', signals: pHit.slice(0, 3), visionUsed: false };
  }
  // 3) 文字纹身信号：命中纹身词 → 判纹身（本 bot 主场景）
  const tHit = TATTOO_SIGNALS.filter((k) => text.includes(k));
  if (tHit.length) {
    return { subject: 'tattoo', source: 'caption', signals: tHit.slice(0, 3), visionUsed: false };
  }
  // 4) 两边都没信号 → 交给识图（调用方借 visionDescription 二次判定）
  return { subject: 'unknown', source: 'default', signals: [], visionUsed: false };
};

// ========== 帖子「意图/主题理解」：先读懂作者想说什么，再据此写评论 ==========
// 解决旧逻辑的核心问题：评论只看风格、不看“这条帖到底在讲什么”，导致宠物纪念帖被回 “slaps”。
// 这里把作者意图归类为 canonical intent，并产出一句话 summary（作者想表达什么）+ 适配的语气 tone。
export type PostIntent = {
  intent: string; // canonical key
  summary: string; // 一句话：作者在这条帖子里想表达/传达什么
  tone: 'respectful' | 'casual' | 'enthusiastic' | 'technical' | 'celebratory';
  sensitive: boolean; // true=涉及逝者/病痛/创伤，评论必须尊重、禁止玩梗/俚语
  keywords: string[];
};

const PET_SIGNALS = ['dog', 'cat', 'puppy', 'kitten', 'pet portrait', 'paw print', 'furbaby', 'fur baby'];

export const detectPostIntent = (caption: string, alts: string[] = []): PostIntent => {
  const text = `${caption} ${alts.join(' ')}`.toLowerCase();

  // 0) 社交/生活类（非纹身内容帖）：生日/庆祝/聚会/家人朋友/旅行等。
  //    这类帖纹身往往只是顺带入镜（如几个人合影身上有纹身、配文"生日快乐"），
  //    上去评"纹身很细节" = 明显的机器人破绽。仅在「无纹身工作内容词」时判为社交，
  //    避免误杀"客户生日定制 fine line piece"这类真纹身内容帖。
  const SOCIAL_RE = /\b(birthday|bday|hbd|happy birthday|生日|happy bday|birth day|anniversary|wedding|got married|just married|engaged|engagement|graduation|grad|holiday|christmas|xmas|new year|vacation|on vacation|trip|travel|getaway|staycation|party|celebrat|congrats|congratulation|with my (friends|family|cousins|girls|boys|crew)|me and my (friends|family|girls|boys)|my (friends|family|people|crew) and i|girls? night|boys? night|weekend vibes|weekend with|hang(ing)? out|brunch|foodie|dinner with|lunch with)\b/i;
  const TATTOO_WORK_RE = /\b(tattoo|tattooed|ink|flash|piece|sleeve|portrait|fineline|fine line|blackwork|traditional|japanese|realism|wip|healed|cover|session|linework|stencil|custom|commission|appointment|booking|needle|cartridge)\b/i;
  if (SOCIAL_RE.test(text) && !TATTOO_WORK_RE.test(text)) {
    return {
      intent: 'social_personal',
      summary:
        'The author is sharing a personal/social-life moment (birthday, gathering, celebration, trip) — NOT a tattoo showcase. Any visible tattoos are incidental. Do NOT engage as a tattoo post; commenting on tattoo detail here reads as a bot.',
      tone: 'casual',
      sensitive: false,
      keywords: ['social', 'personal-life'],
    };
  }

  // 1) 宠物纪念（最敏感）：🐾 + 🕯️ / memorial / rip + 宠物信号
  const petMemorialRe = /(pet memorial|memorial (piece|tattoo|pet)|in memory of (my )?(dog|cat|pet|furbaby|fur baby|animal)|rest in (peace|power)|🕯|rip\b|angel (baby|pet|paw)|late (dog|cat|pet)|lost (my )?(dog|cat|pet)|fur ?angel|paw ?print.*memor|memor.*paw ?print)/;
  if (petMemorialRe.test(text) || (/\bmemorial\b/.test(text) && PET_SIGNALS.some((s) => text.includes(s)))) {
    return {
      intent: 'pet_memorial',
      summary:
        'The artist is sharing a pet memorial tattoo — a heartfelt tribute to a client’s late pet (paw print / candle). The mood is commemorative and emotional, not a flashy showpiece.',
      tone: 'respectful',
      sensitive: true,
      keywords: ['pet memorial', 'paw print', 'candle', 'tribute'],
    };
  }

  // 2) 人物纪念（逝者）
  const humanMemorialRe = /\b(in loving memory|in memory of|rest in (peace|power)|gone too soon|memorial (of|for|piece|tattoo)|rip\b|🕯|passed (away|on)|tribute to (my )?(dad|mom|mother|father|grandma|grandpa|friend|son|daughter))\b/;
  if (humanMemorialRe.test(text)) {
    return {
      intent: 'human_memorial',
      summary:
        'The artist is sharing a memorial tattoo honoring someone who passed — a personal tribute. The mood is solemn and respectful.',
      tone: 'respectful',
      sensitive: true,
      keywords: ['memorial', 'in memory of', 'tribute'],
    };
  }

  // 2.5) 客户「第一次纹身」（细分：区别于普通 portrait/flash，评论角度=里程碑）
  const hypotheticalFirstTattoo = /\b(whether|if|thinking about|ready for|considering).{0,45}\bfirst (tattoo|piece|ink)\b|\b(first tattoo|first piece).{0,30}\b(or|and) (the )?(next|another)\b/i.test(text);
  if (!hypotheticalFirstTattoo && /\b(first tattoo|first piece|first ink|first tat|my first (tattoo|piece|ink)|first (ever )?tattoo|first session|virgin skin|getting my first|my very first (tattoo|piece)|first time (getting|being) (tattooed|inked)|first art)\b/i.test(text)) {
    return {
      intent: 'first_tattoo',
      summary: 'The artist is showing a CLIENT’S FIRST tattoo — a milestone piece. The mood is special, slightly nervous/excited; the comment should acknowledge the first-tattoo moment, not hype it like a flash sheet.',
      tone: 'casual',
      sensitive: false,
      keywords: ['first tattoo', 'milestone'],
    };
  }

  // 3) 人物致敬（非逝者：送家人）
  if (
    /\b(mom|mother|dad|father|grandma|grandpa|grandmother|grandfather|sister|brother|wife|husband|son|daughter|family)\b/.test(text) &&
    /\b(tattoo|piece|portrait|done|got|inked)\b/.test(text)
  ) {
    return {
      intent: 'personal_tribute',
      summary: 'The artist is sharing a personal tribute piece for a loved one (family). Warm, heartfelt tone.',
      tone: 'respectful',
      sensitive: false,
      keywords: ['family tribute'],
    };
  }

  // 4) 宠物肖像（活体宠物，非纪念）
  if (PET_SIGNALS.some((s) => text.includes(s)) && !/\bmemorial\b/.test(text)) {
    return {
      intent: 'pet_portrait',
      summary: 'The artist is showing a pet/animal portrait tattoo — a celebration of a beloved animal.',
      tone: 'enthusiastic',
      sensitive: false,
      keywords: ['pet portrait'],
    };
  }

  // 5) 肖像 / 写实脸
  if (/\b(portrait|likeness|face tattoo|realistic face|hyper ?realism face)\b/.test(text)) {
    return {
      intent: 'portrait',
      summary: 'The artist is sharing a portrait / realism piece.',
      tone: 'casual',
      sensitive: false,
      keywords: ['portrait'],
    };
  }

  // 6) Flash — 细分「可订 flash」vs「个人收藏 flash」
  if (/\b(flash|available|pre-drawn|get what you see|open spots|flash sheet|flash design|flash set)\b/i.test(text)) {
    // 个人收藏 flash（非接单）：有 my/own/personal/collection/book 等词且无强接单词 → 走 artist_flash_collection
    const PERSONAL_FLASH_RE = /\b(my flash (collection|book|set)|personal flash|flash i (drew|did|designed|made)|my own flash|flash collection|flash book|my flash|my personal flash)\b/i;
    const BOOKING_FLASH_RE = /\b(available|book|booking|dm|spots open|get what you see|open for booking|appointments?)\b/i;
    if (PERSONAL_FLASH_RE.test(text) && !BOOKING_FLASH_RE.test(text)) {
      return {
        intent: 'artist_flash_collection',
        summary: 'The artist is showing their PERSONAL flash collection / flash book — not a booking post. The comment should react to a specific design or note it’s a dope collection; never ask "is it available?".',
        tone: 'casual',
        sensitive: false,
        keywords: ['flash collection', 'personal'],
      };
    }
    return {
      intent: 'flash_available',
      summary: 'The artist is posting available/bookable flash — designs ready to be booked.',
      tone: 'enthusiastic',
      sensitive: false,
      keywords: ['flash', 'bookable'],
    };
  }

  // 7) 愈合
  if (/\b(healed|months? old|years? old|settled|aftercare|how it aged)\b/.test(text)) {
    return {
      intent: 'healed',
      summary: 'The artist is showing a healed result — how the piece aged.',
      tone: 'casual',
      sensitive: false,
      keywords: ['healed'],
    };
  }

  // 8) 进行中
  if (/\b(wip|in progress|session|outline|lining|shading today|work in progress|first pass)\b/.test(text)) {
    return {
      intent: 'wip',
      summary: 'The artist is sharing a work-in-progress / current session.',
      tone: 'technical',
      sensitive: false,
      keywords: ['wip'],
    };
  }

  // 8.5) 自由手稿（无转印，直接手绘上肤）
  if (/\b(freehand|no stencil|drawn (on|directly)|by hand (with)?out stencil|free hand|hand-drawn on skin)\b/i.test(text)) {
    return {
      intent: 'freehand',
      summary: 'The artist drew this freehand — no stencil, directly on skin. The comment should acknowledge the confidence/spontaneity of drawing direct.',
      tone: 'technical',
      sensitive: false,
      keywords: ['freehand'],
    };
  }

  // 8.6) 定制 / 客制稿（区别于 flash 预制稿）
  if (/\b(custom (piece|work|commission|design|tattoo|flash)|commission(ed)?|bespoke|client'?s (idea|concept|design)|made (this|it) (for|from) (a |the )?client|custom for|their idea)\b/i.test(text)) {
    return {
      intent: 'custom_piece',
      summary: 'The artist is showing a CUSTOM / commissioned piece translated from a client’s idea. The comment should acknowledge the custom concept or how the artist interpreted it.',
      tone: 'casual',
      sensitive: false,
      keywords: ['custom', 'commission'],
    };
  }

  // 8.7) 大件 / 长期项目（sleeve / back piece / 多 session）
  if (/\b(sleeve|half sleeve|leg sleeve|back piece|full (arm|leg|body)|full sleeve|ongoing project|multi-session|multi session|part (one|1|two|2|three|3)|session (one|1|two|2))\b/i.test(text)) {
    return {
      intent: 'sleeve_project',
      summary: 'The artist is showing a sleeve / large ongoing project. The comment should acknowledge the SCOPE / overall composition across the whole piece, not just one element.',
      tone: 'casual',
      sensitive: false,
      keywords: ['sleeve', 'project'],
    };
  }

  // 9) 改 / 遮盖 — 细分「遮盖旧名字/旧字」vs 普通遮盖
  if (/\b(cover|coverup|covered up|before|after|transformation)\b/i.test(text)) {
    // 遮盖旧名字/旧词（高精准评论角度）
    if (/\b(old name|ex('?s)? name|covering (a |her |his |the )?name|name cover ?up|cover(ing)? up (an? |the )?(old |ex'?s )?(name|word|script)|ex('?s)? (name|script)|cover(ing)? (her|his) (name|script)|old script|old word)\b/i.test(text)) {
      return {
        intent: 'coverup_name',
        summary: 'The artist is covering up an OLD NAME / OLD WORD (ex’s name, old script). The comment should acknowledge how the new design absorbs the old ink — specific to cover-up craft.',
        tone: 'technical',
        sensitive: false,
        keywords: ['coverup', 'old name'],
      };
    }
    return {
      intent: 'coverup',
      summary: 'The artist is showing a cover-up / before-after transformation.',
      tone: 'technical',
      sensitive: false,
      keywords: ['coverup'],
    };
  }

  // 10) 预约 / 推广
  if (/\b(booking|book now|dm to book|taking appointments|available appointment|deposit|spots open)\b/.test(text)) {
    return {
      intent: 'booking',
      summary: 'The artist is announcing booking availability / appointments.',
      tone: 'casual',
      sensitive: false,
      keywords: ['booking'],
    };
  }

  // 11) 展会 / 客座
  if (/\b(convention|guest spot|guest artist|tattoo expo|trade show)\b/.test(text)) {
    return {
      intent: 'convention',
      summary: 'The artist is posting about a convention / guest spot / event.',
      tone: 'casual',
      sensitive: false,
      keywords: ['convention'],
    };
  }

  // 11.5) 获奖 / 刊登 / 精选（高光时刻）
  if (/\b(featured|published|on the cover|cover of|winner|award|selected|honored|magazine|inked mag|best of|recognition)\b/i.test(text)) {
    return {
      intent: 'feature_award',
      summary: 'The artist is celebrating featured / awarded / published work. The comment should be a genuine congrats on the recognition, specific to the piece.',
      tone: 'celebratory',
      sensitive: false,
      keywords: ['feature', 'award'],
    };
  }

  // 11.6) 合作（与另一位 artist 联名）
  if (/\b(collab|collaborat|guest spot with|collab with|duet with|together with @|join(ed)? (me|us) (for|on))\b/i.test(text)) {
    return {
      intent: 'collab',
      summary: 'The artist is posting a COLLAB with another artist. The comment should acknowledge the combined work / the other artist if named.',
      tone: 'casual',
      sensitive: false,
      keywords: ['collab'],
    };
  }

  // 11.7) 教学 / 教程 / 知识分享
  if (/\b(tutorial|how to|tips?|learn|breakdown|process (video|breakdown)|speed draw|time ?lapse|watch me|step by step|teaching|educational)\b/i.test(text)) {
    return {
      intent: 'educational',
      summary: 'The artist is sharing educational / tutorial content. The comment should acknowledge the knowledge share genuinely, peer-to-peer respect.',
      tone: 'casual',
      sensitive: false,
      keywords: ['educational'],
    };
  }

  // 12) BTS / 设备 / 工作室
  if (/\b(new (machine|setup|desk|station)|studio|workstation|my (setup|desk)|unboxing|haul|my station)\b/.test(text)) {
    return {
      intent: 'bts',
      summary: 'The artist is sharing behind-the-scenes / gear / studio.',
      tone: 'casual',
      sensitive: false,
      keywords: ['bts'],
    };
  }

  // 13) 字母 / 语录
  if (/\b(script|lettering|quote|handwriting|hand-lettered|calligraphy)\b/.test(text)) {
    return {
      intent: 'script_quote',
      summary: 'The artist is sharing a script / lettering / quote tattoo.',
      tone: 'casual',
      sensitive: false,
      keywords: ['script'],
    };
  }

  // 14) 粉丝向 / 角色（流行文化）
  if (/\b(cosplay|anime|marvel|dc\b|disney|pokemon|star wars|game of thrones|harry potter|character)\b/.test(text)) {
    return {
      intent: 'fan_art',
      summary: 'The artist is showing a pop-culture / character tattoo.',
      tone: 'enthusiastic',
      sensitive: false,
      keywords: ['character'],
    };
  }

  // 15) 植物 / 自然（非宠物动物）
  if (/\b(flower|botanical|plant|rose|skull|nature|mountain|ocean|wave|leaf|animal)\b/.test(text)) {
    return {
      intent: 'botanical_nature',
      summary: 'The artist is sharing a nature / botanical / illustrative piece.',
      tone: 'casual',
      sensitive: false,
      keywords: ['nature'],
    };
  }

  return {
    intent: 'generic',
    summary: 'The post\'s subject is not strongly signalled by the caption — rely on image/style cues to decide what it is actually about before commenting.',
    tone: 'casual',
    sensitive: false,
    keywords: [],
  };
};

/**
 * 帖子「是否值得作为纹身内容去互动」闸门（2026-08-14 用户硬要求：只评纹身帖，其余跳过）。
 * 这一步 100% 由「文字意图」决定，不靠 QWEN 看图救未知帖。
 * - 'social'  : 社交/生活类（生日/聚会/家人朋友/旅行）→ 纹身只是顺带入镜，不评、跳过。
 * - 'tattoo'  : 明确的纹身内容帖（flash/healed/wip/portrait/memorial 等）→ 正常互动（QWEN 仅用于读懂图、写具体评论）。
 * - 'unknown' : generic（文字无纹身意图信号）→ 直接跳过，绝不调 QWEN 去"识别这是什么帖"。
 */
export const TATTOO_CONTENT_INTENTS = new Set<string>([
  'pet_memorial', 'human_memorial', 'personal_tribute', 'pet_portrait', 'portrait',
  'flash_available', 'artist_flash_collection', 'custom_piece', 'healed', 'wip',
  'freehand', 'sleeve_project', 'coverup', 'coverup_name', 'booking', 'convention',
  'feature_award', 'collab', 'educational', 'bts', 'script_quote', 'fan_art', 'botanical_nature',
  'first_tattoo',
]);
export const intentEngagement = (intent: string): 'tattoo' | 'social' | 'unknown' => {
  if (intent === 'social_personal') return 'social';
  if (TATTOO_CONTENT_INTENTS.has(intent)) return 'tattoo';
  return 'unknown'; // generic 及其它
};

/**
 * 视觉闭环（修正版 · 2026-08-14 用户硬要求）：
 * QWEN 只负责「读懂这张纹身图的内容」喂给评论生成器（识图→具体观察），
 * **绝不负责任意决定「评不评这条帖」**——那一步 100% 由文字意图(intentEngagement) 决定。
 * 所以本函数只做一件事：当文字已明确判为纹身意图时，若视觉观测到 memorial/悼念信号，
 * 把 sensitive 升为 true（让评论走尊重语气，不对肃穆图写玩梗）。
 * 它永远不改 intent、永不把「未知帖」救成活意图——未知/社交帖在调用本函数之前就已跳过。
 */
export const reconcileIntentWithVision = (
  captionIntent: PostIntent,
  visionDescription: string
): PostIntent => {
  if (!visionDescription || !visionDescription.trim()) return captionIntent;
  // 视觉观测到强烈悼念信号 → 升 sensitive（仅影响语气，不影响是否评论）
  const VISION_SENSITIVE_RE = /(memorial|in memory of|rest in (peace|power)|rip\b|🕯|candle|grave|funeral|somber|tribute to|passed (away|on)|grieving|loss)/i;
  if (VISION_SENSITIVE_RE.test(visionDescription) && !captionIntent.sensitive) {
    return { ...captionIntent, sensitive: true, tone: 'respectful' };
  }
  return captionIntent;
};

/** 根据意图给出「评论角度」指引，注入评论生成 prompt —— 精准度核心：细分意图 → 具体写什么 */
export const getIntentGuidance = (intent: PostIntent): string => {
  // 细分意图 → 精准评论角度（让 LLM 知道这条帖该写哪个具体点，而非泛泛赞美）
  const ANGLE: Record<string, string> = {
    first_tattoo: `COMMENT ANGLE: This is the client's FIRST tattoo — a milestone. Acknowledge it genuinely (e.g. "clean lines to start the journey", "first piece and the lines are already dialed"). Warm, not hype.`,
    coverup_name: `COMMENT ANGLE: Cover-up of an OLD NAME / OLD WORD. Acknowledge how the new design swallows the old ink (e.g. "the way the new piece absorbs the old script is clean"). Specific to cover-up craft.`,
    artist_flash_collection: `COMMENT ANGLE: The artist's PERSONAL flash collection (NOT a booking post). React to a specific design you like, or note it's a dope personal collection. Do NOT ask "is it available?".`,
    flash_available: `COMMENT ANGLE: Bookable flash. React to a specific design on the sheet, or the sheet's vibe. You MAY hint interest but do NOT demand availability like a customer.`,
    custom_piece: `COMMENT ANGLE: A custom / commissioned piece. Acknowledge the custom concept or how the artist translated the client's idea into ink.`,
    freehand: `COMMENT ANGLE: Freehand, no stencil — drawn direct on skin. Acknowledge the confidence / spontaneity of drawing live.`,
    sleeve_project: `COMMENT ANGLE: A sleeve / large ongoing project. Acknowledge the SCOPE / overall composition across the whole piece, not just one element.`,
    feature_award: `COMMENT ANGLE: Featured / awarded / published work. Genuine congrats on the recognition, specific to the piece.`,
    collab: `COMMENT ANGLE: A collab with another artist. Acknowledge the combined work / the other artist if named.`,
    educational: `COMMENT ANGLE: Educational / tutorial content. Acknowledge the knowledge share genuinely — peer-to-peer respect (e.g. "this breakdown is gold").`,
    healed: `COMMENT ANGLE: Healed result. Comment on how it held up — line integrity, color retention, crispness over time.`,
    wip: `COMMENT ANGLE: Work in progress / current session. Comment on the stage reached and the craft so far; anticipation for the finish.`,
    coverup: `COMMENT ANGLE: A cover-up / transformation. Comment on how the old was absorbed / the new design's strength.`,
    portrait: `COMMENT ANGLE: A portrait / realism piece. Comment on the likeness / the eyes / how the face reads.`,
    pet_portrait: `COMMENT ANGLE: A pet portrait. Warm reaction to capturing the animal's character.`,
    personal_tribute: `COMMENT ANGLE: A tribute to a loved one. Warm, heartfelt acknowledgment of who it honors.`,
    pet_memorial: `COMMENT ANGLE: RESPECTFUL. A pet memorial. Warm acknowledgment of the tribute, no slang/hype.`,
    human_memorial: `COMMENT ANGLE: RESPECTFUL. A memorial to someone passed. Warm, solemn acknowledgment.`,
    booking: `COMMENT ANGLE: Booking announcement. Genuine "your work sells itself" vibe — not a customer begging for a slot.`,
    convention: `COMMENT ANGLE: Convention / guest spot. React to the event / location, peer energy.`,
    bts: `COMMENT ANGLE: Behind-the-scenes / gear. React to the setup / machine / station like a peer.`,
    script_quote: `COMMENT ANGLE: Script / lettering. Comment on the flow / letter connections / the quote choice.`,
    fan_art: `COMMENT ANGLE: Pop-culture / character piece. React to the character / how it's captured.`,
    botanical_nature: `COMMENT ANGLE: Nature / botanical. Comment on a specific element (the leaf, the rose, the wave).`,
  };
  if (ANGLE[intent.intent]) return ANGLE[intent.intent];
  if (intent.sensitive || intent.tone === 'respectful') {
    return `POST TONE: RESPECTFUL / SENSITIVE. The author is sharing something personal or commemorative (${intent.intent}). Write a warm, genuine, short acknowledgment of the SUBJECT — name what it is (a pet memorial, a tribute). No slang, no jokes, no "slaps"/"af"/"tho", no hype. A simple heartfelt line like a real person would leave. NEVER be flippant.`;
  }
  switch (intent.tone) {
    case 'enthusiastic':
      return `POST TONE: ENTHUSIASTIC. The author is showing off available/celebratory work. A genuine hype/react comment is welcome — but still specific to the subject, not generic.`;
    case 'technical':
      return `POST TONE: TECHNICAL. The author is sharing process/WIP/cover-up. A peer comment about the craft/process fits.`;
    case 'celebratory':
      return `POST TONE: CELEBRATORY. Warm, genuine praise.`;
    case 'casual':
    default:
      return `POST TONE: CASUAL. A natural peer comment acknowledging the subject of the piece.`;
  }
};
