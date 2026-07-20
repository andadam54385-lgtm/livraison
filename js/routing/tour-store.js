import { getDb } from "../db/schema.js";
import { get, put, getAllFromIndex } from "../lib/idb.js";
import { uuid } from "../lib/id.js";
import { getColis, saveColis } from "../scan/colis-store.js";

export async function createTour({ depot, stops, totalDureeSec, returnToDepot = false, depotArrivee = null }) {
  const db = await getDb();
  const tour = {
    id: uuid(),
    dateCreation: new Date().toISOString(),
    statut: "en_cours",
    depot,
    stops,
    totalDureeSec,
    returnToDepot,
    depotArrivee,
  };
  await put(db, "tours", tour);
  return tour;
}

export async function getActiveTour() {
  const db = await getDb();
  const tours = await getAllFromIndex(db, "tours", "by_statut", "en_cours");
  return tours[0] || null;
}

export async function saveTour(tour) {
  const db = await getDb();
  await put(db, "tours", tour);
  return tour;
}

export async function archiveTour(tourId) {
  const db = await getDb();
  const tour = await get(db, "tours", tourId);
  if (!tour) return null;
  tour.statut = "archivee";
  await put(db, "tours", tour);
  return tour;
}

export async function markStopDelivered(tourId, ordre) {
  const db = await getDb();
  const tour = await get(db, "tours", tourId);
  if (!tour) return null;
  const stop = tour.stops.find((s) => s.ordre === ordre);
  if (stop) {
    stop.statutLivraison = "livre";
    stop.heureLivraison = new Date().toISOString();
    // Garde colis.statut synchronise avec l'etat de la tournee, sinon la
    // fiche colis reste marquee "en_tournee" indefiniment.
    const colis = await getColis(stop.colisId);
    if (colis) {
      colis.statut = "livre";
      await saveColis(colis);
    }
  }
  await put(db, "tours", tour);
  return tour;
}

// Echec de livraison (absent, acces impossible...) : distinct de "livre",
// avec une raison libre courte -- sert de base au chantier F (report des
// non-livres au lendemain), pas encore implemente ici (le colis reste tel
// quel, aucune reintegration automatique).
export async function markStopFailed(tourId, ordre, raison) {
  const db = await getDb();
  const tour = await get(db, "tours", tourId);
  if (!tour) return null;
  const stop = tour.stops.find((s) => s.ordre === ordre);
  if (stop) {
    stop.statutLivraison = "echec";
    stop.raisonEchec = raison || "";
    stop.heureEchec = new Date().toISOString();
    const colis = await getColis(stop.colisId);
    if (colis) {
      colis.statut = "echec";
      await saveColis(colis);
    }
  }
  await put(db, "tours", tour);
  return tour;
}

// Echange la position (ordre) d'un arret avec son voisin immediat --
// reordonnancement manuel simple (boutons ▲▼), plus fiable sur mobile qu'un
// glisser-deposer. direction: -1 (remonte, plus tot) ou +1 (descend, plus tard).
// Les temps de trajet (legDureeSec) restent ceux calcules pour l'ordre
// d'origine : apres un deplacement manuel, l'heure d'arrivee estimee est donc
// approximative tant que la tournee n'est pas recalculee.
export async function moveStop(tourId, ordre, direction) {
  const db = await getDb();
  const tour = await get(db, "tours", tourId);
  if (!tour) return null;
  const stops = tour.stops.slice().sort((a, b) => a.ordre - b.ordre);
  const idx = stops.findIndex((s) => s.ordre === ordre);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= stops.length) return tour;
  const tmp = stops[idx].ordre;
  stops[idx].ordre = stops[swapIdx].ordre;
  stops[swapIdx].ordre = tmp;
  tour.stops = stops;
  await put(db, "tours", tour);
  return tour;
}

async function listAllTours(db) {
  const [enCours, archivees] = await Promise.all([
    getAllFromIndex(db, "tours", "by_statut", "en_cours"),
    getAllFromIndex(db, "tours", "by_statut", "archivee"),
  ]);
  return [...enCours, ...archivees];
}

// Petit bilan du jour (colis livres, tournees calculees, duree estimee
// cumulee) -- calcule a la volee a partir des tournees en cours + archivees,
// pas d'agregat persiste separement.
export async function getTodayStats() {
  const db = await getDb();
  const todayStr = new Date().toISOString().slice(0, 10);
  const tours = await listAllTours(db);
  let livres = 0;
  let echecs = 0;
  let dureeEstimeeSec = 0;
  let toursCount = 0;
  for (const tour of tours) {
    if ((tour.dateCreation || "").slice(0, 10) === todayStr) {
      dureeEstimeeSec += tour.totalDureeSec || 0;
      toursCount++;
    }
    for (const stop of tour.stops) {
      if (stop.statutLivraison === "livre" && (stop.heureLivraison || "").slice(0, 10) === todayStr) {
        livres++;
      }
      if (stop.statutLivraison === "echec" && (stop.heureEchec || "").slice(0, 10) === todayStr) {
        echecs++;
      }
    }
  }
  return { livres, echecs, dureeEstimeeSec, toursCount };
}

// Marque un colis livre directement depuis la liste (hors ecran Tournee).
// Si le colis appartient a la tournee active, synchronise aussi l'arret
// correspondant pour eviter toute incoherence entre les deux ecrans.
export async function markColisDeliveredDirect(colisId) {
  const db = await getDb();
  const colis = await getColis(colisId);
  if (!colis) return null;
  colis.statut = "livre";
  await saveColis(colis);

  const activeTour = await getActiveTour();
  if (activeTour) {
    const stop = activeTour.stops.find((s) => s.colisId === colisId);
    if (stop && stop.statutLivraison !== "livre") {
      stop.statutLivraison = "livre";
      stop.heureLivraison = new Date().toISOString();
      await put(db, "tours", activeTour);
    }
  }
  return colis;
}
