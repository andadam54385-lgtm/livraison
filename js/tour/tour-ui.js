import { getActiveTour, markStopDelivered, archiveTour } from "../routing/tour-store.js";
import { getColis } from "../scan/colis-store.js";
import { getSetting } from "../settings/settings-store.js";
import { buildNavUrl } from "./deep-links.js";
import { formatDurationShort } from "../lib/geo-utils.js";

let containerRef = null;

export async function mount(container) {
  containerRef = container;
  await render();
}

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

function renderStopCard(stop, colis, navApp) {
  if (!colis) {
    return `<div class="card"><div class="muted">Colis introuvable (${escapeAttr(stop.colisId)})</div></div>`;
  }
  const delivered = stop.statutLivraison === "livre";
  const adresse = `${colis.adresseRaw?.rue || ""}, ${colis.adresseRaw?.cp || ""} ${colis.adresseRaw?.ville || ""}`;
  const navUrl = colis.geocode?.lat
    ? buildNavUrl(navApp, { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom })
    : null;

  return `
    <div class="card" style="${delivered ? "opacity:0.5;" : ""}">
      <div class="card-row">
        <div class="card-title">#${stop.ordre} ${colis.nom || "(nom inconnu)"}</div>
        ${colis.avant12h ? '<span class="badge badge-warn">Avant 12h</span>' : ""}
      </div>
      <div class="muted">${adresse}</div>
      ${colis.quantite > 1 ? `<span class="badge badge-pending" style="margin-top:4px;">${colis.quantite} colis</span>` : ""}
      <div class="button-row">
        ${colis.tel ? `<a class="btn-link" href="tel:${colis.tel}">📞 Appeler</a>` : ""}
        ${navUrl ? `<a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener">🧭 Naviguer</a>` : ""}
        ${
          delivered
            ? `<button type="button" disabled>Livré ✓</button>`
            : `<button type="button" class="primary" data-deliver-ordre="${stop.ordre}">Livré</button>`
        }
      </div>
    </div>
  `;
}

async function render() {
  const tour = await getActiveTour();
  const progressFill = document.getElementById("tour-progress-fill");

  if (!tour) {
    if (progressFill) progressFill.style.width = "0%";
    containerRef.innerHTML = `<div class="empty-state">Aucune tournée en cours. Va dans l'onglet "Trier" pour en créer une.</div>`;
    return;
  }

  const navApp = await getSetting("navApp");
  const stopsWithColis = await Promise.all(
    tour.stops
      .slice()
      .sort((a, b) => a.ordre - b.ordre)
      .map(async (stop) => ({ stop, colis: await getColis(stop.colisId) }))
  );

  const delivered = stopsWithColis.filter((s) => s.stop.statutLivraison === "livre").length;
  const total = stopsWithColis.length;
  if (progressFill) {
    progressFill.style.width = `${total === 0 ? 0 : Math.round((delivered / total) * 100)}%`;
  }

  containerRef.innerHTML = `
    <div class="card">
      <div class="card-row">
        <span class="muted">${delivered}/${total} livrés</span>
        <span class="muted">${formatDurationShort(tour.totalDureeSec)} estimées</span>
      </div>
    </div>
    ${stopsWithColis.map(({ stop, colis }) => renderStopCard(stop, colis, navApp)).join("")}
    <div class="button-row">
      <button type="button" class="danger" id="new-tour-btn">Nouvelle tournée</button>
    </div>
  `;

  containerRef.querySelectorAll("[data-deliver-ordre]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await markStopDelivered(tour.id, Number(btn.dataset.deliverOrdre));
      render();
    });
  });

  containerRef.querySelector("#new-tour-btn").addEventListener("click", async () => {
    if (!confirm("Archiver la tournée en cours et en démarrer une nouvelle ?")) return;
    await archiveTour(tour.id);
    location.hash = "#routing";
  });
}
