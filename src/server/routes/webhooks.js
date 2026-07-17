'use strict';

const express = require('express');
const { playRandomAlbums } = require('../../roon/albumPlayer');
const { parseGenres, clampCount, genreNameToCandidates } = require('../../genres');

/** Send a plain-text response (iOS Shortcuts shows the body). */
function text(res, status, message) {
  res.status(status).type('text/plain').send(message);
}

/**
 * Resolve a webhook's stored config into the genre sets the player expects.
 * Prefer re-resolving from the stored raw genre NAMES so webhooks pick up
 * alias/preset/taxonomy fixes (e.g. Metal now drills through Pop/Rock, or a new
 * subgenre alias) without being recreated. Fall back to the pre-`genre_names`
 * stored genre sets / path for older ("existing") webhooks.
 */
function genreSetsFor(webhook) {
  if (webhook.genreNames && webhook.genreNames.length) {
    const sets = webhook.genreNames.map(genreNameToCandidates).filter(Boolean);
    if (sets.length) return sets;
  }
  if (webhook.genres && webhook.genres.length) return webhook.genres;
  if (webhook.genrePath) return [webhook.genrePath];
  return null;
}

/**
 * Run a play request and translate the outcome into a text response.
 * @param {object} roonManager
 * @param {{genreSets:(Array|null), count:number, zoneId:(string|null), label:(string|null)}} params
 * @param {import('express').Response} res
 */
async function runPlay(roonManager, { genreSets, count, zoneId, label }, res) {
  if (!roonManager.isPaired()) {
    text(res, 503, 'Not connected to a Roon Core yet. Make sure the extension is enabled in Roon > Settings > Extensions.');
    return;
  }
  try {
    const result = await playRandomAlbums({ roonManager, genreSets, zoneId, count });
    const where = result.zoneName ? ` in ${result.zoneName}` : '';
    const from = label ? ` from ${label}` : '';
    if (result.requested > 1) {
      const first = result.albums[0] ? ` — starting with ${result.albums[0]}` : '';
      text(res, 200, `Playing ${result.count} random albums${from}${where}${first}`);
    } else {
      const what = result.albums[0] ? result.albums[0] : 'a random album';
      text(res, 200, `Playing ${what}${where}`);
    }
  } catch (err) {
    text(res, 500, err.message || 'Failed to play album');
  }
}

/**
 * Webhook TRIGGER routes (GET, text/plain responses).
 * @param {{roonManager:object, webhooksRepo:object}} deps
 * @returns {import('express').Router}
 */
function triggerRoutes({ roonManager, webhooksRepo }) {
  const router = express.Router();

  router.get('/w/:slug', async (req, res) => {
    const webhook = webhooksRepo.getBySlug(req.params.slug);
    if (!webhook) {
      text(res, 404, `No webhook named "${req.params.slug}"`);
      return;
    }
    await runPlay(
      roonManager,
      {
        genreSets: genreSetsFor(webhook),
        count: webhook.count || 1,
        zoneId: webhook.zoneId || null,
        label: webhook.genre || null,
      },
      res
    );
  });

  // Ad-hoc / legacy endpoint. Supports ?genre=Jazz (legacy),
  // ?genres=Metal,Electronic (multi), and ?count=N.
  router.get('/random-album', async (req, res) => {
    const raw = req.query.genres != null ? req.query.genres : req.query.genre;
    const genreSets = parseGenres(raw);
    const count = clampCount(req.query.count || 1);
    const label = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    await runPlay(roonManager, { genreSets, count, zoneId: null, label }, res);
  });

  return router;
}

module.exports = { triggerRoutes };
