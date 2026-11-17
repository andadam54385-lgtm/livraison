// Regles pures de l'ecran Favoris (favoris-ui.js), testees dans
// favoris-liste.test.mjs. Aucun acces au DOM ni a IndexedDB.

import { horairesOf, horairesSontVides } from "./horaires.js";

// Minuscules sans accents : « éPINAL » trouve « Epinal ».
function plat(texte) {
  return String(texte || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Chaque mot tape doit apparaitre quelque part (nom, rue, CP, ville ou note),
// dans n'importe quel ordre : « foch nancy » trouve « 12 avenue Foch, 54000 Nancy ».
export function filtrerFavoris(favoris, recherche) {
  const mots = plat(recherche).split(/\s+/).filter(Boolean);
  if (mots.length === 0) return favoris;
  return favoris.filter((f) => {
    const texte = plat([f.nom, f.rue, f.cp, f.ville, f.note].join(" "));
    return mots.every((m) => texte.includes(m));
  });
}

// Ce qu'affiche la ligne repliee : titre, sous-titre, et deux reperes
// (une note existe, des horaires existent) pour savoir quoi ouvrir.
// Avec un nom (entreprise, client) : le nom en titre, l'adresse dessous.
export function resumeFavori(f) {
  const nom = String(f.nom || "").trim();
  if (nom) {
    return {
      titre: nom,
      sousTitre: [f.rue, [f.cp, f.ville].filter(Boolean).join(" ")].filter(Boolean).join(", "),
      aNote: Boolean(String(f.note || "").trim()),
      aHoraires: !horairesSontVides(horairesOf(f)),
    };
  }
  const titre = f.rue || f.ville || "(adresse sans rue)";
  const sousTitre = [f.cp, f.rue ? f.ville : ""].filter(Boolean).join(" ");
  return {
    titre,
    sousTitre,
    aNote: Boolean(String(f.note || "").trim()),
    aHoraires: !horairesSontVides(horairesOf(f)),
  };
}
