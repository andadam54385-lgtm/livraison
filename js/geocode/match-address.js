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

  const scored = pool.map((entry) => {
    let score = streetSimilarity(normRue, entry.rn);
    if (numero && entry.n && String(numero).trim() === String(entry.n).trim()) {
      score += 0.15;
    }
    if (normCommune && entry.cn === normCommune) {
      score += 0.05;
    }
    return { entry, score: Math.min(score, 1) };
  });

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 5);
  const best = candidates.length > 0 && candidates[0].score >= CONFIDENCE_THRESHOLD ? candidates[0] : null;

  return { best, candidates };
}
