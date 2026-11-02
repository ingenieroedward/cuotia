// Cuotia's service worker. It only does two harmless things: it makes the app installable and it keeps the look
// (styles, fonts, icons) when the connection drops. It NEVER stores a page: pages carry payments, names and personal
// links, so they always come from the server; with no connection a short "sin conexión" page is shown instead.
const CACHE = "cuotia-static-v1";
const ASSETS = [
  "/offline",
  "/static/app.css",
  "/static/app.js",
  "/static/fonts/plus-jakarta-sans-latin.woff2",
  "/static/fonts/plus-jakarta-sans-latin-ext.woff2",
  "/static/icons/icon.svg",
  "/static/icons/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("cuotia-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // payments, logins and every other form go straight to the network
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline")));
    return;
  }
  // Styles, script, fonts and icons: the network first (a new deploy shows at once), the saved copy when offline.
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
  }
});
