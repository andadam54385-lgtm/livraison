// Tests de l'heure d'arrivee estimee : marge FIXE de 10 % sur les trajets et
// pauses declarees. L'apprentissage du rythme reel a ete retire le 2026-09-15
// (voir l'en-tete de eta.js) ; le cas 2 verifie qu'il ne revient pas.
// Execute via `node js/tour/eta.test.mjs`.
import { computeEtas, MARGE_TRAJET, pauseTotalSec, pauseEnCours } from "./eta.js";

let failures = 0;
function assert(cond, label) {
  if (!cond) failures++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
}
function assertClose(actual, expected, label, tolSec = 1) {
  const ok = Math.abs(actual - expected) <= tolSec * 1000;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${new Date(expected).toISOString()}, obtenu: ${new Date(actual).toISOString()})`);
}

const T0 = Date.parse("2026-09-10T08:00:00Z");
const min = (n) => n * 60 * 1000;
const DWELL = 180; // 3 min
const tour = (extra = {}) => ({ dateCreation: new Date(T0).toISOString(), returnToDepot: false, totalDureeSec: 0, ...extra });
// 6 arrets, 10 min de trajet chacun -> 11 min une fois la marge de 10 % posee.
const stops = (traites) =>
  [1, 2, 3, 4, 5, 6].map((ordre) => {
    const t = traites[ordre];
    return {
      stop: { ordre, colisId: `C${ordre}`, legDureeSec: 600, statutLivraison: t ? "livre" : "a_livrer", heureLivraison: t ? new Date(t).toISOString() : null },
      colis: { id: `C${ordre}` },
    };
  });

console.log("=== Marge fixe de 10 % sur les trajets, pas sur la duree d'arret ===");
{
  assert(MARGE_TRAJET === 0.1, "la marge vaut 10 %");
  const { etas, facteurTrajet } = computeEtas(tour(), stops({}), DWELL);
  assert(Math.abs(facteurTrajet - 1.1) < 1e-9, "facteur de trajet 1,1");
  assertClose(etas.get("C1").getTime(), T0 + min(11), "arret 1 : 10 min x 1,1");
  assertClose(etas.get("C2").getTime(), T0 + min(11) + min(3) + min(11), "arret 2 : + 3 min d'arret (non majores) + 11 min");
}

console.log("\n=== Livreur 25 % plus lent : AUCUN apprentissage, la marge reste 10 % ===");
{
  const t1 = T0 + min(12);
  const t2 = t1 + min(16.25);
  const t3 = t2 + min(16.25);
  const t4 = t3 + min(16.25);
  const r = computeEtas(tour(), stops({ 1: t1, 2: t2, 3: t3, 4: t4 }), DWELL);
  assert(Math.abs(r.facteurTrajet - 1.1) < 1e-9, "le facteur ne suit plus le rythme mesure");
  assert(!("rythme" in r), "plus aucun rythme renvoye a l'ecran");
  assertClose(r.etas.get("C5").getTime(), t4 + min(11), "arret 5 : repart du dernier Livre, trajet x 1,1");
  assertClose(r.etas.get("C6").getTime(), t4 + min(11) + min(3) + min(11), "arret 6 : duree d'arret non majoree");
  assert(r.depotEta === null, "pas de retour depot demande");
}

console.log("\n=== Retour au depot : le trajet retour est majore de 10 % aussi ===");
{
  // 6 tronçons de 600 s + retour de 900 s.
  const { depotEta, etas } = computeEtas(tour({ returnToDepot: true, totalDureeSec: 6 * 600 + 900 }), stops({}), DWELL);
  const dernier = etas.get("C6").getTime();
  assertClose(depotEta.getTime(), dernier + min(3) + 900 * 1.1 * 1000, "depot = dernier arret + 3 min + retour x 1,1");
}

console.log("\n=== Pause DECLAREE terminee : l'arret suivant repart de l'heure de reprise ===");
{
  const t1 = T0 + min(12);
  const t2 = t1 + min(13);
  const t3 = t2 + min(13);
  const pauseDebut = t3 + min(2);
  const pauseFin = pauseDebut + min(45);
  const pauses = [{ debut: new Date(pauseDebut).toISOString(), fin: new Date(pauseFin).toISOString() }];
  assert(Math.abs(pauseTotalSec(pauses, pauseFin + min(5)) - 45 * 60) < 1, "duree totale de pause = 45 min");
  assert(pauseEnCours(pauses) === null, "aucune pause en cours une fois terminee");
  const r = computeEtas(tour({ pauses }), stops({ 1: t1, 2: t2, 3: t3 }), DWELL, { maintenant: pauseFin + min(1) });
  assertClose(r.etas.get("C4").getTime(), pauseFin + min(11), "arret 4 : reprise + 11 min");
  assert(Math.abs(r.pauseTotalSec - 45 * 60) < 1, "le total de pause est remonte a l'ecran");
}

console.log("\n=== Pause EN COURS : les heures reculent avec l'horloge ===");
{
  const t1 = T0 + min(12);
  const pauseDebut = t1 + min(5);
  const pauses = [{ debut: new Date(pauseDebut).toISOString(), fin: null }];
  const s = stops({ 1: t1 });
  const maintenant = pauseDebut + min(20);
  const r = computeEtas(tour({ pauses }), s, DWELL, { maintenant });
  assert(r.pauseEnCours != null, "la pause en cours est signalee a l'ecran");
  assertClose(r.etas.get("C2").getTime(), maintenant + min(11), "l'arret suivant est repousse a maintenant + trajet x 1,1");
  const plusTard = computeEtas(tour({ pauses }), s, DWELL, { maintenant: maintenant + min(10) });
  assertClose(plusTard.etas.get("C2").getTime(), maintenant + min(21), "elle recule tant que le livreur n'a pas repris");
  assert(Math.abs(plusTard.pauseTotalSec - 30 * 60) < 1, "le compteur de pause tourne (30 min)");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
