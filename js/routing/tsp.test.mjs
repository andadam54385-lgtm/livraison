// Tests du modele de cout horaire (voir tourCost dans tsp.js).
//
// Le point central verifie ici : une contrainte "avant 12h" ne porte QUE sur
// le colis concerne. Tant que ce point-la est servi a l'heure, l'optimiseur
// reste libre de placer tous les autres arrets ou il veut, avant ou apres --
// c'est precisement ce que l'ancienne penalite de position ne savait pas
// faire (elle poussait le colis marque en tete de tournee coute que coute).

import { tourCost, optimizeTourOrder } from "./tsp.js";

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

const H = (h, m = 0) => h * 3600 + m * 60;

// Matrice symetrique simple : 0 = depart, 1..4 = arrets alignes, 10 min entre
// deux points consecutifs, proportionnel a la distance d'index.
function buildLineMatrix(n, legSec = 600) {
  const m = [];
  for (let i = 0; i < n; i++) {
    m.push([]);
    for (let j = 0; j < n; j++) m[i].push(Math.abs(i - j) * legSec);
  }
  return m;
}

console.log('=== Une contrainte "avant 12h" ne coute rien tant qu elle est tenue ===');
{
  const matrix = buildLineMatrix(5);
  const timing = { departureSec: H(8), dwellSec: 180, deadlines: { 4: H(12) }, closedWindows: {} };
  // Ordre naturel 1,2,3,4 : arrivee au point 4 a 8h + 4x10min + 3x3min = 8h49.
  const order = [1, 2, 3, 4];
  const avecContrainte = tourCost(order, matrix, 0, timing);
  const sansContrainte = tourCost(order, matrix, 0, { ...timing, deadlines: {} });
  check("aucune penalite quand le point contraint est servi a l heure", avecContrainte, sansContrainte);
}

console.log("\n=== Le retard n est compte que pour le point contraint ===");
{
  const matrix = buildLineMatrix(3, 3600); // 1h entre points consecutifs
  // Depart 10h. Ordre 1,2 : arrivee au 1 a 11h, au 2 a 12h05 (1h + 5min d arret).
  const timing = { departureSec: H(10), dwellSec: 300, closedWindows: {}, lateWeight: 1 };
  const sansDeadline = tourCost([1, 2], matrix, 0, { ...timing, deadlines: {} });

  // Contrainte sur le point 2 (arrivee 12h05) -> 5 min de retard comptees.
  const deadlineSur2 = tourCost([1, 2], matrix, 0, { ...timing, deadlines: { 2: H(12) } });
  check("retard de 5 min facture sur le point contraint", deadlineSur2 - sansDeadline, 300);

  // La meme contrainte posee sur le point 1 (arrivee 11h) ne coute rien : le
  // point 2 arrive pourtant toujours a 12h05, mais il n est pas contraint.
  const deadlineSur1 = tourCost([1, 2], matrix, 0, { ...timing, deadlines: { 1: H(12) } });
  check("un arret non contraint peut arriver apres midi sans penalite", deadlineSur1 - sansDeadline, 0);
}

console.log("\n=== Regression du bug signale : un avant 12h ne monopolise plus la tete de tournee ===");
{
  // 12 arrets en ligne, 3 min de trajet entre voisins, 2 min par arret. Le
  // dernier de la ligne (le plus loin du depart) est marque "avant 12h".
  // Depart 8h : meme en le servant en DERNIER, on arrive tres avant midi.
  const n = 13;
  const matrix = buildLineMatrix(n, 180);
  const stops = [];
  for (let i = 1; i < n; i++) stops.push(i);

  const { order } = optimizeTourOrder(matrix, 0, stops, {
    timing: { departureSec: H(8), dwellSec: 120, deadlines: { 12: H(12) }, closedWindows: {} },
    timeBudgetMs: 500,
  });

  // L ordre optimal reste le parcours en ligne : le colis contraint est le
  // plus eloigne, le forcer en premier couterait un aller-retour complet.
  check("l ordre reste le parcours le plus court", order, stops);
  checkTrue("le colis 'avant 12h' n est PAS force en tete", order[0] !== 12);

  // Verification du modele : l heure d arrivee sur le dernier point est bien
  // avant midi, donc la contrainte est effectivement tenue sans rien forcer.
  const arriveeDernier = H(8) + 12 * 180 + 11 * 120;
  checkTrue("le colis contraint arrive quand meme avant 12h", arriveeDernier < H(12));
}

console.log("\n=== Mais la contrainte agit quand elle ne peut PAS etre tenue autrement ===");
{
  // Meme ligne, mais depart a 11h30 : servir le point 12 en dernier le ferait
  // arriver bien apres midi. L optimiseur doit cette fois le remonter.
  const n = 13;
  const matrix = buildLineMatrix(n, 180);
  const stops = [];
  for (let i = 1; i < n; i++) stops.push(i);

  const { order } = optimizeTourOrder(matrix, 0, stops, {
    timing: { departureSec: H(11, 30), dwellSec: 120, deadlines: { 12: H(12) }, closedWindows: {} },
    timeBudgetMs: 500,
  });
  checkTrue("le colis contraint est remonte quand l heure limite l exige", order.indexOf(12) < stops.length - 1);
}

console.log("\n=== Fermeture de midi d un pro : creneau evite, pas un rang impose ===");
{
  const matrix = buildLineMatrix(3, 3600);
  const timing = { departureSec: H(10), dwellSec: 300, deadlines: {}, lateWeight: 1 };
  // Point 2 atteint a 12h05, en pleine fermeture 12h-14h -> penalite
  // FORFAITAIRE (30 min, ~un repassage), identique quelle que soit l heure
  // d arrivee DANS le creneau -- ferme c est ferme, pas de "moins pire".
  const ferme = tourCost([1, 2], matrix, 0, { ...timing, closedWindows: { 2: [H(12), H(14)] } });
  const ouvert = tourCost([1, 2], matrix, 0, { ...timing, closedWindows: {} });
  check("penalite forfaitaire d arrivee pendant la fermeture", ferme - ouvert, 30 * 60);
  const fermeTard = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(11, 30), closedWindows: { 2: [H(12), H(14)] } });
  const ouvertTard = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(11, 30), closedWindows: {} });
  check("meme forfait plus tard dans le creneau (pas de rabais)", fermeTard - ouvertTard, 30 * 60);

  // Arriver APRES la reouverture ne coute rien.
  const tardif = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(15), closedWindows: { 2: [H(12), H(14)] } });
  const tardifSansFermeture = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(15), closedWindows: {} });
  check("aucune penalite en dehors du creneau de fermeture", tardif - tardifSansFermeture, 0);
}

console.log("\n=== Plusieurs fenetres fermees par arret (horaires jour par jour) ===");
{
  const matrix = buildLineMatrix(3, 3600);
  const timing = { departureSec: H(8), dwellSec: 0, deadlines: {}, lateWeight: 1 };
  // Ouvre a 10h30, pause 12h-14h, ferme a 17h : trois fenetres fermees.
  const fenetres = { 2: [[0, H(10, 30)], [H(12), H(14)], [H(17), H(24)]] };
  // Point 2 atteint a 10h (depart 8h + 2 x 1h) : avant l ouverture.
  const avantOuverture = tourCost([1, 2], matrix, 0, { ...timing, closedWindows: fenetres });
  const libre = tourCost([1, 2], matrix, 0, { ...timing, closedWindows: {} });
  check("arrivee avant l ouverture : penalisee", avantOuverture - libre, 30 * 60);
  // Depart 9h : point 2 a 11h, entre l ouverture et la pause.
  const ouvert = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(9), closedWindows: fenetres });
  const ouvertLibre = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(9), closedWindows: {} });
  check("arrivee entre ouverture et pause : rien", ouvert - ouvertLibre, 0);
  // Depart 16h : point 2 a 18h, apres la fermeture.
  const apresFermeture = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(16), closedWindows: fenetres });
  const apresLibre = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(16), closedWindows: {} });
  check("arrivee apres la fermeture : penalisee", apresFermeture - apresLibre, 30 * 60);
  const jourFerme = tourCost([1, 2], matrix, 0, { ...timing, departureSec: H(9), closedWindows: { 2: [[0, H(24)]] } });
  check("jour ferme : penalise a toute heure", jourFerme - ouvertLibre, 30 * 60);
}

console.log("\n=== Contrainte souple : jamais d echec, meme si tout est intenable ===");
{
  const matrix = buildLineMatrix(4, 7200); // 2h entre voisins
  const stops = [1, 2, 3];
  const { order } = optimizeTourOrder(matrix, 0, stops, {
    // Trois colis "avant 12h" en partant a 11h : impossible a tenir.
    timing: { departureSec: H(11), dwellSec: 300, deadlines: { 1: H(12), 2: H(12), 3: H(12) }, closedWindows: {} },
    timeBudgetMs: 300,
  });
  check("tous les arrets sont quand meme ordonnances", order.slice().sort((a, b) => a - b), stops);
}

console.log("\n=== Regression 'allers-retours' : la fermeture d un pro ne tord pas la tournee ===");
{
  // 8 arrets en ligne, 8 min de trajet entre voisins, 3 min d arret.
  // Depart 11h30 : l arret 5 (pro, ferme 12h-14h) tombe en pleine fermeture
  // quel que soit l ordre raisonnable. L eviter exigerait de le repousser
  // apres 14h, soit ~2h a tourner en rond -- bien PLUS cher que l attente
  // reelle a la porte. Pondere x10 (l ancien bug), l optimiseur choisissait
  // quand meme le grand detour : c est le "des allers-retours" du terrain.
  const n = 9;
  const matrix = buildLineMatrix(n, 480);
  const stops = [];
  for (let i = 1; i < n; i++) stops.push(i);

  const { order } = optimizeTourOrder(matrix, 0, stops, {
    timing: { departureSec: H(11, 30), dwellSec: 180, deadlines: {}, closedWindows: { 5: [H(12), H(14)] } },
    timeBudgetMs: 500,
  });
  check("l ordre reste le parcours en ligne (pas de detour absurde)", order, stops);
}

console.log("\n=== Un arret inatteignable n aveugle plus le 2-opt ===");
{
  // 6 arrets en ligne + un point 7 isole (Infinity vers/depuis tout le
  // monde). Avant le plafond fini, TOUT ordre coutait Infinity : le 2-opt ne
  // pouvait plus rien comparer et l ordre restait le plus-proche-voisin brut.
  const n = 8;
  const matrix = buildLineMatrix(n, 300);
  for (let i = 0; i < n; i++) {
    matrix[i][7] = Infinity;
    matrix[7][i] = Infinity;
  }
  const stops = [1, 2, 3, 4, 5, 6, 7];
  const { order, cost } = optimizeTourOrder(matrix, 0, stops, {
    timing: { departureSec: H(8), dwellSec: 120, deadlines: {}, closedWindows: {} },
    timeBudgetMs: 300,
  });
  checkTrue("le cout reste fini (comparable/optimisable)", Number.isFinite(cost));
  check("les arrets atteignables restent en ligne, l isole en dernier", order, [1, 2, 3, 4, 5, 6, 7]);
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} TEST(S) EN ECHEC`);
if (failures > 0) process.exit(1);
