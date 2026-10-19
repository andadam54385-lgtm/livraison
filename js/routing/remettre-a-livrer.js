// Annulation d'un "Livre" ou d'un "Echec" appuye par erreur (retour terrain
// 2026-09-15 : "remettre un colis a livrer si on a clique sans faire expres").
// Fonction pure, sans acces a la base, pour etre testable
// (remettre-a-livrer.test.mjs) ; tour-store.js l'applique dans la meme
// transaction que les autres mutations d'arret (updateTourAtomic).
//
// L'arret garde son numero d'ordre : il reprend sa place dans la tournee, et
// redevient l'arret courant s'il etait le premier encore a faire. Les heures
// et le motif sont effaces -- sans ca l'export CSV (export-tours.js) sortait
// une heure de livraison ou un motif d'echec pour un colis jamais livre.
//
// Renvoie true si l'arret a change, false sinon (colis absent de la tournee,
// ou arret deja a livrer : rien a annuler).
export function remettreArretALivrer(tour, colisId, setColisStatut) {
  const stop = (tour?.stops || []).find((s) => s.colisId === colisId);
  if (!stop) return false;
  if (stop.statutLivraison !== "livre" && stop.statutLivraison !== "echec") return false;
  stop.statutLivraison = "a_livrer";
  stop.heureLivraison = null;
  delete stop.heureEchec;
  delete stop.raisonEchec;
  setColisStatut?.(colisId, "en_tournee");
  return true;
}
