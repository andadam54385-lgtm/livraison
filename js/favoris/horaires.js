import { hhmmToSec } from "../lib/geo-utils.js";

// Horaires d'ouverture JOUR PAR JOUR d'une adresse favorite -- retour terrain :
// "les horaires jour par jour, avec possibilite de les appliquer sur d'autres
// jours et de fermer un jour en entier", puis "mets ouvert le matin et ouvert
// l'apres-midi, ou continu s'il coche une touche -- mais il peut quand meme
// mettre des horaires d'ouverture (si ca ouvre a 12 mais en continu, c'est
// bien de le savoir)". D'ou DEUX PLAGES par defaut (matin, apres-midi) et une
// case "journee continue" qui n'en laisse qu'UNE, bornee elle aussi.
//
// Module PUR (aucun DOM, aucun IndexedDB) pour rester testable : ce qui
// compte, c'est la traduction en fenetres FERMEES pour l'optimiseur (voir
// tourCost dans tsp.js), et elle doit etre juste.
//
// Un jour = { ferme, continu, matinDebut, matinFin, apremDebut, apremFin }
// (heures en "HH:MM", chaine vide = non renseigne). En mode continu, les
// bornes de la journee sont matinDebut (ouverture) et apremFin (fermeture) :
// ce sont deja le debut et la fin de la journee dans l'autre mode, donc
// basculer d'un mode a l'autre ne perd jamais ces deux heures-la.
// Un favori porte `horaires` = un objet par cle de jour ; les favoris plus
// anciens portent une forme precedente (ouverture/fermeture/pauseDebut/
// pauseFin) ou le tout premier couple fermeDebut/fermeFin -- les deux sont
// converties par horairesOf.

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

export const SECONDES_PAR_JOUR = 24 * 3600;

// getDay() : 0 = dimanche, 1 = lundi ... -> cle de jour.
export function jourKeyForDate(date = new Date()) {
  return JOURS[(date.getDay() + 6) % 7].key;
}

export function emptyJour() {
  return { ferme: false, continu: false, matinDebut: "", matinFin: "", apremDebut: "", apremFin: "" };
}

export function emptyHoraires() {
  const h = {};
  for (const j of JOURS) h[j.key] = emptyJour();
  return h;
}

// Convertit un jour d'une forme precedente (ouverture/fermeture + pause) vers
// la forme a deux plages.
function fromLegacyJour(src) {
  const jour = { ...emptyJour(), ferme: Boolean(src.ferme) };
  if (src.pauseDebut && src.pauseFin) {
    jour.matinDebut = src.ouverture || "";
    jour.matinFin = src.pauseDebut;
    jour.apremDebut = src.pauseFin;
    jour.apremFin = src.fermeture || "";
  } else {
    // Pas de pause : la journee est d'un seul tenant.
    jour.continu = true;
    jour.matinDebut = src.ouverture || "";
    jour.apremFin = src.fermeture || "";
  }
  return jour;
}

export function horairesOf(favori) {
  const out = emptyHoraires();
  if (favori?.horaires && typeof favori.horaires === "object") {
    for (const j of JOURS) {
      const src = favori.horaires[j.key];
      if (!src || typeof src !== "object") continue;
      const estAncien = "ouverture" in src || "fermeture" in src || "pauseDebut" in src || "pauseFin" in src;
      out[j.key] = estAncien ? fromLegacyJour(src) : { ...emptyJour(), ...src, ferme: Boolean(src.ferme), continu: Boolean(src.continu) };
    }
    return out;
  }
  // Tout premier format : une seule pause, valable tous les jours.
  if (favori?.fermeDebut && favori?.fermeFin) {
    for (const j of JOURS) out[j.key] = { ...emptyJour(), matinFin: favori.fermeDebut, apremDebut: favori.fermeFin };
  }
  return out;
}

export function jourEstVide(jour) {
  if (!jour) return true;
  if (jour.ferme) return false;
  return !jour.matinDebut && !jour.matinFin && !jour.apremDebut && !jour.apremFin;
}

export function horairesSontVides(horaires) {
  return JOURS.every((j) => jourEstVide(horaires?.[j.key]));
}

// Plages OUVERTES d'un jour, en secondes depuis minuit. Une plage dont une
// seule borne est renseignee s'etend jusqu'au bout de la journee du cote
// manquant ("ouvre a 14h" = ouvert 14h -> minuit), plutot que d'etre ignoree :
// une heure saisie doit toujours contraindre quelque chose.
export function openWindowsForJour(horaires, jourKey) {
  const jour = horaires?.[jourKey];
  if (!jour || jour.ferme) return [];
  const borne = (v, defaut) => {
    const s = hhmmToSec(v);
    return s == null ? defaut : s;
  };
  if (jour.continu) {
    if (!jour.matinDebut && !jour.apremFin) return [[0, SECONDES_PAR_JOUR]];
    return [[borne(jour.matinDebut, 0), borne(jour.apremFin, SECONDES_PAR_JOUR)]].filter(([a, b]) => b > a);
  }
  const plages = [];
  if (jour.matinDebut || jour.matinFin) plages.push([borne(jour.matinDebut, 0), borne(jour.matinFin, SECONDES_PAR_JOUR)]);
  if (jour.apremDebut || jour.apremFin) plages.push([borne(jour.apremDebut, 0), borne(jour.apremFin, SECONDES_PAR_JOUR)]);
  if (plages.length === 0) return [[0, SECONDES_PAR_JOUR]];
  // Bornes a l'envers ecartees, puis fusion des plages qui se touchent (une
  // pause saisie a l'identique des deux cotes ne doit pas creer une fenetre
  // fermee de duree nulle).
  const valides = plages.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const fusionnees = [];
  for (const [a, b] of valides) {
    const derniere = fusionnees[fusionnees.length - 1];
    if (derniere && a <= derniere[1]) derniere[1] = Math.max(derniere[1], b);
    else fusionnees.push([a, b]);
  }
  return fusionnees;
}

// Fenetres FERMEES d'un jour : le complement des plages ouvertes sur
// [0, 24h]. C'est ce que tourCost penalise. Passer par le complement plutot
// que d'enumerer les cas ("avant l'ouverture", "pause", "apres la fermeture")
// evite les trous : toute heure qui n'est pas explicitement ouverte est
// fermee, quelles que soient les bornes renseignees.
export function closedWindowsForJour(horaires, jourKey) {
  const jour = horaires?.[jourKey];
  if (!jour) return [];
  if (jour.ferme) return [[0, SECONDES_PAR_JOUR]];
  const ouvertes = openWindowsForJour(horaires, jourKey);
  if (ouvertes.length === 0) return [[0, SECONDES_PAR_JOUR]];
  const fermees = [];
  let curseur = 0;
  for (const [debut, fin] of ouvertes) {
    if (debut > curseur) fermees.push([curseur, debut]);
    curseur = Math.max(curseur, fin);
  }
  if (curseur < SECONDES_PAR_JOUR) fermees.push([curseur, SECONDES_PAR_JOUR]);
  return fermees;
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

function hhmm(secondes) {
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Texte court d'un jour pour l'affichage ("Fermé", "08:00–12:00 · 14:00–18:00",
// "12:00–18:00 en continu"), vide si rien n'est renseigne.
export function resumeJour(jour) {
  if (jourEstVide(jour)) return "";
  if (jour.ferme) return "Fermé";
  const ouvertes = openWindowsForJour({ x: jour }, "x");
  if (ouvertes.length === 0) return "Fermé";
  if (ouvertes.length === 1 && ouvertes[0][0] === 0 && ouvertes[0][1] === SECONDES_PAR_JOUR) return "Ouvert toute la journée";
  const texte = ouvertes
    .map(([a, b]) => {
      if (a === 0) return `jusqu'à ${hhmm(b)}`;
      if (b === SECONDES_PAR_JOUR) return `à partir de ${hhmm(a)}`;
      return `${hhmm(a)}–${hhmm(b)}`;
    })
    .join(" · ");
  return jour.continu ? `${texte} en continu` : texte;
}
