'use strict';

const { makeBrowseClient } = require('./browseClient');
const { makeSettingsService } = require('./settingsLayout');
const { buildGenreIndex, matchGenreName } = require('./genreIndex');
const { checkForUpdate } = require('../updateChecker');

/** How long a built live genre index stays fresh before a rebuild. */
const GENRE_INDEX_TTL_MS = 60 * 60 * 1000;

/**
 * Lazily require the node-roon-api packages. Kept out of module scope so tests
 * that inject a fake manager never load the real (native-discovery) modules.
 */
function loadRoonModules() {
  /* eslint-disable global-require */
  const RoonApi = require('node-roon-api');
  const RoonApiBrowse = require('node-roon-api-browse');
  const RoonApiTransport = require('node-roon-api-transport');
  const RoonApiSettings = require('node-roon-api-settings');
  const RoonApiStatus = require('node-roon-api-status');
  /* eslint-enable global-require */
  return { RoonApi, RoonApiBrowse, RoonApiTransport, RoonApiSettings, RoonApiStatus };
}

/** Convert a raw Roon zone to the app's camelCase shape. */
function toZoneJson(zone) {
  return {
    zoneId: zone.zone_id,
    displayName: zone.display_name,
    state: zone.state,
  };
}

class RoonManager {
  /**
   * @param {{config:object, webhooksRepo:object, onZonesChanged?:Function, roonModules?:object}} opts
   */
  constructor({ config, webhooksRepo, onZonesChanged, roonModules } = {}) {
    if (!config) throw new Error('RoonManager requires config');
    this.config = config;
    this.webhooksRepo = webhooksRepo;
    this.onZonesChanged = onZonesChanged;
    this._roonModules = roonModules || null; // allow injection

    this.roon = null;
    this.core = null;
    this.transport = null;
    this._browseClient = null;
    this.svcStatus = null;
    this.svcSettings = null;

    /** @type {Map<string, object>} zone_id -> raw zone */
    this._zones = new Map();
    this._defaultZoneId = null;

    // Cached live genre index (Phase 2).
    this._genreIndex = null;
    this._genreIndexAt = 0;

    // Restore a persisted default zone if available.
    try {
      const persisted = config && config.DEFAULT_ZONE_ID;
      if (persisted) this._defaultZoneId = persisted;
    } catch {
      /* ignore */
    }
  }

  /** Start Roon discovery and register services. */
  start() {
    const mods = this._roonModules || loadRoonModules();
    const { RoonApi, RoonApiBrowse, RoonApiTransport, RoonApiSettings, RoonApiStatus } = mods;

    this.roon = new RoonApi({
      extension_id: this.config.ROON_EXTENSION_ID,
      display_name: this.config.ROON_DISPLAY_NAME,
      display_version: this.config.ROON_DISPLAY_VERSION,
      publisher: this.config.ROON_PUBLISHER,
      email: this.config.ROON_EMAIL,
      website: this.config.ROON_WEBSITE,
      core_paired: (core) => this._onCorePaired(core),
      core_unpaired: (core) => this._onCoreUnpaired(core),
    });

    // Restore persisted default zone from Roon config if present.
    try {
      const saved = this.roon.load_config && this.roon.load_config('app');
      if (saved && saved.defaultZoneId) this._defaultZoneId = saved.defaultZoneId;
    } catch {
      /* ignore */
    }

    this.svcStatus = new RoonApiStatus(this.roon);

    const settings = makeSettingsService(this.roon, {
      RoonApiSettings,
      webhooksRepo: this.webhooksRepo,
      config: this.config,
      getZones: () => this.getZones(),
      onDefaultZone: (zoneId) => this.setDefaultZoneId(zoneId),
      checkForUpdate: () =>
        checkForUpdate({
          owner: this.config.GITHUB_OWNER,
          repo: this.config.GITHUB_REPO,
          branch: this.config.GITHUB_BRANCH,
          currentVersion: this.config.VERSION,
        }),
    });
    this.svcSettings = settings.service;

    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiBrowse],
      provided_services: [this.svcStatus, this.svcSettings],
    });

    this._setStatus('Waiting to be paired with your Roon Core…', false);
    this.roon.start_discovery();
    return this;
  }

  _onCorePaired(core) {
    this.core = core;
    this.transport = core.services.RoonApiTransport;
    this._browseClient = makeBrowseClient(core.services.RoonApiBrowse);

    this._setStatus(`Paired with ${core.display_name || 'Roon Core'}.`, false);

    if (this.transport && typeof this.transport.subscribe_zones === 'function') {
      this.transport.subscribe_zones((response, body) => this._onZones(response, body));
    }
  }

  _onCoreUnpaired() {
    this.core = null;
    this.transport = null;
    this._browseClient = null;
    this._zones.clear();
    // Drop the cached genre index; it rebuilds after re-pair.
    this._genreIndex = null;
    this._genreIndexAt = 0;
    this._setStatus('Roon Core unpaired.', true);
    if (typeof this.onZonesChanged === 'function') this.onZonesChanged(this.getZones());
  }

  _onZones(response, body) {
    if (!body) return;
    if (response === 'Subscribed') {
      this._zones.clear();
      for (const z of body.zones || []) this._zones.set(z.zone_id, z);
    } else if (response === 'Changed') {
      for (const z of body.zones_added || []) this._zones.set(z.zone_id, z);
      for (const z of body.zones_changed || []) this._zones.set(z.zone_id, z);
      for (const z of body.zones_removed || []) {
        // zones_removed may be ids or zone objects.
        const id = typeof z === 'string' ? z : z.zone_id;
        this._zones.delete(id);
      }
    }
    if (typeof this.onZonesChanged === 'function') this.onZonesChanged(this.getZones());
  }

  _setStatus(message, isError) {
    this._statusMessage = message;
    if (this.svcStatus && typeof this.svcStatus.set_status === 'function') {
      this.svcStatus.set_status(message, !!isError);
    }
  }

  /** @returns {boolean} */
  isPaired() {
    return !!this.core;
  }

  /** @returns {string|null} */
  getCoreName() {
    return this.core ? this.core.display_name || null : null;
  }

  /** @returns {string} current status message. */
  getStatusMessage() {
    return this._statusMessage || (this.isPaired() ? 'Paired.' : 'Not paired.');
  }

  /** @returns {Array<{zoneId:string,displayName:string,state:string}>} */
  getZones() {
    return Array.from(this._zones.values()).map(toZoneJson);
  }

  /**
   * @returns {string|null} the configured default zone, else first playing zone,
   * else the first zone, else null.
   */
  getDefaultZoneId() {
    if (this._defaultZoneId && this._zones.has(this._defaultZoneId)) return this._defaultZoneId;
    const zones = Array.from(this._zones.values());
    const playing = zones.find((z) => z.state === 'playing');
    if (playing) return playing.zone_id;
    if (zones.length) return zones[0].zone_id;
    // Fall back to the persisted id even if the zone isn't currently known.
    return this._defaultZoneId || null;
  }

  /**
   * Persist a default zone selection.
   * @param {string} zoneId
   */
  setDefaultZoneId(zoneId) {
    this._defaultZoneId = zoneId || null;
    try {
      if (this.roon && typeof this.roon.save_config === 'function') {
        this.roon.save_config('app', { defaultZoneId: this._defaultZoneId });
      }
    } catch {
      /* ignore persistence errors */
    }
  }

  /**
   * @param {object} opts
   * @returns {Promise<object>}
   */
  browse(opts) {
    if (!this._browseClient) return Promise.reject(new Error('No Roon Core paired'));
    return this._browseClient.browse(opts);
  }

  /**
   * @param {object} opts
   * @returns {Promise<object>}
   */
  load(opts) {
    if (!this._browseClient) return Promise.reject(new Error('No Roon Core paired'));
    return this._browseClient.load(opts);
  }

  /**
   * Return the live genre index, building (and caching, TTL 1h) it on demand.
   * Best-effort: never throws — on a build error it returns the last cached
   * index, or an empty one. Returns an empty index when not paired.
   * @returns {Promise<{genres:Array<{name:string,path:string[]}>, builtAt:number}>}
   */
  async getGenreIndex() {
    if (!this.isPaired()) return { genres: [], builtAt: 0 };
    const now = Date.now();
    if (this._genreIndex && now - this._genreIndexAt < GENRE_INDEX_TTL_MS) {
      return this._genreIndex;
    }
    try {
      const index = await buildGenreIndex(this, { maxDepth: 3 });
      this._genreIndex = index;
      this._genreIndexAt = Date.now();
      return index;
    } catch {
      return this._genreIndex || { genres: [], builtAt: 0 };
    }
  }

  /**
   * Best-effort resolution of a genre NAME to an exact library title-path via
   * the live index. Never throws; returns null when nothing matches.
   * @param {string} name
   * @returns {Promise<string[]|null>}
   */
  async resolveGenreName(name) {
    try {
      return matchGenreName(await this.getGenreIndex(), name);
    } catch {
      return null;
    }
  }
}

module.exports = { RoonManager, toZoneJson };
