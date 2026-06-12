/**
 * Read saved Instagram credentials from Chrome Login Data.
 * Username is plaintext; password needs DPAPI (Windows) decryption.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

// All profile directories
const entries = fs.readdirSync(USER_DATA, { withFileTypes: true });
const profiles = entries
  .filter(e => e.isDirectory() && (e.name === 'Default' || /^Profile \d+$/.test(e.name)))
  .map(e => e.name);

console.log('Found profiles:', profiles.join(', '));
console.log('');

for (const profile of profiles) {
  const dbPath = path.join(USER_DATA, profile, 'Login Data');
  if (!fs.existsSync(dbPath)) { console.log(`[${profile}] No Login Data`); continue; }

  // Copy to temp because Chrome locks the file
  const tmpPath = path.join(os.tmpdir(), `chrome_login_${profile.replace(/\s/g, '_')}.db`);
  try {
    fs.copyFileSync(dbPath, tmpPath);
    const db = new Database(tmpPath, { readonly: true });

    const rows = db.prepare(`
      SELECT origin_url, username_value, password_value
      FROM logins
      WHERE origin_url LIKE '%instagram%'
         OR origin_url LIKE '%ig.%'
         OR action_url LIKE '%instagram%'
    `).all() as Array<{ origin_url: string; username_value: string; password_value: Buffer }>;

    if (rows.length === 0) {
      console.log(`[${profile}] No IG entries`);
    } else {
      for (const row of rows) {
        console.log(`[${profile}] ============================`);
        console.log(`  URL:      ${row.origin_url}`);
        console.log(`  Username: ${row.username_value}`);

        // Decrypt password via PowerShell DPAPI
        const hex = row.password_value.toString('hex');
        try {
          const psScript = `
            Add-Type -AssemblyName System.Security
            $enc = [byte[]]@(${row.password_value.join(',')})
            $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
            [System.Text.Encoding]::UTF8.GetString($dec)
          `;
          const result = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
            encoding: 'utf-8',
            timeout: 10000,
            windowsHide: true,
          }).trim();
          console.log(`  Password: ${result || '(decrypt failed)'}`);
        } catch (e: any) {
          console.log(`  Password: (DPAPI error: ${e?.message?.slice(0, 60)})`);
        }
        console.log('');
      }
    }

    db.close();
    fs.unlinkSync(tmpPath);
  } catch (e: any) {
    console.log(`[${profile}] Error: ${e?.message?.slice(0, 100)}`);
  }
}
