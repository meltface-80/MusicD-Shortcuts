'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildGenreIndex, matchGenreName } = require('../src/roon/genreIndex');
const { createFakeRoonManager, buildDefaultTree } = require('./helpers/fakeRoon');

/** Does the index contain a genre with this normalized-equal path? */
function hasPath(index, wanted) {
  return index.genres.some(
    (g) =>
      g.path.length === wanted.length &&
      g.path.every((s, i) => s.toLowerCase() === wanted[i].toLowerCase())
  );
}

/* --- buildGenreIndex ---------------------------------------------------- */

test('buildGenreIndex enumerates top-level and nested genres from the tree', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });

  assert.ok(index.builtAt > 0, 'builtAt is a timestamp');
  assert.ok(hasPath(index, ['Jazz']));
  assert.ok(hasPath(index, ['Jazz', 'Cool Jazz']));
  assert.ok(hasPath(index, ['Electronic']));
  assert.ok(hasPath(index, ['Electronic', 'Trip Hop']));
  assert.ok(hasPath(index, ['Pop/Rock']));
  assert.ok(hasPath(index, ['Pop/Rock', 'Heavy Metal']));
  assert.ok(hasPath(index, ['Pop/Rock', 'Heavy Metal', 'Death Metal']));
  assert.ok(hasPath(index, ['Pop/Rock', 'Metal']));
});

test('buildGenreIndex records exact library titles (spaced "Trip Hop")', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });
  const trip = index.genres.find((g) => g.path.length === 2 && g.path[0] === 'Electronic' && g.name === 'Trip Hop');
  assert.ok(trip, 'Trip Hop is recorded with its exact spaced title');
});

test('buildGenreIndex over a tree without a Genres node returns {genres:[]}', async () => {
  const tree = buildDefaultTree();
  tree.items = tree.items.filter((n) => n.title !== 'Genres');
  const roonManager = createFakeRoonManager({ tree });
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });
  assert.deepStrictEqual(index.genres, []);
  assert.ok(index.builtAt > 0);
});

test('buildGenreIndex respects maxDepth (no deep subgenres at depth 1)', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 1 });
  assert.ok(hasPath(index, ['Jazz']));
  assert.ok(!hasPath(index, ['Jazz', 'Cool Jazz']), 'nested genre excluded at maxDepth 1');
  assert.ok(!hasPath(index, ['Pop/Rock', 'Heavy Metal']));
});

/* --- matchGenreName ----------------------------------------------------- */

test('matchGenreName resolves an exact subgenre name to its full path', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });

  assert.deepStrictEqual(matchGenreName(index, 'death metal'), ['Pop/Rock', 'Heavy Metal', 'Death Metal']);
  assert.deepStrictEqual(matchGenreName(index, 'cool jazz'), ['Jazz', 'Cool Jazz']);
});

test('matchGenreName resolves a "Parent > Child" drill path', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });
  assert.deepStrictEqual(
    matchGenreName(index, 'Pop/Rock > Heavy Metal'),
    ['Pop/Rock', 'Heavy Metal']
  );
  // A drill path that doesn't exist as a real nesting returns null.
  assert.strictEqual(matchGenreName(index, 'Jazz > Death Metal'), null);
});

test('matchGenreName exact-name prefers the shallowest path', async () => {
  // Two genres named "Metal"-ish: only one here, but "Trip Hop" both spaced and
  // requested hyphenated should resolve to the single Electronic > Trip Hop path.
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });
  assert.deepStrictEqual(matchGenreName(index, 'Trip-Hop'), ['Electronic', 'Trip Hop']);
});

test('matchGenreName falls back to fuzzy (startsWith / substring) matching', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });
  // "trip" is not an exact genre name; startsWith fuzzy reaches "Trip Hop".
  assert.deepStrictEqual(matchGenreName(index, 'trip'), ['Electronic', 'Trip Hop']);
});

test('matchGenreName falls back to token-overlap matching', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });
  // "metal death" has no exact/startsWith/substring hit but all tokens appear
  // in "Death Metal".
  assert.deepStrictEqual(matchGenreName(index, 'metal death'), ['Pop/Rock', 'Heavy Metal', 'Death Metal']);
});

test('matchGenreName returns null for an unknown genre', async () => {
  const roonManager = createFakeRoonManager();
  const index = await buildGenreIndex(roonManager, { maxDepth: 3 });
  assert.strictEqual(matchGenreName(index, 'Polka'), null);
});

test('matchGenreName returns null against an empty index', () => {
  assert.strictEqual(matchGenreName({ genres: [] }, 'Jazz'), null);
});
