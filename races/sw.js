
const CACHE = "race-planner-20261125204011";
const ASSETS = ["./conghua100-2026.html", "./index.html", "./vendor/html2canvas.min.js", "./vendor/leaflet/images/layers-2x.png", "./vendor/leaflet/images/layers.png", "./vendor/leaflet/images/marker-icon-2x.png", "./vendor/leaflet/images/marker-icon.png", "./vendor/leaflet/images/marker-shadow.png", "./vendor/leaflet/leaflet.css", "./vendor/leaflet/leaflet.js"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return resp;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
