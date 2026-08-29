// Recherche en ligne de lieux/entreprises via Nominatim (le geocodeur
// public d'OpenStreetMap) -- retour terrain : "je veux que depuis l'app on
// trouve l'adresse" (d'une entreprise/zone industrielle introuvable dans la
// BAN, qui ne connait que les adresses officielles, jamais les noms
// d'etablissements). Avant ce module, le seul recours etait d'ouvrir Google
// Maps a cote, faire un appui long sur le bon point, copier les coordonnees
// et revenir les coller -- penible et source d'erreurs.
//
// Seule fonctionnalite de l'app a DEPENDRE du reseau (le reste est
// offline-first) : assume, ce cas d'usage est irrealisable hors ligne (une
// base mondiale d'etablissements ne tient pas dans l'app) et l'ancien
// detour par Google Maps exigeait deja du reseau. L'appelant doit donc
// toujours prevoir le cas "echec reseau" (voir scan-ui.js).
//
// Politique d'usage Nominatim (https://operations.osmfoundation.org/policies/nominatim/) :
// max 1 requete/seconde, usage leger -- respecte ici par construction :
// recherche declenchee par un BOUTON explicite (jamais a la frappe), pour
// une poignee de colis par jour au pire.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export async function searchOnlinePlaces(query, { limit = 5 } = {}) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    countrycodes: "fr",
    limit: String(limit),
    "accept-language": "fr",
  });
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Recherche en ligne indisponible (HTTP ${res.status})`);
  const rows = await res.json();
  return rows
    .map((r) => ({
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      label: r.display_name || r.name || `${r.lat}, ${r.lon}`,
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}
