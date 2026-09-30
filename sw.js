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
const SW_BUILD = 161;

// Le nom du cache ne depend QUE de SW_BUILD : l'activation le connait sans
// relire le manifeste sur le reseau. Avant, un manifeste illisible pendant une
// mise a jour (reseau qui coupe) faisait installer un "shell de secours" de 5
// fichiers, et l'activation pouvait alors effacer le cache complet -- l'appli
// perdait son fonctionnement hors ligne.
const CACHE_ACTIF = `tournee-ups-b${SW_BUILD}`;
const CLE_EMPREINTES = "./__empreintes.json";

// ?b= : cle de cache propre a ce build cote CDN de GitHub Pages (max-age=600)
// -- sinon un serveur relais peut encore servir l'ANCIEN manifeste pendant
// 10 minutes apres la mise en ligne.
async function loadManifest() {
  const res = await fetch(`./precache-manifest.json?b=${SW_BUILD}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`manifeste HTTP ${res.status}`);
  return res.json();
}

async function empreinte(buffer) {
  const d = await crypto.subtle.digest("SHA-1", buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

// 3 essais par fichier, jamais le cache HTTP du navigateur, et une cle propre
// a cette version cote CDN (voir loadManifest) : un fichier modifie arrive
// toujours frais.
async function telecharger(url, version) {
  let derniere = null;
  for (let essai = 0; essai < 3; essai++) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const res = await fetch(`${url}${sep}v=${version}`, { cache: "reload" });
      if (res.ok) return res;
      derniere = new Error(`HTTP ${res.status}`);
    } catch (err) {
      derniere = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (essai + 1)));
  }
  throw new Error(`${url} : ${derniere?.message || derniere}`);
}

// Mise a jour DIFFERENTIELLE (retour terrain 2026-09-30 "le 160 arrive pas") :
// avant, chaque build retelechargeait les ~17 Mo de l'appli en tout-ou-rien
// (cache.addAll) -- dont 13 Mo de Tesseract qui ne changent jamais. En 4G, en
// tournee, un seul fichier rate et l'installation echouait sans rien dire.
// Desormais un fichier dont l'empreinte (manifest.files) n'a pas change est
// recopie depuis un cache deja installe ; seuls les fichiers modifies passent
// par le reseau. Un cache d'avant ce mecanisme n'a pas d'empreintes : ses
// fichiers sont alors hashes sur place (un ecart, par ex. de fins de ligne,
// ne fait que retelecharger le fichier -- jamais d'echec).
async function installerDifferentiel(manifest) {
  const cache = await caches.open(CACHE_ACTIF);
  const attendues = manifest.files || {};
  const sources = [];
  for (const nom of await caches.keys()) {
    if (!nom.startsWith("tournee-ups-") || nom === CACHE_ACTIF) continue;
    const c = await caches.open(nom);
    const r = await c.match(CLE_EMPREINTES);
    sources.push({ cache: c, empreintes: r ? await r.json().catch(() => null) : null });
  }

  const aTelecharger = [];
  let recopies = 0;
  for (const url of manifest.assets) {
    const attendue = attendues[url];
    let reprise = null;
    if (attendue) {
      for (const s of sources) {
        const r = await s.cache.match(url);
        if (!r) continue;
        const connue = s.empreintes ? s.empreintes[url] : await empreinte(await r.clone().arrayBuffer());
        if (connue === attendue) {
          reprise = r;
          break;
        }
      }
    }
    if (reprise) {
      await cache.put(url, reprise);
      recopies++;
    } else {
      aTelecharger.push(url);
    }
  }

  // 4 telechargements en parallele : assez pour ne pas trainer, sans saturer
  // une connexion mobile faible.
  let i = 0;
  const ouvrier = async () => {
    while (i < aTelecharger.length) {
      const url = aTelecharger[i++];
      await cache.put(url, await telecharger(url, manifest.version));
    }
  };
  await Promise.all([ouvrier(), ouvrier(), ouvrier(), ouvrier()]);

  // Ecrites en DERNIER : un cache sans empreintes = installation pas finie.
  await cache.put(CLE_EMPREINTES, new Response(JSON.stringify(attendues), { headers: { "Content-Type": "application/json" } }));
  return { recopies, telecharges: aTelecharger.length };
}

// Une installation ratee est normalement invisible (l'ancienne version reste
// simplement en place) : on la consigne dans le journal "Signaler un bug" des
// Reglages pour pouvoir la diagnostiquer a distance. Jamais de creation de
// base : si elle n'existe pas encore, on n'ecrit rien.
async function consignerEchec(err) {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("delivery-tour");
      req.onupgradeneeded = () => req.transaction.abort();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (db.objectStoreNames.contains("bugReports")) {
      await new Promise((resolve) => {
        const tx = db.transaction("bugReports", "readwrite");
        tx.objectStore("bugReports").put({
          id: `sw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          date: new Date().toISOString(),
          type: "auto",
          message: `Mise à jour vers le build ${SW_BUILD} non installée : ${err?.message || err}`,
          context: "sw.js install",
          stack: err?.stack ? String(err.stack).slice(0, 4000) : null,
          ecran: "mise à jour",
        });
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      });
    }
    db.close();
  } catch {
    // Journal indisponible : rien de plus a faire, l'ancienne version reste.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const manifest = await loadManifest();
        await installerDifferentiel(manifest);
        self.skipWaiting();
      } catch (err) {
        await consignerEchec(err);
        throw err;
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("tournee-ups-") && name !== CACHE_ACTIF)
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
