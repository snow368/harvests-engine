/** Persistent, single-process queue for asynchronous comment review. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type CommentQueueItem = {
  id: string;
  handle: string;
  postUrl: string;
  postKey: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'reviewing' | 'human_pending' | 'approved' | 'blocked' | 'posted';
  mediaFiles: string[];
  meta?: Record<string, unknown>;
  vision?: unknown;
  technical?: unknown;
  safeFacts?: string[];
  proposedComment?: string;
  groundingRisks?: string[];
  reason?: string;
  postedAt?: string;
};

const ROOT = path.resolve(process.env.BOT_COMMENT_QUEUE_DIR || './data/comment_queue');
const MEDIA_DIR = path.join(ROOT, 'media');
const STATE_FILE = path.join(ROOT, 'queue.json');
const MAX_PENDING = Math.max(1, Number(process.env.BOT_COMMENT_QUEUE_MAX || 20));
const TTL_HOURS = Math.max(1, Number(process.env.BOT_COMMENT_QUEUE_TTL_HOURS || 24));

const ensure = () => { fs.mkdirSync(MEDIA_DIR, { recursive: true }); };
const keyOf = (url: string) => {
  try {
    const match = new URL(url).pathname.match(/^\/(p|reels?)\/([^/]+)/i);
    return match ? `${match[1].replace(/^reels$/i, 'reel').toLowerCase()}:${match[2]}` : '';
  } catch { return ''; }
};

let items: CommentQueueItem[] = [];
try {
  ensure();
  if (fs.existsSync(STATE_FILE)) items = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!Array.isArray(items)) items = [];
  // A process restart safely returns unfinished reviews to pending.
  items.forEach((item) => { if (item.status === 'reviewing') item.status = 'pending'; });
} catch { items = []; }

const save = () => {
  ensure();
  const temp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(temp, STATE_FILE);
};

export const enqueueCommentCandidate = (input: {
  handle: string; postUrl: string; images: string[]; meta?: Record<string, unknown>;
}): { ok: boolean; id?: string; reason?: string } => {
  const postKey = keyOf(input.postUrl);
  if (!postKey || !input.images.length) return { ok: false, reason: 'invalid_candidate' };
  const now = Date.now();
  const duplicate = items.find((item) => item.postKey === postKey && item.status !== 'blocked');
  if (duplicate) return { ok: false, reason: `duplicate_${duplicate.status}` };
  const active = items.filter((item) => ['pending', 'reviewing', 'human_pending', 'approved'].includes(item.status) && Date.parse(item.expiresAt) > now);
  if (active.length >= MAX_PENDING) return { ok: false, reason: 'queue_full' };
  const id = `${now}_${createHash('sha1').update(`${postKey}:${now}`).digest('hex').slice(0, 10)}`;
  const mediaFiles = input.images.map((base64, index) => {
    const file = path.join(MEDIA_DIR, `${id}_${String(index + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  });
  items.push({
    id, handle: input.handle, postUrl: input.postUrl, postKey,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL_HOURS * 3600_000).toISOString(),
    status: 'pending', mediaFiles, meta: input.meta,
  });
  save();
  return { ok: true, id };
};

export const claimPendingComment = (): CommentQueueItem | null => {
  const now = Date.now();
  let changed = false;
  for (const item of items) {
    if (['pending', 'human_pending', 'approved'].includes(item.status) && Date.parse(item.expiresAt) <= now) {
      item.status = 'blocked'; item.reason = 'expired';
      changed = true;
    }
  }
  const item = items.find((entry) => entry.status === 'pending');
  if (!item) { if (changed) save(); return null; }
  item.status = 'reviewing'; save();
  return structuredClone(item);
};

export const finishCommentReview = (id: string, patch: Partial<CommentQueueItem>) => {
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  Object.assign(item, patch);
  save();
};

export const markCommentHumanApproved = (id: string) => finishCommentReview(id, {
  status: 'approved',
  reason: 'human_approved_for_posting',
});

export const markCommentHumanRejected = (id: string, reason = 'human_rejected') => finishCommentReview(id, {
  status: 'blocked',
  reason,
});

export const nextApprovedComment = (): CommentQueueItem | null => {
  const now = Date.now();
  const item = items.find((entry) => entry.status === 'approved' && Date.parse(entry.expiresAt) > now);
  return item ? structuredClone(item) : null;
};

export const markCommentPosted = (id: string) => finishCommentReview(id, { status: 'posted', postedAt: new Date().toISOString() });
export const getCommentQueueStats = () => ({
  pending: items.filter((x) => x.status === 'pending').length,
  reviewing: items.filter((x) => x.status === 'reviewing').length,
  humanPending: items.filter((x) => x.status === 'human_pending').length,
  approved: items.filter((x) => x.status === 'approved').length,
  blocked: items.filter((x) => x.status === 'blocked').length,
  posted: items.filter((x) => x.status === 'posted').length,
});
