/* MusicD Shortcuts — PWA dashboard logic. Vanilla JS, no dependencies. */
(function () {
  "use strict";

  var STATUS_POLL_MS = 10000;

  var els = {
    statusPill: document.getElementById("status-pill"),
    statusText: document.getElementById("status-text"),
    webhooks: document.getElementById("webhooks"),
    refreshBtn: document.getElementById("refresh-btn"),
    form: document.getElementById("create-form"),
    name: document.getElementById("wh-name"),
    genre: document.getElementById("wh-genre"),
    customField: document.getElementById("custom-genre-field"),
    customGenre: document.getElementById("wh-genre-custom"),
    zone: document.getElementById("wh-zone"),
    zoneHint: document.getElementById("zone-hint"),
    createBtn: document.getElementById("create-btn"),
    formMsg: document.getElementById("form-msg"),
    toast: document.getElementById("toast")
  };

  // Cache of preset genrePath keyed by label, so POST can send genrePath too.
  var presetPaths = {};

  /* --- fetch helpers ----------------------------------------------------- */
  async function api(path, options) {
    var res = await fetch(path, Object.assign({ headers: { Accept: "application/json" } }, options));
    if (!res.ok) {
      var detail = "";
      try {
        var j = await res.json();
        detail = j && (j.error || j.message) ? (j.error || j.message) : "";
      } catch (e) { /* ignore */ }
      var err = new Error(detail || ("Request failed (" + res.status + ")"));
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /* --- status ------------------------------------------------------------ */
  async function loadStatus() {
    try {
      var s = await api("/api/status");
      if (s && s.paired) {
        setPill("ok", "Connected to " + (s.coreName || "Roon Core"));
      } else {
        setPill("warn", (s && s.message) || "Waiting for Roon Core…");
      }
    } catch (e) {
      setPill("warn", "Server unreachable");
    }
  }

  function setPill(kind, text) {
    els.statusPill.className = "pill pill--" + (kind === "ok" ? "ok" : "warn");
    els.statusText.textContent = text;
    els.statusText.title = text;
  }

  /* --- selectors --------------------------------------------------------- */
  async function loadPresets() {
    try {
      var data = await api("/api/genres/presets");
      var presets = (data && data.presets) || [];
      var opts = ['<option value="">Any album</option>'];
      presetPaths = {};
      presets.forEach(function (p) {
        if (!p || !p.label) return;
        // "Any Album" preset already covered by the default empty option.
        if (p.genrePath == null || (Array.isArray(p.genrePath) && p.genrePath.length === 0)) {
          presetPaths[""] = null;
          return;
        }
        presetPaths[p.label] = p.genrePath;
        opts.push('<option value="' + esc(p.label) + '">' + esc(p.label) + "</option>");
      });
      opts.push('<option value="__custom__">Custom genre…</option>');
      els.genre.innerHTML = opts.join("");
    } catch (e) {
      els.genre.innerHTML =
        '<option value="">Any album</option><option value="__custom__">Custom genre…</option>';
    }
  }

  async function loadZones() {
    try {
      var data = await api("/api/zones");
      var zones = (data && data.zones) || [];
      var opts = ['<option value="">Default zone (last active)</option>'];
      zones.forEach(function (z) {
        if (!z || !z.zoneId) return;
        opts.push('<option value="' + esc(z.zoneId) + '">' + esc(z.displayName || z.zoneId) + "</option>");
      });
      els.zone.innerHTML = opts.join("");
      els.zoneHint.textContent = zones.length
        ? "Where the album should play."
        : "No zones detected yet — “Default zone” plays to the last active zone.";
    } catch (e) {
      els.zone.innerHTML = '<option value="">Default zone (last active)</option>';
      els.zoneHint.textContent = "Couldn’t load zones — “Default zone” still works.";
    }
  }

  /* --- webhooks list ----------------------------------------------------- */
  async function loadWebhooks() {
    els.webhooks.setAttribute("aria-busy", "true");
    try {
      var data = await api("/api/webhooks");
      renderWebhooks((data && data.webhooks) || []);
    } catch (e) {
      els.webhooks.innerHTML =
        '<p class="empty empty--err">Couldn’t load webhooks. ' + esc(e.message) + "</p>";
    } finally {
      els.webhooks.setAttribute("aria-busy", "false");
    }
  }

  function renderWebhooks(list) {
    if (!list.length) {
      els.webhooks.innerHTML =
        '<p class="empty">No webhooks yet. Create your first one below.</p>';
      return;
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (w) { frag.appendChild(webhookCard(w)); });
    els.webhooks.innerHTML = "";
    els.webhooks.appendChild(frag);
  }

  function webhookCard(w) {
    var url = w.url || (location.origin + "/w/" + (w.slug || ""));
    var genreLabel = w.genre ? w.genre : "Any album";
    var zoneLabel = w.zoneName ? w.zoneName : "Default zone";

    var card = document.createElement("article");
    card.className = "card";

    var top = document.createElement("div");
    top.className = "card__top";
    var titleWrap = document.createElement("div");
    var title = document.createElement("div");
    title.className = "card__title";
    title.textContent = w.name || "Untitled";
    var tags = document.createElement("div");
    tags.className = "card__tags";
    tags.appendChild(makeTag(genreLabel, false));
    tags.appendChild(makeTag(zoneLabel, false));
    if (w.isPreset) tags.appendChild(makeTag("Preset", true));
    titleWrap.appendChild(title);
    titleWrap.appendChild(tags);
    top.appendChild(titleWrap);
    card.appendChild(top);

    var urlRow = document.createElement("div");
    urlRow.className = "url-row";
    var urlEl = document.createElement("code");
    urlEl.className = "url";
    urlEl.textContent = url;
    urlEl.title = url;
    urlRow.appendChild(urlEl);
    card.appendChild(urlRow);

    var actions = document.createElement("div");
    actions.className = "card__actions";

    var copyBtn = button("Copy URL", "btn btn--sm btn--grow");
    copyBtn.addEventListener("click", function () { copyUrl(url); });

    var testLink = document.createElement("a");
    testLink.className = "btn btn--sm btn--grow";
    testLink.textContent = "Test";
    testLink.href = url;
    testLink.target = "_blank";
    testLink.rel = "noopener";

    var delBtn = button("Delete", "btn btn--sm btn--danger");
    delBtn.addEventListener("click", function () { deleteWebhook(w, delBtn); });

    actions.appendChild(copyBtn);
    actions.appendChild(testLink);
    actions.appendChild(delBtn);
    card.appendChild(actions);

    return card;
  }

  function makeTag(text, isPreset) {
    var t = document.createElement("span");
    t.className = "tag" + (isPreset ? " tag--preset" : "");
    t.textContent = text;
    return t;
  }

  function button(label, cls) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    return b;
  }

  async function deleteWebhook(w, btn) {
    if (!window.confirm('Delete “' + (w.name || "this webhook") + '”?')) return;
    btn.disabled = true;
    try {
      await api("/api/webhooks/" + encodeURIComponent(w.id), { method: "DELETE" });
      showToast("Deleted");
      await loadWebhooks();
    } catch (e) {
      btn.disabled = false;
      showToast("Delete failed: " + e.message);
    }
  }

  /* --- create ------------------------------------------------------------ */
  function onGenreChange() {
    var custom = els.genre.value === "__custom__";
    els.customField.hidden = !custom;
    if (custom) els.customGenre.focus();
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    hideFormMsg();

    var name = els.name.value.trim();
    if (!name) { formMsg("err", "Please enter a name."); els.name.focus(); return; }

    var payload = { name: name };
    var sel = els.genre.value;
    if (sel === "__custom__") {
      var custom = els.customGenre.value.trim();
      if (!custom) { formMsg("err", "Enter a custom genre or pick another option."); els.customGenre.focus(); return; }
      payload.genre = custom;
      payload.genrePath = [[custom]];
    } else if (sel) {
      payload.genre = sel;
      if (presetPaths[sel]) payload.genrePath = presetPaths[sel];
    } // empty sel => any album, send nothing

    var zoneId = els.zone.value;
    if (zoneId) {
      payload.zoneId = zoneId;
      var zoneName = els.zone.options[els.zone.selectedIndex].textContent;
      if (zoneName) payload.zoneName = zoneName;
    }

    els.createBtn.disabled = true;
    els.createBtn.textContent = "Creating…";
    try {
      await api("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
      els.form.reset();
      els.customField.hidden = true;
      formMsg("ok", "Webhook created.");
      showToast("Webhook created");
      await loadWebhooks();
    } catch (e) {
      formMsg("err", "Couldn’t create webhook: " + e.message);
    } finally {
      els.createBtn.disabled = false;
      els.createBtn.textContent = "Create webhook";
    }
  }

  function formMsg(kind, text) {
    els.formMsg.hidden = false;
    els.formMsg.className = "form__msg form__msg--" + (kind === "ok" ? "ok" : "err");
    els.formMsg.textContent = text;
  }
  function hideFormMsg() { els.formMsg.hidden = true; els.formMsg.textContent = ""; }

  /* --- clipboard + toast ------------------------------------------------- */
  async function copyUrl(url) {
    var ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch (e) { /* fall through to legacy */ }
    if (!ok) ok = legacyCopy(url);
    showToast(ok ? "Copied!" : "Copy failed — long-press the URL to copy");
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  var toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    // force reflow so the transition runs even on repeat
    void els.toast.offsetWidth;
    els.toast.classList.add("toast--show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove("toast--show");
      setTimeout(function () { els.toast.hidden = true; }, 220);
    }, 2000);
  }

  /* --- utils ------------------------------------------------------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* --- service worker ---------------------------------------------------- */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("service-worker.js").catch(function () { /* offline shell optional */ });
    });
  }

  /* --- boot -------------------------------------------------------------- */
  function init() {
    els.genre.addEventListener("change", onGenreChange);
    els.form.addEventListener("submit", onSubmit);
    els.refreshBtn.addEventListener("click", function () { loadStatus(); loadWebhooks(); });

    loadStatus();
    loadPresets();
    loadZones();
    loadWebhooks();

    setInterval(loadStatus, STATUS_POLL_MS);
    registerSW();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
