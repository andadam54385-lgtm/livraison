import { getDb } from "../db/schema.js";
import { get, put, del, getAll, getAllFromIndex } from "../lib/idb.js";
import { uuid } from "../lib/id.js";

export async function isDuplicateTracking(tracking) {
  if (!tracking) return false;
  const db = await getDb();
  const existing = await get(db, "colis", tracking);
  return Boolean(existing);
}

export async function saveColis(colis) {
  const db = await getDb();
  const id = colis.id || colis.tracking || uuid();
  const record = { ...colis, id };
  await put(db, "colis", record);
  return record;
}

export async function getColis(id) {
  const db = await getDb();
  return get(db, "colis", id);
}

export async function deleteColis(id) {
  const db = await getDb();
  return del(db, "colis", id);
}

export async function listAllColis() {
  const db = await getDb();
  const all = await getAll(db, "colis");
  return all.sort((a, b) => (a.dateScan || "").localeCompare(b.dateScan || ""));
}

export async function listColisByStatut(statut) {
  const db = await getDb();
  return getAllFromIndex(db, "colis", "by_statut", statut);
}

// Adresse a AFFICHER (toute l'UI doit passer par ici, jamais reconstruire a
// la main depuis adresseRaw) : une fois le colis geocode, adresseAffichage
// contient l'adresse canonique de la BAN (bien casee, complete -- voir
// geocode-ui.js/formatEntry, pose au moment du match dans scan-ui.js). Avant
// geocodage, repli sur adresseRaw (texte OCR/saisie tel quel, jamais une
// forme normalisee : normalizeStreet/normalizeCity ne servent qu'au matching
// interne, voir geocode/normalize-address.js).
export function formatAdresseAffichage(colis) {
  if (colis.adresseAffichage) return colis.adresseAffichage;
  const rue = colis.adresseRaw?.rue || "";
  const cp = colis.adresseRaw?.cp || "";
  const ville = colis.adresseRaw?.ville || "";
  if (!rue && !cp && !ville) return "(adresse à vérifier)";
  return `${rue}, ${cp} ${ville}`.trim();
}
