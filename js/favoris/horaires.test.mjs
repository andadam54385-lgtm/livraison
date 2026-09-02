import {
  JOURS,
  JOURS_OUVRES,
  jourKeyForDate,
  emptyHoraires,
  emptyJour,
  horairesOf,
  openWindowsForJour,
  closedWindowsForJour,
  appliquerJour,
  resumeJour,
  horairesSontVides,
  SECONDES_PAR_JOUR,
} from "./horaires.js";

let failures = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}
const H = (h, m = 0) => h * 3600 + m * 60;
const jour = (patch) => ({ ...emptyJour(), ...patch });
const unJour = (patch) => ({ x: jour(patch) });

console.log("=== Cle de jour ===");
{
  assertEqual(jourKeyForDate(new Date(2026, 8, 2)), "mer", "2 septembre 2026 = mercredi");
  assertEqual(jourKeyForDate(new Date(2026, 8, 6)), "dim", "6 septembre 2026 = dimanche (getDay 0)");
  assertEqual(jourKeyForDate(new Date(2026, 8, 7)), "lun", "7 septembre 2026 = lundi");
  assertEqual(JOURS.length, 7, "sept jours");
}

console.log("\n=== Deux plages : matin et apres-midi ===");
{
  const h = unJour({ matinDebut: "08:00", matinFin: "12:00", apremDebut: "14:00", apremFin: "18:00" });
  assertEqual(openWindowsForJour(h, "x"), [[H(8), H(12)], [H(14), H(18)]], "deux plages ouvertes");
  assertEqual(
    closedWindowsForJour(h, "x"),
    [[0, H(8)], [H(12), H(14)], [H(18), H(24)]],
    "ferme avant, entre les deux, et apres"
  );
  assertEqual(resumeJour(h.x), "08:00–12:00 · 14:00–18:00", "resume");
}

console.log("\n=== Journee continue (la case cochee) ===");
{
  // "Si ca ouvre a 12 mais en continu, c'est bien de le savoir" : une seule
  // plage, bornee quand meme.
  const h = unJour({ continu: true, matinDebut: "12:00", apremFin: "18:00" });
  assertEqual(openWindowsForJour(h, "x"), [[H(12), H(18)]], "une seule plage");
  assertEqual(closedWindowsForJour(h, "x"), [[0, H(12)], [H(18), H(24)]], "ferme avant 12h et apres 18h");
  assertEqual(resumeJour(h.x), "12:00–18:00 en continu", "resume : le 'en continu' est dit");
  const sansBornes = unJour({ continu: true });
  assertEqual(closedWindowsForJour(sansBornes, "x"), [], "continu sans heures : jamais ferme");
  assertEqual(resumeJour(sansBornes.x), "", "continu sans heures : rien a afficher");
  // La case continue ignore les bornes de la coupure, elle ne les efface pas :
  // decocher doit retrouver les deux plages.
  const bascule = unJour({ continu: true, matinDebut: "08:00", matinFin: "12:00", apremDebut: "14:00", apremFin: "18:00" });
  assertEqual(openWindowsForJour(bascule, "x"), [[H(8), H(18)]], "en continu, la coupure est ignoree");
  bascule.x.continu = false;
  assertEqual(openWindowsForJour(bascule, "x"), [[H(8), H(12)], [H(14), H(18)]], "decoche : la coupure revient");
}

console.log("\n=== Jour ferme ===");
{
  const h = unJour({ ferme: true, matinDebut: "08:00", apremFin: "18:00" });
  assertEqual(closedWindowsForJour(h, "x"), [[0, H(24)]], "ferme toute la journee, quoi qu'il y ait dans les champs");
  assertEqual(openWindowsForJour(h, "x"), [], "aucune plage ouverte");
  assertEqual(resumeJour(h.x), "Fermé", "resume");
}

console.log("\n=== Saisies partielles : une heure saisie contraint toujours ===");
{
  assertEqual(closedWindowsForJour(unJour({ matinDebut: "10:00" }), "x"), [[0, H(10)]], "ouvre a 10 : ferme avant");
  assertEqual(closedWindowsForJour(unJour({ apremFin: "16:00" }), "x"), [[H(16), H(24)]], "ferme a 16 : ferme apres");
  assertEqual(
    closedWindowsForJour(unJour({ matinDebut: "08:00", matinFin: "12:00" }), "x"),
    [[0, H(8)], [H(12), H(24)]],
    "matin seul renseigne : ferme tout l'apres-midi"
  );
  assertEqual(closedWindowsForJour(unJour({}), "x"), [], "rien renseigne : aucune fenetre");
  assertEqual(closedWindowsForJour(emptyHoraires(), "inconnu"), [], "cle inconnue : aucune fenetre");
  assertEqual(closedWindowsForJour(unJour({ matinDebut: "14:00", matinFin: "12:00" }), "x"), [[0, H(24)]], "plage a l'envers : ecartee, donc ferme");
  // Coupure de duree nulle : les plages se touchent, aucune fenetre fermee au milieu.
  assertEqual(
    closedWindowsForJour(unJour({ matinDebut: "08:00", matinFin: "12:00", apremDebut: "12:00", apremFin: "18:00" }), "x"),
    [[0, H(8)], [H(18), H(24)]],
    "plages jointives : pas de fenetre fermee de duree nulle"
  );
}

console.log("\n=== Compatibilite avec les formats precedents ===");
{
  // Tout premier format : un seul couple fermeDebut/fermeFin, tous les jours.
  const h = horairesOf({ fermeDebut: "12:00", fermeFin: "14:00" });
  assertEqual(closedWindowsForJour(h, "lun"), [[H(12), H(14)]], "ancienne pause de midi, lundi");
  assertEqual(closedWindowsForJour(h, "dim"), [[H(12), H(14)]], "... et dimanche (tous les jours, comme avant)");
  // Format intermediaire (build 126) : ouverture/fermeture + pause.
  const h2 = horairesOf({ horaires: { mar: { ouverture: "08:30", fermeture: "18:00", pauseDebut: "12:00", pauseFin: "13:30" } } });
  assertEqual(
    closedWindowsForJour(h2, "mar"),
    [[0, H(8, 30)], [H(12), H(13, 30)], [H(18), H(24)]],
    "ouverture/fermeture + pause converties en deux plages"
  );
  const h3 = horairesOf({ horaires: { mer: { ouverture: "10:00", fermeture: "14:00" } } });
  assertEqual(closedWindowsForJour(h3, "mer"), [[0, H(10)], [H(14), H(24)]], "sans pause : journee d'un seul tenant");
  assertEqual(h3.mer.continu, true, "... et marquee comme continue");
  const h4 = horairesOf({ fermeDebut: "12:00", fermeFin: "14:00", horaires: { lun: { ferme: true } } });
  assertEqual(closedWindowsForJour(h4, "lun"), [[0, H(24)]], "horaires presents : ils priment sur l'ancien couple");
  assertEqual(closedWindowsForJour(h4, "mar"), [], "jour absent des horaires : vide, pas l'ancien couple");
  assertEqual(horairesSontVides(horairesOf(null)), true, "favori inexistant : horaires vides");
  assertEqual(horairesSontVides(horairesOf({})), true, "favori sans horaires : vides");
  assertEqual(horairesSontVides(horairesOf({ horaires: { dim: { ferme: true } } })), false, "un jour ferme n'est pas 'vide'");
}

console.log("\n=== Copier un jour sur d'autres ===");
{
  const h = emptyHoraires();
  h.lun = jour({ matinDebut: "10:00", matinFin: "12:00", apremDebut: "14:00", apremFin: "18:00" });
  const semaine = appliquerJour(h, "lun", JOURS_OUVRES);
  assertEqual(semaine.ven.matinDebut, "10:00", "vendredi recoit le lundi");
  assertEqual(semaine.sam.matinDebut, "", "samedi intact");
  assertEqual(h.ven.matinDebut, "", "l'original n'est pas modifie");
  semaine.ven.matinDebut = "09:00";
  assertEqual(semaine.lun.matinDebut, "10:00", "les jours copies sont des objets distincts");
}

console.log("\n=== Bornes de la journee ===");
{
  assertEqual(SECONDES_PAR_JOUR, 86400, "24 h en secondes");
  assertEqual(resumeJour(unJour({ continu: true, matinDebut: "" , apremFin: "18:00" }).x), "jusqu'à 18:00 en continu", "borne de fin seule");
  assertEqual(resumeJour(unJour({ matinDebut: "09:00" }).x), "à partir de 09:00", "borne de debut seule");
  assertEqual(resumeJour(null), "", "rien");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
