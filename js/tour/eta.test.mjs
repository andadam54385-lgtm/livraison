// Tests de l'heure d'arrivee estimee et de l'apprentissage du rythme reel
// (retour terrain 2026-09-10 : "plus j'avance, plus je perds de temps").
// Execute via `node js/tour/eta.test.mjs`.
import { computeEtas, apprendreRythme, formatRythme } from "./eta.js";

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
// 6 arrets, 10 min de trajet chacun (prevu par arret : 10 + 3 = 13 min).
const stops = (traites) =>
  [1, 2, 3, 4, 5, 6].map((ordre) => {
    const t = traites[ordre];
    return {
      stop: { ordre, colisId: `C${ordre}`, legDureeSec: 600, statutLivraison: t ? "livre" : "a_livrer", heureLivraison: t ? new Date(t).toISOString() : null },
      colis: { id: `C${ordre}` },
    };
  });

console.log("=== Sans arret traite : depart de la creation, marge sur les trajets seulement ===");
{
  const { etas, rythme, facteurTrajet } = computeEtas(tour(), stops({}), DWELL, { margeTrajetPct: 20 });
  assert(rythme === null, "aucun rythme mesurable sans livraison");
  assert(Math.abs(facteurTrajet - 1.2) < 1e-9, "la marge de 20 % s'applique aux trajets");
  assertClose(etas.get("C1").getTime(), T0 + min(12), "arret 1 : 10 min x 1,2");
  assertClose(etas.get("C2").getTime(), T0 + min(12) + min(3) + min(12), "arret 2 : + 3 min d'arret (non majores) + 12 min");
}

console.log("\n=== Rythme reel 25 % plus lent sur 3 livraisons : applique a la suite ===");
{
  // Prevu entre deux "Livre" : 13 min ; reel : 16,25 min (x 1,25).
  const t1 = T0 + min(12);
  const t2 = t1 + min(16.25);
  const t3 = t2 + min(16.25);
  const t4 = t3 + min(16.25);
  const s = stops({ 1: t1, 2: t2, 3: t3, 4: t4 });
  const rythme = apprendreRythme(s, DWELL);
  assert(rythme && rythme.paires === 3, `3 intervalles mesures (obtenu: ${rythme && rythme.paires})`);
  assert(rythme && Math.abs(rythme.ratio - 1.25) < 0.01, `ratio 1,25 (obtenu: ${rythme && rythme.ratio.toFixed(3)})`);
  const { etas, depotEta } = computeEtas(tour(), s, DWELL, { margeTrajetPct: 20 });
  // Ancre = dernier "Livre" (arret 4) ; la marge fixe est remplacee par le rythme mesure.
  assertClose(etas.get("C5").getTime(), t4 + min(10 * 1.25), "arret 5 : trajet x 1,25 depuis le dernier Livre");
  assertClose(etas.get("C6").getTime(), t4 + min(10 * 1.25) + min(3 * 1.25) + min(10 * 1.25), "arret 6 : l'arret intermediaire est aussi majore");
  assert(depotEta === null, "pas de retour depot demande");
  assert(formatRythme(rythme) === "rythme +25 %", `libelle d'en-tete (obtenu: ${formatRythme(rythme)})`);
}

console.log("\n=== Moins de 3 livraisons : pas de rythme, la marge fixe reste ===");
{
  const s = stops({ 1: T0 + min(12), 2: T0 + min(30) });
  assert(apprendreRythme(s, DWELL) === null, "1 seul intervalle : pas de rythme");
  const { facteurTrajet } = computeEtas(tour(), s, DWELL, { margeTrajetPct: 15 });
  assert(Math.abs(facteurTrajet - 1.15) < 1e-9, "repli sur la marge de 15 %");
}

console.log("\n=== Pause repas au milieu : l'intervalle aberrant est ecarte ===");
{
  const t1 = T0 + min(12);
  const t2 = t1 + min(13);
  const t3 = t2 + min(13);
  const t4 = t3 + min(13) + min(75); // 75 min de pause
  const t5 = t4 + min(13);
  const s = stops({ 1: t1, 2: t2, 3: t3, 4: t4, 5: t5 });
  const rythme = apprendreRythme(s, DWELL);
  assert(rythme && rythme.paires === 3, `la pause n'est pas comptee (obtenu: ${rythme && rythme.paires} paires)`);
  assert(rythme && Math.abs(rythme.ratio - 1) < 0.01, `rythme = prevu (obtenu: ${rythme && rythme.ratio.toFixed(3)})`);
}

console.log("\n=== Arret valide hors ordre : l'intervalle negatif est ignore ===");
{
  const t1 = T0 + min(12);
  const t3 = t1 + min(13);
  const t2 = t3 + min(5); // le 2 est valide APRES le 3
  const t4 = t2 + min(13);
  const s = stops({ 1: t1, 2: t2, 3: t3, 4: t4 });
  const rythme = apprendreRythme(s, DWELL);
  // Paires valables : (1,2) 18 min, (3,4) 13 min ; (2,3) negative.
  assert(rythme === null, "2 paires seulement une fois la paire inversee ecartee : pas de rythme");
}

console.log("\n=== Fourchette : 5 fois plus lent est plafonne a 2,5 ===");
{
  const t1 = T0 + min(12);
  const t2 = t1 + min(65);
  const t3 = t2 + min(65);
  const t4 = t3 + min(65);
  // 65 min reel pour 13 prevu = x5 : au-dessus du seuil de pause (3 x 13 + 15 = 54) -> ecarte.
  assert(apprendreRythme(stops({ 1: t1, 2: t2, 3: t3, 4: t4 }), DWELL) === null, "x5 passe pour une pause, pas un rythme");
  // 40 min reel pour 13 prevu = x3,08 : sous le seuil de pause, mais plafonne a 2,5.
  const u2 = t1 + min(40);
  const u3 = u2 + min(40);
  const u4 = u3 + min(40);
  const rythme = apprendreRythme(stops({ 1: t1, 2: u2, 3: u3, 4: u4 }), DWELL);
  assert(rythme && rythme.ratio === 2.5, `plafond 2,5 (obtenu: ${rythme && rythme.ratio})`);
}

console.log("\n=== Retour au depot : le trajet retour est majore comme les autres ===");
{
  const s = stops({});
  // 6 tronçons de 600 s + retour de 900 s.
  const { depotEta, etas } = computeEtas(tour({ returnToDepot: true, totalDureeSec: 6 * 600 + 900 }), s, DWELL, { margeTrajetPct: 10 });
  const dernier = etas.get("C6").getTime();
  assertClose(depotEta.getTime(), dernier + min(3) + 900 * 1.1 * 1000, "depot = dernier arret + 3 min + retour x 1,1");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
