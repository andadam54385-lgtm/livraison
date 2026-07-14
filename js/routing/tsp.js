// Tri d'ordre de visite : plus-proche-voisin puis amelioration 2-opt sur la
// matrice de temps. Pour N<=100, un passage 2-opt complet est O(N^2) et le
// cout complet O(N) -> largement sous la milliseconde par tentative, donc on
// peut se permettre plusieurs passes completes sans optimisation delta.
//
// La contrainte "avant 12h" est une penalite souple ajoutee au cout total
// (position dans l'ordre x poids), jamais une contrainte dure : le calcul
// n'echoue jamais, il pousse juste les colis marques vers le debut de
// tournee quand c'est rentable.

export function tourCost(order, matrix, startIdx, penaltyWeight, avant12hFlags) {
  let cost = 0;
  let current = startIdx;
  for (let pos = 0; pos < order.length; pos++) {
    const idx = order[pos];
    cost += matrix[current][idx];
    if (avant12hFlags[idx]) cost += pos * penaltyWeight;
    current = idx;
  }
  return cost;
}

export function nearestNeighborOrder(matrix, startIdx, indices) {
  const remaining = new Set(indices);
  remaining.delete(startIdx);
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

export function twoOpt(initialOrder, matrix, startIdx, options = {}) {
  const { avant12hFlags = {}, penaltyWeight = 0, timeBudgetMs = 4000 } = options;
  let order = initialOrder.slice();
  let bestCost = tourCost(order, matrix, startIdx, penaltyWeight, avant12hFlags);
  const deadline = (typeof performance !== "undefined" ? performance.now() : Date.now()) + timeBudgetMs;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  let improved = order.length >= 4;
  while (improved && now() < deadline) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      if (now() > deadline) break;
      for (let j = i + 1; j < order.length; j++) {
        reverseInPlace(order, i, j);
        const cost = tourCost(order, matrix, startIdx, penaltyWeight, avant12hFlags);
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

export function optimizeTourOrder(matrix, startIdx, stopIndices, options = {}) {
  const nnOrder = nearestNeighborOrder(matrix, startIdx, stopIndices);
  return twoOpt(nnOrder, matrix, startIdx, options);
}
