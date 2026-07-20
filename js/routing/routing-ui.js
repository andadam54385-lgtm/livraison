import { getDb } from "../db/schema.js";
import { loadCsrFromDb } from "./graph-loader.js";
import { buildSpatialGrid, findNearestNode } from "./spatial-index.js";
import { buildTravelTimeMatrix } from "./matrix-builder.js";
import { optimizeTourOrder } from "./tsp.js";
import { listColisByStatut, saveColis } from "../scan/colis-store.js";
import { createTour } from "./tour-store.js";
import { getAllSettings, setSetting } from "../settings/settings-store.js";
import { formatDurationShort } from "../lib/geo-utils.js";
import { emit } from "../lib/event-bus.js";

// Colis "eligibles" pour un (re)calcul de tournee : les tout juste geocodes
// ("pret") ET ceux d'une tournee precedente pas encore livres ("en_tournee").
// Inclure "en_tournee" est ce qui permet de recalculer une tournee en cours
// de route (nouveaux colis scannes, retard...) sans avoir a repasser
// manuellement chaque colis restant au statut "pret" -- seuls les colis deja
// "livre" sont exclus.
export async function listColisEligibles() {
  const [pret, enTournee] = await Promise.all([listColisByStatut("pret"), listColisByStatut("en_tournee")]);
  return [...pret, ...enTournee];
}

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

// Duree de chaque troncon (etape precedente -> etape courante), alignee sur
// `order` -- sert a la fois au total (somme) et a l'heure d'arrivee estimee
// par arret (cumul progressif, voir tour-ui.js).
function legDurationsSeconds(order, matrix, startIdx) {
  const legs = [];
  let current = startIdx;
  for (const idx of order) {
    legs.push(matrix[current][idx]);
    current = idx;
  }
  return legs;
}

// Ecran appelant (tour-ui.js, Etat A) : doit fournir un conteneur avec
// #routing-status, #routing-progress-fill et les boutons de declenchement
// (peu importe leur nombre/libelle, seul `useGps`/`depotReturn` importent ici).
export async function runSort(container, { useGps, depotReturn, onDone, disableButtons = [] }) {
  const statusEl = container.querySelector("#routing-status");
  const progressFill = container.querySelector("#routing-progress-fill");
  disableButtons.forEach((b) => (b.disabled = true));

  try {
    const settings = await getAllSettings();
    const eligibles = await listColisEligibles();

    if (eligibles.length === 0) {
      statusEl.textContent = "Aucun colis prêt à trier (valide et géocode d'abord tes scans).";
      disableButtons.forEach((b) => (b.disabled = false));
      return;
    }

    // Choix fait ici, au demarrage de CETTE tournee (pas un reglage global
    // fige a l'avance) -- persiste quand meme comme valeur par defaut pour
    // pre-cocher la case au prochain calcul.
    const depotReturnChecked = Boolean(depotReturn);
    await setSetting("depotReturn", depotReturnChecked);

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
      disableButtons.forEach((b) => (b.disabled = false));
      return;
    }

    statusEl.textContent = "Positionnement des arrêts sur le réseau routier…";
    const grid = buildSpatialGrid(csr.nodeLat, csr.nodeLon);

    // Si "revenir au depot" est active, le depot est ajoute une seconde fois
    // en tant que point d'arrivee fixe (voir fixedEndIdx plus bas) -- distinct
    // du point de depart, qui peut etre le depot ou la position GPS.
    const depotReturnPoint = depotReturnChecked ? { lat: settings.depotLat, lon: settings.depotLon } : null;
    const points = [
      start,
      ...eligibles.map((c) => ({ lat: c.geocode.lat, lon: c.geocode.lon })),
      ...(depotReturnPoint ? [depotReturnPoint] : []),
    ];
    const depotEndIdx = depotReturnPoint ? points.length - 1 : null;

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
    const stopIndices = eligibles.map((_, i) => i + 1);
    const avant12hFlags = {};
    eligibles.forEach((c, i) => {
      avant12hFlags[i + 1] = Boolean(c.avant12h);
    });
    const penaltyWeight = (settings.avant12hPenaltyMinutes || 0) * 60;

    const { order } = optimizeTourOrder(matrix, 0, depotEndIdx != null ? [...stopIndices, depotEndIdx] : stopIndices, {
      avant12hFlags,
      penaltyWeight,
      timeBudgetMs: 5000,
      fixedEndIdx: depotEndIdx,
    });

    const legs = legDurationsSeconds(order, matrix, 0);
    const totalDureeSec = legs.reduce((a, b) => a + b, 0);
    // fixedEndIdx (voir tsp.js) garantit que le point de retour au depot,
    // s'il existe, est toujours le tout dernier element de `order` -- les
    // legs des arrets de livraison correspondent donc directement aux
    // memes positions dans `order` (pas besoin de les re-associer).
    const deliveryOrder = depotEndIdx != null ? order.slice(0, -1) : order;

    const stops = deliveryOrder.map((pointIdx, i) => {
      const colis = eligibles[pointIdx - 1];
      return {
        colisId: colis.id,
        ordre: i + 1,
        statutLivraison: "a_livrer",
        heureLivraison: null,
        legDureeSec: legs[i],
      };
    });

    const tour = await createTour({
      depot: start,
      stops,
      totalDureeSec,
      returnToDepot: Boolean(depotReturnPoint),
      depotArrivee: depotReturnPoint ? { lat: settings.depotLat, lon: settings.depotLon, label: settings.depotLabel } : null,
    });

    for (const colis of eligibles) {
      await saveColis({ ...colis, statut: "en_tournee" });
    }

    emit("tour:computed", { tour });
    statusEl.textContent = `Tournée prête (${formatDurationShort(totalDureeSec)} estimées).`;
    onDone?.(tour);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Erreur: ${err.message || err}`;
  } finally {
    disableButtons.forEach((b) => (b.disabled = false));
  }
}
