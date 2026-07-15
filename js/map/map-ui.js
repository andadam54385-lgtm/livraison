import { listAllColis } from "../scan/colis-store.js";
import { getActiveTour } from "../routing/tour-store.js";
import { getAllSettings } from "../settings/settings-store.js";

// Pas de fond de carte (aucune tuile externe, 100% local) : plan
// schematique en SVG, positions calculees a partir des lat/lon reelles
// avec une projection locale simple (equirectangulaire corrigee par
// cos(latitude) pour garder les proportions correctes sur une petite zone).
// Objectif : voir d'un coup d'oeil la repartition des arrets et l'ordre de
// la tournee, pas un GPS -- la navigation turn-by-turn reste deleguee a
// Apple Plans/Waze.

let containerRef = null;

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

function buildProjection(points, width, height, padding) {
  const centerLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const cosLat = Math.cos((centerLat * Math.PI) / 180) || 1;
  const toXY = (lat, lon) => ({ x: lon * cosLat, y: lat });

  const xy = points.map((p) => toXY(p.lat, p.lon));
  const minX = Math.min(...xy.map((p) => p.x));
  const maxX = Math.max(...xy.map((p) => p.x));
  const minY = Math.min(...xy.map((p) => p.y));
  const maxY = Math.max(...xy.map((p) => p.y));

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const availW = width - 2 * padding;
  const availH = height - 2 * padding;
  const scale = Math.min(availW / spanX, availH / spanY);
  const offsetX = padding + (availW - spanX * scale) / 2;
  const offsetY = padding + (availH - spanY * scale) / 2;

  return (lat, lon) => {
    const { x, y } = toXY(lat, lon);
    return {
      x: offsetX + (x - minX) * scale,
      y: offsetY + (maxY - y) * scale, // inverse : la latitude augmente vers le haut, l'axe Y du SVG vers le bas
    };
  };
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

async function render() {
  const [allColis, activeTour, settings] = await Promise.all([listAllColis(), getActiveTour(), getAllSettings()]);
  const geocoded = allColis.filter((c) => c.geocode?.lat != null && c.geocode?.lon != null);

  if (geocoded.length === 0) {
    containerRef.innerHTML = `<div class="empty-state">Aucun colis géocodé pour le moment. Scanne ou saisis des colis, puis reviens ici.</div>`;
    return;
  }

  const depot = { lat: settings.depotLat, lon: settings.depotLon };
  const points = [depot, ...geocoded.map((c) => ({ lat: c.geocode.lat, lon: c.geocode.lon }))];

  const width = 400;
  const height = 520;
  const project = buildProjection(points, width, height, 28);

  const depotXY = project(depot.lat, depot.lon);

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

  containerRef.innerHTML = `
    <div style="padding:10px 16px;">
      <div class="stats-row">
        <span class="stat-pill">🏠 Dépôt</span>
        <span class="stat-pill" style="border-color:#f59e0b;color:#f59e0b;">● À vérifier</span>
        <span class="stat-pill" style="border-color:#d97706;color:#d97706;">● Prêt / en tournée</span>
        <span class="stat-pill" style="border-color:#22c55e;color:#22c55e;">● Livré</span>
      </div>
    </div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; display:block; background:var(--bg-elevated);">
      ${routeLine}
      <rect x="${depotXY.x - 7}" y="${depotXY.y - 7}" width="14" height="14" fill="#eef2fb" stroke="#0b1220" stroke-width="2" />
      ${pins}
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
}

export async function mount(container) {
  containerRef = container;
  await render();
}
