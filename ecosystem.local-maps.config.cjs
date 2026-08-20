// Local-only headed Maps runner and its control listener.
const path = require('node:path');
const ENGINE_DIR = __dirname;
const LOGS_DIR = path.join(ENGINE_DIR, 'logs');

module.exports = {
  apps: [
    {
      name: 'maps-scrape-scheduler',
      cwd: ENGINE_DIR,
      script: './scripts/maps-scrape-scheduler.ts',
      interpreter: 'node.exe',
      node_args: '--import tsx',
      autorestart: true,
      restart_delay: 10_000,
      env: {
        CLOUD_API_BASE: 'https://harvests.pages.dev',
        BOT_API_TOKEN: 'vps-bot-secret-2024',
        SCRAPE_POLL_INTERVAL_MS: '60000',
        SCRAPE_MAX_RUNTIME_MS: '21600000',
        SCRAPE_CDP_URL: 'http://127.0.0.1:9222',
        SCRAPE_COUNTRY: 'USA',
      },
      error_file: path.join(LOGS_DIR, 'maps-scrape-local-error.log'),
      out_file: path.join(LOGS_DIR, 'maps-scrape-local-out.log'),
    },
    {
      name: 'bot-control-listener-local',
      cwd: ENGINE_DIR,
      script: './scripts/bot-control-listener.ts',
      interpreter: 'node.exe',
      node_args: '--import tsx',
      autorestart: true,
      restart_delay: 5_000,
      env: {
        CLOUD_API_BASE: 'https://harvests.pages.dev',
        BOT_API_TOKEN: 'vps-bot-secret-2024',
        LISTENER_INTERVAL_MS: '10000',
        CONTROL_HOST_ID: 'local-windows',
        CONTROL_HOST_LABEL: 'Local headed Chrome',
      },
      error_file: path.join(LOGS_DIR, 'control-local-error.log'),
      out_file: path.join(LOGS_DIR, 'control-local-out.log'),
    },
  ],
};
