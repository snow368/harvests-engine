/**
 * Unfollow maintenance — 关注回收（follow churn）
 *
 * 目的：账号「关注 600+ / 粉丝十几个」的 following:followers 比例失衡，是 IG 判定
 * mass-follow 垃圾号最显眼的信号。本模块在**关注满宽限期仍未回关**的账号上做低速
 * 取关，把 following 总数压回安全区间，同时给足对方回关窗口，不误伤有互动的号。
 *
 * 安全设计（默认全保守，且默认关闭）：
 *   - BOT_UNFOLLOW_ENABLED 默认 false —— 必须显式打开才运行
 *   - 宽限期 GRACE_DAYS 默认 14 天：关注 14 天内不碰，给足回关时间
 *   - 日上限 DAILY_MAX 默认 25，单次间隔 90–240s 随机
 *   - 只在 following 数超过 MIN_FOLLOWING（默认 400）时才启动；低于阈值自动停
 *   - 已回关 / 已发过 DM / 对方赞过我们 / 我们评论过 → 一律跳过（KEEP_IF_ENGAGED）
 *   - 撞到 IG 风控提示（Try Again Later 等）→ 立即停本轮并冷却 12h
 *
 * 与主循环的关系：共用 bot 的同一个 page，由 pollLoop 在任务间隙调用，
 * 不与任务执行并发，也不额外申请浏览器窗口（不抢 scraper / 主 bot 的 Chrome）。
 */

const num = (raw: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

const bool = (raw: string | undefined, dflt: boolean): boolean => {
  if (raw === undefined || raw === '') return dflt;
  return String(raw).toLowerCase() === 'true';
};

export const UNFOLLOW_CONFIG = {
  enabled: bool(process.env.BOT_UNFOLLOW_ENABLED, false),
  graceDays: num(process.env.BOT_UNFOLLOW_GRACE_DAYS, 14, 1, 90),
  dailyMax: num(process.env.BOT_UNFOLLOW_DAILY_MAX, 50, 1, 200),
  minIntervalSec: num(process.env.BOT_UNFOLLOW_MIN_INTERVAL_SEC, 45, 20, 3600),
  maxIntervalSec: num(process.env.BOT_UNFOLLOW_MAX_INTERVAL_SEC, 120, 30, 7200),
  /** 只有 following 数高于此值才做回收；低于即停，避免把号清成"零关注" */
  minFollowing: num(process.env.BOT_UNFOLLOW_MIN_FOLLOWING, 300, 0, 100000),
  /** 每轮最多处理几个（受日上限与间隔双重约束） */
  perRunMax: num(process.env.BOT_UNFOLLOW_PER_RUN_MAX, 3, 1, 50),
  /** 两次巡检之间的最小间隔（分钟），避免 20s 轮询里被反复调用 */
  checkIntervalMin: num(process.env.BOT_UNFOLLOW_CHECK_INTERVAL_MIN, 60, 1, 1440),
  keepIfEngaged: bool(process.env.BOT_UNFOLLOW_KEEP_IF_ENGAGED, true),
  /**
   * 排序方向：desc=粉丝多的先取关（大号几乎不可能回关，清理收益最高，默认）
   *             asc =粉丝少的先取关（清僵尸/低质小号）
   */
  order: String(process.env.BOT_UNFOLLOW_ORDER || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
  /** 只考虑粉丝数 >= 该值的候选（0=不限）。想只清大号就设一个下限，如 2000 */
  minFollowers: num(process.env.BOT_UNFOLLOW_MIN_FOLLOWERS, 0, 0, 100_000_000),
  dryRun: bool(process.env.BOT_UNFOLLOW_DRY_RUN, false),
};

export type UnfollowDeps = {
  /** 取当前 page（可能为 null，未初始化时） */
  page: () => any;
  likeState: any;
  saveLikeState: () => void;
  logBehavior: (event: string, data?: Record<string, any>) => void;
  recordInteraction: (handle: string, type: string, detail?: Record<string, any>) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  jitter: (min: number, max: number) => number;
  toBareHandle: (v: string) => string;
  igBase: string;
  /** 主 bot 是否正忙（有任务在执行）；忙则本轮不取关 */
  busy: () => boolean;
};

type FollowEntry = {
  followedAt?: number;
  followBackDetected?: boolean;
  followBackDetectedAt?: number;
  unfollowedAt?: number;
  dmSent?: boolean;
  likedUsDetected?: boolean;
  /** 对方粉丝数（访问 profile 时顺带采集，用于排序取关优先级） */
  followers?: number;
  followersCheckedAt?: number;
  rapport?: { commentedAt?: number; likedPosts?: number; commentLikedAt?: number };
  commentLikedByArtistAt?: number;
};

/** "1,234" / "12.3k" / "1.2m" / "1,2万" → number */
const parseCount = (raw: string): number => {
  const s = String(raw || '').replace(/[,，\s]/g, '');
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*([kmwKMW万億亿]?)/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toLowerCase();
  if (unit === 'k') return Math.round(n * 1_000);
  if (unit === 'm' || unit === '百万') return Math.round(n * 1_000_000);
  if (unit === 'w' || unit === '万') return Math.round(n * 10_000);
  if (unit === '亿' || unit === '億') return Math.round(n * 100_000_000);
  return Math.round(n);
};

/**
 * 读对方粉丝数。IG 的 followers 链接 title 属性是精确值（"1,234 followers"），
 * 退化情况读链接文本（"12.3k"），再退化用 header 文本正则。
 */
const readFollowers = async (p: any): Promise<number | null> => {
  try {
    const raw = (await p.evaluate(() => {
      const a = document.querySelector('a[href$="/followers/"]') as HTMLElement | null;
      if (!a) return '';
      return a.getAttribute('title') || a.innerText || a.textContent || '';
    }).catch(() => '')) as string;
    const n = parseCount(raw);
    if (n > 0) return n;
  } catch { /* fall through */ }
  try {
    const txt = (await p.evaluate(() => {
      const h = document.querySelector('header');
      return (h as HTMLElement | null)?.innerText || document.body.innerText || '';
    }).catch(() => '')) as string;
    const m = String(txt).match(/([\d,.]+\s*[kKmM万wW]?)\s*(?:followers|粉丝)/i);
    if (m) {
      const n = parseCount(m[1]);
      if (n > 0) return n;
    }
  } catch { /* ignore */ }
  return null;
};

const dayKey = (ts = Date.now()): string => new Date(ts).toISOString().slice(0, 10);

let lastCheckAt = 0;
let cooldownUntil = 0;
let consecutiveFailures = 0;

/** IG 风控文案：出现即立刻停手 */
const BLOCK_TEXTS = [
  'try again later',
  'we restrict certain activity',
  'action blocked',
  'unusual activity',
  '请稍后再试',
];

const looksBlocked = async (page: any): Promise<boolean> => {
  try {
    const body = (await page.evaluate(() => document.body.innerText || '').catch(() => '')) as string;
    const lower = body.toLowerCase();
    return BLOCK_TEXTS.some((t) => lower.includes(t));
  } catch {
    return false;
  }
};

const ensureStateShape = (likeState: any) => {
  if (!likeState.follows) likeState.follows = {};
  if (!likeState.follows.byHandle) likeState.follows.byHandle = {};
  if (!likeState.unfollows) likeState.unfollows = {};
  if (!likeState.unfollows.byDay) likeState.unfollows.byDay = {};
  return likeState;
};

/** 对方是否已经和我们产生过任何正向互动 —— 有则不取关 */
const hasEngagement = (st: FollowEntry): string | null => {
  if (st.followBackDetected) return 'follow_back';
  if (st.dmSent) return 'dm_sent';
  if (st.likedUsDetected) return 'liked_us';
  if (st.commentLikedByArtistAt) return 'artist_liked_comment';
  if (st.rapport?.commentedAt) return 'we_commented';
  if ((st.rapport?.likedPosts || 0) > 0) return 'rapport_liked';
  return null;
};

/** 当前"仍在关注"的数量（已取关的不计）。用于总量上限闸门与是否启动回收的判断。 */
export const countFollowing = (byHandle: Record<string, FollowEntry>): number =>
  Object.values(byHandle).filter((s) => s?.followedAt && !s?.unfollowedAt).length;

export const unfollowCandidates = (likeState: any, now = Date.now()) => {
  ensureStateShape(likeState);
  const byHandle: Record<string, FollowEntry> = likeState.follows.byHandle || {};
  const graceMs = UNFOLLOW_CONFIG.graceDays * 86_400_000;
  const dir = UNFOLLOW_CONFIG.order === 'asc' ? 1 : -1; // desc: 粉丝多的排前面
  const out = Object.entries(byHandle)
    .filter(([, s]) => s?.followedAt && !s?.unfollowedAt && !s?.followBackDetected)
    .filter(([, s]) => now - (s.followedAt as number) > graceMs)
    .map(([handle, s]) => ({ handle, state: s, engaged: UNFOLLOW_CONFIG.keepIfEngaged ? hasEngagement(s) : null }))
    .sort((a, b) => {
      const fa = a.state.followers;
      const fb = b.state.followers;
      // 粉丝数未知的排最后：先处理有数据的，未知的在访问时顺带采集，下一轮参与排序
      if (fa == null && fb == null) return (a.state.followedAt as number) - (b.state.followedAt as number);
      if (fa == null) return 1;
      if (fb == null) return -1;
      if (fa !== fb) return (fa - fb) * dir;
      return (a.state.followedAt as number) - (b.state.followedAt as number); // 同龄则老的先清
    });
  return out;
};

/**
 * 单个取关动作。返回 'unfollowed' | 'not_following' | 'blocked' | 'failed' | 'dry_run'
 */
const unfollowOne = async (deps: UnfollowDeps, handle: string, st: FollowEntry): Promise<string> => {
  const { page, sleep, jitter, igBase, logBehavior, saveLikeState } = deps;
  const p = page();
  if (!p) return 'failed';

  const url = `${igBase}/${handle}/`;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(jitter(1500, 3000));

  // 顺带采集粉丝数（访问成本已经花了，不额外请求），供后续轮次排序使用
  const followers = await readFollowers(p);
  if (followers != null) {
    st.followers = followers;
    st.followersCheckedAt = Date.now();
    saveLikeState();
  }
  if (UNFOLLOW_CONFIG.minFollowers > 0 && followers != null && followers < UNFOLLOW_CONFIG.minFollowers) {
    logBehavior('unfollow_skipped_below_min_followers', {
      handle, followers, minFollowers: UNFOLLOW_CONFIG.minFollowers,
    });
    return 'skipped_small';
  }

  if (await looksBlocked(p)) {
    cooldownUntil = Date.now() + 12 * 3600_000;
    logBehavior('unfollow_blocked_detected', { handle });
    return 'blocked';
  }

  // 精确匹配，避免 "Follow" 误命中 "Follow Back" / "Following"
  const followingBtn = p.getByRole('button', { name: 'Following', exact: true }).first();
  const hasFollowing = (await followingBtn.count().catch(() => 0)) > 0;

  if (!hasFollowing) {
    // 已经不在关注（可能对方删号/我们此前已取关/请求待审）→ 只做状态自愈
    for (const label of ['Follow', 'Follow Back', 'Requested']) {
      const btn = p.getByRole('button', { name: label, exact: true }).first();
      if ((await btn.count().catch(() => 0)) > 0) {
        logBehavior('unfollow_already_not_following', { handle, sawButton: label });
        return 'not_following';
      }
    }
    logBehavior('unfollow_button_not_found', { handle });
    return 'failed';
  }

  if (UNFOLLOW_CONFIG.dryRun) {
    logBehavior('unfollow_dry_run', { handle });
    return 'dry_run';
  }

  await followingBtn.click({ timeout: 8000 }).catch(() => {});
  await sleep(jitter(1200, 2500));

  // IG 有确认弹窗（"Unfollow @x?"）；部分版本直接取关，没有弹窗
  const confirmBtn = p.getByRole('button', { name: 'Unfollow', exact: true }).first();
  if ((await confirmBtn.count().catch(() => 0)) > 0) {
    await confirmBtn.click({ timeout: 8000 }).catch(() => {});
    await sleep(jitter(1500, 3000));
  }

  // 校验：Following 按钮应消失，出现 Follow / Follow Back
  let ok = false;
  for (let i = 0; i < 3; i += 1) {
    const stillFollowing = (await p.getByRole('button', { name: 'Following', exact: true }).count().catch(() => 0)) > 0;
    if (!stillFollowing) { ok = true; break; }
    await sleep(1500);
  }
  if (!ok) return 'failed';

  if (await looksBlocked(p)) {
    cooldownUntil = Date.now() + 12 * 3600_000;
    logBehavior('unfollow_blocked_detected', { handle });
    return 'blocked';
  }
  return 'unfollowed';
};

/**
 * 主循环周期调用。自带节流 + 日上限 + 冷却，空转成本极低。
 */
export const runUnfollowMaintenance = async (deps: UnfollowDeps): Promise<void> => {
  if (!UNFOLLOW_CONFIG.enabled) return;
  const now = Date.now();
  if (now < cooldownUntil) return;
  if (now - lastCheckAt < UNFOLLOW_CONFIG.checkIntervalMin * 60_000) return;
  if (deps.busy()) return;

  lastCheckAt = now;
  const { likeState, saveLikeState, logBehavior, recordInteraction, sleep, jitter, toBareHandle } = deps;
  ensureStateShape(likeState);

  const following = countFollowing(likeState.follows.byHandle);
  if (following < UNFOLLOW_CONFIG.minFollowing) {
    logBehavior('unfollow_skipped_below_threshold', { following, minFollowing: UNFOLLOW_CONFIG.minFollowing });
    return;
  }

  const today = dayKey(now);
  const doneToday = Number(likeState.unfollows.byDay[today] || 0);
  if (doneToday >= UNFOLLOW_CONFIG.dailyMax) {
    logBehavior('unfollow_daily_cap_reached', { today, doneToday, cap: UNFOLLOW_CONFIG.dailyMax });
    return;
  }

  const candidates = unfollowCandidates(likeState, now)
    .filter((c) => !c.engaged)
    .slice(0, Math.min(UNFOLLOW_CONFIG.perRunMax, UNFOLLOW_CONFIG.dailyMax - doneToday));

  if (candidates.length === 0) {
    logBehavior('unfollow_no_candidates', { following, graceDays: UNFOLLOW_CONFIG.graceDays });
    return;
  }

  logBehavior('unfollow_run_start', {
    following,
    candidates: candidates.length,
    doneToday,
    cap: UNFOLLOW_CONFIG.dailyMax,
    graceDays: UNFOLLOW_CONFIG.graceDays,
    dryRun: UNFOLLOW_CONFIG.dryRun,
  });

  let processed = 0;
  for (const c of candidates) {
    if (deps.busy()) break;
    const handle = toBareHandle(c.handle);
    if (!handle) continue;
    const st = (likeState.follows.byHandle[handle] ||= {}) as FollowEntry;

    let result: string;
    try {
      result = await unfollowOne(deps, handle, st);
    } catch (err: any) {
      result = 'failed';
      logBehavior('unfollow_error', { handle, reason: String(err?.message || err) });
    }

    if (result === 'skipped_small') {
      // 粉丝数低于下限：数据已采集入状态，本轮跳过。不算失败、不占日额度
      await sleep(jitter(8000, 20000));
      continue;
    }

    if (result === 'unfollowed' || result === 'not_following' || result === 'dry_run') {
      if (result === 'unfollowed' || result === 'not_following') {
        st.unfollowedAt = Date.now();
        likeState.unfollows.byDay[today] = Number(likeState.unfollows.byDay[today] || 0) + 1;
      }
      saveLikeState();
      recordInteraction(handle, 'unfollow', {
        reason: 'no_follow_back',
        followedDaysAgo: st.followedAt ? Math.round((Date.now() - st.followedAt) / 86_400_000) : null,
        dryRun: result === 'dry_run',
      }).catch(() => {});
      logBehavior(result === 'dry_run' ? 'unfollow_dry_run_done' : 'unfollow_done', { handle, result });
      processed += 1;
      consecutiveFailures = 0;
    } else if (result === 'blocked') {
      saveLikeState();
      logBehavior('unfollow_abort_cooldown', { handle, cooldownUntil });
      break;
    } else {
      consecutiveFailures += 1;
      logBehavior('unfollow_failed', { handle, consecutiveFailures });
      if (consecutiveFailures >= 3) {
        cooldownUntil = Date.now() + 6 * 3600_000;
        logBehavior('unfollow_abort_failures', { consecutiveFailures, cooldownUntil });
        break;
      }
    }

    // 两个动作之间随机停顿，模拟真人节奏
    const waitMs = jitter(UNFOLLOW_CONFIG.minIntervalSec * 1000, UNFOLLOW_CONFIG.maxIntervalSec * 1000);
    await sleep(waitMs);
  }

  if (processed > 0) {
    logBehavior('unfollow_run_done', {
      processed,
      doneToday: Number(likeState.unfollows.byDay[today] || 0),
      followingAfter: countFollowing(likeState.follows.byHandle),
    });
  }
};
