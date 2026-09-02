import { hhmmToSec } from "../lib/geo-utils.js";

// Horaires d'ouverture JOUR PAR JOUR d'une adresse favorite -- retour terrain :
// "les horaires jour par jour, avec possibilite de les appliquer sur d'autres
// jours et de fermer un jour en entier, mais aussi debut et fin : parfois ca
// ouvre a 10 ou ferme a 14h". Module PUR (aucun DOM, aucun IndexedDB) pour
// rester testable : ce qui compte, c'est la traduction en fenetres FERMEES
// pour l'optimiseur (voir tourCost dans tsp.js), et elle doit etre juste.
//
// Un jour = { ferme, ouverture, fermeture, pauseDebut, pauseFin } (heures en
// "HH:MM", chaine vide = non renseigne). Un favori porte `horaires` = un objet
// par cle de jour ; les favoris d'avant ce module portent l'ancien couple
// fermeDebut/fermeFin (une seule pause, tous les jours), lu tel quel par
// horairesOf.

export const JOURS = [
  { key: "lun", label: "Lun" },
  { key: "mar", label: "Mar" },
  { key: "mer", label: "Mer" },
  { key: "jeu", label: "Jeu" },
  { key: "ven", label: "Ven" },
  { key: "sam", label: "Sam" },
  { key: "dim", label: "Dim" },
];
export const JOURS_OUVRES = ["lun", "mar", "mer", "jeu", "ven"];
export const TOUS_LES_JOURS = JOURS.map((j) => j.key);

const SECONDES_PAR_JOUR = 24 * 3600;

// getDay() : 0 = dimanche, 1 = lundi ... -> cle de jour.
export function jourKeyForDate(date = new Date()) {
  return JOURS[(date.getDay() + 6) % 7].key;
}

export function emptyJour() {
  return { ferme: false, ouverture: "", fermeture: "", pauseDebut: "", pauseFin: "" };
}

export function emptyHoraires() {
  const h = {};
  for (const j of JOURS) h[j.key] = emptyJour();
  return h;
}

export function horairesOf(favori) {
  const out = emptyHoraires();
  if (favori?.horaires && typeof favori.horaires === "object") {
    for (const j of JOURS) {
      const src = favori.horaires[j.key];
      if (src && typeof src === "object") out[j.key] = { ...emptyJour(), ...src, ferme: Boolean(src.ferme) };
    }
    return out;
  }
  // Favori d'avant ce module : une seule pause, valable tous les jours.
  if (favori?.fermeDebut && favori?.fermeFin) {
    for (const j of JOURS) out[j.key] = { ...emptyJour(), pauseDebut: favori.fermeDebut, pauseFin: favori.fermeFin };
  }
  return out;
}

export function jourEstVide(jour) {
  return !jour || (!jour.ferme && !jour.ouverture && !jour.fermeture && !jour.pauseDebut && !jour.pauseFin);
}

export function horairesSontVides(horaires) {
  return JOURS.every((j) => jourEstVide(horaires?.[j.key]));
}

// Fenetres FERMEES d'un jour, en secondes depuis minuit, triees : ce que
// tourCost penalise. Jour ferme = toute la journee ; sinon avant l'ouverture,
// la pause (si ses deux bornes sont la et dans l'ordre) et apres la fermeture.
// Une borne incoherente (pause a l'envers, ouverture a 00:00) est ignoree
// plutot que de produire une fenetre absurde.
export function closedWindowsForJour(horaires, jourKey) {
  const jour = horaires?.[jourKey];
  if (!jour) return [];
  if (jour.ferme) return [[0, SECONDES_PAR_JOUR]];
  const wins = [];
  const ouverture = hhmmToSec(jour.ouverture);
  const fermeture = hhmmToSec(jour.fermeture);
  const pauseDebut = hhmmToSec(jour.pauseDebut);
  const pauseFin = hhmmToSec(jour.pauseFin);
  if (ouverture != null && ouverture > 0) wins.push([0, ouverture]);
  if (pauseDebut != null && pauseFin != null && pauseFin > pauseDebut) wins.push([pauseDebut, pauseFin]);
  if (fermeture != null && fermeture > 0 && fermeture < SECONDES_PAR_JOUR) wins.push([fermeture, SECONDES_PAR_JOUR]);
  return wins.sort((a, b) => a[0] - b[0]);
}

// Recopie le jour `sourceKey` sur les jours `ciblesKeys` (la source elle-meme
// est laissee telle quelle). Renvoie un NOUVEL objet.
export function appliquerJour(horaires, sourceKey, ciblesKeys) {
  const out = { ...horaires };
  const src = { ...(horaires[sourceKey] || emptyJour()) };
  for (const k of ciblesKeys) {
    if (k !== sourceKey) out[k] = { ...src };
  }
  return out;
}

// Texte court d'un jour pour l'affichage ("Fermé", "ouvre 10:00 · pause
// 12:00–14:00 · ferme 17:00"), vide si rien n'est renseigne.
export function resumeJour(jour) {
  if (jourEstVide(jour)) return "";
  if (jour.ferme) return "Fermé";
  const parts = [];
  if (jour.ouverture) parts.push(`ouvre ${jour.ouverture}`);
  if (jour.pauseDebut && jour.pauseFin) parts.push(`pause ${jour.pauseDebut}–${jour.pauseFin}`);
  if (jour.fermeture) parts.push(`ferme ${jour.fermeture}`);
  return parts.join(" · ");
}
