// Autour de quoi classer les adresses proposees a la saisie (voir
// matchAdresseEntries/`pres` dans ban-index.js). Fonction pure, testee par
// points-reference.test.mjs.
//
// Retours terrain 2026-10-09 : "mettre en premier les adresses les plus
// proches", puis "sinon proche des points precedents ou deja installes, si pas
// de GPS active ou si on prepare au depot". Regle :
//   1. GPS recent ET loin du depot -> la position du livreur (il est dans sa
//      zone, il ajoute ce qu'il voit autour de lui) ;
//   2. sinon (pas de GPS, ou GPS au depot pendant la preparation) -> TOUS les
//      points deja installes (preparation + tournee du jour) : une adresse est
//      proche si elle est proche de l'un d'eux. Au depot, le GPS ne dit rien de
//      la zone de livraison, les colis deja saisis si ;
//   3. aucun point encore (premiere adresse) -> GPS s'il existe, sinon depot.
const RAYON_DEPOT_KM = 3;

function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * 111;
  const dLon = (b.lon - a.lon) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

// gps : {lat, lon} ou null ; depot : {lat, lon} ou null ; colis : tous les
// colis ; idsTournee : Set des colis de la tournee active (ses arrets deja
// livres comptent aussi : c'est la zone du jour).
export function choisirPointsDeReference({ gps = null, depot = null, colis = [], idsTournee = new Set() }) {
  const gpsValide = gps?.lat != null && gps?.lon != null ? gps : null;
  const depotValide = depot?.lat != null && depot?.lon != null ? depot : null;
  const auDepot = gpsValide && depotValide && distanceKm(gpsValide, depotValide) < RAYON_DEPOT_KM;
  if (gpsValide && !auDepot) return [gpsValide];

  const installes = colis
    .filter((c) => c?.geocode?.lat != null && c?.geocode?.lon != null)
    .filter((c) => (c.statut !== "livre" && c.statut !== "echec") || idsTournee.has(c.id))
    .map((c) => ({ lat: c.geocode.lat, lon: c.geocode.lon }));
  if (installes.length > 0) return installes;

  if (gpsValide) return [gpsValide];
  return depotValide ? [depotValide] : [];
}
