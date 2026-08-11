import { normalizeCity } from "../geocode/normalize-address.js";
import { looseCommune } from "../geocode/match-address.js";

// Parsing d'une LISTE de plusieurs adresses visibles en meme temps sur une
// photo (ex: photo/scan d'un ecran d'appli transporteur affichant une
// tournee complete), par opposition a parse-ups-label.js qui parse UNE
// etiquette imprimee a la fois. Fonction pure (pas de DOM), testable sans
// OCR reel -- voir parse-address-list.test.mjs.
//
// Principe (retour terrain) : chaque adresse occupe plusieurs lignes (nom
// optionnel, rue+numero, ville, CP -- parfois rue et debut de ville colles
// sur UNE ligne, parfois au contraire ville et CP chacun sur leur PROPRE
// ligne separee -- verifie sur un vrai terminal UPS : "rue" / "ville" / "cp"
// sur 3 lignes distinctes, PAS "cp ville" combine comme suppose au depart),
// separees visuellement a l'ecran par un trait horizontal plein largeur
// entre deux clients. L'OCR ne "lit" jamais ce trait comme du texte -- seul
// l'espace vertical qu'il laisse est detectable, via un ecart de position
// (bbox) nettement plus grand qu'entre deux lignes consecutives d'un meme
// bloc. Voir groupLinesIntoBlocks().
//
// Contrairement a parse-ups-label.js (etiquette imprimee, texte OCR
// generalement tout en majuscules), le texte d'un ecran/appli est en casse
// normale -- toutes les regex ici sont insensibles a la casse.

const CP_VILLE_RE = /^(\d{5})\s+([a-zà-ÿ'\-]+(?:\s[a-zà-ÿ'\-]+)*)$/i;
// Meme motif que CP_VILLE_RE mais PAS ancre au debut : capture "reste de la
// ligne" + CP + ville a la fin, pour le cas "rue et debut de ville colles
// sur la meme ligne" (ex: "12 Avenue de la Liberation 54000 Nancy").
const CP_VILLE_TRAILING_RE = /^(.*\S)\s+(\d{5})\s+([a-zà-ÿ'\-]+(?:\s[a-zà-ÿ'\-]+){0,4})\s*$/i;
// CP SEUL sur sa propre ligne (bug reel corrige ici : un vrai terminal UPS
// affiche generalement "rue" / "ville" / "cp" sur 3 lignes separees, pas
// "cp ville" combine -- avant ce correctif, une ligne "54200" isolee etait
// captee par le repli "commence par un chiffre" et finissait dans la RUE
// (numero de voie), corrompant l'adresse et laissant cp/ville vides.
const CP_ONLY_RE = /^(\d{5})$/;

const STREET_KEYWORDS = [
  "RUE", "AVENUE", "AV", "BD", "BOULEVARD", "ROUTE", "CHEMIN", "IMPASSE",
  "ALLEE", "ALLÉE", "ZONE", "ZI", "ZAC", "LIEU-DIT", "LIEU DIT", "HAMEAU",
  "LOTISSEMENT", "RESIDENCE", "RÉSIDENCE", "PLACE", "COURS", "QUAI", "VOIE",
  "TER", "BIS", "FAUBOURG",
];

// Mot entier, jamais une sous-chaine (meme raison que parse-ups-label.js :
// "AV" dans "DAVID", "BD" dans "ABDALLAH", "VOIE" dans "SAVOIE"...).
function lineHasStreetWord(line) {
  const upper = line.toUpperCase();
  return STREET_KEYWORDS.some((k) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-ZÀ-Ü'])${escaped}(?=[^A-ZÀ-Ü']|$)`, "i").test(upper);
  });
}

// Coupe une ligne "rue ... CP Ville" en deux lignes distinctes si le CP+
// ville n'occupe pas la ligne entiere -- sans ca, classifyBlockLines ne
// reconnaitrait ni une ligne de rue propre ni une ligne CP+ville propre, et
// la ligne entiere finirait mal classee.
function splitEmbeddedCpVille(line) {
  const trimmed = line.trim();
  if (!trimmed || CP_VILLE_RE.test(trimmed)) return [trimmed];
  const m = trimmed.match(CP_VILLE_TRAILING_RE);
  if (m) return [m[1].trim(), `${m[2]} ${m[3]}`.trim()];
  return [trimmed];
}

// Classifie les lignes d'UN bloc (deja isole par groupLinesIntoBlocks) en
// nom/rue/CP/ville -- meme heuristique de base que classifyShipToBlock dans
// parse-ups-label.js (chiffre en tete de ligne ou mot-cle de voie -> rue,
// sinon -> nom), adaptee a la casse normale d'un ecran, plus deux ajouts
// pour les vrais terminaux (voir plus haut) :
//   - une ligne de 5 chiffres SEULE -> CP (pas confondue avec un numero de
//     voie, voir CP_ONLY_RE) ;
//   - une ligne qui correspond a une commune CONNUE (knownCities, la liste
//     des communes de la base BAN locale deja chargee -- voir
//     listDistinctCities()/ban-index.js) -> ville, meme sans CP colle sur la
//     meme ligne. Sans base de reference, une ligne "DOMMARTIN LES TOUL"
//     est structurellement identique a une ligne "AKHRAZ HASSAN" (juste des
//     mots, sans chiffre ni mot-cle) -- impossible a distinguer d'un nom de
//     personne par la seule forme du texte. knownCities est optionnel
//     (Set vide par defaut) : sans lui, ce cas de figure retombe sur
//     l'ancien comportement (ligne non reconnue -> repli ci-dessous).
// Repli pour toute ligne qui ne correspond a AUCUN des motifs ci-dessus :
// rattachee au MEME champ que la ligne precedente plutot que prise par
// defaut pour un nom -- couvre le retour a la ligne d'une rue ou d'une
// ville trop longue pour la largeur d'ecran ("RUE DU GENERAL DE" / "GAULLE"),
// qui sinon polluait/ecrasait le nom detecte (bug reel corrige ici).
export function classifyBlockLines(rawLines, { knownCities = new Set() } = {}) {
  const lines = rawLines.flatMap(splitEmbeddedCpVille);
  const result = { names: [], streets: [], cp: null, ville: null };
  let lastCategory = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const cpVilleMatch = line.match(CP_VILLE_RE);
    if (cpVilleMatch) {
      result.cp = cpVilleMatch[1];
      result.ville = cpVilleMatch[2].trim();
      lastCategory = "cpville";
      continue;
    }

    const cpOnlyMatch = line.match(CP_ONLY_RE);
    if (cpOnlyMatch) {
      result.cp = cpOnlyMatch[1];
      lastCategory = "cp";
      continue;
    }

    const hasStreetWord = lineHasStreetWord(line);
    const startsWithNumber = /^\d/.test(line);
    if (startsWithNumber || hasStreetWord) {
      result.streets.push(line);
      lastCategory = "street";
      continue;
    }

    // looseCommune (pas juste normalizeCity) : un terminal affiche souvent
    // une commune composee SANS tirets ("DOMMARTIN LES TOUL") alors que
    // knownCities (base BAN) la stocke AVEC ("dommartin-les-toul") -- voir
    // looseCommune dans match-address.js, meme probleme deja resolu pour le
    // geocodage.
    const normalizedVille = looseCommune(normalizeCity(line));
    if (normalizedVille && knownCities.has(normalizedVille)) {
      // Dernier match l'emporte (meme logique que "nom" plus bas) : un
      // terminal peut afficher une ville en double (ex: un libelle de zone
      // au-dessus du bloc ET la ville propre de l'adresse) -- la derniere
      // occurrence est la plus fiable, jamais une concatenation des deux.
      result.ville = line;
      lastCategory = "ville";
      continue;
    }

    if (lastCategory === "street") {
      result.streets.push(line);
      continue;
    }
    if (lastCategory === "ville") {
      result.ville = `${result.ville} ${line}`.trim();
      continue;
    }

    result.names.push(line);
    lastCategory = "name";
  }

  return result;
}

function bboxUnion(boxes) {
  return boxes.reduce(
    (acc, b) => ({
      x0: Math.min(acc.x0, b.x0),
      y0: Math.min(acc.y0, b.y0),
      x1: Math.max(acc.x1, b.x1),
      y1: Math.max(acc.y1, b.y1),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  );
}

// Regroupe des lignes OCR (deja triees de haut en bas, avec leur bbox) en
// blocs -- un bloc = une adresse potentielle -- des qu'un ecart vertical
// entre deux lignes consecutives depasse nettement la hauteur de ligne
// mediane du lot (c'est la ou le trait separateur laisse un blanc). Seuil
// relatif (pas une valeur fixe en pixels) : robuste a la distance
// camera-ecran/zoom, qui change la taille absolue du texte a chaque prise.
const GAP_RATIO_THRESHOLD = 1.6;

export function groupLinesIntoBlocks(lines) {
  if (lines.length === 0) return [];
  const heights = lines.map((l) => l.bbox.y1 - l.bbox.y0).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 20;

  const blocks = [[lines[0]]];
  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const curLine = lines[i];
    const gap = curLine.bbox.y0 - prevLine.bbox.y1;
    if (gap > medianHeight * GAP_RATIO_THRESHOLD) {
      blocks.push([curLine]);
    } else {
      blocks[blocks.length - 1].push(curLine);
    }
  }
  return blocks;
}

/**
 * @param {{text: string, bbox: {x0:number,y0:number,x1:number,y1:number}}[]} ocrLines
 *   Lignes OCR triees de haut en bas (ordre naturel de Tesseract).
 * @param {{knownCities?: Set<string>}} options
 *   knownCities : noms de communes normalises (normalizeCity) connus de la
 *   base BAN locale -- voir classifyBlockLines. Optionnel, sans impact sur
 *   le comportement existant si omis (Set vide).
 * @returns {{nom: string|null, rue: string|null, cp: string|null, ville: string|null, bbox: object, rawLines: string[]}[]}
 */
export function parseAddressList(ocrLines, { knownCities = new Set() } = {}) {
  const blocks = groupLinesIntoBlocks(ocrLines);
  return blocks
    .map((blockLines) => {
      const classified = classifyBlockLines(
        blockLines.map((l) => l.text),
        { knownCities }
      );
      const nom = classified.names.length > 0 ? classified.names[classified.names.length - 1] : null;
      const rue = classified.streets.length > 0 ? classified.streets.join(" ") : null;
      return {
        nom,
        rue,
        cp: classified.cp,
        ville: classified.ville,
        bbox: bboxUnion(blockLines.map((l) => l.bbox)),
        rawLines: blockLines.map((l) => l.text),
      };
    })
    .filter((b) => b.rue || (b.cp && b.ville)); // ignore les blocs sans aucune info d'adresse exploitable (bruit OCR)
}
