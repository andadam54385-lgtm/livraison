// Service worker cache-first. La liste des assets a precacher est generee par
// tools/gen-precache-manifest.js (execute en local, jamais au runtime) et ecrite
// dans precache-manifest.json, qui contient aussi un hash de version pour
// invalider le cache quand le contenu change.
//
// IMPORTANT : les navigateurs ne detectent une mise a jour du service worker
// qu'en comparant les OCTETS de ce fichier sw.js lui-meme -- pas ceux des
// fichiers qu'il precache. Toute correction qui doit atteindre les appareils
// ayant deja installe une version anterieure DOIT donc modifier ce fichier
// (ex: incrementer SW_BUILD ci-dessous), meme si le bug corrige se trouve
// ailleurs. Sans ca, le service worker reste bloque sur son ancien cache.
const SW_BUILD = 35;

const FALLBACK_ASSETS = ["./", "./index.html", "./manifest.webmanifest", "./css/app.css", "./js/app.js"];

async function loadManifest() {
  try {
    const res = await fetch("./precache-manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("[sw] precache-manifest.json indisponible, fallback shell minimal:", err);
    return { version: "fallback", assets: FALLBACK_ASSETS };
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const manifest = await loadManifest();
      const cache = await caches.open(`tournee-ups-${manifest.version}`);
      await cache.addAll(manifest.assets);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const manifest = await loadManifest();
      const activeCacheName = `tournee-ups-${manifest.version}`;
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("tournee-ups-") && name !== activeCacheName)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;

      try {
        const response = await fetch(event.request);
        return response;
      } catch (err) {
        return new Response("Ressource indisponible hors ligne.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    })()
  );
});
