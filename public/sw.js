// Keeps the page itself available without signal. Data comes from /api and is
// kept on the phone by app.js, so this only caches the page files.

// Bump on every change to the page files, so open pages reload with the new version (see app.js).
const CACHE = "madplan-v8";
const FILES = ["/", "/app.css", "/app.js", "/fonts/fredoka-500.woff2", "/fonts/fredoka-600.woff2", "/fonts/nunito-600.woff2", "/fonts/nunito-700.woff2", "/fonts/nunito-800.woff2"];

self.addEventListener("install", (event) => {
  // Past the browser's HTTP cache, so a new version never starts with old files.
  const fresh = FILES.map((file) => new Request(file, { cache: "reload" }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Serve from the cache at once, and refresh the cache from the network for next time.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const key = event.request.mode === "navigate" ? "/" : event.request;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(key, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
