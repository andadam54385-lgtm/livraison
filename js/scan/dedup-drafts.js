import { streetSimilarity, looseCommune } from "../geocode/match-address.js";
import { normalizeStreet, normalizeCity } from "../geocode/normalize-address.js";

// Deduplication des brouillons d'un scan de LISTE (video importee ou camera
// live). Extrait de batch-scan-ui.js pour etre testable : ce sont des
// fonctions pures, mais elles vivaient dans un module d'interface qui ne
// s'importe pas hors navigateur ("self is not defined"), donc la logique la
// plus delicate du scan de liste n'avait aucun test.

// Deduplication FLOUE (pas une simple cle exacte) : bug reel corrige ici,
// retour terrain "65 arrets reels -> 240 propositions". L'OCR d'un ecran
// filme (reflets, tremblement, texte minuscule) ne relit JAMAIS deux fois le
// MEME texte a l'identique pour une meme adresse physique -- une cle exacte
// (rue+cp+ville normalises) traitait donc chaque nouvelle variante de bruit
// comme une adresse toute neuve a chaque passage de l'OCR (la boucle tourne
// en continu tant que la camera reste pointee), d'ou la multiplication.
// On compare desormais chaque nouvelle detection a celles deja retenues via
// streetSimilarity (Levenshtein + trigrammes, deja utilise pour le
// geocodage BAN) : un CP present des deux cotes doit correspondre, une ville
// presente des deux cotes doit correspondre, et la rue doit depasser
// FUZZY_DEDUP_THRESHOLD -- suffisamment tolerant au bruit OCR sans fusionner
// deux rues reellement differentes du meme secteur.
const FUZZY_DEDUP_THRESHOLD = 0.62;

const MIN_FRAGMENT_LEN = 8;

// Un fragment de bord de cadre a perdu son NUMERO (il etait sur la partie
// coupee). Une rue qui commence par un numero est donc une rue complete, et
// ne doit jamais etre absorbee par simple correspondance de fin : "1 rue des
// allies" et "3 rue des allies" partagent la meme fin sans etre la meme
// adresse.
function startsWithHouseNumber(street) {
  return /^\d/.test(street);
}

// Numero de voie en tete, sans le complement ("12 bis" -> "12").
function houseNumber(street) {
  const m = street.match(/^(\d{1,4})(?=\s|$)/);
  return m ? m[1] : null;
}

// Une fiche "complete" porte au moins sa commune ou son code postal. Un
// fragment de bord de cadre n'a jamais ni l'un ni l'autre : ce sont
// precisement les lignes restees hors du champ de la camera.
function isCompleteCard(d) {
  return Boolean(d.cp || d.ville);
}

export function isSameAddress(a, b) {
  if (a.cp && b.cp && a.cp !== b.cp) return false;
  // looseCommune : "BAR-LE-DUC" et "BAR LE DUC" sont la meme commune -- sans
  // ca, la meme fiche lue avec et sans tirets ne se dedupliquait jamais.
  const villeA = looseCommune(normalizeCity(a.ville || ""));
  const villeB = looseCommune(normalizeCity(b.ville || ""));
  if (villeA && villeB && villeA !== villeB) return false;
  const streetA = normalizeStreet(a.rue || "");
  const streetB = normalizeStreet(b.rue || "");
  if (!streetA || !streetB) return Boolean(villeA) && villeA === villeB;
  // Fiche COUPEE au bord du cadre de capture (retour terrain "138 points au
  // lieu de 60" sur un ecran qui defile) : une image attrape "15 RUE DU
  // MARECHAL", la suivante la fiche entiere avec la commune repliee dans la
  // rue -- la similarite Levenshtein/trigrammes s'effondre alors que c'est le
  // MEME client. Une rue strictement contenue dans l'autre (des le debut,
  // normalisees toutes les deux) suffit a les identifier.
  // Deux numeros DIFFERENTS sur la meme voie sont deux livraisons
  // differentes, point final -- aucune tolerance floue ici. Sans cette regle,
  // streetSimilarity trouvait "1 rue des allies" et "3 rue des allies"
  // quasiment identiques (un seul caractere d'ecart sur seize) et fusionnait
  // deux arrets reels en un seul : un colis disparaissait silencieusement de
  // la tournee, ce qui est bien pire qu'un doublon a supprimer a la main.
  const numA = houseNumber(streetA);
  const numB = houseNumber(streetB);
  if (numA && numB && numA !== numB) return false;
  // Une fiche numerotee et une fiche NON numerotee, toutes deux completes
  // (commune ou CP presents des deux cotes) : deux clients distincts, pas une
  // coupure. Retour terrain du build 121 ("il a trouve moins d'adresses qu'en
  // realite") : les livraisons en entreprise SANS numero de voie sont
  // frequentes ("YZANCE, GRANDE TERRE ALL") et se faisaient absorber par un
  // client numerote de la meme rue ("6 GRANDE TERRE ALL"). Un vrai fragment
  // de coupure, lui, n'est jamais complet -- sa commune et son CP sont restes
  // hors cadre -- donc cette regle ne bloque pas la fusion des fragments.
  if ((numA === null) !== (numB === null) && isCompleteCard(a) && isCompleteCard(b)) {
    return false;
  }

  const shorter = streetA.length <= streetB.length ? streetA : streetB;
  const longer = streetA.length <= streetB.length ? streetB : streetA;
  if (shorter.length >= MIN_FRAGMENT_LEN && longer.startsWith(shorter)) return true;
  // Coupure par le HAUT du cadre : c'est le cas majoritaire d'un ecran qu'on
  // fait defiler, et il produit l'inverse du precedent -- le fragment perd son
  // DEBUT, pas sa fin ("ERATION AVE FAINSAUEEL" pour "10 LIBERATION AVE
  // FAINS-VEEL", "SSAGE RUE" pour "PASSAGE RUE", "EGAUTO" pour
  // "EURLGREGAUTO"). Le test par prefixe ci-dessus ne peut rien voir, et
  // chaque fragment devenait un arret fantome de plus. Garde-fou : seulement
  // si le fragment n'a pas son propre numero de rue (voir
  // startsWithHouseNumber).
  if (
    shorter.length >= MIN_FRAGMENT_LEN &&
    !startsWithHouseNumber(shorter) &&
    longer.endsWith(shorter)
  ) {
    return true;
  }
  return streetSimilarity(streetA, streetB) >= FUZZY_DEDUP_THRESHOLD;
}

// Complete en place un brouillon deja retenu avec les champs qu'une nouvelle
// capture aurait mieux lus (ex: CP/ville absents la premiere fois, texte de
// rue plus complet) -- profite du fait que l'OCR se trompe DIFFEREMMENT a
// chaque passage plutot que de garder seulement la toute premiere lecture,
// potentiellement la plus incomplete.
export function mergeDraftInto(existing, incoming) {
  if (!existing.cp && incoming.cp) existing.cp = incoming.cp;
  if (!existing.ville && incoming.ville) existing.ville = incoming.ville;
  if (!existing.nom && incoming.nom) existing.nom = incoming.nom;
  if (incoming.rue && (!existing.rue || incoming.rue.length > existing.rue.length + 3)) existing.rue = incoming.rue;
}

// Absorbe les brouillons d'une passe OCR dans la collecte (deduplication
// floue + complement des champs manquants) -- partage entre le mode camera
// live et l'analyse d'une video importee, qui produisent exactement les
// memes brouillons par des chemins differents.
export function ingestDrafts(collected, drafts) {
  const boxResults = [];
  for (const draft of drafts) {
    const matchIdx = collected.findIndex((existing) => isSameAddress(existing, draft));
    const isNew = matchIdx === -1;
    if (isNew) {
      collected.push(draft);
    } else {
      mergeDraftInto(collected[matchIdx], draft);
    }
    boxResults.push({ bbox: draft.bbox, isNew });
  }
  return boxResults;
}
