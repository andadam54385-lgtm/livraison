// Tests du "dernier arret" (dernier-arret.js) et de la queue fixe de
// l'optimiseur (fixedTail dans tsp.js).
//
// Lancer : node js/routing/dernier-arret.test.mjs

import { deplacerEnDernier, indexDernier, dernierEnQueue } from "./dernier-arret.js";
import { optimizeTourOrder } from "./tsp.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

const arret = (colisId, ordre, statutLivraison = "a_livrer") => ({ colisId, ordre, statutLivraison });
const ordreDe = (tour) => tour.stops.slice().sort((a, b) => a.ordre - b.ordre).map((s) => `${s.colisId}:${s.ordre}`);

// 1. Tournee en cours : l'arret passe apres tous les arrets a faire, les
//    arrets deja traites gardent leur numero.
{
  const tour = { stops: [arret("A", 1, "livre"), arret("B", 2), arret("C", 3, "livre"), arret("D", 4), arret("E", 5)] };
  check("deplacerEnDernier : change l'ordre", deplacerEnDernier(tour, "B"), true);
  check("deplacerEnDernier : B apres D et E, A et C intacts", ordreDe(tour), ["A:1", "D:2", "C:3", "E:4", "B:5"]);
}

// 2. Deja dernier, ou arret deja traite, ou colis absent : rien ne bouge.
{
  const tour = { stops: [arret("A", 1), arret("B", 2)] };
  check("deja dernier -> false", deplacerEnDernier(tour, "B"), false);
  check("colis absent -> false", deplacerEnDernier(tour, "Z"), false);
  const tour2 = { stops: [arret("A", 1, "livre"), arret("B", 2)] };
  check("arret deja livre -> false", deplacerEnDernier(tour2, "A"), false);
  check("arret deja livre -> ordre inchange", ordreDe(tour2), ["A:1", "B:2"]);
}

// 3. indexDernier : point (i + 1) du colis marque, le plus recent si plusieurs.
{
  check("aucun dernier -> null", indexDernier([{ id: "a" }, { id: "b" }]), null);
  check("un dernier -> son point", indexDernier([{ id: "a" }, { id: "b", dernier: true }, { id: "c" }]), 2);
  check(
    "deux derniers -> le plus recemment scanne",
    indexDernier([
      { id: "a", dernier: true, dateScan: "2026-09-30T08:00:00Z" },
      { id: "b", dernier: true, dateScan: "2026-09-30T09:00:00Z" },
    ]),
    2
  );
}

// 4. dernierEnQueue : seulement si le DERNIER des arrets a faire est marque.
{
  check("marque en queue -> vrai", dernierEnQueue([{}, {}, { dernier: true }]), true);
  check("marque ailleurs -> faux", dernierEnQueue([{ dernier: true }, {}]), false);
  check("liste vide -> faux", dernierEnQueue([]), false);
}

// 5. Optimiseur : le point "dernier" reste en fin, AVANT le retour depot, et
//    le reste de la tournee est construit pour finir pres de lui.
//    Ligne : depart 0 ; arrets a 1..5 ; "dernier" en 3 (au milieu !) ; depot 0.
{
  const pos = [0, 1, 2, 4, 5, 3, 0]; // index 5 = "dernier" (position 3), index 6 = retour depot
  const m = pos.map((a) => pos.map((b) => Math.abs(a - b) * 60));
  const { order } = optimizeTourOrder(m, 0, [1, 2, 3, 4, 5, 6], { fixedTail: [5, 6], timing: {}, timeBudgetMs: 300 });
  check("queue fixe : dernier puis depot en fin", order.slice(-2), [5, 6]);
  check("queue fixe : aucun arret perdu", order.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
}

// 6. Sans retour depot : le "dernier" seul en queue.
{
  const pos = [0, 1, 2, 4, 5, 3];
  const m = pos.map((a) => pos.map((b) => Math.abs(a - b) * 60));
  const { order } = optimizeTourOrder(m, 0, [1, 2, 3, 4, 5], { fixedTail: [5], timing: {}, timeBudgetMs: 300 });
  check("sans depot : dernier en fin", order[order.length - 1], 5);
}

// 7. Compatibilite : fixedEndIdx seul marche comme avant.
{
  const pos = [0, 1, 2, 3, 0];
  const m = pos.map((a) => pos.map((b) => Math.abs(a - b) * 60));
  const { order } = optimizeTourOrder(m, 0, [1, 2, 3, 4], { fixedEndIdx: 4, timing: {}, timeBudgetMs: 300 });
  check("fixedEndIdx seul : depot en fin", order[order.length - 1], 4);
}

if (failures > 0) {
  console.log(`\n${failures} echec(s)`);
  process.exit(1);
}
console.log("\nTous les tests passent.");
