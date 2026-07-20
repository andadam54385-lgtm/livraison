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

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
