// Reconnaissance d'un favori par son TEXTE (nom d'entreprise, rue), pas
// seulement par sa position. Retour terrain 2026-11-03 : "j'espere que si on
// garde l'adresse de l'entreprise en favori, on garde aussi sa position GPS".
// La position etait bien gardee, mais jamais reutilisee : findNearbyFavori ne
// cherche qu'APRES geocodage, a 60 m pres -- une adresse sans rue ("AZUR
// PRODUCTION / ONVILLE") retombait au centre du village, trop loin du point
// corrige la veille pour retrouver le favori. Ici, le texte scanne suffit.
//
// Module pur (aucun acces IndexedDB) : testable sous Node, voir
// favori-texte.test.mjs.

const SAINT = { st: "saint", ste: "sainte" };

export function normTexte(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((t) => SAINT[t] || t)
    .join(" ");
}

// Textes qui designent ce favori : son nom, sa rue, et les variantes deja
// rencontrees (alias -- "AZUR PROD" choisi une fois dans la liste des favoris
// pour "AZUR PRODUCTION" sera reconnu directement la fois suivante).
export function textesFavori(fav) {
  return [fav.nom, fav.rue, ...(fav.alias || [])].map(normTexte).filter(Boolean);
}

// Meme commune : les deux villes si elles sont connues (un code postal couvre
// souvent plusieurs villages -- "Grande Rue" existe dans chacun), sinon le
// code postal.
function memeCommune(fav, adresse) {
  const v1 = normTexte(fav.ville);
  const v2 = normTexte(adresse.ville);
  if (v1 && v2) return v1 === v2;
  const cp1 = String(fav.cp || "").trim();
  const cp2 = String(adresse.cp || "").trim();
  return !!(cp1 && cp2 && cp1 === cp2);
}

export function favoriCorrespond(fav, { nom = "", rue = "", cp = "", ville = "" } = {}) {
  if (fav.lat == null || fav.lon == null) return false;
  if (!memeCommune(fav, { cp, ville })) return false;
  const cherches = [nom, rue].map(normTexte).filter(Boolean);
  if (cherches.length === 0) return false;
  const connus = textesFavori(fav);
  return cherches.some((t) => connus.includes(t));
}

// Score de recherche libre (champ "Nom / lieu a chercher") : part des mots
// tapes retrouves dans le favori (debut de mot suffit : "azur prod" trouve
// "AZUR PRODUCTION"). Un favori ne sort que si au moins un mot hors commune
// correspond -- sinon taper "onville" listerait tous les favoris du village.
export function scoreRecherche(fav, query) {
  const mots = normTexte(query).split(" ").filter((t) => t.length >= 2);
  if (mots.length === 0) return 0;
  const motsFavori = normTexte([fav.nom, fav.rue, ...(fav.alias || []), fav.cp, fav.ville, fav.note].join(" ")).split(" ");
  const motsVille = new Set(normTexte(`${fav.ville} ${fav.cp}`).split(" "));
  let trouves = 0;
  let horsVille = false;
  for (const m of mots) {
    if (motsFavori.some((w) => w.startsWith(m))) {
      trouves++;
      if (!motsVille.has(m)) horsVille = true;
    }
  }
  if (!horsVille) return 0;
  return trouves / mots.length;
}

export function rechercherDansFavoris(favoris, query, limit = 5) {
  return favoris
    .filter((f) => f.lat != null && f.lon != null)
    .map((f) => ({ fav: f, score: scoreRecherche(f, query) }))
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.fav);
}

export function libelleFavori(fav) {
  const titre = fav.nom || fav.rue || "(sans nom)";
  const lieu = [fav.nom ? fav.rue : "", `${fav.cp || ""} ${fav.ville || ""}`.trim()].filter(Boolean).join(", ");
  return lieu ? `${titre} — ${lieu}` : titre;
}
