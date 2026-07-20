import { getDb } from "../db/schema.js";
import { loadCsrFromDb } from "./graph-loader.js";
import { buildSpatialGrid, findNearestNode } from "./spatial-index.js";
import { dijkstraNodeToNode, createDijkstraScratch } from "./dijkstra.js";
import { getColis } from "../scan/colis-store.js";
import { saveTour } from "./tour-store.js";

// Insertion au moindre detour : quand un colis "oublie" est retrouve et
// scanne en cours de tournee (Etat B), plutot que d'attendre un recalcul
// complet (qui re-optimiserait TOUT, y compris les arrets deja traites),
// on l'insere directement a l'endroit qui allonge le moins le trajet
// restant. Pas de re-optimisation globale : les arrets existants gardent
// leur ordre relatif, seul le nouveau s'intercale.

function isPendingStop(stop) {
  return stop.statutLivraison !== "livre" && stop.statutLivraison !== "echec";
}

function travelSeconds(csr, grid, scratch, from, to) {
  const fromNode = findNearestNode(grid, csr.nodeLat, csr.nodeLon, from.lat, from.lon).nodeIndex;
  const toNode = findNearestNode(grid, csr.nodeLat, csr.nodeLon, to.lat, to.lon).nodeIndex;
  if (fromNode === -1 || toNode === -1) return Infinity;
  const result = dijkstraNodeToNode(csr, fromNode, [toNode], scratch, { maxSeconds: 3600 });
  return result.get(toNode) ?? Infinity;
}

/**
 * @returns {Promise<{tour: object, position: number} | null>} null si le
 * graphe routier n'est pas disponible (le caller doit alors se rabattre sur
 * un simple statut "pret", inclus au prochain recalcul complet).
 */
export async function insertStopCheapest(tour, colis) {
  const db = await getDb();
  const csr = await loadCsrFromDb(db);
  if (!csr || colis.geocode?.lat == null) return null;

  const allStops = tour.stops.slice();
  const doneStops = allStops.filter((s) => !isPendingStop(s)).sort((a, b) => a.ordre - b.ordre);
  const pendingStops = allStops.filter(isPendingStop).sort((a, b) => a.ordre - b.ordre);

  // Point de reference "ou en est le livreur" : le dernier arret traite s'il
  // y en a un, sinon le point de depart d'origine -- pas de suivi GPS
  // continu, c'est la meilleure approximation disponible sans ca.
  let referencePoint = tour.depot;
  if (doneStops.length > 0) {
    const lastDoneColis = await getColis(doneStops[doneStops.length - 1].colisId);
    if (lastDoneColis?.geocode?.lat != null) {
      referencePoint = { lat: lastDoneColis.geocode.lat, lon: lastDoneColis.geocode.lon };
    }
  }

  const pendingWithColis = [];
  for (const stop of pendingStops) {
    const c = await getColis(stop.colisId);
    if (c?.geocode?.lat != null) pendingWithColis.push({ stop, colis: c });
  }

  const points = [
    referencePoint,
    ...pendingWithColis.map(({ colis: c }) => ({ lat: c.geocode.lat, lon: c.geocode.lon })),
    ...(tour.returnToDepot && tour.depotArrivee ? [tour.depotArrivee] : []),
  ];
  const newPoint = { lat: colis.geocode.lat, lon: colis.geocode.lon };

  const grid = buildSpatialGrid(csr.nodeLat, csr.nodeLon);
  const scratch = createDijkstraScratch(csr.edgeCount);

  // bestIdx = inserer juste apres points[bestIdx] (0 = tout en tete, juste
  // apres le point de reference).
  let bestIdx = 0;
  let bestExtraSec = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const aToB = travelSeconds(csr, grid, scratch, a, b);
    const aToNew = travelSeconds(csr, grid, scratch, a, newPoint);
    const newToB = travelSeconds(csr, grid, scratch, newPoint, b);
    const extra = aToNew + newToB - aToB;
    if (extra < bestExtraSec) {
      bestExtraSec = extra;
      bestIdx = i;
    }
  }

  const doneMaxOrdre = doneStops.reduce((m, s) => Math.max(m, s.ordre), 0);
  const newStop = { colisId: colis.id, ordre: 0, statutLivraison: "a_livrer", heureLivraison: null, legDureeSec: null };
  const newPendingOrder = pendingWithColis.map((x) => x.stop);
  newPendingOrder.splice(bestIdx, 0, newStop);
  newPendingOrder.forEach((s, i) => {
    s.ordre = doneMaxOrdre + i + 1;
  });

  tour.stops = [...doneStops, ...newPendingOrder];
  await saveTour(tour);
  return { tour, position: newStop.ordre };
}
