// Dijkstra sur le graphe "etendu par arete" (voir graph-loader.js) : chaque
// etat de recherche est une arete dirigee, ce qui permet de respecter les
// restrictions de virage. Tas binaire indexe (vraie decrease-key en O(log n))
// + early-exit : la recherche s'arrete des que tous les groupes-cibles
// restants ont ete resolus, sans explorer tout le graphe.

function siftUp(heap, heapPos, dist, pos) {
  while (pos > 0) {
    const parent = (pos - 1) >> 1;
    if (dist[heap[parent]] <= dist[heap[pos]]) break;
    swapHeap(heap, heapPos, parent, pos);
    pos = parent;
  }
}

function siftDown(heap, heapPos, dist, pos, size) {
  for (;;) {
    const left = pos * 2 + 1;
    const right = left + 1;
    let smallest = pos;
    if (left < size && dist[heap[left]] < dist[heap[smallest]]) smallest = left;
    if (right < size && dist[heap[right]] < dist[heap[smallest]]) smallest = right;
    if (smallest === pos) break;
    swapHeap(heap, heapPos, pos, smallest);
    pos = smallest;
  }
}

function swapHeap(heap, heapPos, i, j) {
  const a = heap[i];
  const b = heap[j];
  heap[i] = b;
  heap[j] = a;
  heapPos[b] = i;
  heapPos[a] = j;
}

// A creer une fois par worker et reutiliser sur les ~100 appels d'une
// tournee (evite de reallouer des typed arrays a la taille du graphe a
// chaque run). Dimensionne sur le nombre d'ARETES (le graphe de recherche),
// pas le nombre de noeuds.
export function createDijkstraScratch(edgeCount) {
  return {
    dist: new Float64Array(edgeCount),
    heap: new Int32Array(edgeCount),
    heapPos: new Int32Array(edgeCount),
    settled: new Uint8Array(edgeCount),
  };
}

/**
 * Dijkstra multi-source / multi-groupe-cible generique sur les etats-aretes.
 *
 * @param {{adjOffsets:Int32Array, adjNeighbors:Int32Array, edgeWeight:Float32Array}} csr
 * @param {Array<{state:number, cost:number}>} seeds - etats de depart (couts initiaux, pour le multi-source)
 * @param {Map<number, number[]>} targetGroups - groupId -> liste d'etats-aretes dont l'atteinte resout ce groupe
 * @param {ReturnType<typeof createDijkstraScratch>} scratch
 * @param {{maxSeconds?: number}} options
 * @returns {Map<number, number>} groupId -> duree en secondes (Infinity si inatteignable)
 */
function dijkstraMultiSourceMultiTarget(csr, seeds, targetGroups, scratch, options = {}) {
  const { adjOffsets, adjNeighbors, edgeWeight } = csr;
  const maxSeconds = options.maxSeconds ?? Infinity;
  const { dist, heap, heapPos, settled } = scratch;

  dist.fill(Infinity);
  heapPos.fill(-1);
  settled.fill(0);

  let size = 0;
  const push = (state, d) => {
    dist[state] = d;
    heap[size] = state;
    heapPos[state] = size;
    size++;
    siftUp(heap, heapPos, dist, size - 1);
  };
  const pop = () => {
    const top = heap[0];
    size--;
    if (size > 0) {
      heap[0] = heap[size];
      heapPos[heap[0]] = 0;
      siftDown(heap, heapPos, dist, 0, size);
    }
    heapPos[top] = -1;
    return top;
  };
  const decreaseKey = (state, d) => {
    dist[state] = d;
    siftUp(heap, heapPos, dist, heapPos[state]);
  };

  const stateToGroup = new Map();
  for (const [groupId, states] of targetGroups) {
    for (const s of states) stateToGroup.set(s, groupId);
  }
  const remainingGroups = new Set(targetGroups.keys());
  const results = new Map();

  for (const { state, cost } of seeds) {
    if (cost > maxSeconds) continue;
    if (heapPos[state] === -1) {
      if (dist[state] === Infinity || cost < dist[state]) push(state, cost);
    } else if (cost < dist[state]) {
      decreaseKey(state, cost);
    }
  }

  while (size > 0 && remainingGroups.size > 0) {
    const state = pop();
    if (settled[state]) continue;
    settled[state] = 1;
    const d = dist[state];

    const groupId = stateToGroup.get(state);
    if (groupId !== undefined && remainingGroups.has(groupId)) {
      results.set(groupId, d);
      remainingGroups.delete(groupId);
      if (remainingGroups.size === 0) break;
    }

    if (d > maxSeconds) continue;

    const start = adjOffsets[state];
    const end = adjOffsets[state + 1];
    for (let e = start; e < end; e++) {
      const next = adjNeighbors[e];
      if (settled[next]) continue;
      const nd = d + edgeWeight[next];
      if (nd > maxSeconds || nd >= dist[next]) continue;
      if (heapPos[next] === -1) {
        push(next, nd);
      } else {
        decreaseKey(next, nd);
      }
    }
  }

  for (const g of remainingGroups) results.set(g, Infinity);
  return results;
}

/**
 * Traduit une requete "du noeud source vers plusieurs noeuds cibles" en
 * recherche sur le graphe etendu par arete : le depart seme toutes les
 * aretes sortantes du noeud source (aucune restriction ne s'applique au
 * tout premier mouvement, on ne vient de nulle part), et chaque cible est
 * resolue des que N'IMPORTE LAQUELLE de ses aretes entrantes est atteinte
 * (Dijkstra depile par distance croissante, donc la premiere trouvee est la
 * meilleure).
 *
 * @param {ReturnType<import("./graph-loader.js").buildCsrFromRawGraph>} csr
 * @param {number} sourceNodeIdx
 * @param {number[]} targetNodeIdxs
 * @param {ReturnType<typeof createDijkstraScratch>} scratch
 * @param {{maxSeconds?: number}} options
 * @returns {Map<number, number>} targetNodeIdx -> duree en secondes
 */
export function dijkstraNodeToNode(csr, sourceNodeIdx, targetNodeIdxs, scratch, options = {}) {
  const { outOffsets, outValues, inOffsets, inValues, edgeWeight } = csr;

  const results = new Map();
  const targetGroups = new Map();
  const remainingTargets = [];

  for (const t of targetNodeIdxs) {
    if (t === sourceNodeIdx) {
      results.set(t, 0);
      continue;
    }
    const states = [];
    for (let i = inOffsets[t]; i < inOffsets[t + 1]; i++) states.push(inValues[i]);
    if (states.length === 0) {
      results.set(t, Infinity); // noeud sans arete entrante : inatteignable (sauf s'il est la source, deja gere)
      continue;
    }
    targetGroups.set(t, states);
    remainingTargets.push(t);
  }

  if (remainingTargets.length > 0) {
    const seeds = [];
    for (let i = outOffsets[sourceNodeIdx]; i < outOffsets[sourceNodeIdx + 1]; i++) {
      const edgeId = outValues[i];
      seeds.push({ state: edgeId, cost: edgeWeight[edgeId] });
    }

    if (seeds.length === 0) {
      // Noeud source sans arete sortante : rien n'est atteignable depuis lui.
      for (const t of remainingTargets) results.set(t, Infinity);
    } else {
      const found = dijkstraMultiSourceMultiTarget(csr, seeds, targetGroups, scratch, options);
      for (const [t, d] of found) results.set(t, d);
    }
  }

  return results;
}
