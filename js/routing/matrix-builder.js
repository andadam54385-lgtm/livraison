// Orchestration des Web Workers de routage : construit la matrice de temps
// de trajet NxN (asymetrique -- le graphe est oriente a cause des sens
// uniques et des restrictions de virage, donc duree(A->B) != duree(B->A))
// entre tous les points d'une tournee.
//
// Les jobs (une ligne = un Dijkstra depuis un point) sont independants et
// distribues en round-robin sur plusieurs workers -- necessaire depuis le
// passage au graphe "etendu par arete" (voir graph-loader.js, requis pour
// respecter les restrictions de virage) : l'etat de recherche etant une
// arete et non un noeud, le graphe de recherche est ~2x plus grand, ce qui
// ne laissait plus assez de marge avec un seul worker sur le pire cas
// (mesure reelle, voir historique). Pas de SharedArrayBuffer (eviterait la
// copie du CSR par worker) car ca demande les en-tetes COOP/COEP,
// incompatibles avec un hebergement statique simple -- chaque worker recoit
// donc sa propre copie transferee du CSR de routage.

const MAX_WORKERS = 3;

function createWorker() {
  return new Worker(new URL("./routing-worker.js", import.meta.url), { type: "module" });
}

function pickWorkerCount(rowCount) {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2;
  // Garde un coeur libre pour l'UI/le thread principal, ne depasse jamais le
  // nombre de lignes a calculer (inutile de creer plus de workers que de travail).
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1, rowCount));
}

function cloneCsrFields(fields) {
  return {
    adjOffsets: fields.adjOffsets.slice(),
    adjNeighbors: fields.adjNeighbors.slice(),
    edgeWeight: fields.edgeWeight.slice(),
    outOffsets: fields.outOffsets.slice(),
    outValues: fields.outValues.slice(),
    inOffsets: fields.inOffsets.slice(),
    inValues: fields.inValues.slice(),
    nodeCount: fields.nodeCount,
    edgeCount: fields.edgeCount,
  };
}

function transferListFor(csrCopy) {
  return [
    csrCopy.adjOffsets.buffer,
    csrCopy.adjNeighbors.buffer,
    csrCopy.edgeWeight.buffer,
    csrCopy.outOffsets.buffer,
    csrCopy.outValues.buffer,
    csrCopy.inOffsets.buffer,
    csrCopy.inValues.buffer,
  ];
}

/**
 * @param {object} csr structure CSR issue de graph-loader.js
 * @param {number[]} pointNodeIndices index de noeud de graphe pour chaque point (memes index utilises pour lignes/colonnes)
 * @param {{onProgress?: (done:number, total:number) => void, maxSeconds?: number}} options
 * @returns {Promise<Float64Array[]>} matrix[i][j] = duree en secondes de i vers j
 */
export async function buildTravelTimeMatrix(csr, pointNodeIndices, options = {}) {
  const { onProgress, maxSeconds } = options;
  const n = pointNodeIndices.length;
  const matrix = new Array(n);

  // nodeLat/nodeLon/edgeFromNode/edgeToNode ne sont pas envoyes aux workers :
  // ils ne servent qu'au snapping spatial (deja fait sur le thread principal
  // avant cet appel), pas a la recherche Dijkstra elle-meme.
  const { adjOffsets, adjNeighbors, edgeWeight, outOffsets, outValues, inOffsets, inValues, nodeCount, edgeCount } = csr;
  const csrFields = { adjOffsets, adjNeighbors, edgeWeight, outOffsets, outValues, inOffsets, inValues, nodeCount, edgeCount };

  const workerCount = pickWorkerCount(n);
  const workers = [];

  try {
    for (let w = 0; w < workerCount; w++) {
      const worker = createWorker();
      // Le dernier worker recoit les buffers d'origine (transfert zero-copy,
      // les libere sur ce thread) ; les autres recoivent une copie (le
      // meme ArrayBuffer ne peut etre transfere qu'a un seul destinataire).
      const csrCopy = w === workerCount - 1 ? csrFields : cloneCsrFields(csrFields);

      await new Promise((resolve, reject) => {
        worker.onerror = (event) => reject(event.error || new Error("Erreur worker de routage (init)"));
        worker.onmessage = (event) => {
          if (event.data.type === "ready") resolve();
        };
        worker.postMessage({ type: "init", csr: csrCopy }, transferListFor(csrCopy));
      });

      workers.push(worker);
    }

    let doneRows = 0;
    await new Promise((resolve, reject) => {
      let pending = n;
      for (const worker of workers) {
        worker.onerror = (event) => reject(event.error || new Error("Erreur worker de routage"));
        worker.onmessage = (event) => {
          const msg = event.data;
          if (msg.type !== "rowResult") return;
          matrix[msg.jobId] = msg.distances;
          doneRows++;
          onProgress?.(doneRows, n);
          pending--;
          if (pending === 0) resolve();
        };
      }
      for (let row = 0; row < n; row++) {
        const worker = workers[row % workers.length];
        worker.postMessage({
          type: "computeRow",
          jobId: row,
          sourceIdx: pointNodeIndices[row],
          targetIdxs: pointNodeIndices,
          maxSeconds,
        });
      }
    });

    return matrix;
  } finally {
    for (const worker of workers) worker.terminate();
  }
}
