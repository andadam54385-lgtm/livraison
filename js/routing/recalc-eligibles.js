// Selection des colis a retrier lors d'un recalcul EN PLACE d'une tournee
// active (voir runRecalculate dans routing-ui.js). Fonction pure, sans acces
// a la base, pour etre testable (recalc-eligibles.test.mjs).
//
// Bug reel corrige ici (retour terrain : "recalcul de l'itineraire au lieu
// du calcul normal, il a rajoute 33 adresses qui n'ont rien a voir avec
// aujourd'hui"). Le recalcul reprenait listColisEligibles(), soit TOUS les
// colis "pret" + TOUS les "en_tournee" de la base -- y compris ceux d'une
// tournee qui n'existe plus. "Effacer l'historique des tournees" supprimait
// par exemple aussi la tournee ACTIVE sans toucher aux colis, qui restaient
// "en_tournee" a vie : invisibles en Etat B (la feuille n'affiche que
// tour.stops), ils resurgissaient d'un coup au recalcul suivant.
//
// Un recalcul en place ne doit retrier QUE :
//   1. les arrets de CETTE tournee pas encore traites (statutLivraison
//      "a_livrer"), dans l'ordre de la tournee ;
//   2. les colis "pret" scannes entre-temps dont l'insertion au moindre
//      detour n'a pas abouti ("sera inclus au prochain recalcul", voir
//      handleColisSaved dans tour-ui.js).
// Un colis "en_tournee" qui n'est PAS dans tour.stops est un orphelin : il
// n'est pas retrie ici. Il repasse "pret" a la fin de journee (finDeJournee)
// et redevient visible dans la preparation, ou l'utilisateur tranche.
export function pickRecalcEligibles({ tour, colisById, pretColis }) {
  const picked = new Map();
  const stops = (tour?.stops || []).slice().sort((a, b) => a.ordre - b.ordre);
  for (const stop of stops) {
    if (stop.statutLivraison !== "a_livrer") continue;
    const colis = colisById.get(stop.colisId);
    // Colis supprime entre-temps ("Effacer les colis") ou deja traite par un
    // autre chemin : l'arret n'a plus rien a retrier.
    if (!colis || colis.statut === "livre" || colis.statut === "echec") continue;
    picked.set(colis.id, colis);
  }
  for (const colis of pretColis || []) {
    if (!picked.has(colis.id)) picked.set(colis.id, colis);
  }
  return [...picked.values()];
}
