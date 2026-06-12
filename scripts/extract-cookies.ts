// Extract Instagram cookies from Chrome profile for CloakBrowser
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CHROME_PROFILE = process.env.CHROME_PROFILE || 'F:/bots/profiles/bot_wa_01';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './data/bot_profiles/bot_wa_01_cloak';

const cookiesPath = path.join(CHROME_PROFILE, 'Default', 'Cookies');
const tmpPath = path.join(OUTPUT_DIR, 'cookies_copy.db');
const jsonPath = path.join(OUTPUT_DIR, 'ig_cookies.json');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Copy to avoid locking
fs.copyFileSync(cookiesPath, tmpPath);

const db = new Database(tmpPath, { readonly: true });
const rows = db.prepare(`
  SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly, same_site
  FROM cookies
  WHERE host_key LIKE '%instagram%' OR host_key LIKE '%ig.c%' OR host_key LIKE '%facebook%'
`).all();
db.close();

const cookies = rows.map((r: any) => ({
  name: r.name,
  value: r.value,
  domain: r.host_key.startsWith('.') ? r.host_key : '.' + r.host_key,
  path: r.path || '/',
  expires: r.expires_utc ? Math.floor(r.expires_utc / 1000000 - 11644473600) : -1,
  httpOnly: Boolean(r.is_httponly),
  secure: Boolean(r.is_secure),
  sameSite: r.same_site === 0 ? 'No_Restriction' as const : r.same_site === 1 ? 'Lax' as const : 'Strict' as const,
}));

fs.writeFileSync(jsonPath, JSON.stringify(cookies, null, 2));

const important = cookies.filter((c: any) =>
  ['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'ig_nrcb'].includes(c.name)
);

console.log(`Extracted ${cookies.length} IG/FB cookies from Chrome profile`);
console.log('Key cookies:', important.map((c: any) => c.name).join(', '));
console.log('Saved to', jsonPath);
