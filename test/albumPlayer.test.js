'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  playRandomAlbum,
  playByGenrePathCandidates,
  playRandomAlbums,
  resolveZone,
} = require('../src/roon/albumPlayer');
const { genreNameToCandidates } = require('../src/genres');
const { createFakeRoonManager, buildDefaultTree } = require('./helpers/fakeRoon');

/* --- normalization-aware matching --------------------------------------- */

test('a hyphenated "Trip-Hop" request matches the spaced "Trip Hop" library node', async () => {
  const roonManager = createFakeRoonManager();
  // The fake library node is titled "Trip Hop" (spaced); the request is
  // hyphenated. normalizeGenre folds them so matching still reaches it.
  const result = await playRandomAlbum({
    roonManager,
    genrePath: ['Electronic', 'Trip-Hop'],
    zoneId: 'zone-1',
  });
  assert.match(result.album, /^Trip-Hop Album \d+$/);
});

test('the "death metal" alias reaches Pop/Rock > Heavy Metal > Death Metal', async () => {
  const roonManager = createFakeRoonManager();
  const candidates = genreNameToCandidates('death metal');
  const result = await playByGenrePathCandidates({ roonManager, candidates, zoneId: 'zone-1' });
  assert.match(result.album, /^Death Metal Album \d+$/);
});

test('any-album plays and returns an album title', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbum({ roonManager, genrePath: null, zoneId: 'zone-1' });
  assert.match(result.album, /^Library Album \d+$/);
  assert.strictEqual(result.zoneId, 'zone-1');
  assert.strictEqual(result.zoneName, 'Living Room');
  assert.strictEqual(roonManager._plays.length, 1);
});

test('jazz genre plays a jazz album', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbum({ roonManager, genrePath: ['Jazz'], zoneId: 'zone-1' });
  assert.match(result.album, /^Jazz Album \d+$/);
  assert.strictEqual(roonManager._plays.length, 1);
});

test('trip-hop via candidate ["Electronic","Trip-Hop"] plays', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playByGenrePathCandidates({
    roonManager,
    candidates: [['Trip-Hop'], ['Electronic', 'Trip-Hop']],
    zoneId: 'zone-1',
  });
  // First candidate ["Trip-Hop"] does not exist at the top Genres level, so the
  // second candidate (drill through Electronic) must be used.
  assert.match(result.album, /^Trip-Hop Album \d+$/);
});

test('unknown genre throws a clear error', async () => {
  const roonManager = createFakeRoonManager();
  await assert.rejects(
    () => playRandomAlbum({ roonManager, genrePath: ['Bluegrass'], zoneId: 'zone-1' }),
    /Genre "Bluegrass" not found in your library/
  );
});

test('empty album list throws', async () => {
  const roonManager = createFakeRoonManager({ tree: buildDefaultTree({ albums: 0 }) });
  await assert.rejects(
    () => playRandomAlbum({ roonManager, genrePath: null, zoneId: 'zone-1' }),
    /No albums found/
  );
});

test('final Play Now browse receives the correct zone_or_output_id', async () => {
  const roonManager = createFakeRoonManager();
  await playRandomAlbum({ roonManager, genrePath: null, zoneId: 'zone-2' });
  assert.strictEqual(roonManager._plays.length, 1);
  assert.strictEqual(roonManager._plays[0].zoneId, 'zone-2');
  // The recorded play node is a "Play Now" leaf.
  assert.strictEqual(roonManager._plays[0].node.isPlayNow, true);
});

test('a random offset within range is used for album selection', async () => {
  const roonManager = createFakeRoonManager(); // Library has 5 albums
  await playRandomAlbum({ roonManager, genrePath: null, zoneId: 'zone-1' });
  const albumLoad = roonManager._calls.load.find((c) => c.count === 1);
  assert.ok(albumLoad, 'expected a count:1 load for the random album');
  assert.ok(albumLoad.offset >= 0 && albumLoad.offset < 5, `offset ${albumLoad.offset} in [0,5)`);
});

test('resolveZone falls back to the default zone id', () => {
  const roonManager = createFakeRoonManager({ defaultZoneId: 'zone-2' });
  const r = resolveZone(roonManager, null);
  assert.strictEqual(r.zoneId, 'zone-2');
  assert.strictEqual(r.zoneName, 'Kitchen');
});

test('throws when no zone is available', async () => {
  const roonManager = createFakeRoonManager({ zones: [], defaultZoneId: null });
  await assert.rejects(
    () => playRandomAlbum({ roonManager, genrePath: null, zoneId: null }),
    /No Roon zone available/
  );
});

test('every browse/load carries a multi_session_key and it is unique per call', async () => {
  const roonManager = createFakeRoonManager();
  await playRandomAlbum({ roonManager, genrePath: null, zoneId: 'zone-1' });
  const keys = new Set();
  for (const c of [...roonManager._calls.browse, ...roonManager._calls.load]) {
    assert.ok(c.multi_session_key, 'call missing multi_session_key');
    keys.add(c.multi_session_key);
  }
  // A single play uses ONE session key across all its calls.
  assert.strictEqual(keys.size, 1);
});

/* --- multi-album (count) + multi-genre ---------------------------------- */

test('playRandomAlbums plays N albums: first Play Now, rest Queue', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbums({ roonManager, genreSets: null, zoneId: 'zone-1', count: 3 });
  assert.strictEqual(result.requested, 3);
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.albums.length, 3);
  result.albums.forEach((a) => assert.match(a, /^Library Album \d+$/));
  // Actions recorded on the fake: first is Play Now, the rest are Queue.
  const actions = roonManager._plays.map((p) => p.action);
  assert.strictEqual(actions.length, 3);
  assert.strictEqual(actions[0], 'Play Now');
  assert.deepStrictEqual(actions.slice(1), ['Queue', 'Queue']);
  // All performed on the requested zone.
  assert.ok(roonManager._plays.every((p) => p.zoneId === 'zone-1'));
});

test('playRandomAlbums with a single genre set plays from that genre', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbums({
    roonManager,
    genreSets: [[['Jazz']]],
    zoneId: 'zone-1',
    count: 2,
  });
  assert.strictEqual(result.albums.length, 2);
  result.albums.forEach((a) => assert.match(a, /^Jazz Album \d+$/));
});

test('playRandomAlbums draws from a randomly chosen genre when several are given', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbums({
    roonManager,
    genreSets: [[['Jazz']], [['Electronic']]],
    zoneId: 'zone-1',
    count: 6,
  });
  assert.strictEqual(result.albums.length, 6);
  result.albums.forEach((a) => assert.match(a, /^(Jazz|Electronic) Album \d+$/));
});

test('playRandomAlbums resolves trip-hop via candidate drill-down', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbums({
    roonManager,
    genreSets: [[['Trip-Hop'], ['Electronic', 'Trip-Hop']]],
    zoneId: 'zone-1',
    count: 2,
  });
  assert.strictEqual(result.albums.length, 2);
  result.albums.forEach((a) => assert.match(a, /^Trip-Hop Album \d+$/));
});

test('playRandomAlbums count defaults to 1 and is best-effort on later slots', async () => {
  const roonManager = createFakeRoonManager();
  const one = await playRandomAlbums({ roonManager, genreSets: null, zoneId: 'zone-1' });
  assert.strictEqual(one.requested, 1);
  assert.strictEqual(one.albums.length, 1);
});

/* --- nested genres (Metal under Pop/Rock) ------------------------------- */

test('explicit nested path plays a subgenre album (Pop/Rock > Heavy Metal)', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbum({
    roonManager,
    genrePath: ['Pop/Rock', 'Heavy Metal'],
    zoneId: 'zone-1',
  });
  assert.match(result.album, /^Heavy Metal Album \d+$/);
});

test('metal preset candidates resolve via the Pop/Rock drill path', async () => {
  const roonManager = createFakeRoonManager();
  // Top-level "Metal"/"Heavy Metal" do not exist here (they are under Pop/Rock),
  // so the first candidates miss and the drill paths succeed.
  const result = await playByGenrePathCandidates({
    roonManager,
    candidates: [['Metal'], ['Heavy Metal'], ['Pop/Rock', 'Heavy Metal'], ['Pop/Rock', 'Metal']],
    zoneId: 'zone-1',
  });
  assert.match(result.album, /^(Heavy Metal|Metal) Album \d+$/);
});

test('playRandomAlbums (multi) plays several metal albums via the drill path', async () => {
  const roonManager = createFakeRoonManager();
  const result = await playRandomAlbums({
    roonManager,
    genreSets: [[['Metal'], ['Heavy Metal'], ['Pop/Rock', 'Heavy Metal'], ['Pop/Rock', 'Metal']]],
    zoneId: 'zone-1',
    count: 3,
  });
  assert.strictEqual(result.albums.length, 3);
  result.albums.forEach((a) => assert.match(a, /^(Heavy Metal|Metal) Album \d+$/));
});
