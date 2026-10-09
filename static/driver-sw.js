const CACHE = "nexus-driver-v22";
const SHELL = [
  "/driver/",
  "/static/css/driver.css?v=20",
  "/static/js/driver-app.js?v=21",
  "/static/driver-manifest.json",
  "/static/brand/nexus-logo.webp",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];
// Internet "bor, lekin ishlamaydi" bo‘lsa sahifa osilib qolmasin — keshdagi nusxa ochiladi
const NET_WAIT_MS = 6000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => cache.addAll(SHELL.slice(0, 5))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

function fromCache(req) {
  if (req.mode === "navigate") {
    return caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("/driver/"));
  }
  return caches.match(req);
}

function networkFirst(req, shouldCache) {
  const net = fetch(req).then((res) => {
    if (res.ok && shouldCache) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
  const timed = new Promise((resolve) => {
    setTimeout(() => fromCache(req).then((hit) => hit && resolve(hit)), NET_WAIT_MS);
  });
  return Promise.race([net.catch(() => fromCache(req).then((hit) => hit || Promise.reject(new Error("offline")))), timed]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isApi = url.pathname.startsWith("/api/");
  const isTile = url.hostname.includes("tile.openstreetmap.org");
  if (isApi) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && url.pathname.includes("/driver/")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }
  if (isTile) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      })
    );
    return;
  }
  event.respondWith(networkFirst(req, url.origin === location.origin || url.hostname.includes("unpkg.com")));
});
