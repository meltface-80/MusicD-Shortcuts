'use strict';

const express = require('express');
const { PRESETS, parseGenres, clampCount } = require('../../genres');

/**
 * REST API consumed by the PWA. Returns JSON.
 * @param {{roonManager:object, webhooksRepo:object, config:object}} deps
 * @returns {import('express').Router}
 */
function apiRoutes({ roonManager, webhooksRepo }) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({
      paired: roonManager.isPaired(),
      coreName: roonManager.getCoreName(),
      message: typeof roonManager.getStatusMessage === 'function' ? roonManager.getStatusMessage() : null,
      zoneCount: roonManager.getZones().length,
    });
  });

  router.get('/zones', (req, res) => {
    res.json({ zones: roonManager.getZones() });
  });

  router.get('/genres/presets', (req, res) => {
    res.json({ presets: PRESETS.map((p) => ({ key: p.key, label: p.label, genrePath: p.genrePath })) });
  });

  // Live genre library (Phase 2). `available:false` with genres:[] when
  // unpaired, when the index is empty, or when the manager can't provide one.
  router.get('/genres/library', async (req, res) => {
    try {
      if (typeof roonManager.getGenreIndex !== 'function') {
        res.json({ available: false, genres: [] });
        return;
      }
      const paired = typeof roonManager.isPaired === 'function' && roonManager.isPaired();
      if (!paired) {
        res.json({ available: false, genres: [] });
        return;
      }
      const index = await roonManager.getGenreIndex();
      const genres = (index && index.genres) || [];
      res.json({
        available: genres.length > 0,
        genres: genres.map((g) => ({ name: g.name, path: g.path })),
      });
    } catch {
      res.json({ available: false, genres: [] });
    }
  });

  router.get('/webhooks', (req, res) => {
    res.json({ webhooks: webhooksRepo.list() });
  });

  router.post('/webhooks', (req, res) => {
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    try {
      const data = {
        name: String(body.name),
        count: clampCount(body.count != null ? body.count : 1),
        zoneId: body.zoneId != null ? body.zoneId : null,
        zoneName: body.zoneName != null ? body.zoneName : null,
      };
      // Multi-genre selection (array of genre names) takes precedence.
      const names = Array.isArray(body.genres)
        ? body.genres.map((g) => String(g).trim()).filter(Boolean)
        : null;
      if (names && names.length) {
        data.genreNames = names;
        data.genres = parseGenres(names);
        data.genre = names.join(', ');
      } else {
        data.genre = body.genre != null ? body.genre : null;
        data.genrePath = body.genrePath != null ? body.genrePath : null;
      }
      const webhook = webhooksRepo.create(data);
      res.status(201).json({ webhook });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/webhooks/:id', (req, res) => {
    const webhook = webhooksRepo.get(req.params.id);
    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json({ webhook });
  });

  router.patch('/webhooks/:id', (req, res) => {
    const updated = webhooksRepo.update(req.params.id, req.body || {});
    if (!updated) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json({ webhook: updated });
  });

  router.delete('/webhooks/:id', (req, res) => {
    const removed = webhooksRepo.remove(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}

module.exports = { apiRoutes };
