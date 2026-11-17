import { getDb } from "../db/schema.js";
import { get, put, del, getAll } from "../lib/idb.js";
import { uuid } from "../lib/id.js";
import { haversineMeters } from "../lib/geo-utils.js";
import { favoriCorrespond, normTexte, textesFavori, rechercherDansFavoris } from "./favori-texte.js";

// Rayon de tolerance pour considerer qu'un colis geocode correspond a un
// favori existant : deux points de la meme adresse peuvent geocoder a
// quelques metres d'ecart selon le numero exact/l'imprecision BAN.
const NEARBY_TOLERANCE_M = 60;

export async function addFavori({ nom, rue, cp, ville, lat, lon, note }) {
  const db = await getDb();
  const record = {
    id: uuid(),
    nom: nom || "",
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
  // Tri numerique : « 2 Rue X » avant « 10 Rue X » (et pas l'inverse).
  const cmp = (x, y) => (x || "").localeCompare(y || "", "fr", { numeric: true, sensitivity: "base" });
  return all.sort((a, b) => cmp(a.ville, b.ville) || cmp(a.rue, b.rue));
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

// Favori designe par le TEXTE d'une adresse (nom d'entreprise ou rue + meme
// commune) -- voir favori-texte.js. Consulte AVANT la BAN au geocodage : un
// point place a la main une fois est retrouve tel quel les jours suivants.
export async function findFavoriParTexte(adresse) {
  const all = await listFavoris();
  return all.find((f) => favoriCorrespond(f, adresse)) || null;
}

export async function chercherFavoris(query, limit = 5) {
  return rechercherDansFavoris(await listFavoris(), query, limit);
}

// Retient le point GPS place A LA MAIN pour un colis (recherche d'entreprise,
// coordonnees collees, favori choisi dans la liste) : retour terrain "si on
// garde l'adresse de l'entreprise en favori, on garde aussi sa position".
// - favori deja reconnu par le texte (ou choisi : favoriId) -> son point est
//   mis a jour, et le texte scanne s'y ajoute en alias s'il differe ;
// - sinon un favori est cree (nom + adresse + point).
// Sans texte ou sans commune, rien a retrouver plus tard : rien n'est cree.
export async function memoriserPosition(colis, { favoriId = null } = {}) {
  const { lat, lon } = colis.geocode || {};
  if (lat == null || lon == null) return null;
  const nom = (colis.nom || "").trim();
  const { rue = "", cp = "", ville = "" } = colis.adresseRaw || {};
  const textes = [nom, rue.trim()].filter(Boolean);
  if (textes.length === 0) return null;

  const db = await getDb();
  const fav = favoriId ? await get(db, "favoris", favoriId) : await findFavoriParTexte({ nom, rue, cp, ville });
  if (fav) {
    const connus = textesFavori(fav);
    const alias = [...(fav.alias || [])];
    for (const t of textes) {
      if (!connus.includes(normTexte(t))) alias.push(t);
    }
    return updateFavori(fav.id, { lat, lon, nom: fav.nom || nom, alias });
  }
  if (!cp.trim() && !ville.trim()) return null;
  return addFavori({ nom, rue, cp, ville, lat, lon });
}
