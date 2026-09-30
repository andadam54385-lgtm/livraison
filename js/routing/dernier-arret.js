// "Dernier arret" (retour terrain 2026-09-30 : "rajoute la possibilite de
// mettre un point comme le dernier") -- colis.dernier = true, un seul colis a
// la fois, pose depuis la fiche colis. Fonctions pures, sans acces a la base,
// pour etre testables (dernier-arret.test.mjs) ; les appelants (tour-store,
// routing-ui, insert-stop) les appliquent.

// Arret encore a faire (ni livre ni en echec) -- meme definition que
// isPending (tour-ui.js) et reverseRemainingStops (tour-store.js).
function estAFaire(stop) {
  return stop.statutLivraison !== "livre" && stop.statutLivraison !== "echec";
}

// Tournee en cours : fait passer l'arret de ce colis APRES tous les autres
// arrets encore a faire. Les arrets deja traites gardent leur numero ; les
// arrets a faire se repartissent LEURS numeros existants (meme principe que
// reverseRemainingStops), donc aucun numero ne change de main avec un arret
// traite. Renvoie true si l'ordre a change.
export function deplacerEnDernier(tour, colisId) {
  const stops = (tour?.stops || []).slice().sort((a, b) => a.ordre - b.ordre);
  const aFaire = stops.filter(estAFaire);
  const cible = aFaire.find((s) => s.colisId === colisId);
  if (!cible || aFaire[aFaire.length - 1] === cible) return false;
  const numeros = aFaire.map((s) => s.ordre);
  const nouvelOrdre = aFaire.filter((s) => s !== cible).concat(cible);
  nouvelOrdre.forEach((s, i) => {
    s.ordre = numeros[i];
  });
  tour.stops = stops;
  return true;
}

// Calcul de tournee (Optimiser, recalcul) : index de point (i + 1, le point
// 0 etant le depart) du colis marque "dernier" parmi les eligibles, ou null.
// Si plusieurs sont marques (ne devrait pas arriver, la fiche n'en garde
// qu'un), le plus recemment scanne gagne -- les autres restent des arrets
// normaux.
export function indexDernier(eligibles) {
  let meilleur = null;
  eligibles.forEach((c, i) => {
    if (!c?.dernier) return;
    if (meilleur == null || String(c.dateScan || "") > String(eligibles[meilleur - 1].dateScan || "")) meilleur = i + 1;
  });
  return meilleur;
}

// Insertion au moindre detour (insert-stop.js) : un colis ajoute en route ne
// doit jamais passer APRES l'arret marque "dernier". `pendingColis` = colis
// des arrets a faire, dans l'ordre. Vrai si le dernier d'entre eux est marque
// "dernier" -- l'appelant retire alors l'emplacement qui le suit.
export function dernierEnQueue(pendingColis) {
  const dernier = pendingColis[pendingColis.length - 1];
  return Boolean(dernier?.dernier);
}
