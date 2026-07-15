import { getDb } from "../db/schema.js";
import { get, put, clear, bulkPutChunked } from "../lib/idb.js";
import { buildCsrFromRawGraph } from "../routing/graph-loader.js";

// Mode dev : ?fixtures=1 (persiste dans localStorage) charge les petites
// fixtures de test-fixtures/ au lieu des vrais graph.json/ban.json (6.5+ Mo).
function useFixtures() {
  const param = new URLSearchParams(location.search).get("fixtures");
  if (param === "1") localStorage.setItem("useTestFixtures", "1");
  if (param === "0") localStorage.removeItem("useTestFixtures");
  return localStorage.getItem("useTestFixtures") === "1";
}

// fetch() resout les chemins relatifs par rapport a la page (index.html),
// pas par rapport a ce module -- contrairement a import()/import.meta.url.
// Sur un hebergement a la racine (ex: localhost:8123/), les deux se
// confondent par coincidence ; sous GitHub Pages, servi depuis un
// sous-dossier (ex: /livraison/), ça diverge et fetch() 404. On force donc
// une resolution explicite relative a ce module via import.meta.url.
function moduleRelativeUrl(relativePath) {
  return new URL(relativePath, import.meta.url).href;
}

function assetUrls() {
  if (useFixtures()) {
    return {
      graph: moduleRelativeUrl("../../test-fixtures/mini-graph.json"),
      ban: moduleRelativeUrl("../../test-fixtures/mini-ban.json"),
      manifest: null,
      gzip: false,
    };
  }
  return {
    // Compresses (~3.6x pour le graphe, ~11.7x pour les adresses -- JSON
    // numerique/textuel tres repetitif) : necessaire pour rester sous la
    // limite de taille de fichier de GitHub sur une zone large. Genere par
    // tools/compress-assets.js, decompresse nativement ci-dessous.
    graph: moduleRelativeUrl("../../assets/graph.json.gz"),
    ban: moduleRelativeUrl("../../assets/ban.json.gz"),
    manifest: moduleRelativeUrl("../../assets/manifest-content.json"),
    gzip: true,
  };
}

// Pas d'option `cache` explicite : le service worker (cache-first, voir
// sw.js) intercepte deja ces requetes same-origin depuis son propre Cache
// Storage une fois installe -- forcer en plus le cache HTTP navigateur ici
// est redondant et peut echouer sur les tres gros fichiers (observe :
// ERR_CACHE_WRITE_FAILURE sur graph.json.gz avec `cache: "force-cache"`).
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossible de charger ${url} (HTTP ${res.status})`);
  return res.json();
}

// DecompressionStream est supporte nativement depuis Safari 16.4+ (dejà
// notre plancher iOS pour le WASM SIMD de Tesseract.js) -- aucune
// dependance JS de decompression a embarquer.
async function fetchGzipJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossible de charger ${url} (HTTP ${res.status})`);
  const decompressed = res.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).json();
}

function loadJson(url, gzip) {
  return gzip ? fetchGzipJson(url) : fetchJson(url);
}

async function currentDataVersion(urls) {
  if (!urls.manifest) return null;
  try {
    return await fetchJson(urls.manifest);
  } catch {
    return null;
  }
}

export async function runImportIfNeeded(onProgress) {
  const db = await getDb();
  const urls = assetUrls();
  const targetVersion = await currentDataVersion(urls);

  const graphMeta = await get(db, "graphMeta", "current");
  const banMeta = await get(db, "banMeta", "current");

  const graphUpToDate = Boolean(
    targetVersion && graphMeta && graphMeta.version === targetVersion.graphVersion
  );
  const banUpToDate = Boolean(targetVersion && banMeta && banMeta.version === targetVersion.banVersion);

  if (graphUpToDate && banUpToDate) {
    onProgress?.({ phase: "done", label: "Données déjà prêtes." });
    return;
  }

  if (!graphUpToDate) {
    onProgress?.({ phase: "graph", label: "Chargement du graphe routier…" });
    const rawGraph = await loadJson(urls.graph, urls.gzip);
    onProgress?.({ phase: "graph", label: "Construction de l'index routier…" });
    const csr = buildCsrFromRawGraph(rawGraph);
    await put(db, "graphCSR", { key: "current", ...csr });
    await put(db, "graphMeta", {
      key: "current",
      bbox: csr.bbox,
      nodeCount: csr.nodeCount,
      edgeCount: csr.edgeCount,
      version: targetVersion ? targetVersion.graphVersion : "fixtures",
    });
  }

  if (!banUpToDate) {
    onProgress?.({ phase: "ban", label: "Chargement des adresses…" });
    const rawBan = await loadJson(urls.ban, urls.gzip);
    const entries = rawBan.entries;

    await clear(db, "banEntries");
    onProgress?.({ phase: "ban", label: `Import de ${entries.length} adresses…`, done: 0, total: entries.length });
    await bulkPutChunked(db, "banEntries", entries, 3000, (done, total) => {
      onProgress?.({ phase: "ban", label: `Import des adresses… (${done}/${total})`, done, total });
    });
    await put(db, "banMeta", {
      key: "current",
      bbox: rawBan.bbox,
      count: entries.length,
      version: targetVersion ? targetVersion.banVersion : "fixtures",
    });
  }

  onProgress?.({ phase: "done", label: "Prêt." });
}
