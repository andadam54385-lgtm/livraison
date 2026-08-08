// Regression : "6 Rue de l'Église, 54470 Ansauville" (etiquette reelle,
// voir js/scan/parse-ups-label.test.mjs cas 1) etait geocode a tort vers
// "6 Rue de l'Église, 54470 Rembercourt-sur-Mad" -- une commune differente
// partageant le meme code postal, avec exactement le meme nom de rue (tres
// courant en zone rurale : "Rue de l'Église" existe dans des dizaines de
// villages). Corrige dans scoreCandidates() : voir le commentaire dans
// match-address.js pour le detail du bug (plafond de score qui ecrasait le
// bonus commune).
import { scoreCandidates } from "./match-address.js";
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

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
