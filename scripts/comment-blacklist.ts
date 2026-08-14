/**
 * è¯„è®ºé»‘åå•ï¼ˆ2026-08-14ï¼‰
 * è¢«æ‹‰é»‘è´¦å· = æ˜Žç¡®ä¸å–œæ¬¢è¢«è¯„è®º / è¦æ±‚ä¸è¦äº’åŠ¨çš„è´¦å·ã€‚
 * å‘½ä¸­åŽ bot åšå†³ä¸åœ¨å…¶å¸–å­ä¸‹å†™è¯„è®ºï¼ˆå«å…¶ä½œä¸º owner æˆ– co-author å‡ºçŽ°çš„å¸–å­ï¼‰ã€‚
 *
 * æ•°æ®æ¥æºï¼ˆäºŒè€…åˆå¹¶ã€åŽ»é‡ï¼‰ï¼š
 *   1) æ–‡ä»¶ <STATE_DIR>/comment_blacklist.jsonï¼š
 *        { "handles": [ { "handle": "xxx", "reason": "...", "mode": "comment"|"all" } ], "updatedAt": "ISO" }
 *        mode: "comment"ï¼ˆé»˜è®¤ï¼‰ä»…ç¦æ­¢è¯„è®ºï¼›"all" ç¦æ­¢ä¸€åˆ‡äº’åŠ¨ï¼ˆèµž/å…³æ³¨/è¯„è®ºï¼‰ã€‚
 *   2) çŽ¯å¢ƒå˜é‡ COMMENT_BLACKLIST="handle1,handle2,..."ï¼ˆä»… comment æ¨¡å¼ï¼‰ã€‚
 *
 * åŒ¹é…ï¼šè¢«æµè§ˆçš„ profile handleã€å¸–å­ owner handleã€caption é‡Œ @ åˆ°çš„å…±åŒä½œè€…ï¼Œä»»ä¸€å‘½ä¸­å³æ‹¦æˆªã€‚
 * å¤§å°å†™/å‰å¯¼ @ è‡ªåŠ¨å½’ä¸€ã€‚
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    // comment æ¨¡å¼ï¼šä»»ä½• entry éƒ½æ‹¦æˆªï¼ˆè¯„è®ºæ˜¯ç”¨æˆ·æ˜Žç¡®è¯‰æ±‚ï¼Œæœ€ä¸¥æ ¼ï¼‰
    // all æ¨¡å¼ï¼šä»… entry.mode==='all' æ‹¦æˆªï¼ˆç”¨äºŽèµž/å…³æ³¨ç­‰å…¨é‡å±è”½ï¼‰
    if (want === 'comment') return { blacklisted: true, entry, matched: cand };
    if (want === 'all' && entry.mode === 'all') return { blacklisted: true, entry, matched: cand };
  }
  return { blacklisted: false, matched: '' };
};

/** ä¾¿æ·å°è£…ï¼šæ˜¯å¦ç¦æ­¢å†™è¯„è®ºï¼ˆé»˜è®¤æŸ¥è¯¢ï¼‰ */
export const isCommentBlacklisted = (
  handle: string,
  opts?: { ownerHandle?: string; caption?: string }
): boolean => checkBlacklist(handle, { ...opts, mode: 'comment' }).blacklisted;

/** ä¾¿æ·å°è£…ï¼šæ˜¯å¦ç¦æ­¢ä¸€åˆ‡äº’åŠ¨ï¼ˆèµž/å…³æ³¨/è¯„è®ºï¼‰ã€‚ä»… mode==='all' çš„æ¡ç›®è§¦å‘ã€‚ */
export const isAllEngageBlacklisted = (
  handle: string,
  opts?: { ownerHandle?: string; caption?: string }
): boolean => checkBlacklist(handle, { ...opts, mode: 'all' }).blacklisted;
