// Tests de l'annulation d'un "Livre"/"Echec" appuye par erreur
// (remettre-a-livrer.js). Lancer : node js/routing/remettre-a-livrer.test.mjs

import { remettreArretALivrer } from "./remettre-a-livrer.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

const tourDe = (stops) => ({ stops });
const espion = () => {
  const appels = [];
  return { appels, fn: (colisId, statut) => appels.push([colisId, statut]) };
};

console.log("=== Cas 1 : un 'Livre' par erreur redevient a livrer ===");
{
  const tour = tourDe([
    { colisId: "A", ordre: 1, statutLivraison: "livre", heureLivraison: "2026-09-15T09:12:00Z" },
    { colisId: "B", ordre: 2, statutLivraison: "a_livrer", heureLivraison: null },
  ]);
  const s = espion();
  check("renvoie true", remettreArretALivrer(tour, "A", s.fn), true);
  check("statut remis a a_livrer", tour.stops[0].statutLivraison, "a_livrer");
  check("heure de livraison effacee", tour.stops[0].heureLivraison, null);
  check("ordre conserve", tour.stops[0].ordre, 1);
  check("colis repasse en_tournee (une seule fois)", s.appels, [["A", "en_tournee"]]);
  check("l'autre arret n'est pas touche", tour.stops[1].statutLivraison, "a_livrer");
}

console.log("\n=== Cas 2 : un 'Echec' par erreur perd aussi son heure et son motif ===");
{
  const tour = tourDe([{ colisId: "E", ordre: 3, statutLivraison: "echec", heureEchec: "2026-09-15T10:00:00Z", raisonEchec: "absent" }]);
  const s = espion();
  check("renvoie true", remettreArretALivrer(tour, "E", s.fn), true);
  check("statut remis a a_livrer", tour.stops[0].statutLivraison, "a_livrer");
  check("heure d'echec supprimee", "heureEchec" in tour.stops[0], false);
  check("motif supprime (sinon il ressort dans l'export CSV)", "raisonEchec" in tour.stops[0], false);
  check("colis repasse en_tournee", s.appels, [["E", "en_tournee"]]);
}

console.log("\n=== Cas 3 : rien a annuler ===");
{
  const tour = tourDe([{ colisId: "P", ordre: 1, statutLivraison: "a_livrer", heureLivraison: null }]);
  const s = espion();
  check("arret deja a livrer : false", remettreArretALivrer(tour, "P", s.fn), false);
  check("aucune ecriture de statut colis", s.appels, []);
  check("colis absent de la tournee : false", remettreArretALivrer(tour, "INCONNU", s.fn), false);
  check("tournee absente : false, sans planter", remettreArretALivrer(null, "P", s.fn), false);
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} TEST(S) EN ECHEC`);
process.exit(failures === 0 ? 0 : 1);
