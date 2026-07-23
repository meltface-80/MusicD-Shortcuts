'use strict';

const express = require('express');
const { playRandomAlbums } = require('../../roon/albumPlayer');
const { parseGenres, clampCount, genreNameToCandidates, splitGenreInput, normalizeGenre } = require('../../genres');

/** Send a plain-text response (iOS Shortcuts shows the body). */
function text(res, status, message) {
  res.status(status).type('text/plain').send(message);
}

/** True when two title-paths are equal (normalization-aware). */
function samePath(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((s, i) => normalizeGenre(s) === normalizeGenre(b[i]));
}

/**
 * Resolve ONE genre NAME into an ordered candidate-path array. The live library
 * index path (Phase 2) is tried FIRST, then the Phase 1 static candidates
 * (deduped against the live path). If the index is empty / mis-enumerated /
 * absent, this falls through to Phase 1 alone — no regression.
 * @param {object} roonManager
 * @param {string} name
 * @returns {Promise<string[][]|null>} candidate paths, or null when empty.
 */
async function enrichName(roonManager, name) {
  const staticCandidates = genreNameToCandidates(name) || [];
  let candidates = staticCandidates;
  if (roonManager && typeof roonManager.resolveGenreName === 'function') {
    let livePath = null;
    try {
      livePath = await roonManager.resolveGenreName(name);
    } catch {
      livePath = null;
    }
    if (livePath && livePath.length) {
      candidates = [livePath, ...staticCandidates.filter((c) => !samePath(c, livePath))];
    }
  }
  return candidates && candidates.length ? candidates : null;
}

/**
 * Resolve a webhook's stored config into the genre sets the player expects.
 * Prefer re-resolving from the stored raw genre NAMES — trying the live library
 * index path first (so a genre that only exists as a nested subgenre resolves
 * precisely), then the Phase 1 static aliases/presets. Fall back to the
 * pre-`genre_names` stored genre sets / path for older ("existing") webhooks.
 * @param {object} roonManager
 * @param {object} webhook
 * @returns {Promise<Array|null>}
 */
async function resolveGenreSets(roonManager, webhook) {
  if (webhook.genreNames && webhook.genreNames.length) {
    const sets = [];
    for (const name of webhook.genreNames) {
      const candidates = await enrichName(roonManager, name);
      if (candidates) sets.push(candidates);
    }
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
        genreSets: await resolveGenreSets(roonManager, webhook),
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
    // Derive genre NAMES, then enrich each with the live index (Phase 1 static
    // stays the fallback). Fall back to parseGenres(raw) when nothing enriches.
    let names = null;
    if (Array.isArray(raw)) names = raw.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
    else if (typeof raw === 'string') names = splitGenreInput(raw);

    let genreSets;
    if (names && names.length) {
      const sets = [];
      for (const name of names) {
        const candidates = await enrichName(roonManager, name);
        if (candidates) sets.push(candidates);
      }
      genreSets = sets.length ? sets : parseGenres(raw);
    } else {
      genreSets = parseGenres(raw);
    }

    const count = clampCount(req.query.count || 1);
    const label = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    await runPlay(roonManager, { genreSets, count, zoneId: null, label }, res);
  });

  return router;
}

module.exports = { triggerRoutes };
