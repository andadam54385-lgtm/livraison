import { JOURS, JOURS_OUVRES, TOUS_LES_JOURS, jourKeyForDate, jourEstVide, appliquerJour, resumeJour } from "./horaires.js";
import { escapeHtml } from "../lib/escape.js";

// Editeur d'horaires jour par jour, PARTAGE par la fiche colis, la carte
// d'arret (tour-ui) et les Reglages -- une seule mecanique a maintenir.
// Onglets Lun..Dim (le jour courant preselectionne), UN seul jour edite a la
// fois : 7 jours x 5 champs n'entrent pas sur un ecran de telephone. Deux
// raccourcis recopient le jour affiche sur la semaine de travail ou sur tous
// les jours ("possibilite de l'appliquer sur d'autres jours", retour terrain).
// onChange(horaires) est appele a chaque modification effective, avec un
// NOUVEL objet -- l'appelant enregistre et previent l'utilisateur.
export function renderHorairesEditor(host, horairesInitial, { onChange } = {}) {
  let horaires = clone(horairesInitial);
  let jourKey = jourKeyForDate(new Date());

  function emit() {
    onChange?.(clone(horaires));
  }

  function tabsHtml() {
    return JOURS.map((j) => {
      const jour = horaires[j.key];
      const etat = jour?.ferme ? "closed" : jourEstVide(jour) ? "" : "set";
      return `<button type="button" class="hours-day ${j.key === jourKey ? "active" : ""} ${etat}" data-jour="${j.key}" aria-label="${escapeHtml(j.label)}${jour?.ferme ? ", fermé" : ""}">${j.label}<span class="hours-dot"></span></button>`;
    }).join("");
  }

  function render() {
    const jour = horaires[jourKey];
    host.innerHTML = `
      <div class="hours-editor">
        <div class="hours-days">${tabsHtml()}</div>
        <label class="hours-ferme">
          <input type="checkbox" data-h="ferme" ${jour.ferme ? "checked" : ""}>
          <span>Fermé toute la journée</span>
        </label>
        <div class="hours-grid" ${jour.ferme ? "hidden" : ""}>
          <label>Ouvre à<input type="time" data-h="ouverture" value="${escapeHtml(jour.ouverture)}"></label>
          <label>Ferme à<input type="time" data-h="fermeture" value="${escapeHtml(jour.fermeture)}"></label>
          <label>Pause de<input type="time" data-h="pauseDebut" value="${escapeHtml(jour.pauseDebut)}"></label>
          <label>Pause jusqu'à<input type="time" data-h="pauseFin" value="${escapeHtml(jour.pauseFin)}"></label>
        </div>
        <p class="muted hours-resume">${escapeHtml(resumeJour(jour) || "Aucun horaire ce jour : passage possible à toute heure.")}</p>
        <div class="hours-copy">
          <button type="button" data-copy="ouvres">Copier sur lun–ven</button>
          <button type="button" data-copy="tous">Copier sur tous les jours</button>
        </div>
      </div>
    `;

    host.querySelectorAll("[data-jour]").forEach((btn) => {
      btn.addEventListener("click", () => {
        jourKey = btn.dataset.jour;
        render();
      });
    });

    host.querySelector('[data-h="ferme"]').addEventListener("change", (e) => {
      horaires[jourKey] = { ...horaires[jourKey], ferme: e.target.checked };
      emit();
      render();
    });

    // Les heures : "change" (valeur validee), pas "blur" -- sur iOS la roue
    // du selecteur d'heure valide sans forcement quitter le champ. Pas de
    // re-rendu complet ici (il fermerait le selecteur) : seuls les onglets et
    // le resume sont rafraichis.
    host.querySelectorAll('input[type="time"][data-h]').forEach((input) => {
      input.addEventListener("change", () => {
        horaires[jourKey] = { ...horaires[jourKey], [input.dataset.h]: input.value };
        emit();
        host.querySelector(".hours-days").innerHTML = tabsHtml();
        host.querySelectorAll("[data-jour]").forEach((btn) => {
          btn.addEventListener("click", () => {
            jourKey = btn.dataset.jour;
            render();
          });
        });
        host.querySelector(".hours-resume").textContent = resumeJour(horaires[jourKey]) || "Aucun horaire ce jour : passage possible à toute heure.";
      });
    });

    host.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cibles = btn.dataset.copy === "ouvres" ? JOURS_OUVRES : TOUS_LES_JOURS;
        horaires = appliquerJour(horaires, jourKey, cibles);
        emit();
        render();
      });
    });
  }

  render();
  return { get: () => clone(horaires) };
}

function clone(horaires) {
  const out = {};
  for (const j of JOURS) out[j.key] = { ...(horaires?.[j.key] || { ferme: false, ouverture: "", fermeture: "", pauseDebut: "", pauseFin: "" }) };
  return out;
}
