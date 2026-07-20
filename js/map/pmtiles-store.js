import { get, put } from "../lib/idb.js";

// Le fond de carte (assets/map.pmtiles, 60+ Mo) vit en IndexedDB, comme le
// reste des donnees locales de l'appli -- PAS en OPFS (essaye en premier,
// abandonne : navigator.storage.getDirectory()/createWritable() se sont
// reveles indisponibles ou non-fiables sur au moins un appareil de test reel,
// alors qu'IndexedDB fonctionne deja partout dans cette appli, y compris pour
// des volumes comparables comme les ~45k entrees BAN). Un Blob stocke en
// IndexedDB reste gere par le moteur du navigateur comme une reference
// disque, pas charge entierement en memoire JS -- .slice().arrayBuffer()
// (utilise par pmtiles.js pour lire des tranches d'octets pendant le
// pan/zoom) ne lit que la portion demandee, meme depuis IndexedDB.
function moduleRelativeUrl(relativePath) {
  return new URL(relativePath, import.meta.url).href;
}

// Retourne le Blob deja telecharge, ou null si absent (pas encore importe,
// ou navigateur sans le fichier).
export async function getMapFile(db) {
  const meta = await get(db, "mapMeta", "current");
  return meta?.file ?? null;
}

// Telecharge assets/map.pmtiles avec suivi de progression (Content-Length).
// Accumule en Blob en memoire pendant le fetch (~60 Mo, tient confortablement
// en memoire mobile moderne) avant d'etre remis a l'appelant pour stockage.
async function downloadMapPmtiles(onProgress) {
  const url = moduleRelativeUrl("../../assets/map.pmtiles");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossible de charger ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body || !total) {
    // Repli sans progression detaillee (ex: reponse compressee par le
    // serveur, Content-Length absent) -- rare en local mais ne doit pas
    // bloquer l'import.
    const blob = await res.blob();
    onProgress?.(blob.size, blob.size);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  return new Blob(chunks);
}

// Verifie si le fond de carte deja stocke correspond a mapVersion (hash du
// manifest, voir tools/gen-data-manifest.js), et le (re)telecharge sinon.
// mapVersion peut etre null (assets/map.pmtiles absent du build -- chantier C
// non deploye) : dans ce cas on ne fait rien, la carte reste simplement
// indisponible plutot que de faire echouer tout l'import.
export async function ensureMapDownloaded(db, mapVersion, onProgress) {
  if (!mapVersion) return;

  const meta = await get(db, "mapMeta", "current");
  if (meta && meta.version === mapVersion && meta.file) return; // deja a jour et present

  onProgress?.({ phase: "map", label: "Téléchargement du fond de carte…", done: 0, total: 0 });
  const blob = await downloadMapPmtiles((done, total) => {
    // done/total en Mo (arrondis) plutot qu'en octets bruts : la barre de
    // progression (import-ui.js) affiche directement `${done} / ${total}`
    // sous le label, doit rester lisible.
    const doneMb = Math.round(done / 1e6);
    const totalMb = Math.round(total / 1e6);
    onProgress?.({
      phase: "map",
      label: `Téléchargement du fond de carte… (${doneMb} / ${totalMb} Mo)`,
      done: doneMb,
      total: totalMb,
    });
  });
  await put(db, "mapMeta", { key: "current", version: mapVersion, byteLength: blob.size, file: blob });
}
