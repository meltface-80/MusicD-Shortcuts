# CLAUDE.md — MusicD-Shortcuts

Guidance for Claude (and humans) working in this repository.

## What this project is

A **Roon extension** that turns "play a random album" into shareable **webhooks**
you can trigger from **iPhone/iOS Shortcuts** (and likely Android HTTP-shortcut
apps). It pairs with your Roon Core, exposes an HTTP server, and plays a random
album — optionally filtered by genre — into a chosen Roon zone when a webhook URL
is hit.

It ships with pre-made webhooks:

1. Any random album
2. Random Pop/Rock album
3. Random Metal album
4. Random Jazz album
5. Random Electronic album
6. Random Trip-Hop album

Users can also create their own genre webhooks two ways:

- **In Roon** → Settings → Extensions → this extension's settings: pick a genre
  from a dropdown + a zone, save, and a new webhook is created.
- **In the built-in PWA dashboard** (served by the extension): create/rename/delete
  webhooks, copy their URLs straight into a Shortcut. Webhooks persist in a
  local **SQLite** database (Node's built-in `node:sqlite` — no native build).

All saved webhooks are listed with copyable URLs in both the Roon settings
(as a link to the dashboard) and the PWA.

## Hard requirements (from the project owner)

- **Use agent workers** for the substantive build work; the lead orchestrates,
  integrates, and verifies.
- **Research and test fully. No regressions.** Every change keeps the test suite
  green. Behaviour that worked before must keep working.
- **Docker install.** Ship a `Dockerfile` + `docker-compose.yml`.
- **Build from the main repos — no tarballs.** The `node-roon-api*` packages are
  **not on the public npm registry**; depend on the official RoonLabs GitHub
  repos via git dependencies. Do **not** vendor `.tgz` tarballs or download
  release archives in the Docker build; build from source.
- **GitHub Pages site** (`docs/`) explaining the project, iOS Shortcuts setup,
  and Docker commands — build this **last**.

## Architecture

```
src/
  index.js            Entry point: chdir to DATA_DIR, wire Roon + server together
  config.js           Env-driven config (PORT, DATA_DIR, PUBLIC_BASE_URL, ...)
  genres.js           Preset genre definitions (any/pop-rock/metal/jazz/electronic/trip-hop)
  roon/
    roonManager.js    RoonApi lifecycle: pairing, zones, status, settings service
    browseClient.js   Thin promisified wrapper over RoonApiBrowse (browse/load)
    albumPlayer.js    Pure-ish logic: find + play a random album by genre (testable)
    settingsLayout.js RoonApiSettings layout (dropdown + zone) -> creates webhooks
  db/
    database.js       SQLite via built-in node:sqlite; schema/migrations; path in DATA_DIR
    webhooks.js       CRUD for webhook rows
  server/
    app.js            Express app factory (injected deps -> testable)
    routes/
      webhooks.js     Dynamic trigger endpoints (GET, so Shortcuts "Get Contents of URL" works)
      api.js          REST API used by the PWA
      health.js       /healthz
public/               The PWA (static): index.html, app.js, styles.css,
                      manifest.webmanifest, service-worker.js, icons/
test/                 Unit + integration tests (node:test)
docs/                 GitHub Pages site (built LAST)
```

### Key design rules

- **Roon is injected, never imported directly by tests.** `albumPlayer` and the
  server talk to a `browseClient`/`roonManager` interface. Tests pass a **mock
  browse tree**, so the whole album-selection + playback flow is testable with no
  real Core. This is how we guarantee "no regressions" without hardware.
- **Webhook triggers are `GET`** — iOS Shortcuts' "Get Contents of URL" defaults
  to GET, and the owner's flow uses GET. Keep them GET and side-effecting but
  idempotent-enough (each hit plays a fresh random album).
- **Config/paths:** `node-roon-api` persists its pairing to `config.json` in the
  **process working directory**. `src/index.js` therefore `chdir`s to `DATA_DIR`
  (default `./data`, `/data` in Docker) so both `config.json` and the SQLite file
  live on the mounted volume and survive container restarts.

## Roon API ground truth (verified against source)

Packages (git deps, versions seen): `node-roon-api@1.2.3`,
`node-roon-api-browse@1.0.0`, `node-roon-api-transport@2.0.1`,
`node-roon-api-settings@1.0.0`, `node-roon-api-status@1.0.0`.

- **Pairing:** `new RoonApi({ ...meta, core_paired(core){}, core_unpaired(core){} })`.
  After pairing, services are on `core.services.RoonApiTransport` /
  `core.services.RoonApiBrowse`. Then `roon.init_services({ required_services:
  [RoonApiBrowse, RoonApiTransport], provided_services: [svc_status, svc_settings] })`
  and `roon.start_discovery()`. (The owner's `on_service_registered` sample was
  **not** a real API — do not use it.)
- **Zones:** `transport.subscribe_zones(cb)` and `transport.get_zones(cb)`. Zones
  carry `zone_id`, `display_name`, `state` (`playing`/`paused`/`loading`/`stopped`),
  and `outputs[]` with `output_id`.
- **Browse:** `browse(opts, cb)` / `load(opts, cb)`, callback is
  `(err, body)` where `err` is `false` on success. Use `hierarchy: "browse"`,
  `pop_all: true` to start at root, and a per-request **`multi_session_key`** so
  concurrent webhook hits don't clobber each other's browse state. `browse` result
  `body.action` is `"list"|"message"|"none"|...`; a list has `body.list.count`.
  `load({ offset, count })` returns `body.items[]` (each with `item_key`, `title`,
  `hint`). Playback requires `zone_or_output_id` on the browse calls in the play chain.
- **Play sequence (random album by genre):** the confirmed path (from
  `RoonLabs`/`TheAppgineer/roon-extension-random-radio` + `RoonCommandLine`) is
  `['Genres', '<genre>', 'Albums', <random album>, 'Play Album', 'Play Now']`.
  "Play Now" is **nested under a "Play Album" action-list** for albums — it is NOT
  a direct action (the owner's sample got this wrong). Navigate down using
  `item_key` (no zone); on the **final `browse()` of the "Play Now" item, set
  `zone_or_output_id`** — that call starts playback. For "any album" the path is
  `['Library', 'Albums', <random>, 'Play Album', 'Play Now']` (a track variant
  `['Library','Tracks', <random>,'Play Now']` has Play Now direct). Randomness =
  pick a random `offset` in `[0, list.count)` at the album-list level, then
  `load({offset, count:1})`. `albumPlayer.js` implements this as a generic
  **path-walker** with `''` = "accept a random item at this level", mirroring the
  reference `random-radio.js` algorithm, plus a fallback that enters
  `Play Album`/`Play`/any `action_list` when "Play Now" isn't a direct child.
  Every browse/load call carries a per-request **`multi_session_key`** so
  concurrent webhook hits don't corrupt each other's browse stack.
- **Settings layout:** `RoonApiSettings(roon, { get_settings, save_settings,
  button_pressed })`. `get_settings(cb)` returns `{ values, layout, has_error }`.
  Layout widget types include `label`, `string`, `integer`, `dropdown`
  (`{ type, title, setting, values:[{title,value}] }`), `zone`
  (`{ type:"zone", title, setting }`), and `group`. `save_settings(req, is_dry_run,
  settings)`: on a real (non-dry-run) save, validate then
  `svc_settings.update_settings(layout)` and `roon.save_config("settings", values)`.
  Roon calls `save_settings` with `is_dry_run=true` on every keystroke — only
  persist/`update_settings` when `is_dry_run` is false and there are no errors.
  **Roon settings `label`/`status` widgets render plain text only — no clickable
  links.** So the dashboard URL is shown as copyable plain text in a `label`.
- **Status:** `svc_status.set_status(message, is_error)`.

## Genres

Roon uses TiVo/AllMusic-derived genres, so a preset is a friendly label plus a
list of **candidate genre paths** to try (case-insensitive, exact title match on
each level of the `Genres` browser):

- Pop/Rock → `["Pop/Rock"]` (literal slash)
- Metal → `["Metal"]`, then `["Heavy Metal"]` (AllMusic top-level is "Heavy Metal")
- Jazz → `["Jazz"]`
- Electronic → `["Electronic"]`
- Trip-Hop → `["Trip-Hop"]`, then `["Electronic", "Trip-Hop"]` (it's a **subgenre
  under Electronic**, hyphenated)

Genre lookup scans the `Genres` list for the first path level; if not found it
tries the next candidate path (which may drill through a parent). The `Genres`
list only shows genres that actually have library content, so a missing genre
fails gracefully with a clear message. Genre strings are **data, not hardcoded
logic** — users add any genre/path their library has via the dropdown or PWA.

## Commands

```bash
npm install            # installs git-based Roon deps + express + better-sqlite3
npm test               # runs the full node:test suite (must stay green)
npm start              # runs the extension (needs a Roon Core on the LAN)
docker compose up -d   # containerised install
```

## Working agreements

- Do the heavy implementation via **agent workers**, one cohesive module set per
  worker; the lead runs tests and integrates between phases.
- Never break a green test. Add tests with every behavioural change.
- Prefer git dependencies on the official Roon repos; never commit tarballs.
- Keep secrets/PII out of commits. The extension needs no cloud credentials.
