// Heure d'arrivee estimee par arret, et apprentissage du RYTHME REEL du
// livreur au fil de la journee. Fonctions pures, testees dans eta.test.mjs
// (sorties de tour-ui.js pour ca, comme dedup-drafts.js).
//
// Les temps de trajet (legDureeSec, poses au tri par routing-ui.js) sortent du
// graphe routier aux vitesses LEGALES A VIDE : 80 km/h sur departementale, 70,
// 50, 40, 30 en village -- aucun carrefour, aucune entree de village, aucune
// place a chercher, pas de camion. Retour terrain 2026-09-10 : "plus j'avance,
// plus je perds de temps". L'heure du prochain arret repart bien du dernier
// "Livre" reel, mais le retard pris sur chaque tronçon n'etait jamais
// reinjecte dans les suivants : le "Fin ≈" glissait vers le soir toute la
// journee, tronçon apres tronçon.
//
// Deux correctifs :
//   - apprendreRythme : sur les arrets deja traites DANS L'ORDRE, compare le
//     temps reellement ecoule entre deux "Livre" (l'appui se fait apres la
//     remise du colis, confirme par le livreur) au temps prevu (trajet + duree
//     d'arret). Le ratio s'applique a tout ce qui reste, trajets ET arrets --
//     c'est sur l'ensemble qu'il a ete mesure.
//   - margeTrajetPct (reglage) : marge fixe sur les seuls trajets, tant que la
//     journee n'a pas assez de livraisons pour mesurer (MIN_PAIRES).

// Au moins 3 intervalles mesures et 10 min de temps prevu cumule : en dessous,
// un seul client bavard ou un seul feu rouge ferait basculer toute la journee.
const MIN_PAIRES = 3;
const MIN_PREVU_SEC = 600;
// Un intervalle beaucoup plus long que prevu n'est pas du rythme, c'est une
// pause (repas, incident) : ecarte. Seuil relatif au prevu, plus une marge
// fixe, pour ne pas jeter un vrai long tronçon rural.
const PAUSE_FACTEUR = 3;
const PAUSE_MARGE_SEC = 900;
// Le ratio reste dans une fourchette plausible : au-dela, c'est une donnee
// aberrante (horloge, arret valide bien apres coup), pas un rythme.
const RATIO_MIN = 0.6;
const RATIO_MAX = 2.5;

function heureTraitement(stop) {
  const brut = stop.statutLivraison === "livre" ? stop.heureLivraison : stop.statutLivraison === "echec" ? stop.heureEchec : null;
  if (!brut) return null;
  const t = new Date(brut).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {{stop: object}[]} stopsSorted arrets tries par ordre
 * @param {number} dwellSec duree moyenne d'un arret
 * @returns {{ratio:number, paires:number, reelSec:number, prevuSec:number} | null}
 */
export function apprendreRythme(stopsSorted, dwellSec) {
  let reelSec = 0;
  let prevuSec = 0;
  let paires = 0;
  for (let i = 1; i < stopsSorted.length; i++) {
    const precedent = stopsSorted[i - 1].stop;
    const courant = stopsSorted[i].stop;
    const tPrecedent = heureTraitement(precedent);
    const tCourant = heureTraitement(courant);
    if (tPrecedent == null || tCourant == null) continue;
    // Pas de temps de trajet connu (arret insere en cours de route, vieille
    // tournee) : rien a comparer.
    if (!(courant.legDureeSec > 0)) continue;
    const reel = (tCourant - tPrecedent) / 1000;
    // Traite hors ordre (le suivant valide AVANT le precedent) : pas un
    // intervalle de trajet.
    if (reel <= 0) continue;
    const prevu = courant.legDureeSec + dwellSec;
    if (reel > prevu * PAUSE_FACTEUR + PAUSE_MARGE_SEC) continue;
    reelSec += reel;
    prevuSec += prevu;
    paires++;
  }
  if (paires < MIN_PAIRES || prevuSec < MIN_PREVU_SEC) return null;
  const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, reelSec / prevuSec));
  return { ratio, paires, reelSec, prevuSec };
}

// Cumul des temps de trajet + duree d'arret a partir du dernier arret
// REELLEMENT valide (livre/echec) plutot que de la creation de la tournee --
// un livreur en avance ou en retard doit voir des heures qui suivent son
// rythme. Sans arret valide, repli sur la creation de la tournee. Un arret
// sans legDureeSec (vieille tournee, insertion en cours de route) compte 0.
// Retourne aussi l'heure estimee de retour au depot quand applicable : le
// trajet retour n'est pas un arret, il se deduit de totalDureeSec (qui inclut
// TOUS les tronçons, retour compris) moins les tronçons des arrets.
export function computeEtas(tour, stopsSorted, dwellSec, { margeTrajetPct = 0 } = {}) {
  let anchorTime = new Date(tour.dateCreation).getTime();
  let anchorIndex = -1;
  stopsSorted.forEach(({ stop }, i) => {
    const t = heureTraitement(stop);
    if (t != null) {
      anchorTime = t;
      anchorIndex = i;
    }
  });

  const rythme = apprendreRythme(stopsSorted, dwellSec);
  const facteurTrajet = rythme ? rythme.ratio : 1 + (Number(margeTrajetPct) || 0) / 100;
  const facteurArret = rythme ? rythme.ratio : 1;

  let cumulative = 0;
  const etas = new Map();
  for (let i = anchorIndex + 1; i < stopsSorted.length; i++) {
    const { stop } = stopsSorted[i];
    cumulative += (stop.legDureeSec || 0) * facteurTrajet;
    etas.set(stop.colisId, new Date(anchorTime + cumulative * 1000));
    cumulative += dwellSec * facteurArret;
  }

  let depotEta = null;
  if (tour.returnToDepot) {
    const sumStopLegs = stopsSorted.reduce((s, { stop }) => s + (stop.legDureeSec || 0), 0);
    const returnLegSec = Math.max(0, (tour.totalDureeSec || 0) - sumStopLegs);
    depotEta = new Date(anchorTime + (cumulative + returnLegSec * facteurTrajet) * 1000);
  }

  return { etas, depotEta, rythme, facteurTrajet };
}

// "+22 %" / "−8 %" pour l'en-tete ; null si aucun rythme mesure.
export function formatRythme(rythme) {
  if (!rythme) return null;
  const pct = Math.round((rythme.ratio - 1) * 100);
  if (pct === 0) return "rythme prévu";
  return `rythme ${pct > 0 ? "+" : "−"}${Math.abs(pct)} %`;
}
