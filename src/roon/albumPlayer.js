'use strict';

const crypto = require('node:crypto');
const { normalizeGenre } = require('../genres');

/**
 * @typedef {object} RoonManagerLike
 * @property {()=>Array<{zoneId:string,displayName:string,state:string}>} getZones
 * @property {()=>(string|null)} getDefaultZoneId
 * @property {(opts:object)=>Promise<object>} browse
 * @property {(opts:object)=>Promise<object>} load
 */

/** Random integer in [0, max). */
function randInt(max) {
  return Math.floor(Math.random() * max);
}

/**
 * Normalization-aware title match. Uses `normalizeGenre`, so browse-level genre
 * matching folds hyphen/space/`&`/case/slash differences ("Trip-Hop" == "Trip
 * Hop"); it is harmless for action names ("Play Now" etc.).
 */
function matchTitle(item, title) {
  return (
    item &&
    typeof item.title === 'string' &&
    normalizeGenre(item.title) === normalizeGenre(title)
  );
}

/**
 * Build the navigation path (up to and including the random-album selection).
 * The empty string `''` means "pick a RANDOM item at this list level".
 * @param {string[]|null} genrePath a single genre path (e.g. ["Electronic","Trip-Hop"]) or null/[]
 * @returns {string[]}
 */
function buildNavPath(genrePath) {
  if (Array.isArray(genrePath) && genrePath.length > 0) {
    return ['Genres', ...genrePath, 'Albums', ''];
  }
  return ['Library', 'Albums', ''];
}

/** Build a clear error message for a missing named segment. */
function missingSegmentMessage(segment, genrePath) {
  if (Array.isArray(genrePath) && genrePath.includes(segment)) {
    return `Genre "${segment}" not found in your library`;
  }
  return `"${segment}" not found in your Roon library`;
}

/**
 * Load every item at the current browse level (paginated).
 * @param {RoonManagerLike} roonManager
 * @param {string} msk multi_session_key
 * @returns {Promise<Array<{item_key:string,title:string,hint?:string}>>}
 */
async function loadAllItems(roonManager, msk) {
  const items = [];
  const pageSize = 100;
  let offset = 0;
  for (let guard = 0; guard < 1000; guard += 1) {
    const loaded = await roonManager.load({
      hierarchy: 'browse',
      offset,
      count: pageSize,
      multi_session_key: msk,
    });
    const batch = (loaded && loaded.items) || [];
    items.push(...batch);
    if (batch.length < pageSize) break;
    offset += batch.length;
  }
  return items;
}

/**
 * Given that we have browsed INTO an album, find and trigger an action such as
 * "Play Now" or "Queue". Handles both the nested "Play Album" -> action-list and
 * the case where the action is a direct child.
 * @param {RoonManagerLike} roonManager
 * @param {string} msk
 * @param {string} zoneId
 * @param {string} [action="Play Now"]  e.g. "Play Now" | "Queue" | "Add Next"
 */
async function triggerAction(roonManager, msk, zoneId, action) {
  const wanted = action || 'Play Now';
  let items = await loadAllItems(roonManager, msk);

  let target = items.find((it) => matchTitle(it, wanted));

  if (!target) {
    // Descend into an action-list: "Play Album" / "Play" / any hint action_list.
    const actionList =
      items.find((it) => matchTitle(it, 'Play Album')) ||
      items.find((it) => matchTitle(it, 'Play')) ||
      items.find((it) => it && it.hint === 'action_list');
    if (!actionList) {
      throw new Error('Could not find a play action for this album');
    }
    await roonManager.browse({
      hierarchy: 'browse',
      item_key: actionList.item_key,
      multi_session_key: msk,
    });
    items = await loadAllItems(roonManager, msk);
    target =
      items.find((it) => matchTitle(it, wanted)) ||
      (wanted === 'Play Now' ? items.find((it) => matchTitle(it, 'Play')) : null);
    if (!target) {
      throw new Error(`Could not find "${wanted}" for this album`);
    }
  }

  // The browse of the action item WITH the zone performs it (starts/queues playback).
  await roonManager.browse({
    hierarchy: 'browse',
    item_key: target.item_key,
    zone_or_output_id: zoneId,
    multi_session_key: msk,
  });
}

/**
 * Resolve the target zone: the explicit id, else the manager's default.
 * @param {RoonManagerLike} roonManager
 * @param {string|null} [zoneId]
 * @returns {{zoneId:string|null, zoneName:string|null}}
 */
function resolveZone(roonManager, zoneId) {
  const zones = (roonManager.getZones && roonManager.getZones()) || [];
  const targetId = zoneId || (roonManager.getDefaultZoneId && roonManager.getDefaultZoneId()) || null;
  let zoneName = null;
  if (targetId) {
    const z = zones.find(
      (zz) => zz.zoneId === targetId || zz.zone_id === targetId || zz.output_id === targetId
    );
    if (z) zoneName = z.displayName || z.display_name || null;
  }
  return { zoneId: targetId, zoneName };
}

/**
 * Play a random album, optionally filtered to a single genre path. `action`
 * selects what to do with it — "Play Now" (default) starts playback and clears
 * the queue; "Queue" appends it to the end.
 * @param {{roonManager:RoonManagerLike, genrePath?:string[]|null, zoneId?:string|null, action?:string}} params
 * @returns {Promise<{album:string, zoneId:string, zoneName:string|null}>}
 */
async function playRandomAlbum({ roonManager, genrePath, zoneId, action }) {
  if (!roonManager) throw new Error('roonManager is required');
  const msk = crypto.randomUUID();

  const { zoneId: zid, zoneName } = resolveZone(roonManager, zoneId);
  if (!zid) {
    throw new Error('No Roon zone available. Choose a zone or start playback in Roon first.');
  }

  const navPath = buildNavPath(genrePath);

  // Start at the browse root.
  let body = await roonManager.browse({ hierarchy: 'browse', pop_all: true, multi_session_key: msk });
  let albumTitle = null;

  for (let i = 0; i < navPath.length; i += 1) {
    const segment = navPath[i];

    if (segment === '') {
      const count = body && body.list && typeof body.list.count === 'number' ? body.list.count : 0;
      if (count <= 0) {
        const label = Array.isArray(genrePath) && genrePath.length ? `genre "${genrePath[genrePath.length - 1]}"` : 'your library';
        throw new Error(`No albums found for ${label}`);
      }
      const offset = randInt(count);
      const loaded = await roonManager.load({ hierarchy: 'browse', offset, count: 1, multi_session_key: msk });
      const item = loaded && loaded.items && loaded.items[0];
      if (!item) throw new Error('Failed to load a random album');
      albumTitle = item.title;
      body = await roonManager.browse({ hierarchy: 'browse', item_key: item.item_key, multi_session_key: msk });
    } else {
      const items = await loadAllItems(roonManager, msk);
      const item = items.find((it) => matchTitle(it, segment));
      if (!item) throw new Error(missingSegmentMessage(segment, genrePath));
      body = await roonManager.browse({ hierarchy: 'browse', item_key: item.item_key, multi_session_key: msk });
    }
  }

  // `body` now describes the album's action level. Trigger the action.
  await triggerAction(roonManager, msk, zid, action);

  return { album: albumTitle, zoneId: zid, zoneName };
}

/**
 * Try each candidate genre path in order until one succeeds. `candidates` is an
 * array of path arrays (e.g. [["Trip-Hop"], ["Electronic","Trip-Hop"]]), or
 * null/[] for "any album".
 * @param {{roonManager:RoonManagerLike, candidates?:(string[][]|null), zoneId?:string|null, action?:string}} params
 */
async function playByGenrePathCandidates({ roonManager, candidates, zoneId, action }) {
  if (!candidates || candidates.length === 0) {
    return playRandomAlbum({ roonManager, genrePath: null, zoneId, action });
  }
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      return await playRandomAlbum({ roonManager, genrePath: candidate, zoneId, action });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No matching genre path found in your library');
}

/** Fisher–Yates shuffle (returns a new array). */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * Play/queue ONE album drawn from a random genre in `genreSets`. Each element of
 * `genreSets` is a candidate-path array for one genre. Selected genres are tried
 * in random order until one yields an album. `null`/`[]` means any genre.
 * @param {{roonManager:RoonManagerLike, genreSets?:(string[][][]|null), zoneId:string, action:string}} params
 */
async function playOneFromSets({ roonManager, genreSets, zoneId, action }) {
  if (!genreSets || genreSets.length === 0) {
    return playRandomAlbum({ roonManager, genrePath: null, zoneId, action });
  }
  const order = shuffle(genreSets);
  let lastErr = null;
  for (const candidates of order) {
    try {
      return await playByGenrePathCandidates({ roonManager, candidates, zoneId, action });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No matching genre found in your library');
}

/**
 * Play `count` random albums into a zone. The first uses "Play Now" (starting
 * playback and replacing the queue); the rest are appended with "Queue". When
 * `genreSets` has several genres, each album is drawn from a randomly chosen one.
 * @param {{roonManager:RoonManagerLike, genreSets?:(string[][][]|null), zoneId?:string|null, count?:number}} params
 * @returns {Promise<{albums:string[], count:number, requested:number, zoneId:string, zoneName:string|null}>}
 */
async function playRandomAlbums({ roonManager, genreSets, zoneId, count }) {
  if (!roonManager) throw new Error('roonManager is required');
  const requested = Math.max(1, Math.floor(Number(count)) || 1);
  const { zoneId: zid, zoneName } = resolveZone(roonManager, zoneId);
  if (!zid) {
    throw new Error('No Roon zone available. Choose a zone or start playback in Roon first.');
  }

  const albums = [];
  for (let i = 0; i < requested; i += 1) {
    const action = i === 0 ? 'Play Now' : 'Queue';
    try {
      const r = await playOneFromSets({ roonManager, genreSets, zoneId: zid, action });
      albums.push(r.album);
    } catch (err) {
      // The first album must start playback; later slots are best-effort.
      if (i === 0) throw err;
    }
  }
  return { albums, count: albums.length, requested, zoneId: zid, zoneName };
}

module.exports = {
  playRandomAlbum,
  playByGenrePathCandidates,
  playRandomAlbums,
  playOneFromSets,
  resolveZone,
  buildNavPath,
  shuffle,
};
