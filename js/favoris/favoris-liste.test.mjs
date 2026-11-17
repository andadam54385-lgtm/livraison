// Tests de l'ecran Favoris : recherche et resume d'une ligne (favoris-liste.js).
//
// Lancer : node js/favoris/favoris-liste.test.mjs

import { filtrerFavoris, resumeFavori } from "./favoris-liste.js";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

const favs = [
  { id: "a", rue: "12 Avenue Foch", cp: "54000", ville: "Nancy", note: "code 1234" },
  { id: "b", rue: "3 Rue des Jardins", cp: "88000", ville: "Épinal", note: "" },
  { id: "c", rue: "", cp: "55300", ville: "CHAUVONCOURT", note: "chien" },
];
const ids = (l) => l.map((f) => f.id);

// 1. Recherche.
check("recherche vide -> tout", ids(filtrerFavoris(favs, "")), ["a", "b", "c"]);
check("espaces seuls -> tout", ids(filtrerFavoris(favs, "   ")), ["a", "b", "c"]);
check("mot dans la rue", ids(filtrerFavoris(favs, "foch")), ["a"]);
check("deux mots dans le desordre (rue + ville)", ids(filtrerFavoris(favs, "nancy foch")), ["a"]);
check("sans accent trouve l'accent", ids(filtrerFavoris(favs, "epinal")), ["b"]);
check("majuscules indifferentes", ids(filtrerFavoris(favs, "CHAUV")), ["c"]);
check("cherche aussi dans la note", ids(filtrerFavoris(favs, "chien")), ["c"]);
check("code postal", ids(filtrerFavoris(favs, "880")), ["b"]);
check("un mot absent -> rien", ids(filtrerFavoris(favs, "foch metz")), []);

// 2. Ligne repliee.
check("titre = rue", resumeFavori(favs[0]).titre, "12 Avenue Foch");
check("sous-titre = cp + ville", resumeFavori(favs[0]).sousTitre, "54000 Nancy");
check("sans rue : titre = ville, sous-titre = cp seul", [resumeFavori(favs[2]).titre, resumeFavori(favs[2]).sousTitre], ["CHAUVONCOURT", "55300"]);
check("repere note", [resumeFavori(favs[0]).aNote, resumeFavori(favs[1]).aNote], [true, false]);
check("note faite d'espaces -> pas de repere", resumeFavori({ note: "   " }).aNote, false);
check("pas d'horaires -> pas de repere", resumeFavori(favs[0]).aHoraires, false);
check("horaires renseignes -> repere", resumeFavori({ horaires: { lun: { matinDebut: "08:00" } } }).aHoraires, true);
check("ancien format (pause unique) -> repere", resumeFavori({ fermeDebut: "12:00", fermeFin: "14:00" }).aHoraires, true);
check("favori vide -> titre de repli", resumeFavori({}).titre, "(adresse sans rue)");

// 3. Favori avec un nom (app perso : nom retrouve au scan).
{
  const garage = { id: "g", nom: "Garage Martin", rue: "4 Rue Carnot", cp: "54200", ville: "Toul", note: "" };
  check("nom en titre", resumeFavori(garage).titre, "Garage Martin");
  check("adresse complete en sous-titre", resumeFavori(garage).sousTitre, "4 Rue Carnot, 54200 Toul");
  check("recherche par le nom", ids(filtrerFavoris([...favs, garage], "garage")), ["g"]);
  check("nom fait d'espaces -> titre = rue", resumeFavori({ ...garage, nom: "  " }).titre, "4 Rue Carnot");
}

if (failures > 0) {
  console.log(`\n${failures} TEST(S) EN ECHEC`);
  process.exit(1);
}
console.log("\nTOUS LES TESTS SONT PASSES");
