// Port exact de data-prep/scripts/lib/ban-normalizer.js (runtime navigateur,
// pas de dependance partagee possible avec le script Node de Composant A).
// Toute divergence entre les deux copies casse le matching adresse
// silencieusement -- ne pas modifier l'une sans repercuter sur l'autre.

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

export function stripAccents(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeStreet(raw) {
  if (!raw) return "";
  let s = stripAccents(raw.toLowerCase());
  s = s.replace(/[^a-z0-9\s'-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  const tokens = s.split(" ").map((tok) => ABBREVIATIONS[tok] || tok);
  return tokens.join(" ");
}

export function normalizeCity(raw) {
  if (!raw) return "";
  return stripAccents(raw.toLowerCase()).replace(/\s+/g, " ").trim();
}
