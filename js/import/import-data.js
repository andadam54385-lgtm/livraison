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

function assetUrls() {
  if (useFixtures()) {
    return {
      graph: "../../test-fixtures/mini-graph.json",
      ban: "../../test-fixtures/mini-ban.json",
      manifest: null,
    };
  }
  return {
    graph: "../../assets/graph.json",
    ban: "../../assets/ban.json",
    manifest: "../../assets/manifest-content.json",
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Impossible de charger ${url} (HTTP ${res.status})`);
  return res.json();
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
    const rawGraph = await fetchJson(urls.graph);
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
    const rawBan = await fetchJson(urls.ban);
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
