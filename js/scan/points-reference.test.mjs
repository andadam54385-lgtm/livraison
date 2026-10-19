// Tests du choix des points de reference pour classer les adresses proposees
// (points-reference.js).
//
// Lancer : node js/scan/points-reference.test.mjs

import { choisirPointsDeReference } from "./points-reference.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

const depot = { lat: 48.6169, lon: 6.208 }; // Fleville
const auDepot = { lat: 48.6175, lon: 6.2095 }; // GPS a ~150 m du depot
const pompey = { lat: 48.7672, lon: 6.1278 };
const colis = (id, lat, lon, statut = "pret") => ({ id, statut, geocode: { lat, lon } });
const frouard = colis("A", 48.7586, 6.1348);
const liverdun = colis("B", 48.7600, 6.0640);

// 1. GPS dans la zone : sa position, rien d'autre.
check("GPS loin du depot -> la position du livreur", choisirPointsDeReference({ gps: pompey, depot, colis: [frouard, liverdun] }), [pompey]);

// 2. Preparation au depot : le GPS (au depot) est ignore, les points installes servent.
check(
  "GPS au depot -> tous les points deja installes",
  choisirPointsDeReference({ gps: auDepot, depot, colis: [frouard, liverdun] }),
  [{ lat: 48.7586, lon: 6.1348 }, { lat: 48.76, lon: 6.064 }]
);

// 3. Pas de GPS : les points installes.
check("sans GPS -> points installes", choisirPointsDeReference({ depot, colis: [frouard] }).length, 1);

// 4. Les livres d'une ANCIENNE tournee ne comptent pas ; ceux de la tournee du jour si.
{
  const vieux = colis("V", 49.16, 5.38, "livre"); // Verdun, il y a un mois
  const duJour = colis("J", 48.7915, 6.1246, "livre"); // Custines, livre ce matin
  const pts = choisirPointsDeReference({ depot, colis: [frouard, vieux, duJour], idsTournee: new Set(["J"]) });
  check("livre ancien exclu, livre du jour garde", pts.map((p) => p.lat), [48.7586, 48.7915]);
}

// 5. Premiere adresse de la journee : GPS s'il existe (meme au depot), sinon depot.
check("aucun point, GPS au depot -> GPS", choisirPointsDeReference({ gps: auDepot, depot, colis: [] }), [auDepot]);
check("aucun point, pas de GPS -> depot", choisirPointsDeReference({ depot, colis: [] }), [depot]);
check("rien du tout -> liste vide (ordre d'origine)", choisirPointsDeReference({}), []);

// 6. Colis sans point GPS (pas encore geocode) ignores.
check("colis non geocode ignore", choisirPointsDeReference({ depot, colis: [{ id: "X", statut: "a_verifier", geocode: { lat: null, lon: null } }] }), [depot]);

if (failures > 0) {
  console.log(`\n${failures} echec(s)`);
  process.exit(1);
}
console.log("\nTous les tests passent.");
