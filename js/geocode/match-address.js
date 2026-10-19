import { normalizeStreet, normalizeCity } from "./normalize-address.js";
import { queryByCp, queryByCommune } from "./ban-index.js";

export function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

function trigrams(s) {
  const padded = `  ${s} `;
  const grams = new Set();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const g of setA) if (setB.has(g)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Tolerance aux fautes OCR sur le nom de rue : combine distance d'edition
// (fautes ponctuelles: 0/O, l/1, lettres manquantes) et similarite de
// trigrammes (robuste aux mots reordonnes/tronques).
export function streetSimilarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  const levScore = maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
  const jacScore = jaccardSimilarity(trigrams(a), trigrams(b));
  return levScore * 0.5 + jacScore * 0.5;
}

const CONFIDENCE_THRESHOLD = 0.72;

// Bug reel corrige ici (retour terrain, Onville) : "33 GORZE RUE" -- l'ordre
// du terminal, type de voie en fin -- etait geocode "33 Grande Rue" au lieu
// de "33 Rue de Gorze", dans la bonne commune. streetSimilarity, lettre a
// lettre, preferait "grande rue" : meme longueur, meme fin "rue", quatre
// lettres communes -- alors que le seul mot qui identifie la voie, "gorze",
// n'y figure pas. Les mots de LIAISON (rue, de, la...) pesent autant que le
// nom propre dans une distance d'edition, et l'inversion "gorze rue" /
// "rue de gorze" coute cher a Levenshtein.
// On extrait donc les mots PORTEURS de chaque cote (tout sauf les types de
// voie et les articles/prepositions) : un candidat dont AUCUN mot porteur ne
// ressemble a un mot porteur de la recherche voit sa similarite de rue
// reduite. Jamais de bonus dans l'autre sens (un "place de l'eglise" ne doit
// pas rattraper "rue de l'eglise" parce qu'ils partagent "eglise") : la
// distance d'edition garde le dernier mot entre candidats plausibles, on ne
// fait qu'ecarter ceux qui parlent d'une autre voie.
const MOTS_DE_VOIE = new Set([
  "rue", "avenue", "boulevard", "route", "chemin", "impasse", "allee", "place", "cours", "quai", "square",
  "ruelle", "voie", "faubourg", "lotissement", "residence", "hameau", "zone", "zi", "za", "zac", "passage",
  "sentier", "chaussee", "montee", "promenade", "esplanade", "mail", "clos", "venelle", "traverse", "cite",
  "lieu", "dit", "lieudit", "rd", "cd", "rn", "d", "n",
  // Formes abregees de "lotissement" : "lt" quand normalizeStreet ne l'a pas
  // expanse (voie qui porte deja un type, ex "rue du lt colonel"), "lot" que
  // la BAN elle-meme utilise dans 8 libelles du secteur.
  "lt", "lot",
]);
const MOTS_DE_LIAISON = new Set(["de", "du", "des", "la", "le", "les", "l", "et", "a", "au", "aux", "en", "sur", "sous", "par", "pour"]);
const CONTENT_MATCH_MIN = 0.5;
const CONTENT_MISMATCH_FACTOR = 0.6;

export function motsPorteurs(normalized) {
  return String(normalized || "")
    .split(/[\s'-]+/)
    .filter((t) => t && !MOTS_DE_VOIE.has(t) && !MOTS_DE_LIAISON.has(t));
}

function tokenSimilarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

// Meilleure ressemblance entre un mot porteur de la recherche et un mot
// porteur du candidat ; null si l'un des deux n'a aucun mot porteur (rien a
// comparer, on ne penalise pas).
export function contentMatch(queryTokens, candidateNormalized) {
  const candTokens = motsPorteurs(candidateNormalized);
  if (queryTokens.length === 0 || candTokens.length === 0) return null;
  let best = 0;
  for (const q of queryTokens) {
    for (const c of candTokens) {
      const s = tokenSimilarity(q, c);
      if (s > best) best = s;
    }
  }
  return best;
}

// Bug reel corrige ici (retour terrain : "6 rue de l'eglise" a Ansauville
// remontait Rembercourt-sur-Mad, meme apres correction manuelle repetee) :
// "Rue de l'Eglise"/"Place de l'Eglise" existe dans des dizaines de communes
// differentes partageant le meme code postal en zone rurale --
// streetSimilarity(+numero) atteint facilement 1.0+ a elle seule des que la
// rue/numero correspondent exactement, PEU IMPORTE la commune. Plafonner le
// score total a 1 (ancien code) ecrasait alors totalement le bonus commune
// cense departager ces cas : deux communes a 1.15/1.20 avant plafonnage
// ressortaient toutes les deux a 1.0 apres, rendant le tri quasi arbitraire
// (ordre de depart du pool) des que le nom de rue est courant. Le bonus
// commune est aussi renforce (0.05 -> 0.35) : une ville correctement
// reconnue doit trancher nettement, pas ajouter un dixieme de point qu'un
// simple ecart d'accentuation OCR peut deja combler. Pas de plafond sur le
// score total : il ne sert qu'au tri/seuil relatif, jamais affiche comme une
// probabilite brute (voir geocode-ui.js qui clampe l'affichage a 100%).
const COMMUNE_MATCH_BONUS = 0.35;
const NUMERO_MATCH_BONUS = 0.15;
const REP_MATCH_BONUS = 0.08;
const REP_MISMATCH_PENALTY = 0.08;

// Separe un numero de voie combine (ex: "6", "6 bis", "6a") en {n, rep} pour
// le comparer aux champs BAN, qui les stockent SEPAREMENT (entry.n = "6",
// entry.rep = "BIS"/"A"/...). Bug reel corrige ici : l'ancien code comparait
// le numero tel quel a entry.n seul ("6 bis" !== "6"), donc le bonus numero
// ne s'appliquait quasiment jamais des qu'une adresse avait un suffixe --
// meme bis/ter, deja "reconnus" par splitNumeroRue cote scan-ui.js, ne
// beneficiaient d'aucun bonus au moment du matching.
function splitNumeroRep(numero) {
  const s = String(numero || "").trim();
  if (!s) return { n: "", rep: "" };
  const m = s.match(/^(\d+)\s?(bis|ter|quater|quinquies|[a-z])?\.?$/i);
  if (!m) return { n: s, rep: "" };
  return { n: m[1], rep: (m[2] || "").toLowerCase() };
}

function normalizeRep(rep) {
  return String(rep || "")
    .toLowerCase()
    .replace(/[.\s]/g, "")
    .trim();
}

// Comparaison de commune tolerante aux tirets/apostrophes (voir usage dans
// scoreCandidates) -- volontairement PAS utilisee pour le stockage
// (entry.cn reste tel que precalcule par data-prep), seulement au moment de
// la comparaison, donc aucun impact sur ban.json.gz deja genere/deploye.
// Exportee : reutilisee par parse-address-list.js (reconnaissance d'une
// ligne "ville" via la liste des communes connues), meme probleme -- un
// terminal affiche souvent une commune composee SANS tirets ("DOMMARTIN LES
// TOUL") alors que la BAN la stocke AVEC ("dommartin-les-toul").
// Les ligatures sont expansees ICI et pas dans normalizeCity, pour la meme
// raison que les tirets : les `cn` de assets/ban.json.gz sont deja calcules et
// stockes avec la ligature ("kœur-la-grande", "vandœuvre-les-nancy", "jœuf",
// "lalœuf" -- 5 communes de la zone). Un terminal ecrit toujours "KOEUR LA
// GRANDE" : sans expansion des DEUX cotes au moment de comparer, la commune
// n'etait jamais reconnue, elle finissait collee a la rue et l'arret partait
// sans ville (terrain 2026-09-09, Kœur-la-Grande et Kœur-la-Petite).
// "ST"/"STE" -> "SAINT"/"SAINTE" : le terminal l'abrege ("SORCY ST MARTIN"),
// et le livreur le tape pareil ("st mihiel"). Cette expansion vivait
// uniquement dans parse-address-list.js, donc SEUL le scan de liste en
// profitait : une commune tapee a la main dans la fiche colis n'etait pas
// reconnue (ni par l'autocompletion, ni par le bonus commune du geocodage),
// et l'adresse repartait sur le seul code postal -- exactement ce qui a
// envoye deux arrets dans le mauvais village (retour terrain 2026-09-11 :
// "il prend pas la ville s'il y a st au lieu de saint").
// Mot ENTIER seulement : aucune commune francaise ne commence par un mot
// "st"/"ste" qui ne soit pas "saint"/"sainte".
export function looseCommune(s) {
  return String(s || "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[-']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bste\b/gi, "sainte")
    .replace(/\bst\b/gi, "saint");
}

// Extrait de matchAddress() pour rester testable sans IndexedDB (voir
// match-address.test.mjs) : prend le pool BAN deja recupere en entree plutot
// que d'aller le chercher lui-meme.
export function scoreCandidates(pool, { normRue, normCommune, numero }) {
  const wanted = splitNumeroRep(numero);
  const queryTokens = motsPorteurs(normRue);
  const scored = pool.map((entry) => {
    let score = streetSimilarity(normRue, entry.rn);
    // Aucun mot porteur en commun : c'est une autre voie, quelle que soit la
    // ressemblance des mots de liaison (voir MOTS_DE_VOIE).
    const contenu = contentMatch(queryTokens, entry.rn);
    if (contenu != null && contenu < CONTENT_MATCH_MIN) score *= CONTENT_MISMATCH_FACTOR;
    if (wanted.n && entry.n && wanted.n === String(entry.n).trim()) {
      score += NUMERO_MATCH_BONUS;
      // Numero identique : departage par le suffixe (bis/A/B...), frequent
      // que plusieurs entrees BAN partagent le meme numero de base a une
      // meme adresse ("6", "6 bis", "6 ter" cote a cote). Une correspondance
      // exacte du suffixe renforce le score ; un suffixe clairement
      // different (l'un des deux est renseigne, l'autre different) penalise
      // legerement -- jamais assez pour annuler le bonus numero de base, le
      // numero reste le signal le plus fort.
      const entryRep = normalizeRep(entry.rep);
      const wantedRep = normalizeRep(wanted.rep);
      if (wantedRep && entryRep && wantedRep === entryRep) {
        score += REP_MATCH_BONUS;
      } else if (wantedRep !== entryRep) {
        score -= REP_MISMATCH_PENALTY;
      }
    }
    // Comparaison stricte d'abord, puis un repli "sans tirets/apostrophes"
    // (jamais applique au stockage, uniquement ici a la volee -- pas besoin
    // de reconstruire ban.json.gz) : beaucoup de communes francaises ont un
    // nom compose ("Rembercourt-sur-Mad", "Saint-Mihiel"), et un utilisateur
    // qui tape/OCRise le nom sans les tirets (espaces a la place) perdait
    // jusqu'ici tout le bonus commune -- exactement le signal cense
    // departager deux villages qui partagent une meme rue courante.
    if (normCommune && (entry.cn === normCommune || looseCommune(entry.cn) === looseCommune(normCommune))) {
      score += COMMUNE_MATCH_BONUS;
    }
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * @param {{rue:string, cp:string, commune:string, numero?:string}} address
 * @returns {Promise<{best: {entry:object, score:number} | null, candidates: {entry:object, score:number}[]}>}
 */
export async function matchAddress({ rue, cp, commune, numero }) {
  const normRue = normalizeStreet(rue);
  const normCommune = normalizeCity(commune);

  let pool = await queryByCp(cp);
  if (pool.length === 0 && normCommune) {
    pool = await queryByCommune(normCommune);
  }
  if (pool.length === 0) {
    return { best: null, candidates: [] };
  }

  const scored = scoreCandidates(pool, { normRue, normCommune, numero });
  const candidates = scored.slice(0, 5);
  const best = candidates.length > 0 && candidates[0].score >= CONFIDENCE_THRESHOLD ? candidates[0] : null;

  return { best, candidates };
}
