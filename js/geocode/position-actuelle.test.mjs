// Tests des textes de position-actuelle.js (le GPS lui-meme se teste sur le telephone).
//
// Lancer : node js/geocode/position-actuelle.test.mjs

import { messageErreurPosition, libelleDepotGps } from "./position-actuelle.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

check("libelle : 5 decimales (~1 m)", libelleDepotGps(48.692054, 6.184417), "Ma position GPS (48.69205, 6.18442)");
check("refus -> parle des reglages du telephone", /réglages du téléphone/.test(messageErreurPosition({ code: 1 })), true);
check("delai -> propose de reessayer dehors", /dehors/.test(messageErreurPosition({ code: 3 })), true);
check("pas de GPS -> taper l'adresse", /Tape l'adresse/.test(messageErreurPosition({ code: "indisponible" })), true);
check("erreur inconnue -> message generique", /Réessaie/.test(messageErreurPosition(new Error("x"))), true);
check("erreur nulle -> pas de plantage", typeof messageErreurPosition(null), "string");

if (failures > 0) {
  console.log(`\n${failures} TEST(S) EN ECHEC`);
  process.exit(1);
}
console.log("\nTOUS LES TESTS SONT PASSES");
