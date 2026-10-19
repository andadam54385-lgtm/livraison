// Etat d'attente visuel partage (anneau qui tourne + texte) -- voir .spinner
// dans app.css. Remplace le texte statique brut ("Géocodage…") utilise
// jusqu'ici pour les attentes reelles (OCR, geocodage, chargement de la
// carte...), indiscernable a l'oeil d'un ecran fige. `text` doit deja etre
// une chaine sure a inserer telle quelle (toujours un texte fixe ecrit dans
// le code ici, jamais une donnee utilisateur -- si un jour ce n'est plus le
// cas, echapper au point d'appel avec escapeHtml, voir lib/escape.js).
export function loadingHtml(text) {
  return `<div class="empty-state"><div class="spinner"></div><p>${text}</p></div>`;
}

// Variante en ligne, pour une zone de statut deja en place (#routing-status,
// #import-status, un bouton, une liste de resultats...) ou le bloc centre
// ci-dessus casserait la mise en page : petit anneau + texte sur la meme
// ligne. Meme regle sur `text` que loadingHtml -- chaine sure telle quelle.
export function inlineLoadingHtml(text) {
  return `<span class="spinner spinner-inline"></span>${text}`;
}

// Meme etat en ligne, mais pose dans un element DEJA en place, et surtout
// reutilisable tel quel a chaque tick d'une progression (import BAN, calcul
// de la matrice de trajets...) : l'anneau existant est conserve et seul le
// texte est remplace. Reecrire innerHTML a chaque tick recreerait le noeud
// et redemarrerait l'animation CSS a zero a chaque fois -- l'anneau
// paraitrait fige, soit exactement le probleme qu'il doit resoudre. Le texte
// passe par un noeud texte (jamais interprete comme du HTML), donc aucune
// contrainte d'echappement ici, contrairement aux deux fonctions ci-dessus.
export function setInlineLoading(el, text) {
  if (!el) return;
  let spinner = el.firstElementChild;
  if (!spinner || !spinner.classList.contains("spinner-inline")) {
    el.textContent = "";
    spinner = document.createElement("span");
    spinner.className = "spinner spinner-inline";
    el.appendChild(spinner);
    el.appendChild(document.createTextNode(""));
  }
  spinner.nextSibling.textContent = text;
}
