/* MusicD Shortcuts — service worker. Cache-first app shell, network for API. */
"use strict";

var CACHE = "musicd-shortcuts-v1";
var SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // addAll is atomic; use individual puts so one missing asset won't abort install.
      return Promise.all(
        SHELL.map(function (url) {
          return fetch(url, { cache: "no-cache" })
            .then(function (res) { if (res && res.ok) return cache.put(url, res); })
            .catch(function () { /* ignore individual failures */ });
        })
      );
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (k) { if (k !== CACHE) return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API or webhook-trigger calls — always go to the network.
  if (url.pathname.indexOf("/api/") === 0 ||
      url.pathname.indexOf("/w/") === 0 ||
      url.pathname === "/random-album" ||
      url.pathname === "/healthz") {
    return; // default browser handling (network)
  }

  // App shell: cache-first, fall back to network, then to cached index for navigations.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        if (req.mode === "navigate") return caches.match("/index.html");
        return Response.error();
      });
    })
  );
});
