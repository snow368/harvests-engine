/* eslint-disable no-console */
// Reddit Intel bot — scrape tattoo subreddits, AI classify for brand/product insights
process.env.BOT_TASK_TYPE = 'reddit_scrape';

import('./bot-worker-cloak.js').then(({ main }) => {
  main().catch((err: any) => {
    console.error('[bot-reddit] fatal:', err);
    process.exit(1);
  });
});
