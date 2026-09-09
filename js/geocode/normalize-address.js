// Port de data-prep/scripts/lib/ban-normalizer.js (runtime navigateur, pas de
// dependance partagee possible avec le script Node de Composant A).
// La reference n'est plus data-prep depuis le 2026-07-24 (assets/ban.json.gz
// est regenere avec CE fichier, voir CLAUDE.md) : c'est donc la coherence avec
// les `rn` deja deployes qui compte. Toute regle ajoutee ici doit etre
// verifiee contre assets/ban.json.gz -- une expansion qui change la forme
// normalisee d'entrees deja indexees casse le matching silencieusement.

const ABBREVIATIONS = {
  av: "avenue",
  ave: "avenue",
  bd: "boulevard",
  bld: "boulevard",
  boul: "boulevard",
  pl: "place",
  che: "chemin",
  chem: "chemin",
  rte: "route",
  imp: "impasse",
  all: "allee",
  sq: "square",
  fg: "faubourg",
  st: "saint",
  ste: "sainte",
};

// "LT" = lotissement sur les listes du terminal (retour terrain) -- absent de
// ABBREVIATIONS parce que l'expansion n'est PAS inconditionnelle : dans la
// vraie BAN du secteur, les seuls "lt" isoles (74 entrees sur 366 396) sont
// des LIEUTENANTS -- "Rue du Lt Roland Excoffier", "Rue du Lt Colonel
// Bauclin". Les deux motifs se distinguent sans ambiguite :
//   - lieutenant : la voie porte deja son type ("rue") et "lt" suit un article
//     ("du Lt") ;
//   - lotissement : "lt" EST le type de voie, en tete ("LT LES ROSES") ou en
//     fin, ordre du terminal ("CLOS DES IRIS LT").
// Verifie sur assets/ban.json.gz : aucune entree deployee ne change de forme
// normalisee avec cette regle (les deux rues de lieutenant contiennent "rue").
// "lot" n'est deliberement PAS expanse : la BAN elle-meme ecrit 8 lotissements
// "Lot ..." dont le `rn` deploye commence par "lot" -- les expanser cote
// requete seulement les rendrait introuvables.
// Liste volontairement COURTE : elle ne sert qu'a rattraper un "Rue Lt Roland"
// sans article, jamais vu dans la BAN deployee mais possible. Y mettre tous
// les types de voie serait contre-productif -- les lotissements reels en
// portent dans leur NOM ("Lot le Clos des Iris", "Lot de la Haie de Seigle -
// Hameau de Criviller"), ils seraient alors tous bloques a tort.
const TYPES_DE_VOIE = new Set(["rue", "avenue", "boulevard", "impasse", "ruelle", "faubourg", "lotissement"]);
const ARTICLES = new Set(["de", "du", "des", "la", "le", "les", "d", "l"]);

function expandLotissement(tokens) {
  if (!tokens.includes("lt")) return tokens;
  if (tokens.some((tok) => TYPES_DE_VOIE.has(tok))) return tokens;
  return tokens.map((tok, i) => (tok === "lt" && !ARTICLES.has(tokens[i - 1] || "") ? "lotissement" : tok));
}

export function stripAccents(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeStreet(raw) {
  if (!raw) return "";
  let s = stripAccents(raw.toLowerCase());
  s = s.replace(/[^a-z0-9\s'-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  const tokens = s.split(" ").map((tok) => ABBREVIATIONS[tok] || tok);
  return expandLotissement(tokens).join(" ");
}

export function normalizeCity(raw) {
  if (!raw) return "";
  return stripAccents(raw.toLowerCase()).replace(/\s+/g, " ").trim();
}
