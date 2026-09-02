// Tri d'ordre de visite : plus-proche-voisin puis amelioration 2-opt sur la
// matrice de temps. Pour N<=100, un passage 2-opt complet est O(N^2) et le
// cout complet O(N) -> largement sous la milliseconde par tentative, donc on
// peut se permettre plusieurs passes completes sans optimisation delta.
//
// Contraintes horaires : souples, jamais dures -- si tout ne peut pas tenir
// dans les horaires, le calcul n'echoue pas, il minimise le retard total.
//
// L'ancienne version ajoutait "position dans l'ordre x poids" au cout pour
// chaque colis "avant 12h". L'algorithme ne connaissait donc que le RANG dans
// la liste, jamais l'heure d'arrivee : avec le reglage par defaut (20 min), un
// colis en 30e position coutait 10 heures fictives, qu'aucun gain de trajet
// reel ne pouvait compenser. Un "avant 12h" finissait toujours dans les tout
// premiers, meme quand la tournee laissait largement le temps de faire 30
// points avant midi -- retour terrain explicite, c'etait le comportement le
// plus penible de l'optimiseur.
//
// Le cout est maintenant : temps de trajet + retard REEL sur les contraintes.
// Tant que l'ordre candidat respecte les horaires, la penalite est nulle et
// l'optimiseur est totalement libre de minimiser le trajet. Le modele d'heure
// d'arrivee est le meme que celui des ETA affichees (voir computeEtas dans
// tour-ui.js) : depart + trajets cumules + duree d'arret par point deja
// visite, pour que l'app n'optimise jamais sur un modele different de celui
// qu'elle affiche.
// Un troncon inatteignable (graphe deconnecte, au-dela du plafond de la
// matrice) vaut Infinity dans la matrice : sans plafond fini, le cout TOTAL
// devient Infinity pour TOUS les ordres candidats, plus aucune comparaison ne
// distingue rien, et le 2-opt ne peut plus rien ameliorer -- l'ordre reste le
// plus-proche-voisin brut, connu pour ses croisements/allers-retours. Une
// valeur finie enorme garde le point "cher" sans aveugler l'optimiseur.
const UNREACHABLE_LEG_SECONDS = 4 * 3600;

// Cout forfaitaire d'une arrivee pendant la fermeture d'un pro (~un
// repassage) -- voir le commentaire dans tourCost.
const WINDOW_MISS_SECONDS = 30 * 60;

export function tourCost(order, matrix, startIdx, timing = {}) {
  const { departureSec = 0, dwellSec = 0, deadlines = {}, closedWindows = {}, lateWeight = 10 } = timing;

  let travel = 0;
  let penalty = 0;
  let clock = departureSec;
  let current = startIdx;

  for (let pos = 0; pos < order.length; pos++) {
    const idx = order[pos];
    const rawLeg = matrix[current][idx];
    const leg = Number.isFinite(rawLeg) ? rawLeg : UNREACHABLE_LEG_SECONDS;
    travel += leg;
    clock += leg;

    const limit = deadlines[idx];
    if (limit != null && clock > limit) penalty += (clock - limit) * lateWeight;

    // Arriver pendant une fermeture (pause de midi d'un pro) : penalite
    // FORFAITAIRE, pas proportionnelle -- double bug reel corrige ici
    // (retour terrain : "des allers-retours"). (1) Ponderee x10 comme les
    // retards, une arrivee a 12h01 coutait ~20h fictives : n'importe quel
    // detour devenait "rentable", un ou deux colis "pro" tordaient toute la
    // tournee. (2) Proportionnelle a l'attente restante (win[1]-clock), elle
    // RECOMPENSAIT une arrivee tard dans le creneau (13h51 "moins cher" que
    // 12h05) -- alors que ferme, c'est ferme, l'arret est perdu pareil. Le
    // forfait (~cout reel d'un repassage) borne mecaniquement les detours
    // acceptes : l'optimiseur ne deplace un pro que si ca coute moins que
    // WINDOW_MISS_SECONDS de trajet en plus, sinon il n'y touche pas.
    // Plusieurs fenetres par arret (horaires jour par jour, voir
    // favoris/horaires.js : avant l'ouverture, la pause, apres la fermeture,
    // ou la journee entiere) ; l'ancienne forme a une seule paire [debut,
    // fin] reste acceptee.
    const wins = closedWindows[idx];
    if (wins) {
      const liste = Array.isArray(wins[0]) ? wins : [wins];
      if (liste.some(([a, b]) => clock >= a && clock < b)) penalty += WINDOW_MISS_SECONDS;
    }

    clock += dwellSec;
    current = idx;
  }

  return travel + penalty;
}

// fixedEndIdx (optionnel) : force cet index a rester le tout dernier arret
// (ex: retour au depot en fin de tournee) -- exclu du parcours glouton et
// rajoute a la fin.
export function nearestNeighborOrder(matrix, startIdx, indices, options = {}) {
  const { fixedEndIdx = null } = options;
  const remaining = new Set(indices);
  remaining.delete(startIdx);
  if (fixedEndIdx != null) remaining.delete(fixedEndIdx);
  const order = [];
  let current = startIdx;

  while (remaining.size > 0) {
    let best = -1;
    let bestCost = Infinity;
    for (const idx of remaining) {
      const c = matrix[current][idx];
      if (c < bestCost) {
        bestCost = c;
        best = idx;
      }
    }
    if (best === -1) {
      // Tous les restants sont inatteignables depuis "current" (graphe
      // deconnecte) : on les ajoute quand meme dans un ordre arbitraire
      // plutot que de bloquer le calcul.
      for (const idx of remaining) order.push(idx);
      break;
    }
    order.push(best);
    remaining.delete(best);
    current = best;
  }
  if (fixedEndIdx != null) order.push(fixedEndIdx);
  return order;
}

function reverseInPlace(arr, i, j) {
  while (i < j) {
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
    i++;
    j--;
  }
}

// lockTailCount (optionnel) : nombre d'arrets en fin de liste exclus des
// permutations (ex: 1 pour garder le retour au depot fixe en derniere
// position, voir fixedEndIdx dans optimizeTourOrder/nearestNeighborOrder).
export function twoOpt(initialOrder, matrix, startIdx, options = {}) {
  const { timing = {}, timeBudgetMs = 4000, lockTailCount = 0 } = options;
  let order = initialOrder.slice();
  const limit = order.length - lockTailCount; // [0, limit) est permutable, la queue verrouillee ne bouge jamais
  let bestCost = tourCost(order, matrix, startIdx, timing);
  const deadline = (typeof performance !== "undefined" ? performance.now() : Date.now()) + timeBudgetMs;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  let improved = limit >= 4;
  while (improved && now() < deadline) {
    improved = false;
    for (let i = 0; i < limit - 1; i++) {
      if (now() > deadline) break;
      for (let j = i + 1; j < limit; j++) {
        reverseInPlace(order, i, j);
        const cost = tourCost(order, matrix, startIdx, timing);
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          improved = true;
        } else {
          reverseInPlace(order, i, j); // annule l'essai
        }
      }
    }
  }

  return { order, cost: bestCost };
}

// fixedEndIdx (optionnel) : cet index (ex: point "retour au depot") reste
// toujours le dernier arret ; seul l'ordre des autres arrets est optimise.
export function optimizeTourOrder(matrix, startIdx, stopIndices, options = {}) {
  const { fixedEndIdx = null, ...rest } = options;
  const nnOrder = nearestNeighborOrder(matrix, startIdx, stopIndices, { fixedEndIdx });
  const lockTailCount = fixedEndIdx != null ? 1 : 0;
  return twoOpt(nnOrder, matrix, startIdx, { ...rest, lockTailCount });
}
