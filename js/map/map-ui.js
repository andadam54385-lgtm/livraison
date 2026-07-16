import { listAllColis } from "../scan/colis-store.js";
import { getActiveTour } from "../routing/tour-store.js";
import { getAllSettings } from "../settings/settings-store.js";
import { getDb } from "../db/schema.js";
import { loadCsrFromDb } from "../routing/graph-loader.js";
import { listFavoris } from "../favoris/favoris-store.js";

// Pas de fond de carte (aucune tuile externe, 100% local) : plan
// schematique en SVG, positions calculees a partir des lat/lon reelles avec
// une projection locale simple (equirectangulaire corrigee par cos(latitude)
// pour garder les proportions correctes sur une petite zone). Pour donner un
// vrai repere geographique (le plan de points seul n'etait pas exploitable),
// le trace des rues environnantes est dessine a partir du graphe routier deja
// charge en local pour Module 3 (memes donnees, pas de nouveau telechargement)
// et les communes concernees sont etiquetees par leur nom.

let containerRef = null;

const MAX_STREET_SEGMENTS = 2500;

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

// Bbox des points a afficher, elargie d'une marge (paddingRatio) pour laisser
// de la place au contexte routier/communes autour des arrets, pas juste un
// cadrage serre sur les pins.
function computeBBox(points, paddingRatio) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const padLat = Math.max((maxLat - minLat) * paddingRatio, 0.006);
  const padLon = Math.max((maxLon - minLon) * paddingRatio, 0.006);
  return {
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
    minLon: minLon - padLon,
    maxLon: maxLon + padLon,
  };
}

function buildProjection(bbox, width, height, padding) {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const cosLat = Math.cos((centerLat * Math.PI) / 180) || 1;
  const minX = bbox.minLon * cosLat;
  const maxX = bbox.maxLon * cosLat;
  const minY = bbox.minLat;
  const maxY = bbox.maxLat;

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const availW = width - 2 * padding;
  const availH = height - 2 * padding;
  const scale = Math.min(availW / spanX, availH / spanY);
  const offsetX = padding + (availW - spanX * scale) / 2;
  const offsetY = padding + (availH - spanY * scale) / 2;

  return (lat, lon) => {
    const x = lon * cosLat;
    const y = lat;
    return {
      x: offsetX + (x - minX) * scale,
      y: offsetY + (maxY - y) * scale, // inverse : la latitude augmente vers le haut, l'axe Y du SVG vers le bas
    };
  };
}

// Dessine les segments du graphe routier (deja en IndexedDB pour le module de
// tri) qui tombent dans la zone visible, pour donner un vrai repere de rues
// plutot qu'un nuage de points abstrait. Dedupe les aretes aller/retour
// (graphe etendu par arete : A->B et B->A sont deux entrees distinctes) et
// plafonne le nombre de segments pour rester fluide sur mobile.
function buildStreetLines(csr, bbox, project) {
  if (!csr) return "";
  const { nodeLat, nodeLon, edgeFromNode, edgeToNode, edgeCount } = csr;
  const seen = new Set();
  let html = "";
  let count = 0;
  for (let i = 0; i < edgeCount && count < MAX_STREET_SEGMENTS; i++) {
    const from = edgeFromNode[i];
    const to = edgeToNode[i];
    const latF = nodeLat[from];
    const lonF = nodeLon[from];
    const latT = nodeLat[to];
    const lonT = nodeLon[to];
    const inBBox =
      (latF >= bbox.minLat && latF <= bbox.maxLat && lonF >= bbox.minLon && lonF <= bbox.maxLon) ||
      (latT >= bbox.minLat && latT <= bbox.maxLat && lonT >= bbox.minLon && lonT <= bbox.maxLon);
    if (!inBBox) continue;
    const key = from < to ? `${from}_${to}` : `${to}_${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
    const a = project(latF, lonF);
    const b = project(latT, lonT);
    html += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#3a4a63" stroke-width="1" opacity="0.65" />`;
  }
  return html;
}

// Etiquette chaque commune distincte des colis geocodes, au centroide de ses
// arrets -- donne un repere "je suis a peu pres a [ville]" au premier regard.
function buildCityLabels(geocoded, project) {
  const groups = new Map();
  for (const c of geocoded) {
    const ville = (c.adresseRaw?.ville || "").trim();
    if (!ville) continue;
    if (!groups.has(ville)) groups.set(ville, []);
    groups.get(ville).push(c);
  }
  let html = "";
  for (const [ville, list] of groups) {
    const pts = list.map((c) => project(c.geocode.lat, c.geocode.lon));
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    html += `<text x="${cx.toFixed(1)}" y="${(cy - 16).toFixed(1)}" text-anchor="middle" font-size="11" fill="#c7d2e0" style="pointer-events:none;">${escapeAttr(ville)}</text>`;
  }
  return html;
}

function colorForColis(c) {
  if (c.statut === "livre") return "#22c55e";
  if (c.statut === "a_verifier") return "#f59e0b";
  return "#d97706"; // pret / en_tournee
}

function formatColisDetail(c) {
  const adresse = `${c.adresseRaw?.rue || ""}, ${c.adresseRaw?.cp || ""} ${c.adresseRaw?.ville || ""}`;
  return `
    <div class="card-title">${c.nom || "(nom inconnu)"}</div>
    <div class="muted">${adresse}</div>
    <div class="stats-row">
      ${c.avant12h ? '<span class="badge badge-warn">Avant 12h</span>' : ""}
      ${c.quantite > 1 ? `<span class="badge badge-pending">${c.quantite} colis</span>` : ""}
    </div>
    ${c.tel ? `<a class="btn-link" style="margin-top:8px;" href="tel:${c.tel}">📞 ${c.tel}</a>` : ""}
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

async function render() {
  const db = await getDb();
  const [allColis, activeTour, settings, csr, favoris] = await Promise.all([
    listAllColis(),
    getActiveTour(),
    getAllSettings(),
    loadCsrFromDb(db),
    listFavoris(),
  ]);
  const geocoded = allColis.filter((c) => c.geocode?.lat != null && c.geocode?.lon != null);

  if (geocoded.length === 0) {
    containerRef.innerHTML = `<div class="empty-state">Aucun colis géocodé pour le moment. Scanne ou saisis des colis, puis reviens ici.</div>`;
    return;
  }

  const depot = { lat: settings.depotLat, lon: settings.depotLon };
  const favGeoco = favoris.filter((f) => f.lat != null && f.lon != null);
  const points = [
    depot,
    ...geocoded.map((c) => ({ lat: c.geocode.lat, lon: c.geocode.lon })),
    ...favGeoco.map((f) => ({ lat: f.lat, lon: f.lon })),
  ];

  const width = 400;
  const height = 520;
  const bbox = computeBBox(points, 0.35);
  const project = buildProjection(bbox, width, height, 28);

  const depotXY = project(depot.lat, depot.lon);
  const streetLines = buildStreetLines(csr, bbox, project);
  const cityLabels = buildCityLabels(geocoded, project);

  let routeLine = "";
  if (activeTour) {
    const byColisId = new Map(geocoded.map((c) => [c.id, c]));
    const ordered = activeTour.stops
      .slice()
      .sort((a, b) => a.ordre - b.ordre)
      .map((s) => byColisId.get(s.colisId))
      .filter(Boolean);
    const routePoints = [depotXY, ...ordered.map((c) => project(c.geocode.lat, c.geocode.lon))];
    routeLine = `<polyline points="${routePoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="none" stroke="#d97706" stroke-width="2" stroke-dasharray="5,4" opacity="0.7" />`;
  }

  const pins = geocoded
    .map((c) => {
      const { x, y } = project(c.geocode.lat, c.geocode.lon);
      const color = colorForColis(c);
      const faded = c.statut === "livre" ? "opacity:0.55;" : "";
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${color}" stroke="#0b1220" stroke-width="2" style="${faded}cursor:pointer;" data-colis-id="${escapeAttr(c.id)}" />`;
    })
    .join("");

  const favPins = favGeoco
    .map((f) => {
      const { x, y } = project(f.lat, f.lon);
      return `<text x="${x.toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="middle" font-size="16" style="cursor:pointer;" data-favori-id="${escapeAttr(f.id)}">⭐</text>`;
    })
    .join("");

  containerRef.innerHTML = `
    <div style="padding:10px 16px;">
      <div class="stats-row">
        <span class="stat-pill">🏠 Dépôt</span>
        <span class="stat-pill" style="border-color:#f59e0b;color:#f59e0b;">● À vérifier</span>
        <span class="stat-pill" style="border-color:#d97706;color:#d97706;">● Prêt / en tournée</span>
        <span class="stat-pill" style="border-color:#22c55e;color:#22c55e;">● Livré</span>
        <span class="stat-pill">⭐ Favori</span>
      </div>
    </div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; background:var(--bg-elevated);">
      ${streetLines}
      ${routeLine}
      <rect x="${depotXY.x - 7}" y="${depotXY.y - 7}" width="14" height="14" fill="#eef2fb" stroke="#0b1220" stroke-width="2" />
      ${cityLabels}
      ${pins}
      ${favPins}
    </svg>
    <div id="map-detail" style="padding:12px 16px;"></div>
  `;

  const detailEl = containerRef.querySelector("#map-detail");
  containerRef.querySelectorAll("[data-colis-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const colis = geocoded.find((c) => c.id === el.dataset.colisId);
      if (!colis) return;
      detailEl.innerHTML = `<div class="card">${formatColisDetail(colis)}</div>`;
    });
  });
  containerRef.querySelectorAll("[data-favori-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const fav = favGeoco.find((f) => f.id === el.dataset.favoriId);
      if (!fav) return;
      detailEl.innerHTML = `<div class="card">${formatFavoriDetail(fav)}</div>`;
    });
  });
}

export async function mount(container) {
  containerRef = container;
  await render();
}
