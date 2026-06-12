/**
 * Minimal CloakBrowser verification — launch, open IG, confirm success.
 */
import fs from 'node:fs';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_wa_01_cloak_v2';
const HEADLESS = false;

async function main() {
  // Fresh profile
  if (fs.existsSync(PROFILE_DIR)) {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log('[test] importing cloakbrowser...');
  const { launchPersistentContext } = await import('cloakbrowser');

  console.log('[test] launching persistent context...');
  const context = await launchPersistentContext({
    userDataDir: PROFILE_DIR,
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
  });

  console.log('[test] context OK, opening Instagram...');
  const pages = context.pages?.() || [];
  let page = pages[0] || await context.newPage();

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('[test] SUCCESS — IG loaded. Close the browser window to finish.');

  // Wait for browser to be manually closed
  process.on('SIGINT', async () => {
    console.log('[test] closing...');
    await context.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[test] FAILED:', e?.message || e);
  process.exit(1);
});
