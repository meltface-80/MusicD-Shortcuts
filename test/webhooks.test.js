'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { initSchema, migrate } = require('../src/db/database');
const { WebhooksRepo } = require('../src/db/webhooks');

const CONFIG = { DB_PATH: ':memory:', PUBLIC_BASE_URL: 'http://example.test:3000' };

function makeRepo() {
  const db = initSchema(new DatabaseSync(':memory:'));
  return new WebhooksRepo({ config: CONFIG, db });
}

test('create/get/list/getBySlug roundtrip with JSON shape + url', () => {
  const repo = makeRepo();
  const created = repo.create({ name: 'Random Jazz', genre: 'Jazz', genrePath: [['Jazz']] });
  assert.strictEqual(created.name, 'Random Jazz');
  assert.strictEqual(created.slug, 'random-jazz');
  assert.strictEqual(created.genre, 'Jazz');
  assert.deepStrictEqual(created.genrePath, [['Jazz']]);
  assert.strictEqual(created.isPreset, false);
  assert.strictEqual(created.url, 'http://example.test:3000/w/random-jazz');
  assert.strictEqual(typeof created.createdAt, 'number');

  const fetched = repo.get(created.id);
  assert.deepStrictEqual(fetched, created);

  const bySlug = repo.getBySlug('random-jazz');
  assert.strictEqual(bySlug.id, created.id);

  const list = repo.list();
  assert.strictEqual(list.length, 1);
});

test('unique slug generation avoids collisions', () => {
  const repo = makeRepo();
  const a = repo.create({ name: 'My Mix' });
  const b = repo.create({ name: 'My Mix' });
  const c = repo.create({ name: 'My Mix' });
  assert.strictEqual(a.slug, 'my-mix');
  assert.strictEqual(b.slug, 'my-mix-2');
  assert.strictEqual(c.slug, 'my-mix-3');
});

test('update mutates fields and returns new JSON', () => {
  const repo = makeRepo();
  const w = repo.create({ name: 'Original', genre: null });
  const updated = repo.update(w.id, { name: 'Renamed', genre: 'Rock', zoneId: 'zone-9' });
  assert.strictEqual(updated.name, 'Renamed');
  assert.strictEqual(updated.genre, 'Rock');
  assert.strictEqual(updated.zoneId, 'zone-9');
  assert.strictEqual(repo.update('missing', { name: 'x' }), null);
});

test('remove deletes a webhook', () => {
  const repo = makeRepo();
  const w = repo.create({ name: 'Temp' });
  assert.strictEqual(repo.remove(w.id), true);
  assert.strictEqual(repo.get(w.id), null);
  assert.strictEqual(repo.remove(w.id), false);
});

test('seedPresets inserts the default presets and is idempotent', () => {
  const repo = makeRepo();
  assert.strictEqual(repo.seedPresets(), true);
  assert.strictEqual(repo.count(), 8);

  const seededAgain = repo.seedPresets();
  assert.strictEqual(seededAgain, false);
  assert.strictEqual(repo.count(), 8);

  const list = repo.list();
  const slugs = list.map((w) => w.slug).sort();
  assert.ok(slugs.includes('any-album'));
  assert.ok(slugs.includes('random-jazz'));
  assert.ok(slugs.includes('5-random-albums'));
  assert.ok(slugs.includes('10-random-albums'));
  assert.ok(list.every((w) => w.isPreset === true));

  const any = repo.getBySlug('any-album');
  assert.strictEqual(any.genre, null);
  assert.strictEqual(any.genrePath, null);
  assert.strictEqual(any.count, 1);

  const jazz = repo.getBySlug('random-jazz');
  assert.deepStrictEqual(jazz.genrePath, [['Jazz']]);
  assert.strictEqual(jazz.genre, 'Jazz');
  assert.strictEqual(jazz.count, 1);

  const five = repo.getBySlug('5-random-albums');
  assert.strictEqual(five.count, 5);
  assert.strictEqual(five.genre, null);
  assert.strictEqual(five.genres, null);

  const ten = repo.getBySlug('10-random-albums');
  assert.strictEqual(ten.count, 10);
});

test('create + toJson round-trips count and multi-genre sets', () => {
  const repo = makeRepo();
  const wh = repo.create({
    name: '7 Metal & Electronic',
    genre: 'Metal & Electronic',
    genres: [[['Metal'], ['Heavy Metal']], [['Electronic']]],
    count: 7,
  });
  assert.strictEqual(wh.count, 7);
  assert.strictEqual(wh.genre, 'Metal & Electronic');
  assert.deepStrictEqual(wh.genres, [[['Metal'], ['Heavy Metal']], [['Electronic']]]);
  assert.strictEqual(wh.genrePath, null);

  const fetched = repo.getBySlug(wh.slug);
  assert.strictEqual(fetched.count, 7);
  assert.deepStrictEqual(fetched.genres, wh.genres);

  // update can change count + genres
  const updated = repo.update(wh.id, { count: 3, genres: [[['Jazz']]] });
  assert.strictEqual(updated.count, 3);
  assert.deepStrictEqual(updated.genres, [[['Jazz']]]);

  // defaults: count is 1 when omitted
  const plain = repo.create({ name: 'Plain' });
  assert.strictEqual(plain.count, 1);
  assert.strictEqual(plain.genres, null);
});

test('create + toJson round-trips raw genreNames', () => {
  const repo = makeRepo();
  const wh = repo.create({
    name: 'DnB',
    genre: 'Drum & Bass',
    genreNames: ['Drum & Bass'],
    count: 1,
  });
  assert.deepStrictEqual(wh.genreNames, ['Drum & Bass']);
  assert.strictEqual(wh.genre, 'Drum & Bass');

  const fetched = repo.getBySlug(wh.slug);
  assert.deepStrictEqual(fetched.genreNames, ['Drum & Bass']);

  // update can change genreNames
  const updated = repo.update(wh.id, { genreNames: ['Jazz', 'Metal'] });
  assert.deepStrictEqual(updated.genreNames, ['Jazz', 'Metal']);

  // null clears them
  const cleared = repo.update(wh.id, { genreNames: null });
  assert.strictEqual(cleared.genreNames, null);

  // omitted on create -> null
  const plain = repo.create({ name: 'No Names' });
  assert.strictEqual(plain.genreNames, null);
});

test('seedPresets stores genreNames for single-genre presets, null for others', () => {
  const repo = makeRepo();
  repo.seedPresets();
  assert.deepStrictEqual(repo.getBySlug('random-jazz').genreNames, ['Jazz']);
  assert.deepStrictEqual(repo.getBySlug('random-metal').genreNames, ['Metal']);
  assert.strictEqual(repo.getBySlug('any-album').genreNames, null);
  assert.strictEqual(repo.getBySlug('5-random-albums').genreNames, null);
});

test('migration adds genre_names and backfills from the legacy genre label', () => {
  // Simulate an OLD database WITHOUT the genre_names column.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      genre TEXT, genre_path TEXT, genres TEXT,
      album_count INTEGER NOT NULL DEFAULT 1,
      zone_id TEXT, zone_name TEXT, is_preset INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    'INSERT INTO webhooks (id, name, slug, genre, album_count, is_preset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('a1', 'Old Combo', 'old-combo', 'Metal & Electronic', 1, 0, Date.now());
  db.prepare(
    'INSERT INTO webhooks (id, name, slug, genre, album_count, is_preset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('a2', 'Any', 'any', null, 1, 0, Date.now());

  migrate(db);

  const cols = db.prepare('PRAGMA table_info(webhooks)').all().map((r) => r.name);
  assert.ok(cols.includes('genre_names'), 'genre_names column added');

  const combo = db.prepare('SELECT genre_names FROM webhooks WHERE id = ?').get('a1');
  assert.deepStrictEqual(JSON.parse(combo.genre_names), ['Metal', 'Electronic']);

  const any = db.prepare('SELECT genre_names FROM webhooks WHERE id = ?').get('a2');
  assert.strictEqual(any.genre_names, null);
});
