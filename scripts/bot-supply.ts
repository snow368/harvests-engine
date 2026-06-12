/* eslint-disable no-console */
// Supply Analysis bot — analyze competitor supply brands on Instagram
// Connects via CDP to Desktop 2 Chrome for shared IG session
process.env.BOT_TASK_TYPE = 'supply_analysis';

import('./bot-worker-cloak.js').then(({ main }) => {
  main().catch((err: any) => {
    console.error('[bot-supply] fatal:', err);
    process.exit(1);
  });
});
