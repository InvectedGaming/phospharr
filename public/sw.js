/* Phospharr service worker — offline app shell + installability.
 *
 * Deliberately conservative: it ONLY caches the static shell (HTML/JS/icons).
 * Live media (/stream, /watch, share + tuner exports) and the API are never
 * intercepted, so streaming and auth behave exactly as without a SW.
 */
const CACHE = "phospharr-shell-v1";
const SHELL = ["/", "/app.js", "/vendor/mpegts.js", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Never touch live media, API, or auth/token-scoped routes — let the network
  // handle them untouched so streaming and sessions work normally.
  const p = url.pathname;
  if (
    p.startsWith("/api/") || p.startsWith("/stream") || p.startsWith("/watch") ||
    p.startsWith("/share") || p.startsWith("/s/") || p.startsWith("/t/") ||
    p.startsWith("/discover") || p.startsWith("/lineup") ||
    p.endsWith(".m3u") || p.endsWith(".xml")
  ) return;

  // App shell + static assets: network-first (updates land immediately), with a
  // cache fallback so the shell still loads offline.
  const isShell = req.mode === "navigate" || SHELL.includes(p) || p.startsWith("/vendor/") || p.startsWith("/icon");
  if (!isShell) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match("/"))),
  );
});
