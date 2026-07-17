'use strict';

const { PRESETS, parseGenres, splitGenreInput, clampCount, MAX_ALBUM_COUNT } = require('../genres');

/**
 * Human-friendly name for a generated webhook.
 * @param {number} count number of albums
 * @param {string|null} label genre label, or null for any genre
 * @returns {string}
 */
function webhookName(count, label) {
  if (count > 1) return label ? `${count} Random ${label} Albums` : `${count} Random Albums`;
  return label ? `Random ${label}` : 'Random Album';
}

/**
 * Plain-text status for the software-update section.
 * @param {object} config
 * @param {object|null} lastUpdate result stored from the last manual check
 * @returns {string}
 */
function updateStatusText(config, lastUpdate) {
  const pinned = (lastUpdate && lastUpdate.pinned) || versionLine(config.VERSION);
  const line = `Installed version: v${config.VERSION} (pinned to ${pinned})`;
  if (!lastUpdate) {
    return `${line}\nNot checked yet — choose "Check now" above and Save.`;
  }
  if (lastUpdate.checking) {
    return `${line}\nChecking for updates…`;
  }
  if (lastUpdate.error) {
    return `${line}\nLast check failed: ${lastUpdate.error}`;
  }
  if (lastUpdate.updateAvailable) {
    return (
      `${line}\nUpdate available: v${lastUpdate.latest}. Redeploy the container ` +
      `(e.g. docker compose pull && docker compose up -d) to update — your ` +
      `pairing and webhooks are kept, and it stays the same extension in Roon.`
    );
  }
  let msg = `${line}\nUp to date (latest in ${pinned}: v${lastUpdate.latest}).`;
  if (lastUpdate.newerLineAvailable && lastUpdate.remote) {
    msg += ` A newer line (v${lastUpdate.remote}) exists — still pinned to ${pinned}.`;
  }
  return msg;
}

/** "1.0.0" -> "1.0.x" */
function versionLine(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)\./);
  return m ? `${m[1]}.${m[2]}.x` : version;
}

/**
 * Normalize a Roon `zone` widget value to a plain id string. Roon may store the
 * widget value as a bare id string OR as a `{ output_id, zone_id, name }` object
 * depending on the build; the rest of the app (and the SQLite bindings) require a
 * string or null.
 * @param {string|object|null|undefined} val
 * @returns {string|null}
 */
function zoneWidgetToId(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return val.output_id || val.zone_id || val.id || null;
  return null;
}

/**
 * Build the settings layout object shown in Roon's extension settings.
 * @param {object} settings the current settings `values` object
 * @param {{webhooksRepo:object, config:object, getZones:Function}} ctx
 * @returns {object} a Roon settings layout
 */
function buildLayout(settings, { webhooksRepo, config, lastUpdate }) {
  const values = Object.assign({ count: 1 }, settings || {});

  // Existing webhooks listing (plain text — Roon labels can't hyperlink).
  let existing;
  try {
    existing = webhooksRepo.list();
  } catch {
    existing = [];
  }
  const listText = existing.length
    ? existing.map((w) => `• ${w.name}: ${w.url}`).join('\n')
    : 'No webhooks yet.';
  const presetNames = PRESETS.filter((p) => p.genrePath).map((p) => p.label).join(', ');

  return {
    values,
    layout: [
      {
        type: 'group',
        title: 'Create a shortcut webhook',
        items: [
          {
            type: 'string',
            title: 'Genres (comma-separated — leave blank for any genre)',
            setting: 'genres',
          },
          {
            type: 'integer',
            title: 'Number of albums to play',
            setting: 'count',
            min: 1,
            max: MAX_ALBUM_COUNT,
          },
          {
            type: 'zone',
            title: 'Target zone',
            setting: 'defaultZone',
          },
        ],
      },
      {
        type: 'label',
        title:
          `Separate multiple genres with a COMMA, e.g. "Metal, Electronic" (each ` +
          `album is drawn from a random one). A genre that contains "&" — like ` +
          `"Drum & Bass" or "R&B" — counts as ONE genre. Presets: ${presetNames}. ` +
          `For a subgenre, use "Parent > Child", e.g. "Pop/Rock > Heavy Metal". ` +
          `Leave blank for any genre. Set the count for a multi-album queue, then ` +
          `Save to create the webhook.`,
      },
      {
        type: 'label',
        title: `Dashboard (open in a browser): ${config.PUBLIC_BASE_URL}/`,
      },
      {
        type: 'label',
        title: `Your webhooks:\n${listText}`,
      },
      {
        type: 'group',
        title: 'Software update',
        items: [
          {
            type: 'dropdown',
            title: 'Check for a new version',
            setting: 'updateCheck',
            values: [
              { title: '—', value: '' },
              { title: 'Check now (then Save)', value: 'check' },
            ],
          },
          {
            type: 'label',
            title: updateStatusText(config, lastUpdate),
          },
        ],
      },
    ],
    has_error: false,
  };
}

/**
 * Create the RoonApiSettings service. `roon` is the RoonApi instance and
 * `RoonApiSettings` is the constructor (injected so tests need not load it).
 *
 * @param {object} roon RoonApi instance (provides save_config/load_config)
 * @param {object} ctx
 * @param {Function} ctx.RoonApiSettings constructor
 * @param {object} ctx.webhooksRepo
 * @param {object} ctx.config
 * @param {Function} ctx.getZones () => zones
 * @param {Function} [ctx.saveConfig] (values) => void
 * @param {Function} [ctx.loadConfig] () => values
 * @param {Function} [ctx.onDefaultZone] (zoneId) => void  called when a zone is chosen
 * @returns {{service:object}} the settings service + handle to update layout
 */
function makeSettingsService(roon, ctx) {
  const {
    RoonApiSettings,
    webhooksRepo,
    config,
    getZones,
    saveConfig,
    loadConfig,
    onDefaultZone,
    checkForUpdate,
  } = ctx;

  const load = () => {
    if (typeof loadConfig === 'function') return loadConfig() || {};
    if (roon && typeof roon.load_config === 'function') return roon.load_config('settings') || {};
    return {};
  };
  const persist = (values) => {
    if (typeof saveConfig === 'function') return saveConfig(values);
    if (roon && typeof roon.save_config === 'function') return roon.save_config('settings', values);
    return undefined;
  };

  // Result of the last MANUAL update check (persisted so it survives restarts).
  let lastUpdate = null;
  try {
    if (roon && typeof roon.load_config === 'function') lastUpdate = roon.load_config('updateResult') || null;
  } catch {
    lastUpdate = null;
  }
  const layoutCtx = () => ({ webhooksRepo, config, getZones, lastUpdate });
  const pushLayout = (values) => {
    if (svc && typeof svc.update_settings === 'function') {
      svc.update_settings(buildLayout(values, layoutCtx()));
    }
  };

  let svc;
  let lastSavedValues = load();

  const getSettings = (cb) => {
    lastSavedValues = load();
    cb(buildLayout(lastSavedValues, layoutCtx()));
  };

  const saveSettings = (req, isDryRun, settings) => {
    const incoming = (settings && settings.values) || {};
    const layout = buildLayout(incoming, layoutCtx());
    const hasError = !!layout.has_error;

    req.send_complete(hasError ? 'NotValid' : 'Success', { settings: layout });

    if (isDryRun || hasError) return;

    // Real save: create a webhook when the user configured genres or a
    // multi-album count. ("Any genre, 1 album" already exists as a preset.)
    const genresStr = (incoming.genres || '').trim();
    const count = clampCount(incoming.count);
    const zoneId = zoneWidgetToId(incoming.defaultZone);

    if (genresStr || count > 1) {
      // Split on comma/newline only, so "Drum & Bass" stays a single genre.
      const names = genresStr ? splitGenreInput(genresStr) : [];
      const label = names.length ? names.join(', ') : null;
      webhooksRepo.create({
        name: webhookName(count, label),
        genre: label,
        genreNames: names.length ? names : null,
        genres: names.length ? parseGenres(names) : null,
        count,
        zoneId,
        zoneName: null,
      });
    }

    // Persist the chosen default zone.
    if (zoneId && typeof onDefaultZone === 'function') {
      onDefaultZone(zoneId);
    }

    // Did the operator ask for a manual update check?
    const wantsCheck = incoming.updateCheck === 'check' && typeof checkForUpdate === 'function';

    // Reset the create + check fields for the next save.
    const nextValues = { ...incoming, genres: '', count: 1, updateCheck: '' };
    lastSavedValues = nextValues;
    persist(nextValues);

    if (!wantsCheck) {
      pushLayout(nextValues);
      return;
    }

    // Run the check asynchronously; show "Checking…" now, the result when ready.
    lastUpdate = { checking: true, pinned: versionLine(config.VERSION) };
    pushLayout(nextValues);
    Promise.resolve()
      .then(() => checkForUpdate())
      .then((result) => {
        lastUpdate = result;
      })
      .catch((err) => {
        lastUpdate = { error: (err && err.message) || 'check failed', checkedAt: Date.now() };
      })
      .then(() => {
        try {
          if (roon && typeof roon.save_config === 'function') roon.save_config('updateResult', lastUpdate);
        } catch {
          /* ignore persistence errors */
        }
        pushLayout(nextValues);
      });
  };

  svc = new RoonApiSettings(roon, {
    get_settings: getSettings,
    save_settings: saveSettings,
    button_pressed: () => {},
  });

  return { service: svc, buildLayout: (v) => buildLayout(v, layoutCtx()) };
}

module.exports = { makeSettingsService, buildLayout };
