'use strict';

const { buildGenreIndex, matchGenreName } = require('../../src/roon/genreIndex');

/**
 * An in-memory fake of the Roon browse tree + a roonManager that walks it,
 * matching the interface albumPlayer/routes depend on:
 *   { isPaired, getCoreName, getStatusMessage, getZones, getDefaultZoneId,
 *     browse(opts):Promise, load(opts):Promise }
 *
 * The tree is a set of "nodes". Each node has:
 *   { title, hint, count, items?:[childNode], onPlay?:fn }
 * A node's `items` are its children (the next browse level). `count` is derived
 * from items.length unless overridden.
 *
 * Browse/load emulate Roon: browse({pop_all}) resets to root; browse({item_key})
 * descends into a child and sets it as the current level; load() returns the
 * current level's items (respecting offset/count). Passing zone_or_output_id on
 * a node with onPlay records the play.
 */

let keyCounter = 0;
function assignKeys(node) {
  node._key = `k${keyCounter++}`;
  for (const child of node.items || []) assignKeys(child);
  return node;
}

/** Build a leaf album node: album -> "Play Album" -> "Play Now". */
function albumNode(title) {
  return {
    title,
    items: [
      {
        title: 'Play Album',
        hint: 'action_list',
        items: [
          { title: 'Play Now', hint: 'action', isPlayNow: true },
          { title: 'Add Next', hint: 'action' },
          { title: 'Queue', hint: 'action' },
        ],
      },
      { title: 'Play Artist Radio', hint: 'action_list', items: [{ title: 'Play Now', hint: 'action' }] },
    ],
  };
}

/**
 * Build a default fake tree:
 *   root -> Library -> Albums -> [N albums]
 *        -> Genres  -> [Jazz -> Albums -> [albums],
 *                       Electronic -> [Trip-Hop -> Albums -> [albums], Albums -> [albums]]]
 * @param {{albums?:number}} [opts]
 */
function buildDefaultTree(opts = {}) {
  const n = opts.albums == null ? 5 : opts.albums;
  const mkAlbums = (prefix, count) =>
    Array.from({ length: count }, (_, i) => albumNode(`${prefix} Album ${i + 1}`));

  const root = {
    title: 'Root',
    items: [
      {
        title: 'Library',
        items: [{ title: 'Albums', items: mkAlbums('Library', n) }],
      },
      {
        title: 'Genres',
        items: [
          {
            title: 'Jazz',
            items: [
              { title: 'Albums', items: mkAlbums('Jazz', 3) },
              // "Cool Jazz" is deliberately NOT in any Phase 1 alias, so it can
              // ONLY be resolved via the live genre index (proves Phase 2 value).
              { title: 'Cool Jazz', items: [{ title: 'Albums', items: mkAlbums('Cool Jazz', 2) }] },
            ],
          },
          {
            title: 'Electronic',
            items: [
              { title: 'Albums', items: mkAlbums('Electronic', 4) },
              // Node title is SPACED ("Trip Hop") while requests use the
              // hyphenated "Trip-Hop" — exercises normalization-aware matching.
              { title: 'Trip Hop', items: [{ title: 'Albums', items: mkAlbums('Trip-Hop', 2) }] },
            ],
          },
          {
            // Metal / Heavy Metal are nested under Pop/Rock (AllMusic taxonomy),
            // NOT at the top level — mirrors real Roon libraries.
            title: 'Pop/Rock',
            items: [
              { title: 'Albums', items: mkAlbums('Pop/Rock', 4) },
              {
                title: 'Heavy Metal',
                items: [
                  { title: 'Albums', items: mkAlbums('Heavy Metal', 3) },
                  // A deeper subgenre so the "death metal" alias drill path
                  // (Pop/Rock > Heavy Metal > Death Metal) can be reached.
                  { title: 'Death Metal', items: [{ title: 'Albums', items: mkAlbums('Death Metal', 2) }] },
                ],
              },
              { title: 'Metal', items: [{ title: 'Albums', items: mkAlbums('Metal', 3) }] },
            ],
          },
        ],
      },
    ],
  };
  keyCounter = 0;
  assignKeys(root);
  return root;
}

/**
 * Create a fake roonManager over a browse tree.
 * @param {object} [config]
 * @param {object} [config.tree] a tree (from buildDefaultTree)
 * @param {boolean} [config.paired]
 * @param {Array} [config.zones]
 * @param {string} [config.defaultZoneId]
 */
function createFakeRoonManager(config = {}) {
  const tree = config.tree || buildDefaultTree();
  const paired = config.paired !== false;
  const zones = config.zones || [
    { zoneId: 'zone-1', displayName: 'Living Room', state: 'stopped' },
    { zoneId: 'zone-2', displayName: 'Kitchen', state: 'playing' },
  ];
  const defaultZoneId = 'defaultZoneId' in config ? config.defaultZoneId : 'zone-1';

  // Index nodes by key for O(1) descent.
  const byKey = new Map();
  (function index(node) {
    byKey.set(node._key, node);
    for (const c of node.items || []) index(c);
  })(tree);

  // Per multi_session_key "current level" state.
  const sessions = new Map();
  const calls = { browse: [], load: [] };
  const plays = [];

  const listOf = (node) => ({
    title: node.title,
    count: (node.items || []).length,
    level: 0,
    hint: node.hint || null,
  });

  const manager = {
    _tree: tree,
    _calls: calls,
    _plays: plays,

    isPaired: () => paired,
    getCoreName: () => (paired ? 'Fake Core' : null),
    getStatusMessage: () => (paired ? 'Paired with Fake Core.' : 'Not paired.'),
    getZones: () => zones.slice(),
    getDefaultZoneId: () => defaultZoneId,

    browse(opts) {
      calls.browse.push(opts);
      const msk = opts.multi_session_key || '_default';

      if (opts.pop_all) {
        sessions.set(msk, tree);
        return Promise.resolve({ action: 'list', list: listOf(tree) });
      }

      if (opts.item_key) {
        const node = byKey.get(opts.item_key);
        if (!node) return Promise.reject(new Error('Unknown item_key'));

        // Play/queue trigger: an action node browsed WITH a zone performs it.
        if (opts.zone_or_output_id && (node.isPlayNow || node.hint === 'action')) {
          plays.push({ node, action: node.title, zoneId: opts.zone_or_output_id, msk });
          return Promise.resolve({ action: 'none', list: null });
        }
        sessions.set(msk, node);
        return Promise.resolve({ action: 'list', list: listOf(node) });
      }

      // Bare browse (no item_key / pop_all): return current level.
      const cur = sessions.get(msk) || tree;
      return Promise.resolve({ action: 'list', list: listOf(cur) });
    },

    load(opts) {
      calls.load.push(opts);
      const msk = opts.multi_session_key || '_default';
      const cur = sessions.get(msk) || tree;
      const items = (cur.items || []).map((c) => ({
        item_key: c._key,
        title: c.title,
        subtitle: null,
        hint: c.hint || null,
      }));
      const offset = opts.offset || 0;
      const count = typeof opts.count === 'number' ? opts.count : items.length;
      const slice = items.slice(offset, offset + count);
      return Promise.resolve({ list: listOf(cur), offset, items: slice });
    },

    // Phase 2 — same surface the real RoonManager exposes, over this fake tree.
    async getGenreIndex() {
      return buildGenreIndex(manager, { maxDepth: 3 });
    },
    async resolveGenreName(name) {
      return matchGenreName(await manager.getGenreIndex(), name);
    },
  };

  return manager;
}

module.exports = { createFakeRoonManager, buildDefaultTree, albumNode };
