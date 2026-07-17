'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { initSchema } = require('../src/db/database');
const { WebhooksRepo } = require('../src/db/webhooks');
const { createApp } = require('../src/server/app');
const { createFakeRoonManager } = require('./helpers/fakeRoon');

const CONFIG = { PUBLIC_BASE_URL: 'http://example.test:3000', PORT: 0 };

function makeRepo() {
  const db = initSchema(new DatabaseSync(':memory:'));
  const repo = new WebhooksRepo({ config: CONFIG, db });
  repo.seedPresets();
  return repo;
}

/** Start an app on an ephemeral port, return { base, close, roonManager, repo }. */
function startApp({ paired = true } = {}) {
  const repo = makeRepo();
  const roonManager = createFakeRoonManager({ paired });
  const app = createApp({ roonManager, webhooksRepo: repo, config: CONFIG });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
        roonManager,
        repo,
      });
    });
  });
}

let ctx;
before(async () => {
  ctx = await startApp();
});
after(async () => {
  if (ctx) await ctx.close();
});

test('GET /healthz returns ok', async () => {
  const res = await fetch(`${ctx.base}/healthz`);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true });
});

test('GET /api/genres/presets returns 6', async () => {
  const res = await fetch(`${ctx.base}/api/genres/presets`);
  const body = await res.json();
  assert.strictEqual(body.presets.length, 6);
});

test('GET /api/status reflects the fake manager', async () => {
  const res = await fetch(`${ctx.base}/api/status`);
  const body = await res.json();
  assert.strictEqual(body.paired, true);
  assert.strictEqual(body.coreName, 'Fake Core');
  assert.strictEqual(body.zoneCount, 2);
});

test('GET /api/zones lists zones', async () => {
  const res = await fetch(`${ctx.base}/api/zones`);
  const body = await res.json();
  assert.strictEqual(body.zones.length, 2);
  assert.strictEqual(body.zones[0].displayName, 'Living Room');
});

test('GET /api/webhooks lists the seeded presets', async () => {
  const res = await fetch(`${ctx.base}/api/webhooks`);
  const body = await res.json();
  assert.strictEqual(body.webhooks.length, 8);
  assert.ok(body.webhooks.every((w) => w.isPreset === true));
});

test('POST /api/webhooks creates a webhook, then DELETE removes it', async () => {
  const createRes = await fetch(`${ctx.base}/api/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My Custom', genre: 'Rock', genrePath: [['Rock']] }),
  });
  assert.strictEqual(createRes.status, 201);
  const { webhook } = await createRes.json();
  assert.strictEqual(webhook.name, 'My Custom');
  assert.strictEqual(webhook.slug, 'my-custom');
  assert.strictEqual(webhook.url, 'http://example.test:3000/w/my-custom');

  const getRes = await fetch(`${ctx.base}/api/webhooks/${webhook.id}`);
  assert.strictEqual(getRes.status, 200);

  const patchRes = await fetch(`${ctx.base}/api/webhooks/${webhook.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed Custom' }),
  });
  assert.strictEqual((await patchRes.json()).webhook.name, 'Renamed Custom');

  const delRes = await fetch(`${ctx.base}/api/webhooks/${webhook.id}`, { method: 'DELETE' });
  assert.strictEqual(delRes.status, 204);

  const gone = await fetch(`${ctx.base}/api/webhooks/${webhook.id}`);
  assert.strictEqual(gone.status, 404);
});

test('POST /api/webhooks without name returns 400', async () => {
  const res = await fetch(`${ctx.base}/api/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ genre: 'Rock' }),
  });
  assert.strictEqual(res.status, 400);
});

test('GET /w/:slug triggers a play and returns 200 text', async () => {
  const res = await fetch(`${ctx.base}/w/any-album`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/plain'));
  const bodyText = await res.text();
  assert.match(bodyText, /^Playing /);
  assert.ok(ctx.roonManager._plays.length >= 1);
});

test('GET /w/:slug for a genre webhook plays', async () => {
  const res = await fetch(`${ctx.base}/w/random-jazz`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Jazz Album/);
});

test('GET /w/unknown returns 404 text', async () => {
  const res = await fetch(`${ctx.base}/w/does-not-exist`);
  assert.strictEqual(res.status, 404);
  assert.match(await res.text(), /No webhook named/);
});

test('GET /random-album?genre=Jazz plays', async () => {
  const res = await fetch(`${ctx.base}/random-album?genre=Jazz`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Jazz Album/);
});

test('POST with genres:["Drum & Bass"] stores one genre name and label', async () => {
  const res = await fetch(`${ctx.base}/api/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My DnB', genres: ['Drum & Bass'], count: 1 }),
  });
  assert.strictEqual(res.status, 201);
  const { webhook } = await res.json();
  // "&" is NOT a separator: a single genre is stored, label uses comma-join.
  assert.deepStrictEqual(webhook.genreNames, ['Drum & Bass']);
  assert.strictEqual(webhook.genre, 'Drum & Bass');
  await fetch(`${ctx.base}/api/webhooks/${webhook.id}`, { method: 'DELETE' });
});

test('POST with multiple genres joins the label with a comma', async () => {
  const res = await fetch(`${ctx.base}/api/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Combo', genres: ['Metal', 'Electronic'], count: 1 }),
  });
  const { webhook } = await res.json();
  assert.deepStrictEqual(webhook.genreNames, ['Metal', 'Electronic']);
  assert.strictEqual(webhook.genre, 'Metal, Electronic');
  await fetch(`${ctx.base}/api/webhooks/${webhook.id}`, { method: 'DELETE' });
});

test('an "existing" webhook without genreNames still resolves via the fallback', async () => {
  // Create a pre-genre_names shaped row directly: genre + genres set, no names.
  const created = ctx.repo.create({
    name: 'Legacy Jazz',
    genre: 'Jazz',
    genres: [[['Jazz']]],
    slug: 'legacy-jazz',
  });
  assert.strictEqual(created.genreNames, null);
  const res = await fetch(`${ctx.base}/w/legacy-jazz`);
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Jazz Album/);
  await fetch(`${ctx.base}/api/webhooks/${created.id}`, { method: 'DELETE' });
});

test('trigger returns 503 when no core is paired', async () => {
  const unpaired = await startApp({ paired: false });
  try {
    const res = await fetch(`${unpaired.base}/w/any-album`);
    assert.strictEqual(res.status, 503);
    assert.match(await res.text(), /Roon Core/);
  } finally {
    await unpaired.close();
  }
});
