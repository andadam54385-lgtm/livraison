// Trajets que le graphe routier dit INJOIGNABLES (Infinity) -- fonctions
// pures, testees par trajet-secours.test.mjs.
//
// Bug reel (retour terrain 2026-10-01 : "le sens est trop bizarre" puis "j'ai
// perdu l'estimation en haut") : une adresse de Pompey s'accrochait a un point
// du graphe ou l'on ne peut pas ENTRER (bout de rue a sens unique) -- les 44
// trajets vers elle valaient Infinity, ceux depuis elle etaient normaux.
//   1. Optimiseur : tsp.js remplace un trajet infini par une penalite FIXE ;
//      ce point devenait une "teleportation gratuite" (y entrer coute pareil
//      d'ou qu'on vienne), et la tournee finissait loin a Saizerais en se
//      croyant ramenee gratis a Pompey -- 119 min de route au lieu de 105.
//   2. Heures estimees : un seul troncon infini rendait infinies toutes les
//      heures suivantes, le "Fin ≈" et le total ("— estimees").
// Regle : un trajet infini prend le temps du SENS INVERSE (la rue existe, le
// graphe a juste un trou dans un sens) ; si les deux sens sont infinis,
// estimation a vol d'oiseau.

// Detour route/vol d'oiseau et vitesse moyenne de village : estimation de
// secours seulement, jamais utilisee quand le graphe repond.
const DETOUR = 1.35;
const VITESSE_KMH = 40;

export function estimationVolOiseauSec(a, b) {
  if (a?.lat == null || a?.lon == null || b?.lat == null || b?.lon == null) return Infinity;
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * R * Math.asin(Math.sqrt(h));
  return ((km * DETOUR) / VITESSE_KMH) * 3600;
}

// Remplace sur place chaque trajet infini de la matrice ; renvoie le nombre
// de trajets repares. `points[i]` = {lat, lon} du point i de la matrice.
export function reparerMatrice(matrix, points) {
  const n = matrix.length;
  // Valeurs calculees d'abord sur l'etat D'ORIGINE, ecrites ensuite : une
  // reparation ne sert jamais de "sens inverse" a une autre.
  const corrections = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || Number.isFinite(matrix[i][j])) continue;
      const inverse = matrix[j][i];
      const valeur = Number.isFinite(inverse) ? inverse : estimationVolOiseauSec(points[i], points[j]);
      if (Number.isFinite(valeur)) corrections.push([i, j, valeur]);
    }
  }
  for (const [i, j, valeur] of corrections) matrix[i][j] = valeur;
  return corrections.length;
}

// Duree totale d'une tournee a afficher : totalDureeSec s'il est fini, sinon
// la somme des troncons connus (vieille tournee calculee avant ce correctif).
export function dureeTourneeSec(tour) {
  if (Number.isFinite(tour?.totalDureeSec)) return tour.totalDureeSec;
  return (tour?.stops || []).reduce((s, st) => s + (Number.isFinite(st.legDureeSec) ? st.legDureeSec : 0), 0);
}
