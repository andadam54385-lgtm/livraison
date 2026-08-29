// Echappement HTML centralise -- avant ce module, chaque fichier UI avait sa
// propre copie locale d'escapeHtml/escapeAttr (9 copies au total), et c'est
// exactement ce qui a permis a un vrai trou de passer inaperçu : un fichier
// echappait le href="tel:..." avec escapeHtml (qui ne touche PAS aux
// guillemets, donc inoperant dans un attribut), d'autres ne l'echappaient
// pas du tout (voir commit "Audit code : corrige l'injection d'attribut via
// le telephone"). Une seule source de verite rend ce genre de derive
// impossible.
//
// escapeHtml : pour du CONTENU texte entre balises. Echappe aussi les
// guillemets -- inutile dans du texte mais inoffensif (&quot; s'affiche
// comme "), et rend la fonction sure meme si quelqu'un l'utilise par erreur
// dans un attribut.
export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// escapeAttr : pour l'INTERIEUR d'un attribut delimite par des guillemets
// doubles (value="...", data-x="...", href="..."). Le guillemet est le seul
// caractere qui puisse fermer l'attribut ; & est echappe aussi pour ne
// jamais produire d'entite involontaire.
export function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
