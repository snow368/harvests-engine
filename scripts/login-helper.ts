/**
 * Login Helper v3 — Use regular launch, manually save session.
 * After login, close browser to persist cookies.
 */
import { launch } from 'cloakbrowser';
import fs from 'node:fs';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_wa_01_cloak';

async function main() {
  // Remove old profile so it starts clean
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('[login] Launching browser (profile: ' + PROFILE_DIR + ')...');

  const browser = await launch({
    headless: false,
    args: [
      '--window-size=1280,900',
      '--user-data-dir=' + PROFILE_DIR,
    ],
  });

  const page = await browser.newPage();
  console.log('[login] Browser open. Loading IG...');

  try {
    await page.goto('https://www.instagram.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });
  } catch (e: any) {
    console.log('[login] nav:', e?.message?.slice(0, 80));
  }

  console.log('[login] URL:', (await page.url()).slice(0, 80));
  console.log('=========================');
  console.log('  Log into IG now');
  console.log('  Close browser when done');
  console.log('=========================');

  // Wait for close
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      try {
        if (!browser.isConnected()) { clearInterval(t); resolve(); }
      } catch { clearInterval(t); resolve(); }
    }, 2000);
  });

  try { await browser.close(); } catch {}
  console.log('[login] Done. Profile: ' + PROFILE_DIR);
}

main().catch(e => {
  console.error('[login] Error:', e?.message || e);
  process.exit(1);
});
