// Tests de la reconnaissance d'un favori par son texte (favori-texte.js).
//
// Lancer : node js/favoris/favori-texte.test.mjs

import { normTexte, favoriCorrespond, scoreRecherche, rechercherDansFavoris } from "./favori-texte.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

const azur = { id: "a", nom: "AZUR PRODUCTION", rue: "", cp: "54470", ville: "Onville", lat: 49.01, lon: 5.93 };
const grandeRue = { id: "g", nom: "", rue: "12 Grande Rue", cp: "54470", ville: "Waville", lat: 49.0, lon: 5.94 };

check("normalise accents, tirets, st", normTexte("St-Julien-lès-Gorze"), "saint julien les gorze");

// 1. Le nom scanne retrouve le favori, meme ecrit autrement (casse/accents).
check("nom identique", favoriCorrespond(azur, { nom: "Azur Production", cp: "54470", ville: "ONVILLE" }), true);
// 2. Le nom lu dans la ligne rue (liste UPS sans rue) le retrouve aussi.
check("nom dans la rue", favoriCorrespond(azur, { rue: "AZUR PRODUCTION", cp: "54470" }), true);
// 3. Autre village du meme code postal : pas le meme lieu.
check("autre village meme CP", favoriCorrespond(grandeRue, { rue: "12 grande rue", cp: "54470", ville: "Onville" }), false);
check("meme village", favoriCorrespond(grandeRue, { rue: "12 GRANDE RUE", cp: "54470", ville: "Waville" }), true);
// 4. Ville absente du scan : le code postal suffit.
check("ville absente, CP egal", favoriCorrespond(grandeRue, { rue: "12 grande rue", cp: "54470" }), true);
// 5. Rien de commun / pas de texte : pas de correspondance.
check("texte vide", favoriCorrespond(azur, { cp: "54470", ville: "Onville" }), false);
check("autre entreprise", favoriCorrespond(azur, { nom: "AZUR DECO", cp: "54470", ville: "Onville" }), false);
// 6. Alias appris : une variante choisie une fois est reconnue ensuite.
check("alias", favoriCorrespond({ ...azur, alias: ["azur prod"] }, { nom: "AZUR PROD", ville: "Onville" }), true);
// 7. Favori sans position : inutilisable.
check("sans GPS", favoriCorrespond({ ...azur, lat: null }, { nom: "AZUR PRODUCTION", ville: "Onville" }), false);

// Recherche libre.
check("debut de mot", scoreRecherche(azur, "azur prod") > 0.9, true);
check("nom + ville", scoreRecherche(azur, "azur production onville"), 1);
check("ville seule ne sort pas tout le village", scoreRecherche(azur, "onville"), 0);
check(
  "classement",
  rechercherDansFavoris([grandeRue, azur], "azur onville").map((f) => f.id),
  ["a"]
);

if (failures) {
  console.log(`\n${failures} echec(s)`);
  process.exit(1);
}
console.log("\nTous les tests passent.");
