// Shell cache so a cold launch works with no signal (the sideline case).
// ponytail: stale-while-revalidate — cached shell renders instantly, the update
// is fetched in the background and lands on the *next* launch. /api/* never
// touches this cache; sync stays network-only and authoritative.
const CACHE = "sideline-shell-v2";
// Every file the app needs to render offline. Adding a new <link>/<script> to
// index.html means adding it here too, or the cold offline launch breaks.
const SHELL = ["/", "/app.css", "/app.js", "/lineup-core.js", "/drills.js", "/diagram.js", "/icon.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // sync must never be served stale

  // Team links carry the token in the hash (#t=...), which never reaches the
  // network — so every navigation is just "/". Keyed explicitly to stay that way.
  const key = e.request.mode === "navigate" ? "/" : e.request;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    const fresh = fetch(e.request)
      .then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      })
      .catch(() => hit || Response.error());
    return hit || fresh;
  })());
});
