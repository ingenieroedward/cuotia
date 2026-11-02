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

// Phone notifications. The payload is encrypted end to end; it only carries a short title, text and the panel path to open.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* a plain-text push still shows something */ }
  event.waitUntil(self.registration.showNotification(String(data.title || "Cuotia"), {
    body: String(data.body || ""), tag: data.tag ? String(data.tag) : undefined,
    icon: "/static/icons/icon-192.png", badge: "/static/icons/icon-192.png",
    data: { url: String(data.url || "/panel").startsWith("/") ? String(data.url || "/panel") : "/panel" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const asked = String(event.notification.data?.url || "/panel");
  // "@resident/pagar": the resident's own link (saved on their phone when they turned notifications on) plus a subpage.
  const resolve = asked.startsWith("@resident")
    ? caches.open("resident-link").then((c) => c.match("/resident-link")).then((r) => (r ? r.text() : "/")).then((base) => base + asked.slice("@resident".length)).catch(() => "/")
    : Promise.resolve(asked);
  event.waitUntil(resolve.then((path) => new URL(path, self.location.origin).href).then((target) => self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const open = windows.find((w) => w.url.startsWith(self.location.origin) && "focus" in w);
    return open ? open.focus().then((w) => w.navigate?.(target)) : self.clients.openWindow(target);
  })));
});
