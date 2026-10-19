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

console.log("\n=== 'st' = 'saint' et ligatures (terrain 2026-09-11 : aucune proposition) ===");
// "4 Notre dame St mihiel" ne proposait RIEN : la recherche exige que chaque
// mot tape soit le PREFIXE d'un mot de l'adresse, et "saint" ne commence pas
// par "st". Meme probleme pour "kœur" : la ligature n'etant ni une lettre a-z
// ni un accent decomposable, elle servait de SEPARATEUR et coupait le mot en
// "k" + "ur" -- taper "koeur" ne trouvait rien.
{
  assertEqual(tokenizeQuery("Kœur-la-Grande"), ["koeur", "la", "grande"], "ligature oe developpee, pas coupee");
  assertEqual(tokenizeQuery("Vandœuvre-lès-Nancy"), ["vandoeuvre", "les", "nancy"], "idem Vandoeuvre");
  assertEqual(tokenizeQuery("Tær"), ["taer"], "ligature ae developpee");
  // Alias pose sur l'ENTREE, dans les deux sens : la base ecrit les deux
  // formes (13 542 adresses "saint...", 24 "st...").
  assertEqual(buildSearchTokens({ r: "Rue Notre Dame", c: "Saint-Mihiel", cp: "55300" }).includes("st"), true, '"saint" de la base porte aussi l\'alias "st"');
  assertEqual(buildSearchTokens({ r: "Rue St Claude", c: "Toul", cp: "54200" }).includes("saint"), true, '"st" de la base porte aussi l\'alias "saint"');
  assertEqual(buildSearchTokens({ r: "Rue Sainte Claire", c: "Villerupt", cp: "54190" }).includes("ste"), true, '"sainte" porte l\'alias "ste"');

  const fixtureSaint = [
    { n: "4", rep: "", r: "Rue Notre Dame", c: "Saint-Mihiel", cp: "55300" },
    { n: "2", rep: "", r: "Rue de l'Orme", c: "Kœur-la-Grande", cp: "55300" },
    { n: "9", rep: "", r: "Rue des Iris", c: "Stenay", cp: "55700" },
    { n: "6", rep: "", r: "Rue du College St Claude", c: "Toul", cp: "54200" },
  ].map((e) => ({ ...e, _searchTokens: buildSearchTokens(e) }));
  const villes = (q) => matchAdresseEntries(fixtureSaint, q, 5).map((e) => e.c);

  assertEqual(villes("4 Notre dame St mihiel"), ["Saint-Mihiel"], "la saisie exacte du terrain propose enfin l'adresse");
  assertEqual(villes("4 notre dame saint mihiel"), ["Saint-Mihiel"], "la forme en toutes lettres marche toujours");
  assertEqual(villes("2 orme koeur"), ["Kœur-la-Grande"], '"koeur" tape a plat trouve "Kœur"');
  assertEqual(villes("2 orme kœur"), ["Kœur-la-Grande"], "et la ligature tapee aussi");
  assertEqual(villes("college saint claude"), ["Toul"], '"saint" tape trouve une rue ecrite "St" dans la base');
  // Garde-fou : le mot tape n'est JAMAIS reecrit, sinon "ste" deviendrait
  // "sainte" et Stenay disparaitrait en cours de frappe.
  assertEqual(villes("stenay"), ["Stenay"], "Stenay reste trouvable");
  assertEqual(villes("ste"), ["Stenay"], '"ste" en cours de frappe propose encore Stenay');
}

console.log("\n=== matchAdresseEntries avec `pres` : les plus proches d'abord (2026-10-09) ===");
{
  // "Rue de Metz" existe a Nancy, Frouard et Custines ; la base les stocke
  // dans cet ordre (Nancy en premier), le livreur est a Pompey.
  const rueDeMetz = [
    { n: "40", rep: "", r: "Rue de Metz", c: "Nancy", cp: "54000", lat: 48.70, lon: 6.18 },
    { n: "12", rep: "", r: "Rue de Metz", c: "Nancy", cp: "54000", lat: 48.701, lon: 6.181 },
    { n: "40", rep: "", r: "Rue de Metz", c: "Frouard", cp: "54390", lat: 48.7586, lon: 6.1348 },
    { n: "91", rep: "", r: "Rue de Metz", c: "Frouard", cp: "54390", lat: 48.7580, lon: 6.1364 },
    { n: "40", rep: "", r: "Rue de Metz", c: "Custines", cp: "54670", lat: 48.7915, lon: 6.1246 },
    { n: "62", rep: "", r: "Rue de Metz", c: "Custines", cp: "54670", lat: 48.7941, lon: 6.1179 },
  ].map((e) => ({ ...e, _searchTokens: buildSearchTokens(e) }));
  const pompey = { lat: 48.7672, lon: 6.1278 };
  const res = (q) => matchAdresseEntries(rueDeMetz, q, 6, { pres: pompey }).map((e) => `${e.n} ${e.c}`);

  assertEqual(res("40 rue de metz"), ["40 Frouard", "40 Custines", "40 Nancy"], "numero exact, du plus proche au plus loin (Nancy ne passe plus devant)");
  assertEqual(res("rue de metz").length, 3, "une seule suggestion par rue et par commune (6 adresses, 3 rues)");
  assertEqual(res("rue de metz").map((x) => x.split(" ")[1]), ["Frouard", "Custines", "Nancy"], "sans numero : communes de la plus proche a la plus loin");
  assertEqual(res("62 rue de metz")[0], "62 Custines", "le numero exact passe devant une rue plus proche");
  assertEqual(
    matchAdresseEntries(rueDeMetz, "40 rue de metz", 6).slice(0, 3).map((e) => e.c),
    ["Nancy", "Frouard", "Custines"],
    "sans `pres` : comportement d'origine inchange (ordre de la base, Nancy en tete)"
  );

  // Rayon de 20 km : la rue proche passe devant le bon numero tres loin ; et
  // s'il manque des propositions proches, la recherche va plus loin.
  const avecLointaine = [
    ...rueDeMetz,
    { n: "7", rep: "", r: "Rue de Metz", c: "Verdun", cp: "55100", lat: 49.16, lon: 5.38 },
  ].map((e) => ({ ...e, _searchTokens: buildSearchTokens(e) }));
  const proches = (q, limit) => matchAdresseEntries(avecLointaine, q, limit, { pres: pompey }).map((e) => `${e.n} ${e.c}`);
  assertEqual(proches("7 rue de metz", 3)[0].endsWith("Frouard"), true, "le n°7 a Verdun (60 km) ne passe pas devant la Rue de Metz proche");
  assertEqual(proches("7 rue de metz", 6).includes("7 Verdun"), true, "moins de 6 rues proches -> Verdun proposee quand meme, en dernier");

  // Plusieurs points de reference (preparation au depot, colis deja saisis a
  // Custines ET a Verdun) : chaque adresse est jugee a son point le plus proche.
  const deuxVillages = [{ lat: 48.7915, lon: 6.1246 }, { lat: 49.16, lon: 5.38 }];
  const multi = (q) => matchAdresseEntries(avecLointaine, q, 6, { pres: deuxVillages }).map((e) => e.c);
  assertEqual(multi("7 rue de metz")[0], "Verdun", "numero exact a cote d'un des points (Verdun) -> en tete");
  assertEqual(multi("rue de metz").slice(0, 2), ["Custines", "Verdun"], "chaque village saisi attire ses propres rues");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
