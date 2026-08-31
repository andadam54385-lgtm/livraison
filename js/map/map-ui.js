import { listAllColis, saveColis, formatAdresseAffichage, formatAdresseForNav } from "../scan/colis-store.js";
import { getActiveTour, markColisDeliveredDirect } from "../routing/tour-store.js";
import { getAllSettings } from "../settings/settings-store.js";
import { listFavoris } from "../favoris/favoris-store.js";
import { buildNavUrl } from "../tour/deep-links.js";
import { getMapFile } from "./pmtiles-store.js";
import { getDb } from "../db/schema.js";
import { loadCsrFromDb } from "../routing/graph-loader.js";
import { buildSpatialGrid, findNearestNode } from "../routing/spatial-index.js";
import { dijkstraSingleTargetPath, createDijkstraScratch } from "../routing/dijkstra.js";
import { icon, iconToImage } from "../ui/icons.js";
import { showToast } from "../lib/toast.js";
import { escapeHtml, escapeAttr } from "../lib/escape.js";
import { loadingHtml } from "../lib/loading.js";

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
// Fusion Carte + Tournee : la carte vit dans un slot STATIQUE de #tour-view
// (jamais reecrit par les renders de tour-ui), donc l'instance MapLibre
// SURVIT d'un rendu a l'autre -- fini le "recree a chaque mount()" de
// l'ancien onglet Carte. Deux variantes d'affichage du meme slot :
// - "backdrop" (tournee active) : fond de carte sous la feuille de tour-ui,
//   la liste d'arrets interne (.stop-panel) est masquee (doublon).
// - "overlay" (preparation) : plein ecran a la demande (lasso, vue
//   d'ensemble), avec bouton de fermeture et liste interne visible.
let currentVariant = null;
let onCloseCallback = null;
let themeMediaCleanup = null;
// Mode "selection par zones" (lasso) : etat local a l'ecran Carte, reinitialise
// a chaque mount() -- voir setupZoneMode().
let zoneMode = false;
// true seulement une fois addMapLayers() a tourne (dans map.on("load", ...)) :
// getSource() avant que le style ne soit charge peut lever selon la version
// de MapLibre plutot que retourner juste undefined -- ce flag explicite evite
// de s'y fier (voir refreshMapData()).
let layersReady = false;

let libsLoadPromise = null;
let pmtilesProtocol = null; // singleton process : un seul enregistrement global du schema "pmtiles"
let pmtilesReady = null; // null = pas encore teste, true/false ensuite

const STATUT_COLORS = { livre: "#22c55e", echec: "#dc2626", a_verifier: "#94a3b8" };
const DEFAULT_STOP_COLOR = "#3b82f6"; // pret / en_tournee
const ROUTE_COLOR = "#3b82f6";
const ROUTE_DONE_COLOR = "#94a3b8";
// Anneau colore par zone manuelle (voir setupZoneMode()) -- distinct de la
// couleur de remplissage (qui reste le statut du colis) : la teinte identifie
// juste le groupe, pas de sens ordinal au-dela du numero affiche sur le pin.
const ZONE_COLORS = ["#f97316", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f59e0b", "#14b8a6", "#a855f7"];

function moduleRelativeUrl(relativePath) {
  return new URL(relativePath, import.meta.url).href;
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
  const navUrl = c.geocode?.lat != null ? buildNavUrl(navApp, { lat: c.geocode.lat, lon: c.geocode.lon, label: c.nom, adresse: formatAdresseForNav(c) }) : null;
  return `
    <div class="card-row">
      <div class="card-title">${ordre != null ? `#${ordre} ` : ""}${escapeHtml(c.nom || "(nom inconnu)")}</div>
      ${badgeForStatut(c.statut)}
      ${c.avant12h ? '<span class="badge badge-urgent">Avant 12h</span>' : ""}
    </div>
    <div class="muted">${escapeHtml(adresse)}</div>
    ${c.quantite > 1 ? `<span class="badge badge-pending" style="margin-top:4px;">${c.quantite} colis</span>` : ""}
    <div class="button-row">
      ${c.tel ? `<a class="btn-link" href="tel:${escapeAttr(c.tel)}">${icon("phone")}Appeler</a>` : ""}
      ${navUrl ? `<a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener">${icon("navigation")}Naviguer</a>` : ""}
    </div>
    ${
      done
        ? `<button type="button" disabled style="margin-top:10px;width:100%;">${c.statut === "livre" ? `Livré ${icon("check", { spaced: false })}` : "Échec"}</button>`
        : `<button type="button" class="ok" data-map-deliver="${escapeAttr(c.id)}" style="margin-top:10px;width:100%;">Marquer livré</button>`
    }
  `;
}

function formatFavoriDetail(f) {
  const adresse = `${f.rue || ""}, ${f.cp || ""} ${f.ville || ""}`;
  return `
    <div class="card-title">${icon("star")}${f.rue || "Favori"}</div>
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
      const navUrl = colis.geocode?.lat != null ? buildNavUrl(navApp, { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse: formatAdresseForNav(colis) }) : null;
      return `
        <div class="stop-row${delivered || failed ? " stop-row-done" : ""}" data-stop-colis-id="${escapeAttr(colis.id)}">
          <div class="stop-row-num">${stop.ordre}</div>
          <div class="stop-row-body">
            <div class="stop-row-title">${escapeHtml(colis.nom || "(nom inconnu)")} ${badgeForStatut(colis.statut)}</div>
            <div class="muted">${escapeHtml(adresse)}</div>
          </div>
          <div class="stop-row-actions">
            ${navUrl ? `<a href="${navUrl}" target="_blank" rel="noopener" aria-label="Naviguer" class="stop-row-btn">${icon("navigation", { spaced: false })}</a>` : ""}
            ${delivered ? `<span class="stop-row-btn" aria-label="Livré">${icon("check", { spaced: false })}</span>` : `<button type="button" class="stop-row-btn" data-stop-deliver="${escapeAttr(colis.id)}" aria-label="Marquer livré">${icon("check", { spaced: false })}</button>`}
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
      if (c.zone != null) {
        properties.zone = c.zone;
        properties.zoneColor = ZONE_COLORS[(c.zone - 1) % ZONE_COLORS.length];
      }
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

// Charge les pictogrammes depot/arrivee/favori en bitmap (une fois par
// instance Map -- recreee a chaque render()) : les symbol layers MapLibre
// dessinent leur text-field avec la police vendorisee (Noto Sans, plage
// Latin-1 uniquement, voir CLAUDE.md chantier C), qui ne contient AUCUN
// glyphe emoji. Un text-field "🏠"/"🏁"/"⭐" ne s'affichait donc pas du tout
// (case vide silencieuse) -- une image bitmap contourne le probleme.
async function ensureMapIcons(map) {
  const specs = [
    ["icon-depot", "home", "#0f172a"],
    ["icon-arrivee", "flag", "#0f172a"],
    ["icon-favori", "star", "#eab308"],
  ];
  await Promise.all(
    specs.map(async ([name, iconName, color]) => {
      if (map.hasImage(name)) return;
      const imageData = await iconToImage(iconName, { size: 40, color });
      map.addImage(name, imageData);
    })
  );
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
    layout: {
      "icon-image": ["match", ["get", "kind"], "depot", "icon-depot", "icon-arrivee"],
      "icon-size": 0.55,
      "icon-allow-overlap": true,
    },
  });

  map.addSource("favoris", { type: "geojson", data: favorisGeoJson });
  map.addLayer({
    id: "favoris-label",
    type: "symbol",
    source: "favoris",
    layout: { "icon-image": "icon-favori", "icon-size": 0.5, "icon-allow-overlap": true },
  });

  map.addSource("stops", { type: "geojson", data: stopsGeoJson });
  map.addLayer({
    id: "stops-circle",
    type: "circle",
    source: "stops",
    paint: {
      "circle-radius": 13,
      "circle-color": ["match", ["get", "statut"], "livre", STATUT_COLORS.livre, "echec", STATUT_COLORS.echec, "a_verifier", STATUT_COLORS.a_verifier, DEFAULT_STOP_COLOR],
      // Anneau colore par zone manuelle (voir ZONE_COLORS/setupZoneMode) --
      // distinct du remplissage, qui reste le statut du colis.
      "circle-stroke-color": ["case", ["has", "zoneColor"], ["get", "zoneColor"], "#ffffff"],
      "circle-stroke-width": ["case", ["has", "zoneColor"], 4, 2],
      "circle-opacity": ["match", ["get", "statut"], "livre", 0.6, "echec", 0.6, 1],
    },
  });
  map.addLayer({
    id: "stops-label",
    type: "symbol",
    source: "stops",
    layout: {
      // Une fois la tournee calculee, l'ordre de passage prime sur le numero
      // de zone (qui n'a servi qu'a le determiner) -- avant calcul, "Z<n>"
      // donne au livreur un retour visuel immediat sur ses zones dessinees.
      "text-field": ["case", ["has", "ordre"], ["to-string", ["get", "ordre"]], ["has", "zone"], ["concat", "Z", ["to-string", ["get", "zone"]]], ""],
      "text-size": 11,
      "text-allow-overlap": true,
    },
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

const SHEET_STATES = { collapsed: 64, half: 0.42, full: 0.82 };

// Feuille glissante a 3 positions (repliee / mi-hauteur / pleine hauteur),
// glissable au doigt (pointer events, une seule poignee) ET cliquable (cycle
// aux 3 positions sans avoir a glisser -- accessibilite/precision). La
// hauteur est pilotee en pixels (pas en max-height/CSS class comme l'ancienne
// version a 2 etats) pour permettre un suivi fluide du doigt pendant le drag.
function setupStopPanelSheet(panel, handle) {
  const heightFor = (name) => (name === "collapsed" ? SHEET_STATES.collapsed : Math.round(window.innerHeight * SHEET_STATES[name]));
  let state = "collapsed";
  let dragged = false;
  let dragStartY = null;
  let dragStartHeight = null;

  function applyState(name, animate = true) {
    state = name;
    panel.style.transition = animate ? "height 0.22s var(--ease)" : "none";
    panel.style.height = `${heightFor(name)}px`;
    panel.dataset.state = name;
  }
  applyState("collapsed", false);

  function nearestState(height) {
    let best = "collapsed";
    let bestDist = Infinity;
    for (const name of Object.keys(SHEET_STATES)) {
      const d = Math.abs(height - heightFor(name));
      if (d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  }

  handle.addEventListener("click", () => {
    if (dragged) {
      dragged = false; // le pointerup qui suit un drag ne doit pas aussi cycler l'etat
      return;
    }
    const order = ["collapsed", "half", "full"];
    applyState(order[(order.indexOf(state) + 1) % order.length]);
  });

  handle.addEventListener("pointerdown", (e) => {
    dragStartY = e.clientY;
    dragStartHeight = panel.getBoundingClientRect().height;
    panel.style.transition = "none";
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (dragStartY === null) return;
    const dy = dragStartY - e.clientY;
    if (Math.abs(dy) > 4) dragged = true;
    const h = Math.min(heightFor("full"), Math.max(heightFor("collapsed"), dragStartHeight + dy));
    panel.style.height = `${h}px`;
  });
  function endDrag() {
    if (dragStartY === null) return;
    dragStartY = null;
    applyState(nearestState(panel.getBoundingClientRect().height));
  }
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

// Recupere + met en forme toutes les donnees necessaires a l'ecran Carte
// (colis geocodes, tournee active, reglages, favoris, graphe routier) --
// factorise pour etre appelable a la fois par render() (montage complet) et
// refreshMapData() (rafraichissement leger apres une livraison, voir
// plus bas) sans dupliquer la logique de tri/filtrage.
async function loadMapData() {
  const db = await getDb();
  const [allColis, activeTour, settings, favoris, csr] = await Promise.all([
    listAllColis(),
    getActiveTour(),
    getAllSettings(),
    listFavoris(),
    loadCsrFromDb(db),
  ]);
  // Bug reel corrige ici (retour terrain : "la carte devient vite illisible
  // au fil des jours") : allColis contient TOUT l'historique (des semaines
  // de colis livres/en echec dont la tournee est archivee depuis
  // longtemps), et rien ne filtrait par date/tournee -- chaque colis
  // geocode restait un point sur la carte indefiniment. Ne garde que les
  // colis encore pertinents : pas encore traites (pret/en_tournee/a
  // verifier, utile pour preparer la prochaine tournee) OU appartenant a la
  // tournee du jour actuellement active (pour voir la progression du jour,
  // meme les arrets deja livres/en echec) -- jamais un colis livre/en echec
  // d'une tournee archivee anterieure.
  const activeTourColisIds = new Set((activeTour?.stops || []).map((s) => s.colisId));
  const geocoded = allColis.filter(
    (c) =>
      c.geocode?.lat != null &&
      c.geocode?.lon != null &&
      (c.statut !== "livre" && c.statut !== "echec" ? true : activeTourColisIds.has(c.id))
  );
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

  return { db, geocoded, settings, csr, depot, favGeoco, returnPoint, ordreParColisId, ordered };
}

// Rebranche les boutons "Marquer livre" d'une liste d'arrets (portee limitee
// a scopeEl pour pouvoir re-brancher juste apres un remplacement cible de
// .stop-panel-list, sans reparcourir tout containerRef -- voir
// refreshMapData()).
function bindStopListDeliverButtons(scopeEl) {
  scopeEl.querySelectorAll("[data-stop-deliver]").forEach((el) => {
    el.addEventListener("click", async () => {
      await markColisDeliveredDirect(el.dataset.stopDeliver);
      await refreshMapData();
    });
  });
}

// Rafraichissement leger apres une livraison marquee depuis l'ecran Carte :
// contrairement a render(), ne detruit PAS l'instance MapLibre (contexte
// WebGL + tuiles deja decodees) ni l'etat de l'UI (panneau menu, position de
// la feuille d'arrets, pan/zoom) -- seules les donnees qui peuvent reellement
// changer (statut d'un arret) sont mises a jour : sources "stops"/"route" via
// setData(), liste d'arrets, et fiche detail si elle est ouverte sur le colis
// concerne. "favoris"/"waypoints" ne changent jamais suite a une livraison,
// pas besoin de les toucher. Repli sur render() si l'instance n'existe pas
// encore ou si ses sources ne sont pas encore posees (fenetre de montage
// avant que le "load" de MapLibre n'ait tourne, voir addMapLayers plus haut) --
// getSource() ne leve pas d'exception, retourne juste undefined.
export async function refreshMapData() {
  // Peut etre appele par tour-ui alors que la carte n'a jamais ete ouverte
  // (aucun slot rendu) : no-op. mapInstance null avec un slot rendu = ecran
  // liste sans WebGL/fond de carte -> re-render complet leger, comme avant.
  if (!containerRef || !containerRef.dataset.mapVariant) return;
  if (!mapInstance || !layersReady) return render();

  const { geocoded, csr, depot, returnPoint, ordreParColisId, ordered, settings } = await loadMapData();

  mapInstance.getSource("stops").setData(buildStopsGeoJson(geocoded, ordreParColisId));
  mapInstance.getSource("route").setData(buildRouteGeoJson(depot, ordered, returnPoint, csr));

  const stopListEl = containerRef.querySelector(".stop-panel-list");
  if (stopListEl) {
    stopListEl.innerHTML = renderStopList(ordered, settings.navApp);
    bindStopListDeliverButtons(stopListEl);
  }

  // Si la fiche detail ouverte concerne justement le colis qu'on vient de
  // livrer, la rafraichir aussi (sinon son bouton "Marquer livre" reste
  // affiche par erreur jusqu'au prochain montage complet).
  const detailEl = containerRef.querySelector("#map-detail");
  const openBtn = detailEl?.querySelector("[data-map-deliver]");
  if (openBtn) {
    const colis = geocoded.find((c) => c.id === openBtn.dataset.mapDeliver);
    if (colis) {
      detailEl.innerHTML = `<div class="card" style="margin:0 16px 12px;">${formatColisDetail(colis, { navApp: settings.navApp, ordre: ordreParColisId.get(colis.id) })}</div>`;
      const btn = detailEl.querySelector("[data-map-deliver]");
      btn?.addEventListener("click", async () => {
        await markColisDeliveredDirect(btn.dataset.mapDeliver);
        await refreshMapData();
      });
    }
  }
}

// Ray casting standard (point en coordonnees ecran, polygone = tableau de
// [x,y] ecran) -- tout se fait en pixels, jamais en lat/lon : le lasso est
// dessine a un instant donne pendant lequel la carte ne bouge pas (l'overlay
// capture tous les evenements pointer, voir setupZoneMode), donc pas besoin
// de reprojeter le polygone si la carte pan/zoom apres coup.
function pointInPolygon([px, py], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Colis assignables a une zone : memes criteres que listColisEligibles()
// (routing-ui.js) -- seuls les colis "pret"/"en_tournee" sont repris par un
// (re)calcul de tournee, inutile de proposer une zone sur un colis "a
// verifier" (pas encore geocode correctement) ou deja livre/en echec.
function zoneEligibleColis(geocoded) {
  return geocoded.filter((c) => c.statut === "pret" || c.statut === "en_tournee");
}

// Mode "selection par zones" (lasso) : le livreur trace un contour a main
// levee autour d'un groupe d'arrets, lui donne un numero de zone, recommence
// pour un autre groupe -- computeOptimizedStops (routing-ui.js) respecte
// ensuite ce macro-ordre (toutes les zones 1 avant les zones 2, etc.) en ne
// laissant l'optimisation automatique jouer qu'A L'INTERIEUR de chaque zone.
// L'overlay capture tous les evenements pointer pendant le mode (voir
// .zone-draw-overlay.active en CSS) : la carte MapLibre en dessous n'en recoit
// alors plus aucun, pas besoin de desactiver dragPan separement.
// Bug reel corrige ici : l'overlay etait a l'origine un <svg> directement --
// Safari ne hit-teste de facon fiable que les zones REELLEMENT peintes d'un
// <svg> racine vide, pas toute sa boite (contrairement a un <div>). Resultat
// concret sur iPhone : le tap "traversait" l'overlay jusqu'a la carte en
// dessous, qui se mettait donc a paner au lieu de dessiner. Un <div> (hit-
// testable sur toute sa boite, meme transparent) capture desormais les
// evenements ; le <svg> imbrique ne sert plus qu'a l'affichage (pointer-
// events:none, voir CSS), jamais a la detection du geste.
function setupZoneMode(map, geocoded, ordreParColisId) {
  const toggleBtn = containerRef.querySelector("#zone-mode-toggle");
  const overlay = containerRef.querySelector("#zone-draw-overlay");
  const drawSvg = overlay?.querySelector(".zone-draw-svg");
  const hintBar = containerRef.querySelector("#zone-hint-bar");
  const confirmPanel = containerRef.querySelector("#zone-confirm-panel");
  if (!toggleBtn || !overlay || !drawSvg || !hintBar || !confirmPanel) return;

  let drawing = false;
  let drawPoints = [];
  // Cache le rect le temps d'UN geste (pointerdown -> pointerup) : evite un
  // reflow a chaque pointermove tout en restant robuste au clientX/clientY
  // (contrairement a offsetX/offsetY, dont le referentiel change si la
  // capture de pointeur retargete e.target vers un enfant different).
  let overlayRect = null;

  function pointFromEvent(e) {
    const rect = overlayRect || overlay.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function renderDrawPath() {
    if (drawPoints.length < 2) {
      drawSvg.innerHTML = "";
      return;
    }
    const pts = drawPoints.map(([x, y]) => `${x},${y}`).join(" ");
    drawSvg.innerHTML = `<polygon points="${pts}"></polygon>`;
  }

  function applyZoneMode(active) {
    zoneMode = active;
    toggleBtn.classList.toggle("active", active);
    overlay.classList.toggle("active", active);
    hintBar.hidden = !active;
    if (!active) {
      drawing = false;
      drawPoints = [];
      renderDrawPath();
      confirmPanel.innerHTML = "";
    }
  }
  applyZoneMode(false);

  toggleBtn.addEventListener("click", () => applyZoneMode(!zoneMode));

  function nextZoneNumber() {
    const zones = zoneEligibleColis(geocoded)
      .map((c) => c.zone)
      .filter((z) => z != null);
    return zones.length ? Math.max(...zones) + 1 : 1;
  }

  async function refreshZoneVisuals() {
    if (!layersReady) return;
    mapInstance?.getSource("stops")?.setData(buildStopsGeoJson(geocoded, ordreParColisId));
  }

  function showZoneConfirmPanel(selectedColis) {
    const suggested = nextZoneNumber();
    confirmPanel.innerHTML = `
      <div class="zone-confirm-card">
        <div class="card-title">${selectedColis.length} arrêt${selectedColis.length > 1 ? "s" : ""} entouré${selectedColis.length > 1 ? "s" : ""}</div>
        <div class="field">
          <label for="zone-number-input">Numéro de zone (ordre de passage)</label>
          <input type="number" id="zone-number-input" min="1" step="1" value="${suggested}">
        </div>
        <div class="button-row">
          <button type="button" id="zone-confirm-cancel">Annuler</button>
          <button type="button" class="primary" id="zone-confirm-save">Valider</button>
        </div>
      </div>
    `;
    confirmPanel.querySelector("#zone-confirm-cancel").addEventListener("click", () => {
      confirmPanel.innerHTML = "";
    });
    confirmPanel.querySelector("#zone-confirm-save").addEventListener("click", async () => {
      const n = parseInt(confirmPanel.querySelector("#zone-number-input").value, 10);
      confirmPanel.innerHTML = "";
      if (!Number.isFinite(n) || n < 1) return;
      for (const c of selectedColis) {
        c.zone = n;
        await saveColis(c);
      }
      showToast(`Zone ${n} enregistrée (${selectedColis.length} arrêt${selectedColis.length > 1 ? "s" : ""}).`);
      await refreshZoneVisuals();
    });
  }

  overlay.addEventListener("pointerdown", (e) => {
    if (!zoneMode) return;
    drawing = true;
    overlayRect = overlay.getBoundingClientRect();
    drawPoints = [pointFromEvent(e)];
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
    renderDrawPath();
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    drawPoints.push(pointFromEvent(e));
    renderDrawPath();
  });
  overlay.addEventListener("pointerup", async (e) => {
    if (!drawing) return;
    drawing = false;
    overlayRect = null;
    overlay.releasePointerCapture(e.pointerId);
    const points = drawPoints;
    drawPoints = [];
    renderDrawPath();
    // <3 points (simple tap, pas un vrai tracé) : rien a selectionner.
    if (points.length < 3) return;
    const candidates = zoneEligibleColis(geocoded);
    const selected = candidates.filter((c) => {
      const pt = map.project([c.geocode.lon, c.geocode.lat]);
      return pointInPolygon([pt.x, pt.y], points);
    });
    if (selected.length === 0) {
      showToast("Aucun arrêt dans cette zone.");
      return;
    }
    showZoneConfirmPanel(selected);
  });
  overlay.addEventListener("pointercancel", () => {
    drawing = false;
    overlayRect = null;
    drawPoints = [];
    renderDrawPath();
  });

  containerRef.querySelector("#zone-reset-btn")?.addEventListener("click", async () => {
    const withZone = zoneEligibleColis(geocoded).filter((c) => c.zone != null);
    if (withZone.length === 0) {
      showToast("Aucune zone à réinitialiser.");
      return;
    }
    if (!confirm(`Effacer ${withZone.length} assignation${withZone.length > 1 ? "s" : ""} de zone ?`)) return;
    for (const c of withZone) {
      delete c.zone;
      await saveColis(c);
    }
    showToast("Zones réinitialisées.");
    await refreshZoneVisuals();
  });
}

async function render() {
  containerRef.innerHTML = loadingHtml("Chargement de la carte…");

  const { db, geocoded, settings, csr, depot, favGeoco, returnPoint, ordreParColisId, ordered } = await loadMapData();

  if (geocoded.length === 0) {
    // Bug reel : l'ancien retour anticipe remplaçait TOUT le conteneur par le
    // message vide, y compris le bouton menu -- or Reglages n'est accessible
    // QUE depuis ce menu (plus d'onglet dedie dans la nav du bas depuis le
    // 2026-07-26). Un utilisateur sans aucun colis geocode (ex: tout premier
    // lancement) se retrouvait donc sans aucun moyen d'atteindre Reglages.
    containerRef.innerHTML = `
      <div class="map-canvas-wrap">
        <div class="empty-state">Aucun colis géocodé pour le moment. Scanne ou saisis des colis, puis reviens ici.</div>
        <button type="button" class="map-menu-btn" id="map-menu-toggle" aria-label="Menu">${icon("menu", { spaced: false, size: 22 })}</button>
        <button type="button" class="map-menu-btn map-close-btn" id="map-close-btn" aria-label="Fermer la carte">${icon("x", { spaced: false, size: 22 })}</button>
        <div class="map-menu-panel" id="map-menu-panel" hidden>
          <a class="btn-link" href="#settings">${icon("settings")}Réglages</a>
          ${!csr ? `<p class="map-menu-warn">${icon("alert-triangle", { spaced: false })}Trajet en ligne droite (graphe routier non chargé)</p>` : ""}
        </div>
      </div>
    `;
    const menuToggle = containerRef.querySelector("#map-menu-toggle");
    const menuPanel = containerRef.querySelector("#map-menu-panel");
    menuToggle.addEventListener("click", () => menuPanel.toggleAttribute("hidden"));
    return;
  }

  await loadMapLibs();
  const hasMap = await ensurePmtilesSource(db);

  if (mapInstance) {
    mapInstance.remove();
    mapInstance = null;
    layersReady = false;
  }
  if (themeMediaCleanup) {
    themeMediaCleanup();
    themeMediaCleanup = null;
  }

  const stopListHtml = renderStopList(ordered, settings.navApp);

  // Carte plein ecran (plus de header/legende toujours visibles) : tout ce
  // qui n'est pas la carte elle-meme (legende, avertissements, acces aux
  // Reglages) est regroupe dans un seul menu deroulant en haut a gauche,
  // ferme par defaut.
  containerRef.innerHTML = `
    <div class="map-canvas-wrap">
      ${hasMap ? `<div id="maplibre-map"></div>` : `<div class="empty-state">Fond de carte indisponible : synchronise l'appli en Wifi une fois (voir Réglages) pour le télécharger.</div>`}
      ${hasMap ? `<div class="zone-draw-overlay" id="zone-draw-overlay"><svg class="zone-draw-svg"></svg></div>` : ""}
      <button type="button" class="map-menu-btn" id="map-menu-toggle" aria-label="Menu">${icon("menu", { spaced: false, size: 22 })}</button>
      ${hasMap ? `<button type="button" class="map-menu-btn zone-mode-btn" id="zone-mode-toggle" aria-label="Sélection par zones">${icon("lasso", { spaced: false, size: 20 })}</button>` : ""}
      <button type="button" class="map-menu-btn map-close-btn" id="map-close-btn" aria-label="Fermer la carte">${icon("x", { spaced: false, size: 22 })}</button>
      <div class="map-menu-panel" id="map-menu-panel" hidden>
        <a class="btn-link" href="#settings">${icon("settings")}Réglages</a>
        <div class="map-legend">
          <span class="legend-item">${icon("home", { spaced: false })}Départ</span>
          ${returnPoint ? `<span class="legend-item">${icon("flag", { spaced: false })}Retour dépôt</span>` : ""}
          <span class="legend-item"><span class="legend-dot" style="background:#94a3b8;"></span>À vérifier</span>
          <span class="legend-item"><span class="legend-dot" style="background:${DEFAULT_STOP_COLOR};"></span>Prêt / en tournée</span>
          <span class="legend-item"><span class="legend-dot" style="background:#22c55e;"></span>Livré</span>
          <span class="legend-item"><span class="legend-dot" style="background:#dc2626;"></span>Échec</span>
          <span class="legend-item">${icon("star", { spaced: false })}Favori</span>
          ${hasMap ? `<span class="legend-item"><span class="legend-dot" style="background:${ZONE_COLORS[0]};"></span>Anneau = zone manuelle (${icon("lasso", { spaced: false, size: 14 })})</span>` : ""}
        </div>
        ${!hasMap ? `<p class="map-menu-warn">${icon("alert-triangle", { spaced: false })}Fond de carte non téléchargé</p>` : ""}
        ${!csr ? `<p class="map-menu-warn">${icon("alert-triangle", { spaced: false })}Trajet en ligne droite (graphe routier non chargé)</p>` : ""}
      </div>
      ${
        hasMap
          ? `
      <div class="zone-hint-bar" id="zone-hint-bar" hidden>
        <span>Entoure un groupe d'arrêts au doigt, puis choisis son numéro de passage.</span>
        <button type="button" id="zone-reset-btn">Réinitialiser</button>
      </div>
      <div id="zone-confirm-panel"></div>
      `
          : ""
      }
      <div id="map-detail"></div>
      ${
        stopListHtml
          ? `
        <div class="stop-panel" id="stop-panel" data-state="collapsed">
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
  `;

  const menuToggle = containerRef.querySelector("#map-menu-toggle");
  const menuPanel = containerRef.querySelector("#map-menu-panel");
  menuToggle.addEventListener("click", () => menuPanel.toggleAttribute("hidden"));
  containerRef.querySelector("#map-close-btn")?.addEventListener("click", () => onCloseCallback?.());

  const stopPanel = containerRef.querySelector("#stop-panel");
  if (stopPanel) {
    setupStopPanelSheet(stopPanel, containerRef.querySelector("#stop-panel-toggle"));
  }

  const navApp = settings.navApp;
  const detailEl = containerRef.querySelector("#map-detail");

  function bindDeliverButton() {
    const btn = detailEl.querySelector("[data-map-deliver]");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      await markColisDeliveredDirect(btn.dataset.mapDeliver);
      await refreshMapData();
    });
  }

  const initialStopListEl = containerRef.querySelector(".stop-panel-list");
  if (initialStopListEl) bindStopListDeliverButtons(initialStopListEl);

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
      // Le bouton d'attribution "i" par defaut est en bas a droite -- pile
      // sous la feuille des arrets (.stop-panel, position:absolute sur toute
      // la largeur en bas de la carte), d'ou le chevauchement constate.
      // Repositionne en haut a gauche, seul coin libre de tout controle.
      attributionControl: false,
    });
  } catch (err) {
    console.error("[map] Échec d'initialisation de MapLibre (WebGL indisponible ?) :", err);
    const mapEl = containerRef.querySelector("#maplibre-map");
    if (mapEl) {
      mapEl.outerHTML = `<div class="empty-state">Carte indisponible sur cet appareil (WebGL non accessible dans ce navigateur). La liste des arrêts ci-dessous reste utilisable.</div>`;
    }
    // Pas de map.project() possible sans instance MapLibre -- le mode zones
    // n'a aucun sens ici, retire les elements plutot que de laisser des
    // boutons morts.
    containerRef.querySelector("#zone-mode-toggle")?.remove();
    containerRef.querySelector("#zone-draw-overlay")?.remove();
    containerRef.querySelector("#zone-hint-bar")?.remove();
    return;
  }
  mapInstance = map;
  setupZoneMode(map, geocoded, ordreParColisId);
  map.addControl(new window.maplibregl.AttributionControl({ compact: true }), "top-left");
  map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(
    new window.maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
    "top-right"
  );

  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onThemeChange = () => loadBasemapStyle(currentFlavor()).then((s) => map.setStyle(s));
  mq.addEventListener("change", onThemeChange);
  themeMediaCleanup = () => mq.removeEventListener("change", onThemeChange);

  map.on("load", async () => {
    // Bug reel corrige ici : si l'utilisateur quitte puis revient tres vite
    // sur l'ecran Carte, render() est rappelee et detruit deja mapInstance
    // (ligne ~594) avant que le "load" de CETTE instance-ci (encore en
    // cours de chargement style/tuiles au moment du render() precedent)
    // n'ait eu le temps de se declencher -- sans ce garde, la suite tentait
    // d'ajouter des sources/couches sur une instance MapLibre deja detruite
    // (exception non geree, silencieuse). mapInstance pointe alors deja
    // vers la NOUVELLE instance : `map !== mapInstance` detecte que celle-ci
    // est perimee et abandonne proprement.
    if (map !== mapInstance) return;
    await ensureMapIcons(map);
    if (map !== mapInstance) return; // re-verifie apres l'attente asynchrone
    const routeGeoJson = buildRouteGeoJson(depot, ordered, returnPoint, csr);
    const stopsGeoJson = buildStopsGeoJson(geocoded, ordreParColisId);
    const favorisGeoJson = buildFavorisGeoJson(favGeoco);
    const waypointsGeoJson = buildWaypointsGeoJson(depot, returnPoint);
    addMapLayers(map, { routeGeoJson, stopsGeoJson, favorisGeoJson, waypointsGeoJson });
    layersReady = true;

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

// Point d'entree de la fusion : idempotent tant que le slot ne change pas.
// Premier appel = rendu complet + creation MapLibre ; appels suivants =
// simple bascule de variante + rafraichissement des donnees + resize
// (obligatoire apres tout changement de taille/visibilite du conteneur,
// MapLibre ne l'observe pas lui-meme).
export async function ensureMap(slotEl, variant, { onClose } = {}) {
  onCloseCallback = onClose || null;
  const reuse = mapInstance && containerRef === slotEl;
  containerRef = slotEl;
  slotEl.dataset.mapVariant = variant;
  currentVariant = variant;
  if (reuse) {
    await refreshMapData();
    requestAnimationFrame(() => mapInstance?.resize());
    return;
  }
  await render();
  requestAnimationFrame(() => mapInstance?.resize());
}

export function isMapMounted() {
  return Boolean(mapInstance && containerRef?.isConnected);
}
