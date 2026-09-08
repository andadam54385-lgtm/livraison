// Tests de la selection des colis au recalcul en place (recalc-eligibles.js).
//
// Le point central : un colis "en_tournee" qui n'appartient PAS a la tournee
// recalculee (orphelin d'une tournee disparue) ne doit JAMAIS etre retrie --
// c'est le bug des "33 adresses qui n'ont rien a voir avec aujourd'hui".
//
// Lancer : node js/routing/recalc-eligibles.test.mjs

import { pickRecalcEligibles } from "./recalc-eligibles.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

const colis = (id, statut) => ({ id, statut, geocode: { status: "ok", lat: 48.7, lon: 5.9 } });
const ids = (list) => list.map((c) => c.id);

console.log("\n=== Cas 1 : les orphelins en_tournee hors tournee sont ignores (le bug) ===");
{
  const tour = {
    stops: [
      { colisId: "A", ordre: 1, statutLivraison: "a_livrer" },
      { colisId: "B", ordre: 2, statutLivraison: "a_livrer" },
    ],
  };
  // colisById ne contient que les colis de la tournee : les orphelins
  // "X1..X33" existent en base avec statut en_tournee, mais ne sont
  // references par aucun arret -- ils ne doivent pas apparaitre.
  const colisById = new Map([
    ["A", colis("A", "en_tournee")],
    ["B", colis("B", "en_tournee")],
  ]);
  const result = pickRecalcEligibles({ tour, colisById, pretColis: [] });
  check("seuls les arrets de la tournee sont retries", ids(result), ["A", "B"]);
}

console.log("\n=== Cas 2 : arrets deja livres/en echec exclus, ordre de tournee conserve ===");
{
  const tour = {
    stops: [
      { colisId: "C", ordre: 3, statutLivraison: "a_livrer" },
      { colisId: "A", ordre: 1, statutLivraison: "livre" },
      { colisId: "B", ordre: 2, statutLivraison: "echec" },
      { colisId: "D", ordre: 4, statutLivraison: "a_livrer" },
    ],
  };
  const colisById = new Map(["A", "B", "C", "D"].map((id) => [id, colis(id, "en_tournee")]));
  const result = pickRecalcEligibles({ tour, colisById, pretColis: [] });
  check("livre/echec restent fixes, les a_livrer dans l'ordre", ids(result), ["C", "D"]);
}

console.log("\n=== Cas 3 : les colis 'pret' scannes entre-temps sont ajoutes, sans doublon ===");
{
  const tour = { stops: [{ colisId: "A", ordre: 1, statutLivraison: "a_livrer" }] };
  const colisById = new Map([["A", colis("A", "en_tournee")]]);
  // "A" en double ne doit apparaitre qu'une fois ; "N" est un nouveau scan
  // dont l'insertion au moindre detour n'a pas abouti.
  const pretColis = [colis("N", "pret"), colis("A", "pret")];
  const result = pickRecalcEligibles({ tour, colisById, pretColis });
  check("tournee + nouveaux 'pret', dedoublonne", ids(result), ["A", "N"]);
}

console.log("\n=== Cas 4 : colis supprime ou deja traite malgre un arret a_livrer ===");
{
  const tour = {
    stops: [
      { colisId: "GONE", ordre: 1, statutLivraison: "a_livrer" }, // efface via "Effacer les colis"
      { colisId: "L", ordre: 2, statutLivraison: "a_livrer" }, // livre par un autre chemin
      { colisId: "K", ordre: 3, statutLivraison: "a_livrer" },
    ],
  };
  const colisById = new Map([
    ["L", colis("L", "livre")],
    ["K", colis("K", "en_tournee")],
  ]);
  const result = pickRecalcEligibles({ tour, colisById, pretColis: [] });
  check("ni le colis disparu ni le colis livre ne sont retries", ids(result), ["K"]);
}

console.log("\n=== Cas 5 : tournee vide ou absente -> seulement les 'pret' ===");
{
  const result = pickRecalcEligibles({ tour: null, colisById: new Map(), pretColis: [colis("P", "pret")] });
  check("sans tournee, retourne les 'pret'", ids(result), ["P"]);
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} TEST(S) EN ECHEC`);
process.exit(failures === 0 ? 0 : 1);
