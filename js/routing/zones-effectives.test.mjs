// Tests de la zone effective des colis (zones-effectives.js).
//
// Le point central : un colis SANS zone ne doit plus jamais etre pousse en fin
// de tournee -- il rejoint la zone de son voisin zone le plus proche. C'est le
// bug du 2026-09-30 : deux adresses de Pompey oubliees par le lasso, visitees
// APRES Bouxieres-aux-Dames alors que Pompey etait deja traverse.
//
// Lancer : node js/routing/zones-effectives.test.mjs

import { zonesEffectives } from "./zones-effectives.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

// Matrice a partir de positions sur une ligne (secondes = ecart * 60) : le
// point 0 est le depart, les points 1..n les colis.
function matriceLigne(positions) {
  return positions.map((a) => positions.map((b) => Math.abs(a - b) * 60));
}
const colis = (zone, lat = 48.7, lon = 6.1) => ({ zone, geocode: { lat, lon } });

// 1. Aucune zone posee : comportement inchange, un seul groupe.
{
  const e = [colis(undefined), colis(null), colis(undefined)];
  // JSON ecrit Infinity comme null : comparaison explicite, sinon le test
  // passerait aussi avec des null.
  check("aucune zone -> tout Infinity (un seul groupe)", zonesEffectives(e, matriceLigne([0, 1, 2, 3])).every((z) => z === Infinity), true);
}

// 2. Toutes zonees : les numeros sont gardes tels quels.
{
  const e = [colis(2), colis(1), colis(3)];
  check("toutes zonees -> inchangees", zonesEffectives(e, matriceLigne([0, 1, 2, 3])), [2, 1, 3]);
}

// 3. Cas reel du 2026-09-30, schematise sur une ligne (minutes) :
//    Saizerais (zone 1) = 10, Liverdun (zone 2) = 20, Pompey (zone 3) = 30,
//    Frouard (zone 4) = 40, Bouxieres (zone 5) = 50 ; deux Pompey SANS zone
//    en 31 et 32. Avant : groupe "sans zone" en fin -> Bouxieres puis retour
//    a Pompey. Maintenant : elles rejoignent la zone 3 (Pompey).
{
  const positions = [0, 10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 31, 32];
  const e = [
    colis(1), colis(1), // Saizerais
    colis(2), colis(2), // Liverdun
    colis(3), colis(3), // Pompey (zonees)
    colis(4), colis(4), // Frouard
    colis(5), colis(5), // Bouxieres
    colis(null), colis(undefined), // les deux Pompey oubliees par le lasso
  ];
  const z = zonesEffectives(e, matriceLigne(positions));
  check("Pompey oubliees -> rejoignent la zone de Pompey (3)", z.slice(-2), [3, 3]);
  check("les zones posees a la main ne bougent pas", z.slice(0, -2), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
}

// 4. Sens unique : le temps n'est connu que dans un sens -> il suffit.
{
  const m = [
    [0, 100, 100, 100],
    [100, 0, 100, 5000],
    [100, 100, 0, Infinity],
    [100, 5000, 30, 0], // colis 3 (sans zone) -> colis 2 (zone 7) : 30 s
  ];
  const e = [colis(4), colis(7), colis(null)];
  check("temps connu dans un seul sens -> utilise", zonesEffectives(e, m), [4, 7, 7]);
}

// 5. Injoignable de tous les colis zones (point hors reseau) -> repli a vol
//    d'oiseau, jamais en fin de tournee.
{
  const inf = Infinity;
  const m = [
    [0, 1, 1, inf],
    [1, 0, 1, inf],
    [1, 1, 0, inf],
    [inf, inf, inf, 0],
  ];
  const e = [colis(1, 48.70, 6.10), colis(2, 48.90, 6.30), colis(null, 48.88, 6.29)];
  check("injoignable -> zone la plus proche a vol d'oiseau", zonesEffectives(e, m), [1, 2, 2]);
}

// 6. Egalite parfaite -> la plus petite zone (resultat stable).
{
  const positions = [0, 10, 30, 20];
  const e = [colis(2), colis(1), colis(null)];
  check("egalite -> plus petite zone", zonesEffectives(e, matriceLigne(positions)), [2, 1, 1]);
}

// 7. Un sans-zone ne se rattache jamais a un autre sans-zone (pas de chainage) :
//    le colis 3 est a 1 min du colis 2 (sans zone) mais a 5 min du colis 1 (zone 4).
{
  const positions = [0, 10, 14, 15];
  const e = [colis(4), colis(null), colis(null)];
  check("pas de chainage entre sans-zone", zonesEffectives(e, matriceLigne(positions)), [4, 4, 4]);
}

if (failures > 0) {
  console.log(`\n${failures} echec(s)`);
  process.exit(1);
}
console.log("\nTous les tests passent.");
