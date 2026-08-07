// Shell cache so a cold launch works with no signal (the sideline case).
// ponytail: stale-while-revalidate — cached shell renders instantly, the update
// is fetched in the background and lands on the *next* launch. /api/* never
// touches this cache; sync stays network-only and authoritative.
const CACHE = "sideline-shell-v15";
// Every file the app needs to render offline. Adding a new <link>/<script> to
// index.html means adding it here too, or the cold offline launch breaks.
const SHELL = ["/", "/app.css", "/app.js", "/lineup-core.js", "/state.js", "/stats.js", "/outbox.js", "/drills.js", "/diagram.js", "/icon.png", "/manifest.webmanifest"];

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

/* ---------- push: the period alarm for a locked phone ----------
   The push carries no payload — VAPID-only sends skip the whole encryption
   layer, so the text is fixed here. iOS revokes a subscription that receives a
   push without showing a notification, so this always shows one. */
self.addEventListener("push", (e) => {
  e.waitUntil(
    self.registration.showNotification("⏱ Period over", {
      body: "Tap to open Sideline and start the next one.",
      icon: "/icon.png",
      badge: "/icon.png",
      tag: "period-end",        // a re-send replaces rather than stacks
      renotify: true,
      requireInteraction: true, // stays on the wrist until acknowledged
      vibrate: [400, 150, 400, 150, 700],
    })
  );
});

// Focus the open app if there is one, otherwise launch it.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) return c.focus();
    }
    return clients.openWindow("/#p=game");
  })());
});
