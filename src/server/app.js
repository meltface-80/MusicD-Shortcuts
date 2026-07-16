'use strict';

const path = require('node:path');
const express = require('express');
const { apiRoutes } = require('./routes/api');
const { triggerRoutes } = require('./routes/webhooks');
const { healthRoutes } = require('./routes/health');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/**
 * Build the express app.
 * @param {{roonManager:object, webhooksRepo:object, config:object}} deps
 * @returns {import('express').Express}
 */
function createApp({ roonManager, webhooksRepo, config }) {
  if (!roonManager) throw new Error('createApp requires roonManager');
  if (!webhooksRepo) throw new Error('createApp requires webhooksRepo');

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // Health + REST API + trigger endpoints.
  app.use('/', healthRoutes());
  app.use('/api', apiRoutes({ roonManager, webhooksRepo, config }));
  app.use('/', triggerRoutes({ roonManager, webhooksRepo }));

  // Static PWA.
  app.use(express.static(PUBLIC_DIR));
  app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err) res.status(200).type('text/plain').send('MusicD Shortcuts is running.');
    });
  });

  // JSON 404 for unknown /api routes.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Generic error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (req.path && req.path.startsWith('/api')) {
      res.status(status).json({ error: err.message || 'Internal error' });
    } else {
      res.status(status).type('text/plain').send(err.message || 'Internal error');
    }
  });

  return app;
}

module.exports = { createApp };
