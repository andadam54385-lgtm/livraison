import { getDb } from "../db/schema.js";
import { get, put, getAllFromIndex } from "../lib/idb.js";
import { uuid } from "../lib/id.js";
import { getColis, saveColis } from "../scan/colis-store.js";

export async function createTour({ depot, stops, totalDureeSec }) {
  const db = await getDb();
  const tour = {
    id: uuid(),
    dateCreation: new Date().toISOString(),
    statut: "en_cours",
    depot,
    stops,
    totalDureeSec,
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
