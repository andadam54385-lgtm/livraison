import { escapeHtml, escapeAttr } from "../lib/escape.js";
import { icon } from "./icons.js";

// Groupe de boutons a choix unique (pro/particulier, ramasse/livraison,
// avant 12h ou non). Retour terrain : ces choix se posent au moment de valider
// une adresse, et une case a cocher est une cible trop petite -- l'appli
// s'utilise a une main, parfois avec des gants (voir l'en-tete de app.css).
// Chaque option est ici une vraie cible tactile, et celle qui est active se
// lit d'un coup d'oeil sans avoir a viser un carre de 26px.
//
// L'etat vit dans le DOM (classe .active sur le bouton choisi) plutot que dans
// une variable a synchroniser : le formulaire est deja rendu d'un bloc en
// innerHTML puis relu champ par champ a la validation, readSegmented() suit
// exactement le meme schema que les querySelector(...).value voisins.

export function segmentedHtml(name, options, current) {
  const boutons = options
    .map((o) => {
      const actif = o.value === current;
      return `<button type="button" class="segmented-btn${actif ? " active" : ""}" data-segmented="${escapeAttr(name)}" data-value="${escapeAttr(o.value)}" aria-pressed="${actif}">${o.icon ? icon(o.icon, { size: 14 }) : ""}${escapeHtml(o.label)}</button>`;
    })
    .join("");
  return `<div class="segmented" role="group">${boutons}</div>`;
}

export function bindSegmented(container, name) {
  const boutons = [...container.querySelectorAll(`[data-segmented="${cssEscape(name)}"]`)];
  for (const b of boutons) {
    b.addEventListener("click", () => {
      for (const autre of boutons) {
        const actif = autre === b;
        autre.classList.toggle("active", actif);
        autre.setAttribute("aria-pressed", String(actif));
      }
    });
  }
}

export function readSegmented(container, name) {
  const actif = container.querySelector(`[data-segmented="${cssEscape(name)}"].active`);
  return actif ? actif.dataset.value : null;
}

// CSS.escape n'existe pas partout (et pas dans les tests hors navigateur) :
// les noms utilises ici sont des identifiants simples ecrits dans le code,
// donc un repli sans echappement est sans risque.
function cssEscape(value) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value;
}
