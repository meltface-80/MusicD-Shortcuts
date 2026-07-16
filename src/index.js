'use strict';

const fs = require('node:fs');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db/database');
const { WebhooksRepo } = require('./db/webhooks');
const { RoonManager } = require('./roon/roonManager');
const { createApp } = require('./server/app');

function main() {
  const config = loadConfig();

  // Ensure the data directory exists and make it the CWD BEFORE creating RoonApi,
  // so config.json (Roon pairing) lands on the mounted volume.
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  process.chdir(config.DATA_DIR);

  const db = openDatabase(config.DB_PATH);
  const webhooksRepo = new WebhooksRepo({ config, db });
  webhooksRepo.seedPresets();

  const roonManager = new RoonManager({ config, webhooksRepo });
  roonManager.start();

  const app = createApp({ roonManager, webhooksRepo, config });
  const server = app.listen(config.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`MusicD Shortcuts listening on port ${config.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`Dashboard: ${config.PUBLIC_BASE_URL}/`);
  });

  const shutdown = (signal) => {
    // eslint-disable-next-line no-console
    console.log(`\nReceived ${signal}, shutting down…`);
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    // Force-exit if close hangs.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
