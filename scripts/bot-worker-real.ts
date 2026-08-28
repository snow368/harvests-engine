/* eslint-disable no-console */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createWorker } from 'tesseract.js';
import { generateComment, getFromPool, refillPool, clearRecentHistory, detectTattooStyle, getInteractionFallback, extractTechniqueHintsFromVision } from './comment-generator';
import { analyzePostImage, isVisionEnabled, buildVisionDescription } from './vision-analyze';
import { detectPostType, detectSubject, isPiercingHandle, detectPostIntent, reconcileIntentWithVision, intentEngagement } from './tattoo-voice';
import { isCommentBlacklisted } from './comment-blacklist';

// 2026-08-07 全局兜底：捕获未处理异常/拒绝，避免单任务内的异步错误直接杀死整个进程
// （此前 bot 在首个任务执行中静默退出，导致任务永远停在 leased、无法 done/failed，违反"需要跑通"要求）。
// 注册 handler 后 Node 不会因 unhandledRejection 默认退出，进程保持存活并落盘原因。
process.on('uncaughtException', (err: any) => {
  console.error('[FATAL uncaughtException]', err?.stack || err);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL unhandledRejection]', reason?.stack || reason);
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
const POLL_INTERVAL_MS = Math.max(1500, Number(process.env.BOT_POLL_INTERVAL_MS || 4000));
const POLL_LIMIT = Math.max(1, Math.min(5, Number(process.env.BOT_POLL_LIMIT || 1)));
const HEARTBEAT_INTERVAL_MS = Math.max(5000, Number(process.env.BOT_HEARTBEAT_INTERVAL_MS || 15000));
const CONTROL_PAUSE_FILE = path.resolve(process.cwd(), 'data', 'control-pause', 'bot-worker.pause');
let controlPauseLogged = false;
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
const BOT_COMMENT_DAILY_MAX = Math.max(0, Math.min(20, Number(process.env.BOT_COMMENT_DAILY_MAX || 2)));
const BOT_COMMENT_HANDLE_COOLDOWN_HOURS = Math.max(24, Number(process.env.BOT_COMMENT_HANDLE_COOLDOWN_HOURS || 72));
const BOT_FOLLOW_ENABLED = String(process.env.BOT_FOLLOW_ENABLED || 'false').toLowerCase() === 'true';
const BOT_FOLLOW_DAILY_MIN = Math.max(0, Math.min(30, Number(process.env.BOT_FOLLOW_DAILY_MIN || 2)));
const BOT_FOLLOW_DAILY_MAX = Math.max(BOT_FOLLOW_DAILY_MIN, Math.min(50, Number(process.env.BOT_FOLLOW_DAILY_MAX || 6)));
const BOT_FOLLOW_MIN_TOUCHES = Math.max(1, Number(process.env.BOT_FOLLOW_MIN_TOUCHES || 2)); // must have >= N visits before follow
const BOT_DAILY_BROWSE_TARGET_NEW = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_NEW || 25));
const BOT_DAILY_BROWSE_TARGET_TRANSITION = Math.max(1, Number(process.env.BOT_DAILY_BROWSE_TARGET_TRANSITION || 50));
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
// 填 IG 号接入系统的日期（raiha8833 = 2026-06-19，距今>50天 → 立即满档）。
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
const NOISE_SITES_CACHE_TTL = 5 * 60 * 1000; // re-fetch every 5 min

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
  const stage = String(command?.accountStage || lastAccountStage || 'stable').toLowerCase();
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
    dayCap?: { key: string; cap: number };
  };
  follows?: {
    byDay?: Record<string, number>;
    byHandle?: Record<string, { followedAt?: number; followBackDetected?: boolean; followBackDetectedAt?: number }>;
    dayCap?: { key: string; cap: number };
  };
  comments?: {
    byDay?: Record<string, number>;
    byHandle?: Record<string, { lastCommentAt?: number }>;
    recentText?: Array<{ ts: number; hash: number }>;
  };
  // DM 去重：记录每个 handle 上次已回复的文案哈希，防止把 bot 自己的出站/上轮回复误当客户新消息反复自回复。
  dmSeen?: Record<string, number>;
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
if (!likeState.comments.byHandle) likeState.comments.byHandle = {};
if (!likeState.comments.recentText) likeState.comments.recentText = [];
if (!likeState.dm) likeState.dm = { byDay: {} };
if (!likeState.rest) likeState.rest = { until: 0, reason: '', severity: '', at: 0 };
if (!likeState.dm.byDay) likeState.dm.byDay = {};
if (!likeState.dmSeen) likeState.dmSeen = {};

const getTodayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isSameDay = (a?: number, b?: number) => { if (!a || !b) return false; return getTodayKey(new Date(a)) === getTodayKey(new Date(b)); };
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
      // 🛑 self-DM 守卫：绝不给 bot 自己的账号发 DM（之前误把 raiha8833 当客户发了 2 条 self-DM）
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
const rapportLikePosts = async (handle: string, n: number): Promise<number> => {
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
          recordRapport();
          recordInteraction(handle, 'like', { rapport: true, reason: 'follow_back_ladder' }).catch(() => {});
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(jitter(800, 1800));
      } catch {}
    }
    return liked;
  } catch { return 0; }
};

// 回关培养评论也必须进入统一人工审核队列。这里绝不触碰评论输入框。
const queueRapportCommentForReview = async (handle: string, text: string): Promise<string | null> => {
  if (!page) return null;
  try {
    await openProfile(handle);
    await page.waitForTimeout(jitter(1500, 3000));
    const firstPost = page.locator('a[href*="/p/"]').first();
    if ((await firstPost.count()) === 0) return null;
    await firstPost.click({ timeout: 8000 });
    await page.waitForTimeout(jitter(1500, 3000));
    const postUrl = page.url();
    const postKey = extractPostKey(postUrl);
    await page.keyboard.press('Escape').catch(() => {});
    if (!postKey) return null;

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
        groundingRisks: ['follow_back_ladder'],
        safeFacts: ['source:follow_back_ladder'],
        lang: 'en',
      }],
    });
    logBehavior('comment_review_queued', { handle, postUrl, draftId, text, source: 'follow_back_ladder' });
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
    if (!BOT_FOLLOW_ENABLED || !page) return false;
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

let incomingFbTick = 0;
const checkIncomingFollowBacks = async () => {
  try {
    incomingFbTick = (incomingFbTick + 1) % 20; // 约每 20 轮查一次，避免频繁打扰
    if (incomingFbTick !== 0) return;
    const me = (ACCOUNT_IDS && ACCOUNT_IDS[0]) || '';
    if (!me || !page) return;
    await page.goto(`${IG_BASE}/${me}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(jitter(1500, 3000));
    const followersLink = page.locator('a[href*="/followers/"]').first();
    if ((await followersLink.count()) > 0) await followersLink.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(jitter(2000, 4000));
    const handles = await page.locator('a[href^="/"]').evaluateAll((els: any[]) =>
      els.map((e) => (e.getAttribute('href') || '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, ''))
        .filter((h: string) => /^[A-Za-z0-9._]{2,30}$/.test(h) && !['p', 'reel', 'explore', 'accounts', 'direct', 'tv', 'stories'].includes(h))
    ).catch(() => []);
    const sample = (handles || []).slice(0, 40);
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
    commentEngagerTick = (commentEngagerTick + 1) % 20;
    if (commentEngagerTick !== 0) return;
    if (!BOT_FOLLOW_ENABLED || !page) return;
    const selfIds = new Set([BOT_ID, ...(ACCOUNT_IDS || [])].map((x) => String(x).toLowerCase()));
    // 1) 扫通知 Others 页（含"赞了你的评论/回复了你的评论"的互动信号）
    await page.goto(`${IG_BASE}/notifications/others/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
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
    if (!engagers.length) return;
    // 3) Pass A：当日检测新互动者，开主页读 bio 判相关性，记录次日 followAt（不立即回关）
    for (const h of engagers.slice(0, 20)) {
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
    // 4) Pass B：遍历持久化状态，次日已到点的 tattoo 互动者才真正回关（不依赖当前页）
    for (const h of Object.keys(likeState.follows?.byHandle || {})) {
      const st = likeState.follows!.byHandle![h] as any;
      if (!st || st.followedAt || !st.commentEngagerFollowAt) continue;
      if (Date.now() < st.commentEngagerFollowAt) continue;
      if (st.commentEngagerSubject && st.commentEngagerSubject !== 'tattoo') continue; // 仅 tattoo 相关
      logBehavior('comment_engager_follow', { handle: h });
      recordInteraction(h, 'follow', { reason: 'comment_engager', subject: st.commentEngagerSubject || 'tattoo' }).catch(() => {});
      await reciprocalFollowBack(h);
      await sleep(jitter(3000, 6000));
    }
  } catch {}
};

// 2026-08-07: 检测「对方赞过我们」——互赞是比互关更强的兴趣信号。
// 打开自己主页最新帖子的点赞者列表，对"已知回关号"标记 likedUsDetected；
// 若对方已回关+已回赞（兴趣明确），把预热窗口提前到 1h 内（比默认 4h 更早、也更自然）。
// 仅覆盖最新一篇帖子的赞者（IG 无公开"谁赞了我全部帖子"接口）；失败静默，不影响主链路。
let likedUsTick = 0;
const checkWhoLikedUs = async (): Promise<void> => {
  try {
    likedUsTick = (likedUsTick + 1) % 20;
    if (likedUsTick !== 0) return;
    const me = (ACCOUNT_IDS && ACCOUNT_IDS[0]) || '';
    if (!me || !page) return;
    const known = new Set(Object.keys(likeState.follows?.byHandle || {}));
    if (!known.size) return;
    await page.goto(`${IG_BASE}/${me}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(jitter(1500, 3000));
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
let audienceTick = 0;
const checkAudienceReciprocate = async () => {
  try {
    audienceTick = (audienceTick + 1) % 20;
    if (audienceTick !== 0) return;
    if (!BOT_FOLLOW_ENABLED || !page) return;
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

    await page.goto(`${IG_BASE}/${me}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(jitter(1500, 3000));
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

const logBehavior = (event: string, data: Record<string, any> = {}) => {
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

const postJson = async (path: string, body: Record<string, any>) => {
  const resp = await fetch(`${API_BASE}${path}`, {
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
  const resp = await fetch(`${API_BASE}${path}`, { headers: buildHeaders() });
  const text = await resp.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${JSON.stringify(payload)}`);
  return payload;
};

// ── AI Core helpers (sales_chats D1 sync) ──────────────────────────────
const aicorePost = async (path: string, body: Record<string, any>): Promise<any> => {
  const resp = await fetch(`${AI_CORE_BASE}${path}`, {
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
    meta: { mode: 'playwright-real', profileDir: PROFILE_DIR }
  });
};

const heartbeatBot = async () => {
  await postJson('/api/bot/heartbeat', {
    botId: BOT_ID,
    accountIds: ACCOUNT_IDS,
    host: BOT_HOST,
    version: BOT_VERSION
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
      try { execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' }); }
      catch { /* 没有 chrome 在跑也正常 */ }
    } else {
      try { execSync(`pkill -f "${ud}" || true`, { stdio: 'ignore' }); } catch {}
    }
  } catch (e) {
    console.warn('[bot-real] clearProfileLock: kill failed:', (e as any)?.message);
  }
  // 进程已死、锁文件不再被占用，删除残留锁文件。删不掉会在下一轮重试（ensureBrowser 有 12 次退避）兜底。
  for (const f of lockFiles) {
    try { fs.rmSync(path.join(ud, f), { force: true }); } catch {}
  }
};

const ensureBrowser = async () => {
  // 已有一个在 instagram.com 的页面 → 直接复用，绝不重新开浏览器（避免多标签堆积）。
  if (context && page) {
    try {
      const url = page.url();
      if (url && url.includes('instagram.com')) return;
    } catch {}
    // 有 context 但页面不在 IG（卡在 about:blank 等）→ 先关干净，再重建，不留孤儿。
    try { await context.close(); } catch {}
    context = null as any; page = null as any;
  }

  // Retry with backoff. 关键：每一次重试前，上一轮若已半启动了一个浏览器/标签页，
  // 必须在 catch 里把它 context.close() 掉 —— 否则孤儿浏览器 + 孤儿标签会越积越多
  // （之前"七八个 about:blank"就是这样来的：12 次重试每次都 newPage 且不清旧进程）。
  const MAX_ATTEMPTS = 4;
  const BACKOFF_MS = 8_000;
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
        console.log('[bot-real] launched persistent browser (stealth mode)');
        return;
      }

      // CDP mode (legacy): connect to an already-running Chrome.
      if (!BOT_CDP_URL) throw new Error('cdp_required_set_BOT_CDP_URL_or_use_BOT_LAUNCH_MODE_persistent');
      browser = await chromium.connectOverCDP(BOT_CDP_URL);
      context = browser.contexts()[0] || await browser.newContext();
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
      console.log(`[bot-real] connected via CDP: ${BOT_CDP_URL}`);
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[bot-real] browser ensure attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e?.message || e}`);
      // 🔴 失败后若留下了半残 context，立刻关掉它，避免孤儿进程/标签堆积（多标签根因）。
      try { if (context) { await context.close(); } } catch {}
      context = null as any; page = null as any;
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
const isOnLoginPage = async (): Promise<boolean> => {
  if (!page) return true; // 没页面一律当未登录，安全等待
  try {
    const url = (page.url() || '').toLowerCase();
    if (url.includes('/accounts/login')) return true;
    if (url.includes('/challenge/')) return true;        // 安全挑战页（确认是你/短信验证）
    if (url.includes('/accounts/onetap')) return true;
    if (url.includes('/accounts/emailsignup')) return true;
    // 登录页才有 username 输入框（用户正输入用户名时也算"未登录"）
    const loginInputCount = await page.locator('input[name="username"]').count();
    if (loginInputCount > 0) return true;
    // 部分挑战页用其他字段
    const challengeInput = await page.locator('input[name="security_code"], input[name="email"]').count();
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
        await sleep(5000);
        continue;
      }
      if (!printed) {
        console.log('[bot-real] ✅ login confirmed (on instagram.com, not on login/challenge) — resuming tasks.');
        printed = true;
      }
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

  // No more "like first" or "first touch window" — comment when a good post is found.
  // Chance roll keeps volume human-scale.
  if (Math.random() > BOT_COMMENT_CHANCE) return { ok: false, reason: 'comment_chance_skip' };

  const key = todayKey();
  const byDay = likeState.comments!.byDay || {};
  const dayCount = Number(byDay[key] || 0);
  if (dayCount >= BOT_COMMENT_DAILY_MAX) return { ok: false, reason: 'comment_daily_limit' };
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

const buildCommentText = async (facts?: ProfileFacts, postMeta?: any): Promise<string> => {
  // ⚠️ 不再优先取预热池：池里是启动时脱离具体帖生成的泛评，回在真实帖上最像 bot。
  // 改为实时按帖生成；仅在 DeepSeek 失败（超时/无 key）才退化为池或口语模板。
  // DeepSeek 实时生成
  const commentStyle = postMeta?.postStyle
    || getPrimaryStyle(facts)
    || '';
  const styleConf = postMeta?.styleConfidence || 'low';

  try {
    const result = await Promise.race([
      generateComment({
        caption: postMeta?.caption?.slice(0, 300) || facts?.sampleCaption?.slice(0, 300),
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
        setTimeout(() => reject(new Error('comment_gen_timeout')), 8000)
      ),
    ]);
    // 异步补充池子
    refillPool().catch(() => {});
    return result.text;
  } catch {
    // Fallback 链：预热池(仍有上下文时比固定模板自然) → 锚定本帖的互动钩子（绝不用泛泛 "fire"，否则无互动无涨粉）
    const pooled = getFromPool();
    if (pooled) return pooled;
    return getInteractionFallback(postMeta?.postIntent, postMeta?.sensitive);
  }
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
  const textarea = page.locator('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i], textarea').first();
  if ((await textarea.count()) === 0) return false;
  await textarea.click({ timeout: 4000 });
  await page.waitForTimeout(jitter(400, 1000));

  const chars = text.split('');
  const useDistractedTyping = Math.random() < 0.3; // 30% chance of "distracted" typing

  if (!useDistractedTyping) {
    // Mode A (70%): steady typing with natural pauses
    for (let i = 0; i < chars.length; i++) {
      await textarea.press(chars[i]);
      await page.waitForTimeout(jitter(50, 200));
      if (i > 0 && i % 12 === 0) await page.waitForTimeout(jitter(300, 900));
    }
  } else {
    // Mode B (30%): chunked typing — type a few words, pause, scroll, come back
    let i = 0;
    while (i < chars.length) {
      const chunkSize = randInt(3, 8);
      const end = Math.min(i + chunkSize, chars.length);
      for (let j = i; j < end; j++) {
        await textarea.press(chars[j]);
        await page.waitForTimeout(jitter(45, 160));
      }
      i = end;
      if (i >= chars.length) break;

      // Distraction: scroll post slightly, pause, then resume typing
      const distraction = Math.random();
      if (distraction < 0.4) {
        // Slight scroll like re-reading the image
        await page.mouse.wheel(0, randInt(-80, 80));
        await page.waitForTimeout(jitter(600, 1500));
      } else if (distraction < 0.7) {
        // Just pause like thinking
        await page.waitForTimeout(jitter(800, 2500));
      } else {
        // Move cursor back a few chars, then retype (simulate typo correction)
        for (let k = 0; k < randInt(1, 3); k++) {
          await textarea.press('Backspace');
          await page.waitForTimeout(jitter(80, 250));
        }
      }
    }
  }

  await page.waitForTimeout(jitter(500, 1500));
  await textarea.press('Enter');
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
      groundingRisks: [],
      safeFacts: [
        ...(meta?.postStyle ? [`style:${meta.postStyle}`] : []),
        ...(meta?.postIntent ? [`intent:${meta.postIntent}`] : []),
        ...(extra.visionDescription ? [String(extra.visionDescription).slice(0, 220)] : []),
      ],
      lang: 'en',
    }],
  });
  logBehavior('comment_review_queued', {
    handle,
    postUrl,
    draftId,
    text,
    score: Number(meta?.score || 0),
    style: extra.style || meta?.postStyle || '',
    styleConfidence: extra.styleConfidence || meta?.styleConfidence || 'low',
    vision: !!extra.visionDescription,
  });
  return draftId;
};

let approvedCommentBusy = false;
const tryPublishApprovedComment = async (): Promise<boolean> => {
  if (!BOT_COMMENT_ENABLED || approvedCommentBusy || !page) return false;
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

    await page.goto(String(item.post_url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(jitter(1800, 3200));
    const approvedAt = String(item.approved_at || '').trim();
    const approvedBy = String(item.approved_by || '').trim();
    if (!approvedAt || !approvedBy) {
      logBehavior('comment_publish_blocked_missing_approval', { draftId: claimedDraftId, handle });
      await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/release`, {}).catch(() => null);
      return false;
    }
    const ok = await tryPostCommentOnOpenModal(text, { draftId: claimedDraftId, approvedAt, approvedBy });
    if (!ok) {
      logBehavior('comment_approved_publish_failed', { draftId: claimedDraftId, handle, reason: 'comment_box_not_found' });
      await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/release`, {}).catch(() => null);
      return false;
    }
    didPostToInstagram = true;

    const key = todayKey();
    const textHash = hashString(normalizeForMatch(text));
    likeState.comments!.byDay![key] = Number(likeState.comments!.byDay![key] || 0) + 1;
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
      await postJson(`/api/drafts/${encodeURIComponent(claimedDraftId)}/release`, {}).catch(() => null);
    }
    logBehavior('comment_approved_publish_error', { reason: String(error?.message || error).slice(0, 180) });
    return false;
  } finally {
    approvedCommentBusy = false;
  }
};

const tryCommentWithStrategy = async (handle: string, facts?: ProfileFacts, likeSummary?: LikeActionSummary): Promise<CommentActionSummary> => {
  if (!page) throw new Error('page_not_initialized');
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
  if (isVisionEnabled() && chosen.meta.postImageSrc) {
    try {
      const vis = await analyzePostImage(chosen.meta.postImageSrc);
      if (vis) {
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
    } catch {}
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

  const text = await buildCommentText(facts, {
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
    const key = todayKey();
    likeState.comments!.byDay![key] = Number(likeState.comments!.byDay![key] || 0) + 1;
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
const getPostImageSrc = async (): Promise<string> => {
  if (!page) return '';
  try {
    return await page.evaluate(() => {
      const imgs = Array.from(
        document.querySelectorAll('div[role="dialog"] img[src*="scontent"]')
      ) as HTMLImageElement[];
      if (!imgs.length) return '';
      let best = '';
      let bestW = 0;
      for (const im of imgs) {
        const w = im.naturalWidth || im.clientWidth || 0;
        if (w > bestW) { bestW = w; best = im.src; }
      }
      return best;
    });
  } catch {
    return '';
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
  const caption = (await page.locator('article ul li span, div[role="dialog"] ul li span').allInnerTexts().catch(() => [] as string[]))
    .join(' ')
    .slice(0, 1200);
  const altHints = (await page.locator('div[role="dialog"] img[alt], article img[alt]').all()
    .then(async (els) => Promise.all(els.slice(0, 4).map(async (el) => ((await el.getAttribute('alt')) || '').slice(0, 200))))
    .catch(() => [] as string[]))
    .join(' ');
  // 帖子图 URL（供视觉分析使用，仅当 BOT_VISION_ENABLED 时后续才会用到）
  const postImageSrc = await getPostImageSrc();
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
  saveLikeState(likeState);
  logBehavior('like_session_done', {
    handle,
    liked,
    attempted: maxLikes,
    cooldownHours,
    dayCountAfter: Number(likeState.likes!.byDay![dayKey] || 0),
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
  const stage = String(command?.accountStage || '').trim().toLowerCase() || 'stable';
  const age = Number(command?.accountAgeDays) ?? -1;
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
    // 评论：仍要求本次有点赞（无互动直接评论显得可疑）。
    if (likeSummary.liked > 0 && commentsOn) {
      await sleep(jitter(1400, 2600));
      commentSummary = await tryCommentWithStrategy(handle, profileFacts, likeSummary);
    } else {
      commentSummary = { attempted: 0, posted: 0, skipped: true, reason: likeSummary.liked > 0 ? 'comment_off' : 'no_like_this_visit' };
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
      // A warm pause keeps the browser/session and heartbeat alive but does not
      // poll or lease new tasks. The host control listener owns this flag.
      if (fs.existsSync(CONTROL_PAUSE_FILE)) {
        if (!controlPauseLogged) console.log(`[bot-real] control pause active: ${CONTROL_PAUSE_FILE}`);
        controlPauseLogged = true;
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
      // ── 回关主动复检：每 5 轮回访一个"已关注未检测回关"的号，让回关能被发现 ──
      try {
        await maybeCheckFollowBacks();
      } catch {}
      // ── 捕获主动关注我们的回流粉（如 tattooshops.be）：每 20 轮查一次 Followers 列表 ──
      try {
        await checkIncomingFollowBacks();
      } catch {}
      // ── 检测「对方赞过我们」：每 20 轮查一次最新帖子点赞者列表，互赞则提前预热窗口 ──
      try {
        await checkWhoLikedUs();
      } catch {}
      // ── 暖受众反关注：每 20 轮扫我们自己帖子下的点赞/评论者，主动关注新暖线索（可选发DM）──
      try {
        await checkAudienceReciprocate();
      } catch {}
      // ── 评论互动回流：每 20 轮扫通知页，tattoo 相关互动者次日回关 ──
      try {
        await checkCommentEngagers();
      } catch {}
      // ── 回关 rapport 阶梯：先点赞→(隔天)评论 建立熟悉感，再发 DM（内部已判断进度）──
      try {
        await syncFollowBackRapport();
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
        if (!page || await isOnLoginPage()) {
          console.log(`[bot-real] ⏸ login page present before task ${cmd?.id} — skipping (retries next cycle after you log in).`);
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
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
          try {
            if (page) { await page.context().close().catch(() => {}); page = null as any; }
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
      console.error('[bot-real] heartbeat error:', err?.message || err);
      recoverAttempts++;
      if (recoverAttempts <= 3) {
        // Re-register and re-connect after server restart
        try {
          await registerBot();
          await ensureBrowser();
          console.log('[bot-real] recovered after server restart');
        } catch (recoverErr: any) {
          console.error('[bot-real] recovery failed:', recoverErr?.message || recoverErr);
        }
      }
      await sleep(Math.min(HEARTBEAT_INTERVAL_MS, 5000));
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
      if (browser) await browser.close();
    }
  } catch {}
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

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
  });
  // 视觉/AI 评论就绪状态自检（用户 2026-08-10 问"flash 可以分析了？"——重启后看这行即可确认）
  console.log('[bot-real] [vision-check]', JSON.stringify({
    visionEnabledFlag: (process.env.BOT_VISION_ENABLED || '0') === '1',
    deepseekKeySet: !!process.env.DEEPSEEK_API_KEY,
    visionKeySet: !!process.env.BOT_VISION_API_KEY,
    isVisionEnabled: isVisionEnabled(),
    visionModel: (process.env.BOT_VISION_MODEL || 'deepseek-v4-flash'),
  }));
  // 预热评论池
  if (BOT_COMMENT_ENABLED) {
    refillPool().then(() => console.log('[bot-real] comment pool warmed up'));
  }
  await fetchNoiseSites(); // load noise sites from cloud
  await registerBot();
  await ensureBrowser();
  await Promise.all([heartbeatLoop(), pollLoop()]);
};

main().catch((err) => {
  console.error('[bot-real] fatal:', err);
  process.exit(1);
});

