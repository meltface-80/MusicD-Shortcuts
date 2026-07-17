'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PRESETS, getPreset } = require('../src/genres');

test('there are exactly six presets with the expected keys', () => {
  assert.strictEqual(PRESETS.length, 6);
  const keys = PRESETS.map((p) => p.key);
  assert.deepStrictEqual(keys, ['any', 'pop-rock', 'metal', 'jazz', 'electronic', 'trip-hop']);
});

test('each preset has key/label/genrePath shape', () => {
  for (const p of PRESETS) {
    assert.strictEqual(typeof p.key, 'string');
    assert.strictEqual(typeof p.label, 'string');
    assert.ok(p.genrePath === null || Array.isArray(p.genrePath), `${p.key} genrePath`);
    if (Array.isArray(p.genrePath)) {
      for (const candidate of p.genrePath) assert.ok(Array.isArray(candidate));
    }
  }
});

test('any is the only null-genrePath preset', () => {
  assert.strictEqual(getPreset('any').genrePath, null);
  assert.deepStrictEqual(getPreset('jazz').genrePath, [['Jazz']]);
  assert.deepStrictEqual(getPreset('trip-hop').genrePath, [['Trip-Hop'], ['Electronic', 'Trip-Hop']]);
  assert.deepStrictEqual(getPreset('metal').genrePath, [['Metal'], ['Heavy Metal'], ['Pop/Rock', 'Heavy Metal'], ['Pop/Rock', 'Metal']]);
});

test('getPreset returns undefined for unknown key', () => {
  assert.strictEqual(getPreset('nope'), undefined);
});

/* --- multi-genre + count helpers ---------------------------------------- */

const {
  genreNameToCandidates,
  parseGenres,
  splitGenreInput,
  normalizeGenre,
  clampCount,
  MAX_ALBUM_COUNT,
} = require('../src/genres');

test('normalizeGenre folds case / hyphen / slash-spacing / ampersand+and', () => {
  assert.strictEqual(normalizeGenre('Trip-Hop'), normalizeGenre('Trip Hop'));
  assert.strictEqual(normalizeGenre('Drum & Bass'), normalizeGenre('drum and bass'));
  assert.strictEqual(normalizeGenre('Pop / Rock'), normalizeGenre('Pop/Rock'));
  assert.strictEqual(normalizeGenre('  HEAVY   METAL '), 'heavy metal');
  // distinct genres stay distinct
  assert.notStrictEqual(normalizeGenre('Jazz'), normalizeGenre('Rock'));
});

test('splitGenreInput splits on comma/newline only, keeping "&" genres whole', () => {
  assert.deepStrictEqual(splitGenreInput('Drum & Bass'), ['Drum & Bass']);
  assert.deepStrictEqual(splitGenreInput('Metal, Electronic'), ['Metal', 'Electronic']);
  assert.deepStrictEqual(splitGenreInput('Metal\nElectronic'), ['Metal', 'Electronic']);
  // "&" and ";" are NOT separators
  assert.deepStrictEqual(splitGenreInput('R&B; Soul'), ['R&B; Soul']);
  assert.deepStrictEqual(splitGenreInput('  ,, '), []);
});

test('genreNameToCandidates resolves subgenre aliases', () => {
  assert.deepStrictEqual(genreNameToCandidates('death metal'), [
    ['Pop/Rock', 'Heavy Metal', 'Death Metal'],
    ['Heavy Metal', 'Death Metal'],
    ['Death Metal'],
  ]);
  // ampersand-containing subgenre resolves under Electronic
  assert.deepStrictEqual(genreNameToCandidates('Drum & Bass'), [
    ['Electronic', 'Drum & Bass'],
    ['Drum & Bass'],
  ]);
  // Ambient drills through Electronic
  assert.deepStrictEqual(genreNameToCandidates('Ambient'), [['Electronic', 'Ambient'], ['Ambient']]);
});

test('genreNameToCandidates applies synonyms', () => {
  // "progressive rock" -> canonical "Prog Rock" -> its alias drill paths
  assert.deepStrictEqual(genreNameToCandidates('progressive rock'), [
    ['Pop/Rock', 'Prog-Rock'],
    ['Pop/Rock', 'Progressive Rock'],
    ['Prog-Rock'],
    ['Progressive Rock'],
  ]);
  // "rhythm and blues" -> "R&B" (literal, single level)
  assert.deepStrictEqual(genreNameToCandidates('rhythm and blues'), [['R&B']]);
});

test('genreNameToCandidates maps preset labels to their candidate paths', () => {
  assert.deepStrictEqual(genreNameToCandidates('Jazz'), [['Jazz']]);
  // Metal drills through Pop/Rock (AllMusic nesting), case-insensitive.
  assert.deepStrictEqual(genreNameToCandidates('metal'), [
    ['Metal'], ['Heavy Metal'], ['Pop/Rock', 'Heavy Metal'], ['Pop/Rock', 'Metal'],
  ]);
  assert.deepStrictEqual(genreNameToCandidates('Trip-Hop'), [['Trip-Hop'], ['Electronic', 'Trip-Hop']]);
  // unknown genre -> single literal path
  assert.deepStrictEqual(genreNameToCandidates('Bluegrass'), [['Bluegrass']]);
  assert.strictEqual(genreNameToCandidates(''), null);
});

test('genreNameToCandidates supports explicit nested "Parent > Child" paths', () => {
  assert.deepStrictEqual(genreNameToCandidates('Pop/Rock > Heavy Metal'), [['Pop/Rock', 'Heavy Metal']]);
  assert.deepStrictEqual(genreNameToCandidates('Electronic > Trip-Hop > Downtempo'), [
    ['Electronic', 'Trip-Hop', 'Downtempo'],
  ]);
  // works inside a multi-genre string too
  assert.deepStrictEqual(parseGenres('Pop/Rock > Heavy Metal, Jazz'), [
    [['Pop/Rock', 'Heavy Metal']],
    [['Jazz']],
  ]);
});

test('parseGenres splits on comma / newline and resolves each', () => {
  assert.strictEqual(parseGenres(''), null);
  assert.strictEqual(parseGenres(null), null);
  assert.deepStrictEqual(parseGenres('Jazz'), [[['Jazz']]]);
  assert.deepStrictEqual(parseGenres('Metal, Electronic'), [
    [['Metal'], ['Heavy Metal'], ['Pop/Rock', 'Heavy Metal'], ['Pop/Rock', 'Metal']],
    [['Electronic']],
  ]);
  assert.deepStrictEqual(parseGenres(['Jazz', 'Electronic']), [[['Jazz']], [['Electronic']]]);
  // extra separators / whitespace are ignored
  assert.deepStrictEqual(parseGenres(' Jazz ,,  Electronic '), [[['Jazz']], [['Electronic']]]);
  // "&" is NOT a separator — "Drum & Bass" is a single genre
  assert.deepStrictEqual(parseGenres('Drum & Bass'), [
    [['Electronic', 'Drum & Bass'], ['Drum & Bass']],
  ]);
});

test('clampCount coerces to an integer in [1, MAX]', () => {
  assert.strictEqual(clampCount(1), 1);
  assert.strictEqual(clampCount(7), 7);
  assert.strictEqual(clampCount(0), 1);
  assert.strictEqual(clampCount(-5), 1);
  assert.strictEqual(clampCount('3'), 3);
  assert.strictEqual(clampCount('nope'), 1);
  assert.strictEqual(clampCount(9999), MAX_ALBUM_COUNT);
  assert.strictEqual(clampCount(2.9), 2);
});
