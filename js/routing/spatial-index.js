import { haversineMeters } from "../lib/geo-utils.js";

// Grille uniforme pour le snapping "point -> noeud de graphe le plus proche"
// en O(1) amorti au lieu d'un balayage lineaire sur tous les noeuds (des
// dizaines de milliers). Reconstruite en memoire au boot, jamais persistee
// (cout negligeable, largement sous la seconde meme sur 80k+ noeuds).
export function buildSpatialGrid(nodeLat, nodeLon, cellSizeDeg = 0.005) {
  const cells = new Map();
  const n = nodeLat.length;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(nodeLon[i] / cellSizeDeg);
    const cy = Math.floor(nodeLat[i] / cellSizeDeg);
    const key = cx * 1000000 + cy;
    let arr = cells.get(key);
    if (!arr) {
      arr = [];
      cells.set(key, arr);
    }
    arr.push(i);
  }
  return { cells, cellSizeDeg };
}

// Cherche le noeud le plus proche en elargissant un anneau de cellules
// autour du point jusqu'a trouver un candidat, puis explore un anneau
// supplementaire de securite (un noeud plus proche peut se trouver dans une
// cellule diagonale pas encore visitee).
export function findNearestNode(grid, nodeLat, nodeLon, lat, lon, maxRadius = 80) {
  const { cells, cellSizeDeg } = grid;
  const cx = Math.floor(lon / cellSizeDeg);
  const cy = Math.floor(lat / cellSizeDeg);

  let bestIndex = -1;
  let bestDist = Infinity;
  let foundAtRadius = -1;

  for (let radius = 0; radius <= maxRadius; radius++) {
    if (foundAtRadius !== -1 && radius > foundAtRadius + 1) break;

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        // Ne visite que la bordure de l'anneau (les cellules interieures ont
        // deja ete visitees aux radius precedents).
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const key = (cx + dx) * 1000000 + (cy + dy);
        const arr = cells.get(key);
        if (!arr) continue;
        for (const idx of arr) {
          const d = haversineMeters(lat, lon, nodeLat[idx], nodeLon[idx]);
          if (d < bestDist) {
            bestDist = d;
            bestIndex = idx;
          }
        }
      }
    }

    if (bestIndex !== -1 && foundAtRadius === -1) foundAtRadius = radius;
  }

  return { nodeIndex: bestIndex, distanceMeters: bestDist };
}
