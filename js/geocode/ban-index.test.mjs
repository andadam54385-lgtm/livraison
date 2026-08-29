// tokenizeQuery, buildSearchTokens et matchAdresseEntries sont pures (pas de
// DB) -- testables directement. queryByCp/queryByCommune/queryByStreetPrefix/
// listDistinctCities/searchAdresses ont besoin d'une vraie IndexedDB et ne
// sont pas couvertes ici (verifiees manuellement, voir l'historique des
// commits) : le projet reste volontairement sans dependance de test
// permanente (fake-indexeddb n'est installe que temporairement, jamais commite).
const { tokenizeQuery, buildSearchTokens, matchAdresseEntries } = await import("./ban-index.js");

let failures = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

console.log("=== tokenizeQuery ===");
assertEqual(tokenizeQuery("4 rue des jardins"), ["4", "rue", "des", "jardins"], "decoupage simple sur espaces");
assertEqual(tokenizeQuery("Doncourt-aux-Templiers"), ["doncourt", "aux", "templiers"], "tiret traite comme separateur");
assertEqual(tokenizeQuery("Grand'Rue"), ["grand", "rue"], "apostrophe traitee comme separateur");
assertEqual(tokenizeQuery("Rosières-en-Haye"), ["rosieres", "en", "haye"], "accents retires + tiret separateur");
assertEqual(tokenizeQuery("  "), [], "chaine vide/espaces seuls -> aucun token");

console.log("\n=== matchAdresseEntries : recherche a la Google Maps (ordre des mots libre) ===");
// Reproduit les 3 bugs reels signales sur l'ancienne approche par position
// stricte (splitAdresseInput, desormais supprimee) : "4 rue des jardins
// 54385" ne proposait jamais Rosieres-en-Haye, "55" ne filtrait pas les
// villes du 54, et "nationale" (sans "Route" devant) ne trouvait rien.
const fixture = [
  { n: "8", rep: "", r: "Rue des Jardins", c: "Rosières-en-Haye", cp: "54385" },
  { n: "2", rep: "", r: "Rue des Jardins", c: "Abaucourt", cp: "54610" },
  { n: "6", rep: "", r: "Route Nationale", c: "Doncourt-aux-Templiers", cp: "55160" },
  { n: "12", rep: "", r: "Rue de la Gare", c: "Toul", cp: "54200" },
].map((e) => ({ ...e, _searchTokens: buildSearchTokens(e) }));

assertEqual(
  matchAdresseEntries(fixture, "4 rue des jardins 54385").map((e) => e.c),
  ["Rosières-en-Haye"],
  "CP complet filtre sur la bonne commune (ex-bug : plafond de requete rendait ca impossible)"
);

assertEqual(
  matchAdresseEntries(fixture, "rue des jardins 55").map((e) => e.c),
  [],
  "CP partiel par departement (55) exclut bien Abaucourt (54) -- ici aucune 'rue des jardins' en 55 dans le fixture"
);

assertEqual(
  matchAdresseEntries(fixture, "rue des jardins 54").map((e) => e.c).sort(),
  ["Abaucourt", "Rosières-en-Haye"],
  "CP partiel par departement (54) garde les deux communes du 54"
);

assertEqual(
  matchAdresseEntries(fixture, "12 nationale doncourt aux templiers").map((e) => e.c),
  ["Doncourt-aux-Templiers"],
  "mot-type de voie omis ('nationale' au lieu de 'route nationale') trouve quand meme la rue"
);

assertEqual(
  matchAdresseEntries(fixture, "doncourt templiers nationale").map((e) => e.c),
  ["Doncourt-aux-Templiers"],
  "ordre des mots totalement libre (ville avant la rue) -- coeur de la demande explicite \"comme google map\""
);

assertEqual(
  matchAdresseEntries(fixture, "8 rue des jardins").map((e) => `${e.n} ${e.c}`),
  ["8 Rosières-en-Haye", "2 Abaucourt"],
  "numero tape trie les resultats (exact d'abord) sans jamais exclure les autres"
);

assertEqual(matchAdresseEntries(fixture, "xyzzy"), [], "aucune correspondance -> liste vide");
assertEqual(matchAdresseEntries(fixture, ""), [], "saisie vide -> liste vide");

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
