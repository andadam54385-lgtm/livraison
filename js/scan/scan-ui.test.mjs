// splitAdresseInput est la seule fonction pure/testable sans DOM de scan-ui.js
// (le reste du module manipule directement le DOM/la camera). globalThis.self
// est polyfille avant l'import : scan-ui.js importe (transitivement, via
// capture.js/viewfinder-ui.js) des modules qui referencent `self` au niveau
// module (attendu dans un navigateur/service worker, absent de Node).
globalThis.self = globalThis;
const { splitAdresseInput } = await import("./scan-ui.js");

let failures = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

console.log("=== splitAdresseInput : saisie en continu sur une seule ligne ===");
// Retour terrain : "je met 4 rue des jardins il propose des choses[,] quand
// je met le debut du village ou le code postal[,] plus de proposition".

assertEqual(splitAdresseInput("4 rue des jardins"), { numero: "4", street: "rue des jardins", cpTyped: "", villeTyped: "" }, "juste numero+rue, rien apres");

assertEqual(
  splitAdresseInput("4 rue des jardins 54000"),
  { numero: "4", street: "rue des jardins", cpTyped: "54000", villeTyped: "" },
  "CP tape a la suite -- coupure fiable (5 chiffres), toujours appliquee des le 1er essai"
);

assertEqual(
  splitAdresseInput("4 rue des jardins 54000 Nancy"),
  { numero: "4", street: "rue des jardins", cpTyped: "54000", villeTyped: "Nancy" },
  "CP puis ville a la suite"
);

assertEqual(
  splitAdresseInput("4 rue des jardins, Nancy"),
  { numero: "4", street: "rue des jardins", cpTyped: "", villeTyped: "Nancy" },
  "virgule avant la ville -- coupure fiable, toujours appliquee"
);

console.log("\n=== Repli ville collee (sans ponctuation ni CP) : seulement si knownCityPrefixes fourni ===");
const knownCityPrefixes = ["nancy", "metz", "saint mihiel", "toul", "dommartin les toul"];

assertEqual(
  splitAdresseInput("4 rue des jardins nancy"),
  { numero: "4", street: "rue des jardins nancy", cpTyped: "", villeTyped: "" },
  "SANS knownCityPrefixes (1er essai) : aucune coupure -- c'est ce 1er essai qui doit d'abord etre tente tel quel dans bindAdresseAutocomplete"
);

assertEqual(
  splitAdresseInput("4 rue des jardins nancy", { knownCityPrefixes }),
  { numero: "4", street: "rue des jardins", cpTyped: "", villeTyped: "nancy" },
  "AVEC knownCityPrefixes (repli) : ville collee correctement isolee"
);

assertEqual(
  splitAdresseInput("4 rue des jardins nan", { knownCityPrefixes }),
  { numero: "4", street: "rue des jardins", cpTyped: "", villeTyped: "nan" },
  "ville en cours de frappe (prefixe partiel 'nan' de 'nancy') reconnue"
);

assertEqual(
  splitAdresseInput("4 rue de dommartin les toul", { knownCityPrefixes }),
  { numero: "4", street: "rue de", cpTyped: "", villeTyped: "dommartin les toul" },
  "ville composee sur plusieurs mots (jusqu'a 3) correctement isolee"
);

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
