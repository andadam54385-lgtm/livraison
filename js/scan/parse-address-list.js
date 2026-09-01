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
  // Terminal "Itineraire" (retour terrain 2026-09-01, "138 points au lieu de
  // 60") : reference de tournee "999X99", telephone brut sur sa propre ligne
  // ("33630369559", "0821233877" -- 9 a 12 chiffres, jamais un CP qui en fait
  // 5 ni un numero de voie), residu d'icone ("#9", "9" seul sous le
  // pictogramme maison).
  /^\d{3,4}x\d{2,}$/i, // reference type "999X99"
  /^\d{9,12}$/, // telephone/reference numerique brute
  /^#?\d{1,2}$/, // residu d'icone : un ou deux chiffres seuls
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
const TRAILING_NOISE_RE =
  /\s*(\d+([.,]\d+)?\s?km|\d{1,2}[:.]\d{2}(\s*[-–]\s*\d{1,2}[:.]\d{2})?|c\d{1,2}|agc|transfere|en\s?cours|agence|part|pro|\d+\s*\/\s*\d+|\d{3,4}x\d{2,}|\d{9,12}|\d{3,5}\s*\|\s*\d+\+\d+)\s*$/i;

// Bruit d'interface n'importe OU dans la ligne -- pas seulement en debut ou
// en fin (bug reel, retour terrain "beaucoup de donnees parasites" sur un
// terminal "Itineraire" : l'OCR d'un ecran filme fusionne les colonnes, et
// le bruit se retrouve AU MILIEU du texte utile -- "12.61km Q OPTICIENS
// KRYS 8000 jo v VANBERTEN", "us 14 ANDRE MAGINOTRUE 8000 | 0+13 ©".
// stripTrailingNoise (ancre en fin) ne pouvait rien contre ca, et chaque
// residu devenait un faux nom, une rue polluee ou un faux client entier.
//
// Tous ces motifs sont sans ambiguite : ils contiennent une unite ("km"),
// une ponctuation d'heure, un separateur de badge, ou une longueur de
// chiffres impossible pour un numero de voie ou un code postal.
// Chrome de l'application transporteur et barre d'etat du TELEPHONE filme :
// capturees en haut de chaque image, elles fabriquaient des clients entiers
// ("19 F-Bouyques Telecom (2) 9 (c) 4 80% M = Itineraire 2 @ : LISTE(63) |
// CARTE SYNTHESE | CREER" retenu comme adresse). Elles ne peuvent JAMAIS
// faire partie d'une adresse : la ligne entiere est jetee.
const UI_CHROME_RE =
  /(liste\s*\(\s*\d|\bsynth[èe]se\b|\bcr[ée]er\b|\bitin[ée]raire\b|bouygues|telecom|\d{1,3}\s?%|\borange\b|\bsfr\b|\bfree\b)/i;

const NOISE_TOKEN_PATTERNS = [
  /\b\d+[.,]?\d*\s?(km|m)\b\s*Q?/gi, // distance + l'icone "Q" qui la suit : "12.61km Q"
  /\b\d{1,2}\s?[:.]\s?\d{2}\s*[-\u2013]\s*\d{1,2}\s?[:.]\s?\d{2}\b/g, // creneau "11:30-13:30"
  // Badge de colis : "8000 | 0+1" mais aussi ses formes TRONQUEES par le
  // bord du cadre ou par l'OCR ("8000 | 0:", "2000 |o+1", "8000|0+2") --
  // observees collees a de vrais noms ("ckael Caillon 8000 | 0:").
  /\b\d{3,5}\s*\|\s*[o0-9]{0,3}\s*[+: ]?\s*\d{0,3}/gi, // badge "8000 | 0+1", "8000 | 0:", "4000 | 140 87"
  /\b\d{3,4}[xX]\d{2,}\b/g, // reference "999X99"
  /\b\d{9,}\b/g, // telephone/reference brute (un CP fait 5 chiffres, un numero de voie moins)
  /[\u00a9\u00ae\u2122]/g, // pastilles d'icone (c), (R), TM laissees par l'OCR
];

function stripNoiseTokens(text) {
  let out = text;
  for (const re of NOISE_TOKEN_PATTERNS) out = out.replace(re, " ");
  // Residus de separateurs isoles laisses par les suppressions ci-dessus.
  out = out.replace(/\s{2,}/g, " ").trim();
  out = out.replace(/^[\s,;:.|>\-\u2013_*"'\u00b0]+/, "").replace(/[\s,;:|>_*"'\u00b0]+$/, "").trim();
  return out;
}

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
    if (UI_CHROME_RE.test(text)) continue; // en-tete d'appli / barre d'etat du telephone

    // Bruit COLLE en fin de ligne reelle (terminal "Itineraire" : la colonne
    // de droite -- badge "8000 | 0+1", creneau "15:10 - 17:10", "999X99",
    // telephone -- fusionne souvent avec la ligne de gauche a l'OCR :
    // "THOMAS ANTHONY 8000 | 0+1", "LONGEVILLE EN BARROIS 15:10 - 17:10").
    // Sans ce nettoyage, le nom/la ville emportent le bruit, la commune
    // n'est plus reconnue, et la classification derive -- source directe du
    // sur-decoupage "138 points au lieu de 60". Ligne videe par le
    // nettoyage : gardee en espace reserve (bbox intact pour les ecarts).
    // isClientStart est pose AVANT le nettoyage : dans ce terminal chaque
    // fiche s'ouvre sur sa distance ("12.61km Q"), qui est justement du
    // bruit -- elle serait effacee avant d'avoir pu servir de separateur
    // (bug reel du premier jet : la fusion n'etait pas coupee).
    const isClientStart = DISTANCE_MARKER_RE.test(text);
    const cleaned = stripTrailingNoise(stripNoiseTokens(text));
    kept.push({ ...l, text: cleaned, isClientStart });
  }

  return kept;
}

const STREET_KEYWORDS = [
  "RUE", "AVENUE", "AV", "BD", "BOULEVARD", "ROUTE", "CHEMIN", "IMPASSE",
  "ALLEE", "ALLÉE", "ZONE", "ZI", "ZAC", "LIEU-DIT", "LIEU DIT", "HAMEAU",
  "LOTISSEMENT", "RESIDENCE", "RÉSIDENCE", "PLACE", "COURS", "QUAI", "VOIE",
  "TER", "BIS", "FAUBOURG",
  // Abreviations du terminal transporteur (retour terrain : elles manquaient
  // toutes, donc "2 KULLMANN IMP", "26 LIBERATION AVE", "9 POPEY CHMN",
  // "12 REGGIO PL"... n'etaient PAS reconnus comme des rues -- la fiche
  // entiere passait alors a la trappe faute d'adresse exploitable). Le
  // terminal ecrit le type de voie APRES le nom, en abrege.
  "IMP", "ALL", "AVE", "BLVD", "BLV", "CHMN", "RTE", "PL", "SQ", "CRS", "QU",
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
  // CP en fin de ligne SANS ville derriere ("DEVANT BAR 55000" -- fin d'un
  // nom de commune replie sur plusieurs lignes par le terminal) : isole le
  // CP pour qu'il soit reconnu (CP_ONLY_RE), le reste suit le circuit normal.
  const mCp = trimmed.match(/^(.*\S)\s+(\d{5})$/);
  if (mCp && !/\d$/.test(mCp[1])) return [mCp[1].trim(), mCp[2]];
  return [trimmed];
}

// Badge/code/statut d'interface GENERIQUE : court, sans espace, tout en
// majuscules/chiffres. Contrairement a NOISE_LINE_PATTERNS (vocabulaire
// FIXE -- "TRANSFERE", "C18"... propre a UPS/Chronopost), cette regle repose
// sur la FORME, pas les mots -- elle attrape donc aussi le badge d'un
// transporteur JAMAIS rencontre, sans avoir eu besoin de le connaitre a
// l'avance (retour terrain : "il faut que ca marche peu importe la mise en
// forme"). Un vrai nom ou une vraie rue a (quasi) toujours un espace (prenom
// + nom, plusieurs mots) ; un badge d'interface n'en a jamais. Utilisee
// uniquement dans le REPLI (voir plus bas, apres tous les motifs positifs
// specifiques) : ne bloque jamais un vrai mot-cle de voie ou une commune
// connue, deja reconnus avant d'arriver ici.
function looksLikeUiChrome(line) {
  if (/\s/.test(line)) return false;
  if (line.length > 10) return false;
  // Doit contenir un CHIFFRE : bug reel, "EDF" (vrai client) etait rejete
  // comme badge. Le vocabulaire de chrome purement alphabetique deja connu
  // ("AGC", "TRANSFERE"...) est traite par NOISE_LINE_PATTERNS ; ce repli
  // generique ne vise que les codes du type "C18", "999X99", "8000".
  if (!/\d/.test(line)) return false;
  return /^[A-ZÀ-Ü0-9\-]+$/.test(line);
}

// Retour terrain : "un nom c'est 1 ou 2 mots, 3 grand max, on evite les mots
// a rallonge" -- looksLikeUiChrome n'attrape que les badges SANS espace ;
// un texte parasite a plusieurs mots (fusion OCR de plusieurs elements
// d'interface, phrase tronquee...) passait encore au travers. Un vrai nom
// francais reste court (prenom + nom, parfois un 3e mot) ; un veritable
// texte parasite est presque toujours plus long. MAX_NOM_WORDS compte les
// mots de chaque cote d'un " - " separement plutot que la ligne entiere :
// motif reel observe sur un terminal Chronopost ("SERGE CORCERET - SERGE
// CORCERET", 2 noms accoles par un tiret) qu'un plafond global aurait
// injustement rejete.
const MAX_NOM_WORDS = 3;

function countWords(text) {
  return text.split(/\s+/).filter((w) => /[a-zà-ÿ]/i.test(w)).length;
}

// Motifs qui disqualifient DEFINITIVEMENT un nom, quelle que soit sa
// longueur (retour terrain : "n\u00b0 1.73km Q", "A9 9.73km Q", "0329783111 & *
// 2.24km Q" etaient retenus comme noms de clients). Un vrai nom ne contient
// jamais d'unite de distance, d'heure, ni de longue suite de chiffres.
const NON_NAME_RE = /(\d\s?km\b|\b\d{1,2}[:.]\d{2}\b|\d{6,}|\bitin[ée]raire\b|\bliste\b|\bcarte\b|\bsynth[èe]se\b|\bcr[ée]er\b)/i;

function looksLikeName(line) {
  if (NON_NAME_RE.test(line)) return false;
  // Au moins la moitie de caracteres alphabetiques : elimine "8000 | 0+1 RD",
  // "4, UPS AP 999X99 D" et compagnie sans lister leurs formes une par une.
  const lettres = (line.match(/[a-z\u00e0-\u00ff]/gi) || []).length;
  if (lettres < 3 || lettres < line.replace(/\s/g, "").length / 2) return false;
  const clauses = line.split(/\s-\s/);
  return clauses.every((c) => {
    const n = countWords(c);
    return n > 0 && n <= MAX_NOM_WORDS;
  });
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
// knownCps (optionnel) : codes postaux reellement presents dans la base BAN
// locale. Sans lui, toute suite de 5 chiffres passait pour un CP -- l'OCR
// d'un ecran filme en invente en permanence ("55096", "55014", "05500",
// "99999" observes en conditions reelles), et un faux CP suffit a creer un
// faux client (voir le filtre final de parseAddressList) ou a casser
// l'adresse d'un vrai. Avec lui, un CP inconnu est traite comme du texte
// ordinaire et ne fabrique plus rien.
function isPlausibleCp(cp, knownCps) {
  if (!knownCps || knownCps.size === 0) return true; // pas de reference : comportement d'avant
  return knownCps.has(cp);
}

export function classifyBlockLines(rawLines, { knownCities = new Set(), knownCps = new Set() } = {}) {
  const lines = rawLines.flatMap(splitEmbeddedCpVille);
  const result = { names: [], streets: [], cp: null, ville: null };
  let lastCategory = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const cpVilleMatch = line.match(CP_VILLE_RE);
    if (cpVilleMatch && !isPlausibleCp(cpVilleMatch[1], knownCps)) {
      // CP invente par l'OCR : la ligne n'est pas une ligne "CP + ville",
      // on la laisse suivre le circuit normal (elle sera souvent rattachee
      // a la rue ou reconnue comme commune).
    } else if (cpVilleMatch) {
      result.cp = cpVilleMatch[1];
      result.ville = cpVilleMatch[2].trim();
      lastCategory = "cpville";
      continue;
    }

    const cpOnlyMatch = line.match(CP_ONLY_RE);
    if (cpOnlyMatch && isPlausibleCp(cpOnlyMatch[1], knownCps)) {
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

    // Continuation de rue/ville : NON filtree par looksLikeUiChrome (un mot de
    // retour a la ligne d'une rue/ville coupee, ex: "GAULLE" dans "Rue du
    // General de Gaulle", a exactement la meme forme courte/majuscule/sans-
    // espace qu'un badge -- seul le CONTEXTE (ligne precedente deja classee
    // rue/ville) permet de trancher, la forme seule ne suffit pas ici).
    if (lastCategory === "street") {
      result.streets.push(line);
      continue;
    }
    if (lastCategory === "ville") {
      result.ville = `${result.ville} ${line}`.trim();
      continue;
    }

    // Repli final (aucun contexte etabli) : voir looksLikeUiChrome (forme de
    // badge) et looksLikeName (longueur plausible d'un nom, voir plus haut) --
    // deux filtres complementaires, jamais retenu comme nom si l'un des deux
    // echoue.
    if (looksLikeUiChrome(line) || !looksLikeName(line)) {
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
// Un bloc qui contient PLUSIEURS codes postaux est forcement une fusion de
// plusieurs clients (bug reel : l'ecart vertical entre deux fiches disparait
// quand l'OCR fusionne des lignes, et 3-4 clients se retrouvent dans un seul
// bloc -- "OPTICIENS KRYS ... BAR-LE-DUC 55000 ... ROCHELLE BLVD ... 55000").
// Dans ce terminal le CP TERMINE chaque fiche : on recoupe juste apres
// chacun. Sans CP valide en double, le bloc est rendu tel quel.
// Dans ce terminal, CHAQUE fiche client est precedee de sa distance
// ("12.61km Q", "717.01m Q") -- c'est le separateur le plus fiable, bien
// meilleur que le code postal : il est present meme quand le CP a ete mal lu,
// et il marque le DEBUT d'une fiche. Detecte sur le texte BRUT, avant que
// stripNoiseTokens ne l'efface (d'ou l'ordre dans parseAddressList).
const DISTANCE_MARKER_RE = /(^|\s)\d+[.,]?\d*\s?(km|m)\b/i;

function splitOnDistanceMarkers(blockLines) {
  const starts = blockLines.map((l, i) => (l.isClientStart ? i : -1)).filter((i) => i >= 0);
  if (starts.length < 2) return [blockLines];
  const parts = [];
  // Ce qui precede le premier marqueur appartient au client precedent.
  if (starts[0] > 0) parts.push(blockLines.slice(0, starts[0]));
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : blockLines.length;
    parts.push(blockLines.slice(start, end));
  });
  return parts.filter((p) => p.length > 0);
}

function splitFusedBlock(blockLines, knownCps) {
  const cuts = [];
  blockLines.forEach((l, i) => {
    const t = l.text.trim();
    const m = t.match(CP_ONLY_RE) || t.match(CP_VILLE_TRAILING_RE);
    const cp = m ? (m[1].length === 5 && /^\d{5}$/.test(m[1]) ? m[1] : m[2]) : null;
    if (cp && /^\d{5}$/.test(cp) && (!knownCps || knownCps.size === 0 || knownCps.has(cp))) cuts.push(i);
  });
  if (cuts.length < 2) return [blockLines];
  const parts = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(blockLines.slice(start, cut + 1));
    start = cut + 1;
  }
  if (start < blockLines.length) parts.push(blockLines.slice(start));
  return parts.filter((p) => p.length > 0);
}

// Une SEULE ligne OCR peut contenir plusieurs fiches quand l'image a tout
// fusionne ("12.61km Q OPTICIENS KRYS ... BAR-LE-DUC 55000 : A 12.6km Q vu,
// PIED AURE ... 55000"). Le decoupage par index de ligne ne peut rien : on
// recoupe donc le TEXTE lui-meme a chaque marqueur de distance, en pseudo-
// lignes qui partagent la bbox d'origine (l'ecart vertical reste correct,
// et isClientStart les separera ensuite).
const DISTANCE_SPLIT_RE = /(?=(?:^|\s)\d+[.,]?\d*\s?(?:km|m)\b)/i;

function explodeFusedLines(ocrLines) {
  const out = [];
  for (const l of ocrLines) {
    const parts = String(l.text || "")
      .split(DISTANCE_SPLIT_RE)
      .map((t) => t.trim())
      .filter(Boolean);
    if (parts.length < 2) {
      out.push(l);
      continue;
    }
    for (const part of parts) out.push({ ...l, text: part });
  }
  return out;
}

export function parseAddressList(ocrLines, { knownCities = new Set(), knownCps = new Set() } = {}) {
  // Bruit d'interface (distance/horaire/tag/statut/code/bandeau d'instruction,
  // voir stripInterfaceNoise) retire AVANT le decoupage en blocs -- sans ca,
  // ces lignes intercalees entre deux adresses peuvent casser l'ecart qui les
  // separe et les faire fusionner (ou, pire, exploser un client en plusieurs
  // faux clients quand le bandeau lui-meme cree de faux ecarts).
  const usableLines = stripInterfaceNoise(explodeFusedLines(ocrLines));
  // Deux decoupages complementaires : par marqueur de distance (debut de
  // fiche) puis par code postal (fin de fiche). L'un rattrape ce que l'autre
  // rate quand l'OCR a mal lu l'un des deux.
  const blocks = groupLinesIntoBlocks(usableLines)
    .flatMap(splitOnDistanceMarkers)
    .flatMap((b) => splitFusedBlock(b, knownCps));
  return blocks
    .map((blockLines) => {
      const classified = classifyBlockLines(
        blockLines.map((l) => l.text),
        { knownCities, knownCps }
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
    // Un bloc n'est retenu que s'il porte une adresse CREDIBLE : une rue avec
    // au moins un mot alphabetique de 3 lettres (elimine "8000 | 0+1 RD",
    // "0 GONDRECOURT (DE) RTE," et les residus du meme genre), ou un couple
    // CP + ville. Avant, n'importe quel residu contenant un chiffre passait
    // pour une rue et devenait un colis a verifier.
    .filter((b) => {
      const rueCredible = b.rue && /[a-z\u00e0-\u00ff]{3,}/i.test(b.rue);
      return rueCredible || (b.cp && b.ville);
    });
}
