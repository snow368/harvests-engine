/**
 * 评论黑名单（2026-08-14）
 * 被拉黑账号 = 明确不喜欢被评论 / 要求不要互动的账号。
 * 命中后 bot 坚决不在其帖子下写评论（含其作为 owner 或 co-author 出现的帖子）。
 *
 * 数据来源（二者合并、去重）：
 *   1) 文件 <STATE_DIR>/comment_blacklist.json：
 *        { "handles": [ { "handle": "xxx", "reason": "...", "mode": "comment"|"all" } ], "updatedAt": "ISO" }
 *        mode: "comment"（默认）仅禁止评论；"all" 禁止一切互动（赞/关注/评论）。
 *   2) 环境变量 COMMENT_BLACKLIST="handle1,handle2,..."（仅 comment 模式）。
 *
 * 匹配：被浏览的 profile handle、帖子 owner handle、caption 里 @ 到的共同作者，任一命中即拦截。
 * 大小写/前导 @ 自动归一。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface BlacklistEntry {
  handle: string;
  reason?: string;
  mode?: 'comment' | 'all';
}
export interface BlacklistData {
  handles: BlacklistEntry[];
  updatedAt?: string;
}

const STATE_DIR = process.env.BOT_STATE_DIR || path.join(__dirname, '..', 'data');
const BL_FILE = path.join(STATE_DIR, 'comment_blacklist.json');

let cache: BlacklistData | null = null;
let cacheEnv = '';

const normalize = (h: string): string =>
  String(h || '').toLowerCase().replace(/^@/, '').replace(/\s+/g, '').replace(/\/+$/g, '');

export const loadBlacklist = (): BlacklistData => {
  const env = (process.env.COMMENT_BLACKLIST || '').trim();
  if (cache && cacheEnv === env) return cache;

  let fileData: BlacklistData = { handles: [] };
  try {
    if (fs.existsSync(BL_FILE)) {
      const raw = JSON.parse(fs.readFileSync(BL_FILE, 'utf8'));
      if (raw && Array.isArray(raw.handles)) fileData = raw as BlacklistData;
    }
  } catch {
    fileData = { handles: [] };
  }

  const fromEnv: BlacklistEntry[] = env
    ? env.split(',').map((h) => ({ handle: normalize(h), mode: 'comment' }))
    : [];

  const merged: BlacklistEntry[] = [
    ...fileData.handles.map((e) => ({ ...e, handle: normalize(e.handle) })),
    ...fromEnv,
  ];

  const seen = new Set<string>();
  const dedup: BlacklistEntry[] = [];
  for (const e of merged) {
    if (!e.handle) continue;
    if (seen.has(e.handle)) continue;
    seen.add(e.handle);
    dedup.push(e);
  }

  cache = { handles: dedup, updatedAt: fileData.updatedAt };
  cacheEnv = env;
  return cache;
};

export interface BlacklistCheck {
  blacklisted: boolean;
  entry?: BlacklistEntry;
  matched: string;
}

export const checkBlacklist = (
  handle: string,
  opts?: { ownerHandle?: string; caption?: string; mode?: 'comment' | 'all' }
): BlacklistCheck => {
  const bl = loadBlacklist();
  if (!bl.handles.length) return { blacklisted: false, matched: '' };

  const candidates: string[] = [];
  if (handle) candidates.push(normalize(handle));
  if (opts?.ownerHandle) candidates.push(normalize(opts.ownerHandle));
  if (opts?.caption) {
    const mentioned = (opts.caption.match(/@([a-z0-9_.]+)/gi) || []).map((m) =>
      normalize(m.replace(/^@/, ''))
    );
    for (const m of mentioned) candidates.push(m);
  }

  const want = opts?.mode || 'comment';
  for (const cand of candidates) {
    const entry = bl.handles.find((e) => e.handle === cand);
    if (!entry) continue;
    // comment 模式：任何 entry 都拦截（评论是用户明确诉求，最严格）
    // all 模式：仅 entry.mode==='all' 拦截（用于赞/关注等全量屏蔽）
    if (want === 'comment') return { blacklisted: true, entry, matched: cand };
    if (want === 'all' && entry.mode === 'all') return { blacklisted: true, entry, matched: cand };
  }
  return { blacklisted: false, matched: '' };
};

/** 便捷封装：是否禁止写评论（默认查询） */
export const isCommentBlacklisted = (
  handle: string,
  opts?: { ownerHandle?: string; caption?: string }
): boolean => checkBlacklist(handle, { ...opts, mode: 'comment' }).blacklisted;

/** 便捷封装：是否禁止一切互动（赞/关注/评论）。仅 mode==='all' 的条目触发。 */
export const isAllEngageBlacklisted = (
  handle: string,
  opts?: { ownerHandle?: string; caption?: string }
): boolean => checkBlacklist(handle, { ...opts, mode: 'all' }).blacklisted;
