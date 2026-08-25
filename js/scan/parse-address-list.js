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

// Bruit d'interface propre au terminal (distance au prochain arret, plage
// horaire, tag zone/colis) -- bug reel corrige ici, reproduit et verifie sur
// une vraie capture : ces lignes s'intercalent PILE entre deux adresses,
// juste sous le CP de l'une et juste au-dessus du nom de la suivante. Deux
// consequences en cascade avant ce correctif : (1) commencant par un
// chiffre, elles etaient captees par le repli "numero de voie" et
// polluaient la RUE ("JONCHERY RUE 21.8km") ; (2) pire, en s'intercalant
// dans l'ecart vertical qui separe deux clients, elles le decoupaient en
// DEUX ecarts plus petits dont NI L'UN NI L'AUTRE ne depassait le seuil de
// groupLinesIntoBlocks -- deux adresses entieres fusionnaient alors en une
// seule (bloc "JEANNE D'ARC RUE 22.34km AKHRAZ HASSAN 14 GENERAL LECLERC
// AVE 22.83km" observe en test). Filtrees ICI, avant meme le decoupage en
// blocs, pour ne jamais entrer dans le calcul des ecarts.
const NOISE_LINE_PATTERNS = [
  /^\d+([.,]\d+)?\s?km$/i, // distance : "21.8km", "22,44 km"
  /^\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}$/, // plage horaire : "08:20 - 10:20"
  /^\d{3,5}\s*\|\s*\d+\+\d+$/, // tag zone/colis : "8000 | 0+1"
  // Bug reel corrige ici (retour terrain : "118 adresses au lieu de 27" sur un
  // terminal Chronopost, bien plus charge visuellement qu'UPS -- code de
  // tournee, statut, compteur enveloppe/colis, heure seule en plus de la
  // distance). Chacun de ces elements, non filtre, devenait soit un faux nom
  // ("TRANSFERE" pris pour le destinataire), soit polluait la rue, soit
  // cassait un ecart de bloc comme les lignes "Xkm" avant elles.
  /^(transfere|en\s?cours|agence|part|pro)$/i, // statut/categorie affiche a cote d'une icone
  /^c\d{1,2}$/i, // code de tournee/type ("C18", "C13"...)
  /^agc$/i, // code "agence" (retour en agence)
  /^\d+\s*\/\s*\d+$/, // compteur enveloppe/colis : "0 / 1"
  /^\d{1,2}[:.]\d{2}$/, // heure seule (pas une plage) : "11:45"
];

function isNoiseLine(text) {
  const trimmed = text.trim();
  return NOISE_LINE_PATTERNS.some((re) => re.test(trimmed));
}

// Numero de suivi/reference : chaine alphanumerique SANS espace d'au moins 8
// caracteres contenant au moins un chiffre ("NX014074748JB", "01595217550547T").
// Jamais une adresse (une rue/ville reelle garde toujours ses espaces entre
// mots une fois lue par l'OCR), donc sans risque de confondre les deux.
const TRACKING_CODE_RE = /^(?=.*\d)[a-z0-9]{8,}$/i;

// Bandeau d'instruction en texte libre ("Attention consigne de livraison...",
// "Doit etre ramene en agence, merci de ne pas le presenter...") : contenu
// imprevisible (aucune regex fixe ne peut le reconnaitre mot a mot), mais
// TOUJOURS introduit par une de ces formules-ancres, et TOUJOURS suivi d'un
// numero de suivi (voir TRACKING_CODE_RE) qui marque la fin du bandeau.
const BANNER_ANCHOR_RE = /(attention\s+consigne\s+de\s+livraison|doit\s+[eê]tre\s+ramen[ée]\s+en\s+agence|merci\s+de\s+ne\s+pas\s+le\s+pr[ée]senter)/i;

// Limite de securite : si aucun repere de fin de bandeau (CP seul ou numero
// de suivi) n'apparait dans les MAX_BANNER_LINES lignes suivantes, on
// abandonne le mode bandeau plutot que d'avaler silencieusement le reste de
// la liste (pire bug possible ici : perdre des adresses reelles parce que la
// detection de fin a rate, alors que le but est justement d'en recuperer plus).
const MAX_BANNER_LINES = 6;

// Repli d'un token de bruit ISOLE en fin de chaine (pas ancre en fin absolue
// de ligne comme NOISE_LINE_PATTERNS -- ici on nettoie la fin d'une ligne plus
// longue, ex: l'OCR a fusionne rue + distance + debut de bandeau en UNE seule
// ligne detectee : "14 GENERAL LECLERC AVE 42 km Attention consigne...").
// Applique en boucle (plusieurs tokens de bruit peuvent s'empiler en fin de
// ligne) jusqu'a stabilisation.
const TRAILING_NOISE_RE = /\s*(\d+([.,]\d+)?\s?km|\d{1,2}[:.]\d{2}(\s*[-–]\s*\d{1,2}[:.]\d{2})?|c\d{1,2}|agc|transfere|en\s?cours|agence|part|pro|\d+\s*\/\s*\d+)\s*$/i;

function stripTrailingNoise(text) {
  let s = text;
  let previous;
  do {
    previous = s;
    s = s.replace(TRAILING_NOISE_RE, "").trim();
  } while (s !== previous && s.length > 0);
  return s;
}

// Retire le bruit d'interface AVANT le decoupage en blocs (meme raison que
// isNoiseLine seul, mais gere en plus les bandeaux d'instruction multi-lignes
// et le cas ou l'OCR fusionne une ligne reelle et le debut d'un bandeau sur
// UNE seule ligne detectee ("... 42 km Attention consigne de livraison...") --
// dans ce cas la partie AVANT l'ancre est conservee (nettoyee via
// stripTrailingNoise), le reste est traite comme bruit.
//
// Bug reel corrige ici, distinct du bruit isole (voir NOISE_LINE_PATTERNS,
// simplement retire -- fusionner deux petits ecarts en un seul REND le
// decoupage en blocs plus juste, voir groupLinesIntoBlocks/Cas 9) : un
// BANDEAU peut faire plusieurs lignes, et le SUPPRIMER completement (comme un
// bruit isole) fusionne artificiellement les deux petits ecarts qui
// l'entourent en un seul GRAND ecart -- qui depasse alors a tort le seuil de
// groupLinesIntoBlocks et coupe un client A EN DEUX (sa carte, puis un faux
// second bloc a partir du reste du bandeau). Les lignes de bandeau sont donc
// gardees comme "espaces reservés" (bbox intact, texte vide) : elles comptent
// toujours pour le calcul des ecarts (le decoupage en blocs reste correct),
// mais classifyBlockLines les ignore silencieusement (ligne vide -> `if
// (!line) continue`, deja le cas avant ce correctif).
function stripInterfaceNoise(ocrLines) {
  const kept = [];
  let insideBanner = false;
  let bannerLinesConsumed = 0;

  for (const l of ocrLines) {
    const text = l.text.trim();
    if (!text) continue;

    if (insideBanner) {
      bannerLinesConsumed++;
      if (TRACKING_CODE_RE.test(text)) {
        insideBanner = false;
        kept.push({ ...l, text: "" }); // numero de suivi : espace reserve, jamais garde comme contenu
        continue;
      }
      if (CP_ONLY_RE.test(text)) {
        insideBanner = false;
        kept.push(l); // le CP, lui, est une donnee reelle a garder telle quelle
        continue;
      }
      if (bannerLinesConsumed >= MAX_BANNER_LINES) {
        insideBanner = false; // repli de securite, voir commentaire plus haut -- traite cette ligne normalement
      } else {
        kept.push({ ...l, text: "" });
        continue;
      }
    }

    const anchorMatch = text.match(BANNER_ANCHOR_RE);
    if (anchorMatch) {
      const before = anchorMatch.index > 0 ? stripTrailingNoise(text.slice(0, anchorMatch.index)) : "";
      insideBanner = true;
      bannerLinesConsumed = 0;
      kept.push({ ...l, text: before });
      continue;
    }

    if (isNoiseLine(text) || TRACKING_CODE_RE.test(text)) continue; // bruit isole (hors bandeau) : retire entierement, voir Cas 9
    kept.push(l);
  }

  return kept;
}

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
  // Bruit d'interface (distance/horaire/tag/statut/code/bandeau d'instruction,
  // voir stripInterfaceNoise) retire AVANT le decoupage en blocs -- sans ca,
  // ces lignes intercalees entre deux adresses peuvent casser l'ecart qui les
  // separe et les faire fusionner (ou, pire, exploser un client en plusieurs
  // faux clients quand le bandeau lui-meme cree de faux ecarts).
  const usableLines = stripInterfaceNoise(ocrLines);
  const blocks = groupLinesIntoBlocks(usableLines);
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
