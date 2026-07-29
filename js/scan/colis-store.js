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

// Adresse a passer aux liens de navigation GPS (deep-links.js) -- DIFFERENT de
// formatAdresseAffichage (display) : quand geocode.manual est vrai (livreur a
// colle des coordonnees GPS a la main via "Introuvable ? entreprise/zone
// industrielle...", voir scan-ui.js's acceptManualCoords), adresseAffichage
// n'est JAMAIS pose (pas de match BAN) et formatAdresseAffichage retombe alors
// sur adresseRaw -- c'est-a-dire EXACTEMENT le texte qui vient d'echouer le
// geocodage automatique. deep-links.js prefere toujours `adresse` a
// `lat,lon` des qu'un texte est present (retour terrain : precision GPS BAN
// parfois moins bonne que le geocodage Apple/Waze/Google sur une adresse
// propre) -- mais ici ce texte n'a justement RIEN de propre/fiable, et les
// coordonnees que le livreur a explicitement recuperees (copiees depuis un
// point precis sur Google Maps) sont la seule information fiable qu'on ait.
// Les ecarter au profit du texte fait recommencer Apple/Waze/Google le meme
// geocodage bancal, silencieusement, et peut renvoyer un point eloigne (bug
// terrain "adresse compressee envoyee au GPS" -- voir memoire du bug).
export function formatAdresseForNav(colis) {
  if (colis.geocode?.manual) return null;
  return formatAdresseAffichage(colis);
}
