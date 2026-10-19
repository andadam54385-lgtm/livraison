// Regression : "6 Rue de l'Église, 54470 Ansauville" (etiquette reelle,
// voir js/scan/parse-ups-label.test.mjs cas 1) etait geocode a tort vers
// "6 Rue de l'Église, 54470 Rembercourt-sur-Mad" -- une commune differente
// partageant le meme code postal, avec exactement le meme nom de rue (tres
// courant en zone rurale : "Rue de l'Église" existe dans des dizaines de
// villages). Corrige dans scoreCandidates() : voir le commentaire dans
// match-address.js pour le detail du bug (plafond de score qui ecrasait le
// bonus commune).
import { scoreCandidates, looseCommune } from "./match-address.js";
import { normalizeStreet, normalizeCity } from "./normalize-address.js";

let failures = 0;

function assert(cond, label) {
  if (!cond) failures++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
}

// Extrait reel de assets/ban.json (cp 54470) : plusieurs communes partagent
// "Rue de l'Église" au numero 6, avec des variantes d'apostrophe (l'entree
// source BAN utilise tantot une apostrophe droite, tantot typographique --
// voir le commentaire "point 3" dans la memoire du bug pour le detail).
const pool = [
  { n: "6", r: "Rue de l'Eglise", rn: normalizeStreet("Rue de l'Eglise"), cp: "54470", c: "Ansauville", cn: "ansauville" },
  { n: "6", r: "Rue de l'Eglise", rn: normalizeStreet("Rue de l'Eglise"), cp: "54470", c: "Saint-Julien-lès-Gorze", cn: "saint-julien-les-gorze" },
  { n: "6", r: "Rue de l'Eglise", rn: normalizeStreet("Rue de l'Eglise"), cp: "54470", c: "Lironville", cn: "lironville" },
  { n: "6", r: "Rue de l’Eglise", rn: normalizeStreet("Rue de l’Eglise"), cp: "54470", c: "Rembercourt-sur-Mad", cn: "rembercourt-sur-mad" }, // apostrophe typographique dans la source
];

const normRue = normalizeStreet("Rue de l'Eglise");
const normCommune = normalizeCity("Ansauville");
const scored = scoreCandidates(pool, { normRue, normCommune, numero: "6" });

assert(scored[0].entry.c === "Ansauville", `la commune correctement identifiee doit gagner nettement (obtenu: ${scored[0].entry.c})`);
assert(scored[0].score > scored[1].score + 0.1, `l'ecart avec le 2e candidat doit etre net, pas un quasi-ex-aequo (obtenu: ${scored[0].score.toFixed(3)} vs ${scored[1].score.toFixed(3)})`);
assert(
  scored.find((s) => s.entry.c === "Rembercourt-sur-Mad").score < scored[0].score,
  "Rembercourt-sur-Mad (mauvaise commune) ne doit jamais devancer Ansauville"
);

// Regression : retour terrain "modifie parfois le numero, n'accepte pas les
// bis/a/b". Deux bugs distincts corriges (voir splitNumeroRue dans
// scan-ui.js et scoreCandidates ci-dessus) : la saisie "6a" ne s'extrayait
// pas du tout comme numero, et meme quand un suffixe etait reconnu (bis/ter)
// il n'etait jamais compare a entry.rep -- plusieurs entrees BAN au meme
// numero de base ("6", "6 bis", "6 A"...) etaient donc indiscernables, le
// mauvais candidat pouvait gagner par bruit de similarite de rue.
{
  const repPool = [
    { n: "6", rep: "", r: "Rue de l'Eglise", rn: normRue, cp: "54470", c: "Ansauville", cn: "ansauville" },
    { n: "6", rep: "A", r: "Rue de l'Eglise", rn: normRue, cp: "54470", c: "Ansauville", cn: "ansauville" },
    { n: "6", rep: "B", r: "Rue de l'Eglise", rn: normRue, cp: "54470", c: "Ansauville", cn: "ansauville" },
  ];
  const repScored = scoreCandidates(repPool, { normRue, normCommune, numero: "6a" });
  assert(repScored[0].entry.rep === "A", `"6a" doit faire gagner l'entree rep=A (obtenu: rep=${repScored[0].entry.rep || "(aucun)"})`);
  assert(
    repScored[0].score > repScored.find((s) => s.entry.rep === "B").score,
    "l'entree rep=A doit nettement devancer l'entree rep=B pour une recherche '6a'"
  );
}

// Regression : commune tapee/OCRisee sans les tirets ("Rembercourt sur Mad")
// perdait tout le bonus commune face a l'entree BAN "Rembercourt-sur-Mad" --
// frequent, beaucoup de communes francaises ont un nom compose.
{
  const hyphenPool = [
    { n: "6", rep: "", r: "Rue de l'Eglise", rn: normRue, cp: "54470", c: "Ansauville", cn: "ansauville" },
    { n: "6", rep: "", r: "Rue de l'Eglise", rn: normRue, cp: "54470", c: "Rembercourt-sur-Mad", cn: "rembercourt-sur-mad" },
  ];
  const hyphenScored = scoreCandidates(hyphenPool, { normRue, normCommune: normalizeCity("Rembercourt sur Mad"), numero: "6" });
  assert(
    hyphenScored[0].entry.c === "Rembercourt-sur-Mad",
    `"Rembercourt sur Mad" (sans tirets) doit quand meme matcher "Rembercourt-sur-Mad" (obtenu: ${hyphenScored[0].entry.c})`
  );
}

// Regression (retour terrain, Onville) : "33 GORZE RUE" -- ordre du terminal,
// type de voie en fin -- etait geocode "33 Grande Rue" au lieu de "33 Rue de
// Gorze". Extrait reel de la BAN d'Onville (54890).
{
  const onville = (n, r) => ({ n, rep: "", r, rn: normalizeStreet(r), cp: "54890", c: "Onville", cn: "onville" });
  const poolOnville = [
    onville("33", "Grande Rue"),
    onville("33", "Rue de Gorze"),
    onville("14", "Grande Rue"),
    onville("14", "Rue de Gorze"),
    onville("26", "Grande Rue"),
  ];
  const communeOnville = normalizeCity("Onville");
  for (const numero of ["33", "14"]) {
    const scored = scoreCandidates(poolOnville, { normRue: normalizeStreet("GORZE RUE"), normCommune: communeOnville, numero });
    assert(
      scored[0].entry.r === "Rue de Gorze" && scored[0].entry.n === numero,
      `"${numero} GORZE RUE" doit donner "${numero} Rue de Gorze" (obtenu: ${scored[0].entry.n} ${scored[0].entry.r})`
    );
    const grandeRue = scored.find((s) => s.entry.r === "Grande Rue" && s.entry.n === numero);
    // Avant le correctif, Grande Rue DEVANCAIT Rue de Gorze (0.956 vs 0.933) ;
    // l'ecart attendu ici est celui qu'apporte la penalite de mots porteurs
    // sur la seule part "similarite de rue" du score (les bonus numero et
    // commune, identiques des deux cotes, ne bougent pas).
    assert(scored[0].score > grandeRue.score + 0.1, `... avec un ecart net sur "${numero} Grande Rue" (${scored[0].score.toFixed(3)} vs ${grandeRue.score.toFixed(3)})`);
  }
  // L'ordre BAN reste evidemment reconnu, et "Grande Rue" reste trouvable
  // quand c'est bien elle qu'on cherche.
  const direct = scoreCandidates(poolOnville, { normRue: normalizeStreet("Rue de Gorze"), normCommune: communeOnville, numero: "33" });
  assert(direct[0].entry.r === "Rue de Gorze", `"33 Rue de Gorze" inchange (obtenu: ${direct[0].entry.r})`);
  const grande = scoreCandidates(poolOnville, { normRue: normalizeStreet("GRANDE RUE"), normCommune: communeOnville, numero: "33" });
  assert(grande[0].entry.r === "Grande Rue", `"33 GRANDE RUE" donne bien Grande Rue (obtenu: ${grande[0].entry.r})`);
  // Faute OCR sur le mot porteur : toujours rattrapee (pas de faux ecart).
  const ocr = scoreCandidates(poolOnville, { normRue: normalizeStreet("GORSE RUE"), normCommune: communeOnville, numero: "33" });
  assert(ocr[0].entry.r === "Rue de Gorze", `"GORSE RUE" (faute OCR) donne encore Rue de Gorze (obtenu: ${ocr[0].entry.r})`);
}

// Regression (retour terrain) : "LT" = lotissement sur les listes du terminal.
// Piege verifie sur la vraie BAN : "Lt" y designe aussi un LIEUTENANT ("Rue du
// Lt Roland Excoffier" a Sexey-aux-Forges, "Rue du Lt Colonel Bauclin" a
// Seuil-d'Argonne -- les 74 seuls "lt" isoles des 366 396 entrees), et la BAN
// abrege elle-meme certains lotissements en "Lot ..." (8 libelles) : ni l'un
// ni l'autre ne doit bouger, sinon des adresses deja indexees deviennent
// introuvables. Voir expandLotissement dans normalize-address.js.
{
  const eq = (actual, expected, label) => assert(actual === expected, `${label} (obtenu: ${JSON.stringify(actual)})`);
  eq(normalizeStreet("LT LES ROSES"), "lotissement les roses", '"LT LES ROSES" : type de voie en tete');
  eq(normalizeStreet("LES ROSES LT"), "les roses lotissement", '"LES ROSES LT" : type de voie en fin (ordre du terminal)');
  eq(normalizeStreet("Rue du Lt Roland Excoffier"), "rue du lt roland excoffier", "lieutenant intact (article + type de voie deja present)");
  eq(normalizeStreet("Lot le Clos des Iris"), "lot le clos des iris", '"Lot" jamais expanse (la BAN elle-meme l\'ecrit ainsi)');

  const dombasle = (r) => ({ n: "5", rep: "", r, rn: normalizeStreet(r), cp: "54110", c: "Dombasle-sur-Meurthe", cn: "dombasle-sur-meurthe" });
  const poolRoses = [dombasle("Rue des Roses"), dombasle("Lotissement les Roses")];
  const communeRoses = normalizeCity("Dombasle-sur-Meurthe");
  // Avant l'expansion, "lt les roses" ressemblait plus a "rue des roses"
  // (meme longueur, meme squelette) qu'au lotissement cherche.
  const lot = scoreCandidates(poolRoses, { normRue: normalizeStreet("LT LES ROSES"), normCommune: communeRoses, numero: "5" });
  assert(lot[0].entry.r === "Lotissement les Roses", `"5 LT LES ROSES" doit donner le lotissement, pas la rue (obtenu: ${lot[0].entry.r})`);
  const rue = scoreCandidates(poolRoses, { normRue: normalizeStreet("RUE DES ROSES"), normCommune: communeRoses, numero: "5" });
  assert(rue[0].entry.r === "Rue des Roses", `"5 RUE DES ROSES" reste la rue (obtenu: ${rue[0].entry.r})`);

  const sexey = (r) => ({ n: "2", rep: "", r, rn: normalizeStreet(r), cp: "54550", c: "Sexey-aux-Forges", cn: "sexey-aux-forges" });
  const poolLt = [sexey("Rue de la Gare"), sexey("Rue du Lt Roland Excoffier")];
  const lieutenant = scoreCandidates(poolLt, { normRue: normalizeStreet("RUE DU LT ROLAND EXCOFFIER"), normCommune: normalizeCity("Sexey-aux-Forges"), numero: "2" });
  assert(
    lieutenant[0].entry.r === "Rue du Lt Roland Excoffier",
    `la rue du Lt (lieutenant) reste trouvable telle quelle (obtenu: ${lieutenant[0].entry.r})`
  );
}

// Regression (retour terrain 2026-09-11) : "il prend pas la ville s'il y a st
// au lieu de saint, et s'il n'y a pas le tiret ; et kœur il a du mal si je
// mets juste koeur". looseCommune est le point de comparaison UNIQUE des
// communes (bonus du geocodage, autocompletion de la fiche, dedoublonnage,
// communes connues du parser) : l'expansion "ST" -> "SAINT" y vit maintenant,
// au lieu du seul parser de liste.
{
  const memeCommune = (a, b) => looseCommune(a) === looseCommune(b);
  assert(memeCommune("st mihiel", "saint-mihiel"), '"st mihiel" = "saint-mihiel"');
  assert(memeCommune("saint mihiel", "saint-mihiel"), '"saint mihiel" (sans tiret) = "saint-mihiel"');
  assert(memeCommune("st-mihiel", "saint-mihiel"), '"st-mihiel" = "saint-mihiel"');
  assert(memeCommune("ste marie", "sainte-marie"), '"ste marie" = "sainte-marie"');
  assert(memeCommune("koeur-la-grande", "kœur-la-grande"), '"koeur" tape a plat = "kœur" de la base');
  assert(memeCommune("vandoeuvre les nancy", "vandœuvre-les-nancy"), "Vandoeuvre sans ligature ni tirets");
  // Jamais une sous-chaine : "st" doit rester un mot entier.
  assert(!memeCommune("stenay", "saintenay"), '"stenay" n\'est pas "saintenay" (st doit etre un mot entier)');
  assert(looseCommune("stenay") === "stenay", "une commune qui COMMENCE par st n'est pas touchee");

  // Effet reel : la commune tapee "st mihiel" redonne son bonus au bon
  // village. Sans elle, seul le CP tranchait -- et "Rue de Saint Mihiel"
  // existe a Ranzieres, aux Paroches et a Dompcevrin (bug du build 142).
  const p = (n, r, c, cn) => ({ n, rep: "", r, rn: normalizeStreet(r), cp: "55300", c, cn });
  const pool = [p("8", "Rue de Saint Mihiel", "Ranzières", "ranzieres"), p("8", "Rue du Temple", "Saint-Mihiel", "saint-mihiel")];
  const scored = scoreCandidates(pool, { normRue: normalizeStreet("TEMPLE RUE"), normCommune: normalizeCity("st mihiel"), numero: "8" });
  assert(scored[0].entry.c === "Saint-Mihiel", `"st mihiel" tape a la main donne bien Saint-Mihiel (obtenu: ${scored[0].entry.c})`);
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
