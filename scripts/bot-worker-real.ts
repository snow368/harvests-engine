/* eslint-disable no-console */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createWorker } from 'tesseract.js';
import { generateComment, clearRecentHistory, detectTattooStyle, extractTechniqueHintsFromVision, commentShapeFlags } from './comment-generator';
import { analyzePostImage, isVisionEnabled, buildVisionDescription } from './vision-analyze';
import { detectPostType, detectSubject, isPiercingHandle, detectPostIntent, reconcileIntentWithVision, intentEngagement } from './tattoo-voice';
// 关注回收（follow churn）：清理长期未回关的号，压低 following:followers 比例。
// 默认关闭，由 BOT_UNFOLLOW_ENABLED 打开；详见 scripts/unfollow-maintenance.ts
import { runUnfollowMaintenance, countFollowing } from './unfollow-maintenance';
import { isCommentBlacklisted } from './comment-blacklist';

// 2026-09-17 致命日志必须**同时**进 out 日志。
// pm2 把 console.error 写进 error_file、console.log 写进 out_file；而运维习惯只看
// bot-worker-out.log ⇒ 启动期的致命原因一直"看不见"（排查时 out 日志里只有重启后的
// config 打印，看着像"启动完就没动静"，实际是 error 日志里在刷 fatal）。
const logFatal = (...args: any[]) => {
  console.error(...args);
  try { console.log(...args); } catch {}
};

// 2026-08-07 全局兜底：捕获未处理异常/拒绝，避免单任务内的异步错误直接杀死整个进程
// （此前 bot 在首个任务执行中静默退出，导致任务永远停在 leased、无法 done/failed，违反"需要跑通"要求）。
// 注册 handler 后 Node 不会因 unhandledRejection 默认退出，进程保持存活并落盘原因。
process.on('uncaughtException', (err: any) => {
  logFatal('[FATAL uncaughtException]', err?.stack || err);
});
process.on('unhandledRejection', (reason: any) => {
  logFatal('[FATAL unhandledRejection]', reason?.stack || reason);
});


type CommandPayload = {
  id: string;
  artistId?: string;
  artistHandle?: string;
  [key: string]: any;
};
type BrowseSummary = {
  totalMedia: number;
  opened: number;
  desiredOpenCount: number;
};
type LikeActionSummary = {
  attempted: number;
  liked: number;
  skippedCooldown: boolean;
  likedUrls: string[];
};
type CommentActionSummary = {
  attempted: number;
  posted: number;
  skipped: boolean;
  reason?: string;
  text?: string;
  postUrl?: string;
};
type FollowActionSummary = {
  attempted: number;
  followed: number;
  skipped: boolean;
  reason?: string;
};
type ProfileFacts = {
  url: string;
  title: string;
  statTexts: string[];
  postCount?: number;
  followers?: number;
  following?: number;
  bio: string;
  profileAddress?: string;
  externalUrl?: string;
  email?: string;
  emails?: string[];
  categoryLabel?: string;
  sampleCaption?: string;
  imageAltHints?: string[];
  categorySignals?: {
    textPositiveHits: string[];
    textNegativeHits: string[];
    imagePositiveHits: string[];
    imageNegativeHits: string[];
  };
  nonTattooSuspect?: boolean;
  category?: string;
};

const API_BASE = (process.env.BOT_API_BASE || 'https://harvests-cloud-api.inkflowapp.workers.dev').replace(/\/+$/, '');
const BOT_ID = process.env.BOT_ID || `bot_${Math.random().toString(36).slice(2, 8)}`;
const BOT_HOST = process.env.BOT_HOST || process.env.HOSTNAME || 'local-dev';
const BOT_VERSION = process.env.BOT_VERSION || '0.2.0-real';
const ACCOUNT_IDS = (process.env.BOT_ACCOUNT_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
const BOT_API_KEY = (process.env.BOT_API_KEY || '').trim();
const BOT_API_TOKEN = (process.env.BOT_API_TOKEN || 'vps-bot-secret-2024').trim();
// D1 配额防御（2026-09-07）：默认 60s/60s，禁止裸跑回 4s/15s 旧档——
// bot_fizdy8 事件：无 env 裸跑 = 4s poll × 全表扫描，1.4h 烧穿 D1 全天 500 万行额度。
// 需要更快响应时显式传 BOT_POLL_INTERVAL_MS，但默认必须保守。
const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.BOT_POLL_INTERVAL_MS || 60000));
const POLL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BOT_POLL_LIMIT || 1)));
const HEARTBEAT_INTERVAL_MS = Math.max(10000, Number(process.env.BOT_HEARTBEAT_INTERVAL_MS || 60000));
const CONTROL_PAUSE_FILE = path.resolve(process.cwd(), 'data', 'control-pause', 'bot-worker.pause');
let controlPauseLogged = false;
// 🔴 2026-09-18：「人工暂停」是**最危险的静默态** —— 它让主循环每轮 continue、
// 却既不打行为事件也不触发看门狗（看门狗主动跳过暂停期），于是「进程 online、
// 心跳新鲜、零产出」可以无限持续，且没人查得出原因。
// 这里节流 10 分钟写一次 D1 事件，让任何长时间的暂停在数据里留痕。
let controlPauseLoggedAt = 0;
const CONTROL_PAUSE_LOG_EVERY_MS = 10 * 60_000;
const IG_BASE = (process.env.INSTAGRAM_BASE || 'https://www.instagram.com').replace(/\/+$/, '');
const PROFILE_DIR = process.env.BOT_PROFILE_DIR || `./data/bot_profiles/${BOT_ID}`;
const HEADLESS = String(process.env.BOT_HEADLESS || 'false').toLowerCase() === 'true';
const BOT_CDP_URL = (process.env.BOT_CDP_URL || '').trim();
const BOT_LAUNCH_MODE = (process.env.BOT_LAUNCH_MODE || 'cdp').trim().toLowerCase(); // cdp | persistent
const BOT_EXEC_MODE = (process.env.BOT_EXEC_MODE || 'browse_only').trim().toLowerCase(); // browse_only | browse_like
const BOT_HUMAN_BREAK_MIN_MS = Math.max(60_000, Number(process.env.BOT_HUMAN_BREAK_MIN_MS || 5 * 60_000)); // min break 5 min
const BOT_HUMAN_BREAK_MAX_MS = Math.max(BOT_HUMAN_BREAK_MIN_MS, Number(process.env.BOT_HUMAN_BREAK_MAX_MS || 15 * 60_000)); // max break 15 min
const BOT_BREAK_EVERY_N = Math.max(2, Math.min(10, Number(process.env.BOT_BREAK_EVERY_N || 4))); // break every ~4 profiles
const HUMAN_MIMICRY_ENABLED = String(process.env.HUMAN_MIMICRY_ENABLED || 'true').toLowerCase() === 'true';
const BOT_SPEED_FACTOR = Math.max(0.8, Number(process.env.BOT_SPEED_FACTOR || 1.0)); // 1.0 baseline, higher = slower
const BOT_VARIANCE = Math.min(0.8, Math.max(0, Number(process.env.BOT_VARIANCE || 0.25))); // per-bot elastic variance
const BOT_BROWSE_ORDER = (process.env.BOT_BROWSE_ORDER || 'random').trim().toLowerCase(); // random | newest | mixed
const BOT_MIN_VISIBLE_TILES = Math.max(2, Math.min(12, Number(process.env.BOT_MIN_VISIBLE_TILES || 6)));
const BOT_PROXY_SERVER = (process.env.BOT_PROXY_SERVER || '').trim();
const BOT_PROXY_USERNAME = (process.env.BOT_PROXY_USERNAME || '').trim();
const BOT_PROXY_PASSWORD = (process.env.BOT_PROXY_PASSWORD || '').trim();
const BOT_NON_TATTOO_MODE = (process.env.BOT_NON_TATTOO_MODE || 'review_only').trim().toLowerCase(); // review_only | fail
const BOT_LIKE_MIN_PER_VISIT = Math.max(0, Math.min(5, Number(process.env.BOT_LIKE_MIN_PER_VISIT || 1)));
const BOT_LIKE_MAX_PER_VISIT = Math.max(BOT_LIKE_MIN_PER_VISIT, Math.min(8, Number(process.env.BOT_LIKE_MAX_PER_VISIT || 3)));
const BOT_LIKE_INTERVAL_MIN_SEC = Math.max(10, Number(process.env.BOT_LIKE_INTERVAL_MIN_SEC || 40));
const BOT_LIKE_INTERVAL_MAX_SEC = Math.max(BOT_LIKE_INTERVAL_MIN_SEC, Number(process.env.BOT_LIKE_INTERVAL_MAX_SEC || 120));
const BOT_LIKE_COOLDOWN_MIN_HOURS = Math.max(4, Number(process.env.BOT_LIKE_COOLDOWN_MIN_HOURS || 24));
const BOT_LIKE_COOLDOWN_MAX_HOURS = Math.max(BOT_LIKE_COOLDOWN_MIN_HOURS, Number(process.env.BOT_LIKE_COOLDOWN_MAX_HOURS || 72));
const BOT_SKIP_OLD_POST_DAYS = Math.max(30, Number(process.env.BOT_SKIP_OLD_POST_DAYS || 180));
const BOT_PREFER_RECENT_DAYS = Math.max(7, Number(process.env.BOT_PREFER_RECENT_DAYS || 30));
const BOT_COMMENT_ENABLED = String(process.env.BOT_COMMENT_ENABLED || 'false').toLowerCase() === 'true';
// 诊断日志开关：BOT_DEBUG=true 时打印点赞/关注决策链，用于排查为何没点赞/关注/DM。默认关闭避免刷屏。
const BOT_DEBUG = String(process.env.BOT_DEBUG || 'false').toLowerCase() === 'true';
const dbg = (...args: any[]) => { if (BOT_DEBUG) console.error(...args); };
const BOT_COMMENT_CHANCE = Math.max(0, Math.min(1, Number(process.env.BOT_COMMENT_CHANCE || 0.2)));
const BOT_COMMENT_DRAFT_DAILY_MIN = Math.max(0, Math.min(50, Number(process.env.BOT_COMMENT_DRAFT_DAILY_MIN || 15)));
const BOT_COMMENT_DRAFT_DAILY_MAX = Math.max(
  BOT_COMMENT_DRAFT_DAILY_MIN,
  Math.min(50, Number(process.env.BOT_COMMENT_DRAFT_DAILY_MAX || process.env.BOT_COMMENT_DAILY_MAX || 25)),
);
const BOT_COMMENT_PUBLISH_DAILY_MAX = Math.max(0, Math.min(50, Number(process.env.BOT_COMMENT_PUBLISH_DAILY_MAX || 12)));

// ── 2026-09-19 用户拍板：草稿额度**按来源拆分**（「让 bot 每天评论几十个新人」）────────
// 旧行为：task_review（陌生目标帖）与 follow_back_ladder（已关注我们的号）**共用**同一个
//   comments.draftsByDay 额度 ⇒ 实测 `comment_skip_draft_daily_target` 是全链路最高频事件，
//   而 40min 窗口内 7 次 skip 的 source 全是 ladder ⇒ 真正带来新曝光的陌生目标帖被挤掉。
//   这就是「新人评论量上不去」的根因，不是总量不够。
// 新行为：两路各有独立日额度，陌生人占大头（默认 30–40 vs 6–10），互不挤占。
// 注意：两段上界仍受 Math.min(50) 硬顶（总草稿 ≤50/天，按 IG 行为安全线定）。
const clampCmt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const BOT_COMMENT_DRAFT_STRANGER_MIN = clampCmt(Number(process.env.BOT_COMMENT_DRAFT_STRANGER_MIN || 30), 0, 50);
const BOT_COMMENT_DRAFT_STRANGER_MAX = clampCmt(Number(process.env.BOT_COMMENT_DRAFT_STRANGER_MAX || 40), BOT_COMMENT_DRAFT_STRANGER_MIN, 50);
const BOT_COMMENT_DRAFT_LADDER_MIN = clampCmt(Number(process.env.BOT_COMMENT_DRAFT_LADDER_MIN || 6), 0, 50);
const BOT_COMMENT_DRAFT_LADDER_MAX = clampCmt(Number(process.env.BOT_COMMENT_DRAFT_LADDER_MAX || 10), BOT_COMMENT_DRAFT_LADDER_MIN, 50);
const BOT_COMMENT_PUBLISH_INTERVAL_MIN_SEC = Math.max(60, Number(process.env.BOT_COMMENT_PUBLISH_INTERVAL_MIN_SEC || 8 * 60));
const BOT_COMMENT_PUBLISH_INTERVAL_MAX_SEC = Math.max(
  BOT_COMMENT_PUBLISH_INTERVAL_MIN_SEC,
  Number(process.env.BOT_COMMENT_PUBLISH_INTERVAL_MAX_SEC || 20 * 60),
);
const BOT_COMMENT_HANDLE_COOLDOWN_HOURS = Math.max(24, Number(process.env.BOT_COMMENT_HANDLE_COOLDOWN_HOURS || 72));
// 硬闸门（2026-09-14 用户拍板）：视觉判定"图里看不到纹身" → 直接不写评论。
// 默认开。设 BOT_COMMENT_REQUIRE_TATTOO_VISIBLE=0 可退回旧行为（只按文字意图决定评不评）。
const BOT_COMMENT_REQUIRE_TATTOO_VISIBLE = String(process.env.BOT_COMMENT_REQUIRE_TATTOO_VISIBLE ?? '1').toLowerCase() !== '0';
const BOT_FOLLOW_ENABLED = String(process.env.BOT_FOLLOW_ENABLED || 'false').toLowerCase() === 'true';
// 回关开关（独立于 BOT_FOLLOW_ENABLED）：别人先关注我们/在我们帖下互动 → 我们礼貌回关。
// 回关不增加 following（反而 +粉丝），是粉丝维护而非扩张，故默认 true 不受"手动关注"策略影响。
const BOT_FOLLOW_BACK_ENABLED = String(process.env.BOT_FOLLOW_BACK_ENABLED || 'true').toLowerCase() === 'true';
// 回关行业审核：默认仅对 bio 判定为 tattoo 相关（tattoo artist/shop/ink 等）的号自动回关，
// 保证 B2B 受众质量；设 false 则对所有新粉/互动者无条件回关（旧行为）。
const BOT_FOLLOW_BACK_REQUIRE_TATTOO = String(process.env.BOT_FOLLOW_BACK_REQUIRE_TATTOO || 'true').toLowerCase() === 'true';
const BOT_FOLLOW_DAILY_MIN = Math.max(0, Math.min(30, Number(process.env.BOT_FOLLOW_DAILY_MIN || 2)));
const BOT_FOLLOW_DAILY_MAX = Math.max(BOT_FOLLOW_DAILY_MIN, Math.min(50, Number(process.env.BOT_FOLLOW_DAILY_MAX || 6)));
// 关注总量硬上限（0=不限）。following 达到该值后停止新增关注，只能靠取关腾出名额，
// 保证 following:followers 不再恶化（配合 unfollow-maintenance 的回收形成净流出）。
const BOT_FOLLOW_MAX_FOLLOWING = Math.max(0, Number(process.env.BOT_FOLLOW_MAX_FOLLOWING || 0));
const BOT_FOLLOW_MIN_TOUCHES = Math.max(1, Number(process.env.BOT_FOLLOW_MIN_TOUCHES || 2)); // must have >= N visits before follow
const BOT_DAILY_BROWSE_TARGET_NEW = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_NEW || 25));
const BOT_DAILY_BROWSE_TARGET_TRANSITION = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_TRANSITION || 50));
const BOT_DAILY_TASK_TARGET = Math.max(1, Number(process.env.BOT_DAILY_TASK_TARGET || 80));
const BOT_DAILY_BROWSE_TARGET_STABLE = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_STABLE || 130));
// OCR 仅用于兜底提取粉丝数，非点赞/评论/关注必需；沙箱环境下 tesseract.js 的
// createWorker('eng') 会去下载/初始化 WASM 模型并永久挂起，曾导致每个任务卡满看门狗。
// 默认关闭，且即便开启也用硬超时包裹，绝不阻塞任务执行（2026-08-07 修复）。
const BOT_OCR_ENABLED = String(process.env.BOT_OCR_ENABLED || 'false').toLowerCase() === 'true';
// DM 日上限：回关后的号"慢慢"发，不无上限狂发（2026-08-07 新增）。0 = 不限。
const BOT_DM_DAILY_MAX = Math.max(0, Number(process.env.BOT_DM_DAILY_MAX || 12));
// 回关后到首次 DM 的自然预热窗口（小时），避免秒回关秒 DM 显得机械。0 = 直接发。
const BOT_DM_WARMUP_HOURS = Math.max(0, Number(process.env.BOT_DM_WARMUP_HOURS || 4));
// 账号绑定/自动化起始日（ISO）。用于按真实账号成熟天数连续爬坡关注/评论/点赞上限。
// 填 IG 号接入系统的日期（peachtattoosupplyraiha，原 raiha8833；改名不重置年龄）。
// 不填则 bot 用本地首次运行日做基准（未来新号从 0 自动暖机）。
const BOT_ACCOUNT_BOUND_AT = String(process.env.BOT_ACCOUNT_BOUND_AT || '').trim();
// DM 文案池（回关后软性 B2B 开场白）。直接随 create-marketing-task 的 scriptContent 带上，
// 不依赖 cloud-api 的 marketing_scripts 表（该表写入被 Firebase 中间件拦截，需部署才能改）。
// 可用 BOT_DM_SCRIPTS_JSON 环境变量覆盖（JSON 字符串数组）。
const BOT_DM_SCRIPTS_DEFAULT = [
  "Hey — I've been quietly following your work, and I keep coming back to your linework. There's a calm confidence in it that's rare. I run InkFlow — we're the wholesale house for the stuff you burn through daily: ink, cartridges, aftercare. No pitch, just… if supply ever lets you down mid-session (we've ALL been there 😅), reply 'catalog' and I'll send our artist price list. Glad I found your page 🙌",
  "Quick honest one: your shading stopped me scrolling today. I've spent enough time around tattoo studios to know the difference between ink that flows and ink that fights you — and your pieces clearly come from the good stuff. I'm with InkFlow (wholesale ink + needles + aftercare). Whenever you want a backup source that just shows up on time, say the word and I'll send the list. Zero pressure 👍",
  "Been enjoying your posts — there's a real point of view in your work, not just technique. I help tattoo artists stay stocked through InkFlow (ink, carts, aftercare, wholesale). The thing I hear most from artists is 'I just want my supplier to not ghost me' — that's kind of our whole thing. If you ever want to compare or grab a sample kit, reply and I'll shoot it over. Happy to have you in the circle ✌️"
];
let BOT_DM_SCRIPTS: string[] = BOT_DM_SCRIPTS_DEFAULT;
try { if (process.env.BOT_DM_SCRIPTS_JSON) BOT_DM_SCRIPTS = JSON.parse(process.env.BOT_DM_SCRIPTS_JSON); } catch {}
if (!Array.isArray(BOT_DM_SCRIPTS) || !BOT_DM_SCRIPTS.length) BOT_DM_SCRIPTS = BOT_DM_SCRIPTS_DEFAULT;
// 2026-08-11: 暖受众 DM 文案池（对我们帖子下点赞/评论的人，软性感谢 + 供货钩子，情绪化代入感）
// 2026-08-11(补): 加西班牙语（es）池 —— 面向 TX/CA/FL 等西语纹身师，按 detectLangForHandle 选语言。
// 可用 AUDIENCE_DM_SCRIPTS_JSON 环境变量覆盖：
//   - JSON 数组 → 当作 en 池填充（向后兼容旧用法）；
//   - JSON 对象 {en:[...], es:[...]} → 直接覆盖两语言池。
const AUDIENCE_DM_SCRIPTS_DEFAULT: Record<string, string[]> = {
  en: [
    "Hey — thanks for the love on our recent piece 🙌 means a lot coming from someone with your eye. I run InkFlow — we're the wholesale house for the ink, cartridges and aftercare you burn through daily. No pitch, just: if your supplier ever ghosts you mid-session, reply 'catalog' and I'll send our artist price list. Glad you're here ✌️",
    "Noticed you hanging out on our page — appreciate you 🙏 Your work's got a point of view, so I figured you'd care about supply that just shows up on time. I'm with InkFlow (wholesale ink + needles + aftercare). Whenever you want a backup source that doesn't vanish, say the word and I'll shoot over the list. Zero pressure 👍",
    "Saw you liked our stuff — thank you, genuinely. Around tattoo studios I keep hearing 'I just want my supplier to not disappear on me' — kind of our whole thing at InkFlow (ink, carts, aftercare, wholesale). If you ever want to compare or grab a sample kit, reply and I'll send it. Happy to have you around ✌️"
  ],
  es: [
    "¡Hola! Gracias por el cariño a nuestra última pieza 🙌 Significa mucho viniendo de alguien con tu ojo. Soy parte de InkFlow — somos el proveedor mayorista de la tinta, los cartuchos y el aftercare que usas a diario. Sin pitch: si tu proveedor alguna vez te deja tirado a mitad de sesión, responde 'catálogo' y te mando nuestra lista de precios para artistas. ¡Qué bueno tenerte por aquí! ✌️",
    "Te vi por nuestra página — te agradezco 🙏 Tu trabajo tiene una voz propia, así que supuse que te importa un proveedor que simplemente llega a tiempo. Estoy con InkFlow (tinta, agujas y aftercare al por mayor). Cuando quieras una fuente de respaldo que no desaparezca, dímelo y te paso la lista. Cero presión 👍",
    "Vi que te gustó lo nuestro — gracias, de verdad. En los estudios de tatuaje siempre escucho 'solo quiero un proveedor que no me abandona' — básicamente eso somos en InkFlow (tinta, cartuchos, aftercare, al por mayor). Si alguna vez quieres comparar o pedir un kit de muestra, respóndeme y te lo mando. Me alegra tenerte por acá ✌️"
  ]
};
let AUDIENCE_DM_SCRIPTS: Record<string, string[]> = AUDIENCE_DM_SCRIPTS_DEFAULT;
try {
  if (process.env.AUDIENCE_DM_SCRIPTS_JSON) {
    const parsed = JSON.parse(process.env.AUDIENCE_DM_SCRIPTS_JSON);
    if (Array.isArray(parsed)) AUDIENCE_DM_SCRIPTS = { en: parsed, es: AUDIENCE_DM_SCRIPTS_DEFAULT.es };
    else if (parsed && typeof parsed === 'object') AUDIENCE_DM_SCRIPTS = parsed as Record<string, string[]>;
  }
} catch {}
if (!AUDIENCE_DM_SCRIPTS || !AUDIENCE_DM_SCRIPTS.en || !AUDIENCE_DM_SCRIPTS.en.length) {
  AUDIENCE_DM_SCRIPTS = AUDIENCE_DM_SCRIPTS_DEFAULT;
}
const hashStr = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const pickFromPool = (pool: string[], key: string) => pool[hashStr(key || 'anon') % pool.length];
// 暖受众 DM 按语言选池（es/en；其他语言 fallback en）。复用 detectLangForHandle 检测对方主页语言。
const getAudienceDmScript = (handle: string, lang: string): string => {
  const pool = (AUDIENCE_DM_SCRIPTS[lang] || AUDIENCE_DM_SCRIPTS.en || AUDIENCE_DM_SCRIPTS_DEFAULT.en);
  return pickFromPool(pool, handle);
};
// 本地化优先层（2026-08-07）：基于 WebSearch 调研的本地商务话术，含本地痛点钩子
// （EU REACH 墨水禁令 / 日本先信任后生意）。无本地化版的语言 fallback 到翻译版。
// 完整档案见 D:\harvests\_tools\localized-dm-playbook.md
const LOCALIZED_DM_BY_LANG: Record<string, string[]> = {
  nl: [
    "Hoi — ik volg je werk al even, die recente pieces zijn echt strak. Ik zit bij InkFlow, groothandel in tattoobenenodigdheden (inkt, cartridges, aftercare). Ik weet dat de EU-inktverordening (REACH) veel studio's onder druk zet — wij leveren alleen REACH-conforme kleuren met volledige veiligheidsbladen. Wil je een sample-kit of de prijslijst vergelijken? Stuur gerust een berichtje, totaal zonder verplichting 🙌",
    "Hoi! Je lijnwerk is proper. Korte vraag: ik help studio's bevoorraad via InkFlow — groothandel inkt + naalden + aftercare, alles REACH-conform. Mocht je ooit een betrouwbare backup-bron nodig hebben, antwoord dan gewoon 'catalogus' en ik stuur je de lijst. Geen druk 👍"
  ],
  fr: [
    "Salut — je suis ton travail depuis un moment, tes dernières pièces sont vraiment propres. Je suis chez InkFlow, fournisseur en gros pour studios de tatouage (encre, cartouches, aftercare). Je sais que la réglementation européenne (REACH) met beaucoup de studios sous pression — nous ne fournissons que des encres conformes, avec fiches de sécurité complètes. Si tu veux comparer les prix ou tester un kit d'échantillons, écris-moi, sans aucun engagement 🙌",
    "Salut ! Ton trait est propre. Petite question : j'aide les studios à rester approvisionnés via InkFlow (encre + aiguilles + aftercare en gros, tout conforme REACH). Si tu cherches une source fiable, réponds 'catalogue' et je t'envoie la liste. Zéro pression 👍"
  ],
  de: [
    "Hey — ich schaue mir deine Arbeiten schon eine Weile an, die neueren Stücke sind richtig stark. Ich bin bei InkFlow, Großhandel für Tattoo-Bedarf (Farben, Cartridges, Aftercare). Ich weiß, dass die EU-Farbenverordnung (REACH) viele Studios unter Druck setzt — wir führen nur konforme Farben mit vollständigen Sicherheitsdatenblättern. Falls du Preise vergleichen oder ein Sample-Kit testen willst, schreib mir einfach — ich schicke dir unsere Künstlerkonditionen. Ganz ohne Verpflichtung 🙌",
    "Hi! Deine Linienführung ist sauber. Kurze Frage: ich helfe Studios, über InkFlow zuverlässig versorgt zu bleiben (Großhandel Farben + Nadeln + Aftercare, alles REACH-konform). Falls du eine stabile Backup-Quelle brauchst, antworte einfach 'Katalog' und ich schicke dir die Liste. Null Druck 👍"
  ],
  ja: [
    "こんにちは。突然のご連絡、失礼いたします。作品を拝見し、特にラインの美しさに感銘を受けました。私は InkFlow というタトゥー用品の海外卸売を担当しております（インク・カートリッジ・アフターケア）。日本のタトゥー文化に敬意を持っておりますので、もしよろしければサンプルのご案内をさせてください。お返事いただけましたら幸いです。",
    "こんにちは。お忙しいところ失礼いたします。作品が素晴らしく、ぜひ一度ご挨拶したくご連絡いたしました。InkFlow ではタトゥー用品の卸売（インク・カートリッジ・アフターケア）をしております。ご興味がございましたら、アーティスト価格のリストをお送りいたします。どうぞお気軽にご連絡ください。"
  ]
};
const pickDmScript = (handle: string, lang: string) => {
  const pool = LOCALIZED_DM_BY_LANG[lang] || DM_SCRIPTS_BY_LANG[lang] || DM_SCRIPTS_BY_LANG.en;
  return pickFromPool(pool, handle);
};

// ── 多语言文案池（2026-08-07：按对方国家语言发 DM/评论，真人感翻倍）──
// DM 池：每语言 2 条软性 B2B 供货开场白；评论池：每语言 2 条真诚作品赞美（无推广）；
// opener 池：检测到对方回赞时 DM 的个性化开头。en 引用默认池（可被 env 覆盖）。
const DM_SCRIPTS_BY_LANG: Record<string, string[]> = {
  en: BOT_DM_SCRIPTS,
  de: [
    "Hey — ich hab mir deine Arbeiten angeschaut, die Lines und das Shading sind echt sauber. Ich mache InkFlow (Großhandel für Tattoo-Bedarf: Farben, Cartridges, Aftercare). Falls du mal ein Sample-Kit testen oder Preise vergleichen willst, schreib mir einfach — ich besorge dir Künstlerkonditionen 🙌",
    "Deine Stücke sind stark. Ich versorge Tattoo-Studios über InkFlow mit Großhandels-Bedarf (Farben, Nadeln, Aftercare) — zuverlässige Lieferungen und Künstlerpreise. Kein Druck, aber falls du eine solide Backup-Quelle brauchst, sag einfach Bescheid 👍"
  ],
  fr: [
    "Salut — j'ai regardé ton travail, tes traits et ton ombrage sont vraiment propres. Je suis chez InkFlow (fournitures de tatouage en gros : encre, cartouches, aftercare). Si tu veux tester un kit d'échantillons ou comparer les prix, réponds-moi — je m'occupe de te donner des tarifs artistes 🙌",
    "Tes pièces sont top. J'approvisionne les studios via InkFlow (encre + cartouches + aftercare, en gros) — restocks fiables et tarifs artistes. Sans pression, mais si une source d'approvisionnement solide t'intéresse, fais-moi signe 👍"
  ],
  it: [
    "Ciao — ho visto i tuoi lavori, linee e ombreggiature davvero pulite. Lavoro con InkFlow (forniture per tatuatori all'ingrosso: inchiostri, cartucce, aftercare). Se vuoi provare un kit campione o confrontare i prezzi, scrivimi — ti faccio avere prezzi da artista 🙌",
    "I tuoi pezzi sono forti. Fornisco studi di tatuaggio con InkFlow (inchiostri + cartucce + aftercare, all'ingrosso) — rifornimenti affidabili e prezzi da artista. Nessuna pressione, ma se ti serve una fonte solida, fammi sapere 👍"
  ],
  es: [
    "Hola — estuve viendo tu trabajo, el trazo y el sombreado están muy limpios. Trabajo con InkFlow (material para tatuadores al por mayor: tinta, cartuchos, aftercare). Si quieres probar un kit de muestra o comparar precios, escríbeme — te consigo tarifa de artista 🙌",
    "Tus piezas están brutales. Suministro a estudios con InkFlow (tinta + cartuchos + aftercare, al por mayor) — reposiciones fiables y precio de artista. Sin presión, pero si necesitas una fuente sólida, dímelo 👍"
  ],
  pt: [
    "Oi — vi seu trabalho, o traço e o sombreamento são muito limpos. Sou da InkFlow (materiais para tatuagem no atacado: tinta, cartuchos, aftercare). Se quiser testar um kit de amostra ou comparar preços, me chama — consigo preço de artista pra você 🙌",
    "Suas peças são demais. Forneço estúdios com a InkFlow (tinta + cartuchos + aftercare, atacado) — reposição confiável e preço de artista. Sem pressão, mas se precisar de uma fonte sólida, é só falar 👍"
  ],
  nl: [
    "Hoi — ik heb je werk bekeken, de lijnen en het shading zijn echt strak. Ik werk bij InkFlow (groothandel in tattoobenenodigdheden: inkt, cartridges, aftercare). Wil je een sample-kit testen of prijzen vergelijken? Stuur me gerust een berichtje — ik regel artiestenprijzen voor je 🙌",
    "Je stukken zijn top. Ik bevoorraad tattoo-studio's via InkFlow (inkt + cartridges + aftercare, groothandel) — betrouwbare aanvulling en artiestenprijzen. Geen druk, maar mocht je een solide backup-bron nodig hebben, laat het me weten 👍"
  ],
  pl: [
    "Cześć — oglądałem twoje prace, kreska i cieniowanie są naprawdę czyste. Pracuję z InkFlow (hurtownia artykułów do tatuażu: tusze, kartridże, aftercare). Jeśli chcesz przetestować zestaw próbny albo porównać ceny, napisz — załatwię Ci ceny artystyczne 🙌",
    "Twoje prace są świetne. Zaopatruję studia przez InkFlow (tusze + kartridże + aftercare, hurtowo) — pewne dostawy i ceny artystyczne. Bez presji, ale jeśli potrzebujesz solidnego źródła, daj znać 👍"
  ],
  tr: [
    "Selam — çalışmalarına baktım, çizgiler ve gölgeleme gerçekten temiz. InkFlow'dayım (dövme malzemeleri toptan: mürekkep, kartuş, aftercare). Örnek kit denemek ya da fiyat karşılaştırmak istersen yaz — sana sanatçı fiyatı ayarlarım 🙌",
    "Parçaların harika. Stüdyolara InkFlow ile toptan malzeme sağlıyorum (mürekkep + kartuş + aftercare) — güvenilir stok ve sanatçı fiyatı. Baskı yok, ama sağlam bir tedarik kaynağı ararsan haber ver 👍"
  ],
  cs: [
    "Ahoj — koukal jsem na tvoje práce, linky i stínování jsou fakt čisté. Jsem z InkFlow (velkoobchod s tatérským materiálem: barvy, cartridge, aftercare). Jestli chceš vyzkoušet vzorkový kit nebo porovnat ceny, napiš — zařídím ti umělecké ceny 🙌",
    "Tvoje kousky jsou super. Zásobuji studia přes InkFlow (barvy + cartridge + aftercare, velkoobchod) — spolehlivé doplňování a umělecké ceny. Žádný tlak, ale kdybys potřeboval solidní zdroj, dej vědět 👍"
  ],
  ja: [
    "こんにちは。作品を拝見しました。ラインとシェーディングが本当にきれいです。InkFlow（タトゥー用品卸売：インク・カートリッジ・アフターケア）をやっています。サンプルキットを試したい、価格を比較したい、という時は気軽にメッセージください。アーティスト価格でご案内します🙌",
    "作品がすごくいいですね。InkFlowでスタジオ向けにタトゥー用品（インク＋カートリッジ＋アフターケア）を卸しています。安定した補充とアーティスト価格で。プレッシャーはありませんが、頼れる仕入れ先が欲しい時は声をかけてください👍"
  ],
  ko: [
    "안녕하세요. 작품을 봤는데 라인과 셰이딩이 정말 깔끔하네요. InkFlow(문신 용품 도매: 잉크, 카트리지, 애프터케어)를 운영하고 있습니다. 샘플 키트를 테스트하거나 가격을 비교하고 싶으시면 편하게 연락 주세요. 아티스트 가격으로 도와드릴게요 🙌",
    "작품이 정말 멋집니다. InkFlow로 스튜디오에 문신 용품(잉크+카트리지+애프터케어)을 도매 공급하고 있어요. 안정적인 보충과 아티스트 가격으로요. 부담 없이, 믿을 만한 공급처가 필요하시면 말씀해 주세요 👍"
  ],
  zh: [
    "你好，看了你的作品，线条和阴影处理得很干净。我在做 InkFlow（纹身用品批发：色料、针头、术后护理）。如果想试试样品套装或对比价格，随时回复我，给你艺术家价格 🙌",
    "你的作品很棒。我通过 InkFlow 给工作室供货（色料+针头+术后护理，批发）。补货稳定、艺术家价格。没有压力，但如果你需要可靠的货源，说一声 👍"
  ],
  ru: [
    "Привет — смотрел твои работы, линии и штриховка реально чистые. Я в InkFlow (оптом материалы для тату: чернила, картриджи, афтеркейр). Если хочешь попробовать пробный набор или сравнить цены — напиши, сделаю тебе цены для мастеров 🙌",
    "Твои работы топ. Поставляю студиям через InkFlow (чернила + картриджи + афтеркейр, опт) — стабильные поставки и цены для мастеров. Без давления, но если нужен надёжный источник — дай знать 👍"
  ],
  sv: [
    "Hej — jag har tittat på dina jobb, linjerna och skuggningen är riktigt rena. Jag jobbar med InkFlow (grossist för tatueringsmaterial: bläck, cartridges, aftercare). Om du vill testa ett provkit eller jämföra priser — skriv bara, jag fixar artistpriser åt dig 🙌",
    "Dina grejer är grymma. Jag förser studior via InkFlow (bläck + cartridges + aftercare, grossist) — pålitliga leveranser och artistpriser. Ingen press, men om du behöver en stabil backup-källa, hör av dig 👍"
  ]
};

// 软性 rapport 评论池（真诚赞美同行作品，绝不带任何推广/链接）
// ⚠️ 必须在 RAPPORT_COMMENTS_BY_LANG 之前定义，否则第237行引用会触发 TDZ ReferenceError 导致进程启动即崩溃
const BOT_RAPPORT_COMMENTS_DEFAULT = [
  "clean linework, love it 🔥",
  "this shading is so smooth",
  "your style is unique — been enjoying your posts",
  "that piece is sick 💯",
  "mad respect for the detail here",
  "how many sessions did this take you? been loving your work",
  "do you design these yourself? curious",
];
let BOT_RAPPORT_COMMENTS: string[] = BOT_RAPPORT_COMMENTS_DEFAULT;
try { if (process.env.BOT_RAPPORT_COMMENTS_JSON) BOT_RAPPORT_COMMENTS = JSON.parse(process.env.BOT_RAPPORT_COMMENTS_JSON); } catch {}
if (!Array.isArray(BOT_RAPPORT_COMMENTS) || !BOT_RAPPORT_COMMENTS.length) BOT_RAPPORT_COMMENTS = BOT_RAPPORT_COMMENTS_DEFAULT;

const RAPPORT_COMMENTS_BY_LANG: Record<string, string[]> = {
  en: BOT_RAPPORT_COMMENTS,
  de: ["saubere Linienführung, gefällt mir 🔥", "dieses Shading ist so weich"],
  fr: ["traits bien propres, j'adore 🔥", "ce dégradé est super doux"],
  it: ["linee pulite, mi piace 🔥", "questo sfumato è morbidissimo"],
  es: ["trazo limpio, me encanta 🔥", "este sombreado es muy suave"],
  pt: ["traço limpo, amei 🔥", "esse sombreamento é muito suave"],
  nl: ["strakke lijnen, top 🔥", "die shading is echt zacht"],
  pl: ["czysta kreska, podoba mi się 🔥", "to cieniowanie jest takie miękkie"],
  tr: ["temiz çizgiler, bayıldım 🔥", "bu gölgeleme çok yumuşak"],
  cs: ["čisté linky, líbí se mi 🔥", "to stínování je tak jemné"],
  ja: ["ラインがきれいですね 🔥", "このシェーディング、すごく柔らかい"],
  ko: ["라인 깔끔하네요 🔥", "셰이딩이 정말 부드러워요"],
  zh: ["线条很干净，喜欢 🔥", "这个阴影处理得好柔"],
  ru: ["чистые линии, зашло 🔥", "эта штриховка такая мягкая"],
  sv: ["rena linjer, gillar det 🔥", "det här skuggningen är så mjuk"]
};
const LIKED_US_OPENERS_BY_LANG: Record<string, string> = {
  en: 'Saw you liked one of my pieces — appreciate it! ',
  de: 'Hab gesehen, dass dir ein Beitrag von mir gefallen hat — danke! ',
  fr: "J'ai vu que tu as aimé une de mes pièces — merci ! ",
  it: 'Ho visto che ti è piaciuto un mio lavoro — grazie! ',
  es: 'Vi que te gustó una de mis piezas — ¡gracias! ',
  pt: 'Vi que você curtiu uma das minhas peças — obrigado! ',
  nl: 'Zag dat je een van mijn stukken leuk vond — bedankt! ',
  pl: 'Widziałem, że spodobał ci się mój post — dzięki! ',
  tr: 'Gönderimi beğendiğini gördüm — teşekkürler! ',
  cs: 'Viděl jsem, že se ti líbil můj příspěvek — díky! ',
  ja: '私の作品にいいねをしてくれたのを見ました — ありがとうございます！ ',
  ko: '제 작품에 좋아요를 눌러주셨네요 — 감사합니다! ',
  zh: '看到你赞了我的作品 — 谢谢！ ',
  ru: 'Увидел, что тебе понравился мой пост — спасибо! ',
  sv: 'Såg att du gillade en av mina grejer — tack! '
};

// ── 国家/城市 → 语言 推断（2026-08-07）──
// 优先用任务 payload 的 country/city；没有则从 handle 域名 TLD 推断（如 tattooshops.be → BE）。
const COUNTRY_TO_LANG: Record<string, string> = {
  US: 'en', GB: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en',
  DE: 'de', AT: 'de', CH: 'de',
  FR: 'fr', MC: 'fr',
  IT: 'it', SM: 'it',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', UY: 'es',
  PT: 'pt', BR: 'pt', AO: 'pt', MZ: 'pt',
  NL: 'nl',
  PL: 'pl', CZ: 'cs', SK: 'sk',
  TR: 'tr',
  JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh',
  RU: 'ru', UA: 'uk',
  SE: 'sv', NO: 'no', DK: 'da', FI: 'fi',
  GR: 'el', HU: 'hu', RO: 'ro'
};
// 比利时按城市分语言：瓦隆区(法) vs 佛兰德斯区(荷)。tattooshops.be 默认按 nl（佛兰德斯为主）。
const BE_FR_CITIES = ['liège', 'liege', 'charleroi', 'namur', 'mons', 'tournai', 'bastogne', 'bruxelles', 'brussels', 'wavre', 'nivelles', 'la louvière', 'la louviere', 'verviers'];
const TLD_TO_COUNTRY: Record<string, string> = {
  be: 'BE', de: 'DE', fr: 'FR', it: 'IT', es: 'ES', pt: 'PT', nl: 'NL', pl: 'PL',
  tr: 'TR', cz: 'CZ', jp: 'JP', kr: 'KR', cn: 'CN', ru: 'RU', uk: 'GB', ca: 'CA',
  au: 'AU', ch: 'CH', at: 'AT', se: 'SE', no: 'NO', dk: 'DK', fi: 'FI', gr: 'GR', br: 'BR', mx: 'MX'
};
const inferCountryFromHandle = (handle: string): string => {
  const m = (handle || '').toLowerCase().match(/\.([a-z]{2,3})(?:[/?#]|$)/);
  return (m && TLD_TO_COUNTRY[m[1]]) || '';
};
const langFor = (handle: string, country?: string, city?: string, detectedLang?: string): string => {
  // 2026-08-07 用户拍板：对方帖子实际用的语言最准 → detectedLang 优先
  const dl = String(detectedLang || '').trim();
  if (dl) return dl;
  const c = String(country || '').toUpperCase();
  if (c === 'BE') {
    const cc = String(city || '').toLowerCase();
    return BE_FR_CITIES.some((x) => cc.includes(x)) ? 'fr' : 'nl';
  }
  if (COUNTRY_TO_LANG[c]) return COUNTRY_TO_LANG[c];
  const tld = inferCountryFromHandle(handle);
  if (tld === 'BE') return 'nl';
  return (tld && COUNTRY_TO_LANG[tld]) || 'en';
};

// ── 帖子语言检测（2026-08-07 用户拍板：看对方发的帖子语言决定说什么语言）──
// 轻量启发式：先字符级判 CJK/西里尔/希腊，再按特征词判拉丁语系。不依赖大模型。
const LANG_FEATURES: Record<string, string[]> = {
  de: ['und', 'der', 'die', 'das', 'für', 'ich', 'nicht', 'ist', 'mit', 'ein'],
  nl: ['ik', 'het', 'een', 'voor', 'niet', 'geen', 'van', 'met', 'ben', 'zijn'],
  fr: ['le', 'la', 'les', 'vous', 'pour', 'avec', 'une', 'des', 'est', 'nous'],
  es: ['el', 'la', 'los', 'para', 'con', 'que', 'como', 'por', 'una', 'estoy'],
  it: ['il', 'la', 'che', 'per', 'con', 'non', 'sono', 'una', 'questo', 'molto'],
  pt: ['para', 'com', 'que', 'não', 'uma', 'muito', 'tudo', 'vou', 'está'],
  pl: ['nie', 'się', 'jest', 'do', 'co', 'tak', 'ale', 'bardzo', 'moje'],
  tr: ['ve', 'bir', 'için', 'bu', 'ile', 'değil', 'gibi', 'çok', 'daha'],
  sv: ['och', 'att', 'det', 'som', 'för', 'inte', 'med', 'men', 'har'],
  cs: ['pro', 'jsem', 'na', 'se', 'je', 'že', 'mám', 'vše', 'hezké'],
  ru: ['и', 'в', 'не', 'что', 'для', 'это', 'меня', 'очень', 'мои']
};
const detectLangFromText = (text: string): string => {
  const t = String(text || '');
  if (!t.trim()) return '';
  if (/[\u3040-\u30ff]/.test(t)) return 'ja';      // 假名 → 日语
  if (/[\uac00-\ud7af]/.test(t)) return 'ko';      // 谚文 → 韩语
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh';      // 汉字 → 中文
  if (/[\u0400-\u04ff]/.test(t)) return 'ru';      // 西里尔 → 俄语
  if (/[\u0370-\u03ff]/.test(t)) return 'el';      // 希腊字母 → 希腊语
  const lower = ` ${t.toLowerCase()} `;
  let best = ''; let bestScore = 0;
  for (const [lang, feats] of Object.entries(LANG_FEATURES)) {
    let score = 0;
    for (const f of feats) {
      // 词边界匹配（2026-08-07 修复：子串匹配会把英文 latest 里的 est / available 里的 le 误判为法语）
      const re = new RegExp(`(^|[^a-zà-ÿ0-9])${f}(?=[^a-zà-ÿ0-9])`, 'g');
      const m = lower.match(re);
      if (m) score += m.length;
    }
    if (score > bestScore) { bestScore = score; best = lang; }
  }
  return bestScore >= 2 ? best : '';
};
// 每个 handle 只检测一次（内存缓存 + 状态文件 st.detectedLang 持久化）
const langCache: Record<string, string> = {};
// 打开对方主页时抓 bio + 帖子文本判语言。需在 openProfile 导航完成后调用。
const detectLangForHandle = async (handle: string): Promise<string> => {
  if (langCache[handle]) return langCache[handle];
  if (!page) return '';
  try {
    const texts = await page.locator('h1, h2, span[dir="auto"]').evaluateAll((els: any[]) =>
      els.map((e: any) => (e.textContent || '').trim()).filter((x: string) => x.length > 1)
    ).catch(() => []);
    const joined = (texts || []).join(' ').slice(0, 2000);
    const lang = detectLangFromText(joined);
    if (lang) {
      langCache[handle] = lang;
      const st = likeState.follows?.byHandle?.[handle] as any;
      if (st) { st.detectedLang = lang; saveLikeState(likeState); }
    }
    return lang;
  } catch { return ''; }
};
// 任务/回关号的位置缓存：handle -> { country, city }。任务 payload 有就用，否则 TLD 推断。
const countryCache: Record<string, { country?: string; city?: string }> = {};

// ═══════════════════════════════════════════════════════════════════
// 产品/套餐库（2026-08-07 用户拍板：老板定产品 → AI 本地化 → bot 按客户组装）
// 用法：在 OFFERS 里加一条，label 是展示名，markets 限定国家（空=全部），
// pitch/cta 是每语言的本地化话术。active=false 的 offer 不参与发送（示例默认关）。
// 没有对应语言的 offer 会 fallback 到 en；OFFERS 无可用项时走原固定文案池。
// ⚠️ 钩子匹配铁律（2026-08-07 用户纠偏）：话术里的每个"本地痛点钩子"（如 REACH 合规）
//    必须是我们产品【真实解决】的痛点，且已核实产品能力后才可写进 DM。
//    未确认产品能力前，禁止使用任何合规/资质类强声明钩子。禁止机翻直发。
// ═══════════════════════════════════════════════════════════════════
const OFFERS: Array<{
  id: string;
  label: string;
  active?: boolean;
  markets?: string[];
  pitch: Record<string, string>;
  cta: Record<string, string>;
  // 促销钩子（2026-08-09 用户拍板：PEACH 针 launch 促销）。独立字段，仅对提供了翻译的语言附加，
  // 未翻译的语言不附加（避免机翻直发 + 避免英文污染非英语 DM）。
  promo?: Record<string, string>;
}> = [
  // ── 主推：针 + 转印纸 常备套装（2026-08-07 用户确认：墨水暂不推，主推 needles + stencil paper）
  // 钩子策略：🟡 中钩子——「灭菌 + 独立无菌包装」(2026-08-07 用户确认真实能力) + 每周必补耗材 + 艺术家价格；
  // 未确认的强声明(认证编号/价格对比/时效)仍未写入，等确认后再升级 🔴。
  {
    id: 'needles_paper_kit',
    label: '针 + 转印纸 常备套装',
    active: true,
    pitch: {
      en: 'For a studio, needles and stencil paper are the things you re-order every week. Our needles are sterile, individually sealed — plus a solid range of transfer paper, all at artist pricing, so you can restock in one place without hunting around.',
      de: 'Für Studios sind Nadeln und Stencil-Papier die Verbrauchsmaterialien, die jede Woche nachbestellt werden. Unsere Nadeln sind steril und einzeln versiegelt — dazu ein breites Sortiment Transfer-Papier, alles zu Künstlerkonditionen. So deckst du dich an einem Ort ein, ohne lange zu suchen.',
      nl: 'Voor studio\'s zijn naalden en stencilpapier de verbruiksartikelen die elke week worden bijbesteld. Onze naalden zijn steriel en individueel verzegeld — plus een ruim assortiment transferpapier, alles tegen artiestenprijzen. Zo bevoorraad je op één plek, zonder lang te zoeken.',
      fr: 'Pour un studio, les aiguilles et le papier stencil sont les consommables réapprovisionnés chaque semaine. Nos aiguilles sont stériles, scellées individuellement — avec une bonne gamme de papier transfert, le tout à tarif artiste. Pour te réapprovisionner au même endroit, sans chercher partout.',
      ja: 'スタジオにとって、ニードルとステンシルペーパーは毎週補充が必要な消耗品です。当社のニードルは滅菌済み・個別密封包装。転写紙も豊富に取り揃え、すべてアーティスト価格。まとめて補充でき、探し回る手間がありません。',
      es: 'Para un estudio, las agujas y el papel stencil son lo que se repone cada semana. Nuestras agujas son estériles, selladas individualmente — con una buena gama de papel de transferencia, todo a precio de artista. Para reponer en un solo sitio, sin andar buscando.',
      it: 'Per uno studio, aghi e carta stencil sono i consumabili da riordinare ogni settimana. I nostri aghi sono sterili, sigillati singolarmente — con una buona gamma di carta transfer, tutto a prezzo da artista. Per rifornirti in un unico posto, senza cercare in giro.',
      pt: 'Para um estúdio, agulhas e papel stencil são o que se repõe toda semana. Nossas agulhas são estéreis, embaladas individualmente — com uma boa linha de papel de transferência, tudo a preço de artista. Para repor em um lugar só, sem ficar procurando.',
      pl: 'Dla studia igły i papier stencil to rzeczy zamawiane co tydzień. Nasze igły są sterylne, pakowane pojedynczo — z szerokim wyborem papieru transferowego, wszystko w cenach artystycznych. Zaopatrzysz się w jednym miejscu, bez szukania.',
      tr: 'Bir stüdyo için iğneler ve stencil kağıdı her hafta yenilenen malzemelerdir. İğnelerimiz steril ve tek tek paketlenmiştir — geniş transfer kağıdı yelpazemiz de var, hepsi sanatçı fiyatıyla. Tek yerden stok yaparsınız, aramanıza gerek kalmaz.',
      cs: 'Pro studio jsou jehly a stencil papír věci, které se objednávají každý týden. Naše jehly jsou sterilní, jednotlivě balené — se širokou nabídkou transferového papíru, vše za umělecké ceny. Doplníš vše na jednom místě, bez shánění.',
      ru: 'Для студии иглы и стенсиль-бумага — это то, что заказывают каждую неделю. Наши иглы стерильные, в индивидуальной упаковке — плюс широкий выбор трансферной бумаги, всё по ценам для мастеров. Пополняй запас в одном месте, без поисков.',
      sv: 'För en studio är nålar och stencilpapper det som beställs varje vecka. Våra nålar är sterila och individuellt förpackade — med ett brett sortiment transferpapper, allt till artistpriser. Fyll på på ett ställe, utan att leta.'
    },
    cta: {
      en: 'Want our needle + transfer paper price list? Just reply "stock" and I\'ll send it over — no pressure at all.',
      de: 'Lust auf unsere Nadel- und Papier-Preisliste? Antworte einfach "Stock" und ich schicke sie dir — ganz ohne Druck.',
      nl: 'Zin in onze prijslijst voor naalden en papier? Antwoord gewoon "stock" en ik stuur ze door — totaal zonder druk.',
      fr: 'Tu veux notre grille de prix aiguilles + papier ? Réponds simplement "stock" et je te l\'envoie — sans aucune pression.',
      ja: 'ニードルとペーパーの価格表をご希望でしたら、「stock」とご返信ください。お送りいたします。どうぞご負担なく。',
      es: '¿Quieres nuestra lista de precios de agujas + papel? Responde "stock" y te la envío — sin presión.',
      it: 'Vuoi la nostra lista prezzi aghi + carta? Rispondi "stock" e te la mando — nessuna pressione.',
      pt: 'Quer nossa lista de preços de agulhas + papel? Responda "stock" e eu te envio — sem pressão.',
      pl: 'Chcesz naszą listę cen igieł + papieru? Odpowiedz "stock", a wyślę ją — bez presji.',
      tr: 'İğne + kağıt fiyat listemizi ister misiniz? "stock" yazın, göndereyim — hiçbir baskı yok.',
      cs: 'Chceš naši ceník jehel + papíru? Odepiš "stock" a pošlu ti ho — bez tlaku.',
      ru: 'Хотите наш прайс на иглы + бумагу? Напишите "stock" — и я пришлю. Без давления.',
      sv: 'Vill du ha vår prislista på nålar + papper? Svara "stock" så skickar jag den — ingen press.'
    },
    // ── PEACH 针 launch 促销（2026-08-09 用户拍板，真实条款，本人审核）──
    // 新客专享：买 2 盒送 1 盒（首单·新客户，不与其他优惠叠加）；量贩档（所有客户）：买 10 盒送 2 盒，适用全部 PEACH 型号。
    // 仅对以下已翻译语言附加；其余语言（pl/tr/cs/ru 等）不附加，避免机翻/英文污染。
    promo: {
      en: "Quick note — on PEACH needles (CON / COG / AES / PRO) we're running a launch deal: new studios get 3 boxes for the price of 2 (one-time, new artists only), and any order of 10 boxes ships 12. Reply 'deal' and I'll send the exact terms — no pressure.",
      de: "Kurzer Hinweis — bei PEACH-Nadeln (CON/COG/AES/PRO) läuft ein Einführungsangebot: neue Studios bekommen 3 Boxen zum Preis von 2 (einmalig, nur neue Künstler), und jede Bestellung ab 10 Boxen gibt 12. Antworte 'deal', dann schicke ich die genauen Konditionen — ganz ohne Druck.",
      nl: "Korte note — op PEACH-naalden (CON/COG/AES/PRO) draait een introductieactie: nieuwe studio's krijgen 3 dozen voor de prijs van 2 (eenmalig, alleen nieuwe artiesten), en elke bestelling vanaf 10 dozen levert 12. Antwoord 'deal' en ik stuur je de exacte voorwaarden — totaal zonder druk.",
      fr: "Petite note — sur les aiguilles PEACH (CON/COG/AES/PRO) on lance une offre: les nouveaux studios reçoivent 3 boîtes pour le prix de 2 (une fois, nouveaux artistes uniquement), et toute commande de 10 boîtes en donne 12. Réponds 'deal' et je t'envoie les conditions exactes — sans pression.",
      es: "Nota rápida — en agujas PEACH (CON/COG/AES/PRO) tenemos una oferta de lanzamiento: los nuevos estudios reciben 3 cajas por el precio de 2 (una vez, solo nuevos artistas), y cualquier pedido de 10 cajas envía 12. Responde 'deal' y te mando las condiciones exactas — sin presión.",
      it: "Nota rapida — sulle ago PEACH (CON/COG/AES/PRO) c'è un'offerta di lancio: i nuovi studi ricevono 3 scatole al prezzo di 2 (una tantum, solo nuovi artisti), e ogni ordine di 10 scatole ne spedisce 12. Rispondi 'deal' e ti mando le condizioni esatte — senza pressione.",
      pt: "Nota rápida — nas agulhas PEACH (CON/COG/AES/PRO) temos uma oferta de lançamento: novos estúdios recebem 3 caixas pelo preço de 2 (uma vez, só novos artistas), e qualquer pedido de 10 caixas envia 12. Responda 'deal' e eu mando os termos exatos — sem pressão.",
      ja: "お知らせ — PEACH ニードル（CON/COG/AES/PRO）でスタートキャンペーン中です。新規スタジオ様は2個買うと1個プレゼント（初回・新規限定）、10個のご注文で12個お届けします。「deal」とご返信いただければ詳しい条件をお送りします。どうぞご負担なく。"
    }
  }
];

// 🔴 下单目的地（2026-08-09 用户指定：www.peachtattoosupplies.com）
// 所有 DM 末尾统一附上「在此下单」引导；未翻译语言 fallback 到英文句。
const ORDER_URL = 'https://www.peachtattoosupplies.com';
const ORDER_LINES: Record<string, string> = {
  en: `Order anytime at ${ORDER_URL}`,
  de: `Bestell jederzeit auf ${ORDER_URL}`,
  nl: `Bestel wanneer je wilt op ${ORDER_URL}`,
  fr: `Commandez à tout moment sur ${ORDER_URL}`,
  ja: `ご注文はいつでも ${ORDER_URL} から`,
  es: `Pide cuando quieras en ${ORDER_URL}`,
  it: `Ordina quando vuoi su ${ORDER_URL}`,
  pt: `Peça quando quiser em ${ORDER_URL}`,
  pl: `Zamów kiedy chcesz na ${ORDER_URL}`,
  tr: `İstediğin zaman sipariş ver: ${ORDER_URL}`,
  cs: `Objednejte kdykoli na ${ORDER_URL}`,
  ru: `Заказывайте в любое время на ${ORDER_URL}`,
  sv: `Beställ när du vill på ${ORDER_URL}`,
};

// 按客户情况组装 DM：个性化钩子（回赞）→ 产品 pitch（按市场+语言）→ CTA（同语言）。
// 仅使用 active 的 offer（未核实产品能力前示例保持关闭）；无可用 offer 时 fallback 到原固定文案池。
const buildDmScript = (handle: string, lang: string, st: any): string => {
  const country = String(st?.country || countryCache[handle]?.country || '').toUpperCase();
  const offer = OFFERS.find((o) => {
    const activeOk = o.active !== false;
    const langOk = !!o.pitch[lang] && !!o.cta[lang];
    const marketOk = !o.markets || !o.markets.length || o.markets.includes(country);
    return activeOk && langOk && marketOk;
  });
  if (offer) {
    const opener = st?.likedUsDetected ? (LIKED_US_OPENERS_BY_LANG[lang] || LIKED_US_OPENERS_BY_LANG.en) : '';
    const pitch = (offer.pitch[lang] || offer.pitch.en || '').trim();
    // 促销钩子：仅当该语言提供了翻译才附加（promo[lang] 存在），未翻译语言不附加，避免机翻/英文污染。
    const promo = offer.promo?.[lang];
    const cta = (offer.cta[lang] || offer.cta.en || '').trim();
    // 🔴 末尾统一附「在此下单」目的地（2026-08-09 用户指定 peachtattoosupplies.com）
    const orderLine = ORDER_LINES[lang] || ORDER_LINES.en;
    return [opener, pitch, promo, cta, orderLine].filter(Boolean).join(' ');
  }
  const baseScript = pickDmScript(handle, lang);
  const orderLine = ORDER_LINES[lang] || ORDER_LINES.en;
  return st?.likedUsDetected ? `${LIKED_US_OPENERS_BY_LANG[lang] || LIKED_US_OPENERS_BY_LANG.en}${baseScript} ${orderLine}` : `${baseScript} ${orderLine}`;
};


// ── 回关 rapport 阶梯（先建立熟悉感，再软性 DM，绝不硬推广）──
// 流程：detect → 点赞 3 篇帖子(每天最多 1 篇，横跨 3 天) → 隔 ~18h 后真诚评论 1 条 → 再赞对方 1 条评论
// → 预热窗口后发软性供货 DM。对方先被"同行持续欣赏"，再收到一条像朋友介绍的供货信息，自然转化而非被推销。
const BOT_RAPPORT_DAILY_MAX = Math.max(0, Number(process.env.BOT_RAPPORT_DAILY_MAX || 15));
const RAPPORT_LIKE_TARGET = Math.max(2, Number(process.env.RAPPORT_LIKE_TARGET || 3));
const RAPPORT_LIKE_GAP_HOURS = Math.max(1, Number(process.env.RAPPORT_LIKE_GAP_HOURS || 24));
const RAPPORT_COMMENT_AFTER_HOURS = Math.max(1, Number(process.env.RAPPORT_COMMENT_AFTER_HOURS || 18));
const pickRapportComment = (handle: string, lang: string) => pickFromPool(RAPPORT_COMMENTS_BY_LANG[lang] || RAPPORT_COMMENTS_BY_LANG.en, handle);

// ── AI Core (sales_chats D1 sync for triangulation) ───────────────────
// Bot pushes DM conversations into the sales_chats + chat_messages tables
// so the triangulation engine can detect demand signals across sources.
const AI_CORE_BASE = (process.env.AI_CORE_BASE || 'https://harvests-ai-core-api.inkflowapp.workers.dev').replace(/\/+$/, '');
const AI_CORE_AUTH = process.env.AI_CORE_AUTH || 'Bearer dev';
const AI_CORE_TENANT = process.env.AI_CORE_TENANT || 'sales';

const POSITIVE_KEYWORDS = [
  'tattoo', 'tattooing', 'tattoo studio', 'tattoo shop', 'tattoo parlor', 'tattoo parlour',
  'ink', 'inked', 'blackwork', 'fineline', 'fine line', 'realism', 'traditional', 'neo traditional',
  'irezumi', 'flash', 'custom tattoo', 'coverup', 'cover up', 'piercing', 'body piercing', 'body art'
];
const NEGATIVE_KEYWORDS = [
  'optical', 'vision', 'eyewear', 'eye exam',
  'dental', 'dentist', 'orthodontic', 'clinic', 'medical spa',
  'law', 'attorney', 'legal services',
  'real estate', 'mortgage', 'insurance',
  'hvac', 'plumbing', 'electrician', 'roofing',
  'church', 'ministry', 'school', 'academy',
  'bakery', 'cafe', 'coffee', 'restaurant', 'catering'
];
const PROMO_KEYWORDS = [
  'giveaway', 'sale', 'promo', 'promotion', 'discount', 'deal', 'offer'
];
const BUSINESS_CTA_KEYWORDS = [
  'book now', 'book', 'booking', 'appointments', 'appointment', 'dm to book', 'consultation', 'consult'
];
const STYLE_KEYWORDS = [
  'fine line', 'fineline', 'blackwork', 'realism', 'traditional', 'neo traditional',
  'color', 'anime', 'microrealism', 'ornamental', 'japanese', 'irezumi',
  'geometric', 'dotwork', 'watercolor', 'illustrative', 'tribal', 'trash polka',
  'new school', 'american traditional', 'black and grey', 'surrealism',
];

const keywordHits = (text: string, keywords: string[]) => {
  const lower = String(text || '').toLowerCase();
  return keywords.filter((k) => lower.includes(k));
};
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const normalizeForMatch = (text: string) =>
  String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const parseCompactNumber = (text: string) => {
  const cleaned = String(text || '').trim().toLowerCase().replace(/,/g, '');
  const m = cleaned.match(/(\d+(?:\.\d+)?)([km])?/i);
  if (!m) return 0;
  const base = Number(m[1] || 0);
  const unit = String(m[2] || '').toLowerCase();
  if (unit === 'k') return Math.round(base * 1000);
  if (unit === 'm') return Math.round(base * 1000000);
  return Math.round(base);
};

const parseFirstNumberLike = (text: string) => {
  const m = String(text || '').match(/(\d[\d,\.]*\s*[kKmM]?)/);
  return m?.[1] ? parseCompactNumber(m[1]) : 0;
};

const extractPostKey = (urlOrHref: string) => {
  const m = String(urlOrHref || '').match(/\/(?:p|reel)\/([^\/\?\#]+)/i);
  return m?.[1] ? String(m[1]).toLowerCase() : '';
};
const normalizeHandle = (v: string) => String(v || '').replace(/^@/, '').trim().toLowerCase();
const profileHandleFromUrl = (u: string) => {
  try {
    const p = new URL(u).pathname.split('/').filter(Boolean);
    return p[0] ? normalizeHandle(p[0]) : '';
  } catch {
    return '';
  }
};
// 2026-08-07: 统一把任意形态的 handle（裸名 / @前缀 / 完整 IG URL / 带斜杠）收敛成裸 handle，
// 避免 Neon 存的 "https://www.instagram.com/foo" 直接拼进 URL 变成
// instagram.com/https://... 导致导航失败 → 任务 failed。这是"不出现 failed"的关键修复。
const toBareHandle = (v: string): string => {
  let s = String(v || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || s.includes('instagram.com/')) {
    try {
      const u = new URL(s.startsWith('http') ? s : `https://${s}`);
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg) s = seg;
    } catch {
      const m = s.match(/instagram\.com\/([^/?#]+)/i);
      if (m) s = m[1];
    }
  }
  return s.replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
};

let running = true;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
// Cloud behavior log buffer — flushed during heartbeat
const behaviorBuffer: Record<string, any>[] = [];
const FLUSH_AT = 20; // flush every 20 events

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── CDP 预探活（2026-09-17）──────────────────────────────────────────────
// 旧代码直接 connectOverCDP：Chrome 假死（端口通、协议冻结）时它会一直挂到超时，
// 4 次尝试 ≈ 2.5 分钟，日志里只有一句 timeout —— 完全看不出"是 Chrome 那边不行"。
// 现在先用 5 秒的 HTTP 探活给出**明确结论**（浏览器名 + 标签数），失败原因直接进 out 日志。
// 标签数是 IG 页面变慢的前兆指标（browse_like 每开一个帖子页都算一个 target）。
const CDP_CONNECT_TIMEOUT_MS = Math.max(5_000, Number(process.env.BOT_CDP_CONNECT_TIMEOUT_MS || 20_000));
const probeCdpHttp = async (): Promise<{ ok: boolean; reason: string; targets: number }> => {
  const base = BOT_CDP_URL.replace(/\/+$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    const resp = await fetch(`${base}/json/version`, { signal: ctl.signal });
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}`, targets: -1 };
    const ver: any = await resp.json().catch(() => ({}));
    let targets = -1;
    try {
      const list = await fetch(`${base}/json/list`, { signal: ctl.signal });
      if (list.ok) targets = ((await list.json()) as any[]).length;
    } catch {}
    console.log(`[bot-real] cdp-probe OK: ${ver?.Browser || 'unknown'} | open targets=${targets}`);
    return { ok: true, reason: 'ok', targets };
  } catch (e: any) {
    const reason = e?.name === 'AbortError' ? 'timeout_5s（端口通但不响应 → Chrome 假死）' : String(e?.message || e);
    return { ok: false, reason, targets: -1 };
  } finally {
    clearTimeout(timer);
  }
};

// ── CDP 协议探活（2026-09-17 二修）──────────────────────────────────────
// VPS 实测把真因顶到了更深一层：HTTP 探活**通过**（/json/version 与 /json/list 都答），
// 但 connectOverCDP 在 `<ws connected>` 之后 `Timeout 20000ms exceeded`。
// 即：端口通 → WS 握手成功 → **CDP 命令不响应**。这就是 ig-watchdog 8-14 日志里反复出现的
// "CDP protocol FROZEN (fake-dead)"：Chrome 主线程假死，HTTP 端点还在答，协议层已经死。
// 单靠 HTTP 探活永远判不出来，只会在 20s 后抛一句毫无信息量的 timeout。
// 判据直接复用 scripts/cdp-probe.cjs：连 browser 级 WS + 发 Browser.getVersion，5s 无响应即冻结。
const probeCdpProtocol = async (): Promise<{ ok: boolean; reason: string }> => {
  const base = BOT_CDP_URL.replace(/\/+$/, '');
  let wsUrl = '';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4_000);
    const r = await fetch(`${base}/json/version`, { signal: ctl.signal });
    clearTimeout(t);
    wsUrl = String(((await r.json()) as any)?.webSocketDebuggerUrl || '');
  } catch (e: any) {
    return { ok: false, reason: `http_unreachable:${e?.message || e}` };
  }
  if (!wsUrl) return { ok: false, reason: 'no_webSocketDebuggerUrl' };
  const WS = (globalThis as any).WebSocket;
  if (typeof WS !== 'function') return { ok: true, reason: 'ws_probe_skipped' };
  return await new Promise((resolve) => {
    let done = false;
    let ws: any = null;
    const finish = (ok: boolean, reason: string) => {
      if (done) return;
      done = true;
      try { ws?.close?.(); } catch {}
      resolve({ ok, reason });
    };
    const timer = setTimeout(() => finish(false, 'protocol_frozen_5s'), 5_000);
    try { ws = new WS(wsUrl); } catch (e: any) { clearTimeout(timer); return finish(false, `ws_ctor:${e?.message || e}`); }
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); } catch {} };
    ws.onmessage = (m: any) => {
      try {
        const j = JSON.parse(String(m?.data || ''));
        if (j && j.id === 1) { clearTimeout(timer); finish(true, 'ok'); }
      } catch {}
    };
    ws.onerror = () => { clearTimeout(timer); finish(false, 'ws_error'); };
    ws.onclose = () => { clearTimeout(timer); finish(false, 'ws_closed_before_reply'); };
  });
};

// ── CDP 标签清理（2026-09-17 二修）──────────────────────────────────────
// connectOverCDP 会把**每一个** page target 都 attach 一遍；其中只要有一个僵尸 target
// （渲染进程已死、target 仍挂在 /json/list 上），整个 browser 级连接就会卡到超时。
// VPS 重启后 Chrome 一启动就带 6 个标签（profile 自动恢复了上次会话）—— 正是高发条件，
// bot 只需要 1 个 IG 页。这里在连接前用纯 HTTP 的 /json/close/{id} 把多余标签关掉；
// 只关标签、**不杀 Chrome**（9222 那个 Chrome 是三个进程共用的）。
const healCdpTargets = async (): Promise<void> => {
  const base = BOT_CDP_URL.replace(/\/+$/, '');
  // ⚠️ 2026-09-18：这里过去是**裸 fetch**。它正是看门狗的"自救"路径 ——
  //   自救路径自己挂住 = 永远没人来救。所以 CDP 的 HTTP 调用也必须有本地计时。
  const cdpJson = async (url: string, ms = 5_000): Promise<any> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('cdp_http_timeout')), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      return await r.json().catch(() => null);
    } catch { return null; }
    finally { clearTimeout(timer); }
  };
  const cdpClose = async (url: string, ms = 5_000): Promise<boolean> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('cdp_close_timeout')), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      return !!r.ok;
    } catch { return false; }
    finally { clearTimeout(timer); }
  };
  try {
    const list = ((await cdpJson(`${base}/json/list`)) as any[]) || [];
    const pages = list.filter((t) => t?.type === 'page' && t?.id);
    if (pages.length <= 1) return;
    const keep = pages.find((t) => String(t.url || '').includes('instagram.com')) || pages[0];
    const extra = pages.filter((t) => t.id !== keep.id);
    let closed = 0;
    for (const t of extra.slice(0, 12)) {
      try {
        if (await cdpClose(`${base}/json/close/${t.id}`)) closed++;
      } catch {}
    }
    console.log(`[bot-real] cdp-target-heal: ${pages.length} page targets → closed ${closed}, kept "${String(keep.url || '').slice(0, 60)}"`);
  } catch (e: any) {
    console.log(`[bot-real] cdp-target-heal skipped: ${e?.message || e}`);
  }
};

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const hashString = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};
const BOT_BIAS = (hashString(BOT_ID) % 17) / 100; // 0.00 ~ 0.16, stable per bot
const scaleDelay = (v: number) => Math.max(150, Math.floor(v * BOT_SPEED_FACTOR * (1 + BOT_BIAS)));
const jitter = (min: number, max: number) => {
  const base = Math.floor(Math.random() * (max - min + 1)) + min;
  const swing = 1 + ((Math.random() * 2 - 1) * BOT_VARIANCE); // [1-var, 1+var]
  return scaleDelay(base * swing);
};
// Human break: pause for a random period to mimic natural behavior.
let breakUntil = 0;
let lastAccountStage = 'stable';
let lastIndustry: string | undefined = 'tattoo'; // default: tattoo industry

// Rest-time noise sites — fetched from cloud API so frontend can configure.
let NOISE_SITES: string[] = ['https://www.cnn.com', 'https://www.nydailynews.com', 'https://www.youtube.com'];
let NOISE_SITES_CACHED_AT = 0;
const NOISE_SITES_CACHE_TTL = 60 * 60 * 1000; // configuration changes rarely; protect D1 reads

const fetchNoiseSites = async () => {
  if (!API_BASE) return;
  try {
    const resp = await fetch(`${API_BASE}/api/bot/noise-sites?botId=${encodeURIComponent(BOT_ID)}`, {
      headers: buildHeaders(),
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      if (Array.isArray(data?.sites) && data.sites.length > 0) {
        NOISE_SITES = data.sites;
        NOISE_SITES_CACHED_AT = Date.now();
      }
    }
  } catch {}
};

// Refresh noise sites periodically (check cache)
const ensureNoiseSites = async () => {
  if (Date.now() - NOISE_SITES_CACHED_AT > NOISE_SITES_CACHE_TTL) {
    await fetchNoiseSites();
  }
};

const humanBreak = async () => {
  await ensureNoiseSites(); // keep noise sites fresh
  const now = Date.now();
  if (now < breakUntil) {
    const remaining = breakUntil - now;
    console.log(`[bot-real] human break: ${Math.round(remaining / 1000)}s remaining (stage=${lastAccountStage})...`);
    // Navigate the existing IG tab to a noise site during rest, then back to IG.
    if (page && remaining > 30_000) {
      const prevUrl = IG_BASE;
      const noiseUrl = NOISE_SITES[Math.floor(Math.random() * NOISE_SITES.length)];
      try {
        await page.goto(noiseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // Idle on the noise site for a bit.
        await sleep(Math.min(remaining * 0.6, 60000));
      } catch {}
      // Back to IG before next task.
      try {
        await page.goto(prevUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {}
    }
    // Fallback sleep if any time remains.
    const left = breakUntil - Date.now();
    if (left > 0) await sleep(left);
  }
};

// Schedule next break — frequency & duration depend on account stage.
let profilesSinceBreak = 0;
let tasksSinceLastLearn = 0;
const LEARN_INTERVAL = 20; // trigger learning analysis every 20 tasks

const triggerLearn = async () => {
  try {
    await postJson('/api/bot/learn/analyze', { botId: BOT_ID });
  } catch {}
};
const getBreakThreshold = (stage) => {
  const s = String(stage || '').toLowerCase();
  if (s === 'new') return 1 + Math.floor(Math.random() * 2);
  if (s === 'transition') return 2 + Math.floor(Math.random() * 2);
  if (s === 'growing') return 3 + Math.floor(Math.random() * 3);
  if (s === 'mature') return 5 + Math.floor(Math.random() * 4);
  return 4 + Math.floor(Math.random() * 3); // stable/unknown
};
const getBreakDuration = (stage) => {
  const s = String(stage || '').toLowerCase();
  if (s === 'new') return jitter(3 * 60_000, 8 * 60_000);
  if (s === 'transition') return jitter(5 * 60_000, 10 * 60_000);
  if (s === 'mature') return jitter(5 * 60_000, 15 * 60_000);
  return jitter(BOT_HUMAN_BREAK_MIN_MS, BOT_HUMAN_BREAK_MAX_MS);
};
const maybeScheduleBreak = async (command) => {
  const suppliedAge = Number(command?.accountAgeDays || 0);
  let stage = String(command?.accountStage || lastAccountStage || 'stable').toLowerCase();
  if (suppliedAge <= 0 && BOT_ACCOUNT_BOUND_AT) {
    const boundAt = Date.parse(BOT_ACCOUNT_BOUND_AT);
    const ageDays = Number.isFinite(boundAt) ? Math.max(0, (Date.now() - boundAt) / 86400_000) : 0;
    stage = ageDays < 7 ? 'new' : ageDays < 30 ? 'transition' : ageDays < 60 ? 'growing' : 'mature';
  }
  lastAccountStage = stage;
  if (command?.industry) lastIndustry = String(command.industry);
  profilesSinceBreak++;
  const threshold = getBreakThreshold(stage);
  if (profilesSinceBreak >= threshold) {
    const dur = getBreakDuration(stage);
    breakUntil = Date.now() + dur;
    profilesSinceBreak = 0;
    logBehavior('human_break_start', { breakMs: dur, breakUntil: new Date(breakUntil).toISOString(), stage });
    console.log(`[bot-real] break ${Math.round(dur / 1000)}s (stage=${stage}, threshold=${threshold})`);
  }
};

// Human-like mouse movement: gently move cursor to a random point in the viewport.
const humanMouseMove = async () => {
  if (!page || Math.random() > 0.4) return; // only ~60% chance
  try {
    const vp = page.viewportSize() || { width: 1280, height: 900 };
    const x = Math.floor(Math.random() * vp.width * 0.8);
    const y = Math.floor(Math.random() * vp.height * 0.6);
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 5) + 3 });
  } catch {}
};

// Random hover: briefly hover over a random article element to simulate reading interest.
const humanHover = async () => {
  if (!page || Math.random() > 0.3) return; // ~30% chance
  try {
    const articles = page.locator('article');
    const count = Math.min(await articles.count(), 20);
    if (count > 0) {
      const idx = Math.floor(Math.random() * count);
      await articles.nth(idx).hover({ timeout: 3000 }).catch(() => {});
      await sleep(jitter(400, 1800));
    }
  } catch {}
};

const STATE_DIR = path.resolve('./data/bot_state');
const LIKE_STATE_FILE = path.join(STATE_DIR, `${BOT_ID}_like_state.json`);
type LikeState = {
  byHandle: Record<string, { lastLikedAt?: number; nextEligibleAt?: number }>;
  touches?: Record<string, number>;
  touchesByDay?: Record<string, number>;
  firstTouchAt?: Record<string, number>;
  likes?: {
    byDay?: Record<string, number>;
    // 🔴 2026-09-19：`byDay` 被 BOT_DAILY_LIKE_OVERRIDE 写坏（每次会话写成「本轮数」而非累计，
    // 后一次覆盖前一次）⇒ 面板 `dailyProgress.likes` 恒 0、点赞总数无从统计。
    // `realByDay` 是**不受 override 影响**的真累计计数器，只增不减，用来回答「今天到底点了多少赞」。
    realByDay?: Record<string, number>;
    dayCap?: { key: string; cap: number };
  };
  follows?: {
    byDay?: Record<string, number>;
    byHandle?: Record<string, { followedAt?: number; followBackDetected?: boolean; followBackDetectedAt?: number }>;
    dayCap?: { key: string; cap: number };
  };
  comments?: {
    // byDay is retained for migration from older workers, where queued drafts
    // and published comments were incorrectly mixed in the same counter.
    byDay?: Record<string, number>;
    draftsByDay?: Record<string, number>;
    // 2026-09-19：草稿额度按来源分账（task_review=陌生目标帖 / follow_back_ladder=已关注号）。
    // 旧字段 draftsByDay 保留为**总量**（兼容旧 telemetry），拆分后两路互不挤占。
    draftsByDayBySource?: Record<string, Record<string, number>>;
    draftDayTargetBySource?: Record<string, { key: string; target: number }>;
    postedByDay?: Record<string, number>;
    draftDayTarget?: { key: string; target: number };
    byHandle?: Record<string, { lastCommentAt?: number }>;
    recentText?: Array<{ ts: number; hash: number }>;
    // 帖子级去重：同一个 IG 帖一辈子只允许一条评论。分两张表是因为判定场景不同：
    //   queuedByPostKey = 产出草稿时记（含被人工 reject 的），用来挡「同一帖再生成一条草稿」
    //   postedByPostKey = 真发成功后记，用来挡「claim 到旧草稿后给同一帖发第二条」
    // key 只用 postKey（shortcode），不含文案也不含 handle —— 详见 hasCommentedPost 注释。
    queuedByPostKey?: Record<string, number>;
    postedByPostKey?: Record<string, number>;
    nextPublishAt?: number;
  };
  // DM 去重：记录每个 handle 上次已回复的文案哈希，防止把 bot 自己的出站/上轮回复误当客户新消息反复自回复。
  dmSeen?: Record<string, number>;
  // 2026-09-19：历史评论帖回扫（back-scan）。postsByKey 是「我们在此帖留过评论」的清单
  // （复用 comments.postedByPostKey，180 天 TTL），回扫靠它逐帖复访、找互动。
  //   scanned      = postKey -> 上次复访时间戳（决定旋转顺序与重扫到期）
  //   seenLikes    = postKey -> 上次看到「我们那条评论」的赞数（赞数上涨 = 新增互动信号）
  //   handled      = 互动者 handle -> 我们回赞 TA 的时间戳（防重复回赞）
  postBackScan?: {
    scanned?: Record<string, number>;
    seenLikes?: Record<string, number>;
    handled?: Record<string, number>;
    backfillDoneAt?: number;
    // 上次从 API 回补「已评论帖清单」的时间（本地 state 只留近期记录，需靠 D1 补齐历史）
    listSyncedAt?: number;
  };
  // 🛑 账号休息（被动，IG 限制信号触发）：持久化，bot 重启也继续休息直到冷却结束
  rest?: { until: number; reason: string; severity: string; at: number; count?: number };
};
const loadLikeState = (): LikeState => {
  try {
    if (!fs.existsSync(LIKE_STATE_FILE)) return { byHandle: {} };
    const raw = fs.readFileSync(LIKE_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.byHandle ? parsed : { byHandle: {} };
  } catch {
    return { byHandle: {} };
  }
};
const saveLikeState = (state: LikeState) => {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(LIKE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
};
const likeState = loadLikeState();
if (!likeState.touches) likeState.touches = {};
if (!likeState.touchesByDay) likeState.touchesByDay = {};
if (!likeState.firstTouchAt) likeState.firstTouchAt = {};
if (!likeState.likes) likeState.likes = { byDay: {} };
if (!likeState.likes.byDay) likeState.likes.byDay = {};
if (!likeState.follows) likeState.follows = { byDay: {}, byHandle: {} };
if (!likeState.follows.byDay) likeState.follows.byDay = {};
if (!likeState.follows.byHandle) likeState.follows.byHandle = {};
if (!likeState.comments) likeState.comments = { byDay: {}, byHandle: {}, recentText: [] };
if (!likeState.comments.byDay) likeState.comments.byDay = {};
if (!likeState.comments.draftsByDay) likeState.comments.draftsByDay = { ...likeState.comments.byDay };
if (!likeState.comments.postedByDay) likeState.comments.postedByDay = {};
if (!likeState.comments.byHandle) likeState.comments.byHandle = {};
if (!likeState.comments.recentText) likeState.comments.recentText = [];
if (!likeState.dm) likeState.dm = { byDay: {} };
if (!likeState.rest) likeState.rest = { until: 0, reason: '', severity: '', at: 0 };
if (!likeState.dm.byDay) likeState.dm.byDay = {};
if (!likeState.dmSeen) likeState.dmSeen = {};
if (!likeState.postBackScan) likeState.postBackScan = {};
if (!likeState.postBackScan.scanned) likeState.postBackScan.scanned = {};
if (!likeState.postBackScan.seenLikes) likeState.postBackScan.seenLikes = {};
if (!likeState.postBackScan.handled) likeState.postBackScan.handled = {};

const getTodayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isSameDay = (a?: number, b?: number) => { if (!a || !b) return false; return getTodayKey(new Date(a)) === getTodayKey(new Date(b)); };
// 草稿来源：陌生目标帖（task_review）vs 已关注我们的号（follow_back_ladder）。
// 两路额度独立 —— 详见文件头 `BOT_COMMENT_DRAFT_STRANGER_*` 注释。
type CommentDraftSource = 'task_review' | 'follow_back_ladder';
const draftSourceRange = (source: CommentDraftSource): [number, number] =>
  source === 'follow_back_ladder'
    ? [BOT_COMMENT_DRAFT_LADDER_MIN, BOT_COMMENT_DRAFT_LADDER_MAX]
    : [BOT_COMMENT_DRAFT_STRANGER_MIN, BOT_COMMENT_DRAFT_STRANGER_MAX];
const getCommentDraftDayTarget = (source: CommentDraftSource = 'task_review') => {
  const key = getTodayKey();
  if (!likeState.comments!.draftDayTargetBySource) likeState.comments!.draftDayTargetBySource = {};
  const bag = likeState.comments!.draftDayTargetBySource;
  const cur = bag[source];
  if (!cur || cur.key !== key) {
    const [lo, hi] = draftSourceRange(source);
    const span = hi - lo + 1;
    const target = lo + Math.floor(Math.random() * Math.max(1, span));
    bag[source] = { key, target };
    saveLikeState(likeState);
  }
  return bag[source].target;
};
const commentDraftsToday = () => Number(likeState.comments!.draftsByDay?.[getTodayKey()] || 0);
const commentDraftsTodayFor = (source: CommentDraftSource) =>
  Number(likeState.comments!.draftsByDayBySource?.[source]?.[getTodayKey()] || 0);
const commentsPostedToday = () => Number(likeState.comments!.postedByDay?.[getTodayKey()] || 0);
const canQueueCommentDraft = (source: CommentDraftSource = 'task_review') =>
  commentDraftsTodayFor(source) < getCommentDraftDayTarget(source);
const recordCommentDraftQueued = (source: CommentDraftSource = 'task_review') => {
  const key = getTodayKey();
  if (!likeState.comments!.draftsByDayBySource) likeState.comments!.draftsByDayBySource = {};
  const bag = likeState.comments!.draftsByDayBySource[source] || (likeState.comments!.draftsByDayBySource[source] = {});
  bag[key] = Number(bag[key] || 0) + 1;
  // 总量计数保留（兼容旧 telemetry 读者）；拆分后它 = 两路之和。
  likeState.comments!.draftsByDay![key] = commentDraftsToday() + 1;
  likeState.comments!.byDay![key] = likeState.comments!.draftsByDay![key];
  saveLikeState(likeState);
};
const recordCommentPublished = () => {
  const key = getTodayKey();
  likeState.comments!.postedByDay![key] = commentsPostedToday() + 1;
  likeState.comments!.nextPublishAt = Date.now() + randInt(
    BOT_COMMENT_PUBLISH_INTERVAL_MIN_SEC,
    BOT_COMMENT_PUBLISH_INTERVAL_MAX_SEC,
  ) * 1000;
  saveLikeState(likeState);
};
const canPublishApprovedCommentNow = () => Date.now() >= Number(likeState.comments?.nextPublishAt || 0);

// ── 帖子级去重：同一个 IG 帖子一辈子只允许一条评论（草稿/已发都算）──────────────
// 背景：draftHash 里带了评论文本，换一句文案就被当成新草稿，导致同一个 post 被写两条不同的评论。
// 这里的 key 只取 postKey（shortcode），不含文案/不含 handle，跨 handle 也去重（co-author 帖同理）。
const COMMENT_POST_DEDUP_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 天
const readPostDedupMap = (which: 'queuedByPostKey' | 'postedByPostKey'): Record<string, number> => {
  if (!likeState.comments) likeState.comments = {};
  if (!likeState.comments[which]) likeState.comments[which] = {};
  return likeState.comments[which]!;
};
const postDedupFresh = (map: Record<string, number> | undefined, key: string): boolean => {
  const ts = Number(map?.[key] || 0);
  return !!ts && (Date.now() - ts) <= COMMENT_POST_DEDUP_TTL_MS;
};
const markPostDedup = (which: 'queuedByPostKey' | 'postedByPostKey', postKey: string) => {
  const key = String(postKey || '').trim().toLowerCase();
  if (!key) return;
  const map = readPostDedupMap(which);
  map[key] = Date.now();
  for (const k of Object.keys(map)) {
    if (Date.now() - Number(map[k] || 0) > COMMENT_POST_DEDUP_TTL_MS * 2) delete map[k];
  }
  saveLikeState(likeState);
};
// 产出草稿前用：同一帖只要已经产出过草稿（不论最后是 pending / approved / 已发 / 被人工 reject），
// 就不再产出第二条。这是「同一 post 两条不同评论」的主闸门。
const alreadyHasCommentDraft = (postKey: string): boolean => {
  const key = String(postKey || '').trim().toLowerCase();
  if (!key) return false;
  return postDedupFresh(likeState.comments?.queuedByPostKey, key)
    || postDedupFresh(likeState.comments?.postedByPostKey, key);
};
// 真正发送前用：这个帖已经发出去过评论了 → 别再发第二条（含历史遗留重复草稿）。
const alreadyPostedComment = (postKey: string): boolean => {
  const key = String(postKey || '').trim().toLowerCase();
  if (!key) return false;
  return postDedupFresh(likeState.comments?.postedByPostKey, key);
};
const dmSentToday = () => Number(likeState.dm?.byDay?.[getTodayKey()] || 0);
const recordDmSent = () => {
  const k = getTodayKey();
  likeState.dm.byDay[k] = (likeState.dm.byDay[k] || 0) + 1;
  saveLikeState(likeState);
};

// 每轮扫描：把"已回关 + 已过预热窗口 + 未发过 DM + 当日未超上限"的号直接发 DM。
// 直接走浏览器执行（executeDmTask），不依赖云端 marketing_scripts/marketing_tasks 表，
// 因为该表写入被 Firebase 中间件拦截、且本环境无法部署 cloud-api（无 Cloudflare 凭证）。
// 单次 DM 套 120s 硬超时，失败不标记 dmSent，下一轮可重试。返回本轮是否成功发出至少一条。
const syncFollowBackDmQueue = async (): Promise<boolean> => {
  let sentAny = false;
  try {
    if (BOT_DM_DAILY_MAX > 0 && dmSentToday() >= BOT_DM_DAILY_MAX) return false;
    const byHandle = likeState.follows?.byHandle || {};
    const now = Date.now();
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    for (const [handle, raw] of Object.entries(byHandle)) {
      const st = raw as any;
      // 🛑 self-DM 守卫：绝不给 bot 自己的账号发 DM。
      if (selfIds.has(String(handle).toLowerCase())) continue;
      if (!st?.followBackDetected || st.followBackRevoked || st.dmSent) continue;
      // 熟悉度门槛：评论开启时需 ≥2 赞 + 1 条真实评论；评论关闭时需 ≥3 赞。先建立关系，不硬推广。
      const rp = st.rapport || {};
      const rapportReady = BOT_COMMENT_ENABLED ? (rp.likedPosts >= 2 && rp.commentedAt > 0) : (rp.likedPosts >= 3);
      if (!rapportReady) continue;
      if (now < (st.dmEligibleAt || 0)) continue;
      if (BOT_DM_DAILY_MAX > 0 && dmSentToday() >= BOT_DM_DAILY_MAX) break;
      logBehavior('dm_direct_start', { targetHandle: handle });
      const cc = countryCache[handle] || {};
      const lang = langFor(handle, cc.country || st.country, cc.city || st.city, st.detectedLang);
      // 2026-08-07：产品库模式——按客户情况(市场/语言/回赞)组装 DM；OFFERS 空则走固定池
      const scriptContent = buildDmScript(handle, lang, st);
      const ok = await Promise.race([
        executeDmTask({ target_handle: handle, script_content: scriptContent }),
        new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('dm_direct_timeout_120s')), 120_000)),
      ]).catch(() => false);
      if (ok) {
        st.dmSent = true;
        recordDmSent();
        sentAny = true;
        recordInteraction(handle, 'dm', { scriptContent, lang, followback: true }).catch(() => {});
        // best-effort 服务端记录（云端队列当前不可用，仅作 CRM/跨 bot 可见性）
        postJson('/api/marketing/tasks/report', { targetHandle: handle, status: 'sent', botId: BOT_ID }).catch(() => {});
      } else {
        logBehavior('dm_direct_failed', { targetHandle: handle });
      }
      saveLikeState(likeState);
      await sleep(jitter(6000, 14000)); // 两条 DM 之间留自然间隔，避免连发被风控
    }
  } catch {}
  return sentAny;
};

// ── 回关 rapport 阶梯实现 ────────────────────────────────────────────
const getRapportToday = () => Number((likeState as any).rapportByDay?.[getTodayKey()] || 0);
const recordRapport = () => {
  const k = getTodayKey();
  if (!(likeState as any).rapportByDay) (likeState as any).rapportByDay = {};
  (likeState as any).rapportByDay[k] = ((likeState as any).rapportByDay[k] || 0) + 1;
};

// 给某号近期帖子点 n 篇赞（建立"同行在关注你"的好感信号）。返回实际点赞数。
const rapportLikePosts = async (handle: string, n: number, countRapport = true): Promise<number> => {
  if (!page) return 0;
  try {
    await openProfile(handle);
    await page.waitForTimeout(jitter(1500, 3000));
    const posts = page.locator('a[href*="/p/"]');
    const total = await posts.count();
    let liked = 0;
    for (let i = 0; i < Math.min(n, total); i++) {
      try {
        await posts.nth(i).click({ timeout: 8000 });
        await page.waitForTimeout(jitter(1500, 3000));
        const likeBtn = page.locator('svg[aria-label="Like"]').first();
        if ((await likeBtn.count()) > 0) {
          await likeBtn.click({ timeout: 6000 }).catch(() => {});
          liked++;
          if (countRapport) recordRapport();
          recordInteraction(handle, 'like', { rapport: true, reason: 'follow_back_ladder' }).catch(() => {});
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(jitter(800, 1800));
      } catch {}
    }
    return liked;
  } catch { return 0; }
};

// ── 回赞（like-back）：2026-09-15 用户拍板「不主动关注，改靠互动吸引对方关注」──
// 场景：对方先赞/评了我们的帖子或评论 → 我们回赞 TA 的一篇帖。
// 对方会收到 "peachtattoosupplyraiha liked your post" 通知 → 回访我们主页 → 关注我们。
// 这是零关注成本的增长动作（不增加 following），与回关 rapport 阶梯的日预算解耦。
const LIKE_BACK_DAILY_MAX = Math.max(0, Number(process.env.AUDIENCE_LIKE_DAILY_MAX || 20));
const likeBackToday = () => Number((likeState as any).likeBackByDay?.[getTodayKey()] || 0);
const recordLikeBack = () => {
  const k = getTodayKey();
  if (!(likeState as any).likeBackByDay) (likeState as any).likeBackByDay = {};
  (likeState as any).likeBackByDay[k] = ((likeState as any).likeBackByDay[k] || 0) + 1;
};
const likeBackEngager = async (handle: string): Promise<number> => {
  if (!page) return 0;
  if (LIKE_BACK_DAILY_MAX > 0 && likeBackToday() >= LIKE_BACK_DAILY_MAX) return 0;
  const got = await rapportLikePosts(handle, 1, false).catch(() => 0);
  if (got > 0) recordLikeBack();
  return got;
};

// 自己的账号绝不自我互动（2026-09-14 用户拍板）：回关队列/取粉来源里偶尔会把
// 自己的账号混进来，必须显式拦掉，否则会跑去给自己账号的帖子写评论（一眼自嗨）。
// 覆盖 handle 本体与帖子owner/co-author 两个层面。
const isOwnAccountHandle = (raw: string): boolean => {
  const h = String(raw || '').trim().toLowerCase().replace(/^@/, '').split('/').filter(Boolean).pop() || '';
  if (!h) return false;
  const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).trim().toLowerCase()));
  return selfIds.has(h);
};

const hasClearCaptionTheme = (meta: any): boolean => {
  const caption = String(meta?.caption || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (caption.length < 20) return false;
  const intent = String(meta?.postIntent || 'generic');
  const subject = String(meta?.subject?.subject || 'unknown');
  const styleConfirmed = String(meta?.styleConfidence || 'low') === 'high' && !!meta?.postStyle;
  return intent !== 'generic' || subject !== 'unknown' || styleConfirmed;
};

// 回关培养评论也必须进入统一人工审核队列。这里绝不触碰评论输入框。
const queueRapportCommentForReview = async (handle: string, _fallbackText: string): Promise<string | null> => {
  // 禁止给自己账号写评论（回关队列里偶有自身账号混入，2026-09-14 用户拍板）
  if (isOwnAccountHandle(handle)) {
    logBehavior('comment_skip_own_account', { handle, source: 'follow_back_ladder', scope: 'profile' });
    return null;
  }
  if (!page) return null;
  if (!canQueueCommentDraft('follow_back_ladder')) {
    logBehavior('comment_skip_draft_daily_target', {
      handle,
      source: 'follow_back_ladder',
      dayCount: commentDraftsTodayFor('follow_back_ladder'),
      dayTarget: getCommentDraftDayTarget('follow_back_ladder'),
    });
    return null;
  }
  try {
    await openProfile(handle);
    await page.waitForTimeout(jitter(1500, 3000));
    const firstPost = page.locator('a[href*="/p/"]').first();
    if ((await firstPost.count()) === 0) return null;
    await firstPost.click({ timeout: 8000 });
    await page.waitForTimeout(jitter(1500, 3000));
    const postUrl = page.url();
    const postKey = extractPostKey(postUrl);
    if (!postKey) return null;

    const meta: any = await readModalMeta('', handle);
    let visionDescription = '';
    let visionTechniqueHints: string[] = [];
    let style = meta.postStyle || '';
    let styleConfidence = meta.styleConfidence || 'low';
    // ⚠️ 2026-09-08 修订：视觉常开（原逻辑 caption 主题清晰即跳过看图 → "看图评论"名存实亡，
    // 用户拍板：看图评论质量更高）。视觉不决定"评不评"（那是 caption/意图闸门的活），
    // 只负责把评论写具体：caption 清晰 → 视觉补 hook/craft 增强；caption 含糊 → 视觉兜底判 subject。
    // subjectConfidence='high' 注入门槛移除：buildVisionDescription 内部按 confidence 只拼可信字段，
    // subject 冲突由 prompt 的 EVIDENCE ORDER（caption 优先）兜底。
    const captionThemeClear = hasClearCaptionTheme(meta);
    let vision: any = null;
    // 2026-09-14：社交/生活类帖（生日、聚会、家人朋友）不调识图——图里必然没纹身，
    // 调了也是浪费 API。纹身意图才进识图。
    const ladderIntent = intentEngagement(String(meta.postIntent || 'generic')) ;
    if (ladderIntent === 'social') {
      logBehavior('comment_skip_social_no_vision', { handle, postUrl, source: 'follow_back_ladder' });
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }
    if (isVisionEnabled() && meta.postImageSrc) {
      vision = await analyzePostImage(meta.postImageSrc);
      if (vision?.tattooVisible) {
        visionDescription = buildVisionDescription(vision);
        visionTechniqueHints = extractTechniqueHintsFromVision(visionDescription);
        if (vision.styleConfidence === 'high' && vision.style) {
          const normalized = vision.style.toLowerCase().replace(/[^a-z0-9]/g, '');
          const detected = detectTattooStyle('', '', [normalized]).primary;
          if (detected && styleConfidence !== 'high') {
            style = detected;
            styleConfidence = 'high';
          }
        }
      }
      logBehavior(captionThemeClear ? 'comment_vision_enhance' : 'comment_vision_fallback', {
        handle,
        postUrl,
        captionThemeClear,
        tattooVisible: !!vision?.tattooVisible,
        imageType: vision?.imageType || '',
        subject: vision?.motif || vision?.subject || '',
        subjectConfidence: vision?.subjectConfidence || 'low',
        placement: vision?.placement || '',
        stage: vision?.stage || 'unknown',
        // hookUsable=false = 视觉模型交上来的是空腔调/赞美词（已被 usableHook 丢弃）
        hookUsable: !!vision?.hookUsable,
        craftNotes: vision?.craftNotes || [],
        hook: vision?.commentHook || '',
      });
    }

    // ===== 纹身硬闸门（2026-09-14 用户拍板）：识图判定"图里看不到纹身" → 不写评论、不建草稿 =====
    // 这条路径以前没有纹身意图闸门，任何首帖都会过识图并生成评论（= 什么帖子都识别）。
    // 现在：social 已在上面提前拦；其余必须识图确认有纹身才继续。
    if (BOT_COMMENT_REQUIRE_TATTOO_VISIBLE && vision && vision.tattooVisible === false) {
      logBehavior('comment_skip_no_tattoo_in_image', {
        handle,
        postUrl,
        source: 'follow_back_ladder',
        imageType: vision.imageType || '',
      });
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }

    const caption = String(meta.caption || '').trim();
    if (!caption && !visionDescription) {
      await page.keyboard.press('Escape').catch(() => {});
      logBehavior('comment_skip_no_grounding', { handle, postUrl, source: 'follow_back_ladder' });
      return null;
    }
    const reconciledIntent = reconcileIntentWithVision({
      intent: meta.postIntent || 'generic',
      summary: meta.postSummary || '',
      tone: meta.postTone || 'casual',
      sensitive: !!meta.sensitive,
      keywords: [],
    }, visionDescription);
    const generated = await Promise.race([
      generateComment({
        caption: caption.slice(0, 700),
        imageAlt: meta.imageAlt || '',
        style,
        styleConfidence,
        techniqueHints: meta.techniqueHints || [],
        visionTechniqueHints,
        visionDescription,
        likeCount: meta.likeCount,
        commentCount: meta.commentCount,
        isReel: meta.isReel,
        postIntent: reconciledIntent.intent,
        postSummary: reconciledIntent.summary,
        postTone: reconciledIntent.tone,
        sensitive: reconciledIntent.sensitive,
      }),
      new Promise<{ text: string; style: string }>((_, reject) =>
        setTimeout(() => reject(new Error('rapport_comment_gen_timeout')), 20000)
      ),
    ]);
    const text = String(generated?.text || '').trim();
    await page.keyboard.press('Escape').catch(() => {});
    if (!text) return null;

    // 同一个帖只允许一条草稿（含 follow_back_ladder 来源）。Key 只用 postKey，不含文案/不含 handle。
    if (alreadyHasCommentDraft(postKey)) {
      logBehavior('comment_skip_post_already_commented', {
        handle, postUrl, postKey, source: 'follow_back_ladder',
      });
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    }
    const draftHash = hashString(`${handle}|${postUrl}|${text}`).toString(36);
    const draftId = `rapport_${Date.now()}_${draftHash.slice(0, 10)}`;
    await postJson('/api/drafts/ingest', {
      botId: BOT_ID,
      drafts: [{
        id: draftId,
        botId: BOT_ID,
        handle,
        postUrl,
        postKey,
        proposedComment: text,
        groundingRisks: [
          'follow_back_ladder',
          ...(!visionDescription ? ['vision_unavailable'] : []),
          ...(!caption ? ['caption_missing'] : []),
        ],
        safeFacts: [
          'source:follow_back_ladder',
          ...(caption ? [`caption:${caption.slice(0, 260)}`] : []),
          ...(visionDescription ? [`vision:${visionDescription.slice(0, 300)}`] : []),
        ],
        lang: 'en',
      }],
    });
    markPostDedup('queuedByPostKey', postKey);
    recordCommentDraftQueued('follow_back_ladder');
    logBehavior('comment_review_queued', {
      handle,
      postUrl,
      draftId,
      text,
      source: 'follow_back_ladder',
      caption: caption.slice(0, 260),
      visionDescription: visionDescription.slice(0, 300),
      generationStyle: generated?.style || '',
      dayCount: commentDraftsTodayFor('follow_back_ladder'),
      dayTarget: getCommentDraftDayTarget('follow_back_ladder'),
      ...commentShapeFlags(text),
    });
    return draftId;
  } catch (error: any) {
    await page.keyboard.press('Escape').catch(() => {});
    logBehavior('comment_review_queue_failed', {
      handle,
      source: 'follow_back_ladder',
      reason: String(error?.message || error).slice(0, 180),
    });
    return null;
  }
};

// 给对方评论点个赞（比赞帖子更私密的熟悉信号：说明你连 TA 说了什么都看了）。
// 打开对方最新帖子的评论区，找到作者(handle)自己的评论行，点赞它。
const rapportLikeComment = async (handle: string): Promise<boolean> => {
  if (!page) return false;
  try {
    await openProfile(handle);
    await page.waitForTimeout(jitter(1500, 3000));
    const firstPost = page.locator('a[href*="/p/"]').first();
    if ((await firstPost.count()) === 0) return false;
    await firstPost.click({ timeout: 8000 });
    await page.waitForTimeout(jitter(1800, 3200));
    // 若评论被折叠，先展开全部评论
    const viewAll = page.locator('button, div[role="button"]').filter({ hasText: /view all/i }).first();
    if ((await viewAll.count()) > 0) await viewAll.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(jitter(800, 1600));
    // 找到「作者 handle 的评论行」里的 Like 按钮并标记，随后用 Playwright 真实点击
    const found = await page.evaluate((h) => {
      const svgs = Array.from(document.querySelectorAll('svg[aria-label="Like"]'));
      for (const svg of svgs) {
        let el = svg.parentElement;
        while (el && el !== document.body) {
          if (el.querySelector(`a[href^="/${h}/"]`)) {
            (svg as SVGElement).setAttribute('data-rap-clike', '1');
            return true;
          }
          el = el.parentElement;
        }
      }
      return false;
    }, handle);
    if (!found) { await page.keyboard.press('Escape').catch(() => {}); return false; }
    const likeBtn = page.locator('svg[data-rap-clike="1"]').first();
    await likeBtn.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(jitter(1200, 2200));
    await page.keyboard.press('Escape').catch(() => {});
    recordRapport();
    recordInteraction(handle, 'comment_like', { rapport: true, reason: 'follow_back_ladder' }).catch(() => {});
    return true;
  } catch { return false; }
};

// 每轮推进回关号的熟悉度阶梯：点赞 3 篇(每天 1 篇) → 真诚评论 → 赞对方评论。DM 由 syncFollowBackDmQueue 在预热后发。
// 每个号每轮最多做 1 个 rapport 动作，且全局受 BOT_RAPPORT_DAILY_MAX 限制，确保"慢慢来"。
const syncFollowBackRapport = async (): Promise<void> => {
  try {
    if (BOT_RAPPORT_DAILY_MAX > 0 && getRapportToday() >= BOT_RAPPORT_DAILY_MAX) return;
    const byHandle = likeState.follows?.byHandle || {};
    const now = Date.now();
    for (const [handle, raw] of Object.entries(byHandle)) {
      if (BOT_RAPPORT_DAILY_MAX > 0 && getRapportToday() >= BOT_RAPPORT_DAILY_MAX) break;
      const st = raw as any;
      if (!st?.followBackDetected || st.dmSent) continue; // DM 发完即停止 ladder
      if (!st.rapport) st.rapport = { likedPosts: 0, lastLikeAt: 0, firstLikeAt: 0, commentQueuedAt: 0, commentedAt: 0, commentLikedAt: 0 };
      const rp = st.rapport;
      // 阶段1：点赞帖子。目标 RAPPORT_LIKE_TARGET(默认3) 篇；仅按时间间隔(RAPPORT_LIKE_GAP_HOURS)节流，
      // 不再强制"每天 1 篇"——放宽后回关号可在 ~1 天内攒够 ≥2 赞，更快跨过 DM-able 门槛。
      if (rp.likedPosts < RAPPORT_LIKE_TARGET && now - (rp.lastLikeAt || 0) > RAPPORT_LIKE_GAP_HOURS * 3600_000) {
        const got = await rapportLikePosts(handle, 1);
        if (got > 0) {
          rp.likedPosts += got;
          rp.lastLikeAt = now;
          if (!rp.firstLikeAt) rp.firstLikeAt = now;
          saveLikeState(likeState);
          await sleep(jitter(4000, 9000));
        }
        continue;
      }
      // 阶段2：已点赞 ≥2 篇且隔 ≥18h，留 1 条真诚评论（用对方语言）
      if (rp.likedPosts >= 2 && !rp.commentQueuedAt && !rp.commentedAt && now - (rp.firstLikeAt || now) > RAPPORT_COMMENT_AFTER_HOURS * 3600_000) {
        const cc = countryCache[handle] || {};
        const lang = langFor(handle, cc.country || st.country, cc.city || st.city, st.detectedLang);
        const draftId = await queueRapportCommentForReview(handle, pickRapportComment(handle, lang));
        if (draftId) {
          rp.commentQueuedAt = now;
          rp.commentDraftId = draftId;
          saveLikeState(likeState);
          await sleep(jitter(4000, 9000));
        }
        continue;
      }
      // 阶段3：已评论且隔 ≥6h，再给 TA 的评论点个赞（"你连 TA 说的话都认真看过"的私密信号）
      if (rp.commentedAt && !rp.commentLikedAt && now - rp.commentedAt > RAPPORT_LIKE_GAP_HOURS * 3600_000) {
        const ok = await rapportLikeComment(handle);
        if (ok) {
          rp.commentLikedAt = now;
          saveLikeState(likeState);
          await sleep(jitter(4000, 9000));
        }
        continue;
      }
    }
  } catch {}
};

// 回关主动复检：bot 关注某号后该号任务即 done，7 天内不会重访，若不主动回访则永远检测不到回关。
// 每 5 轮随机回访一个"已关注但未检测到回关"的号，仅导航+检测 "Follows you"（不点赞/关注），
// 让回关在 1-2 天内被发现，进而被 syncFollowBackDmQueue 触达。
let fbCheckTick = 0;
const maybeCheckFollowBacks = async () => {
  try {
    fbCheckTick = (fbCheckTick + 1) % 2; // 🔼 每 5 轮 → 每 2 轮，更快发现回关
    if (fbCheckTick !== 0) return;
    const byHandle = likeState.follows?.byHandle || {};
    // 撤销池：已 detected 且未撤销的号（检测对方是否已取关）；发现池：已关注未检测的号
    const detected = Object.entries(byHandle).filter(([, s]) => (s as any)?.followBackDetected && !(s as any)?.followBackRevoked);
    const undetected = Object.entries(byHandle).filter(([, s]) => (s as any)?.followedAt && !(s as any)?.followBackDetected);
    const pool = detected.length ? detected : undetected; // 优先复查已回关号是否仍关注（取关撤销）
    if (!pool.length) return;
    const [handle] = pool[Math.floor(Math.random() * pool.length)];
    logBehavior('fb_recheck_open', { targetHandle: handle, mode: detected.length ? 'revoke_check' : 'discover' });
    await openProfile(handle);
    // 撤销检测：打开后若 "Follows you" 已消失，标记 followBackRevoked（数据真实，不再计入有效回关/DM）
    if (detected.length) {
      try {
        const followsYou = await page.locator('text="Follows you"').first().isVisible({ timeout: 2000 }).catch(() => false);
        const st = (likeState.follows!.byHandle![handle] || {}) as any;
        if (st.followBackDetected && !followsYou && !st.followBackRevoked) {
          st.followBackRevoked = true;
          saveLikeState(likeState);
          logBehavior('follow_back_revoked', { handle });
          recordInteraction(handle, 'follow_back_revoked', { handle }).catch(() => {});
        }
      } catch {}
    }
  } catch {}
};

// 2026-08-07: 捕获「主动关注我们」的回流粉（如 tattooshops.be）。我们未必先关注过他们，
// 故需定期查自己账号的 Followers 列表，发现新粉即记为 follow_back，复用 syncFollowBackDmQueue
// 在预热窗口后发购买向 DM，并写入 harvests DB 时间线供前台可见。
// 🔁 回关互惠（reciprocal follow-back）：对方主动关注我们 → 礼貌回关。
// 这是 IG 上风险最低的关注动作（对方已先选我们），三大收益：
//   ① 留住粉丝、降低取关率（互关关系更牢，followBackRevoked 更少 → DM-able 不流失）；
//   ② 对方回关后常会来逛我们主页/点赞 → 经 checkWhoLikedUs 把 DM 预热窗口提前到 1h；
//   ③ 直接增加互关数 = "吸引人关注回来" 的核心增长动作，且不依赖 scheduler 任务量。
// 受全局日关注上限（BOT_FOLLOW_DAILY_MAX，与主动关注共享预算）+ 限制信号检测保护。
const reciprocalFollowBack = async (handle: string): Promise<boolean> => {
  try {
    if (!BOT_FOLLOW_BACK_ENABLED || !page) return false;
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    if (selfIds.has(String(handle).toLowerCase())) return false;
    const st = (likeState.follows!.byHandle![handle] || {}) as any;
    if (st.followedAt) return false; // 已关注过，不重复
    // 日上限（与主动关注共享同一预算，避免双向超量触发 IG 风控）
    const dayKey = todayKey();
    const cap = getFollowDayCap();
    const current = Number(likeState.follows!.byDay?.[dayKey] || 0);
    if (cap > 0 && current >= cap) {
      logBehavior('reciprocal_follow_skip_cap', { handle, current, cap });
      return false;
    }
    await openProfile(handle);
    await page.waitForTimeout(jitter(1200, 2400));
    // 行业审核（2026-09-07）：默认只回关纹身师/纹身相关号。粉丝质量优先——粉圈号、
    // 无关账号即使关注了我们也不回关（留手动决定），防止粉丝池被无关号稀释。
    if (BOT_FOLLOW_BACK_REQUIRE_TATTOO) {
      try {
        const facts = await captureProfileFacts().catch(() => null);
        const bio = (facts && String(facts.bio || '')) || '';
        const subject = bio ? detectSubject(bio, [], handle).subject : 'unknown';
        if (subject !== 'tattoo') {
          logBehavior('reciprocal_follow_skipped_not_tattoo', { handle, subject, bio: bio.slice(0, 120) });
          return false;
        }
      } catch { return false; }
    }
    const followSelectors = ['header button', 'header div[role="button"]', 'main button', 'main div[role="button"]', 'button', 'div[role="button"]'];
    let followBtn: any = null;
    for (const sel of followSelectors) {
      const cand = page.locator(sel).filter({ hasText: /^\s*Follow(\s+Back)?\s*$/i }).first();
      if ((await cand.count()) > 0) { followBtn = cand; break; }
    }
    if (!followBtn) { logBehavior('reciprocal_follow_btn_not_found', { handle }); return false; }
    await followBtn.click({ timeout: 6000 });
    await page.waitForTimeout(jitter(1200, 2400));
    // 🛑 限制信号检测（回关也可能触发 "Try again later"）
    try {
      const bsig = await detectBlockSignal();
      if (bsig) { await triggerAccountRest(bsig.severity, bsig.text); return false; }
    } catch {}
    likeState.follows!.byDay![dayKey] = Number(likeState.follows!.byDay![dayKey] || 0) + 1;
    st.followedAt = Date.now();
    likeState.follows!.byHandle![handle] = st;
    saveLikeState(likeState);
    logBehavior('reciprocal_follow_done', { handle, dayCount: likeState.follows!.byDay![dayKey], dayCap: cap });
    recordInteraction(handle, 'follow', { reciprocated: true, followedAt: Date.now() }).catch(() => {});
    return true;
  } catch { return false; }
};

// IG 保留路径词：`a[href^="/"]` 里会混入导航/功能链接，它们不是用户 handle。
// ⚠️ 2026-09-17 实测：Followers 列表抓取把 `reels` / `popular` 当成「新粉」写进
//    likeState.follows.byHandle（还 recordInteraction('follow_back') + 开 DM 预热窗），
//    然后尝试回关一个不存在的用户。当前 IG 页面无 "Follows you" 时不影响主链路，
//    但会污染状态文件并把垃圾号推进 DM 队列，必须剔除。
const IG_RESERVED_PATHS = new Set([
  'p', 'reel', 'reels', 'explore', 'accounts', 'direct', 'tv', 'stories', 'saved',
  'popular', 'nametag', 'about', 'legal', 'api', 'web', 'emails', 'session',
  'challenge', 'graphql', 'developer', 'your_activity', 'notifications',
]);
const isRealHandle = (h: string) =>
  /^[A-Za-z0-9._]{2,30}$/.test(h) && !IG_RESERVED_PATHS.has(String(h).toLowerCase());

// 🔴 2026-09-19 用户明确要求：「评论点赞优先于新号点赞。每天评论点赞先动手，点过了再去点新号；
//   前期评论的、被点赞的、被回复的都回赞完了，之后每天收到就去点，点完回到日常事务继续。」
// 结构上顺序**本来就是对的** —— pollLoop 里互动块排在任务轮询之前，所以每轮都是「先互动后任务」。
// 真正让「评论点赞」形同不存在的是**节流值**：四条通道（通知页互动者 / 自己帖下的暖受众 /
//   谁赞过我们 / 完整扫 Followers）原来各自挂 `% 20` ⇒ 一轮 ≈7.3min ⇒ 每 ≈146min 才轮到一次，
//   全天只跑 ~10 次且常被 human_break 吃掉 ⇒ audience_like_back / comment_engager_like_back
//   全历史 0 行。
// 现在统一走这个旋钮：默认 3（≈22min）。调小 = 反应更快，但每轮都要真开一次页面，
//   是**导航成本**不是点赞成本；不要低于 2。
const ENGAGEMENT_TICK = Math.max(1, Number(process.env.BOT_ENGAGEMENT_TICK || 3));

let incomingFbTick = 0;
// 2026-09-19：把「读自己粉丝数」从「完整扫粉列表」里拆出来单独高频跑。
// 背景：两者原来都挂在 `%20` 上 ⇒ 粉丝数每 ≈146min 才可能读一次，而 `own_followers` 实测 0 行
//   ⇒ 改任何涨粉策略都无法判断效果（这正是「要不要多搞几个号」这个决策缺的那个数字）。
//   读主页 stats 是**便宜**动作（一次 goto + DOM 读），扫 Followers 弹窗才是**重**动作。
const FOLLOWERS_PROBE_TICK = Math.max(1, Number(process.env.BOT_FOLLOWERS_PROBE_TICK || 3));
let followersProbeTick = 0;

// 2026-09-20: IG is an SPA. `domcontentloaded` fires before the profile shell renders, so any
//   caller that reads the DOM immediately after goto() sees an empty page. Measured today:
//   own_followers.probe returned hasFollowersAnchor=false while the anchor does exist a moment
//   later (profile_facts read a real follower count on 37/200 samples with the same selector).
//   Wait for the shell, then for the element the caller actually needs. Bounded; never throws.
const gotoOwnProfile = async (me: string, expect = 'a[href*="/followers/"], a[href*="/p/"]') => {
  if (!page) return;
  await page.goto(`${IG_BASE}/${me}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForSelector(expect, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(jitter(800, 1600));
};
const checkIncomingFollowBacks = async () => {
  try {
    incomingFbTick = (incomingFbTick + 1) % ENGAGEMENT_TICK;                // 重：完整扫 Followers 列表（默认每 ≈22min）
    followersProbeTick = (followersProbeTick + 1) % FOLLOWERS_PROBE_TICK;  // 轻：只读自己粉丝数（默认每 ≈22min）
    const doSweep = incomingFbTick === 0;
    const doProbe = followersProbeTick === 0;
    if (!doSweep && !doProbe) return;
    const me = (ACCOUNT_IDS && ACCOUNT_IDS[0]) || '';
    if (!me || !page) return;
    // ⚠️ goto 必须带 .catch()：裸 await 超时会抛进外层 catch ⇒ 下面的打点永不执行（本文件最贵的一课）
    await gotoOwnProfile(me);
    // 🔴 涨粉仪表：**读不到也要打点**。旧写法只在 `meFollowers > 0` 时打点，导致
    //   「真的是 0 粉丝」和「选择器失效读不到」两种情况在数据上完全同形，无法区分。
    //   现在永远记一行，并带上 DOM 原始探测（anchor 存在与否 / 原文 / title）供定位。
    try {
      const meFacts = await captureProfileFacts().catch(() => null);
      const meFollowers = Number(meFacts?.followers || 0);
      const probe = await page.evaluate(() => {
        const fA = document.querySelector('a[href*="/followers/"]');
        const gA = document.querySelector('a[href*="/following/"]');
        const clean = (s: string | null | undefined) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        return {
          hasFollowersAnchor: !!fA,
          followersText: clean(fA?.textContent),
          followersTitle: clean(fA?.querySelector('span[title]')?.getAttribute('title')),
          followingText: clean(gA?.textContent),
          // 页面是否是登录态（掉登录页时这里会是 false，与「选择器失效」又能区分开）
          loggedIn: !/\/accounts\/login/.test(location.pathname),
        };
      }).catch(() => null);
      logBehavior('own_followers', {
        handle: me,
        followers: meFollowers,
        following: Number(meFacts?.following || 0),
        posts: Number(meFacts?.postCount || 0),
        tracked: Object.keys(likeState.follows?.byHandle || {}).length,
        probe,
      });
    } catch {}
    if (!doSweep) return; // 仅轻探针：读完粉丝数就收工，不开 Followers 弹窗
    const followersLink = page.locator('a[href*="/followers/"]').first();
    if ((await followersLink.count()) > 0) await followersLink.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(jitter(2000, 4000));
    const handles = await page.locator('a[href^="/"]').evaluateAll((els: any[]) =>
      els.map((e) => (e.getAttribute('href') || '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, ''))
        .filter((h: string) => /^[A-Za-z0-9._]{2,30}$/.test(h) && !['p', 'reel', 'explore', 'accounts', 'direct', 'tv', 'stories', 'saved', 'reels', 'popular'].includes(h))
    ).catch(() => []);
    const sample = (handles || []).filter(isRealHandle).slice(0, 40);
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    const newFans: string[] = []; // 🔁 收集本轮新粉，关弹窗后统一礼貌回关（避免逐个导航打断列表枚举）
    for (const h of sample) {
      if (selfIds.has(String(h).toLowerCase())) continue; // 🛑 不会把 bot 自己记为回关
      const st = (likeState.follows!.byHandle![h] || (likeState.follows!.byHandle![h] = {})) as any;
      if (st.followBackDetected) continue; // 已处理过
      if (!countryCache[h]) countryCache[h] = { country: inferCountryFromHandle(h) };
      st.country = st.country || countryCache[h].country;
      st.followBackDetected = true;
      st.followBackDetectedAt = Date.now();
      st.followedAt = st.followedAt || 0; // 对方主动关注我们；下方统一礼貌回关
      st.dmEligibleAt = BOT_DM_WARMUP_HOURS > 0 ? Date.now() + BOT_DM_WARMUP_HOURS * 3600_000 : 0;
      st.dmSent = false;
      saveLikeState(likeState);
      recordInteraction(h, 'follow_back', { organic: true, followBackDetectedAt: st.followBackDetectedAt }).catch(() => {});
      logBehavior('incoming_follow_back', { handle: h });
      newFans.push(h);
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(jitter(800, 1500));
    // 🔁 回关互惠：礼貌回关本轮新粉（受日关注上限 + 限制信号保护；与主动关注共享预算）
    for (const h of newFans) {
      try { await reciprocalFollowBack(h); } catch {}
      await sleep(jitter(3000, 6000));
    }
  } catch {}
};

// 2026-08-12: 评论互动回流——扫描通知页"X 赞了你的评论 / 回复了你的评论"，
// 仅在【当天检测、次日回关】的节奏下，对 detectSubject==='tattoo' 的互动者回关
// （复用 reciprocalFollowBack 的 dedup/日上限/限制信号保护）。粉丝/穿孔/未知不跟，保 B2B 受众质量。
// 检测与关注分离：检测到即开主页读 bio 判相关性并记录 followAt(≈次日)，次日 sweep 才真正回关，
// 避免"人家一赞你立刻回关"的 bot 信号，也更自然。
let commentEngagerTick = 0;
const checkCommentEngagers = async () => {
  try {
    commentEngagerTick = (commentEngagerTick + 1) % ENGAGEMENT_TICK;
    if (commentEngagerTick !== 0) return;
    // 2026-09-15：不再依赖 BOT_FOLLOW_ENABLED。关掉主动关注后这条"互动者回流"通道改为
    //   回赞（对方收到通知 → 回访我们主页），关注动作单独由 BOT_FOLLOW_BACK_ENABLED 控制。
    if (!page) return;
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    // 1) 扫通知 Others 页（含"赞了你的评论/回复了你的评论"的互动信号）
    // 🔴 2026-09-19：这里原来是**裸 await goto**（没有 .catch）⇒ 一旦超时，异常被外层
    //   try/catch 吞掉，下面的 comment_engager_scan 打点**永远不触发**。这正是
    //   「打点位置坑」的既有未修实例。改成降级 + navOk，保证统计与打点无论如何都写。
    let navOk = true;
    await page.goto(`${IG_BASE}/notifications/others/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { navOk = false; });
    await page.waitForTimeout(jitter(2000, 3500));
    for (let s = 0; s < 3; s++) {
      await page.mouse.wheel(0, 1500).catch(() => {});
      await page.waitForTimeout(jitter(1200, 2200));
    }
    // 2) 抽取互动者：通知项含 actor 链接 + 描述文案（liked your comment / replied to your comment）
    const raw = await page.evaluate(() => {
      const out: { handle: string; text: string }[] = [];
      const links = Array.from(document.querySelectorAll('a[href^="/"]')) as any[];
      for (const link of links) {
        const href = (link.getAttribute('href') || '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
        if (!/^[A-Za-z0-9._]{2,30}$/.test(href)) continue;
        let node: any = link;
        for (let i = 0; i < 4 && node; i++) node = node.parentElement;
        const text = (node ? node.innerText : (link as any).innerText || '').replace(/\s+/g, ' ').trim();
        out.push({ handle: href, text });
      }
      return out;
    }).catch(() => [] as { handle: string; text: string }[]);
    const engagers: string[] = [];
    for (const n of raw) {
      if (selfIds.has(n.handle.toLowerCase())) continue;
      if (/liked your comment|replied to your comment/i.test(n.text)) engagers.push(n.handle);
    }
    // 🔴 2026-09-19：空结果也必须打点。不打点就无法区分「真没人互动」和「通知页正则失配」——
    // 这两种情况的修法完全相反（等 vs 改正则）。此前这里只有一句裸 `return`，
    // 所以 comment_engager_* 全为 0 行时，我们查不出原因。
    logBehavior('comment_engager_scan', {
      navOk,
      scanned: raw.length,
      engagers: engagers.length,
      tracked: Object.keys(likeState.follows?.byHandle || {}).length,
    });
    // 🔴 2026-09-19：`if (!engagers.length) return;` 曾是**死代码陷阱** ——
    // 本轮没扫到新互动者就直接返回 ⇒ 下面的 Pass B（次日已到点的互动者 → 回赞/回关）
    // **永远执行不到**，写进状态的 `commentEngagerFollowAt` 从不被消费。
    // 实测 comment_engager_like_back / _follow_back 全部 0 行。
    // 现在 Pass A 空转不拦 Pass B（两件事本来就没有依赖关系）。
    // 3) Pass A：当日检测新互动者，开主页读 bio 判相关性，记录次日 followAt（不立即回关）
    for (const h of (engagers.length ? engagers.slice(0, 20) : ([] as string[]))) {
      const st = (likeState.follows!.byHandle![h] || (likeState.follows!.byHandle![h] = {})) as any;
      if (st.followedAt || st.commentEngagerProcessed) continue;
      try {
        await openProfile(h);
        await page.waitForTimeout(jitter(1000, 2000));
        const facts = await captureProfileFacts().catch(() => null);
        const subject = facts ? detectSubject(facts.bio, [], h).subject : 'unknown';
        st.commentEngagerProcessed = true;
        st.commentEngagerDetectedAt = Date.now();
        st.commentEngagerSubject = subject;
        st.commentEngagerFollowAt = Date.now() + jitter(20 * 3600_000, 28 * 3600_000); // 次日回关
        saveLikeState(likeState);
        logBehavior('comment_engager_detected', { handle: h, subject });
        if (subject !== 'tattoo') logBehavior('comment_engager_skip', { handle: h, subject });
      } catch {}
      await sleep(jitter(2500, 5000));
    }
    // 4) Pass B：遍历持久化状态，次日已到点的 tattoo 互动者 → 先「回赞」建立互动；
    //    回关仅当 BOT_FOLLOW_BACK_ENABLED 开时执行（默认关，关掉不影响回赞）
    for (const h of Object.keys(likeState.follows?.byHandle || {})) {
      const st = likeState.follows!.byHandle![h] as any;
      if (!st || !st.commentEngagerFollowAt) continue;
      if (Date.now() < st.commentEngagerFollowAt) continue;
      if (st.commentEngagerSubject && st.commentEngagerSubject !== 'tattoo') continue; // 仅 tattoo 相关
      // ① 回赞对方最新一篇帖（对方收到 "liked your post" 通知 → 回访/关注我们的主力信号）
      if (!st.commentEngagerLikedAt) {
        const got = await likeBackEngager(h).catch(() => 0);
        if (got > 0) {
          st.commentEngagerLikedAt = Date.now();
          saveLikeState(likeState);
          logBehavior('comment_engager_like_back', { handle: h, liked: got, dayCount: likeBackToday(), dayCap: LIKE_BACK_DAILY_MAX });
          await sleep(jitter(3000, 6000));
        } else if (LIKE_BACK_DAILY_MAX > 0 && likeBackToday() >= LIKE_BACK_DAILY_MAX) {
          break; // 今日回赞预算用尽：不标记已完成，下一轮/明天继续
        }
      }
      // ② 回关（可选，默认关）
      if (!BOT_FOLLOW_BACK_ENABLED || st.followedAt) continue;
      const followed = await reciprocalFollowBack(h);
      if (followed) {
        logBehavior('comment_engager_follow', { handle: h });
        recordInteraction(h, 'follow', { reason: 'comment_engager', subject: st.commentEngagerSubject || 'tattoo' }).catch(() => {});
      }
      await sleep(jitter(3000, 6000));
    }
  } catch {}
};

// ── 2026-09-19 用户拍板：历史评论帖回扫（retroactive back-scan）──────────────
// 动机：评论链路已经跑了一个月（D1 `comment_posted` 实测 171 篇 / 08-22 起），但
//   「谁回复了我们 / 谁赞了我们的评论」从来没有被回过头收割过 ——
//   comment_engager_* / audience_like_back 全历史 0 行。
// 已评论帖清单 = comments.postedByPostKey（shortcode -> 时间戳，180 天 TTL），天然可枚举，
//   无需新表、无需联网拉历史。
// 两阶段（同一引擎，只改每轮批量）：
//   ① 回溯期：从未扫过的优先，每轮 BATCH_BACKFILL 篇，先把历史欠账补完
//   ② 稳态：全部扫过一轮后，每轮 BATCH_STEADY 篇 + 每帖 RESCAN_DAYS 天重扫一次
// 命中即「回赞」：先赞回复者的**评论**（账 C / rapportByDay），再赞回复者的**最新帖**
//   （账 B / likeBackByDay）。这两本账与任务点赞账 A 互不通气 ⇒
//   这就是「评论互动优先于任务点赞」的结构性实现，不必先合并总池。
// 🔴 硬限制（必须知道，否则会误判功能失效）：IG 网页端**不公开「谁赞了某条评论」**，
//   只给赞数。⇒ 帖子回扫能精确定位「回复者」，但「评论被谁赞」只能读到数量增减。
//   要拿 liker 身份只能靠通知页（checkCommentEngagers）。两条通道互补，不可互相替代。
const POST_BACKSCAN_ENABLED = String(process.env.BOT_POST_BACKSCAN_ENABLED ?? 'true') !== 'false';
const POST_BACKSCAN_BATCH_BACKFILL = Math.max(1, Number(process.env.BOT_POST_BACKSCAN_BATCH_BACKFILL || 6));
const POST_BACKSCAN_BATCH_STEADY = Math.max(1, Number(process.env.BOT_POST_BACKSCAN_BATCH_STEADY || 2));
const POST_BACKSCAN_RESCAN_DAYS = Math.max(1, Number(process.env.BOT_POST_BACKSCAN_RESCAN_DAYS || 7));
const POST_BACKSCAN_MAX_REPLIERS = Math.max(0, Number(process.env.BOT_POST_BACKSCAN_MAX_REPLIERS || 2));
// 节流：每 N 轮真扫一次（其余轮次直接 return，空转成本 ≈ 0）
const POST_BACKSCAN_TICK = Math.max(1, Number(process.env.BOT_POST_BACKSCAN_TICK || 2));

// 在当前打开的帖子页面上，找到 <handle> 的评论行并点赞。
// 选择器策略与 rapportLikeComment 完全一致（往上找祖先里含 /handle/ 链接的 Like 图标），
// 区别是**不导航**——直接吃调用方已经打开的帖子页，省掉一次 openProfile。
const likeHandleCommentHere = async (handle: string): Promise<boolean> => {
  if (!page) return false;
  try {
    const found = await page.evaluate((h) => {
      const svgs = Array.from(document.querySelectorAll('svg[aria-label="Like"]'));
      for (const svg of svgs) {
        let el = svg.parentElement;
        while (el && el !== document.body) {
          if (el.querySelector(`a[href^="/${h}/"]`) || el.querySelector(`a[href="/${h}/"]`)) {
            (svg as unknown as SVGElement).setAttribute('data-bscan-clike', '1');
            return true;
          }
          el = el.parentElement;
        }
      }
      return false;
    }, handle).catch(() => false);
    if (!found) return false;
    const btn = page.locator('svg[data-bscan-clike="1"]').first();
    if ((await btn.count()) === 0) return false;
    await btn.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(jitter(1200, 2200));
    return true;
  } catch { return false; }
};

// 抽取当前帖子页的评论列表：username / 赞数 / 缩进左偏移（用来判"谁挂在谁下面"）。
//
// 🔴 2026-09-19 首轮实测教训：原实现只有**单路**判据 —— 只认「span 文本严格等于 'Reply'」。
//   上线后第一轮 6/6 帖 `totalComments=0` + `foundSelf=false`，而这 6 篇我们**确定**都留过评论
//   ⇒ 判据整体过时（IG 早就不用那个老结构与文案，`_ap3a` 类名更是多年前的）。**双路 + 探针**：
//   ① 路1 = 既定判据（保留，零风险）② 路2 = **结构兜底**：不依赖任何文案，只认「含 <time> 且含作者链
//   接的评论级容器」（IG 评论永远同时有这两样，且不受界面语言影响）。
//   ③ `probe` = 抽不出来时的病因探针（页面到底有没有评论 / 是否掉登录 / 是否被限流 / 按钮文案语言）。
//   这样下一轮不必再猜：探针数据直接指向是"选择器过期"还是"页面没加载"还是"掉登录"。
const extractPostComments = async (): Promise<{
  rows: Array<{ username: string; likes: number; left: number; text: string }>;
  via: 'reply-span' | 'structural' | 'none';
  probe: Record<string, unknown>;
}> => {
  if (!page) return { rows: [], via: 'none', probe: { noPage: true } };
  return await page.evaluate(() => {
    const rows: Array<{ username: string; likes: number; left: number; text: string }> = [];
    const seen = new Set<string>();
    const addRow = (username: string, likes: number, left: number, text: string) => {
      if (!username) return;
      const k = username + '\u0000' + text.slice(0, 60);
      if (seen.has(k)) return;
      seen.add(k);
      rows.push({ username, likes, left, text });
    };
    const leftOf = (el: Element) => { try { return Math.round(el.getBoundingClientRect().left); } catch { return 0; } };
    const handleOf = (el: Element | null): string => {
      if (!el) return '';
      const a = el.querySelector('a[href^="/"]') as HTMLAnchorElement | null;
      const href = (a?.getAttribute('href') || '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
      return /^[A-Za-z0-9._]{2,30}$/.test(href) ? href.toLowerCase() : '';
    };

    // ── 路 1：既定判据（span 'Reply' 上溯 3 层）──
    for (const span of Array.from(document.querySelectorAll('span'))) {
      if ((span.textContent || '').trim() !== 'Reply') continue;
      let c: Element | null = span;
      for (let i = 0; i < 3 && c; i++) c = c.parentElement;
      if (!c) continue;
      const u = handleOf(c);
      if (!u) continue;
      // 赞数：动作行（'Reply' 上溯 2 层）去掉 "Reply" 后，整串须形如 "3 likes" / "1 like"
      const actions = ((span.parentElement?.parentElement?.textContent || '') as string)
        .replace(/Reply/g, ' ').replace(/\s+/g, ' ').trim();
      const lm = actions.match(/^(\d+)\s*likes?$/i);
      addRow(u, lm ? parseInt(lm[1], 10) || 0 : 0, leftOf(c), (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240));
    }
    const viaReplySpan = rows.length;

    // ── 路 2：结构兜底（不依赖 'Reply' 文案，也不受界面语言影响）──
    if (rows.length === 0) {
      for (const t of Array.from(document.querySelectorAll('time'))) {
        let c: Element | null = t;
        for (let i = 0; i < 6 && c && c !== document.body; i++) {
          const up = c.parentElement;
          if (!up) break;
          c = up;
          if (c.querySelector('time') && c.querySelector('a[href^="/"]')) break;
        }
        if (!c) continue;
        const u = handleOf(c);
        if (!u) continue;
        const txt = (c.textContent || '').replace(/\s+/g, ' ').trim();
        const lm = txt.match(/(\d+)\s*likes?/i);
        addRow(u, lm ? parseInt(lm[1], 10) || 0 : 0, leftOf(c), txt.slice(0, 240));
      }
    }

    // ── 探针：抽不出来时定位病因，避免下一轮再靠猜 ──
    const body = (document.body?.innerText || '');
    const probe = {
      path: location.pathname,
      article: document.querySelectorAll('article').length,
      timeEls: document.querySelectorAll('time').length,
      replySpans: viaReplySpan,
      hasReplyWord: /\brepl(y|ies)\b/i.test(body),
      hasViewAll: /view all \d+ comments|view \d+ comments|查看全部|Ver los/i.test(body),
      likeAriaEn: document.querySelectorAll('svg[aria-label="Like"]').length,
      likeAriaAny: Array.from(document.querySelectorAll('svg[aria-label]')).map((s) => s.getAttribute('aria-label')).filter((v, i, arr) => !!v && arr.indexOf(v) === i).slice(0, 8),
      loginWall: !!document.querySelector('input[name="username"]') || /\/accounts\/login/.test(location.pathname),
      rateLimited: /try again later|temporarily blocked|操作过于频繁|Please wait/i.test(body),
      bodyLen: body.length,
    };
    const via: 'reply-span' | 'structural' | 'none' = rows.length === 0 ? 'none' : (viaReplySpan > 0 ? 'reply-span' : 'structural');
    return { rows, via, probe };
  }).catch(() => ({
    rows: [] as Array<{ username: string; likes: number; left: number; text: string }>,
    via: 'none' as const,
    probe: { evalFailed: true } as Record<string, unknown>,
  }));
};

// 清单回补（2026-09-19 首轮实测后新增）：本地 state 的 postedByPostKey 只留了近期记录
// （首轮 queue=44），而 D1 `comment_posted` 实测有 171 篇 —— 不回补的话，「把之前评论过的帖
// 都扫一遍」实际只覆盖最近三天，收割面小 4 倍。
// 纯读接口、每天最多一次；只补 shape 合法的 shortcode，绝不猜。
const syncPostedListFromApi = async (): Promise<number> => {
  const scans = likeState.postBackScan!;
  const last = Number(scans.listSyncedAt || 0);
  if (last && Date.now() - last < 24 * 3600_000) return 0;
  const map = likeState.comments?.postedByPostKey || (likeState.comments!.postedByPostKey = {});
  let added = 0;
  let fetched = 0;
  try {
    for (const off of [0, 200, 400, 600]) {
      const r: any = await getJson(`/api/automation/behavior-logs?event=comment_posted&limit=200&offset=${off}&botId=${encodeURIComponent(BOT_ID)}`);
      const logs: any[] = Array.isArray(r?.logs) ? r.logs : [];
      fetched += logs.length;
      if (!logs.length) break;
      for (const row of logs) {
        const raw = String(row.postUrl || row.post_url || row.url || '');
        const key = extractPostKey(raw);
        if (!key || !/^[A-Za-z0-9_-]{5,20}$/.test(key)) continue;
        if (map[key]) continue;
        map[key] = Number(Date.parse(String(row.ts || ''))) || Date.now();
        added++;
      }
      if (logs.length < 200) break;
    }
    scans.listSyncedAt = Date.now();
    if (added) saveLikeState(likeState);
    // 无条件打点：added=0 也要能区分「接口没数据」和「已经补过」。
    logBehavior('post_backscan_list_synced', { fetched, added, total: Object.keys(map).length });
  } catch (e: any) {
    logBehavior('post_backscan_list_sync_failed', { err: String(e?.message || e).slice(0, 160) });
  }
  return added;
};

let postBackScanTick = 0;
const backScanCommentedPosts = async (): Promise<void> => {
  if (!POST_BACKSCAN_ENABLED || !page) return;
  try {
    postBackScanTick = (postBackScanTick + 1) % POST_BACKSCAN_TICK;
    if (postBackScanTick !== 0) return;
    if (Date.now() < Number(likeState.rest?.until || 0)) return; // 账号休息期不动作
    const selfHandle = String((ACCOUNT_IDS && ACCOUNT_IDS[0]) || '').trim().toLowerCase();
    if (!selfHandle) return;

    // 先把历史清单补齐（每天最多一次、纯读接口、失败静默），否则只能扫到最近几天。
    await syncPostedListFromApi();

    const postedByPostKey = likeState.comments?.postedByPostKey || {};
    const scans = likeState.postBackScan!;
    const scanned = scans.scanned || (scans.scanned = {});
    const seenLikes = scans.seenLikes || (scans.seenLikes = {});
    const handled = scans.handled || (scans.handled = {});
    const rescanMs = POST_BACKSCAN_RESCAN_DAYS * 24 * 3600_000;
    const now = Date.now();

    // 队列：从未扫过(lastScan=0)排最前；否则按最久未扫排（且须已过重扫期）
    const queue = Object.keys(postedByPostKey)
      .map((k) => ({ key: k, postedAt: Number(postedByPostKey[k] || 0), lastScan: Number(scanned[k] || 0) }))
      .filter((c) => c.key && (c.lastScan === 0 || now - c.lastScan > rescanMs))
      .sort((a, b) => (a.lastScan - b.lastScan) || (b.postedAt - a.postedAt));

    if (!queue.length) return;
    const backfilling = queue.some((c) => c.lastScan === 0);
    const batch = queue.slice(0, backfilling ? POST_BACKSCAN_BATCH_BACKFILL : POST_BACKSCAN_BATCH_STEADY);

    let postsVisited = 0;
    let postsWithSelf = 0;
    let repliesFound = 0;
    let likesBacked = 0;
    let commentLikesBacked = 0;

    for (const item of batch) {
      let navOk = true;
      // ⚠️ 打点绝不放在裸 await goto 之后 —— 外层 try/catch 会吞掉超时导致打点永不触发。
      // 这里用 .catch() 把超时降级成 navOk=false，让统计与打点无论如何都执行。
      await page.goto(`${IG_BASE}/p/${item.key}/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { navOk = false; });
      await page.waitForTimeout(jitter(1800, 3200));
      postsVisited++;

      // 展开折叠评论 + 全部 "View replies"，否则回复根本不在 DOM 里
      try {
        for (let round = 0; round < 2; round++) {
          const expanders = page.locator('button, div[role="button"], span[role="button"]')
            .filter({ hasText: /view all \d+ comments|view \d+ repl|view all replies|view replies/i });
          const cnt = await expanders.count().catch(() => 0);
          if (!cnt) break;
          for (let i = 0; i < Math.min(cnt, 6); i++) {
            await expanders.nth(i).click({ timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(jitter(700, 1400));
          }
        }
      } catch {}

      // 等评论区真正渲染出来再抽（IG 是 SPA，domcontentloaded 后评论仍是异步来的；
      // 首轮 6/6 全 0 的另一种可能就是这个）。等不到也不报错，交给探针记录。
      await page.waitForSelector('article time, article ul, time', { timeout: 8000 }).catch(() => {});

      const extracted = await extractPostComments();
      const comments = extracted.rows;
      const selfIdx = comments.findIndex((c) => c.username === selfHandle);
      let replies: string[] = [];
      let indentSpread = 0;
      if (selfIdx >= 0) {
        postsWithSelf++;
        const selfLeft = comments[selfIdx].left;
        const lefts = comments.map((c) => c.left);
        indentSpread = Math.max(...lefts) - Math.min(...lefts);
        // 我们那条评论之后、缩进更深（右移 >8px）且非自己 —— 即挂在我们评论下的回复
        for (let i = selfIdx + 1; i < comments.length; i++) {
          if (comments[i].left <= selfLeft + 8) break; // 缩进回退 = 离开我们的回复区
          const u = comments[i].username;
          if (u && u !== selfHandle && !replies.includes(u)) replies.push(u);
        }
        const prevLikes = Number(seenLikes[item.key] || 0);
        const curLikes = comments[selfIdx].likes;
        if (curLikes > prevLikes) {
          logBehavior('post_backscan_self_likes_up', { postKey: item.key, from: prevLikes, to: curLikes });
        }
        seenLikes[item.key] = curLikes;
      }

      scans.scanned![item.key] = Date.now();
      // 关键可观测点：每次复访都记一行。foundSelf=true 说明「认自己的评论」这条选择器活着；
      // replies 恒 0 且 indentSpread=0 ⇒ 说明缩进判据失效（IG 改版），要换判法。
      logBehavior('post_backscan_scanned', {
        postKey: item.key,
        navOk,
        totalComments: comments.length,
        via: extracted.via,
        foundSelf: selfIdx >= 0,
        indentSpread,
        replies: replies.length,
        probe: extracted.probe,
      });

      if (replies.length) {
        repliesFound += replies.length;
        for (const replier of replies.slice(0, POST_BACKSCAN_MAX_REPLIERS)) {
          if (isOwnAccountHandle(replier)) continue;
          if (handled[replier] && now - Number(handled[replier]) < rescanMs) continue; // 近期已回过，防重复
          // ① 赞回复者的评论（账 C）——比赞帖更"我看了你说了什么"的私密信号
          const likedComment = await likeHandleCommentHere(replier).catch(() => false);
          if (likedComment) { recordRapport(); commentLikesBacked++; }
          await sleep(jitter(2500, 5000));
          // ② 赞回复者最新一篇帖（账 B）——对方收到 "liked your post" → 回访我们主页
          const likedPost = await likeBackEngager(replier).catch(() => 0);
          if (likedPost > 0) likesBacked++;
          handled[replier] = Date.now();
          saveLikeState(likeState);
          logBehavior('post_backscan_reply_found', {
            postKey: item.key,
            replier,
            likedComment,
            likedPost,
            likeBackDayCount: likeBackToday(),
            likeBackDayCap: LIKE_BACK_DAILY_MAX,
          });
          await sleep(jitter(3000, 6000));
        }
      }
      saveLikeState(likeState);
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(jitter(2000, 4500)); // 复访之间留自然间隔，别连扫
    }

    const stillUnscanned = Object.keys(postedByPostKey).filter((k) => !scanned[k]).length;
    if (backfilling && stillUnscanned === 0 && !scans.backfillDoneAt) {
      scans.backfillDoneAt = Date.now();
      saveLikeState(likeState);
      logBehavior('post_backscan_backfill_done', { total: Object.keys(postedByPostKey).length });
    }
    // 每轮汇总一行：这是判断"回扫是否真在跑"的主判据（比任何 status 都可靠）
    logBehavior('post_backscan_cycle', {
      phase: backfilling ? 'backfill' : 'steady',
      queue: queue.length,
      batch: batch.length,
      postsVisited,
      postsWithSelf,
      repliesFound,
      likesBacked,
      commentLikesBacked,
      stillUnscanned,
    });
  } catch {}
};

// 2026-08-07: 检测「对方赞过我们」——互赞是比互关更强的兴趣信号。
// 打开自己主页最新帖子的点赞者列表，对"已知回关号"标记 likedUsDetected；
// 若对方已回关+已回赞（兴趣明确），把预热窗口提前到 1h 内（比默认 4h 更早、也更自然）。
// 仅覆盖最新一篇帖子的赞者（IG 无公开"谁赞了我全部帖子"接口）；失败静默，不影响主链路。
let likedUsTick = 0;
const checkWhoLikedUs = async (): Promise<void> => {
  try {
    likedUsTick = (likedUsTick + 1) % ENGAGEMENT_TICK;
    if (likedUsTick !== 0) return;
    const me = (ACCOUNT_IDS && ACCOUNT_IDS[0]) || '';
    if (!me || !page) return;
    const known = new Set(Object.keys(likeState.follows?.byHandle || {}));
    if (!known.size) return;
    await gotoOwnProfile(me, 'a[href*="/p/"]');
    const firstPost = page.locator('a[href*="/p/"]').first();
    if ((await firstPost.count()) === 0) return;
    await firstPost.click({ timeout: 8000 });
    await page.waitForTimeout(jitter(1800, 3200));
    const likedBy = page.locator('a[href*="/liked_by/"]').first();
    if ((await likedBy.count()) === 0) { await page.keyboard.press('Escape').catch(() => {}); return; }
    await likedBy.click({ timeout: 8000 });
    await page.waitForTimeout(jitter(2000, 3500));
    const handles = await page.locator('a[href^="/"]').evaluateAll((els: any[]) =>
      els.map((e) => (e.getAttribute('href') || '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, ''))
        .filter((h: string) => known.has(h))
    ).catch(() => []);
    const uniq = Array.from(new Set(handles || []));
    for (const h of uniq) {
      const st = likeState.follows!.byHandle![h] as any;
      if (!st || st.likedUsDetected) continue;
      st.likedUsDetected = true;
      st.likedUsDetectedAt = Date.now();
      if (st.followBackDetected) {
        st.dmEligibleAt = Math.min(st.dmEligibleAt || Infinity, Date.now() + 3600_000);
      }
      saveLikeState(likeState);
      recordInteraction(h, 'liked_us', { likedUsDetectedAt: st.likedUsDetectedAt }).catch(() => {});
      logBehavior('liked_us_detected', { handle: h });
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(jitter(800, 1500));
  } catch {}
};

// 2026-08-11: 暖受众反关注（audience reciprocation）
// 主动关注我们自己帖子下「点赞/评论过」的人——他们已对我们的内容感兴趣，回关率远高于冷触达 artist。
// 与 checkWhoLikedUs 的区别：后者只标记「已认识粉丝」的赞；本函数发现并关注「新」暖线索，扩大漏斗顶部。
// 受 AUDIENCE_FOLLOW_DAILY_MAX（默认 20）+ 限制信号检测保护；AUDIENCE_DM_ENABLED 为真时对关注的暖线索发软性 DM。
// 2026-09-15 双模式：BOT_FOLLOW_ENABLED=false（当前策略）→ 只回赞不关注，受 AUDIENCE_LIKE_DAILY_MAX（默认 20）阀值。
let audienceTick = 0;
const checkAudienceReciprocate = async () => {
  try {
    audienceTick = (audienceTick + 1) % ENGAGEMENT_TICK;
    if (audienceTick !== 0) return;
    // 2026-09-15：不再依赖 BOT_FOLLOW_ENABLED —— 关掉主动关注后本通道降级为「回赞」模式
    //   （对方赞/评过我们的帖子 → 我们回赞 TA 一篇帖），关注动作仍只在 BOT_FOLLOW_ENABLED 开时做。
    if (!page) return;
    const me = (ACCOUNT_IDS && ACCOUNT_IDS[0]) || '';
    if (!me) return;
    const dayKey = todayKey();
    const followCap = Math.max(0, Number(process.env.AUDIENCE_FOLLOW_DAILY_MAX || 20));
    const dmEnabled = /^(1|true|yes|on)$/i.test(process.env.AUDIENCE_DM_ENABLED || 'true');
    const dmCap = Math.max(0, Number(process.env.AUDIENCE_DM_DAILY_MAX || 10));
    const postsScan = Math.max(1, Math.min(8, Number(process.env.AUDIENCE_POSTS_SCAN || 3)));
    let followedToday = Number((likeState.audienceFollowsByDay || {})[dayKey] || 0);
    let dmToday = Number((likeState.audienceDmByDay || {})[dayKey] || 0);
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    const seen = new Set<string>();
    const isHandle = (h: string) => /^[A-Za-z0-9._]{2,30}$/.test(h) && !['p','reel','explore','accounts','direct','tv','stories','saved','reels'].includes(h);

    await gotoOwnProfile(me, 'a[href*="/p/"]');
    const postLinks = await page.locator('a[href*="/p/"]').evaluateAll((els: any[]) =>
      Array.from(new Set(els.map((e: any) => (e.getAttribute('href') || '').split('?')[0]).filter((h: string) => h.includes('/p/')).slice(0, postsScan)))
    ).catch(() => [] as string[]);
    for (const pl of postLinks) {
      if (followedToday >= followCap && dmToday >= dmCap) break;
      await page.goto(`${IG_BASE}${pl}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(jitter(1800, 3200));
      // 评论者：帖子页评论区里的 handle 链接
      const commenters = await page.locator('a[href^="/"]').evaluateAll((els: any[]) =>
        els.map((e: any) => (e.getAttribute('href') || '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, ''))
          .filter((h: string) => isHandle(h))
      ).catch(() => [] as string[]);
      for (const h of commenters) { if (h) seen.add(h); }
      // 点赞者：打开 liked_by 弹窗
      const likedBy = page.locator('a[href*="/liked_by/"]').first();
      if ((await likedBy.count()) > 0) {
        await likedBy.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(jitter(2000, 3500));
        const likers = await page.locator('a[href^="/"]').evaluateAll((els: any[]) =>
          els.map((e: any) => (e.getAttribute('href') || '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, ''))
            .filter((h: string) => isHandle(h))
        ).catch(() => [] as string[]);
        for (const h of likers) { if (h) seen.add(h); }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(jitter(800, 1500));
      }
    }
    let scanned = 0;
    for (const h of Array.from(seen)) {
      if (scanned++ > 60) break; // 每轮最多处理 60 个候选，避免单次过长
      if (followedToday >= followCap && dmToday >= dmCap) break;
      if (selfIds.has(h.toLowerCase())) continue;
      const st: any = (likeState.follows!.byHandle![h] || (likeState.follows!.byHandle![h] = {}));
      // ── 关注关闭时（默认）：本通道只做「回赞」——对方已对我们的内容表示过兴趣，
      //    回赞 TA 一篇帖 = 对方收到通知 → 回访我们主页，零关注成本的增长动作。──
      if (!BOT_FOLLOW_ENABLED) {
        if (st.audienceLikedAt) continue;
        if (LIKE_BACK_DAILY_MAX > 0 && likeBackToday() >= LIKE_BACK_DAILY_MAX) break;
        const got = await likeBackEngager(h).catch(() => 0);
        if (got > 0) {
          st.audienceLikedAt = Date.now();
          saveLikeState(likeState);
          recordInteraction(h, 'like', { audience: true, reason: 'audience_like_back' }).catch(() => {});
          logBehavior('audience_like_back', { handle: h, dayCount: likeBackToday(), dayCap: LIKE_BACK_DAILY_MAX });
        }
        await sleep(jitter(3000, 6000));
        continue;
      }
      if (st.followedAt) continue; // 已关注过，跳过
      if (followedToday >= followCap) continue; // 已达关注上限，本轮回填只处理新关注的
      const ok = await followAudienceLead(h);
      if (!ok) continue;
      followedToday++;
      st.followedAt = Date.now();
      st.audienceFollowedAt = Date.now();
      likeState.audienceFollowsByDay = likeState.audienceFollowsByDay || {};
      likeState.audienceFollowsByDay[dayKey] = followedToday;
      saveLikeState(likeState);
      recordInteraction(h, 'follow', { audience: true, reason: 'audience_reciprocate', followedAt: Date.now() }).catch(() => {});
      logBehavior('audience_follow_done', { handle: h, dayCount: followedToday, dayCap: followCap });
      // 可选：对暖线索发软性 DM（受 AUDIENCE_DM_DAILY_MAX + 限制信号保护）
      if (dmEnabled && dmToday < dmCap) {
        try {
          const alang = (await detectLangForHandle(h)) || 'en';
          const script = getAudienceDmScript(h, alang);
          await executeDmTask({ target_handle: h, script_content: script } as any);
          dmToday++;
          likeState.audienceDmByDay = likeState.audienceDmByDay || {};
          likeState.audienceDmByDay[dayKey] = dmToday;
          saveLikeState(likeState);
        } catch {}
      }
      await sleep(jitter(3000, 6000));
    }
  } catch {}
};

// 暖受众关注：打开对方主页点 Follow（与 reciprocalFollowBack 同源逻辑），受限制信号保护。
const followAudienceLead = async (handle: string): Promise<boolean> => {
  try {
    if (!BOT_FOLLOW_ENABLED || !page) return false;
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    if (selfIds.has(String(handle).toLowerCase())) return false;
    await openProfile(handle);
    await page.waitForTimeout(jitter(1200, 2400));
    const followSelectors = ['header button', 'header div[role="button"]', 'main button', 'main div[role="button"]', 'button', 'div[role="button"]'];
    let followBtn: any = null;
    for (const sel of followSelectors) {
      const cand = page.locator(sel).filter({ hasText: /^\s*Follow(\s+Back)?\s*$/i }).first();
      if ((await cand.count()) > 0) { followBtn = cand; break; }
    }
    if (!followBtn) { logBehavior('audience_follow_btn_not_found', { handle }); return false; }
    await followBtn.click({ timeout: 6000 });
    await page.waitForTimeout(jitter(1200, 2400));
    try {
      const bsig = await detectBlockSignal();
      if (bsig) { await triggerAccountRest(bsig.severity, bsig.text); return false; }
    } catch {}
    logBehavior('audience_follow_clicked', { handle });
    return true;
  } catch { return false; }
};

// ── 主循环停滞看门狗的状态（2026-09-18）────────────────────────────────
// 判据说明参见下方 stallWatchdogLoop。任何"有产出"的动作都会走 logBehavior，
// 所以在 logBehavior 里刷时间戳：**静默超过阈值 = 卡死**，比看任务量可靠得多。
const STALL_WATCHDOG_MS = Math.max(300_000, Number(process.env.BOT_STALL_WATCHDOG_MS || 25 * 60_000));
const STALL_RESTART_COOLDOWN_MS = Math.max(600_000, Number(process.env.BOT_STALL_RESTART_COOLDOWN_MIN || 20) * 60_000);
const STALL_RESTART_MARKER = path.join(STATE_DIR, 'bot-worker.stall-restart.json');
let lastProgressAt = Date.now();
let stallHeals = 0;
const touchProgress = () => { lastProgressAt = Date.now(); };

const logBehavior = (event: string, data: Record<string, any> = {}) => {
  touchProgress();
  try {
    behaviorBuffer.push({ ...data, ts: new Date().toISOString(), botId: BOT_ID, event });
  } catch {}
};

const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (BOT_API_KEY) headers['x-bot-key'] = BOT_API_KEY;
  if (BOT_API_TOKEN) headers['Authorization'] = `Bearer ${BOT_API_TOKEN}`;
  return headers;
};

// 🔴 2026-09-18：所有出网请求加**硬超时**。
// 旧实现是裸 `await fetch(...)`：socket 一旦卡住（undici keep-alive 复用 + 中转抖动）
// 就永不返回 ⇒ pollLoop 整条主循环**静默卡死**，而 heartbeatLoop 是并发的另一条循环，
// 照常刷新 last_heartbeat ⇒ 前台显示 online 的「假绿灯」。
// 2026-09-17 19:46 实测就这样卡了 13 小时（零事件、零租约，但心跳一直新鲜）。
// 宁可有超时报错让上层 catch 接管重试，也不要无限等。
const API_FETCH_TIMEOUT_MS = Math.max(5_000, Number(process.env.BOT_API_TIMEOUT_MS || 45_000));
const fetchWithTimeout = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`fetch_timeout_${API_FETCH_TIMEOUT_MS}ms`)), API_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
};

// 🔴 2026-09-18：**Playwright 协议调用也能永久挂住**。
// 与 fetch 不同的是，CDP 连接"半死"（端口通、WS 通、渲染进程已死）时，`await page.xxx()`
// 既不抛错也不返回 —— `try/catch` 接不住，Playwright 自己的 default timeout 也可能不生效
// （超时由 driver 侧计时，driver 与浏览器一起僵住时无人来计时）。
// 2026-09-17 19:46 起静默 13 小时、心跳照旧新鲜的形态，与这条路径完全同型：
//   卡点在 `isOnLoginPage()` 的 `locator.count()` → `waitUntilLoggedIn()` 的 for 循环
//   永远停在同一个 await 上 → 零行为事件、零租约、零日志。
// 这里给出**本地计时**的兜底：超时就当作失败，让调用方按既有分支重试（绝不静默无限等）。
const withTimeout = async <T,>(p: Promise<T>, ms: number, label: string): Promise<T | null> => {
  let timer: any;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const PW_CALL_TIMEOUT_MS = Math.max(2_000, Number(process.env.BOT_PW_CALL_TIMEOUT_MS || 15_000));

const postJson = async (path: string, body: Record<string, any>) => {
  const resp = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`);
  return payload;
};

const getJson = async (path: string) => {
  const resp = await fetchWithTimeout(`${API_BASE}${path}`, { headers: buildHeaders() });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`);
  return payload;
};

// ── AI Core helpers (sales_chats D1 sync) ──────────────────────────────
const aicorePost = async (path: string, body: Record<string, any>): Promise<any> => {
  // 2026-09-18：改用带硬超时的 fetch —— 聊天同步是 best-effort，绝不该因对端挂住而拖死主循环。
  const resp = await fetchWithTimeout(`${AI_CORE_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: AI_CORE_AUTH },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) {
    // Log but don't throw — chat sync is best-effort, never break the DM flow.
    console.warn(`[aicore] POST ${path} FAILED ${resp.status}: ${JSON.stringify(payload).slice(0, 200)}`);
    return null;
  }
  return payload;
};

/** Upsert a sales_chat + append a message. Idempotent on handle. */
const reportDmChat = async (handle: string, role: 'agent' | 'customer', body: string, dealStage?: string) => {
  if (!handle || !body) return;
  const r = await aicorePost(`/${AI_CORE_TENANT}/chats`, {
    customer_handle: handle,
    customer_type: 'artist',
    platform: 'instagram',
    locale: 'en',
    deal_stage: dealStage || 'inquiry',
    summary: body.slice(0, 200),
  });
  if (r?.ok && r?.chat?.id) {
    await aicorePost(`/${AI_CORE_TENANT}/chats/${r.chat.id}/messages`, {
      messages: [{ role, body, created_at: new Date().toISOString() }],
    }).catch(() => {});
  }
};

const registerBot = async () => {
  await postJson('/api/bot/register', {
    botId: BOT_ID,
    accountIds: ACCOUNT_IDS,
    host: BOT_HOST,
    version: BOT_VERSION,
    meta: buildWorkerDailyMeta(),
  });
};

// ---------------------------------------------------------------------------
// 运行时自检 + 基础设施状态上报（喂给前台「系统健康」面板）
//
// 2026-09-18 那次 13 小时卡死的教训：**心跳是假绿灯**，它和任务主循环在
// Promise.all 里并发跑，主循环挂住时心跳照跳、pm2 照 online。所以心跳里除了
// 进度，还要带上「只有本进程知道的实话」：
//   * 浏览器 CDP 是**什么时候**连上的（不是布尔值，是时间戳 —— 时间戳才能暴露陈旧）；
//   * 两个守护脚本（chrome-keeper / vps-bot-autosync）的状态文件内容 + 新鲜度。
// 前台按这些判据把坏掉的板块画红，而不是看 pm2 的状态灯。
//
// ⚠️ 这里任何一项失败都不能影响心跳本身 —— 全部包在 try/catch 里，读不到就报 null。
// ---------------------------------------------------------------------------
const runtimeDiag = {
  startedAt: Date.now(),
  // 每次 CDP 连接成功就刷新；前台据此判断「浏览器还能不能用」
  browserConnectedAt: 0,
  browserConnectCount: 0,
  lastCdpFailure: '' as string,
  lastCdpFailureAt: 0,
};

const INFRA_STATUS_FILES = {
  autosync: 'C:\\harvests\\logs\\autosync-status.json',
  chromeKeeper: 'C:\\harvests\\logs\\chrome-keeper-status.json',
};

type InfraProbe = {
  at: number;
  ageSec: number;
  result: string;
  note?: string;
  head?: string;
  remoteHead?: string;
  restarted?: boolean;
  verdict?: string;
} | null;

const readInfraStatus = (file: string): InfraProbe => {
  try {
    if (!fs.existsSync(file)) return null;
    // 状态文件由 PowerShell 写、故意不带 BOM；这里仍容忍 BOM，免得解析莫名其妙失败。
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    const at = Number(j?.at || 0);
    if (!at) return null;
    const clip = (v: any, n: number) => (v === undefined || v === null ? undefined : String(v).slice(0, n));
    return {
      at,
      ageSec: Math.max(0, Math.round((Date.now() - at) / 1000)),
      result: clip(j.result, 40) || 'unknown',
      note: clip(j.note, 180),
      head: clip(j.head, 12),
      remoteHead: clip(j.remoteHead, 12),
      restarted: typeof j.restarted === 'boolean' ? j.restarted : undefined,
      verdict: clip(j.verdict, 20),
    };
  } catch (e: any) {
    return { at: 0, ageSec: -1, result: 'unreadable', note: String(e?.message || e).slice(0, 120) };
  }
};

const buildWorkerDailyMeta = () => {
  const dayKey = getTodayKey();
  return {
    mode: 'playwright-real',
    profileDir: PROFILE_DIR,
    accountIds: ACCOUNT_IDS,
    dailyPlan: {
      taskTarget: BOT_DAILY_TASK_TARGET,
      commentDraftMin: BOT_COMMENT_DRAFT_DAILY_MIN,
      commentDraftMax: BOT_COMMENT_DRAFT_DAILY_MAX,
      commentDraftTarget: getCommentDraftDayTarget(),
      commentPublishMax: BOT_COMMENT_PUBLISH_DAILY_MAX,
      commentPublishIntervalMinSec: BOT_COMMENT_PUBLISH_INTERVAL_MIN_SEC,
      commentPublishIntervalMaxSec: BOT_COMMENT_PUBLISH_INTERVAL_MAX_SEC,
      likeTarget: getDailyLikeCap(),
      followTarget: getFollowDayCap(),
    },
    dailyProgress: {
      day: dayKey,
      profilesVisited: Number(likeState.touchesByDay?.[dayKey] || 0),
      // 2026-09-19：改读 realByDay。旧的 byDay 被 BOT_DAILY_LIKE_OVERRIDE 写坏（恒等于本轮赞数），
      // 面板 likes 因此长期显示 0，让人误判「没在点赞」。
      likes: Number(likeState.likes?.realByDay?.[dayKey] || 0),
      follows: Number(likeState.follows?.byDay?.[dayKey] || 0),
      commentDrafts: commentDraftsToday(),
      commentsPosted: commentsPostedToday(),
      nextCommentPublishAt: Number(likeState.comments?.nextPublishAt || 0),
    },
    // 前台「系统健康」面板的数据源（后端 /api/system/health 读 meta.infra）。
    // 全部字段都是可选的：任何一项读不到就 null，绝不让心跳因为自检失败而挂掉。
    infra: {
      startedAt: runtimeDiag.startedAt,
      uptimeSec: Math.round((Date.now() - runtimeDiag.startedAt) / 1000),
      browser: {
        // connected 由「距今多久」推导，而不是连过一次就永远 true ——
        // 前者才能暴露「连上过但后来死了」。
        connected: runtimeDiag.browserConnectedAt > 0
          && (Date.now() - runtimeDiag.browserConnectedAt) < 30 * 60 * 1000,
        lastConnectedAt: runtimeDiag.browserConnectedAt,
        connectedAgeSec: runtimeDiag.browserConnectedAt
          ? Math.round((Date.now() - runtimeDiag.browserConnectedAt) / 1000) : null,
        connectCount: runtimeDiag.browserConnectCount,
        lastFailure: runtimeDiag.lastCdpFailure || null,
        lastFailureAgeSec: runtimeDiag.lastCdpFailureAt
          ? Math.round((Date.now() - runtimeDiag.lastCdpFailureAt) / 1000) : null,
      },
      autosync: readInfraStatus(INFRA_STATUS_FILES.autosync),
      chromeKeeper: readInfraStatus(INFRA_STATUS_FILES.chromeKeeper),
    },
  };
};

const heartbeatBot = async () => {
  await postJson('/api/bot/heartbeat', {
    botId: BOT_ID,
    accountIds: ACCOUNT_IDS,
    host: BOT_HOST,
    version: BOT_VERSION,
    meta: buildWorkerDailyMeta(),
  });
  // Flush behavior log buffer to cloud
  if (behaviorBuffer.length >= FLUSH_AT) {
    const batch = behaviorBuffer.splice(0);
    postJson('/api/automation/behavior-logs', { logs: batch }).catch((e) => {
      console.error(`[bot-real] behavior-logs flush failed (${batch.length} entries):`, e?.message || e);
    });
  }
};

const reportCommand = async (commandId: string, status: 'done' | 'failed', reason?: string) => {
  const payload: Record<string, any> = { botId: BOT_ID, commandId, status };
  if (reason) payload.reason = reason;
  await postJson('/api/automation/report', payload);
};

// 2026-08-07: 把每次互动写进 harvests DB 的 artist_interactions 时间线 + 同步 artists.stage，
// 使前台 ShopOutreach 能看到每个 lead 的接触历史（点赞/评论/关注/DM/回关）。
const recordInteraction = async (handle: string, eventType: string, detail: Record<string, any> = {}) => {
  if (!handle) return;
  const cleanHandle = String(handle).replace(/^@/, '').trim();
  const preview = detail?.text ? ' :: ' + String(detail.text).slice(0, 80) : '';
  console.log(`[bot-real] interaction: ${eventType} @${cleanHandle}${preview}`);
  try {
    await postJson('/api/automation/interaction', {
      botId: BOT_ID,
      artistHandle: cleanHandle,
      eventType,
      detail
    });
  } catch (e) {
    console.warn(`[bot-real] interaction FAILED (${eventType} @${cleanHandle}):`, e?.message || e);
  }
};

// Kills any orphaned Chromium still holding our profile directory — e.g. a
// persistent browser whose JS handle died (page crash / context lost) but the
// OS process lingers and keeps SingletonLock. Without this, a relaunch hits
// "Opening in existing browser session" and the bot loops forever (seen
// 2026-08-08: browser crashed ~8min in, then 12 retries all failed).
// NOTE: this does a host-wide `taskkill /IM chrome.exe` on Windows. On a host
// running multiple bot accounts (matrix), scope this by --user-data-dir instead.
const clearProfileLock = () => {
  const ud = path.resolve(process.cwd(), PROFILE_DIR);
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'SingletonTimedLock'];
  // 必须先杀孤儿 chrome，再删锁文件：活进程以独占方式握着 SingletonLock（ERROR code 32），
  // 文件被打开时 fs.rmSync 删不掉。VPS 专用机，直接整机关所有 chrome 最可靠。
  try {
    if (process.platform === 'win32') {
      try { execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore', windowsHide: true }); }
      catch { /* 没有 chrome 在跑也正常 */ }
    } else {
      try { execSync(`pkill -f "${ud}" || true`, { stdio: 'ignore', windowsHide: true }); } catch {}
    }
  } catch (e) {
    console.warn('[bot-real] clearProfileLock: kill failed:', (e as any)?.message);
  }
  // 进程已死、锁文件不再被占用，删除残留锁文件。删不掉会在下一轮重试（ensureBrowser 有 12 次退避）兜底。
  for (const f of lockFiles) {
    try { fs.rmSync(path.join(ud, f), { force: true }); } catch {}
  }
};

// 🔴 2026-09-19 实测：esbuild/tsx 的 keepNames 会给 `page.evaluate()` 回调里的**具名函数**
//   （`const f = () => {}` / `function f(){}` / 对象方法）注入 `__name(fn, "f")`；
//   而 `__name` 只定义在 Node 模块作用域 —— 回调是序列化后丢进浏览器执行的，
//   浏览器里没有这个标识符 ⇒ `ReferenceError: __name is not defined`
//   ⇒ 被 `.catch(() => null)` 静默吞掉 ⇒ 整段 DOM 解析返回空。**日志上看不出任何报错。**
//   实测后果（两处都是"静默失明"）：
//     ① own_followers.probe 恒 null ⇒ 分不清「真 0 粉」和「选择器读不到」，涨粉策略无从验收；
//     ② extractPostComments 恒 0 条评论 ⇒ 回扫找不到回复者 ⇒ 回赞/回关的输入端整条断掉。
//   修法：把 __name 补进页面全局。**必须用字符串形式**传入（写成函数字面量会被 esbuild 再处理一次）；
//   `||` 保证幂等、不覆盖页面已有值；WeakSet 保证每个 page 只装一次（重新导航由 addInitScript 自动覆盖）。
const EVAL_SHIM_SRC = 'globalThis.__name = globalThis.__name || function (t) { return t };';
const evalShimInstalled = new WeakSet<object>();
const installEvalShim = async (p: Page) => {
  if (evalShimInstalled.has(p)) return;
  evalShimInstalled.add(p);
  try { await p.addInitScript(EVAL_SHIM_SRC); } catch {}  // 该页之后的所有导航
  try { await p.evaluate(EVAL_SHIM_SRC); } catch {}       // 当前已加载的那个文档
};

const ensureBrowser = async () => {
  // 已有一个在 instagram.com 的页面 → 直接复用，绝不重新开浏览器（避免多标签堆积）。
  if (context && page) {
    try {
      const url = page.url();
      if (url && url.includes('instagram.com')) { await installEvalShim(page); return; }
    } catch {}
    // 有 context 但页面不在 IG（卡在 about:blank 等）→ 先关干净，再重建，不留孤儿。
    try { await context.close(); } catch {}
    context = null as any; page = null as any;
  }

  // Retry with backoff. 关键：每一次重试前，上一轮若已半启动了一个浏览器/标签页，
  // 必须在 catch 里把它 context.close() 掉 —— 否则孤儿浏览器 + 孤儿标签会越积越多
  // （之前"七八个 about:blank"就是这样来的：12 次重试每次都 newPage 且不清旧进程）。
  // 2026-09-17：内层重试改短（3 次 × 5s 退避）。
  // 旧值 4 次 × 8s 退避 + 每次 30s 连接超时 ⇒ 单次 ensureBrowser 最坏 2.5 分钟，
  // 而外层（bootstrap）现在会无限重试 ⇒ 内层只需"快速判定 + 快速交还"，不要长时间占着。
  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = 5_000;
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (BOT_LAUNCH_MODE === 'persistent') {
        // Persistent context: Playwright's own browser, navigator.webdriver removed automatically.
        // Login session is saved in the profile directory.
        const profilePath = path.resolve(process.cwd(), PROFILE_DIR);
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
        // 🔴 每次启动前：杀光所有孤儿 chrome + 删残留锁文件，确保不会撞 ProcessSingleton，
        //    也不会因为上一次没退干净的 chrome 而反复失败重试。
        clearProfileLock();
        context = await chromium.launchPersistentContext(profilePath, {
          headless: HEADLESS,
          viewport: { width: 1280, height: 900 },
          args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
          ],
        }) as any;
        // 🔴 单标签铁律：Playwright 启动 persistent 时第一个页永远是 about:blank，
        // 直接复用它并导航到 IG，绝不 newPage 开第二个/第三个标签。
        const allPages = (context as any).pages?.() || [];
        page = allPages[0] || (await (context as any).newPage());
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // 关掉当前页之外的一切标签（任何残留 about:blank / 其它页），保证永远只有唯一一个 IG 标签。
        for (const p of ((context as any).pages?.() || [])) {
          if (p !== page) { try { await p.close(); } catch {} }
        }
        await page.bringToFront().catch(() => {});
        if (page) await installEvalShim(page);
        console.log('[bot-real] launched persistent browser (stealth mode)');
        runtimeDiag.browserConnectedAt = Date.now();
        runtimeDiag.browserConnectCount += 1;
        runtimeDiag.lastCdpFailure = '';
        return;
      }

      // CDP mode (legacy): connect to an already-running Chrome.
      if (!BOT_CDP_URL) throw new Error('cdp_required_set_BOT_CDP_URL_or_use_BOT_LAUNCH_MODE_persistent');
      // 🔴 2026-09-17：先 5s 探活，再连。失败原因写进 out 日志，不再是一句干巴巴的 timeout。
      const pre = await probeCdpHttp();
      if (!pre.ok) {
        throw new Error(`cdp_unreachable(${BOT_CDP_URL}) → ${pre.reason}。需要重启 9222 那个 Chrome 窗口（scripts\\repair-bot-runner.ps1 第 4 步）`);
      }
      // 🔴 2026-09-17 二修：HTTP 通 ≠ 协议通。
      // VPS 实测 line: `<ws connected>` 之后 `connectOverCDP: Timeout 20000ms exceeded`
      // = Chrome 主线程假死（协议冻结）。HTTP 探活查不出，只会给一句没信息量的 timeout。
      const proto = await probeCdpProtocol();
      if (!proto.ok) {
        throw new Error(
          `cdp_protocol_frozen(${BOT_CDP_URL}) → ${proto.reason}。` +
          `端口通、WS 能握手，但 CDP 命令无响应（Chrome 主线程卡死，HTTP 探活看不出来）。` +
          `bot 自己不动这个 Chrome（9222 是三进程共用）—— 请跑 scripts\\repair-bot-runner.ps1 第 4 步重启它。`
        );
      }
      // 僵尸 page target 会让 connectOverCDP 逐 target attach 时整体卡死（重启后 Chrome
      // 常一次带出 6 个恢复标签）。连接前先清成单标签。
      await healCdpTargets();
      browser = await chromium.connectOverCDP(BOT_CDP_URL, { timeout: CDP_CONNECT_TIMEOUT_MS });
      // 🔴 2026-09-17：**不能**再 `browser.contexts()[0] || await browser.newContext()`。
      // Playwright 在 CDP 连接上不支持 newContext()，而旧代码又会在任务失败时
      // `page.context().close()` —— 那关掉的正是外部 Chrome 的**默认 context**。
      // 于是"默认 context 没了 → newContext() 抛错 → 4 次重试全败 → ensureBrowser 抛错"
      // 彻底自锁：Chrome 明明活着（/json/version 能答），bot 却永远连不上，
      // 表现就是心跳正常、任务一条不动。这里直接把真因说清楚。
      context = browser.contexts()[0] || null;
      if (!context) {
        throw new Error('cdp_no_default_context：外部 Chrome 的默认 context 已消失（多半被上一次任务失败时的 context.close() 关掉了）。请重启 9222 的 Chrome 窗口。');
      }
      const existingPages = context.pages();
      if (existingPages.length > 0) {
        for (const p of existingPages) {
          try {
            const u = p.url();
            if (u && u.includes('instagram.com')) { page = p; break; }
          } catch {}
        }
      }
      if (!page) {
        page = await context.newPage();
        try {
          await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
          });
        } catch {}
        await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
      await page.bringToFront().catch(() => {});
      if (page) await installEvalShim(page);
      console.log(`[bot-real] connected via CDP: ${BOT_CDP_URL}`);
      // 时间戳（不是布尔值）：前台要能看出「连接是 3 秒前刷新的」还是「2 小时前刷新的」。
      runtimeDiag.browserConnectedAt = Date.now();
      runtimeDiag.browserConnectCount += 1;
      runtimeDiag.lastCdpFailure = '';
      return;
    } catch (e) {
      lastErr = e;
      logFatal(`[bot-real] browser ensure attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e?.message || e}`);
      // 让心跳把「连不上 Chrome 的原因」带到前台（否则前台只能看到一段没有产出的静默）
      runtimeDiag.lastCdpFailure = String(e?.message || e).slice(0, 180);
      runtimeDiag.lastCdpFailureAt = Date.now();
      // 🔴 2026-09-17：CDP 模式下 **绝不** `context.close()`。
      // 那关掉的是外部 Chrome 的默认 context（= 把浏览器端所有标签一起关），
      // 关完连下一个进程都连不上 → 变成永久自锁。CDP 模式只回收本进程的半残标签。
      try {
        if (BOT_LAUNCH_MODE === 'persistent') {
          if (context) await context.close();
        } else if (page) {
          await page.close().catch(() => {});
        }
      } catch {}
      context = null as any; page = null as any;
      // 断掉本次 CDP 连接的引用（★ 不要 browser.close()：那会真的把外部 Chrome 关掉）
      browser = null as any;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS);
      }
    }
  }
  throw new Error(`ensureBrowser failed after ${MAX_ATTEMPTS} attempts: ${lastErr?.message || lastErr}`);
};

const reportObservation = async (command: CommandPayload, summary: BrowseSummary, profileFacts?: Record<string, any>) => {
  const payload: Record<string, any> = {
    botId: BOT_ID,
    commandId: command.id,
    artistId: command.artistId || null,
    artistHandle: command.artistHandle || null,
    mode: BOT_EXEC_MODE,
    summary,
    profileFacts: profileFacts || {}
  };
  await postJson('/api/bot/observe', payload);
};

const ensureExecMode = (mode: string) => {
  if (mode !== 'browse_only' && mode !== 'browse_like') {
    throw new Error(`invalid_exec_mode_${mode}`);
  }
};

const ensureBrowserLegacyLaunchDisabled = () => {
  // Legacy launch intentionally disabled in CDP-first workflow.
  // This prevents accidental opening of a new browser/profile.
  return;
};

const openProfile = async (handle: string) => {
  if (!page) throw new Error('page_not_initialized');
  handle = toBareHandle(handle); // 关键：把完整 URL/@ 前缀收敛成裸 handle，避免导航到 instagram.com/https://... 失败
  if (!handle) { logBehavior('open_profile_empty', {}); return; }
  const url = `${IG_BASE}/${handle}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const dwell = jitter(1500, 3200);
  await page.waitForTimeout(dwell);
  logBehavior('open_profile', { handle, dwellMs: dwell });
  logBehavior('open_profile_done', { handle, currentUrl: page.url() });

  // ── Follow-back detection (self-learning feedback) ──
  // Only check accounts we previously followed; detect "Follows you" →
  // report to server + create a DM marketing task for follow-up outreach.
  const prevFollow = likeState.follows?.byHandle?.[handle];
  if (prevFollow?.followedAt && !prevFollow.followBackDetected) {
    try {
      const followsYou = await page.locator('text="Follows you"').first().isVisible({ timeout: 2000 }).catch(() => false);
      if (followsYou) {
        const st = likeState.follows!.byHandle![handle] as any;
        if (!countryCache[handle]) countryCache[handle] = { country: inferCountryFromHandle(handle) };
        st.country = st.country || countryCache[handle].country;
        st.followBackDetected = true;
        st.followBackDetectedAt = Date.now();
        // 预热窗口：回关后不秒发 DM，等 BOT_DM_WARMUP_HOURS 后再由 syncFollowBackDmQueue 直接发 DM
        st.dmEligibleAt = BOT_DM_WARMUP_HOURS > 0 ? Date.now() + BOT_DM_WARMUP_HOURS * 3600_000 : 0;
        st.dmSent = false;
        saveLikeState(likeState);
        logBehavior('follow_back_detected', { handle });
        // 回关即互动作：给对方帖子点个赞建立好感（关系先行，再发购买向 DM）
        try {
          const firstPost = page.locator('a[href*="/p/"]').first();
          if ((await firstPost.count()) > 0) {
            await firstPost.click({ timeout: 8000 });
            await page.waitForTimeout(jitter(1500, 3000));
            const likeBtn = page.locator('svg[aria-label="Like"]').first();
            if ((await likeBtn.count()) > 0) await likeBtn.click({ timeout: 6000 }).catch(() => {});
            await page.waitForTimeout(jitter(1000, 2000));
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(jitter(500, 1200));
            recordInteraction(handle, 'like', { rapport: true, reason: 'follow_back' }).catch(() => {});
            // 同步计入 rapport 阶梯，使 syncFollowBackDmQueue 的"熟悉度门槛"能识别到已点赞
            if (!st.rapport) st.rapport = { likedPosts: 0, lastLikeAt: 0, firstLikeAt: 0, commentedAt: 0, commentLikedAt: 0 };
            st.rapport.likedPosts = (st.rapport.likedPosts || 0) + 1;
            st.rapport.lastLikeAt = Date.now();
            if (!st.rapport.firstLikeAt) st.rapport.firstLikeAt = Date.now();
            saveLikeState(likeState);
          }
        } catch {}
        // 写入 harvests DB：前台可见「已回关」阶段 + follow_back 时间线
        recordInteraction(handle, 'follow_back', { followBackDetectedAt: st.followBackDetectedAt }).catch(() => {});
      }
    } catch {}
  }
  // 2026-08-07：帖子语言检测（回关相关号、未缓存才做）——看对方帖子实际用什么语言，DM/评论优先用它
  try {
    if (!langCache[handle] && (likeState.follows?.byHandle?.[handle] || countryCache[handle])) {
      await detectLangForHandle(handle);
    }
  } catch {}
};

const isInvalidProfilePage = async () => {
  if (!page) return false;
  const url = page.url().toLowerCase();
  if (url.includes('/accounts/login')) return true;
  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  return (
    bodyText.includes("sorry, this page isn't available") ||
    bodyText.includes('the link you followed may be broken') ||
    bodyText.includes('page not found') ||
    bodyText.includes('user not found')
  );
};

// ── 登录闸门（2026-08-08 重写）：未登录/挑战页时暂停一切任务派发，原地等用户登录，
//    不抢任务、不标 failed；每次校验主动跳回 IG 首页强制重判会话（persistent profile 会话
//    过期会被 IG 踢回登录页，不导航就发现不了）；并用正向"已登录"信号兜底 ──
// 登录闸门的"为什么在等"——用于把**不可见的静默等待**变成 D1 里可见的事件。
// 2026-09-17 那 13 小时静默里最缺的就是这一条：循环在等，但没人知道它在等什么。
let loginGateNote = '';
let loginGateLoggedAt = 0;
const LOGIN_GATE_LOG_EVERY_MS = 10 * 60_000;
// 把「循环在等」写进 D1（节流 10 分钟），这样前台/查询就能看见 bot 到底卡在哪一道闸，
// 而不是只看到"心跳正常"和一片空白。
const noteLoginGate = (reason: string, extra: Record<string, any> = {}) => {
  loginGateNote = reason;
  const now = Date.now();
  if (now - loginGateLoggedAt < LOGIN_GATE_LOG_EVERY_MS) return;
  loginGateLoggedAt = now;
  console.log(`[bot-real] ⏸ login gate: ${reason} — task execution paused, heartbeat alive.`);
  logBehavior('login_gate_waiting', { reason, ...extra });
};
const clearLoginGateNote = () => {
  if (!loginGateLoggedAt) return;
  loginGateLoggedAt = 0;
  loginGateNote = '';
  logBehavior('login_gate_resumed', {});
};
const isOnLoginPage = async (): Promise<boolean> => {
  if (!page) return true; // 没页面一律当未登录，安全等待
  try {
    const url = (page.url() || '').toLowerCase();
    if (url.includes('/accounts/login')) return true;
    if (url.includes('/challenge/')) return true;        // 安全挑战页（确认是你/短信验证）
    if (url.includes('/accounts/onetap')) return true;
    if (url.includes('/accounts/emailsignup')) return true;
    // 登录页才有 username 输入框（用户正输入用户名时也算"未登录"）
    // ⚠️ 2026-09-18：count() 是协议调用，CDP 半死时会**永不返回**（catch 接不住"挂住"）
    //    ⇒ 用本地计时兜底；超时按「无法确认 = 视为未登录」处理，宁可不干活也不瞎干。
    const loginInputCount = await withTimeout(page.locator('input[name="username"]').count(), PW_CALL_TIMEOUT_MS, 'login_input_count');
    if (loginInputCount === null) { loginGateNote = 'login_probe_timeout'; return true; }
    if (loginInputCount > 0) return true;
    // 部分挑战页用其他字段
    const challengeInput = await withTimeout(page.locator('input[name="security_code"], input[name="email"]').count(), PW_CALL_TIMEOUT_MS, 'challenge_input_count');
    if (challengeInput === null) { loginGateNote = 'challenge_probe_timeout'; return true; }
    if (challengeInput > 0) return true;
  } catch {}
  return false;
};

// ── 账号休息（被动，2026-08-10）：IG 弹出"操作被限制/稍后再试/暂时被封"等信号时，
//    整个账号停止一切动作（点赞/评论/关注/DM/回关复检），按严重程度休息 4–72h，
//    并把这次休息记入数据（recordInteraction 'account_rest'，前台可见），休息完自动恢复。
//    信号源自真实 DOM 文本，故为"数据驱动"——IG 没说限流就不休息；bot 重启也继续休息。 ──
const BLOCK_PATTERNS: { re: RegExp; severity: 'soft' | 'hard' | 'checkpoint' }[] = [
  // 硬封：临时封禁 / 禁止关注·点赞·评论 —— 长休息
  { re: /temporarily blocked|we('|’)?ve temporarily|blocked from (following|liking|commenting|doing this)/i, severity: 'hard' },
  // 软封：操作被拦截 / 稍后再试 / 请求过多 / 限制频率 —— 中休息
  { re: /action (was )?blocked|this action has been blocked|we restrict certain activity|please try again later|try again later|too many requests|too many (actions|attempts)|limit how often you (can )?do/i, severity: 'soft' },
  // 验证/安全检查：确认非机器人 / 异常活动 / 验证身份 —— 中短休息
  { re: /confirm you('|’)?re (not )?a (robot|human)|security check|unusual (login )?activity|verify your (identity|account)|suspicious (login )?activity/i, severity: 'checkpoint' },
];

// 扫描当前页面（body + 所有 dialog）是否出现 IG 限制信号。返回 severity + 原文，或 null。
const detectBlockSignal = async (): Promise<{ severity: string; text: string } | null> => {
  if (!page) return null;
  try {
    const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
    const dialogTexts = (await page.locator('div[role="dialog"]').allInnerTexts().catch(() => [] as string[])) || [];
    const text = (bodyText + ' ' + dialogTexts.join(' ')).toLowerCase();
    // 先粗筛强信号词，避免普通帖子正文误触发
    if (!/(block|restrict|temporarily|suspicious|verify|security check|unusual activity|too many)/i.test(text)) return null;
    for (const p of BLOCK_PATTERNS) {
      const m = text.match(p.re);
      if (m) return { severity: p.severity, text: m[0].slice(0, 140) };
    }
  } catch {}
  return null;
};

// 休息时长：按严重程度 + 账号阶段（新/过渡账号封得狠，休息加倍）
const getRestCooldownMs = (severity: string): number => {
  const stage = String(lastAccountStage || 'stable').toLowerCase();
  const young = stage === 'new' || stage === 'transition';
  if (severity === 'hard') return Math.round(jitter(24 * 3600_000, 72 * 3600_000) * (young ? 1.5 : 1));
  if (severity === 'checkpoint') return jitter(2 * 3600_000, 6 * 3600_000);
  return jitter(4 * 3600_000, 12 * 3600_000); // soft
};

const isAccountResting = (): boolean => {
  const r = likeState.rest;
  return !!r && typeof r.until === 'number' && Date.now() < r.until;
};

// 触发账号休息：停止一切动作直到冷却结束，记入数据，离开限制页
const triggerAccountRest = async (severity: string, text: string) => {
  if (isAccountResting()) return; // 已在休息中不重复触发
  const cooldown = getRestCooldownMs(severity);
  likeState.rest = {
    until: Date.now() + cooldown,
    reason: text,
    severity,
    at: Date.now(),
    count: (likeState.rest?.count || 0) + 1,
  };
  saveLikeState(likeState);
  breakUntil = Math.max(breakUntil, likeState.rest.until); // 同时挂起拟人休息逻辑
  logBehavior('account_rest_triggered', {
    severity,
    text,
    restUntil: new Date(likeState.rest.until).toISOString(),
    restCount: likeState.rest.count,
  });
  console.log(`[bot-real] 🛑 ACCOUNT REST (${severity}): "${text}". Resting until ${new Date(likeState.rest.until).toISOString()} (~${Math.round(cooldown / 3600_000)}h). All actions paused; heartbeat/login kept alive.`);
  // 记入数据：账号级事件（event_type=account_rest 不进客户 funnel 的 like/follow/dm 计数，前台可见"账号休息"）
  recordInteraction(BOT_ID, 'account_rest', { severity, reason: text, restUntil: likeState.rest.until }).catch(() => {});
  // 离开限制对话框，回到 IG 首页，避免弹窗卡住后续流程
  if (page) { try { await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {} }
};

// 🔴 登录闸门修复（2026-08-09）：之前用「正向标记」（Home svg / inbox 链接）判断已登录，
// 但页面刚加载或 IG DOM 微调时这些标记缺失 → 误判 login state unclear 并永久暂停，
// 而其实会话有效（任务已跑成）。改为：只要 URL 在 instagram.com 且不在登录/挑战页就放行；
// 仅当确认在登录/挑战页、或页面根本没加载到 IG（about:blank）时才等待/暂停。
const waitUntilLoggedIn = async (): Promise<boolean> => {
  // page 为 null 时先尝试拉起浏览器，避免在"无页面"状态下误判已登录去抢任务
  if (!page) {
    try { await ensureBrowser(); } catch {}
  }
  if (!page) {
    console.log('[bot-real] ⏸  browser not ready — pausing task execution (will retry).');
    return false;
  }
  let printed = false;
  for (let i = 0; i < 180; i++) { // 最多等 ~15 分钟
    try {
      // 在登录/挑战页：不导航，避免打断用户正在输入的登录框，原地等
      if (await isOnLoginPage()) {
        if (!printed) {
          console.log('[bot-real] ⏸  NOT logged in / challenge — pausing ALL task execution. Finish logging in on the IG window (username + password), then the bot auto-resumes. No tasks will be grabbed or marked failed while waiting.');
          printed = true;
        }
        noteLoginGate(loginGateNote || 'on_login_or_challenge_page', { url: String(page?.url?.() || '').slice(0, 200) });
        await sleep(5000);
        continue;
      }
      // 不在登录页 → 主动跳回 IG 首页，强制 IG 重新校验会话（过期会重定向到登录页）
      await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      try { await page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch {}
      // 跳回后可能已被踢到登录页
      if (await isOnLoginPage()) {
        if (!printed) {
          console.log('[bot-real] ⏸  session expired (redirected to login) — pausing ALL task execution, waiting for you to log in. No tasks grabbed or marked failed.');
          printed = true;
        }
        noteLoginGate(loginGateNote || 'session_expired_redirect_to_login', { url: String(page?.url?.() || '').slice(0, 200) });
        await sleep(5000);
        continue;
      }
      // 🔴 关键：不再依赖脆弱 DOM 正向标记。只要 URL 在 instagram.com 且不在登录/挑战页 → 视为已登录放行。
      const urlNow = (page.url() || '').toLowerCase();
      if (!urlNow.includes('instagram.com')) {
        // 页面还没真正加载到 IG（可能 about:blank / 加载失败）→ 重试，不误判为已登录去操作空白页
        if (!printed) {
          console.log('[bot-real] ⏸  page not on instagram.com yet (still loading/blank) — waiting for load.');
          printed = true;
        }
        noteLoginGate('page_not_on_instagram', { url: String(page?.url?.() || '').slice(0, 200) });
        await sleep(5000);
        continue;
      }
      if (!printed) {
        console.log('[bot-real] ✅ login confirmed (on instagram.com, not on login/challenge) — resuming tasks.');
        printed = true;
      }
      clearLoginGateNote();
      return true;
    } catch {}
    await sleep(5000);
  }
  return false;
};

// Detect and escape Instagram follow-suggestions / explore-people trap page.
const escapeFollowTrap = async () => {
  if (!page) return;
  const url = page.url().toLowerCase();
  const isTrapUrl = url.includes('/explore/people/') || url.includes('/explore/');
  if (!isTrapUrl) return;
  logBehavior('follow_trap_detected', { url: page.url() });
  await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(jitter(2000, 3500));
  logBehavior('follow_trap_escaped', { landedUrl: page.url() });
};

const waitForProfileGridReady = async () => {
  if (!page) throw new Error('page_not_initialized');
  // Wait until profile container is visible.
  await page.waitForSelector('main', { state: 'visible', timeout: 20000 });

  // Wait for post/reel tiles to appear. Retry with gentle scroll if lazy-loaded.
  let ready = false;
  for (let i = 0; i < 3; i++) {
    const mediaCount = await page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]').count();
    if (mediaCount > 0) {
      ready = true;
      break;
    }
    await page.waitForTimeout(jitter(1200, 2600));
    await page.mouse.wheel(0, jitter(120, 280)); // tiny nudge to trigger lazy load
  }

  if (!ready) {
    // Continue anyway, but leave a strong signal in logs.
    logBehavior('grid_ready_timeout', { reason: 'no_media_tile_found' });
  } else {
    // Give UI time to fully paint thumbnails/text.
    await page.waitForTimeout(jitter(1800, 3600));
    logBehavior('grid_ready', { ok: true });
  }
};

const waitForMinVisibleTiles = async () => {
  if (!page) throw new Error('page_not_initialized');
  const tileSelector = 'article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]';
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const visibleCount = await page.locator(`${tileSelector}:visible`).count();
    if (visibleCount >= BOT_MIN_VISIBLE_TILES) {
      logBehavior('visible_tiles_ready', { visibleCount, minRequired: BOT_MIN_VISIBLE_TILES, attempt });
      return;
    }
    logBehavior('visible_tiles_wait', { visibleCount, minRequired: BOT_MIN_VISIBLE_TILES, attempt });
    await page.waitForTimeout(jitter(1000, 2200));
    await page.mouse.wheel(0, jitter(80, 220));
  }
  const finalVisible = await page.locator(`${tileSelector}:visible`).count();
  logBehavior('visible_tiles_timeout', { visibleCount: finalVisible, minRequired: BOT_MIN_VISIBLE_TILES });
};

const browseProfileDeep = async (): Promise<BrowseSummary> => {
  if (!page) throw new Error('page_not_initialized');
  const expectedHandle = profileHandleFromUrl(page.url());
  await waitForProfileGridReady();
  await waitForMinVisibleTiles();

  // Gentle profile scroll to simulate reading bio/grid.
  await humanMouseMove();
  const scrollRounds = randInt(3, 6);
  for (let i = 0; i < scrollRounds; i++) {
    const wheel = jitter(350, 900);
    const pause = jitter(800, 2200);
    await page.mouse.wheel(0, wheel);
    await page.waitForTimeout(pause);
    await humanHover();
    logBehavior('profile_scroll', { wheelPx: wheel, pauseMs: pause });
  }

  // Open media posts/reels with retries. Dynamic amount based on profile content size.
  const mediaLocator = page.locator('a[href*="/p/"], a[href*="/reel/"]');
  let totalMedia = await mediaLocator.count();
  if (totalMedia === 0) {
    await page.waitForTimeout(jitter(1200, 2800));
    // One extra scroll and retry in case grid loads late.
    await page.mouse.wheel(0, jitter(450, 1000));
    await page.waitForTimeout(jitter(1000, 2400));
    totalMedia = await mediaLocator.count();
  }
  logBehavior('media_candidates', { totalMedia });

  // 2026-08-07: 硬性收敛浏览打开数到 ≤2。原逻辑对多帖 profile 会打开 8 个 modal，
  // 每个 ~25s，叠加评分+点赞的 modal 后总时长爆看门狗 → 大批任务 task_timeout。
  // 浏览只是"观察"，非必需动作，必须压住单任务模态数。
  let minOpen = 1;
  let maxOpen = 2;

  // Session-depth randomness: mostly normal, sometimes light, sometimes deep.
  const r = Math.random();
  let desiredOpenCount = randInt(minOpen, maxOpen);
  if (r < 0.2) {
    desiredOpenCount = Math.max(1, desiredOpenCount - 1); // light session
  } else if (r > 0.9) {
    desiredOpenCount = Math.min(maxOpen + 2, desiredOpenCount + 2); // deep session
  }
  desiredOpenCount = Math.min(desiredOpenCount, Math.max(1, totalMedia));

  const candidateCount = Math.min(totalMedia, 18);
  const candidates: Array<{ idx: number; score: number; tattooHits: number; negativeHits: number; isReel: boolean; postKey: string }> = [];
  const candidateByIdx = new Map<number, { idx: number; score: number; tattooHits: number; negativeHits: number; isReel: boolean; postKey: string }>();
  const seenCandidateKeys = new Set<string>();
  for (let idx = 0; idx < candidateCount; idx++) {
    try {
      const tile = mediaLocator.nth(idx);
      const href = String((await tile.getAttribute('href').catch(() => '')) || '');
      const postKey = extractPostKey(href) || `idx_${idx}`;
      if (seenCandidateKeys.has(postKey)) continue;
      seenCandidateKeys.add(postKey);
      const alt = String((await tile.locator('img[alt]').first().getAttribute('alt').catch(() => '')) || '');
      const aria = String((await tile.getAttribute('aria-label').catch(() => '')) || '');
      const blob = normalizeForMatch(`${href} ${alt} ${aria}`);
      const tattooHits = keywordHits(blob, POSITIVE_KEYWORDS).length;
      const negativeHits = keywordHits(blob, NEGATIVE_KEYWORDS).length;
      const promoHits = keywordHits(blob, PROMO_KEYWORDS).length;
      const isReel = /\/reel\//i.test(href);

      let score = 0;
      score += tattooHits * 3;
      score -= negativeHits * 4;
      score -= promoHits * 3;
      if (idx < 3) score += 2; // likely pinned/featured zone
      if (isReel) score -= 1; // reels轻降权，避免过多蹭热视频
      score += Math.random() * 1.5; // 同分时随机化，避免固定模式

      const row = { idx, score, tattooHits, negativeHits, isReel, postKey };
      candidates.push(row);
      candidateByIdx.set(idx, row);
    } catch {
      const row = { idx, score: Math.random(), tattooHits: 0, negativeHits: 0, isReel: false, postKey: `idx_${idx}` };
      candidates.push(row);
      candidateByIdx.set(idx, row);
    }
  }

  // 按分排序后，从高分池随机抽样，避免顺序点击。
  candidates.sort((a, b) => b.score - a.score);
  let selectionPool = candidates;
  if (BOT_BROWSE_ORDER === 'newest') {
    selectionPool = [...candidates].sort((a, b) => a.idx - b.idx);
  } else {
    const poolSize = Math.max(desiredOpenCount, Math.ceil(candidates.length * 0.65));
    selectionPool = candidates.slice(0, Math.min(candidates.length, poolSize));
  }
  const chosen: number[] = [];
  const used = new Set<number>();
  while (chosen.length < desiredOpenCount && used.size < selectionPool.length) {
    const pick = selectionPool[randInt(0, selectionPool.length - 1)];
    if (!pick || used.has(pick.idx)) continue;
    used.add(pick.idx);
    chosen.push(pick.idx);
  }
  if (chosen.length < desiredOpenCount) {
    const fallback = candidates.map((c) => c.idx).filter((idx) => !used.has(idx));
    fallback.sort(() => Math.random() - 0.5);
    for (const idx of fallback) {
      if (chosen.length >= desiredOpenCount) break;
      chosen.push(idx);
    }
  }
  logBehavior('browse_selection', {
    totalMedia,
    candidateCount,
    desiredOpenCount,
    selected: chosen,
    topScores: candidates.slice(0, 8).map((c) => ({ idx: c.idx, score: Number(c.score.toFixed(2)), tattooHits: c.tattooHits, negativeHits: c.negativeHits, isReel: c.isReel }))
  });

  let opened = 0;
  const openedPostKeys = new Set<string>();
  for (let i = 0; i < chosen.length && opened < desiredOpenCount; i++) {
    const idx = chosen[i];
    const c = candidateByIdx.get(idx);
    if (c?.postKey && openedPostKeys.has(c.postKey)) continue;
    try {
      await mediaLocator.nth(idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(900, 2200)); // allow tile to fully render in viewport
      await humanMouseMove();
      await mediaLocator.nth(idx).click({ timeout: 12000 });
    } catch {
      // Try JS click fallback
      try {
        await mediaLocator.nth(idx).evaluate((el: any) => el.click());
      } catch {
        continue;
      }
    }
    const meta = await readModalMeta('', expectedHandle);
    const ownerOk = meta?.isOwnerPost !== false;
    const tattooSignal = Number((c?.tattooHits || 0) + (meta?.positive || 0) + (meta?.styleBoost || 0));
    const modalPostKey = String(meta?.postKey || c?.postKey || '');
    if (modalPostKey && openedPostKeys.has(modalPostKey)) {
      await closeModal().catch(() => {});
      continue;
    }
    if (!ownerOk) {
      logBehavior('browse_skip_non_owner_post', { postIndex: idx, ownerHandle: meta?.ownerHandle || '', expectedHandle });
      await closeModal().catch(() => {});
      continue;
    }
    if (tattooSignal <= 0) {
      logBehavior('browse_skip_low_tattoo_signal', { postIndex: idx, ownerHandle: meta?.ownerHandle || '', expectedHandle, tattooSignal });
      await closeModal().catch(() => {});
      continue;
    }
    opened += 1;
    if (modalPostKey) openedPostKeys.add(modalPostKey);
    const watch = jitter(2500, 7000);
    await page.waitForTimeout(watch); // watch image/video
    logBehavior('open_post', { postIndex: idx, watchMs: watch, postKey: modalPostKey || c?.postKey || '', ownerHandle: meta?.ownerHandle || '', tattooSignal });

    const nextBtn = page.locator('button[aria-label="Next"], button[aria-label="下一步"]').first();
    if (await nextBtn.count()) {
      // Occasionally browse one more media item in modal.
      if (Math.random() < 0.35) {
        let movedNext = false;
        try {
          await nextBtn.click({ timeout: 2500 });
          movedNext = true;
        } catch {
          try {
            await nextBtn.evaluate((el: any) => el.click());
            movedNext = true;
          } catch {
            try {
              await page.keyboard.press('ArrowRight');
              movedNext = true;
            } catch {}
          }
        }
        if (movedNext) {
          const nextWatch = jitter(1800, 4500);
          await page.waitForTimeout(nextWatch);
          const nextKey = extractPostKey(page.url());
          if (nextKey) openedPostKeys.add(nextKey);
          logBehavior('next_post', { watchMs: nextWatch });
        } else {
          logBehavior('next_post_skip', { reason: 'click_intercepted' });
        }
      }
    }

    const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="鍏抽棴"]').first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click({ timeout: 5000 });
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(jitter(900, 2200));
  }
  const summary = { totalMedia, opened, desiredOpenCount };
  logBehavior('media_opened_total', summary);
  return summary;
};

const captureProfileFacts = async () => {
  if (!page) throw new Error('page_not_initialized');
  const url = page.url();
  let title = '';
  try {
    title = await page.title();
  } catch {}

  let statTexts: string[] = [];
  try {
    const statsLocator = page.locator('header section ul li span, header ul li span');
    const count = Math.min(await statsLocator.count(), 8);
    const vals: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = (await statsLocator.nth(i).innerText().catch(() => '')).trim();
      if (t) vals.push(t);
    }
    statTexts = vals;
  } catch {}

  let bio = '';
  try {
    const bioCandidates = [
      'header section h1',
      'header section div.-vDIg span',
      'header section div.x78zum5 span'
    ];
    for (const sel of bioCandidates) {
      const t = (await page.locator(sel).first().innerText().catch(() => '')).trim();
      if (t) {
        bio = t;
        break;
      }
    }
  } catch {}

  const facts: ProfileFacts = {
    url,
    title,
    statTexts,
    bio: bio.slice(0, 600)
  };

  // Parse post/follower/following counts from profile.
  // Instagram SPA prevents direct DOM access via CDP; use screenshot-based OCR as fallback.
  try {
    // Strategy A: try known anchor href selectors (may work on some layouts).
    let anchorFollowers = '';
    let anchorFollowing = '';
    try {
      // NOTE: no named functions inside page.evaluate — esbuild keepNames would inject
      // a browser-undefined `__name()` and crash at runtime. Inline the regex instead.
      const anchorCounts = await page.evaluate(() => {
        const re = /(\d[\d,.]*\s*[kKmM]?)/;
        const fA = document.querySelector('a[href*="/followers/"]');
        const gA = document.querySelector('a[href*="/following/"]');
        const fTitle = fA?.querySelector('span[title]')?.getAttribute('title') || '';
        const fText = fA?.textContent || '';
        const gTitle = gA?.querySelector('span[title]')?.getAttribute('title') || '';
        const gText = gA?.textContent || '';
        return {
          followers: (fTitle.match(re)?.[1]) || (fText.match(re)?.[1]) || '',
          following: (gTitle.match(re)?.[1]) || (gText.match(re)?.[1]) || '',
        };
      }).catch(() => null);
      if (anchorCounts) {
        anchorFollowers = anchorCounts.followers || '';
        anchorFollowing = anchorCounts.following || '';
      }
    } catch {}

    const followers = parseFirstNumberLike(anchorFollowers);
    const following = parseFirstNumberLike(anchorFollowing);
    if (followers > 0) facts.followers = followers;
    if (following > 0) facts.following = following;

    // Strategy B: locator-based extraction.
    try {
      const followerLoc = page.locator('a[href*="/followers/"]').first();
      const followingLoc = page.locator('a[href*="/following/"]').first();
      if (!facts.followers) {
        const ft = (await followerLoc.innerText({ timeout: 3000 }).catch(() => '')).trim();
        if (ft) facts.followers = parseCompactNumber(ft);
      }
      if (!facts.following) {
        const gt = (await followingLoc.innerText({ timeout: 3000 }).catch(() => '')).trim();
        if (gt) facts.following = parseCompactNumber(gt);
      }
    } catch {}

    // Strategy C: screenshot the stats row via OCR (layout-independent).
    // Stats appear as 3 numbers (posts / followers / following) in a horizontal row.
    if (BOT_OCR_ENABLED && (!facts.followers || !facts.following || !facts.postCount)) {
      try {
        const ssDir = path.resolve(process.cwd(), 'data', 'screenshots');
        if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
        const ts = Date.now();
        const handleSlug = profileHandleFromUrl(page.url()) || 'unknown';
        const statsPath = path.join(ssDir, `${handleSlug}_${ts}_stats.png`);

        // Screenshot a narrow top strip — stats row always appears near the top.
        // Note: page.evaluate() is blocked via CDP for Instagram, so we use a fixed clip
        // that works across window sizes (the stats row is positioned near y=0 regardless).
        await page.screenshot({ path: statsPath, clip: { x: 0, y: 0, width: 700, height: 180 }, type: 'png', timeout: 8000 });
        (facts as any)._statsScreenshot = statsPath;

        // OCR the stats strip to read post/follower/following numbers.
        try {
          const ocrText = await Promise.race<string>([
            (async () => {
              const worker = await createWorker('eng');
              const { data: { text } } = await worker.recognize(statsPath);
              await worker.terminate().catch(() => {});
              return text || '';
            })(),
            new Promise<string>((_, rej) => setTimeout(() => rej(new Error('ocr_timeout')), 8000)),
          ]).catch(() => '');
          (facts as any)._ocrStatsRaw = ocrText.slice(0, 200);

          // Multi-language patterns: "posts/帖子", "followers/粉丝", "following/关注"
          const postMatch = ocrText.match(/([\d,.]+\s*[kKmM]?)\s*(?:posts|post|帖子|帖|發佈|条)/i);
          const followerMatch = ocrText.match(/([\d,.]+\s*[kKmM]?)\s*(?:followers|follower|粉丝|粉絲|位)/i);
          const followingMatch = ocrText.match(/([\d,.]+\s*[kKmM]?)\s*(?:following|关注|關注|追蹤|追踪)/i);

          if (postMatch && !facts.postCount) facts.postCount = parseCompactNumber(postMatch[1]);
          if (followerMatch && !facts.followers) facts.followers = parseCompactNumber(followerMatch[1]);
          if (followingMatch && !facts.following) facts.following = parseCompactNumber(followingMatch[1]);
        } catch {}

        // Clean up screenshot after OCR to save disk space.
        try { if (fs.existsSync(statsPath)) fs.unlinkSync(statsPath); } catch {}
      } catch {}
    }
  } catch {}

  // Profile category label signal (e.g. "Tattoo & Piercing Shop")
  let categoryLabel = '';
  try {
    const candidates = [
      'header section div[role="button"] span',
      'header section span',
      'header section h2'
    ];
    for (const sel of candidates) {
      const loc = page.locator(sel);
      const c = Math.min(await loc.count(), 12);
      for (let i = 0; i < c; i++) {
        const t = (await loc.nth(i).innerText().catch(() => '')).trim();
        if (!t) continue;
        const lower = t.toLowerCase();
        if (lower.includes('shop') || lower.includes('studio') || lower.includes('tattoo') || lower.includes('piercing')) {
          categoryLabel = t;
          break;
        }
      }
      if (categoryLabel) break;
    }
  } catch {}
  facts.categoryLabel = categoryLabel;

  // External URL from profile.
  try {
    const href = (await page.locator('header a[href^="http"]').first().getAttribute('href').catch(() => '')) || '';
    if (href && /^https?:\/\//i.test(href)) facts.externalUrl = href.trim();
  } catch {}

  // Optional address/location line from profile text.
  try {
    const text = normalizeForMatch(`${facts.bio} ${facts.categoryLabel || ''}`);
    const addrMatch = String(text).match(/\b\d{2,6}\s+[^,]{2,40},?\s+[a-z\s]{2,30}\b/i);
    if (addrMatch?.[0]) facts.profileAddress = addrMatch[0].slice(0, 120);
  } catch {}

  // Non-alt text signal: open first post and capture short caption/hashtags.
  let sampleCaption = '';
  try {
    const firstMedia = page.locator('article a[href*="/p/"], article a[href*="/reel/"]').first();
    if (await firstMedia.count()) {
      await humanMouseMove();
      await firstMedia.click({ timeout: 7000 });
      await page.waitForTimeout(jitter(1200, 2400));
      const captionLoc = page.locator('article ul li span, div[role="dialog"] ul li span');
      const cc = Math.min(await captionLoc.count(), 6);
      const chunks: string[] = [];
      for (let i = 0; i < cc; i++) {
        const t = (await captionLoc.nth(i).innerText().catch(() => '')).trim();
        if (t) chunks.push(t);
      }
      sampleCaption = chunks.join(' ').slice(0, 360);
      const closeBtn = page.locator('svg[aria-label="Close"], svg[aria-label="关闭"]').first();
      if ((await closeBtn.count()) > 0) await closeBtn.click({ timeout: 4000 });
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(jitter(700, 1400));
    }
  } catch {}
  facts.sampleCaption = sampleCaption;

  // Email signal from profile text and sample caption.
  const emailSource = `${title}\n${bio}\n${categoryLabel}\n${sampleCaption}`;
  const emailMatches = Array.from(new Set((emailSource.match(EMAIL_REGEX) || []).map((x) => x.trim().toLowerCase())));
  if (emailMatches.length > 0) {
    facts.emails = emailMatches.slice(0, 5);
    facts.email = facts.emails[0];
  }

  // Lightweight image signal: Instagram often exposes semantic hints in img alt text.
  let imageAltHints: string[] = [];
  try {
    const imgLocator = page.locator('article img[alt], main img[alt]');
    const count = Math.min(await imgLocator.count(), 8);
    const alts: string[] = [];
    for (let i = 0; i < count; i++) {
      const alt = (await imgLocator.nth(i).getAttribute('alt').catch(() => '') || '').trim();
      if (alt) alts.push(alt.slice(0, 160));
    }
    imageAltHints = alts;
  } catch {}
  facts.imageAltHints = imageAltHints;

  const textBlob = normalizeForMatch(`${facts.title} ${facts.bio} ${facts.categoryLabel || ''} ${facts.sampleCaption || ''} ${(facts.statTexts || []).join(' ')}`);
  const imageBlob = normalizeForMatch(imageAltHints.join(' '));
  const handleBlob = normalizeForMatch(url);
  const textPositiveHits = keywordHits(textBlob, POSITIVE_KEYWORDS);
  const textNegativeHits = keywordHits(textBlob, NEGATIVE_KEYWORDS);
  const imagePositiveHits = keywordHits(imageBlob, POSITIVE_KEYWORDS);
  const imageNegativeHits = keywordHits(imageBlob, NEGATIVE_KEYWORDS);
  facts.categorySignals = { textPositiveHits, textNegativeHits, imagePositiveHits, imageNegativeHits };

  // Normalized business category from bio/title/categoryLabel/sampleCaption
  const catBlob = normalizeForMatch(`${facts.title || ''} ${facts.bio || ''} ${facts.categoryLabel || ''} ${facts.sampleCaption || ''}`);
  if (/\b(tattoo|ink|irezumi|tattoolife|tattoolover|tattooist|tatted|tatuaje|bodyart)\b/.test(catBlob)) facts.category = 'tattoo';
  else if (/\b(piercing|piercer|body.mod|stretched|gauges|modifikasi)\b/.test(catBlob)) facts.category = 'piercing';
  else if (/\b(nail|manicure|pedicure|gel|acrylic|nailart|nailtech|nail.salon)\b/.test(catBlob)) facts.category = 'nail';
  else if (/\b(barber|barbershop|haircut|fade|grooming|clipper|haircutter)\b/.test(catBlob)) facts.category = 'barber';
  else if (/\b(esthetician|skincare|facial|lashes|eyelash|waxing|microblading|brow|lash.ext)\b/.test(catBlob)) facts.category = 'esthetician';
  else if (/\b(massage|spa|wellness|therapist|reflexology|bodywork)\b/.test(catBlob)) facts.category = 'massage';
  else if (/\b(salon|hairstylist|hairstyle|beauty|cosmetology|haircolor|blowout)\b/.test(catBlob)) facts.category = 'salon';

  const positiveScore = textPositiveHits.length + imagePositiveHits.length;
  const negativeScore = textNegativeHits.length + imageNegativeHits.length;
  const handleLooksTattoo = /\b(tattoo|ink|irezumi|piercing|needle)\b/.test(handleBlob);
  const strongNegative = negativeScore >= 2;
  // 2026-08-07：放宽非纹身判定，避免 bot 去互动美容院/沙龙等非纹身店。
  // 只要 bio/category 被归类为明确的非纹身业态（salon/esthetician/nail/barber/massage），
  // 且没有任何纹身正向信号，就当作 non-tattoo 跳过（review-only，不点赞/评论/关注）。
  const NON_TATTOO_CATS = new Set(['nail', 'barber', 'esthetician', 'massage', 'salon']);
  const catIsNonTattoo = NON_TATTOO_CATS.has(facts.category);
  // Conservative safety rule: only mark as non-tattoo when negatives are strong,
  // no positives exist, and handle/url itself has no tattoo signal.
  facts.nonTattooSuspect = (strongNegative && positiveScore === 0 && !handleLooksTattoo) || (catIsNonTattoo && positiveScore === 0);

  logBehavior('profile_facts', {
    statTexts: facts?.statTexts || [],
    postCount: Number(facts?.postCount || 0),
    followers: Number(facts?.followers || 0),
    following: Number(facts?.following || 0),
    categoryLabel: facts.categoryLabel || '',
    externalUrl: facts.externalUrl || '',
    _dbgBodyTop: (facts as any)._dbgBodyTop || '',
    _dbgBodyHtml: (facts as any)._dbgBodyHtml || '',
    _dbgAnchor: (facts as any)._dbgAnchor || {},
    _dbgGlobalAnchors: (facts as any)._dbgGlobalAnchors || {},
    profileAddress: facts.profileAddress || '',
    email: facts.email || '',
    textPositiveHits,
    textNegativeHits,
    imagePositiveHits,
    imageNegativeHits,
    handleLooksTattoo,
    strongNegative
  });
  return facts;
};

const getPrimaryStyle = (facts?: ProfileFacts) => {
  const text = normalizeForMatch(`${facts?.bio || ''} ${facts?.sampleCaption || ''} ${facts?.categoryLabel || ''}`);
  for (const style of STYLE_KEYWORDS) {
    if (text.includes(style)) return style;
  }
  return '';
};

const toAgeDays = (iso?: string) => {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
};

// 账号成熟天数：按优先级取年龄源，用于连续爬坡（而非写死的 discrete 阶段）。
// 优先级：① cloud-api 注入的 accountAgeDays → ② 环境变量 BOT_ACCOUNT_BOUND_AT →
// ③ bot 本地首次运行记录（未来新号自动从 0 暖机）→ ④ 无记录视为成熟号（满档）。
const getAccountAgeDays = (command?: CommandPayload): number => {
  const injected = Number(command?.accountAgeDays || 0);
  if (Number.isFinite(injected) && injected > 0) return injected;
  if (BOT_ACCOUNT_BOUND_AT) {
    const d = toAgeDays(BOT_ACCOUNT_BOUND_AT);
    if (Number.isFinite(d) && d > 0) return d;
  }
  const localBound = Number((likeState as any).accountBoundAt || 0);
  if (localBound > 0) return (Date.now() - localBound) / (1000 * 60 * 60 * 24);
  // 首次运行时记录本地起始日，后续自动按真实经过天数爬坡
  if (!(likeState as any).accountBoundAt) {
    (likeState as any).accountBoundAt = Date.now();
    saveLikeState(likeState);
  }
  return 0; // 当天视为最年轻（仅浏览+点赞），次日开始爬坡
};

// 按账号成熟天数计算"日关注上限"（连续爬坡，取代写死的 new/transition/stable 三档）。
//  <3 天：0（纯暖机，只浏览+点赞）
//  3~21 天：线性 2 → BOT_FOLLOW_DAILY_MAX
//  >=21 天：满档 BOT_FOLLOW_DAILY_MAX
// 每日下限取档位 70%，留自然抖动。
const FOLLOW_RAMP_MAX_AGE = 21;
const getAccountFollowRamp = (ageDays: number): number => {
  if (ageDays < 3) return 0;
  if (ageDays >= FOLLOW_RAMP_MAX_AGE) return BOT_FOLLOW_DAILY_MAX;
  const t = (ageDays - 3) / (FOLLOW_RAMP_MAX_AGE - 3); // 0..1
  return Math.round(2 + t * (BOT_FOLLOW_DAILY_MAX - 2));
};

const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const pruneRecentCommentHashes = () => {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  likeState.comments!.recentText = (likeState.comments!.recentText || []).filter((x) => x.ts >= cutoff);
};

const shouldTryComment = (handle: string, likeSummary?: LikeActionSummary) => {
  if (!BOT_COMMENT_ENABLED) return { ok: false, reason: 'comment_disabled' };

  if (!canQueueCommentDraft('task_review')) return { ok: false, reason: 'comment_draft_daily_target' };

  // No more "like first" or "first touch window" — comment when a good post is found.
  // Chance roll keeps volume human-scale.
  if (Math.random() > BOT_COMMENT_CHANCE) return { ok: false, reason: 'comment_chance_skip' };

  const h = likeState.comments!.byHandle?.[handle];
  if (h?.lastCommentAt) {
    const nextAt = h.lastCommentAt + BOT_COMMENT_HANDLE_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (Date.now() < nextAt) return { ok: false, reason: 'comment_handle_cooldown' };
  }
  return { ok: true };
};

const getFollowDayCap = (command?: CommandPayload) => {
  const key = todayKey();
  const ageDays = getAccountAgeDays(command);
  const rampMax = getAccountFollowRamp(ageDays);
  // 每日下限取档位 70%，留自然抖动；档位为 0 时直接 0（新号纯暖机）
  const minCap = Math.floor(rampMax * 0.7);
  const maxCap = rampMax;

  if (!likeState.follows!.dayCap || likeState.follows!.dayCap.key !== key) {
    likeState.follows!.dayCap = { key, cap: minCap >= maxCap ? minCap : randInt(Math.max(0, minCap), Math.max(1, maxCap)) };
    saveLikeState(likeState);
  }
  return likeState.follows!.dayCap.cap;
};

// 关注质量闸门：默认放开（设 0），因为注入的 Neon 任务不带 leadScore/postCount，
// 且 OCR 关闭后 live followers 常抓不到。只要成功打开 profile 并点赞过，账号即视为有效可关注。
// 如需质量过滤可设 BOT_FOLLOW_MIN_LEAD_SCORE / BOT_FOLLOW_MIN_POSTS 提高阈值。
const BOT_FOLLOW_MIN_LEAD_SCORE = Math.max(0, Number(process.env.BOT_FOLLOW_MIN_LEAD_SCORE || 0));
const BOT_FOLLOW_MIN_POSTS = Math.max(0, Number(process.env.BOT_FOLLOW_MIN_POSTS || 0));
const BOT_FOLLOW_POST_COOLDOWN_HOURS = Math.max(12, Number(process.env.BOT_FOLLOW_POST_COOLDOWN_HOURS || 48));
// 是否要求"本次访问已点赞"才允许关注。默认 false：关注是回关→DM 链路的关键动作，不应被点赞失败连坐。
const BOT_FOLLOW_REQUIRE_LIKE = String(process.env.BOT_FOLLOW_REQUIRE_LIKE || 'false').toLowerCase() === 'true';

const shouldTryFollow = (handle: string, likeSummary: LikeActionSummary, command?: CommandPayload, facts?: ProfileFacts) => {
  // [0] 关注跳过自己（防御：不会去关注 bot 自身账号）
  const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
  if (selfIds.has(String(handle).toLowerCase())) return { ok: false, reason: 'self' };

  // [1] 总开关
  if (!BOT_FOLLOW_ENABLED) return { ok: false, reason: 'follow_disabled' };

  // [1.5] following 总量上限：到了就只出不进，靠取关腾位（关注/粉丝比治理）
  if (BOT_FOLLOW_MAX_FOLLOWING > 0) {
    const followingNow = countFollowing(likeState.follows?.byHandle || {});
    if (followingNow >= BOT_FOLLOW_MAX_FOLLOWING) {
      logBehavior('follow_cap_reached', { followingNow, cap: BOT_FOLLOW_MAX_FOLLOWING });
      return { ok: false, reason: `follow_cap_${followingNow}_gte_${BOT_FOLLOW_MAX_FOLLOWING}` };
    }
  }

  // [2] 优先级闸门（默认仅 high；设 BOT_FOLLOW_PRIORITIES=high,medium 或 * 可放宽以提升关注量）
  const priority = String(command?.followPriority || '').toLowerCase();
  const allowedPriors = (process.env.BOT_FOLLOW_PRIORITIES || 'high').split(',').map((s) => s.trim().toLowerCase());
  if (priority && !allowedPriors.includes(priority) && !allowedPriors.includes('*')) {
    return { ok: false, reason: `follow_priority_${priority}` };
  }

  // [3] 触达次数（至少访问过N次）
  const touchCount = likeState.touches?.[handle] || 0;
  if (touchCount < BOT_FOLLOW_MIN_TOUCHES) return { ok: false, reason: `follow_need_more_touches_${touchCount}_lt_${BOT_FOLLOW_MIN_TOUCHES}` };

  // [4] 本站已点赞：默认软闸门。点赞受帖子元数据抓取影响常为 0，若强制"先点赞再关注"，
  // 会导致关注永远不发生（=没有回关来源=没有 DM）。设 BOT_FOLLOW_REQUIRE_LIKE=true 可恢复硬拦。
  if ((likeSummary.liked || 0) <= 0) {
    if (BOT_FOLLOW_REQUIRE_LIKE) return { ok: false, reason: 'follow_need_like_first' };
    logBehavior('follow_soft_no_like', { handle });
  }

  // [5] 未关注过（不去重）
  if (likeState.follows!.byHandle?.[handle]?.followedAt) return { ok: false, reason: 'already_followed' };

  // [6] 日上限
  const dayKey = todayKey();
  const current = Number(likeState.follows!.byDay?.[dayKey] || 0);
  const cap = getFollowDayCap(command);
  if (cap <= 0) {
    // 新号阶段禁止
    return { ok: false, reason: `follow_stage_blocked_${String(command?.accountStage || '')}` };
  }
  if (current >= cap) return { ok: false, reason: `follow_daily_cap_${current}_of_${cap}` };

  // [7] 账号阶段（已在 getFollowDayCap 中通过 cap=0 实现）
  // 不再单独判断，统一由日上限控制

  // [8] leadScore 阈值
  const leadScore = Number(command?.leadScore || 0);
  if (leadScore < BOT_FOLLOW_MIN_LEAD_SCORE) return { ok: false, reason: `follow_lead_score_${leadScore}_lt_${BOT_FOLLOW_MIN_LEAD_SCORE}` };

  // [9] 内容质量：帖子数 >= N（排除空号/废弃号）
  const postCount = Number(facts?.postCount || 0);
  if (postCount < BOT_FOLLOW_MIN_POSTS) return { ok: false, reason: `follow_low_content_${postCount}_posts_lt_${BOT_FOLLOW_MIN_POSTS}` };

  // [10] 非纹身排除
  if (facts?.nonTattooSuspect) return { ok: false, reason: 'follow_non_tattoo' };

  // [11] followers 数据：OCR 关闭后 live 抓取常失败，仅作软提示不再拦截
  // （能成功打开 profile 并点赞，账号已视为有效；followers 抓不到不应阻断关注）
  const followerCount = Number(facts?.followers || 0);
  if (followerCount <= 0) logBehavior('follow_soft_no_follower_data', { handle });

  // [13] 关注后冷却：刚关注完 48h 不在该号互动（避免 look-back pattern）
  const lastFollowedAt = likeState.follows!.byHandle?.[handle]?.followedAt;
  if (lastFollowedAt) {
    const hoursSinceFollow = (Date.now() - lastFollowedAt) / (60 * 60 * 1000);
    if (hoursSinceFollow < BOT_FOLLOW_POST_COOLDOWN_HOURS) return { ok: false, reason: `follow_cooldown_${Math.round(hoursSinceFollow)}h_lt_${BOT_FOLLOW_POST_COOLDOWN_HOURS}h` };
  }

  return { ok: true };
};

const tryFollowOnProfile = async (handle: string, likeSummary: LikeActionSummary, command?: CommandPayload): Promise<FollowActionSummary> => {
  if (!page) return { attempted: 0, followed: 0, skipped: true, reason: 'no_page' };
  // 穿孔号不关注（整个不碰，不污染回关/DM 漏斗）
  if (isPiercingHandle(handle)) {
    logBehavior('follow_skip_piercing_handle', { handle });
    return { attempted: 0, followed: 0, skipped: true, reason: 'follow_skip_piercing_handle' };
  }
  const gate = shouldTryFollow(handle, likeSummary, command);
  dbg(`[dbg-follow] gate=${JSON.stringify(gate)} handle=${handle}`);
  if (!gate.ok) return { attempted: 0, followed: 0, skipped: true, reason: gate.reason };

  // Make sure we're at profile top before finding follow button.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(jitter(1000, 2200));

  // Instagram 在不同布局下把关注按钮渲染成 <button> 或 <div role="button">，
  // 且文案可能是 "Follow" / "Follow Back"。逐个候选定位器尝试，取第一个命中的。
  const followSelectors = [
    'header button', 'header div[role="button"]',
    'main button', 'main div[role="button"]',
    'button', 'div[role="button"]',
  ];
  let followBtn: any = null;
  for (const sel of followSelectors) {
    const cand = page.locator(sel).filter({ hasText: /^\s*Follow(\s+Back)?\s*$/i }).first();
    if ((await cand.count()) > 0) { followBtn = cand; break; }
  }
  dbg(`[dbg-follow] followBtnFound=${!!followBtn} handle=${handle}`);
  if (!followBtn) {
    return { attempted: 1, followed: 0, skipped: true, reason: 'follow_button_not_found' };
  }
  await followBtn.click({ timeout: 6000 });
  await page.waitForTimeout(jitter(1200, 2400));

  // 🛑 检测 IG 限制信号（关注后常弹 "Action Blocked / Try again later"）
  try {
    const bsig = await detectBlockSignal();
    if (bsig) {
      await triggerAccountRest(bsig.severity, bsig.text);
      return { attempted: 1, followed: 0, skipped: true, reason: `account_blocked_${bsig.severity}` };
    }
  } catch {}

  const dayKey = todayKey();
  likeState.follows!.byDay![dayKey] = Number(likeState.follows!.byDay![dayKey] || 0) + 1;
  likeState.follows!.byHandle![handle] = { followedAt: Date.now() };
  saveLikeState(likeState);
  logBehavior('follow_done', { handle, dayCount: likeState.follows!.byDay![dayKey], dayCap: getFollowDayCap() });
  recordInteraction(handle, 'follow', { followedAt: Date.now() }).catch(() => {});
  return { attempted: 1, followed: 1, skipped: false };
};

// 2026-09-15：返回 { text, diag } 而不是裸字符串 —— 失败时把原因带出去落库，
// 否则 `comment_skip_generation_failed` 只有事件名，分不清「API 错 / 太短 / 没过 grounding / 太像历史」。
type CommentGenResult = { text: string; diag: string };
const buildCommentText = async (facts?: ProfileFacts, postMeta?: any): Promise<CommentGenResult> => {
  // ⚠️ 不再优先取预热池：池里是启动时脱离具体帖生成的泛评，回在真实帖上最像 bot。
  // 改为实时按帖生成；失败时不排入草稿，避免脱离真实 caption 的泛评。
  // DeepSeek 实时生成
  const commentStyle = postMeta?.postStyle
    || getPrimaryStyle(facts)
    || '';
  const styleConf = postMeta?.styleConfidence || 'low';

  try {
    const result: any = await Promise.race([
      generateComment({
        caption: postMeta?.caption?.slice(0, 700) || facts?.sampleCaption?.slice(0, 700),
        imageAlt: postMeta?.imageAlt || facts?.imageAltHints?.join(' ').slice(0, 200),
        artistHandle: facts?.title?.replace(/[\(\)@]/g, '').trim(),
        style: commentStyle,
        styleConfidence: styleConf,
        techniqueHints: postMeta?.techniqueHints,
        visionTechniqueHints: postMeta?.visionTechniqueHints,
        visionDescription: postMeta?.visionDescription,
        likeCount: postMeta?.likeCount,
        commentCount: postMeta?.commentCount,
      isReel: postMeta?.isReel,
      postIntent: postMeta?.postIntent,
      postSummary: postMeta?.postSummary,
      postTone: postMeta?.postTone,
      sensitive: postMeta?.sensitive,
    }),
      new Promise<{ text: string }>((_, reject) =>
        setTimeout(() => reject(new Error('comment_gen_timeout')), 20000)
      ),
    ]);
    const text = String(result?.text || '');
    return {
      text,
      diag: text.trim() ? 'ok' : `empty:${result?.reason || result?.style || 'unknown'}`,
    };
  } catch (e: any) {
    return { text: '', diag: `throw:${String(e?.message || e).slice(0, 160)}` };
  }
};

// 评论框找不到时把页面实况记下来，否则只能看到一个干巴巴的 comment_box_not_found，
// 分不清是「页面没加载完」「帖子关了评论」还是「IG 改版换了选择器」。
const collectCommentBoxDiagnostics = async (draftId: string) => {
  if (!page) return;
  try {
    const info = await page.evaluate(() => ({
      url: String(location.href || '').slice(0, 200),
      title: String(document.title || '').slice(0, 120),
      textareas: document.querySelectorAll('textarea').length,
      editables: document.querySelectorAll('div[contenteditable="true"]').length,
      forms: document.querySelectorAll('form').length,
      hasArticle: !!document.querySelector('article'),
      loggedIn: !/\/accounts\/login|challenge\//.test(String(location.href || '')),
      snippet: String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 300),
    }));
    logBehavior('comment_box_debug', { draftId, ...info });
  } catch {}
};

const tryPostCommentOnOpenModal = async (
  text: string,
  approval: { draftId: string; approvedAt: string; approvedBy: string }
) => {
  if (!page) return false;
  if (!approval?.draftId || !approval?.approvedAt || !approval?.approvedBy) {
    logBehavior('comment_publish_blocked_missing_approval', { draftId: approval?.draftId || '' });
    return false;
  }
  const textarea = page.locator([
    'textarea[aria-label*="comment" i]',
    'textarea[placeholder*="comment" i]',
    'form textarea',
    'div[contenteditable="true"][role="textbox"][aria-label*="comment" i]',
  ].join(', ')).first();
  try {
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    return false;
  }
  await textarea.click({ timeout: 4000 });
  await page.waitForTimeout(jitter(400, 1000));

  // The approved draft is immutable at publish time. Simulated typo correction
  // previously deleted characters without restoring them, so type exactly and
  // verify the DOM value before Instagram receives the submit action.
  await textarea.fill('');
  await textarea.pressSequentially(text, { delay: jitter(55, 140) });

  const readEnteredText = async () => textarea.evaluate((element: any) =>
    typeof element.value === 'string' ? element.value : (element.innerText || element.textContent || '')
  );
  const canonicalizeEnteredText = (value: string) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  let enteredText = await readEnteredText();
  if (canonicalizeEnteredText(enteredText) !== canonicalizeEnteredText(text)) {
    logBehavior('comment_publish_text_retry', {
      draftId: approval.draftId,
      expected: text,
      actual: enteredText,
    });
    await textarea.fill('');
    await textarea.fill(text);
    enteredText = await readEnteredText();
  }
  if (canonicalizeEnteredText(enteredText) !== canonicalizeEnteredText(text)) {
    logBehavior('comment_publish_blocked_text_mismatch', {
      draftId: approval.draftId,
      expected: text,
      actual: enteredText,
    });
    throw new Error('comment_text_mismatch_before_submit');
  }

  await page.waitForTimeout(jitter(500, 1500));
  const form = textarea.locator('xpath=ancestor::form[1]');
  const postButton = form.locator('button[type="submit"], button').filter({ hasText: /^Post$/i }).first();
  if ((await postButton.count()) > 0 && await postButton.isEnabled().catch(() => false)) {
    await postButton.click({ timeout: 5000 });
  } else {
    await textarea.press('Enter');
  }
  await page.waitForTimeout(jitter(1500, 3000));
  return true;
};

const queueCommentDraftForReview = async (
  handle: string,
  postUrl: string,
  text: string,
  meta: any,
  extra: Record<string, any> = {}
) => {
  const draftPostKey = extractPostKey(postUrl);
  // 同一个帖只允许一条草稿：draftHash 里含文本，换一句文案会变成"新草稿"，所以必须在文本之外单独拦。
  if (alreadyHasCommentDraft(draftPostKey)) {
    logBehavior('comment_skip_post_already_commented', {
      handle, postUrl, postKey: draftPostKey, source: extra.source || 'task_review',
    });
    return null;
  }
  const draftHash = hashString(`${handle}|${postUrl}|${text}`).toString(36);
  const draftId = `${Date.now()}_${draftHash.slice(0, 10)}`;
  await postJson('/api/drafts/ingest', {
    botId: BOT_ID,
    drafts: [{
      id: draftId,
      botId: BOT_ID,
      handle,
      postUrl,
      postKey: extractPostKey(postUrl),
      proposedComment: text,
      groundingRisks: [
        ...(!extra.visionDescription ? ['vision_unavailable'] : []),
        ...(!meta?.caption ? ['caption_missing'] : []),
      ],
      safeFacts: [
        ...(meta?.caption ? [`caption:${String(meta.caption).slice(0, 260)}`] : []),
        ...(meta?.postStyle ? [`style:${meta.postStyle}`] : []),
        ...(meta?.postIntent ? [`intent:${meta.postIntent}`] : []),
        ...(extra.visionDescription ? [String(extra.visionDescription).slice(0, 220)] : []),
      ],
      lang: 'en',
    }],
  });
  markPostDedup('queuedByPostKey', draftPostKey);
  logBehavior('comment_review_queued', {
    handle,
    postUrl,
    draftId,
    text,
    score: Number(meta?.score || 0),
    style: extra.style || meta?.postStyle || '',
    styleConfidence: extra.styleConfidence || meta?.styleConfidence || 'low',
    vision: !!extra.visionDescription,
    ...commentShapeFlags(text),
  });
  return draftId;
};

let approvedCommentBusy = false;
const tryPublishApprovedComment = async (): Promise<boolean> => {
  if (!BOT_COMMENT_ENABLED || approvedCommentBusy || !page) return false;
  if (commentsPostedToday() >= BOT_COMMENT_PUBLISH_DAILY_MAX) return false;
  if (!canPublishApprovedCommentNow()) return false;
  approvedCommentBusy = true;
  let claimedDraftId = '';
  let didPostToInstagram = false;
  try {
    const data = await postJson('/api/drafts/claim-approved', { botId: BOT_ID });
    const item = data?.item;
    if (!item?.post_url || !item?.proposed_comment) return false;
    claimedDraftId = String(item.draft_id || item.id);

    const handle = String(item.handle || '').replace(/^@/, '').trim();
    const text = String(item.proposed_comment || '').trim();
    logBehavior('comment_approved_publish_start', { draftId: claimedDraftId, handle, postUrl: item.post_url });

    // 🛑 同一帖已发过评论 → 直接终态，不打开页面。历史遗留的重复草稿靠这一步兜底。
    if (alreadyPostedComment(extractPostKey(String(item.post_url || '')))) {
      logBehavior('comment_skip_post_already_commented', {
        draftId: claimedDraftId, handle, postUrl: item.post_url, scope: 'publish',
      });
      await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/release`, {
        reason: 'duplicate_post_already_commented',
      }).catch(() => null);
      return false;
    }

    await page.goto(String(item.post_url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(1800, 3200));
    const approvedAt = String(item.approved_at || '').trim();
    const approvedBy = String(item.approved_by || '').trim();
    if (!approvedAt || !approvedBy) {
      logBehavior('comment_publish_blocked_missing_approval', { draftId: claimedDraftId, handle });
      await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/release`, { reason: 'missing_approval_metadata' }).catch(() => null);
      return false;
    }
    const ok = await tryPostCommentOnOpenModal(text, { draftId: claimedDraftId, approvedAt, approvedBy });
    if (!ok) {
      logBehavior('comment_approved_publish_failed', { draftId: claimedDraftId, handle, reason: 'comment_box_not_found' });
      await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/release`, { reason: 'comment_box_not_found' }).catch(() => null);
      return false;
    }
    didPostToInstagram = true;

    const textHash = hashString(normalizeForMatch(text));
    markPostDedup('postedByPostKey', extractPostKey(String(item.post_url || '')));
    recordCommentPublished();
    if (handle) likeState.comments!.byHandle![handle] = { lastCommentAt: Date.now() };
    likeState.comments!.recentText!.push({ ts: Date.now(), hash: textHash });
    pruneRecentCommentHashes();
    saveLikeState(likeState);

    await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/posted`, {});
    const safeFacts = (() => { try { return JSON.parse(item.safe_facts || '[]'); } catch { return []; } })();
    const isRapportComment = Array.isArray(safeFacts) && safeFacts.includes('source:follow_back_ladder');
    if (isRapportComment && handle) {
      const followState = likeState.follows?.byHandle?.[handle] as any;
      if (followState) {
        if (!followState.rapport) followState.rapport = {};
        followState.rapport.commentedAt = Date.now();
        followState.rapport.commentQueuedAt = 0;
        followState.rapport.commentDraftId = '';
        recordRapport();
        saveLikeState(likeState);
      }
    }
    logBehavior('comment_posted', {
      draftId: claimedDraftId,
      handle,
      postUrl: item.post_url,
      text,
      reviewed: true,
      approvedAt,
      approvedBy,
      source: isRapportComment ? 'follow_back_ladder' : 'task_review',
      publishDayCount: commentsPostedToday(),
      publishDayMax: BOT_COMMENT_PUBLISH_DAILY_MAX,
    });
    if (handle) recordInteraction(handle, 'comment', {
      postUrl: item.post_url,
      text,
      reviewed: true,
      approvedAt,
      approvedBy,
      reason: isRapportComment ? 'follow_back_ladder' : 'task_review',
    }).catch(() => {});
    return true;
  } catch (error: any) {
    if (claimedDraftId && !didPostToInstagram) {
      await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/release`, {
        reason: String(error?.message || error).slice(0, 300),
      }).catch(() => null);
    }
    logBehavior('comment_approved_publish_error', { reason: String(error?.message || error).slice(0, 180) });
    return false;
  } finally {
    approvedCommentBusy = false;
  }
};

const tryCommentWithStrategy = async (handle: string, facts?: ProfileFacts, likeSummary?: LikeActionSummary): Promise<CommentActionSummary> => {
  if (!page) throw new Error('page_not_initialized');

  // 禁止在自己账号的帖子里留言（有些来源是别人主页的 co-author / 推荐流混入）
  if (isOwnAccountHandle(handle)) {
    logBehavior('comment_skip_own_account', { handle, source: 'task_review', scope: 'profile' });
    return { attempted: 0, posted: 0, skipped: true, reason: 'own_account_profile' };
  }

  const gate = shouldTryComment(handle, likeSummary);
  if (!gate.ok) return { attempted: 0, posted: 0, skipped: true, reason: gate.reason };

  // 评论黑名单：被拉黑账号坚决不写评论（用户 2026-08-14 要求）
  if (isCommentBlacklisted(handle)) {
    logBehavior('comment_skip_blacklist', { handle, scope: 'profile' });
    return { attempted: 0, posted: 0, skipped: true, reason: 'blacklisted_handle' };
  }

  const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]');
  const total = await tiles.count();
  // 评论评分候选数收敛到 5：只为后续点赞挑最优帖，无需打开全部（多帖 profile 会拖爆看门狗）。
  const candidateCount = Math.min(total, 5);
  const primaryStyle = getPrimaryStyle(facts);
  const ranked: { idx: number; score: number; meta: any }[] = [];
  for (let idx = 0; idx < candidateCount; idx++) {
    try {
      await tiles.nth(idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(600, 1400));
      await tiles.nth(idx).click({ timeout: 8000 });
      await page.waitForTimeout(jitter(900, 1800));
      const meta = await readModalMeta(primaryStyle, '', facts?.followers);
      // 帖子 owner / co-author 在黑名单 → 跳过该帖（不写评论）
      if (isCommentBlacklisted(meta.ownerHandle, { caption: meta.caption })) {
        logBehavior('comment_skip_blacklist', { handle, ownerHandle: meta.ownerHandle, scope: 'post' });
        await closeModal().catch(() => {});
        continue;
      }
      // 帖子 owner 是自己的账号 → 跳过该帖（不给自己留言）
      if (isOwnAccountHandle(meta.ownerHandle)) {
        logBehavior('comment_skip_own_account', { handle, ownerHandle: meta.ownerHandle, source: 'task_review', scope: 'post' });
        await closeModal().catch(() => {});
        continue;
      }
      const pinnedLikelyBoost = idx < 3 ? 3 : 0;
      const boostedScore = Number(meta.score || 0) + pinnedLikelyBoost;
      ranked.push({ idx, score: boostedScore, meta: { ...meta, pinnedLikelyBoost } });
      await closeModal();
    } catch {
      await closeModal().catch(() => {});
    }
  }
  // 评论优先评"客人最近发的"帖：在质量达标(score>=3)、非推广、且在近 BOT_SKIP_OLD_POST_DAYS 天内 的候选里，
  // 选 ageDays 最小（最新）的那条；同新鲜度再比 score。太老的帖互动价值低（用户 2026-08-10 拍板）。
  const qualifying = ranked.filter(
    (r) => r.score >= 3 && (r.meta.promo ?? 0) === 0 && (r.meta.ageDays ?? 9999) <= BOT_SKIP_OLD_POST_DAYS
  );
  // 评论闸门（2026-08-14 用户硬要求·修正）：只评「文字识别出纹身意图」的帖。
  // - social（生日/聚会/家人朋友）→ 直接跳过（纹身只是顺带入镜，评了=机器人）。
  // - generic（文字无纹身意图信号）→ 直接跳过，绝不调 QWEN 去"识别这是什么帖"（傻逼了才用视觉救未知帖）。
  // - 只有 text intent = tattoo（flash/healed/wip/portrait/memorial…）才进评论流程；
  //   QWEN 视觉此时只用于「读懂这张纹身图」让评论更具体，不决定评不评。
  const tattooQualifying = qualifying.filter((r) => intentEngagement(r.meta.postIntent || 'generic') === 'tattoo');
  if (!tattooQualifying.length) {
    logBehavior('comment_skip_no_tattoo_intent', { handle, totalQualifying: qualifying.length });
    return { attempted: 1, posted: 0, skipped: true, reason: 'no_tattoo_intent_candidate' };
  }
  tattooQualifying.sort((a, b) => (a.meta.ageDays ?? 9999) - (b.meta.ageDays ?? 9999) || b.score - a.score);
  const chosen = tattooQualifying[0];

  // ===== 视觉分析（仅对"将要评论"的最优帖触发，控成本/延迟，不影响浏览评分）=====
  // 文案 + 图片结合：视觉模型"看"图 -> 产出观测 TEXT -> 注入评论生成。
  // 作者自标风格(caption/hashtag) 优先于视觉；视觉仅在自标缺失且模型确认时把 low/medium 升为 high。
  let visionDescription = '';
  let tempStyle = chosen.meta.postStyle || '';
  let tempConf: string = chosen.meta.styleConfidence || 'low';
  let tempSource: string = chosen.meta.styleSource || 'none';
  // ⚠️ 2026-09-08 修订：视觉常开（同 follow_back_ladder 路径）——文字意图闸门已决定评不评，
  // 视觉只负责读懂图把评论写具体；subjectConfidence='high' 注入门槛移除（hook/craft 始终可用）。
  const captionThemeClear = hasClearCaptionTheme(chosen.meta);
  let vis: any = null;
  if (isVisionEnabled() && chosen.meta.postImageSrc) {
    try {
      vis = await analyzePostImage(chosen.meta.postImageSrc);
      if (vis?.tattooVisible) {
        visionDescription = buildVisionDescription(vis);
        if (vis.styleConfidence === 'high' && vis.style) {
          // 视觉判定风格 -> 归一化到分类法 canonical key
          const visNorm = vis.style.toLowerCase().replace(/[^a-z0-9]/g, '');
          const canon = detectTattooStyle('', '', [visNorm]).primary;
          // 作者自标(high)优先；否则（无风格 / 仅 alt 弱猜测 medium）视觉确认即升 high
          if (canon && tempConf !== 'high') {
            tempStyle = canon;
            tempConf = 'high';
            tempSource = 'vision';
          }
        }
      }
      logBehavior(captionThemeClear ? 'comment_vision_enhance' : 'comment_vision_fallback', {
        handle,
        postUrl: chosen.meta?.url || '',
        source: 'task_review',
        captionThemeClear,
        tattooVisible: !!vis?.tattooVisible,
        subject: vis?.motif || vis?.subject || '',
        subjectConfidence: vis?.subjectConfidence || 'low',
        placement: vis?.placement || '',
        stage: vis?.stage || 'unknown',
        hookUsable: !!vis?.hookUsable,
        craftNotes: vis?.craftNotes || [],
        hook: vis?.commentHook || '',
      });
    } catch {
      vis = null;
    }
  }

  // ===== 纹身硬闸门（2026-09-14 用户拍板）：识图跑通但判定"图里看不到纹身" → 不写评论 =====
  // 与文字意图闸门的区别：文字闸门管"这个帖在讲纹身吗"，本闸门管"这张图真有纹身吗"。
  // 只有两者都过才生成评论，避免给自拍/招牌/纹身师聚餐这类图硬编一句纹身评论（一眼机器人）。
  // 识图不可用/报错时 vis=null → 不拦，退回纯文字意图判定（原有行为）。
  if (BOT_COMMENT_REQUIRE_TATTOO_VISIBLE && vis && vis.tattooVisible === false) {
    logBehavior('comment_skip_no_tattoo_in_image', {
      handle,
      postUrl: chosen.meta?.url || '',
      source: 'task_review',
      imageType: vis.imageType || '',
      subject: vis.subject || '',
      captionThemeClear,
    });
    return { attempted: 1, posted: 0, skipped: true, reason: 'no_tattoo_in_image' };
  }

  // 视觉辅助技法识别（2026-08-14 补·用户要"视觉辅助"）：从 QWEN 观测描述里提取技法词，
  // 补进评论生成器的 TECHNIQUE DETAIL。这里"看到"的技法词来自视觉模型文字描述，
  // 与作者自标的 caption 技法区分来源（prompt 里表述不同，诚实边界不同）。
  // 去重：作者已在 caption 自标的技法不再重复认领，避免 prompt 里同技法列两次。
  const visionTechHints: string[] = visionDescription
    ? extractTechniqueHintsFromVision(visionDescription).filter((k) => !(chosen.meta.techniqueHints || []).includes(k))
    : [];

  // ===== 主题闸门：穿孔整个不碰（文字先判，判不出借现有 visionDescription 二次判定，不额外调 API）=====
  let subj: string = (chosen.meta.subject && chosen.meta.subject.subject) || 'unknown';
  if (subj === 'piercing') {
    logBehavior('comment_skip_piercing', { handle, ownerHandle: chosen.meta.ownerHandle, source: chosen.meta.subject?.source });
    return { attempted: 1, posted: 0, skipped: true, reason: 'piercing_skip' };
  }
  if (subj === 'unknown' && visionDescription) {
    const v = detectSubject('', [visionDescription], chosen.meta.ownerHandle || '');
    subj = v.subject;
    logBehavior('comment_subject_vision', { handle, subject: subj, source: v.source });
    if (subj === 'piercing') {
      logBehavior('comment_skip_piercing_vision', { handle, ownerHandle: chosen.meta.ownerHandle });
      return { attempted: 1, posted: 0, skipped: true, reason: 'piercing_skip' };
    }
    if (subj === 'unknown') {
      logBehavior('comment_skip_unknown', { handle, ownerHandle: chosen.meta.ownerHandle });
      return { attempted: 1, posted: 0, skipped: true, reason: 'subject_unknown_skip' };
    }
  }
  if (subj === 'unknown') {
    logBehavior('comment_skip_unknown', { handle, ownerHandle: chosen.meta.ownerHandle });
    return { attempted: 1, posted: 0, skipped: true, reason: 'subject_unknown_skip' };
  }

  // 视觉闭环：QWEN 观测到的悼念信号 → 升 sensitive（仅影响语气，不影响"评不评"；评不评已由文字意图闸门决定）
  const reconciledIntent = reconcileIntentWithVision(
    {
      intent: (chosen.meta.postIntent as any) || 'generic',
      summary: chosen.meta.postSummary || '',
      tone: (chosen.meta.postTone as any) || 'casual',
      sensitive: !!chosen.meta.sensitive,
      keywords: [],
    },
    visionDescription
  );

  // 注意：social 帖已在候选筛选阶段(intentEngagement==='tattoo' 闸门)剔除，
  // 这里不再用视觉补判社交——QWEN 只负责读图喂评论，不决定评不评。

  const gen = await buildCommentText(facts, {
    ...chosen.meta,
    style: tempStyle,
    styleConfidence: tempConf,
    styleSource: tempSource,
    techniqueHints: chosen.meta.techniqueHints || [],
    visionTechniqueHints: visionTechHints,
    visionDescription,
    postSummary: reconciledIntent.summary,
    postIntent: reconciledIntent.intent,
    postTone: reconciledIntent.tone,
    sensitive: reconciledIntent.sensitive,
  });
  const text = gen.text;
  if (!text.trim()) {
    logBehavior('comment_skip_generation_failed', {
      handle,
      postUrl: chosen.meta?.url || '',
      source: 'task_review',
      // 空 = 模型没吐可用文案；非空 = 真原因（api_error / too_short / grounding_fail / too_similar / timeout）
      diag: gen.diag,
      visionUsed: !!visionDescription,
      style: tempStyle,
      styleConfidence: tempConf,
    });
    return { attempted: 1, posted: 0, skipped: true, reason: 'comment_generation_failed' };
  }
  pruneRecentCommentHashes();
  const textHash = hashString(normalizeForMatch(text));
  const dup = (likeState.comments!.recentText || []).some((x) => x.hash === textHash);
  if (dup) return { attempted: 1, posted: 0, skipped: true, reason: 'comment_dup' };

  try {
    const postUrl = chosen.meta?.url || '';
    if (!postUrl || !extractPostKey(postUrl)) {
      return { attempted: 1, posted: 0, skipped: true, reason: 'comment_post_url_missing' };
    }
    const draftId = await queueCommentDraftForReview(handle, postUrl, text, chosen.meta, {
      style: tempStyle,
      styleConfidence: tempConf,
      visionDescription,
    });
    recordCommentDraftQueued('task_review');
    likeState.comments!.byHandle![handle] = { lastCommentAt: Date.now() };
    likeState.comments!.recentText!.push({ ts: Date.now(), hash: textHash });
    pruneRecentCommentHashes();
    saveLikeState(likeState);
    return { attempted: 1, posted: 0, skipped: false, reason: 'comment_review_pending', text, postUrl };
  } catch (error: any) {
    await closeModal().catch(() => {});
    logBehavior('comment_review_queue_failed', { handle, reason: String(error?.message || error).slice(0, 180) });
    return { attempted: 1, posted: 0, skipped: true, reason: 'comment_review_queue_failed' };
  }
};

// 抓取弹窗里"最大的帖子图"的 src（scontent 签名 URL）。仅取 URL 字符串，不下载；
// 视觉分析时直接把 URL 交给视觉模型服务端拉取（避免浏览器 CORS 抓图）。无图/出错返回 ''。
const getVisiblePostImage = async (): Promise<{ src: string; alt: string }> => {
  if (!page) return { src: '', alt: '' };
  try {
    return await page.evaluate(() => {
      const imgs = Array.from(
        document.querySelectorAll('div[role="dialog"] img[src*="scontent"]')
      ) as HTMLImageElement[];
      let best: HTMLImageElement | null = null;
      let bestScore = 0;
      for (const im of imgs) {
        const rect = im.getBoundingClientRect();
        const style = getComputedStyle(im);
        const visibleWidth = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0) continue;
        if (visibleWidth < 220 || visibleHeight < 220) continue;
        // Current carousel frame occupies the largest visible area. Preloaded
        // off-screen slides and avatars are excluded by the intersection test.
        const score = visibleWidth * visibleHeight;
        if (score > bestScore) { bestScore = score; best = im; }
      }
      return { src: best?.src || '', alt: best?.alt || '' };
    });
  } catch {
    return { src: '', alt: '' };
  }
};

const readModalMeta = async (primaryStyle: string, expectedHandle = '', followerCount = 0) => {
  if (!page) return { score: -999, reason: 'no_page' };
  const url = page.url();
  const postKey = extractPostKey(url);
  let ownerHandle = '';
  try {
    const hrefs = await page.locator('div[role="dialog"] header a[href^="/"]').evaluateAll((els) =>
      (els as HTMLAnchorElement[]).map((e) => e.getAttribute('href') || '')
    );
    for (const h of hrefs) {
      const m = String(h || '').match(/^\/([^\/\?\#]+)\/?$/);
      if (m?.[1]) {
        ownerHandle = normalizeHandle(m[1]);
        if (ownerHandle) break;
      }
    }
  } catch {}
  const expected = normalizeHandle(expectedHandle);
  const isOwnerPost = expected ? ownerHandle === expected : true;
  // Caption is the first post row. Reading every <li> also pulled user comments
  // into the prompt and made the model respond to somebody else's words.
  let caption = '';
  try {
    const row = page.locator('div[role="dialog"] ul li, article ul li').first();
    caption = String(await row.innerText({ timeout: 4000 }) || '');
    if (ownerHandle) caption = caption.replace(new RegExp(`^\\s*${ownerHandle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*`, 'i'), '');
    caption = caption
      .replace(/\b(Reply|See translation|Edited)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
  } catch {}
  // Use only the currently visible carousel frame. Combining alt text from
  // hidden slides, avatars and suggested posts polluted both intent and vision.
  const visiblePostImage = await getVisiblePostImage();
  const altHints = visiblePostImage.alt.slice(0, 300);
  const postImageSrc = visiblePostImage.src;
  const dt = await page.locator('time').first().getAttribute('datetime').catch(() => null);
  const dialogText = normalizeForMatch(
    (await page.locator('div[role="dialog"]').first().innerText().catch(() => '')) || ''
  );
  const likesMatch = dialogText.match(/(\d[\d,\.]*)\s+likes?\b/i);
  const commentsMatch = dialogText.match(/view all\s+(\d[\d,\.]*)\s+comments?\b/i);
  const likeCount = likesMatch?.[1] ? Number(String(likesMatch[1]).replace(/[^\d]/g, '')) : 0;
  const commentCount = commentsMatch?.[1] ? Number(String(commentsMatch[1]).replace(/[^\d]/g, '')) : 0;
  const ageDays = toAgeDays(dt || undefined);
  const blob = normalizeForMatch(`${caption} ${altHints}`);
  const positive = keywordHits(blob, POSITIVE_KEYWORDS).length;
  const promo = keywordHits(blob, PROMO_KEYWORDS).length;
  const cta = keywordHits(blob, BUSINESS_CTA_KEYWORDS).length;

  // 风格检测（核心改进）：用分类法从 caption/hashtag(作者自标) + IG alt 文本识别具体风格。
  // 作者自标(正文或 #tag) → high 置信 → 评论可深入该风格工艺（VISION 安全，因风格来自文本）；
  // 仅 alt 猜测 → medium，谨慎引用；无信号 → low，安全通用评论。
  const det = detectTattooStyle(caption, altHints);
  const postStyle = det.primary;
  const styleConfidence = det.confidence;
  const styleSource = det.source;
  const techniqueHints = det.techniqueHints;
  const styleBoost = postStyle ? (styleConfidence === 'high' ? 3 : styleConfidence === 'medium' ? 2 : 1) : 0;
  const isReel = /\/reel\//i.test(url);
  let score = 0;
  if (ageDays <= BOT_PREFER_RECENT_DAYS) score += 4;
  else if (ageDays <= BOT_SKIP_OLD_POST_DAYS) score += 2;
  else score -= 8;
  score += positive * 2;
  score += styleBoost * 2;
  score += cta * 2;
  // Engagement-aware like scoring: absolute count OR engagement rate
  const engagementRate = followerCount > 0 ? likeCount / followerCount : 0;
  if (followerCount > 0 && engagementRate > 0) {
    // Relative: high-engagement posts for this account size
    if (engagementRate >= 0.15) score += 4;
    else if (engagementRate >= 0.07) score += 3;
    else if (engagementRate >= 0.03) score += 2;
    else score += 1;
  } else {
    // Fallback to absolute thresholds when followerCount unknown
    if (likeCount >= 500) score += 3;
    else if (likeCount >= 150) score += 2;
    else if (likeCount >= 60) score += 1;
  }
  if (commentCount >= 20) score += 2;
  else if (commentCount >= 8) score += 1;
  score -= promo * 5;
  if (isReel) score -= 2;
  // Post-type scoring: prefer content posts, deprioritize ads/booking
  const postType = detectPostType(caption, altHints ? [altHints] : []);
  const subject = detectSubject(caption, altHints ? [altHints] : [], ownerHandle);
  const intent = detectPostIntent(caption, altHints ? [altHints] : []);
  if (postType === 'healed') score += 2;
  else if (postType === 'before_after') score += 2;
  else if (postType === 'wip') score += 1;
  else if (postType === 'booking') score -= 3;
  else if (postType === 'flash') score -= 4;
  return { url, postKey, ownerHandle, isOwnerPost, dt, ageDays, score, positive, promo, cta, styleBoost, isReel, likeCount, commentCount, postType, postStyle, styleConfidence, styleSource, techniqueHints, postImageSrc, subject, caption, imageAlt: altHints, postIntent: intent.intent, postSummary: intent.summary, postTone: intent.tone, sensitive: intent.sensitive };
};

const closeModal = async () => {
  if (!page) return;
  // Escape 键最可靠：绕过 IG overlay 拦截
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(jitter(400, 1000));
    // 检查是否真的关掉了（没关掉再走 click 兜底）
    const stillOpen = await page.locator('div[role="dialog"]').first().isVisible().catch(() => false);
    if (!stillOpen) { await page.waitForTimeout(jitter(200, 600)); return; }
  } catch {}
  // 兜底：click SVG Close
  try {
    const closeBtn = page.locator('svg[aria-label="Close"]').first();
    if (await closeBtn.count() > 0) {
      await closeBtn.click({ timeout: 3000, force: true }).catch(() => {});
    }
  } catch {}
  await page.waitForTimeout(jitter(600, 1400));
};

const getDayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

const getLikePolicy = (command?: CommandPayload) => {
  const wp = command?.protocol?.warmupPolicy || {};
  const perVisitMin = Math.max(0, Math.min(5, Number(wp.likePerVisitMin || BOT_LIKE_MIN_PER_VISIT)));
  const perVisitMax = Math.max(perVisitMin, Math.min(8, Number(wp.likePerVisitMax || BOT_LIKE_MAX_PER_VISIT)));
  const gapMin = Math.max(10, Number(wp.likeGapSecMin || BOT_LIKE_INTERVAL_MIN_SEC));
  const gapMax = Math.max(gapMin, Number(wp.likeGapSecMax || BOT_LIKE_INTERVAL_MAX_SEC));
  const cooldownMin = Math.max(4, Number(wp.revisitCooldownHoursMin || BOT_LIKE_COOLDOWN_MIN_HOURS));
  const cooldownMax = Math.max(cooldownMin, Number(wp.revisitCooldownHoursMax || BOT_LIKE_COOLDOWN_MAX_HOURS));
  // 2026-08-07: 提量到 ~100-180 likes/day（用户要求 100-200 综合动作/天）。
  // 默认值上调；个别任务仍可用 protocol.warmupPolicy 覆盖。
  const dailyMin = Math.max(1, Number(wp.dailyLikeMin || 60));
  const dailyMax = Math.max(dailyMin, Number(wp.dailyLikeMax || 160));
  const likeRatio = Math.max(0, Math.min(1, Number(wp.likeRatio || 0.9)));
  return {
    perVisitMin,
    perVisitMax,
    gapMin,
    gapMax,
    cooldownMin,
    cooldownMax,
    dailyMin,
    dailyMax,
    likeRatio
  };
};

const getSingleHandleLikeCap = (command?: CommandPayload) => {
  const ageDays = getAccountAgeDays(command);
  if (ageDays < 3) return 1;        // 新号：每 handle 仅 1 赞（暖机）
  if (ageDays < 30) return 2;       // 成长期：2
  return 2;                         // 成熟号：维持 2（已由日总上限控量）
};

const getDefaultDailyBrowseTarget = (command?: CommandPayload) => {
  const stage = String(command?.accountStage || '').toLowerCase();
  if (stage === 'new') return BOT_DAILY_BROWSE_TARGET_NEW;
  if (stage === 'transition') return BOT_DAILY_BROWSE_TARGET_TRANSITION;
  return BOT_DAILY_BROWSE_TARGET_STABLE;
};

const getDailyLikeCap = (command?: CommandPayload) => {
  const policy = getLikePolicy(command);
  const wp = command?.protocol?.warmupPolicy || {};
  const dayKey = getDayKey();
  const capState = likeState.likes!.dayCap;
  if (!capState || capState.key !== dayKey) {
    const configuredDailyBrowseTarget = Math.max(1, Number(wp.dailyBrowseTarget || 0)) || getDefaultDailyBrowseTarget(command);
    const touchedToday = Number(likeState.touchesByDay?.[dayKey] || 0);
    const expectedBrowse = Math.max(configuredDailyBrowseTarget, touchedToday);
    const dynamicByRatio = Math.round(expectedBrowse * policy.likeRatio);
    const baseCap = Math.max(policy.dailyMin, Math.min(policy.dailyMax, dynamicByRatio));
    const jitteredCap = Math.max(policy.dailyMin, Math.min(policy.dailyMax, baseCap + randInt(-1, 1)));
    likeState.likes!.dayCap = { key: dayKey, cap: jitteredCap };
    saveLikeState(likeState);
  }
  return Number(likeState.likes!.dayCap!.cap || policy.dailyMax);
};

const tryLikeWithStrategy = async (handle: string, facts?: ProfileFacts, command?: CommandPayload): Promise<LikeActionSummary> => {
  if (!page) throw new Error('page_not_initialized');
  const policy = getLikePolicy(command);
  const dayKey = getDayKey();
  // 2026-08-06: BOT_DAILY_LIKE_OVERRIDE 强制指定"今日已点赞数"（0=清零），
  // 用于绕过本地状态文件里旧 bot 刷满的计数（VPS 文件难改，用环境变量控制）。
  const overrideRaw = String(process.env.BOT_DAILY_LIKE_OVERRIDE || '').trim();
  const dayCount = overrideRaw !== ''
    ? Math.max(0, Math.min(50, Number(overrideRaw) || 0))
    : Number(likeState.likes?.byDay?.[dayKey] || 0);
  const dayCap = getDailyLikeCap(command);
  if (dayCount >= dayCap) {
    logBehavior('like_skip_daily_limit', { handle, dayKey, dayCount, dayCap, override: overrideRaw || null });
    return { attempted: 0, liked: 0, skippedCooldown: true, likedUrls: [] };
  }

  const state = likeState.byHandle[handle] || {};
  if (state.nextEligibleAt && Date.now() < state.nextEligibleAt) {
    logBehavior('like_skip_cooldown', { handle, nextEligibleAt: state.nextEligibleAt });
    return { attempted: 0, liked: 0, skippedCooldown: true, likedUrls: [] };
  }

  const tiles = page.locator('article a[href*="/p/"], article a[href*="/reel/"], main a[href*="/p/"], main a[href*="/reel/"]');
  const total = await tiles.count();
  // 评分候选数收敛到 3：只为 2-3 次点赞挑出最优帖，避免打开过多 modal 拖爆看门狗。
  const candidateCount = Math.min(total, 3);
  const candidates: { idx: number; score: number; meta: any }[] = [];
  const primaryStyle = getPrimaryStyle(facts);
  for (let idx = 0; idx < candidateCount; idx++) {
    try {
      await tiles.nth(idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(700, 1600));
      await tiles.nth(idx).click({ timeout: 6000 });
      await page.waitForTimeout(jitter(1000, 2200));
      const meta = await readModalMeta(primaryStyle, '', facts?.followers);
      // "主推帖"加权：优先前3个（常见置顶区）+ 互动高 + 有业务CTA
      const pinnedLikelyBoost = idx < 3 ? 3 : 0;
      const boostedScore = Number(meta.score || 0) + pinnedLikelyBoost;
      candidates.push({ idx, score: boostedScore, meta: { ...meta, pinnedLikelyBoost } });
      await closeModal();
    } catch {
      await closeModal().catch(() => {});
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const desiredLikes = randInt(policy.perVisitMin, policy.perVisitMax);
  const singleHandleCap = getSingleHandleLikeCap(command);
  const remainingDayQuota = Math.max(0, dayCap - dayCount);
  const maxLikes = Math.min(desiredLikes, candidates.length, remainingDayQuota, singleHandleCap);
  dbg(`[dbg-like] handle=${handle} total=${total} candCount=${candidateCount} candLen=${candidates.length} scores=[${candidates.map(c=>c.score).join(',')}] maxLikes=${maxLikes} desired=${desiredLikes} dayCount=${dayCount} dayCap=${dayCap} singleCap=${singleHandleCap}`);
  let liked = 0;
  const likedUrls: string[] = [];
  logBehavior('like_policy_applied', {
    handle,
    desiredLikes,
    maxLikes,
    singleHandleCap,
    dayCount,
    dayCap,
    accountAgeDays: Number(command?.accountAgeDays || 0) || null,
    accountStage: String(command?.accountStage || '') || null
  });

  for (const c of candidates) {
    if (liked >= maxLikes) break;
    if (c.score < 1) continue;
    // 穿孔帖不点赞（整个不碰）
    if (c.meta.subject?.subject === 'piercing') {
      logBehavior('like_skip_piercing', { handle, idx: c.idx, ownerHandle: c.meta.ownerHandle || '' });
      continue;
    }
    try {
      await tiles.nth(c.idx).scrollIntoViewIfNeeded();
      await page.waitForTimeout(jitter(900, 2000));
      await tiles.nth(c.idx).click({ timeout: 10000 });
      await page.waitForTimeout(jitter(1200, 2400));
      const likeBtn = page.locator('svg[aria-label="Like"]').first();
      if ((await likeBtn.count()) > 0) {
        await likeBtn.click({ timeout: 8000 });
        liked += 1;
        likedUrls.push(page.url());
        logBehavior('like_post', {
          handle,
          idx: c.idx,
          score: c.score,
          url: page.url(),
          ageDays: Math.floor(c.meta.ageDays || 0),
          likeCount: Number(c.meta.likeCount || 0),
          commentCount: Number(c.meta.commentCount || 0),
          cta: Number(c.meta.cta || 0),
          pinnedLikelyBoost: Number(c.meta.pinnedLikelyBoost || 0)
        });
      } else {
        const btn = page.locator('button').filter({ hasText: /Like/i }).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 8000 });
          liked += 1;
          likedUrls.push(page.url());
          logBehavior('like_post', {
            handle,
            idx: c.idx,
            score: c.score,
            url: page.url(),
            ageDays: Math.floor(c.meta.ageDays || 0),
            likeCount: Number(c.meta.likeCount || 0),
            commentCount: Number(c.meta.commentCount || 0),
            cta: Number(c.meta.cta || 0),
            pinnedLikelyBoost: Number(c.meta.pinnedLikelyBoost || 0)
          });
        }
      }
      if (liked > 0) recordInteraction(handle, 'like', { idx: c.idx, url: page.url() }).catch(() => {});
      // 🛑 检测 IG 限制信号（点赞后常弹 "Action Blocked"），命中立即停手并启动账号休息
      try {
        const bsig = await detectBlockSignal();
        if (bsig) { await triggerAccountRest(bsig.severity, bsig.text); break; }
      } catch {}
      await page.waitForTimeout(jitter(1200, 2600));
      await closeModal();
      if (liked < maxLikes) {
        const gapSec = randInt(policy.gapMin, policy.gapMax);
        logBehavior('like_gap_wait', { handle, gapSec });
        await sleep(gapSec * 1000);
      }
    } catch {
      await closeModal().catch(() => {});
    }
  }

  const cooldownHours = randInt(Math.floor(policy.cooldownMin), Math.floor(policy.cooldownMax));
  likeState.byHandle[handle] = {
    lastLikedAt: Date.now(),
    nextEligibleAt: Date.now() + cooldownHours * 60 * 60 * 1000
  };
  likeState.likes!.byDay![dayKey] = dayCount + liked;
  // 🔴 2026-09-19：`dayCount` 在 override 生效时恒为 0 ⇒ 上面这行把 byDay 写成「本轮赞数」，
  // 下次会话又被覆盖 ⇒ 面板 likes 恒 0、「今天总共点了多少赞」永远查不到（用户两次问到这个数）。
  // realByDay 只增不减，不受 override 影响，专门用来回答「达到总数了没有」。
  likeState.likes!.realByDay = likeState.likes!.realByDay || {};
  const realAfter = Number(likeState.likes!.realByDay[dayKey] || 0) + liked;
  likeState.likes!.realByDay[dayKey] = realAfter;
  saveLikeState(likeState);
  logBehavior('like_session_done', {
    handle,
    liked,
    attempted: maxLikes,
    cooldownHours,
    dayCountAfter: Number(likeState.likes!.byDay![dayKey] || 0),
    // 真累计（A 账：任务/目标帖点赞）。回答「今天总共点了多少」只认这个字段，
    // dayCountAfter 在 override 生效时是假的（= 本轮赞数）。
    dayCountReal: realAfter,
    dayCap
  });
  return { attempted: maxLikes, liked, skippedCooldown: false, likedUrls };
};

// =====================================================================
// DM Marketing Execution — send Instagram DMs from marketing_tasks
// =====================================================================

const executeDmTask = async (task: any): Promise<boolean> => {
  if (!page) throw new Error('page_not_initialized');
  const targetHandle = String(task.target_handle || '').replace(/^@/, '').trim();
  // 🛑 self-DM 双保险：target 是 bot 自己则直接放弃
  const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
  if (selfIds.has(targetHandle.toLowerCase())) {
    logBehavior('dm_self_skip', { targetHandle });
    return false;
  }
  let scriptContent = '';
  try {
    const parsed = typeof task.script_content === 'string' ? JSON.parse(task.script_content) : task.script_content;
    scriptContent = parsed?.template || parsed?.content || task.script_content;
  } catch {
    scriptContent = String(task.script_content || '');
  }
  if (!targetHandle || !scriptContent) return false;

  logBehavior('dm_start', { targetHandle, taskId: task.id });
  try {
    // Step 1: Navigate to DM new message
    await page.goto(`${IG_BASE}/direct/new/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(2000, 4000));

    // Step 2: Type target handle in search
    const searchInput = page.locator('input[type="text"]').first();
    await searchInput.waitFor({ timeout: 10000 }).catch(() => {});
    await searchInput.fill('');
    // Type slowly like a human
    for (const char of targetHandle) {
      await page.keyboard.type(char, { delay: jitter(60, 180) });
    }
    await page.waitForTimeout(jitter(1500, 3000));

    // Step 3: Click the matching user result
    const userResult = page.locator(`[role="button"]:has-text("${targetHandle}")`).first();
    const clicked = await userResult.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!clicked) {
      // Try alternative selector
      const altResult = page.locator(`a[href="/${targetHandle}/"]`).first();
      await altResult.click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(jitter(1000, 2500));

    // Step 4: Click "Chat" or "Next" button
    const chatBtn = page.locator('button:has-text("Chat"), button:has-text("Next"), div[role="button"]:has-text("Chat")').first();
    await chatBtn.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(jitter(2000, 3500));

    // Step 5: Type message with human-like typing
    const msgArea = page.locator('div[role="textbox"], textarea, div[contenteditable="true"]').first();
    await msgArea.waitFor({ timeout: 10000 }).catch(() => {});
    await msgArea.click();
    await page.waitForTimeout(jitter(500, 1200));
    // Type word by word with pauses
    const words = scriptContent.split(/(\s+)/);
    for (const word of words) {
      await page.keyboard.type(word, { delay: jitter(40, 120) });
      if (Math.random() < 0.15) await page.waitForTimeout(jitter(300, 800)); // occasional mid-msg pause
    }
    await page.waitForTimeout(jitter(800, 2000));

    // Step 6: Send
    const sendBtn = page.locator('button:has-text("Send"), button[type="submit"], div[role="button"]:has-text("Send")').first();
    const sent = await sendBtn.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!sent) {
      // Fallback: press Enter
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(jitter(2000, 4000));

    logBehavior('dm_sent', { targetHandle, taskId: task.id });
    recordInteraction(targetHandle, 'dm', { scriptContent, taskId: task.id }).catch(() => {});
    reportDmChat(targetHandle, 'agent', scriptContent, 'contacted').catch(() => {});
    // 🛑 检测 IG 限制信号（DM 后常弹 "Action Blocked / Try again later"）
    try {
      const bsig = await detectBlockSignal();
      if (bsig) await triggerAccountRest(bsig.severity, bsig.text);
    } catch {}
    // 记录出站 DM 文本哈希，防止随后扫描把 bot 自己的消息误当客户新消息（防自回复死循环）
    if (targetHandle && likeState.dmSeen) {
      likeState.dmSeen[targetHandle] = hashString(scriptContent || '');
      saveLikeState(likeState);
    }
    return true;
  } catch (err: any) {
    logBehavior('dm_failed', { targetHandle, taskId: task.id, error: String(err?.message || '') });
    return false;
  }
};

/** Check for and execute a pending DM marketing task */
const tryExecuteDmTask = async (): Promise<boolean> => {
  try {
    const data = await getJson(`/api/marketing/tasks/poll?botId=${encodeURIComponent(BOT_ID)}&limit=1`);
    const tasks: any[] = Array.isArray(data?.tasks) ? data.tasks : [];
    if (!tasks.length) return false;
    const task = tasks[0];
    const tgt = String(task.target_handle || '').replace(/^@/, '').toLowerCase();
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    if (selfIds.has(tgt)) { // 🛑 self-DM 守卫（poll 路径）
      logBehavior('dm_self_skip', { targetHandle: task.target_handle });
      await postJson('/api/marketing/tasks/report', { taskId: task.id, status: 'failed', botId: BOT_ID, note: 'self_target' }).catch(() => {});
      return false;
    }
    logBehavior('dm_task_acquired', { taskId: task.id, targetHandle: task.target_handle });
    const success = await executeDmTask(task);
    await postJson('/api/marketing/tasks/report', {
      taskId: task.id,
      status: success ? 'sent' : 'failed',
      botId: BOT_ID
    }).catch(() => {});
    return success;
  } catch (err: any) {
    logBehavior('dm_poll_error', { error: String(err?.message || '') });
    return false;
  }
};

// =====================================================================
// DM Auto-Reply — check incoming DMs, classify intent, auto-respond
// =====================================================================

const classifyIntent = (text: string): { intent: string; category: string } => {
  const lower = String(text || '').toLowerCase();
  // Post-purchase signals — check before generic "buy/order" to avoid false match
  if (/\border\s*(number|[#＃]|id|no\.?|placed|confirmed|received|status|track|已下单|已付款|收到了|订单号|已收到|确认订单)|tracking|shipped|delivered|收到货|payment\s*(made|sent|done|confirm)|just\s*(ordered|paid|bought)|已经(下单|付款)|已[经]?付/i.test(lower))
    return { intent: 'purchase_confirmed', category: 'after_sales' };
  if (/how much|\$|price|cost|多少钱|报价|价格/i.test(lower))
    return { intent: 'pricing', category: 'product_intro' };
  if (/what brand|which (product|machine|ink)|推荐|suggest|型号/i.test(lower))
    return { intent: 'product_inquiry', category: 'product_intro' };
  if (/collab|合作|partner|wholesale|批发|代理/i.test(lower))
    return { intent: 'collaboration', category: 'collaboration' };
  if (/buy|purchase|want|interested|order|下单|想买|需要/i.test(lower))
    return { intent: 'purchase', category: 'after_sales' };
  if (/thanks|thank you|nice|great|awesome/i.test(lower))
    return { intent: 'casual_chat', category: 'industry_talk' };
  return { intent: 'casual_chat', category: 'industry_talk' };
};

const pickAutoReply = async (targetHandle: string, intent: string, category: string): Promise<string> => {
  try {
    const data = await postJson('/api/marketing/scripts/select', {
      category,
      intent,
      targetHandle,
      profileFacts: {}  // bot doesn't have profile facts at this point
    });
    const content = data?.selected?.content;
    if (content) return content;
    // Fallback: use category-appropriate template
    const fallbacks: Record<string, string> = {
      product_intro: `Hey @${targetHandle} — so glad you reached out! Happy to help you get sorted. What are you mainly running low on right now — ink, carts, or aftercare? I'll pull together options that actually fit how you work 🙌`,
      collaboration: `Love that you're thinking bigger @${targetHandle} — collabs are the fun part. Tell me a bit about your style and what you'd want to build, and let's see if we're a fit to work together ✌️`,
      industry_talk: `Always good to trade notes with another person in the chair @${targetHandle} 😄 What's been keeping you busy in the studio lately?`,
      after_sales: `Appreciate you checking in @${targetHandle}! Everything land the way you expected? If anything's off or you want to tweak your next order, I'm right here 👍`,
    };
    return fallbacks[category] || `Hey @${targetHandle} — so glad you messaged! What can I help you with? I'm right here 🙌`;
  } catch {
    return `Hey @${targetHandle} — so glad you messaged! What can I help you with? I'm right here 🙌`;
  }
};

// Extract the conversation partner's IG handle from the opened DM thread header.
// Best-effort: the opened conversation pane links the partner's profile as a[href="/<handle>/"].
// Left-side thread-list links are /direct/t/... (excluded) and our own profile is skipped.
const extractThreadHandle = async (): Promise<string> => {
  if (!page) return '';
  try {
    const selfHandle = String(ACCOUNT_IDS[0] || BOT_ID.replace('bot_', '')).toLowerCase();
    const SKIP = new Set(['direct', 'explore', 'accounts', 'p', 'reel', 'tv', 'create', 'edit', 'settings', 'about', 'emails', 'logout', 'story']);
    const links = page.locator('a[href^="/"]');
    const n = await links.count();
    for (let k = 0; k < n; k++) {
      const href = (await links.nth(k).getAttribute('href') || '').trim();
      const m = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
      if (m) {
        const h = m[1].toLowerCase();
        if (h && h !== selfHandle && !SKIP.has(h)) return h;
      }
    }
  } catch {}
  return '';
};

const checkDmReplies = async (): Promise<number> => {
  if (!page) return 0;
  let handled = 0;
  try {
    // Only check replies when no pending DM tasks
    const data = await getJson(`/api/marketing/tasks/poll?botId=${encodeURIComponent(BOT_ID)}&limit=1`);
    if ((data?.tasks || []).length > 0) return 0;

    await page.goto(`${IG_BASE}/direct/inbox/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(3000, 5000));

    const threads = page.locator('a[href*="/direct/t/"]');
    const count = await threads.count();
    if (count === 0) return 0;

    const checkLimit = Math.min(count, 3);
    for (let i = 0; i < checkLimit; i++) {
      try {
        await threads.nth(i).click();
        await page.waitForTimeout(jitter(2000, 4000));

        const msgSpan = page.locator('[role="row"] div[dir="auto"] span').last();
        const latestText = await msgSpan.textContent().catch(() => '');
        if (!latestText) continue;

        const { intent, category } = classifyIntent(latestText);

        const partnerHandle = await extractThreadHandle();

        // 去重守卫：空 handle 或最新消息就是 bot 自己上次的回复 → 跳过，避免反复自回复
        if (!partnerHandle) { logBehavior('dm_reply_skip_empty_handle'); continue; }
        const lastSeen = likeState.dmSeen?.[partnerHandle];
        const curHash = hashString(latestText);
        if (lastSeen && lastSeen === curHash) { logBehavior('dm_reply_skip_own_echo', { targetHandle: partnerHandle }); continue; }

        if (intent === 'purchase_confirmed') {
          // Post-purchase: send thank-you directly, mark as converted (no marketing script)
          const msg = `Thank you for your order @${partnerHandle || ''}! We appreciate your business. If you have any questions about your order, feel free to ask.`;
          const input = page.locator('div[role="textbox"]').first();
          await input.click();
          await page.waitForTimeout(jitter(500, 1200));
          for (const char of msg) {
            await page.keyboard.type(char, { delay: jitter(30, 90) });
            if (Math.random() < 0.1) await page.waitForTimeout(jitter(200, 600));
          }
          await page.waitForTimeout(jitter(800, 1800));
          await page.keyboard.press('Enter');
          await page.waitForTimeout(jitter(1500, 3000));
          handled++;
          logBehavior('dm_purchase_confirmed', { targetHandle: partnerHandle, text: latestText.slice(0, 80) });
          reportDmChat(partnerHandle, 'customer', latestText, 'won').catch(() => {});
          if (likeState.dmSeen) { likeState.dmSeen[partnerHandle!] = hashString(latestText); saveLikeState(likeState); }
          if (partnerHandle) {
            postJson('/api/marketing/tasks/mark-converted', { targetHandle: partnerHandle }).catch(() => {});
            logBehavior('dm_converted_reported', { targetHandle: partnerHandle, source: 'dm_keyword' });
          }
        } else {
          // Normal auto-reply flow
          const reply = await pickAutoReply(partnerHandle, intent, category);
          const input = page.locator('div[role="textbox"]').first();
          await input.click();
          await page.waitForTimeout(jitter(500, 1200));
          for (const char of reply) {
            await page.keyboard.type(char, { delay: jitter(30, 90) });
            if (Math.random() < 0.1) await page.waitForTimeout(jitter(200, 600));
          }
          await page.waitForTimeout(jitter(800, 1800));
          await page.keyboard.press('Enter');
          await page.waitForTimeout(jitter(1500, 3000));
          handled++;
          logBehavior('dm_reply_sent', { intent, category, targetHandle: partnerHandle });
          // Sync incoming customer message + agent auto-reply to sales_chats
          if (partnerHandle) {
            reportDmChat(partnerHandle, 'customer', latestText).catch(() => {});
            reportDmChat(partnerHandle, 'agent', reply).catch(() => {});
          }
          if (likeState.dmSeen) { likeState.dmSeen[partnerHandle!] = hashString(reply); saveLikeState(likeState); }

          // Report "replied" so the Worker flips the lead's marketing_task.
          // No-op on the Worker side if this handle has no engaged task.
          if (partnerHandle) {
            postJson('/api/marketing/tasks/report', {
              targetHandle: partnerHandle,
              status: 'replied',
              botId: BOT_ID
            }).catch(() => {});
            logBehavior('dm_replied_reported', { targetHandle: partnerHandle });
          }
        }
      } catch (err: any) {
        logBehavior('dm_reply_error', { i, err: String(err?.message || '') });
      }
    }
  } catch (err: any) {
    logBehavior('dm_check_error', { err: String(err?.message || '') });
  }
  return handled;
};

const executeCommand = async (command: CommandPayload) => {
  const commandId = command.id;
  const handle = String(command.artistHandle || '').replace(/^@/, '').trim();
  if (!handle) throw new Error('missing_artist_handle');
  // 2026-08-07：任务 payload 的 country/city（create-from-artists 带出）→ 记入位置缓存，
  // 供回关 DM/评论按对方国家语言发文案。
  if ((command as any).country || (command as any).city) {
    countryCache[handle] = { country: String((command as any).country || ''), city: String((command as any).city || '') };
    const st = likeState.follows?.byHandle?.[handle] as any;
    if (st) { st.country = st.country || String((command as any).country || ''); st.city = st.city || String((command as any).city || ''); }
  }
  // 2026-08-06：任务 payload 里的前台动作偏好 → 动态覆盖本进程默认值。
  // 前台「动作偏好」面板设置的 点赞/评论/关注 次数，由 ig-scheduler 写进任务 payload，
  // 这里在本次任务执行期间生效（不污染全局 env，进程级开关保持原样）。
  const pLikes = Number((command as any).likesPerSession ?? NaN);
  const pComments = Number((command as any).commentsPerSession ?? NaN);
  const pFollows = Number((command as any).followsPerSession ?? NaN);
  const actionOverrides = {
    likesEnabled: Number.isFinite(pLikes) && pLikes > 0,
    commentsEnabled: Number.isFinite(pComments) && pComments > 0,
    followsEnabled: Number.isFinite(pFollows) && pFollows > 0,
    likesMin: Number.isFinite(pLikes) ? Math.max(1, Math.min(5, Math.round(pLikes))) : 0,
  };
  if (actionOverrides.likesEnabled || actionOverrides.commentsEnabled || actionOverrides.followsEnabled) {
    console.log(`[bot-real] action prefs from task: likes=${pLikes} comments=${pComments} follows=${pFollows}`);
  }
  const taskModeRaw = String(command?.suggestedExecMode || '').trim().toLowerCase();
  const execMode = (taskModeRaw === 'browse_only' || taskModeRaw === 'browse_like') ? taskModeRaw : BOT_EXEC_MODE;
  const suppliedAge = Number(command?.accountAgeDays || 0);
  const age = getAccountAgeDays(command);
  const inferredStage = age < 7 ? 'new' : age < 30 ? 'transition' : age < 60 ? 'growing' : 'mature';
  const stage = suppliedAge > 0
    ? (String(command?.accountStage || '').trim().toLowerCase() || inferredStage)
    : inferredStage;
  // Repair already-queued legacy tasks carrying the old hardcoded new/0d values.
  command.accountAgeDays = age;
  command.accountStage = stage;
  console.log(`[bot-real] execute ${commandId} -> @${handle} [stage=${stage}, age=${age}d, mode=${execMode}]`);
  logBehavior('task_start', { commandId, handle, mode: execMode, suggestedExecMode: taskModeRaw || null, accountStage: stage, accountAgeDays: age });
  likeState.touches![handle] = Number(likeState.touches![handle] || 0) + 1;
  const dayKey = getDayKey();
  likeState.touchesByDay![dayKey] = Number(likeState.touchesByDay![dayKey] || 0) + 1;
  if (!likeState.firstTouchAt![handle]) likeState.firstTouchAt![handle] = Date.now();
  saveLikeState(likeState);

  ensureExecMode(execMode);
  ensureBrowserLegacyLaunchDisabled();
  await ensureBrowser();
  logBehavior('ensure_browser_done', { commandId, handle });
  // 登录闸门硬保险：执行任何互动前若发现登录页/挑战页，直接中止本任务
  // （不标 failed，留给下一轮你登录后自动重试）
  if (await isOnLoginPage()) {
    console.log(`[bot-real] ⏸ login/challenge page detected at task start (${commandId}) — aborting task, waiting for you to finish logging in.`);
    logBehavior('login_required_at_task_start', { commandId, handle });
    throw new Error('LOGIN_REQUIRED');
  }
  await escapeFollowTrap();        // escape if previous task left us on explore/people
  await openProfile(handle);
  await escapeFollowTrap();        // escape if profile nav landed on follow suggestions
  if (await isInvalidProfilePage()) {
    logBehavior('invalid_profile', { commandId, handle, url: page?.url() || '' });
    try {
      await reportObservation(command, { totalMedia: 0, opened: 0, desiredOpenCount: 0 }, {
        url: page?.url() || '',
        title: 'invalid_profile',
        bio: '',
        statTexts: [],
        nonTattooSuspect: true,
        invalidProfile: true
      });
      logBehavior('observation_reported', { commandId, handle, invalidProfile: true });
    } catch (err: any) {
      logBehavior('observation_report_failed', { commandId, reason: String(err?.message || 'report_failed') });
    }
    logBehavior('task_done', { commandId, handle, mode: execMode, reviewOnly: true, invalidProfile: true });
    return;
  }
  const profileFacts = await captureProfileFacts();
  if (profileFacts?.nonTattooSuspect) {
    logBehavior('non_tattoo_profile', { commandId, handle, title: profileFacts.title, bio: profileFacts.bio });
    try {
      await reportObservation(command, { totalMedia: 0, opened: 0, desiredOpenCount: 0 }, {
        ...profileFacts,
        nonTattooSuspect: true
      });
      logBehavior('observation_reported', { commandId, handle, nonTattooSuspect: true });
    } catch (err: any) {
      logBehavior('observation_report_failed', { commandId, reason: String(err?.message || 'report_failed') });
    }
    if (BOT_NON_TATTOO_MODE === 'fail') {
      throw new Error('non_tattoo_profile');
    }
    logBehavior('task_review_only', { commandId, handle, reason: 'non_tattoo_suspect' });
    logBehavior('task_done', { commandId, handle, mode: execMode, reviewOnly: true });
    return;
  }
  let summary: BrowseSummary = { totalMedia: 0, opened: 0, desiredOpenCount: 0 };
  let likeSummary: LikeActionSummary = { attempted: 0, liked: 0, skippedCooldown: false, likedUrls: [] };
  let commentSummary: CommentActionSummary = { attempted: 0, posted: 0, skipped: true, reason: 'not_run' };
  let followSummary: FollowActionSummary = { attempted: 0, followed: 0, skipped: true, reason: 'not_run' };
  if (execMode === 'browse_like') {
    summary = await browseProfileDeep();
    await sleep(jitter(1200, 2600));
    // 任务 payload 偏好覆盖：前台设置 likes/comments/follows 次数后，
    // 点赞用 payload 次数（likePerVisitMin/Max），评论/关注按 payload 开关执行。
    const cmdWithPrefs = {
      ...(command || {}),
      suggestedExecMode: 'browse_like',
      ...(actionOverrides.likesMin > 0 ? {
        protocol: {
          ...((command as any)?.protocol || {}),
          warmupPolicy: {
            ...((command as any)?.protocol?.warmupPolicy || {}),
            likePerVisitMin: actionOverrides.likesMin,
            likePerVisitMax: Math.max(actionOverrides.likesMin, Number((command as any)?.likePerVisitMax) || actionOverrides.likesMin),
          },
        },
      } : {}),
    } as CommandPayload;
    likeSummary = await tryLikeWithStrategy(handle, profileFacts, cmdWithPrefs);
    // 评论/关注总开关按 payload 偏好动态开关（不污染全局 env）
    const commentsOn = actionOverrides.commentsEnabled ? true : (BOT_COMMENT_ENABLED && (actionOverrides.likesEnabled || BOT_COMMENT_ENABLED));
    const followsOn = actionOverrides.followsEnabled ? true : BOT_FOLLOW_ENABLED;
    dbg(`[dbg] liked=${likeSummary.liked} followsOn=${followsOn} commentsOn=${commentsOn} handle=${handle}`);
    // 草稿生成不依赖本次点赞成功：这里只做视觉/文案分析并进入人工审核，
    // 不会直接触碰 IG 评论框。实际发布仍必须经过审核且受独立日上限控制。
    if (commentsOn) {
      await sleep(jitter(1400, 2600));
      commentSummary = await tryCommentWithStrategy(handle, profileFacts, likeSummary);
    } else {
      commentSummary = { attempted: 0, posted: 0, skipped: true, reason: 'comment_off' };
    }
    // 关注：回关→DM 链路的关键动作，解耦于点赞。只要 followsOn 就尝试关注，
    // 即使本次未点赞（无可点帖/元数据抓不到），也要能关注，否则永远没有回关来源。
    if (followsOn) {
      await sleep(jitter(1200, 2400));
      followSummary = await tryFollowOnProfile(handle, likeSummary, command);
    } else {
      followSummary = { attempted: 0, followed: 0, skipped: true, reason: 'follow_off' };
    }
    await sleep(jitter(1600, 4200));
  } else {
    summary = await browseProfileDeep();
    await sleep(jitter(1200, 2600));
  }
  try {
    await reportObservation(command, summary, {
      ...profileFacts,
      likeSummary,
      commentSummary,
      followSummary,
      touches: likeState.touches![handle] || 0,
      leadScore: Number(command?.leadScore || 0),
      followPriority: String(command?.followPriority || '')
    });
    logBehavior('observation_reported', { commandId, handle });
  } catch (err: any) {
    logBehavior('observation_report_failed', { commandId, reason: String(err?.message || 'report_failed') });
  }
  logBehavior('task_done', { commandId, handle, mode: execMode });
};

let dmReplyTick = 0;
const pollLoop = async () => {
  while (running) {
    try {
      // 每轮循环打点：区分「健康但空闲」（循环照转 = 有打点）和「真的卡死」
      // （循环转不动 = 无打点）。没有这一行，队列没料时的正常空转会被看门狗误判。
      touchProgress();
      // A warm pause keeps the browser/session and heartbeat alive but does not
      // poll or lease new tasks. The host control listener owns this flag.
      if (fs.existsSync(CONTROL_PAUSE_FILE)) {
        if (!controlPauseLogged) console.log(`[bot-real] control pause active: ${CONTROL_PAUSE_FILE}`);
        controlPauseLogged = true;
        if (Date.now() - controlPauseLoggedAt >= CONTROL_PAUSE_LOG_EVERY_MS) {
          controlPauseLoggedAt = Date.now();
          logBehavior('bot_control_paused', { file: CONTROL_PAUSE_FILE, note: 'loop alive but intentionally idle' });
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      if (controlPauseLogged) console.log('[bot-real] control pause cleared; resuming task polling');
      controlPauseLogged = false;
      // ── 登录闸门：未登录则暂停一切任务派发，原地等登录，不抢任务、不标 failed ──
      const loggedIn = await waitUntilLoggedIn();
      if (!loggedIn) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // ── 账号休息（被动，数据驱动）：IG 限制信号触发后，暂停一切动作直到冷却结束 ──
      //    前台/数据可见（recordInteraction account_rest）；心跳 + 登录校验仍存活，冷却完自动续跑。
      if (isAccountResting()) {
        const leftMin = Math.max(0, Math.round((likeState.rest!.until - Date.now()) / 60000));
        console.log(`[bot-real] 🛑 account resting (${likeState.rest!.severity}): ~${leftMin}min left — skipping all actions, heartbeat alive.`);
        await sleep(Math.min(POLL_INTERVAL_MS, 60_000));
        continue;
      }
      // 每轮顺带复检一次页面是否出现新的限制信号（覆盖挑战/弹窗类，无需动作也查）
      try {
        const bsig = await detectBlockSignal();
        if (bsig) await triggerAccountRest(bsig.severity, bsig.text);
      } catch {}
      if (isAccountResting()) {
        await sleep(Math.min(POLL_INTERVAL_MS, 60_000));
        continue;
      }
      // Human-reviewed comments: only drafts explicitly approved in the front-end
      // are allowed to reach Instagram.
      try {
        const publishedApproved = await tryPublishApprovedComment();
        if (publishedApproved) {
          await sleep(jitter(3500, 9000));
          continue;
        }
      } catch {}
      // ══════════════════════════════════════════════════════════════════════════
      // 🔴 2026-09-19 用户要求：「每天评论点赞先动手，点过了再去点新号；前期评论的、被回复的、
      //   被点赞的都回赞完了，之后每天收到就去点，点完回到日常事务继续。」
      // 这个块整体就在任务轮询之前 ⇒ 「互动先于任务」结构上已经成立。
      // 现在把**评论点赞**两条通道（账 C rapport / 账 B likeBack）提到块首：它们与
      // 暖受众/互动者回流共用 likeBack 预算（AUDIENCE_LIKE_DAILY_MAX），排在后面就会被吃光。
      // ══════════════════════════════════════════════════════════════════════════

      // ① 【最高优先】历史评论帖回扫：复访我们留过评论的 171 篇帖，找「回复了我们」的人，
      //    先赞其评论（账 C）再赞其最新帖（账 B）。回溯期每轮多扫，清完欠账转稳态慢扫；
      //    进度看 post_backscan_cycle 的 stillUnscanned（归 0 = 欠账清完）、phase(backfill→steady)。
      try {
        await backScanCommentedPosts();
      } catch {}
      // ② 【次高优先】回关 rapport 阶梯：赞帖 → 真诚评论 → 赞对方评论（账 C），再发 DM。
      try {
        await syncFollowBackRapport();
      } catch {}
      // ③ 评论互动回流：扫通知页找「赞了/回复了我们的评论」的人 → 回赞（账 B，默认每 ≈22min）。
      try {
        await checkCommentEngagers();
      } catch {}
      // ④ 暖受众回赞：扫我们自己帖下的点赞/评论者 → 回赞（账 B，与 ③ 共用预算，故排在 ③ 之后）。
      try {
        await checkAudienceReciprocate();
      } catch {}
      // ⑤ 检测「对方赞过我们」：查最新帖子点赞者列表，互赞则提前预热窗口。
      try {
        await checkWhoLikedUs();
      } catch {}
      // ⑥ 回关主动复检：每 5 轮回访一个"已关注未检测回关"的号，让回关能被发现。
      try {
        await maybeCheckFollowBacks();
      } catch {}
      // ⑦ 捕获主动关注我们的回流粉：轻探针每 ≈22min 读自己粉丝数，重扫描同节流查 Followers 列表。
      try {
        await checkIncomingFollowBacks();
      } catch {}
      // ⑧ 关注回收：清理长期未回关的号，压低 following:followers 比例。
      //    内部自带节流（默认 30 分钟一轮）、日上限、宽限期与忙碌避让，空转成本极低。
      try {
        await runUnfollowMaintenance({
          page: () => page,
          likeState,
          saveLikeState: () => saveLikeState(likeState),
          logBehavior,
          recordInteraction,
          sleep,
          jitter,
          toBareHandle,
          igBase: IG_BASE,
          busy: () => false,
        });
      } catch {}
      // ── 回关号直接发 DM：每轮扫描，受"熟悉度门槛 + 预热窗口 + 日上限"节流（内部已判断）──
      try {
        await syncFollowBackDmQueue();
      } catch {}
      // ── inbox 回复扫描：每 3 轮限流一次，与 DM 发送解耦 ──
      try {
        dmReplyTick = (dmReplyTick + 1) % 3;
        if (dmReplyTick === 0) await checkDmReplies();
      } catch {}
      await sleep(jitter(1500, 3500));

      const data = await getJson(`/api/automation/poll?botId=${encodeURIComponent(BOT_ID)}&limit=${POLL_LIMIT}`);
      const commands: CommandPayload[] = Array.isArray(data?.commands) ? data.commands : [];
      if (!commands.length) {
        await humanBreak(); // also rest/noise during idle
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      for (const cmd of commands) {
        if (!running) break;
        await humanBreak(); // wait if currently in a break period
        // ── 执行前再确认登录态：登录页/挑战页出现则跳过本任务，不抢、不标 failed，下一轮重判 ──
        // 🔴 2026-09-17：page 为 null 时**先尝试重建浏览器**再决定跳过。
        // 旧写法直接 `if (!page || ...) continue`，而 pollLoop 全程没有 ensureBrowser 调用点
        // ⇒ 一旦 page 被置空（见上面任务失败分支），这里就无限跳过：心跳在、任务永不动。
        if (!page) {
          try {
            await ensureBrowser();
          } catch (e: any) {
            console.log(`[bot-real] page not ready — ensureBrowser retry failed: ${e?.message || e} (will retry next cycle)`);
          }
        }
        if (!page || await isOnLoginPage()) {
          console.log(`[bot-real] ⏸ login page present before task ${cmd?.id} — skipping (retries next cycle after you log in).`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        // Do not make approved comments wait for the entire polled task batch.
        // Failed drafts are backed off by the API, so another approved draft can proceed.
        try {
          const publishedApproved = await tryPublishApprovedComment();
          if (publishedApproved) await sleep(jitter(3500, 9000));
        } catch {}
        // 任务级看门狗：单任务执行上限（默认 8 分钟），超时视为 failed 继续下一个，
        // 防止 IG 页面慢/选择器卡死导致 bot 挂死不再消费队列（2026-08-06 修复）
        const TASK_TIMEOUT_MS = Math.max(60_000, Number(process.env.BOT_TASK_TIMEOUT_MS || 5 * 60_000));
        try {
          await Promise.race([
            executeCommand(cmd),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`task_timeout_${Math.round(TASK_TIMEOUT_MS / 1000)}s`)), TASK_TIMEOUT_MS)),
          ]);
          await reportCommand(cmd.id, 'done');
          console.log(`[bot-real] done ${cmd.id}`);
          tasksSinceLastLearn++;
          if (tasksSinceLastLearn >= LEARN_INTERVAL) {
            tasksSinceLastLearn = 0;
            triggerLearn().catch(() => {}); // auto-analyze in background (never crash the loop)
          }
          await maybeScheduleBreak(cmd); // schedule next break after N profiles
          await sleep(jitter(3500, 9500)); // elastic gap between targets
    } catch (err: any) {
      const reason = String(err?.message || 'worker_exception');
      // 登录态缺失：不抢、不标 failed，跳出本轮任务批次，回到顶部闸门等登录
      if (reason.includes('LOGIN_REQUIRED')) {
        console.log('[bot-real] ⏸ login required — skipped task, will retry after you log in.');
        break;
      }
      console.error(`[bot-real] failed ${cmd?.id || 'unknown'}:`, reason);
          logBehavior('task_failed', { commandId: cmd?.id || null, reason });
          if (cmd?.id) {
            try { await reportCommand(cmd.id, 'failed', reason); } catch {}
          }
          // 超时/异常后重建浏览器上下文，避免脏状态传染下一个任务
          // 🔴 2026-09-17 修复（"bot 活着但不干活"的真凶）：
          // CDP 模式下 page.context() 就是外部 Chrome 的**默认 context**，close() 会把
          // 整个浏览器端 context 关掉；接着 ensureBrowser 里 `browser.contexts()[0]` 变空，
          // 而 Playwright 在 CDP 连接上又不支持 newContext() → 永远连不回来。
          // 于是 page 恒为 null → poll 循环每 25s 打一句 "browser not ready / login page present"
          // 就跳过，心跳照常 → 用户看到"进程活着、任务一条不动、日志一片空"。
          // CDP 模式只能回收这一个标签页，绝不能动 context。
          try {
            if (page) {
              if (BOT_LAUNCH_MODE === 'persistent') {
                await page.context().close().catch(() => {});
              } else {
                await page.close().catch(() => {});
              }
              page = null as any;
            }
          } catch {}
        }
      }
    } catch (err: any) {
      console.error('[bot-real] poll error:', err?.message || err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
};

const heartbeatLoop = async () => {
  let recoverAttempts = 0;
  while (running) {
    try {
      await heartbeatBot();
      recoverAttempts = 0;
      await sleep(HEARTBEAT_INTERVAL_MS);
    } catch (err: any) {
      const message = String(err?.message || err);
      console.error('[bot-real] heartbeat error:', message);
      recoverAttempts++;
      const serverPressure = /\b429\b|quota|daily_read|rate limit/i.test(message);
      if (!serverPressure && recoverAttempts <= 3) {
        // Re-register and re-connect after server restart
        try {
          await registerBot();
          await ensureBrowser();
          console.log('[bot-real] recovered after server restart');
        } catch (recoverErr: any) {
          console.error('[bot-real] recovery failed:', recoverErr?.message || recoverErr);
        }
      }
      // Back off under Cloudflare/D1 pressure instead of retrying every five
      // seconds and doubling traffic with register attempts.
      const retryDelay = serverPressure
        ? Math.min(5 * 60_000, 30_000 * Math.pow(2, Math.min(recoverAttempts - 1, 4)))
        : Math.min(60_000, Math.max(5000, HEARTBEAT_INTERVAL_MS * recoverAttempts));
      await sleep(retryDelay);
    }
  }
};

// ── 停滞看门狗（2026-09-18）────────────────────────────────────────────
// 症状（2026-09-17 19:46 实测卡死 13 小时）：pollLoop 卡在一个永不 resolve 的 await 里
//   ⇒ 零事件、零租约（`automation_tasks` 无 leased），
//   而 heartbeatLoop 是 `Promise.all` 里并发的另一条循环 ⇒ last_heartbeat 照常新鲜
//   ⇒ 前台显示 online 的**假绿灯**，看数据看不出毛病。
//   （旧兜底是 pm2 之外的 ig-watchdog.ps1，已停用 ⇒ 现在没有任何人在管这件事。）
// 处理顺序，越往后越重；**绝不 browser.close()**（9222 被三进程共用）：
//   ① 探活 CDP 协议，不健康就清僵尸 target
//   ② 关掉当前 page（带 5s 竞速，因为协议假死时 close 自己也会挂）
//      ⇒ 卡住的 await 立刻 reject，pollLoop 自己的 catch 接管，下一轮 ensureBrowser 重建
//   ③ 连续 3 次软修复仍无进展 → 受控 exit(1)，让 pm2 拉起干净进程
//      （pm2 托管默认 windowsHide:true，不弹窗；20 分钟冷却标记防崩溃循环）
const stallWatchdogLoop = async () => {
  while (running) {
    await sleep(60_000);
    try {
      // 账号休息 / 人工暂停期间本来就"没动作"，不算卡死
      if (isAccountResting()) { touchProgress(); continue; }
      if (fs.existsSync(CONTROL_PAUSE_FILE)) { touchProgress(); continue; }

      const silentMs = Date.now() - lastProgressAt;
      if (silentMs < STALL_WATCHDOG_MS) {
        if (stallHeals > 0) {
          console.log(`[bot-real] ✅ progress resumed after ${stallHeals} stall heal(s).`);
          stallHeals = 0;
        }
        continue;
      }

      stallHeals++;
      const mins = Math.round(silentMs / 60_000);
      console.error(`[bot-real] ⚠️ poll STALL: no progress for ~${mins}min (heal #${stallHeals}) — probing CDP, then breaking the hung await.`);
      logBehavior('poll_stall_detected', { silentMs, heal: stallHeals });

      const probe = await probeCdpProtocol().catch(() => ({ ok: false, reason: 'probe_threw' }));
      if (!probe.ok) {
        console.error(`[bot-real] ⚠️ CDP protocol unhealthy during stall (${probe.reason}) — healing targets.`);
        await healCdpTargets().catch(() => {});
      }

      if (page) {
        await Promise.race([
          page.close({ runBeforeUnload: false }).catch(() => {}),
          sleep(5_000),
        ]);
      }
      try { await (browser as any)?.disconnect?.(); } catch {}
      page = null;
      browser = null;
      touchProgress();

      if (stallHeals >= 3) {
        let lastRestart = 0;
        try { lastRestart = Number(JSON.parse(fs.readFileSync(STALL_RESTART_MARKER, 'utf8'))?.at || 0); } catch {}
        if (Date.now() - lastRestart <= STALL_RESTART_COOLDOWN_MS) {
          console.error(`[bot-real] ⚠️ stall restart skipped (cooldown ${Math.round(STALL_RESTART_COOLDOWN_MS / 60_000)}min active) — soft heals continue.`);
          continue;
        }
        try {
          fs.writeFileSync(STALL_RESTART_MARKER, JSON.stringify({ at: Date.now(), reason: 'poll_stall', silentMs }), 'utf8');
        } catch {}
        console.error('[bot-real] ⚠️ poll stall not healed after soft attempts — controlled restart (exit 1) so pm2 brings up a clean process.');
        try {
          if (behaviorBuffer.length > 0) {
            const batch = behaviorBuffer.splice(0);
            await postJson('/api/automation/behavior-logs', { logs: batch });
          }
        } catch {}
        process.exit(1);
      }
    } catch (err: any) {
      console.error('[bot-real] stall watchdog error:', String(err?.message || err));
    }
  }
};

const shutdown = async (signal: string) => {
  console.log(`[bot-real] shutdown on ${signal}`);
  running = false;
  // Flush pending behavior logs before exit
  if (behaviorBuffer.length > 0) {
    const batch = behaviorBuffer.splice(0);
    console.log(`[bot-real] flushing ${batch.length} pending behavior logs on ${signal}...`);
    try {
      await postJson('/api/automation/behavior-logs', { logs: batch });
    } catch (e) {
      console.error('[bot-real] behavior-logs flush on shutdown failed:', e);
    }
  }
  try {
    if (BOT_LAUNCH_MODE === 'persistent') {
      if (context) await (context as any).close?.();
    } else if (BOT_CDP_URL) {
      // 🔴 2026-09-17：CDP 模式下 `browser.close()` 会**真的把外部 Chrome 关掉**
      // （Playwright 对 connectOverCDP 的 close 透传 CDP `Browser.close`）。
      // 那个 9222 Chrome 是 bot-worker / competitor-ig-monitor / general-intel **三个进程
      // 共用的长命浏览器** —— 一关就全体瘫痪；随后的重启进程连不上 Chrome，又走到 exit(1)
      // 重启循环里。停机时只断开原生连接：置空引用，随进程退出一起回收。
      browser = null as any; context = null as any; page = null as any;
    }
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

// 🔴 2026-09-19：状态自愈 —— 历史上把 IG 保留路径词当成 handle 写进了 byHandle。
// 实测 `comment_review_queue_failed` 40 条**全部**是 handle=popular + `page.goto: Timeout 45000ms`：
// `syncFollowBackRapport` 每轮迭代它、去开一个不存在的"主页"、白烧 45 秒，然后被 catch 吞掉（无声无息）。
// 新写入已在 2026-09-17 过滤（见 isRealHandle），这里清掉**残留的旧键**。
// 幂等：干净时什么都不做、不写盘。失败静默 —— 绝不因为清状态而挡住启动。
const purgeJunkHandles = () => {
  try {
    const byHandle = likeState.follows?.byHandle;
    if (!byHandle) return;
    const junk = Object.keys(byHandle).filter((h) => !isRealHandle(h));
    if (!junk.length) return;
    for (const h of junk) delete byHandle[h];
    saveLikeState(likeState);
    console.log('[bot-real] purged junk handles from state:', junk.join(', '));
    logBehavior('state_junk_handle_purged', { count: junk.length, handles: junk.slice(0, 20) });
  } catch {}
};

const main = async () => {
  console.log('[bot-real] starting with config:', {
    API_BASE, BOT_ID, BOT_HOST, BOT_VERSION, ACCOUNT_IDS, POLL_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, PROFILE_DIR, HEADLESS,
    pollLimit: POLL_LIMIT,
    minVisibleTiles: BOT_MIN_VISIBLE_TILES,
    cdpMode: Boolean(BOT_CDP_URL),
    cdpUrl: BOT_CDP_URL || null,
    execMode: BOT_EXEC_MODE,
    speedFactor: BOT_SPEED_FACTOR,
    variance: BOT_VARIANCE,
    browseOrder: BOT_BROWSE_ORDER,
    proxyEnabled: Boolean(BOT_PROXY_SERVER),
    proxyServer: BOT_PROXY_SERVER || null,
    commentEnabled: BOT_COMMENT_ENABLED,
    commentDraftDailyMin: BOT_COMMENT_DRAFT_DAILY_MIN,
    commentDraftDailyMax: BOT_COMMENT_DRAFT_DAILY_MAX,
    commentDraftToday: commentDraftsToday(),
    commentDraftTargetToday: getCommentDraftDayTarget(),
    commentPublishDailyMax: BOT_COMMENT_PUBLISH_DAILY_MAX,
    commentsPostedToday: commentsPostedToday(),
  });
  // 视觉/AI 评论就绪状态自检（用户 2026-08-10 问"flash 可以分析了？"——重启后看这行即可确认）
  console.log('[bot-real] [vision-check]', JSON.stringify({
    visionEnabledFlag: (process.env.BOT_VISION_ENABLED || '0') === '1',
    deepseekKeySet: !!process.env.DEEPSEEK_API_KEY,
    visionKeySet: !!process.env.BOT_VISION_API_KEY,
    isVisionEnabled: isVisionEnabled(),
    visionModel: (process.env.BOT_VISION_MODEL || 'deepseek-v4-flash'),
  }));
  purgeJunkHandles(); // 清掉状态里残留的 IG 保留词键（见函数上方注释）
  await fetchNoiseSites(); // load noise sites from cloud
  await registerBot();
  await ensureBrowser();
  await Promise.all([heartbeatLoop(), pollLoop(), stallWatchdogLoop()]);
};

// 🔴 2026-09-17：启动期失败**不再** exit(1)。
// 旧写法 `main().catch(err => process.exit(1))`：启动期任何一步抛错（最典型 = 连不上 CDP
// Chrome）进程立刻死 → pm2 拉起 → 再死 …… VPS 实测 ↺ 42、每 ~3 分钟一轮，
// 而 out 日志里永远只有重启后的 config 打印（fatal 落在 error 日志里，没人看）。
// 现在改成**就地重试**：失败只打印原因 + 断开半残连接 + 等 60s 重走启动流程，进程永不退出。
// 与 backlink 两个脚本同一条「永不退出」原则（见 ea3135f）：Windows 上"退出"最贵，
// 每次重启都要重新 attach CDP，还会给控制台程序刷窗口。
// 注意：这里**不调用** browser.close() —— CDP 模式下那会真的关掉外部 Chrome（见 shutdown 注释）。
const bootstrap = async () => {
  let attempt = 0;
  for (;;) {
    try {
      await main();
      return; // main 正常返回 = 已收到停机信号，交给 pm2 收尾
    } catch (err: any) {
      attempt++;
      logFatal(`[bot-real] startup failed (attempt ${attempt}); retrying in 60s:`, err?.stack || err);
      try { if (BOT_LAUNCH_MODE === 'persistent' && context) await (context as any).close?.(); } catch {}
      browser = null as any; context = null as any; page = null as any;
      await sleep(60_000);
    }
  }
};

void bootstrap();

