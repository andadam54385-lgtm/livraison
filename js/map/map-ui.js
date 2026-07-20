import { listAllColis, formatAdresseAffichage } from "../scan/colis-store.js";
import { getActiveTour, markColisDeliveredDirect } from "../routing/tour-store.js";
import { getAllSettings } from "../settings/settings-store.js";
import { listFavoris } from "../favoris/favoris-store.js";
import { buildNavUrl } from "../tour/deep-links.js";
import { getMapFile } from "./pmtiles-store.js";
import { getDb } from "../db/schema.js";
import { loadCsrFromDb } from "../routing/graph-loader.js";
import { buildSpatialGrid, findNearestNode } from "../routing/spatial-index.js";
import { dijkstraSingleTargetPath, createDijkstraScratch } from "../routing/dijkstra.js";

// Chantier C : vrai fond de carte vectoriel (MapLibre GL JS + PMTiles +
// basemap Protomaps), 100% local -- remplace le plan SVG maison (rues
// dessinees a la main depuis le graphe routier). Le style, les glyphs et les
// sprites sont vendorises sous lib/maplibre/ (jamais de CDN, voir CLAUDE.md),
// le fichier .pmtiles (60+ Mo) est stocke en IndexedDB (Blob) par
// pmtiles-store.js apres le premier import Wifi -- pas OPFS, indisponible sur
// au moins un appareil de test reel. Trajet trace en suivant les rues reelles (Dijkstra
// sur le graphe OSM local, comme l'ancienne carte SVG -- voir
// buildRouteSegments), avec repli en ligne droite si le graphe n'est pas
// charge. Reste un aperçu, pas une nav turn-by-turn (deleguee a
// Plans/Waze/Google Maps, voir chantier B).

let containerRef = null;
let mapInstance = null;
let themeMediaCleanup = null;

let libsLoadPromise = null;
let pmtilesProtocol = null; // singleton process : un seul enregistrement global du schema "pmtiles"
let pmtilesReady = null; // null = pas encore teste, true/false ensuite

const STATUT_COLORS = { livre: "#22c55e", echec: "#dc2626", a_verifier: "#94a3b8" };
const DEFAULT_STOP_COLOR = "#3b82f6"; // pret / en_tournee
const ROUTE_COLOR = "#3b82f6";
const ROUTE_DONE_COLOR = "#94a3b8";

function moduleRelativeUrl(relativePath) {
  return new URL(relativePath, import.meta.url).href;
}

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadStylesheetOnce(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Échec chargement ${src}`)));
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      resolve();
    });
    el.addEventListener("error", () => reject(new Error(`Échec chargement ${src}`)));
    document.head.appendChild(el);
  });
}

// MapLibre GL (~1 Mo) et pmtiles.js sont differes (pas charges au boot de
// l'appli) : uniquement necessaires quand l'onglet Carte est ouvert. Une
// seule fois par session (script deja present au 2e mount).
function loadMapLibs() {
  if (!libsLoadPromise) {
    loadStylesheetOnce(moduleRelativeUrl("../../lib/maplibre/maplibre-gl.css"));
    libsLoadPromise = Promise.all([
      loadScriptOnce(moduleRelativeUrl("../../lib/maplibre/maplibre-gl.js")),
      loadScriptOnce(moduleRelativeUrl("../../lib/maplibre/pmtiles.js")),
    ]);
  }
  return libsLoadPromise;
}

// Source pmtiles.js lisant directement le Blob IndexedDB par tranches
// d'octets (blob.slice().arrayBuffer()) -- jamais le fichier entier en
// memoire, et aucune requete reseau (voir js/map/pmtiles-store.js pour le
// telechargement initial en Wifi).
class PmtilesBlobSource {
  constructor(blob) {
    this.blob = blob;
  }
  getKey() {
    return "map.pmtiles";
  }
  async getBytes(offset, length) {
    return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
  }
}

// Enregistre le schema "pmtiles://" une seule fois pour toute la session
// (maplibregl.addProtocol est un registre global : le recreer a chaque mount
// ecraserait le handler sans re-ajouter les instances PMTiles deja connues).
async function ensurePmtilesSource(db) {
  if (pmtilesReady !== null) return pmtilesReady;
  const file = await getMapFile(db);
  if (!file) {
    pmtilesReady = false;
    return false;
  }
  pmtilesProtocol = new window.pmtiles.Protocol();
  window.maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);
  pmtilesProtocol.add(new window.pmtiles.PMTiles(new PmtilesBlobSource(file)));
  pmtilesReady = true;
  return true;
}

function currentFlavor() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

async function loadBasemapStyle(flavor) {
  const res = await fetch(moduleRelativeUrl(`../../lib/maplibre/basemap-assets/styles/${flavor}.json`));
  return res.json();
}

function badgeForStatut(statut) {
  if (statut === "livre") return `<span class="badge badge-ok">Livré</span>`;
  if (statut === "echec") return `<span class="badge badge-warn">Échec</span>`;
  if (statut === "a_verifier") return `<span class="badge badge-pending">À vérifier</span>`;
  return "";
}

function formatColisDetail(c, { navApp, ordre } = {}) {
  const adresse = formatAdresseAffichage(c);
  const done = c.statut === "livre" || c.statut === "echec";
  const navUrl = c.geocode?.lat != null ? buildNavUrl(navApp, { lat: c.geocode.lat, lon: c.geocode.lon, label: c.nom, adresse }) : null;
  return `
    <div class="card-row">
      <div class="card-title">${ordre != null ? `#${ordre} ` : ""}${c.nom || "(nom inconnu)"}</div>
      ${badgeForStatut(c.statut)}
      ${c.avant12h ? '<span class="badge badge-urgent">Avant 12h</span>' : ""}
    </div>
    <div class="muted">${adresse}</div>
    ${c.quantite > 1 ? `<span class="badge badge-pending" style="margin-top:4px;">${c.quantite} colis</span>` : ""}
    <div class="button-row">
      ${c.tel ? `<a class="btn-link" href="tel:${c.tel}">📞 Appeler</a>` : ""}
      ${navUrl ? `<a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener">🧭 Naviguer</a>` : ""}
    </div>
    ${
      done
        ? `<button type="button" disabled style="margin-top:10px;width:100%;">${c.statut === "livre" ? "Livré ✓" : "Échec"}</button>`
        : `<button type="button" class="ok" data-map-deliver="${escapeAttr(c.id)}" style="margin-top:10px;width:100%;">Marquer livré</button>`
    }
  `;
}

function formatFavoriDetail(f) {
  const adresse = `${f.rue || ""}, ${f.cp || ""} ${f.ville || ""}`;
  return `
    <div class="card-title">⭐ ${f.rue || "Favori"}</div>
    <div class="muted">${adresse}</div>
    ${f.note ? `<p style="margin-top:8px;">${f.note}</p>` : `<p class="muted" style="margin-top:8px;">Pas de note.</p>`}
  `;
}

// Liste des arrets sous la carte (comme une appli de navigation grand
// public : chaque ligne = un arret avec son adresse et une action directe).
function renderStopList(ordered, navApp) {
  if (ordered.length === 0) return "";
  return ordered
    .map(({ stop, colis }) => {
      const delivered = stop.statutLivraison === "livre";
      const failed = stop.statutLivraison === "echec";
      const adresse = formatAdresseAffichage(colis);
      const navUrl = colis.geocode?.lat != null ? buildNavUrl(navApp, { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse }) : null;
      return `
        <div class="stop-row${delivered || failed ? " stop-row-done" : ""}" data-stop-colis-id="${escapeAttr(colis.id)}">
          <div class="stop-row-num">${stop.ordre}</div>
          <div class="stop-row-body">
            <div class="stop-row-title">${escapeHtml(colis.nom || "(nom inconnu)")} ${badgeForStatut(colis.statut)}</div>
            <div class="muted">${escapeHtml(adresse)}</div>
          </div>
          <div class="stop-row-actions">
            ${navUrl ? `<a href="${navUrl}" target="_blank" rel="noopener" aria-label="Naviguer" class="stop-row-btn">🧭</a>` : ""}
            ${delivered ? `<span class="stop-row-btn" aria-label="Livré">✓</span>` : `<button type="button" class="stop-row-btn" data-stop-deliver="${escapeAttr(colis.id)}" aria-label="Marquer livré">✓</button>`}
          </div>
        </div>
      `;
    })
    .join("");
}

// Trace routier reel entre chaque paire d'arrets consecutifs (Dijkstra sur le
// graphe OSM local, un appel par segment -- rapide car les arrets sont
// proches et la recherche s'arrete des que la cible est atteinte). Repli sur
// une ligne droite pour un segment donne si le trajet routier echoue (points
// hors reseau connu, graphe deconnecte), plutot que de faire echouer tout
// l'affichage.
function buildRouteSegments(csr, grid, scratch, orderedPoints) {
  const segments = [];
  for (let i = 0; i < orderedPoints.length - 1; i++) {
    const a = orderedPoints[i];
    const b = orderedPoints[i + 1];
    const fromNode = findNearestNode(grid, csr.nodeLat, csr.nodeLon, a.lat, a.lon).nodeIndex;
    const toNode = findNearestNode(grid, csr.nodeLat, csr.nodeLon, b.lat, b.lon).nodeIndex;
    let nodePath = null;
    if (fromNode !== -1 && toNode !== -1) {
      nodePath = dijkstraSingleTargetPath(csr, fromNode, toNode, scratch, { maxSeconds: 3600 });
    }
    if (nodePath && nodePath.length > 1) {
      segments.push(nodePath.map((n) => ({ lat: csr.nodeLat[n], lon: csr.nodeLon[n] })));
    } else {
      segments.push([a, b]);
    }
  }
  return segments;
}

// GeoJSON du trajet : une Feature LineString par troncon consecutif (depot ->
// arret 1 -> ... -> retour depot eventuel), suivant les rues reelles via
// Dijkstra quand le graphe routier est charge (repli en ligne droite sinon,
// voir buildRouteSegments). `done` porte la coloration attenuee des troncons
// deja parcourus.
function buildRouteGeoJson(depot, ordered, returnPoint, csr) {
  const points = [depot, ...ordered.map(({ colis }) => ({ lat: colis.geocode.lat, lon: colis.geocode.lon }))];
  if (returnPoint) points.push(returnPoint);

  const isTraite = (stop) => stop.statutLivraison === "livre" || stop.statutLivraison === "echec";
  const allDelivered = ordered.length > 0 && ordered.every(({ stop }) => isTraite(stop));
  const doneFlags = ordered.map(({ stop }) => isTraite(stop));
  if (returnPoint) doneFlags.push(allDelivered);

  let segments;
  if (csr && points.length > 1) {
    const grid = buildSpatialGrid(csr.nodeLat, csr.nodeLon);
    const scratch = createDijkstraScratch(csr.edgeCount);
    segments = buildRouteSegments(csr, grid, scratch, points);
  } else {
    segments = [];
    for (let i = 0; i < points.length - 1; i++) segments.push([points[i], points[i + 1]]);
  }

  const features = segments.map((seg, i) => ({
    type: "Feature",
    properties: { done: Boolean(doneFlags[i]) },
    geometry: { type: "LineString", coordinates: seg.map((p) => [p.lon, p.lat]) },
  }));
  return { type: "FeatureCollection", features };
}

function buildStopsGeoJson(geocoded, ordreParColisId) {
  return {
    type: "FeatureCollection",
    // "ordre" absent (pas juste null) quand le colis n'est pas dans la
    // tournee active : ["has","ordre"] cote style le distingue de 0/une
    // valeur reelle, une propriete presente avec valeur null resterait
    // "has" = true et afficherait le texte "null" sur le pin.
    features: geocoded.map((c) => {
      const properties = { colisId: c.id, statut: c.statut };
      const ordre = ordreParColisId.get(c.id);
      if (ordre != null) properties.ordre = ordre;
      return {
        type: "Feature",
        properties,
        geometry: { type: "Point", coordinates: [c.geocode.lon, c.geocode.lat] },
      };
    }),
  };
}

function buildFavorisGeoJson(favGeoco) {
  return {
    type: "FeatureCollection",
    features: favGeoco.map((f) => ({
      type: "Feature",
      properties: { favoriId: f.id },
      geometry: { type: "Point", coordinates: [f.lon, f.lat] },
    })),
  };
}

function buildWaypointsGeoJson(depot, returnPoint) {
  const features = [{ type: "Feature", properties: { kind: "depot" }, geometry: { type: "Point", coordinates: [depot.lon, depot.lat] } }];
  if (returnPoint) {
    features.push({ type: "Feature", properties: { kind: "arrivee" }, geometry: { type: "Point", coordinates: [returnPoint.lon, returnPoint.lat] } });
  }
  return { type: "FeatureCollection", features };
}

function addMapLayers(map, data) {
  const { routeGeoJson, stopsGeoJson, favorisGeoJson, waypointsGeoJson } = data;

  map.addSource("route", { type: "geojson", data: routeGeoJson });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#0b1220", "line-width": ["case", ["get", "done"], 6.5, 8], "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["get", "done"], ROUTE_DONE_COLOR, ROUTE_COLOR],
      "line-width": ["case", ["get", "done"], 3.5, 5],
    },
  });

  map.addSource("waypoints", { type: "geojson", data: waypointsGeoJson });
  map.addLayer({
    id: "waypoints-circle",
    type: "circle",
    source: "waypoints",
    paint: { "circle-radius": 12, "circle-color": "#0f172a", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 },
  });
  map.addLayer({
    id: "waypoints-label",
    type: "symbol",
    source: "waypoints",
    layout: { "text-field": ["match", ["get", "kind"], "depot", "🏠", "🏁"], "text-size": 13, "text-allow-overlap": true },
  });

  map.addSource("favoris", { type: "geojson", data: favorisGeoJson });
  map.addLayer({
    id: "favoris-label",
    type: "symbol",
    source: "favoris",
    layout: { "text-field": "⭐", "text-size": 16, "text-allow-overlap": true },
  });

  map.addSource("stops", { type: "geojson", data: stopsGeoJson });
  map.addLayer({
    id: "stops-circle",
    type: "circle",
    source: "stops",
    paint: {
      "circle-radius": 13,
      "circle-color": ["match", ["get", "statut"], "livre", STATUT_COLORS.livre, "echec", STATUT_COLORS.echec, "a_verifier", STATUT_COLORS.a_verifier, DEFAULT_STOP_COLOR],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": ["match", ["get", "statut"], "livre", 0.6, "echec", 0.6, 1],
    },
  });
  map.addLayer({
    id: "stops-label",
    type: "symbol",
    source: "stops",
    layout: { "text-field": ["case", ["has", "ordre"], ["to-string", ["get", "ordre"]], ""], "text-size": 11, "text-allow-overlap": true },
    paint: { "text-color": "#ffffff" },
  });

  for (const layerId of ["stops-circle", "favoris-label"]) {
    map.on("mouseenter", layerId, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layerId, () => (map.getCanvas().style.cursor = ""));
  }
}

function fitToPoints(map, points) {
  if (points.length === 0) return;
  const bounds = new window.maplibregl.LngLatBounds();
  for (const p of points) bounds.extend([p.lon, p.lat]);
  map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 });
}

async function render() {
  containerRef.innerHTML = `<div class="empty-state">Chargement de la carte…</div>`;

  const db = await getDb();
  const [allColis, activeTour, settings, favoris, csr] = await Promise.all([
    listAllColis(),
    getActiveTour(),
    getAllSettings(),
    listFavoris(),
    loadCsrFromDb(db),
  ]);
  const geocoded = allColis.filter((c) => c.geocode?.lat != null && c.geocode?.lon != null);

  if (geocoded.length === 0) {
    containerRef.innerHTML = `<div class="empty-state">Aucun colis géocodé pour le moment. Scanne ou saisis des colis, puis reviens ici.</div>`;
    return;
  }

  await loadMapLibs();
  const hasMap = await ensurePmtilesSource(db);

  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
  }
  if (themeMediaCleanup) {
    themeMediaCleanup();
    themeMediaCleanup = null;
  }

  const depot = activeTour?.depot ?? { lat: settings.depotLat, lon: settings.depotLon, label: settings.depotLabel };
  const favGeoco = favoris.filter((f) => f.lat != null && f.lon != null);
  const returnPoint = activeTour?.returnToDepot && activeTour.depotArrivee ? activeTour.depotArrivee : null;

  const ordreParColisId = new Map();
  let ordered = [];
  if (activeTour) {
    const byColisId = new Map(geocoded.map((c) => [c.id, c]));
    ordered = activeTour.stops
      .slice()
      .sort((a, b) => a.ordre - b.ordre)
      .map((s) => ({ stop: s, colis: byColisId.get(s.colisId) }))
      .filter((x) => x.colis);
    ordered.forEach(({ stop }) => ordreParColisId.set(stop.colisId, stop.ordre));
  }

  const stopListHtml = renderStopList(ordered, settings.navApp);

  containerRef.innerHTML = `
    <div style="padding:10px 16px;">
      <div class="stats-row" style="flex-wrap:wrap;">
        <span class="stat-pill">🏠 Départ</span>
        ${returnPoint ? `<span class="stat-pill">🏁 Retour dépôt</span>` : ""}
        <span class="stat-pill" style="border-color:#94a3b8;color:#94a3b8;">● À vérifier</span>
        <span class="stat-pill" style="border-color:${DEFAULT_STOP_COLOR};color:${DEFAULT_STOP_COLOR};">● Prêt / en tournée</span>
        <span class="stat-pill" style="border-color:#22c55e;color:#22c55e;">● Livré</span>
        <span class="stat-pill" style="border-color:#dc2626;color:#dc2626;">● Échec</span>
        <span class="stat-pill">⭐ Favori</span>
        ${!hasMap ? `<span class="stat-pill stat-pill-warn">⚠ Fond de carte non téléchargé</span>` : ""}
        ${!csr ? `<span class="stat-pill stat-pill-warn">⚠ Trajet en ligne droite (graphe routier non chargé)</span>` : ""}
      </div>
    </div>
    <div class="map-canvas-wrap">
      ${hasMap ? `<div id="maplibre-map"></div>` : `<div class="empty-state">Fond de carte indisponible : synchronise l'appli en Wifi une fois (voir Réglages) pour le télécharger.</div>`}
      ${
        stopListHtml
          ? `
        <div class="stop-panel" id="stop-panel">
          <button type="button" class="stop-panel-handle" id="stop-panel-toggle">
            <span class="stop-panel-bar"></span>
            <span>${ordered.length} arrêt${ordered.length > 1 ? "s" : ""} — voir la liste</span>
          </button>
          <div class="stop-panel-list">${stopListHtml}</div>
        </div>
      `
          : ""
      }
    </div>
    <div id="map-detail"></div>
  `;

  const stopPanel = containerRef.querySelector("#stop-panel");
  if (stopPanel) {
    containerRef.querySelector("#stop-panel-toggle").addEventListener("click", () => {
      stopPanel.classList.toggle("expanded");
    });
  }

  const navApp = settings.navApp;
  const detailEl = containerRef.querySelector("#map-detail");

  function bindDeliverButton() {
    const btn = detailEl.querySelector("[data-map-deliver]");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      await markColisDeliveredDirect(btn.dataset.mapDeliver);
      await render();
    });
  }

  containerRef.querySelectorAll("[data-stop-deliver]").forEach((el) => {
    el.addEventListener("click", async () => {
      await markColisDeliveredDirect(el.dataset.stopDeliver);
      await render();
    });
  });

  if (!hasMap) return;

  const style = await loadBasemapStyle(currentFlavor());
  // MapLibre exige WebGL -- indisponible sur certains postes (accélération
  // matérielle désactivée, pilote GPU/VM en cause, contexte epuisé) : la
  // construction de Map() plante alors de façon synchrone. Sans ce
  // try/catch, l'erreur remontait jusqu'au routeur de vues (app.js) qui
  // effaçait TOUT #map-content -- y compris la légende et la liste des
  // arrêts déjà rendues juste au-dessus, qui n'ont pourtant aucun rapport
  // avec WebGL et restent parfaitement utilisables sans fond de carte.
  let map;
  try {
    map = new window.maplibregl.Map({
      container: "maplibre-map",
      style,
      center: [depot.lon, depot.lat],
      zoom: 12,
    });
  } catch (err) {
    console.error("[map] Échec d'initialisation de MapLibre (WebGL indisponible ?) :", err);
    const mapEl = containerRef.querySelector("#maplibre-map");
    if (mapEl) {
      mapEl.outerHTML = `<div class="empty-state">Carte indisponible sur cet appareil (WebGL non accessible dans ce navigateur). La liste des arrêts ci-dessous reste utilisable.</div>`;
    }
    return;
  }
  mapInstance = map;
  map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(
    new window.maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
    "top-right"
  );

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onThemeChange = () => loadBasemapStyle(currentFlavor()).then((s) => map.setStyle(s));
  mq.addEventListener("change", onThemeChange);
  themeMediaCleanup = () => mq.removeEventListener("change", onThemeChange);

  map.on("load", () => {
    const routeGeoJson = buildRouteGeoJson(depot, ordered, returnPoint, csr);
    const stopsGeoJson = buildStopsGeoJson(geocoded, ordreParColisId);
    const favorisGeoJson = buildFavorisGeoJson(favGeoco);
    const waypointsGeoJson = buildWaypointsGeoJson(depot, returnPoint);
    addMapLayers(map, { routeGeoJson, stopsGeoJson, favorisGeoJson, waypointsGeoJson });

    const allPoints = [
      depot,
      ...geocoded.map((c) => ({ lat: c.geocode.lat, lon: c.geocode.lon })),
      ...favGeoco.map((f) => ({ lat: f.lat, lon: f.lon })),
      ...(returnPoint ? [returnPoint] : []),
    ];
    fitToPoints(map, allPoints);

    map.on("click", "stops-circle", (e) => {
      const props = e.features[0].properties;
      const colis = geocoded.find((c) => c.id === props.colisId);
      if (!colis) return;
      detailEl.innerHTML = `<div class="card" style="margin:0 16px 12px;">${formatColisDetail(colis, { navApp, ordre: ordreParColisId.get(colis.id) })}</div>`;
      bindDeliverButton();
    });
    map.on("click", "favoris-label", (e) => {
      const props = e.features[0].properties;
      const fav = favGeoco.find((f) => f.id === props.favoriId);
      if (!fav) return;
      detailEl.innerHTML = `<div class="card" style="margin:0 16px 12px;">${formatFavoriDetail(fav)}</div>`;
    });
  });
}

export async function mount(container) {
  containerRef = container;
  await render();
}
