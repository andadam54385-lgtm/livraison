import { getDb } from "../db/schema.js";
import { get, put, getAllFromIndex } from "../lib/idb.js";
import { uuid } from "../lib/id.js";

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
  }
  await put(db, "tours", tour);
  return tour;
}
