/* eslint-disable no-console */
// IG Outreach bot — browse, like, comment, follow tattoo shops
// Uses Playwright Chromium persistent profile (per-bot isolated)
process.env.BOT_TASK_TYPE = 'ig_outreach';

import('./bot-worker-cloak.js').then(({ main }) => {
  main().catch((err: any) => {
    console.error('[bot-outreach] fatal:', err);
    process.exit(1);
  });
});
