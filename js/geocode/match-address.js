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
function looseCommune(s) {
  return String(s || "")
    .replace(/[-']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extrait de matchAddress() pour rester testable sans IndexedDB (voir
// match-address.test.mjs) : prend le pool BAN deja recupere en entree plutot
// que d'aller le chercher lui-meme.
export function scoreCandidates(pool, { normRue, normCommune, numero }) {
  const wanted = splitNumeroRep(numero);
  const scored = pool.map((entry) => {
    let score = streetSimilarity(normRue, entry.rn);
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
