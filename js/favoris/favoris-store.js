import { getDb } from "../db/schema.js";
import { get, put, del, getAll } from "../lib/idb.js";
import { uuid } from "../lib/id.js";
import { haversineMeters } from "../lib/geo-utils.js";

// Rayon de tolerance pour considerer qu'un colis geocode correspond a un
// favori existant : deux points de la meme adresse peuvent geocoder a
// quelques metres d'ecart selon le numero exact/l'imprecision BAN.
const NEARBY_TOLERANCE_M = 60;

export async function addFavori({ rue, cp, ville, lat, lon, note }) {
  const db = await getDb();
  const record = {
    id: uuid(),
    rue: rue || "",
    cp: cp || "",
    ville: ville || "",
    lat,
    lon,
    note: note || "",
    dateAjout: new Date().toISOString(),
  };
  await put(db, "favoris", record);
  return record;
}

export async function updateFavori(id, patch) {
  const db = await getDb();
  const existing = await get(db, "favoris", id);
  if (!existing) return null;
  const updated = { ...existing, ...patch, id };
  await put(db, "favoris", updated);
  return updated;
}

export async function deleteFavori(id) {
  const db = await getDb();
  return del(db, "favoris", id);
}

export async function listFavoris() {
  const db = await getDb();
  const all = await getAll(db, "favoris");
  return all.sort((a, b) => (a.ville || "").localeCompare(b.ville || "") || (a.rue || "").localeCompare(b.rue || ""));
}

// Cherche un favori proche d'un point (lat/lon), pour alerter automatiquement
// le livreur quand un colis fraichement geocode correspond a une adresse
// deja notee (ex: code portail, consigne de livraison).
export async function findNearbyFavori(lat, lon) {
  if (lat == null || lon == null) return null;
  const all = await listFavoris();
  let best = null;
  let bestDist = Infinity;
  for (const fav of all) {
    if (fav.lat == null || fav.lon == null) continue;
    const d = haversineMeters(lat, lon, fav.lat, fav.lon);
    if (d <= NEARBY_TOLERANCE_M && d < bestDist) {
      best = fav;
      bestDist = d;
    }
  }
  return best;
}
