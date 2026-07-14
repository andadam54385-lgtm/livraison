import { get } from "../lib/idb.js";

// Construit une structure CSR (Compressed Sparse Row) a partir du graph.json
// "etendu par arete" (edge-expanded / line graph) produit par data-prep (voir
// data-prep/scripts/lib/graph-builder.js). Chaque etat de recherche pour
// Dijkstra est une ARETE dirigee, pas un noeud -- c'est ce qui permet de
// respecter les restrictions de virage (une restriction interdit une
// transition d'une arete entrante vers une arete sortante a un noeud "via"
// donne, ce qui n'est pas exprimable sur un simple graphe noeud-a-noeud).
//
// nodeOutgoingEdges/nodeIncomingEdges (CSR separes) permettent de traduire
// une requete "du noeud A au noeud B" en recherche sur les etats-aretes,
// voir dijkstraNodeToNode() dans dijkstra.js.

function buildNodeEdgeCsr(listPerNode, nodeCount) {
  let total = 0;
  for (const list of listPerNode) total += list.length;

  const offsets = new Int32Array(nodeCount + 1);
  const values = new Int32Array(total);
  let cursor = 0;
  for (let i = 0; i < nodeCount; i++) {
    offsets[i] = cursor;
    const list = listPerNode[i];
    for (let j = 0; j < list.length; j++) values[cursor++] = list[j];
  }
  offsets[nodeCount] = cursor;

  return { offsets, values };
}

export function buildCsrFromRawGraph(rawGraph) {
  const { nodeCoords, edges, edgeAdjacency, nodeOutgoingEdges, nodeIncomingEdges } = rawGraph;
  const nodeCount = nodeCoords.length;
  const edgeCount = edges.length;

  const nodeLat = new Float32Array(nodeCount);
  const nodeLon = new Float32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    nodeLat[i] = nodeCoords[i][0];
    nodeLon[i] = nodeCoords[i][1];
  }

  const edgeFromNode = new Int32Array(edgeCount);
  const edgeToNode = new Int32Array(edgeCount);
  const edgeWeight = new Float32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    edgeFromNode[i] = edges[i][0];
    edgeToNode[i] = edges[i][1];
    edgeWeight[i] = edges[i][2];
  }

  let transitionCount = 0;
  for (const list of edgeAdjacency) transitionCount += list.length;
  const adjOffsets = new Int32Array(edgeCount + 1);
  const adjNeighbors = new Int32Array(transitionCount);
  {
    let cursor = 0;
    for (let i = 0; i < edgeCount; i++) {
      adjOffsets[i] = cursor;
      const list = edgeAdjacency[i];
      for (let j = 0; j < list.length; j++) adjNeighbors[cursor++] = list[j];
    }
    adjOffsets[edgeCount] = cursor;
  }

  const outCsr = buildNodeEdgeCsr(nodeOutgoingEdges, nodeCount);
  const inCsr = buildNodeEdgeCsr(nodeIncomingEdges, nodeCount);

  return {
    nodeLat,
    nodeLon,
    edgeFromNode,
    edgeToNode,
    edgeWeight,
    adjOffsets,
    adjNeighbors,
    outOffsets: outCsr.offsets,
    outValues: outCsr.values,
    inOffsets: inCsr.offsets,
    inValues: inCsr.values,
    nodeCount,
    edgeCount,
    bbox: rawGraph.bbox,
  };
}

export async function loadCsrFromDb(db) {
  const record = await get(db, "graphCSR", "current");
  if (!record) return null;
  return record;
}
