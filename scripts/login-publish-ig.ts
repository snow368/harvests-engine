/**
 * Login Publish IG — Launch Chromium persistent with publish profile dir.
 * Log into IG, then close the browser to persist session.
 * publish-worker.ts will reuse the same session.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';

async function main() {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('[login-publish] Launching Chromium persistent...');
  console.log('[login-publish] Profile:', PROFILE_DIR);
  console.log('=====================================');
  console.log('  Open IG, log in with your account');
  console.log('  Close browser when done to save session');
  console.log('=====================================');

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = browser.pages()[0] || await browser.newPage();
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('[login-publish] IG loaded. URL:', page.url().slice(0, 80));

  // Wait for browser to close
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      try {
        if (!browser.isConnected()) { clearInterval(t); resolve(); }
      } catch { clearInterval(t); resolve(); }
    }, 2000);
  });

  try { await browser.close(); } catch {}
  console.log('[login-publish] Session saved to:', PROFILE_DIR);
}

main().catch(e => {
  console.error('[login-publish] Error:', e?.message || e);
  process.exit(1);
});
