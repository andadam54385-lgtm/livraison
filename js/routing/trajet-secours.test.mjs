// Tests des trajets de secours (trajet-secours.js).
//
// Le point central : un trajet que le graphe dit injoignable ne doit plus
// jamais rester Infinity -- ni dans la matrice de l'optimiseur (sinon le
// point devient une "teleportation gratuite"), ni dans les heures estimees.
//
// Lancer : node js/routing/trajet-secours.test.mjs

import { estimationVolOiseauSec, reparerMatrice, dureeTourneeSec } from "./trajet-secours.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}
function checkTrue(label, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
}

const pompey = { lat: 48.7642, lon: 6.1193 };
const frouard = { lat: 48.7587, lon: 6.1234 };
const saizerais = { lat: 48.7994, lon: 6.0448 };

// 1. Estimation : plausible, et absente sans coordonnees.
{
  const t = estimationVolOiseauSec(saizerais, pompey);
  checkTrue(`Saizerais -> Pompey estime entre 8 et 15 min (${Math.round(t / 60)} min)`, t > 8 * 60 && t < 15 * 60);
  check("sans coordonnees -> Infinity", estimationVolOiseauSec(null, pompey), Infinity);
}

// 2. Cas reel du 2026-10-01 : on ne peut pas ENTRER dans le point 1 (tous les
//    trajets vers lui infinis), on en sort normalement -> le sens inverse sert.
{
  const I = Infinity;
  const m = [
    [0, I, 300],
    [420, 0, 200],
    [310, I, 0],
  ];
  const n = reparerMatrice(m, [saizerais, pompey, frouard]);
  check("2 trajets repares", n, 2);
  check("0 -> 1 prend le temps de 1 -> 0", m[0][1], 420);
  check("2 -> 1 prend le temps de 1 -> 2", m[2][1], 200);
  check("les trajets connus ne bougent pas", [m[0][2], m[1][0], m[2][0]], [300, 420, 310]);
}

// 3. Les deux sens infinis -> estimation a vol d'oiseau, jamais Infinity.
{
  const I = Infinity;
  const m = [
    [0, I],
    [I, 0],
  ];
  reparerMatrice(m, [saizerais, pompey]);
  checkTrue("deux sens infinis -> fini", Number.isFinite(m[0][1]) && Number.isFinite(m[1][0]));
  check("estimation symetrique", m[0][1], m[1][0]);
}

// 4. Une reparation ne sert jamais de "sens inverse" a une autre : sans
//    coordonnees, un trajet infini dans les deux sens reste infini.
{
  const I = Infinity;
  const m = [
    [0, I],
    [I, 0],
  ];
  check("sans coordonnees ni sens inverse -> rien a reparer", reparerMatrice(m, [null, null]), 0);
}

// 5. Duree affichee : total fini tel quel, sinon somme des troncons connus.
{
  check("total fini", dureeTourneeSec({ totalDureeSec: 3600, stops: [] }), 3600);
  check(
    "total infini -> somme des troncons finis",
    dureeTourneeSec({ totalDureeSec: Infinity, stops: [{ legDureeSec: 600 }, { legDureeSec: Infinity }, { legDureeSec: null }, { legDureeSec: 300 }] }),
    900
  );
}

if (failures > 0) {
  console.log(`\n${failures} echec(s)`);
  process.exit(1);
}
console.log("\nTous les tests passent.");
