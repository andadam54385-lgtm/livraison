// Heure d'arrivee estimee par arret. Fonctions pures, testees dans
// eta.test.mjs (sorties de tour-ui.js pour ca, comme dedup-drafts.js).
//
// Les temps de trajet (legDureeSec, poses au tri par routing-ui.js) sortent du
// graphe routier aux vitesses LEGALES A VIDE : 80 km/h sur departementale, 70,
// 50, 40, 30 en village -- aucun carrefour, aucune entree de village, aucune
// place a chercher, pas de camion. D'ou une marge FIXE sur les trajets.
//
// Historique : un apprentissage du "rythme reel" (ratio temps reel / temps
// prevu mesure entre les "Livre" du jour, affiche "rythme +22 %" en en-tete)
// a remplace un temps cette marge fixe. Retour terrain 2026-09-15 : "il y a un
// probleme avec le systeme de pourcentage, oublie, garde juste 10 % et enleve
// le visuel". Retire : seule reste la marge fixe ci-dessous. Ne pas le
// reintroduire sans en reparler.

// Marge appliquee aux seuls TRAJETS (pas a la duree d'arret, reglee a part).
export const MARGE_TRAJET = 0.1;

// Pauses REELLES du livreur (repas, chargement, imprevu) : posees a la main
// depuis l'ecran Tournee, stockees sur le tour sous forme
// [{debut, fin|null}] -- la derniere sans `fin` est la pause en cours. Elles
// repoussent les heures estimees (voir computeEtas).
export function normalisePauses(pauses) {
  if (!Array.isArray(pauses)) return [];
  return pauses
    .map((p) => {
      const debut = p && p.debut ? new Date(p.debut).getTime() : NaN;
      const fin = p && p.fin ? new Date(p.fin).getTime() : null;
      return { debut, fin: fin != null && !Number.isNaN(fin) ? fin : null };
    })
    .filter((p) => !Number.isNaN(p.debut))
    .sort((a, b) => a.debut - b.debut);
}

export function pauseEnCours(pauses) {
  return normalisePauses(pauses).find((p) => p.fin == null) || null;
}

// Duree cumulee des pauses (une pause en cours compte jusqu'a `maintenant`).
export function pauseTotalSec(pauses, maintenant = Date.now()) {
  return normalisePauses(pauses).reduce((total, p) => total + Math.max(0, (p.fin ?? maintenant) - p.debut), 0) / 1000;
}

function heureTraitement(stop) {
  const brut = stop.statutLivraison === "livre" ? stop.heureLivraison : stop.statutLivraison === "echec" ? stop.heureEchec : null;
  if (!brut) return null;
  const t = new Date(brut).getTime();
  return Number.isNaN(t) ? null : t;
}

// Cumul des temps de trajet (majores de MARGE_TRAJET) + duree d'arret a partir
// du dernier arret REELLEMENT valide (livre/echec) plutot que de la creation
// de la tournee -- un livreur en avance ou en retard doit voir des heures qui
// repartent de sa derniere livraison. Sans arret valide, repli sur la creation
// de la tournee. Un arret sans legDureeSec (vieille tournee, insertion en
// cours de route) compte 0. Retourne aussi l'heure estimee de retour au depot
// quand applicable : le trajet retour n'est pas un arret, il se deduit de
// totalDureeSec (qui inclut TOUS les tronçons, retour compris) moins les
// tronçons des arrets.
export function computeEtas(tour, stopsSorted, dwellSec, { maintenant = Date.now() } = {}) {
  let anchorTime = new Date(tour.dateCreation).getTime();
  let anchorIndex = -1;
  stopsSorted.forEach(({ stop }, i) => {
    const t = heureTraitement(stop);
    if (t != null) {
      anchorTime = t;
      anchorIndex = i;
    }
  });

  // Une pause repousse tout ce qui reste : EN COURS, l'ancre suit l'horloge
  // (les heures reculent minute par minute tant que le livreur n'a pas repris)
  // ; TERMINEE apres la derniere livraison, l'ancre est l'heure de reprise --
  // sans ca le "Fin ≈" continuait de promettre l'heure d'avant le repas.
  const pauses = normalisePauses(tour.pauses);
  const enCours = pauses.find((p) => p.fin == null);
  if (enCours) {
    anchorTime = Math.max(anchorTime, maintenant);
  } else {
    for (const p of pauses) if (p.fin > anchorTime) anchorTime = p.fin;
  }

  const facteurTrajet = 1 + MARGE_TRAJET;

  let cumulative = 0;
  const etas = new Map();
  for (let i = anchorIndex + 1; i < stopsSorted.length; i++) {
    const { stop } = stopsSorted[i];
    cumulative += (stop.legDureeSec || 0) * facteurTrajet;
    etas.set(stop.colisId, new Date(anchorTime + cumulative * 1000));
    cumulative += dwellSec;
  }

  let depotEta = null;
  if (tour.returnToDepot) {
    const sumStopLegs = stopsSorted.reduce((s, { stop }) => s + (stop.legDureeSec || 0), 0);
    const returnLegSec = Math.max(0, (tour.totalDureeSec || 0) - sumStopLegs);
    depotEta = new Date(anchorTime + (cumulative + returnLegSec * facteurTrajet) * 1000);
  }

  return { etas, depotEta, facteurTrajet, pauseEnCours: enCours || null, pauseTotalSec: pauseTotalSec(pauses, maintenant) };
}
