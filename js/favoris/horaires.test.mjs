import {
  JOURS,
  JOURS_OUVRES,
  jourKeyForDate,
  emptyHoraires,
  horairesOf,
  closedWindowsForJour,
  appliquerJour,
  resumeJour,
  horairesSontVides,
} from "./horaires.js";

let failures = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}
const H = (h, m = 0) => h * 3600 + m * 60;

console.log("=== Cle de jour ===");
{
  assertEqual(jourKeyForDate(new Date(2026, 8, 2)), "mer", "2 septembre 2026 = mercredi");
  assertEqual(jourKeyForDate(new Date(2026, 8, 6)), "dim", "6 septembre 2026 = dimanche (getDay 0)");
  assertEqual(jourKeyForDate(new Date(2026, 8, 7)), "lun", "7 septembre 2026 = lundi");
  assertEqual(JOURS.length, 7, "sept jours");
}

console.log("\n=== Fenetres fermees d'un jour ===");
{
  const h = emptyHoraires();
  assertEqual(closedWindowsForJour(h, "lun"), [], "rien renseigne : aucune fenetre");
  h.lun = { ferme: false, ouverture: "10:00", fermeture: "14:00", pauseDebut: "", pauseFin: "" };
  assertEqual(closedWindowsForJour(h, "lun"), [[0, H(10)], [H(14), H(24)]], "ouvre a 10, ferme a 14 : ferme avant et apres");
  h.mar = { ferme: false, ouverture: "", fermeture: "", pauseDebut: "12:00", pauseFin: "14:00" };
  assertEqual(closedWindowsForJour(h, "mar"), [[H(12), H(14)]], "pause seule");
  h.mer = { ferme: false, ouverture: "08:30", fermeture: "18:00", pauseDebut: "12:00", pauseFin: "13:30" };
  assertEqual(closedWindowsForJour(h, "mer"), [[0, H(8, 30)], [H(12), H(13, 30)], [H(18), H(24)]], "journee complete : trois fenetres triees");
  h.jeu = { ferme: true, ouverture: "08:00", fermeture: "18:00", pauseDebut: "", pauseFin: "" };
  assertEqual(closedWindowsForJour(h, "jeu"), [[0, H(24)]], "jour ferme : toute la journee, quoi qu'il y ait dans les autres champs");
  h.ven = { ferme: false, ouverture: "", fermeture: "", pauseDebut: "14:00", pauseFin: "12:00" };
  assertEqual(closedWindowsForJour(h, "ven"), [], "pause a l'envers : ignoree");
  assertEqual(closedWindowsForJour(h, "inconnu"), [], "cle inconnue : aucune fenetre");
}

console.log("\n=== Compatibilite avec l'ancien couple fermeDebut/fermeFin ===");
{
  const h = horairesOf({ fermeDebut: "12:00", fermeFin: "14:00" });
  assertEqual(closedWindowsForJour(h, "lun"), [[H(12), H(14)]], "ancienne pause de midi appliquee au lundi");
  assertEqual(closedWindowsForJour(h, "dim"), [[H(12), H(14)]], "... et au dimanche (tous les jours, comme avant)");
  const h2 = horairesOf({ fermeDebut: "12:00", fermeFin: "14:00", horaires: { lun: { ferme: true } } });
  assertEqual(closedWindowsForJour(h2, "lun"), [[0, H(24)]], "horaires presents : ils priment sur l'ancien couple");
  assertEqual(closedWindowsForJour(h2, "mar"), [], "jour absent des horaires : vide, pas l'ancien couple");
  assertEqual(horairesSontVides(horairesOf(null)), true, "favori inexistant : horaires vides");
  assertEqual(horairesSontVides(horairesOf({})), true, "favori sans horaires : vides");
}

console.log("\n=== Copier un jour sur d'autres ===");
{
  const h = emptyHoraires();
  h.lun = { ferme: false, ouverture: "10:00", fermeture: "14:00", pauseDebut: "", pauseFin: "" };
  const semaine = appliquerJour(h, "lun", JOURS_OUVRES);
  assertEqual(semaine.ven.ouverture, "10:00", "vendredi recoit le lundi");
  assertEqual(semaine.sam.ouverture, "", "samedi intact");
  assertEqual(h.ven.ouverture, "", "l'original n'est pas modifie");
  semaine.ven.ouverture = "09:00";
  assertEqual(semaine.lun.ouverture, "10:00", "les jours copies sont des objets distincts");
}

console.log("\n=== Resume d'un jour ===");
{
  assertEqual(resumeJour({ ferme: true }), "Fermé", "ferme");
  assertEqual(resumeJour({ ferme: false, ouverture: "10:00", fermeture: "14:00", pauseDebut: "", pauseFin: "" }), "ouvre 10:00 · ferme 14:00", "ouvre/ferme");
  assertEqual(resumeJour({ ferme: false, ouverture: "", fermeture: "", pauseDebut: "12:00", pauseFin: "14:00" }), "pause 12:00–14:00", "pause");
  assertEqual(resumeJour(null), "", "rien");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
