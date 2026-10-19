import { dijkstraNodeToNode, createDijkstraScratch } from "./dijkstra.js";

let csr = null;
let scratch = null;

self.onmessage = (event) => {
  const msg = event.data;

  if (msg.type === "init") {
    csr = msg.csr;
    scratch = createDijkstraScratch(csr.edgeCount); // etat de recherche = arete, pas noeud
    self.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "computeRow") {
    const { jobId, sourceIdx, targetIdxs, maxSeconds } = msg;
    const resultMap = dijkstraNodeToNode(csr, sourceIdx, targetIdxs, scratch, { maxSeconds });
    const distances = new Float64Array(targetIdxs.length);
    for (let i = 0; i < targetIdxs.length; i++) {
      distances[i] = resultMap.get(targetIdxs[i]);
    }
    self.postMessage({ type: "rowResult", jobId, distances }, [distances.buffer]);
  }
};
