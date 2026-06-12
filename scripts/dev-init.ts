/**
 * DEV account system — migration + seed
 * Creates user_accounts + feature_access tables, creates default DEV user.
 *
 * Usage: npx tsx scripts/dev-init.ts
 */

import 'dotenv/config';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = path.join(process.cwd(), 'data', 'deep_scan_tasks.db');
const DEV_USERNAME = process.env.DEV_USERNAME || 'dev';
const DEV_API_KEY = process.env.DEV_API_KEY || `dev_master_${Date.now()}`;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

try {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_accounts (
      user_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      api_key TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feature_access (
      user_id TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, feature_key),
      FOREIGN KEY (user_id) REFERENCES user_accounts(user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fa_user ON feature_access(user_id);
  `);

  // Upsert DEV user
  const now = Date.now();
  const existing = db.prepare('SELECT user_id FROM user_accounts WHERE username = ?').get(DEV_USERNAME) as any;
  let userId: string;

  if (existing) {
    userId = existing.user_id;
    db.prepare(
      "UPDATE user_accounts SET api_key = ?, role = 'dev', is_active = 1, updated_at = ? WHERE user_id = ?"
    ).run(DEV_API_KEY, now, userId);
  } else {
    userId = `usr_dev_${now}`;
    db.prepare(
      'INSERT INTO user_accounts (user_id, username, api_key, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, DEV_USERNAME, DEV_API_KEY, 'dev', 1, now, now);
  }

  // Ensure all features enabled for DEV
  const features = [
    'content_bot', 'product_tracker', 'forum_monitor',
    'competitor_research', 'content_calendar', 'content_guide',
    'pipeline', 'analytics',
  ];
  const upsert = db.prepare(
    'INSERT OR REPLACE INTO feature_access (user_id, feature_key, enabled, updated_at) VALUES (?, ?, 1, ?)'
  );
  for (const f of features) upsert.run(userId, f, now);

  console.log('DEV account system initialized:');
  console.log(`  Username: ${DEV_USERNAME}`);
  console.log(`  API Key:  ${DEV_API_KEY}`);
  console.log(`  Features: ${features.join(', ')}`);
  console.log('');
  console.log('Use x-dev-key header with this API key for DEV endpoints.');
} finally {
  db.close();
}
