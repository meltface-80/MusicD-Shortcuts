'use strict';

/**
 * The six built-in genre presets.
 * `genrePath` is an array of CANDIDATE paths (each candidate an array of genre
 * title levels to drill in the Roon `Genres` browser). `null` means "any album".
 * @type {Array<{key:string,label:string,genrePath:(string[][]|null)}>}
 */
const PRESETS = [
  { key: 'any', label: 'Any Album', genrePath: null },
  { key: 'pop-rock', label: 'Pop/Rock', genrePath: [['Pop/Rock']] },
  // Metal / Heavy Metal are AllMusic subgenres nested under "Pop/Rock" in most
  // Roon libraries, so include the drill-down paths as candidates.
  { key: 'metal', label: 'Metal', genrePath: [['Metal'], ['Heavy Metal'], ['Pop/Rock', 'Heavy Metal'], ['Pop/Rock', 'Metal']] },
  { key: 'jazz', label: 'Jazz', genrePath: [['Jazz']] },
  { key: 'electronic', label: 'Electronic', genrePath: [['Electronic']] },
  { key: 'trip-hop', label: 'Trip-Hop', genrePath: [['Trip-Hop'], ['Electronic', 'Trip-Hop']] },
];

/** Upper bound on how many albums a single webhook may queue. */
const MAX_ALBUM_COUNT = 50;

/**
 * Canonical comparison form for a genre / browse-item title. Folds the
 * differences that don't matter when matching Roon genre titles:
 *   - lowercase + trim
 *   - hyphens `-` become spaces (so "Trip-Hop" == "Trip Hop")
 *   - whitespace around `/` is collapsed (so "Pop / Rock" == "Pop/Rock")
 *   - `&` and the word "and" both fold to " and " (so "Drum & Bass" ==
 *     "drum and bass")
 *   - repeated whitespace collapses to a single space
 * @param {*} s
 * @returns {string}
 */
function normalizeGenre(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+and\s+/g, ' and ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a user-entered genre string into individual genre NAMES. Splits on
 * comma and newline ONLY — NOT on `&` or `;` — so genre names that legitimately
 * contain an ampersand ("Drum & Bass", "R&B") survive as a single genre.
 * @param {string} str
 * @returns {string[]}
 */
function splitGenreInput(str) {
  return String(str == null ? '' : str)
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Look up a preset by its key.
 * @param {string} key
 * @returns {{key:string,label:string,genrePath:(string[][]|null)}|undefined}
 */
function getPreset(key) {
  return PRESETS.find((p) => p.key === key);
}

/**
 * Common subgenre aliases → candidate drill paths (each a `string[]`), ordered
 * most-specific-first with progressively shallower fallbacks. Keys are compared
 * via `normalizeGenre`, so casing / hyphens / ampersands don't matter. Paths use
 * Roon/AllMusic nesting: Heavy-Metal subgenres under Pop/Rock, most electronic
 * subgenres under Electronic, bebop/hard-bop under Jazz.
 * @type {Object<string,string[][]>}
 */
const SUBGENRE_ALIASES = {
  // Metal (nested under Pop/Rock > Heavy Metal in AllMusic).
  [normalizeGenre('Death Metal')]: [['Pop/Rock', 'Heavy Metal', 'Death Metal'], ['Heavy Metal', 'Death Metal'], ['Death Metal']],
  [normalizeGenre('Black Metal')]: [['Pop/Rock', 'Heavy Metal', 'Black Metal'], ['Heavy Metal', 'Black Metal'], ['Black Metal']],
  [normalizeGenre('Thrash Metal')]: [['Pop/Rock', 'Heavy Metal', 'Thrash Metal'], ['Heavy Metal', 'Thrash Metal'], ['Thrash Metal']],
  [normalizeGenre('Doom Metal')]: [['Pop/Rock', 'Heavy Metal', 'Doom Metal'], ['Heavy Metal', 'Doom Metal'], ['Doom Metal']],
  [normalizeGenre('Power Metal')]: [['Pop/Rock', 'Heavy Metal', 'Power Metal'], ['Heavy Metal', 'Power Metal'], ['Power Metal']],
  [normalizeGenre('Progressive Metal')]: [['Pop/Rock', 'Heavy Metal', 'Progressive Metal'], ['Heavy Metal', 'Progressive Metal'], ['Progressive Metal']],
  [normalizeGenre('Metalcore')]: [['Pop/Rock', 'Heavy Metal', 'Metalcore'], ['Heavy Metal', 'Metalcore'], ['Metalcore']],
  // Rock (nested under Pop/Rock).
  [normalizeGenre('Post-Rock')]: [['Pop/Rock', 'Post-Rock'], ['Post-Rock']],
  [normalizeGenre('Shoegaze')]: [['Pop/Rock', 'Shoegaze'], ['Shoegaze']],
  [normalizeGenre('Prog Rock')]: [['Pop/Rock', 'Prog-Rock'], ['Pop/Rock', 'Progressive Rock'], ['Prog-Rock'], ['Progressive Rock']],
  // Electronic subgenres.
  [normalizeGenre('Ambient')]: [['Electronic', 'Ambient'], ['Ambient']],
  [normalizeGenre('House')]: [['Electronic', 'House'], ['House']],
  [normalizeGenre('Deep House')]: [['Electronic', 'House', 'Deep House'], ['Electronic', 'Deep House'], ['Deep House']],
  [normalizeGenre('Techno')]: [['Electronic', 'Techno'], ['Techno']],
  [normalizeGenre('Dubstep')]: [['Electronic', 'Dubstep'], ['Dubstep']],
  [normalizeGenre('Drum & Bass')]: [['Electronic', 'Drum & Bass'], ['Drum & Bass']],
  [normalizeGenre('Trip-Hop')]: [['Trip-Hop'], ['Electronic', 'Trip-Hop']],
  // Jazz subgenres.
  [normalizeGenre('Bebop')]: [['Jazz', 'Bebop'], ['Bebop']],
  [normalizeGenre('Hard Bop')]: [['Jazz', 'Hard Bop'], ['Hard Bop']],
};

/**
 * Synonyms → the canonical genre NAME to resolve as. Keyed by `normalizeGenre`
 * of the alias. The canonical name is then run back through the resolution
 * cascade (preset / subgenre alias / literal).
 * @type {Object<string,string>}
 */
const SYNONYMS = {
  [normalizeGenre('Progressive Rock')]: 'Prog Rock',
  [normalizeGenre('Prog-Rock')]: 'Prog Rock',
  [normalizeGenre('Progressive Metal')]: 'Progressive Metal',
  [normalizeGenre('Post Bop')]: 'Post-Bop',
  [normalizeGenre('Rhythm & Blues')]: 'R&B',
  [normalizeGenre('Rhythm and Blues')]: 'R&B',
  [normalizeGenre('Drum and Bass')]: 'Drum & Bass',
  [normalizeGenre('DnB')]: 'Drum & Bass',
};

/**
 * Resolve a single genre NAME to its candidate-path array. Cascade:
 *   1. an explicit "Parent > Child" string becomes a single drill path;
 *   2. the name is normalized and mapped through SYNONYMS (if present);
 *   3. a matching PRESET label returns the preset's candidate paths;
 *   4. a matching SUBGENRE_ALIASES key returns its candidate drill paths;
 *   5. otherwise a single literal `[[name]]`.
 * All matching is via `normalizeGenre`, so casing / hyphens / `&` / slash
 * spacing don't matter.
 * @param {string} name
 * @returns {string[][]|null} candidate paths, or null for an empty name.
 */
function genreNameToCandidates(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return null;
  // (1) Explicit nested path, e.g. "Pop/Rock > Heavy Metal". (">" avoids
  // clashing with the "/" in genre names like "Pop/Rock".)
  if (raw.includes('>')) {
    const path = raw.split('>').map((s) => s.trim()).filter(Boolean);
    return path.length ? [path] : null;
  }
  // (2) Apply synonyms (map to a canonical name), then re-normalize.
  let resolved = raw;
  const syn = SYNONYMS[normalizeGenre(raw)];
  if (syn) resolved = syn;
  const key = normalizeGenre(resolved);
  // (3) Preset label match.
  const preset = PRESETS.find((p) => p.genrePath && normalizeGenre(p.label) === key);
  if (preset) return preset.genrePath;
  // (4) Subgenre alias match.
  if (SUBGENRE_ALIASES[key]) return SUBGENRE_ALIASES[key];
  // (5) Literal single-level path (use the resolved/canonical name).
  return [[resolved]];
}

/**
 * Parse a multi-genre selection into "genre sets" — an array where each element
 * is the candidate-path array for ONE genre. Accepts a comma / newline separated
 * string ("Metal, Electronic") or an array of names. `&` and `;` are NOT
 * separators, so "Drum & Bass" stays a single genre. Returns null when nothing
 * usable is given (meaning "any genre").
 * @param {string|string[]|null|undefined} input
 * @returns {string[][][]|null}
 */
function parseGenres(input) {
  let names = [];
  if (Array.isArray(input)) names = input.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  else if (typeof input === 'string') names = splitGenreInput(input);
  if (!names.length) return null;
  const sets = names.map(genreNameToCandidates).filter(Boolean);
  return sets.length ? sets : null;
}

/**
 * Clamp an album count to an integer in [1, MAX_ALBUM_COUNT].
 * @param {*} n
 * @returns {number}
 */
function clampCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, MAX_ALBUM_COUNT);
}

module.exports = {
  PRESETS,
  getPreset,
  genreNameToCandidates,
  parseGenres,
  splitGenreInput,
  normalizeGenre,
  SUBGENRE_ALIASES,
  SYNONYMS,
  clampCount,
  MAX_ALBUM_COUNT,
};
