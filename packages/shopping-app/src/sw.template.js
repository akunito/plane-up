// PHASE 0 SPIKE. Filled in by the build (apps/web/vite.shopping.config.ts): the three quoted
// placeholders below are replaced with the cache version, the precache list and the scope path.
const VERSION = "__SW_VERSION__";
const ASSETS = "__SW_ASSETS__";
const SCOPE = "__SW_SCOPE__";
const CACHE = "shopping-stub-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("shopping-stub-") && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  // A launch from the icon and every in-scope navigation get the cached shell; the hash carries the route.
  if (req.mode === "navigate") {
    event.respondWith(caches.match(SCOPE, { cacheName: CACHE }).then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit || fetch(req)));
});

function kv(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("shopping-stub", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode);
      const out = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function recordSync(tag) {
  const entry = { at: Date.now(), tag, online: self.navigator.onLine, status: 0, clients: 0 };
  entry.clients = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).length;
  let failed = null;
  try {
    const res = await fetch("/api/instances/", { cache: "no-store" });
    entry.status = res.status;
  } catch (e) {
    failed = e;
    entry.status = -1;
  }
  const prev = (await kv("readonly", (s) => s.get("syncLog"))) || [];
  prev.push(entry);
  await kv("readwrite", (s) => s.put(prev.slice(-40), "syncLog"));
  // Rejecting tells the browser the sync did not finish, so it retries when it next sees a network.
  if (failed) throw failed;
}

self.addEventListener("sync", (event) => {
  event.waitUntil(recordSync(event.tag));
});

self.addEventListener("message", (event) => {
  if (event.data === "version" && event.source) event.source.postMessage({ version: VERSION, assets: ASSETS.length });
});
