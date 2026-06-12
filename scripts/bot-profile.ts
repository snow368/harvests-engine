/**
 * Bot Behavior Profile — 人格画像 + 可扩展策略管道
 *
 * 每个 bot 对应一个"真人"画像，行为模式跨维度一致。
 * 新增行为维度只需在 Archetype 里加一条数据，各处理环节读 profile 自动适配。
 *
 * 用法:
 *   const profile = getBotProfile('bot_outreach_02');
 *   profile.strategies.likeStrategy        → 'selective_high_value'
 *   profile.strategies.commentStyle        → 'professional_insight'
 *   profile.strategies.activeSchedule      → 'morning_person'
 *   profile.strategies.riskProfile         → 'cautious'
 *   profile.stage('like').shouldLike(...)  → true/false + reason
 */

import { createHash } from 'node:crypto';

// =====================================================================
// 1. 人类画像 (Human Archetypes) — 现实中的 IG 使用者类型
// =====================================================================
export const ARCHETYPES = [
  {
    id: 'night_owl',
    label: '夜猫子',
    description: '活跃在深夜-凌晨，深度浏览、高互动、喜欢慢慢看每张图',
    typicalActiveHours: ['22:00-02:00', '14:00-17:00'],
    traits: ['high_engagement', 'deep_browse', 'comment_lover', 'slow_paced']
  },
  {
    id: 'scroller',
    label: '随手刷',
    description: '白天碎片时间刷一刷，快速浏览、选择性点赞、基本不评论',
    typicalActiveHours: ['07:00-09:00', '12:00-14:00', '18:00-20:00'],
    traits: ['casual', 'quick_browse', 'selective_liker', 'rare_comment']
  },
  {
    id: 'professional',
    label: '业内同行',
    description: '上班族作息，关注行业内容、专业评论、战略性关注',
    typicalActiveHours: ['09:00-12:00', '15:00-18:00'],
    traits: ['professional_tone', 'industry_focus', 'strategic_follow', 'comment_quality']
  },
  {
    id: 'social_butterfly',
    label: '社交达人',
    description: '互动欲强、频繁评论互动、关注涨粉快、话多',
    typicalActiveHours: ['10:00-13:00', '16:00-22:00'],
    traits: ['high_interaction', 'heavy_commenter', 'follow_unfollow', 'chatty']
  },
  {
    id: 'lurker',
    label: '潜水党',
    description: '只看不互动，偶尔点点赞，浏览速度很慢像在认真看',
    typicalActiveHours: ['08:00-10:00', '20:00-23:00'],
    traits: ['mostly_browse', 'minimal_interaction', 'slow_browse', 'never_comment']
  },
  {
    id: 'growth_hacker',
    label: '增长黑客',
    description: '有策略地运作：定时定量互动、关注/取关循环、数据驱动',
    typicalActiveHours: ['06:00-09:00', '11:00-14:00', '19:00-22:00'],
    traits: ['strategic_engagement', 'follow_unfollow_cycle', 'scheduled_actions', 'data_driven']
  },
  {
    id: 'weekend_warrior',
    label: '周末党',
    description: '工作日偶尔上线，周末集中操作，大量补进度',
    typicalActiveHours: ['WEEKDAY:12:00-13:00', 'WEEKEND:10:00-18:00'],
    traits: ['weekend_bulk', 'weekday_minimal', 'catch_up_mode', 'burst_activity']
  },
  {
    id: 'collector',
    label: '收藏家',
    description: '关注大量账号、喜欢保存帖子、建立行业数据库式的浏览模式',
    typicalActiveHours: ['09:00-11:00', '14:00-16:00', '21:00-23:00'],
    traits: ['heavy_follower', 'content_saver', 'catalog_browse', 'wide_coverage']
  },
] as const;

export type ArchetypeId = (typeof ARCHETYPES)[number]['id'];

// =====================================================================
// 2. 策略维度 (Strategy Dimensions) — 每个维度是一种行为策略
// =====================================================================

/** 点赞策略 */
export const LIKE_STRATEGIES = [
  'generous' as const,           // 几乎每帖都点，适合 social_butterfly
  'selective_high_value' as const, // 只看高信号帖子，适合 professional
  'sparse' as const,             // 极少点赞，适合 lurker
  'newest_only' as const,        // 只看最近N天的帖子，适合 growth_hacker
  'tattoo_purist' as const,      // 只点赞含明确纹身信号的，适合 night_owl
  'random_walk' as const,        // 随机点赞，没有固定模式，适合 scroller
];

/** 评论风格 */
export const COMMENT_STYLES = [
  'professional_insight' as const, // 技术性评论，适合 professional
  'casual_praise' as const,        // 简短夸奖，适合 scroller
  'question_asker' as const,       // 提问互动，适合 social_butterfly
  'silent' as const,               // 不评论，适合 lurker
  'trend_commenter' as const,      // 追热门评论风格，适合 growth_hacker
  'detailed_critic' as const,      // 详细点评，适合 night_owl
];

/** 关注策略 */
export const FOLLOW_STRATEGIES = [
  'aggressive' as const,          // 大量关注，适合 growth_hacker
  'selective' as const,           // 只关注高价值账号，适合 professional
  'moderate' as const,            // 适度关注，适合 social_butterfly
  'rare' as const,                // 几乎不关注，适合 lurker
  'collector' as const,           // 广泛关注建立数据库，适合 collector
  'reciprocal' as const,          // 只关注互关了的，适合 night_owl
];

/** 活跃时段 */
export const ACTIVE_SCHEDULES = [
  'night_owl' as const,           // 深夜活跃
  'morning_person' as const,      // 早上活跃
  'office_hours' as const,        // 工作时间活跃
  'lunch_breaker' as const,       // 午休碎片时间
  'random_scatter' as const,      // 全天随机
  'weekend_binger' as const,      // 周末集中活跃
  'evening_winder' as const,      // 晚上放松型
];

/** 风险偏好 */
export const RISK_PROFILES = [
  'ultra_cautious' as const,      // 极保守：长时间间隔、低频率
  'cautious' as const,            // 保守：遵守所有限速
  'moderate' as const,            // 中等：偶尔微超限速
  'aggressive' as const,          // 激进：接近极限操作
  'experimental' as const,        // 试探性：根据反馈动态调整
];

/** 浏览深度 */
export const BROWSE_DEPTHS = [
  'surface' as const,             // 只看封面，不点开
  'light' as const,               // 点开 1-2 张
  'normal' as const,              // 点开 3-5 张
  'deep' as const,                // 点开很多，仔细看
  'completionist' as const,       // 几乎看所有帖子
];

/** 营销风格 (DM/私信) */
export const MARKETING_STYLES = [
  'soft_sell' as const,           // 软推广：闲聊导入产品
  'direct_pitch' as const,        // 直接介绍产品
  'value_first' as const,         // 先给价值再推产品
  'collaboration' as const,       // 合作邀约角度
  'silent_marketer' as const,     // 不发私信，靠 bio 引流
];

// =====================================================================
// 3. 策略维度类型聚合
// =====================================================================

export type LikeStrategy = (typeof LIKE_STRATEGIES)[number];
export type CommentStyle = (typeof COMMENT_STYLES)[number];
export type FollowStrategy = (typeof FOLLOW_STRATEGIES)[number];
export type ActiveSchedule = (typeof ACTIVE_SCHEDULES)[number];
export type RiskProfile = (typeof RISK_PROFILES)[number];
export type BrowseDepth = (typeof BROWSE_DEPTHS)[number];
export type MarketingStyle = (typeof MARKETING_STYLES)[number];

/**
 * BotStrategies — 所有行为维度的策略选择
 *
 * ★ 扩展方法：加新的行为维度时，在这里新增字段
 *    + 在上面对应加策略枚举
 *    + 在 ARCHETYPE_STRATEGY_MAP 里补对应数据
 *    各处理环节 (like/comment/follow/browse) 自动适配
 */
export interface BotStrategies {
  likeStrategy: LikeStrategy;
  commentStyle: CommentStyle;
  followStrategy: FollowStrategy;
  activeSchedule: ActiveSchedule;
  riskProfile: RiskProfile;
  browseDepth: BrowseDepth;
  marketingStyle: MarketingStyle;
}

// =====================================================================
// 4. 画像 → 策略映射 (Archetype → Strategy Map)
//    新增行为维度时在这里补数据即可
// =====================================================================

const ARCHETYPE_STRATEGY_MAP: Record<ArchetypeId, BotStrategies> = {
  night_owl: {
    likeStrategy: 'tattoo_purist',
    commentStyle: 'detailed_critic',
    followStrategy: 'reciprocal',
    activeSchedule: 'night_owl',
    riskProfile: 'cautious',
    browseDepth: 'deep',
    marketingStyle: 'value_first',
  },
  scroller: {
    likeStrategy: 'random_walk',
    commentStyle: 'casual_praise',
    followStrategy: 'rare',
    activeSchedule: 'lunch_breaker',
    riskProfile: 'moderate',
    browseDepth: 'light',
    marketingStyle: 'silent_marketer',
  },
  professional: {
    likeStrategy: 'selective_high_value',
    commentStyle: 'professional_insight',
    followStrategy: 'selective',
    activeSchedule: 'office_hours',
    riskProfile: 'cautious',
    browseDepth: 'normal',
    marketingStyle: 'direct_pitch',
  },
  social_butterfly: {
    likeStrategy: 'generous',
    commentStyle: 'question_asker',
    followStrategy: 'moderate',
    activeSchedule: 'evening_winder',
    riskProfile: 'aggressive',
    browseDepth: 'normal',
    marketingStyle: 'soft_sell',
  },
  lurker: {
    likeStrategy: 'sparse',
    commentStyle: 'silent',
    followStrategy: 'rare',
    activeSchedule: 'random_scatter',
    riskProfile: 'ultra_cautious',
    browseDepth: 'surface',
    marketingStyle: 'silent_marketer',
  },
  growth_hacker: {
    likeStrategy: 'newest_only',
    commentStyle: 'trend_commenter',
    followStrategy: 'aggressive',
    activeSchedule: 'morning_person',
    riskProfile: 'experimental',
    browseDepth: 'light',
    marketingStyle: 'collaboration',
  },
  weekend_warrior: {
    likeStrategy: 'generous',
    commentStyle: 'casual_praise',
    followStrategy: 'moderate',
    activeSchedule: 'weekend_binger',
    riskProfile: 'moderate',
    browseDepth: 'normal',
    marketingStyle: 'soft_sell',
  },
  collector: {
    likeStrategy: 'selective_high_value',
    commentStyle: 'silent',
    followStrategy: 'collector',
    activeSchedule: 'evening_winder',
    riskProfile: 'cautious',
    browseDepth: 'surface',
    marketingStyle: 'silent_marketer',
  },
};

// =====================================================================
// 5. 策略维度的数值映射 (Strategy → numeric config)
//    每个策略选择对应一套具体的行为参数
// =====================================================================

const LIKE_CONFIG: Record<LikeStrategy, { minPerVisit: number; maxPerVisit: number; dailyCap: number; cooldownHours: number; oldPostSkipDays: number; recentPreferDays: number; scoreWeights: { tattoo: number; negative: number; promo: number; reel: number; recency: number } }> = {
  generous:            { minPerVisit: 2, maxPerVisit: 5, dailyCap: 25, cooldownHours: 24, oldPostSkipDays: 120, recentPreferDays: 30, scoreWeights: { tattoo: 2, negative: -3, promo: -2, reel: 0, recency: 1 } },
  selective_high_value:{ minPerVisit: 0, maxPerVisit: 2, dailyCap: 12, cooldownHours: 48, oldPostSkipDays: 180, recentPreferDays: 14, scoreWeights: { tattoo: 5, negative: -6, promo: -4, reel: -2, recency: 3 } },
  sparse:              { minPerVisit: 0, maxPerVisit: 1, dailyCap: 5,  cooldownHours: 72, oldPostSkipDays: 365, recentPreferDays: 7,  scoreWeights: { tattoo: 3, negative: -5, promo: -3, reel: -1, recency: 2 } },
  newest_only:         { minPerVisit: 1, maxPerVisit: 3, dailyCap: 20, cooldownHours: 24, oldPostSkipDays: 14,  recentPreferDays: 3,  scoreWeights: { tattoo: 1, negative: -2, promo: -1, reel: -1, recency: 5 } },
  tattoo_purist:       { minPerVisit: 1, maxPerVisit: 3, dailyCap: 15, cooldownHours: 48, oldPostSkipDays: 365, recentPreferDays: 7,  scoreWeights: { tattoo: 8, negative: -8, promo: -5, reel: -3, recency: 2 } },
  random_walk:         { minPerVisit: 0, maxPerVisit: 4, dailyCap: 10, cooldownHours: 36, oldPostSkipDays: 90,  recentPreferDays: 14, scoreWeights: { tattoo: 1, negative: -2, promo: -1, reel: 0,  recency: 1 } },
};

const COMMENT_CONFIG: Record<CommentStyle, { enabled: boolean; chance: number; dailyMax: number; handleCooldownHours: number; reviewMode: boolean; tone: string }> = {
  professional_insight: { enabled: true,  chance: 0.3,  dailyMax: 3,  handleCooldownHours: 72, reviewMode: true,  tone: 'professional' },
  casual_praise:        { enabled: true,  chance: 0.15, dailyMax: 2,  handleCooldownHours: 48, reviewMode: false, tone: 'casual' },
  question_asker:       { enabled: true,  chance: 0.4,  dailyMax: 5,  handleCooldownHours: 36, reviewMode: false, tone: 'question' },
  silent:               { enabled: false, chance: 0,    dailyMax: 0,  handleCooldownHours: 0,  reviewMode: true,  tone: 'none' },
  trend_commenter:      { enabled: true,  chance: 0.25, dailyMax: 4,  handleCooldownHours: 48, reviewMode: false, tone: 'detail_focused' },
  detailed_critic:      { enabled: true,  chance: 0.35, dailyMax: 2,  handleCooldownHours: 96, reviewMode: true,  tone: 'detail_focused' },
};

const FOLLOW_CONFIG: Record<FollowStrategy, { enabled: boolean; dailyMin: number; dailyMax: number; minTouches: number; followBackBonus: boolean; unfollowAfterDays: number | null }> = {
  aggressive:   { enabled: true,  dailyMin: 10, dailyMax: 30, minTouches: 1,  followBackBonus: true,  unfollowAfterDays: 7  },
  selective:    { enabled: true,  dailyMin: 2,  dailyMax: 8,  minTouches: 3,  followBackBonus: true,  unfollowAfterDays: 14 },
  moderate:     { enabled: true,  dailyMin: 3,  dailyMax: 12, minTouches: 2,  followBackBonus: false, unfollowAfterDays: null },
  rare:         { enabled: false, dailyMin: 0,  dailyMax: 2,  minTouches: 5,  followBackBonus: false, unfollowAfterDays: null },
  collector:    { enabled: true,  dailyMin: 5,  dailyMax: 20, minTouches: 1,  followBackBonus: false, unfollowAfterDays: null },
  reciprocal:   { enabled: true,  dailyMin: 1,  dailyMax: 5,  minTouches: 2,  followBackBonus: true,  unfollowAfterDays: 30 },
};

const BROWSE_CONFIG: Record<BrowseDepth, { minOpen: number; maxOpen: number; scrollRounds: [number, number]; watchMinMs: number; watchMaxMs: number; minVisibleTiles: number; secondaryBrowseChance: number }> = {
  surface:        { minOpen: 0, maxOpen: 0, scrollRounds: [1, 3], watchMinMs: 500,  watchMaxMs: 2000,  minVisibleTiles: 3,  secondaryBrowseChance: 0.05 },
  light:          { minOpen: 1, maxOpen: 2, scrollRounds: [2, 4], watchMinMs: 1500, watchMaxMs: 4000,  minVisibleTiles: 4,  secondaryBrowseChance: 0.15 },
  normal:         { minOpen: 2, maxOpen: 4, scrollRounds: [3, 6], watchMinMs: 2500, watchMaxMs: 7000,  minVisibleTiles: 5,  secondaryBrowseChance: 0.35 },
  deep:           { minOpen: 4, maxOpen: 8, scrollRounds: [5, 10], watchMinMs: 4000, watchMaxMs: 12000, minVisibleTiles: 6,  secondaryBrowseChance: 0.55 },
  completionist:  { minOpen: 8, maxOpen: 15, scrollRounds: [8, 15], watchMinMs: 6000, watchMaxMs: 20000, minVisibleTiles: 8, secondaryBrowseChance: 0.75 },
};

const RISK_CONFIG: Record<RiskProfile, { taskIntervalMinSec: number; taskIntervalMaxSec: number; breakEveryN: number; breakMinMs: number; breakMaxMs: number; dailyBrowseCap: number; backoffMultiplier: number }> = {
  ultra_cautious:  { taskIntervalMinSec: 30, taskIntervalMaxSec: 90, breakEveryN: 2,  breakMinMs: 10 * 60000, breakMaxMs: 20 * 60000, dailyBrowseCap: 30,  backoffMultiplier: 3 },
  cautious:        { taskIntervalMinSec: 15, taskIntervalMaxSec: 40, breakEveryN: 3,  breakMinMs: 8 * 60000,  breakMaxMs: 15 * 60000, dailyBrowseCap: 50,  backoffMultiplier: 2 },
  moderate:        { taskIntervalMinSec: 10, taskIntervalMaxSec: 25, breakEveryN: 4,  breakMinMs: 5 * 60000,  breakMaxMs: 12 * 60000, dailyBrowseCap: 80,  backoffMultiplier: 1.5 },
  aggressive:      { taskIntervalMinSec: 5,  taskIntervalMaxSec: 15, breakEveryN: 6,  breakMinMs: 3 * 60000,  breakMaxMs: 8 * 60000,  dailyBrowseCap: 120, backoffMultiplier: 1 },
  experimental:    { taskIntervalMinSec: 3,  taskIntervalMaxSec: 12, breakEveryN: 8,  breakMinMs: 2 * 60000,  breakMaxMs: 5 * 60000,  dailyBrowseCap: 200, backoffMultiplier: 0.5 },
};

const MARKETING_CONFIG: Record<MarketingStyle, { dmEnabled: boolean; dmDelayHours: number; approachType: string; followUpCount: number; followUpIntervalDays: number }> = {
  soft_sell:        { dmEnabled: true,  dmDelayHours: 24, approachType: 'casual_question',   followUpCount: 3, followUpIntervalDays: 7 },
  direct_pitch:     { dmEnabled: true,  dmDelayHours: 48, approachType: 'product_intro',     followUpCount: 2, followUpIntervalDays: 5 },
  value_first:      { dmEnabled: true,  dmDelayHours: 72, approachType: 'industry_tip',      followUpCount: 4, followUpIntervalDays: 10 },
  collaboration:    { dmEnabled: true,  dmDelayHours: 96, approachType: 'collab_proposal',   followUpCount: 2, followUpIntervalDays: 14 },
  silent_marketer:  { dmEnabled: false, dmDelayHours: 0,  approachType: 'bio_only',          followUpCount: 0, followUpIntervalDays: 0 },
};

// =====================================================================
// 6. Typing/Browser fingerprint (原始bot-profile已有的)
// =====================================================================
export interface TypingProfile {
  baseSpeedMs: number;
  varianceMs: number;
  pauseChance: number;
  pauseMs: number;
  mistakeChance: number;
  backspaceMs: number;
}

export interface ViewportProfile {
  width: number;
  height: number;
}

// =====================================================================
// 7. 完整 BotProfile
// =====================================================================
export interface BotProfile {
  botId: string;
  hash: string;
  archetype: ArchetypeId;
  strategies: BotStrategies;
  // 数值参数 (由 strategies 派生)
  liking: typeof LIKE_CONFIG[LikeStrategy];
  commenting: typeof COMMENT_CONFIG[CommentStyle];
  following: typeof FOLLOW_CONFIG[FollowStrategy];
  browsing: typeof BROWSE_CONFIG[BrowseDepth];
  risk: typeof RISK_CONFIG[RiskProfile];
  marketing: typeof MARKETING_CONFIG[MarketingStyle];
  // 打字指纹 (保留原版)
  typing: TypingProfile;
  viewport: ViewportProfile;
  commentStyleSeed: number;
}

// =====================================================================
// 8. 确定性 hash 工具
// =====================================================================
const hashInt = (botId: string, suffix: string, min: number, max: number): number => {
  const h = createHash('sha256').update(`${botId}:${suffix}`).digest('hex');
  const normalized = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  return Math.floor(min + normalized * (max - min + 1));
};

const hashPick = <T>(botId: string, suffix: string, options: readonly T[]): T => {
  const idx = hashInt(botId, suffix, 0, options.length - 1);
  return options[idx];
};

const hashRange = (botId: string, suffix: string, min: number, max: number): number => {
  const h = createHash('sha256').update(`${botId}:${suffix}`).digest('hex');
  const normalized = parseInt(h.slice(0, 8), 16) / 0xffffffff;
  return +(min + normalized * (max - min)).toFixed(2);
};

// =====================================================================
// 9. 画像生成
// =====================================================================
const TYPING_VARIANTS: Record<ArchetypeId, { baseSpeed: [number, number]; mistake: [number, number]; pause: [number, number] }> = {
  night_owl:        { baseSpeed: [60, 120], mistake: [0.01, 0.03], pause: [0.05, 0.12] },
  scroller:         { baseSpeed: [40, 80],  mistake: [0.02, 0.05], pause: [0.03, 0.08] },
  professional:     { baseSpeed: [50, 90],  mistake: [0.01, 0.03], pause: [0.03, 0.08] },
  social_butterfly: { baseSpeed: [60, 110], mistake: [0.02, 0.05], pause: [0.04, 0.10] },
  lurker:           { baseSpeed: [80, 120], mistake: [0.01, 0.04], pause: [0.06, 0.12] },
  growth_hacker:    { baseSpeed: [45, 85],  mistake: [0.01, 0.03], pause: [0.02, 0.06] },
  weekend_warrior:  { baseSpeed: [55, 100], mistake: [0.02, 0.04], pause: [0.04, 0.09] },
  collector:        { baseSpeed: [70, 110], mistake: [0.01, 0.03], pause: [0.05, 0.10] },
};

const generateProfile = (botId: string): BotProfile => {
  const archetype = hashPick(botId, 'archetype', ARCHETYPES.map(a => a.id));
  const strategies = { ...ARCHETYPE_STRATEGY_MAP[archetype] };

  // 10% 概率在某个维度上"偏离"画像（让同一画像的 bot 也有细微差异）
  if (hashRange(botId, 'deviation', 0, 1) < 0.1) {
    const allLike = LIKE_STRATEGIES;
    const allComment = COMMENT_STYLES;
    const allFollow = FOLLOW_STRATEGIES;
    const dims: (keyof BotStrategies)[] = ['likeStrategy', 'commentStyle', 'followStrategy', 'browseDepth'];
    const dim = hashPick(botId, 'deviate_dim', dims);
    if (dim === 'likeStrategy') strategies.likeStrategy = hashPick(botId, 'deviate_like', allLike);
    else if (dim === 'commentStyle') strategies.commentStyle = hashPick(botId, 'deviate_comment', allComment);
    else if (dim === 'followStrategy') strategies.followStrategy = hashPick(botId, 'deviate_follow', allFollow);
    else if (dim === 'browseDepth') strategies.browseDepth = hashPick(botId, 'deviate_browse', BROWSE_DEPTHS);
  }

  const tv = TYPING_VARIANTS[archetype];

  return {
    botId,
    hash: createHash('sha256').update(botId).digest('hex').slice(0, 16),
    archetype,
    strategies,
    liking: LIKE_CONFIG[strategies.likeStrategy],
    commenting: COMMENT_CONFIG[strategies.commentStyle],
    following: FOLLOW_CONFIG[strategies.followStrategy],
    browsing: BROWSE_CONFIG[strategies.browseDepth],
    risk: RISK_CONFIG[strategies.riskProfile],
    marketing: MARKETING_CONFIG[strategies.marketingStyle],
    typing: {
      baseSpeedMs: hashInt(botId, 'typo_base', tv.baseSpeed[0], tv.baseSpeed[1]),
      varianceMs: hashInt(botId, 'typo_var', 15, 74),
      pauseChance: hashRange(botId, 'typo_pauseC', tv.pause[0], tv.pause[1]),
      pauseMs: hashInt(botId, 'typo_pauseMs', 300, 1499),
      mistakeChance: hashRange(botId, 'typo_mistake', tv.mistake[0], tv.mistake[1]),
      backspaceMs: hashInt(botId, 'typo_bs', 80, 229),
    },
    viewport: hashPick(botId, 'viewport', [
      { width: 1280, height: 900 },
      { width: 1366, height: 768 },
      { width: 1440, height: 900 },
      { width: 1536, height: 864 },
      { width: 1600, height: 900 },
      { width: 1920, height: 1080 },
    ]),
    commentStyleSeed: hashInt(botId, 'comment_seed', 0, 9999),
  };
};

// =====================================================================
// 10. 缓存与导出
// =====================================================================
const profileCache = new Map<string, BotProfile>();

export const getBotProfile = (botId: string): BotProfile => {
  const cached = profileCache.get(botId);
  if (cached) return cached;
  const profile = generateProfile(botId);
  profileCache.set(botId, profile);
  return profile;
};

/** 每日速度抖动：同 bot 每天速度不一样，但不超出自然范围 */
export const getDailySpeedFactor = (profile: BotProfile): number => {
  const today = new Date().toISOString().slice(0, 10);
  const dayHash = createHash('sha256').update(`${profile.botId}:browse:${today}`).digest('hex');
  const normalized = parseInt(dayHash.slice(0, 8), 16) / 0xffffffff;
  const minMs = profile.browsing.watchMinMs;
  const maxMs = profile.browsing.watchMaxMs;
  const mid = (minMs + maxMs) / 2;
  const spread = (maxMs - minMs) / 2;
  // 每天在 [minMs, maxMs] 范围内偏移，但保持在该 bot 的范围内
  return +(mid - spread + normalized * spread * 2).toFixed(2);
};

export const printProfile = (p: BotProfile) => {
  console.log(`[bot-profile] ${p.botId} (hash=${p.hash})`);
  console.log(`  archetype: ${p.archetype} — ${ARCHETYPES.find(a => a.id === p.archetype)?.label}`);
  console.log(`  strategies: like=${p.strategies.likeStrategy}, comment=${p.strategies.commentStyle}, follow=${p.strategies.followStrategy}, browse=${p.strategies.browseDepth}, risk=${p.strategies.riskProfile}, marketing=${p.strategies.marketingStyle}`);
  console.log(`  typing: ${p.typing.baseSpeedMs}ms/char, typo ${(p.typing.mistakeChance*100).toFixed(0)}%, pause ${(p.typing.pauseChance*100).toFixed(0)}%`);
  console.log(`  viewport: ${p.viewport.width}x${p.viewport.height}`);
  console.log(`  marketing DM: ${p.marketing.dmEnabled ? `enabled (${p.marketing.approachType}, delay ${p.marketing.dmDelayHours}h)` : 'disabled (bio only)'}`);
};

export { LIKE_CONFIG, COMMENT_CONFIG, FOLLOW_CONFIG, BROWSE_CONFIG, RISK_CONFIG, MARKETING_CONFIG };
