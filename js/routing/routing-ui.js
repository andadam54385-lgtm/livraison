import { getDb } from "../db/schema.js";
import { get } from "../lib/idb.js";
import { loadCsrFromDb } from "./graph-loader.js";
import { buildSpatialGrid, findNearestNode } from "./spatial-index.js";
import { buildTravelTimeMatrix } from "./matrix-builder.js";
import { optimizeTourOrder, tourCost } from "./tsp.js";
import { listColisByStatut, saveColis } from "../scan/colis-store.js";
import { createTour, getActiveTour } from "./tour-store.js";
import { getAllSettings } from "../settings/settings-store.js";
import { formatDurationShort } from "../lib/geo-utils.js";
import { emit } from "../lib/event-bus.js";

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Géolocalisation indisponible sur cet appareil."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

function routeDurationSeconds(order, matrix, startIdx) {
  let total = 0;
  let current = startIdx;
  for (const idx of order) {
    total += matrix[current][idx];
    current = idx;
  }
  return total;
}

async function runSort(container, { useGps }) {
  const statusEl = container.querySelector("#routing-status");
  const progressFill = container.querySelector("#routing-progress-fill");
  const startButtons = container.querySelectorAll(".routing-start-btn");
  startButtons.forEach((b) => (b.disabled = true));

  try {
    const settings = await getAllSettings();
    const readyColis = await listColisByStatut("pret");

    if (readyColis.length === 0) {
      statusEl.textContent = "Aucun colis prêt à trier (valide et géocode d'abord tes scans).";
      startButtons.forEach((b) => (b.disabled = false));
      return;
    }

    let start = { lat: settings.depotLat, lon: settings.depotLon, label: settings.depotLabel };
    if (useGps) {
      statusEl.textContent = "Localisation en cours…";
      try {
        const pos = await getCurrentPosition();
        start = { ...pos, label: "Position actuelle" };
      } catch (err) {
        statusEl.textContent = `Position indisponible (${err.message}), utilisation du dépôt.`;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    statusEl.textContent = "Chargement du graphe routier…";
    const db = await getDb();
    const csr = await loadCsrFromDb(db);
    if (!csr) {
      statusEl.textContent = "Graphe routier indisponible. Réimporte les données dans les réglages.";
      startButtons.forEach((b) => (b.disabled = false));
      return;
    }

    statusEl.textContent = "Positionnement des arrêts sur le réseau routier…";
    const grid = buildSpatialGrid(csr.nodeLat, csr.nodeLon);

    const points = [start, ...readyColis.map((c) => ({ lat: c.geocode.lat, lon: c.geocode.lon }))];
    const pointNodeIndices = [];
    const unsnapped = [];
    for (let i = 0; i < points.length; i++) {
      const { nodeIndex, distanceMeters } = findNearestNode(grid, csr.nodeLat, csr.nodeLon, points[i].lat, points[i].lon);
      if (nodeIndex === -1 || distanceMeters > 2000) {
        unsnapped.push(i);
      }
      pointNodeIndices.push(nodeIndex === -1 ? 0 : nodeIndex);
    }
    if (unsnapped.length > 0) {
      statusEl.textContent = `${unsnapped.length} point(s) trop loin du réseau routier connu — ils seront quand même inclus avec une estimation approximative.`;
      await new Promise((r) => setTimeout(r, 1500));
    }

    statusEl.textContent = `Calcul des temps de trajet (0/${points.length})…`;
    const matrix = await buildTravelTimeMatrix(csr, pointNodeIndices, {
      maxSeconds: 3600,
      onProgress: (done, total) => {
        statusEl.textContent = `Calcul des temps de trajet (${done}/${total})…`;
        progressFill.style.width = `${Math.round((done / total) * 100)}%`;
      },
    });

    statusEl.textContent = "Optimisation de l'ordre de tournée…";
    const stopIndices = readyColis.map((_, i) => i + 1);
    const avant12hFlags = {};
    readyColis.forEach((c, i) => {
      avant12hFlags[i + 1] = Boolean(c.avant12h);
    });
    const penaltyWeight = (settings.avant12hPenaltyMinutes || 0) * 60;

    const { order } = optimizeTourOrder(matrix, 0, stopIndices, {
      avant12hFlags,
      penaltyWeight,
      timeBudgetMs: 5000,
    });

    const totalDureeSec = routeDurationSeconds(order, matrix, 0);

    const stops = order.map((pointIdx, i) => {
      const colis = readyColis[pointIdx - 1];
      return {
        colisId: colis.id,
        ordre: i + 1,
        statutLivraison: "a_livrer",
        heureLivraison: null,
      };
    });

    const tour = await createTour({ depot: start, stops, totalDureeSec });

    for (const colis of readyColis) {
      await saveColis({ ...colis, statut: "en_tournee" });
    }

    emit("tour:computed", { tour });
    statusEl.textContent = `Tournée prête (${formatDurationShort(totalDureeSec)} estimées).`;
    location.hash = "#tour";
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Erreur: ${err.message || err}`;
  } finally {
    startButtons.forEach((b) => (b.disabled = false));
  }
}

export async function mount(container) {
  const activeTour = await getActiveTour();
  const readyColis = await listColisByStatut("pret");

  if (activeTour) {
    container.innerHTML = `
      <div class="card">
        <div class="card-title">Tournée en cours</div>
        <p class="muted">${activeTour.stops.length} arrêts, ${formatDurationShort(activeTour.totalDureeSec)} estimées.</p>
        <div class="button-row">
          <button type="button" class="primary" id="go-to-tour">Voir la tournée</button>
        </div>
      </div>
    `;
    container.querySelector("#go-to-tour").addEventListener("click", () => {
      location.hash = "#tour";
    });
    return;
  }

  container.innerHTML = `
    <div class="card">
      <div class="card-title">${readyColis.length} colis prêts à trier</div>
      <p class="muted">Les colis "à vérifier" doivent d'abord être validés et géocodés dans l'onglet Scan.</p>
    </div>
    <div class="button-row">
      <button type="button" class="primary routing-start-btn" id="sort-from-depot">Trier depuis le dépôt</button>
      <button type="button" class="routing-start-btn" id="sort-from-gps">Trier depuis ma position</button>
    </div>
    <p id="routing-status" class="muted" style="margin-top:12px;"></p>
    <div class="progress-bar"><div id="routing-progress-fill" class="progress-bar-fill" style="width:0%"></div></div>
  `;

  container.querySelector("#sort-from-depot").addEventListener("click", () => runSort(container, { useGps: false }));
  container.querySelector("#sort-from-gps").addEventListener("click", () => runSort(container, { useGps: true }));
}
