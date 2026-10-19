import { JOURS, JOURS_OUVRES, TOUS_LES_JOURS, jourKeyForDate, jourEstVide, appliquerJour, resumeJour } from "./horaires.js";
import { escapeHtml } from "../lib/escape.js";

// Editeur d'horaires jour par jour, PARTAGE par la fiche colis, la carte
// d'arret (tour-ui) et les Reglages -- une seule mecanique a maintenir.
// Onglets Lun..Dim (le jour courant preselectionne), UN seul jour edite a la
// fois : 7 jours x 4 champs n'entrent pas sur un ecran de telephone. Deux
// raccourcis recopient le jour affiche sur la semaine de travail ou sur tous
// les jours ("possibilite de l'appliquer sur d'autres jours", retour terrain).
//
// Par defaut DEUX plages (matin, apres-midi) ; la case "journee continue" n'en
// laisse qu'une, bornee elle aussi ("si ca ouvre a 12 mais en continu, c'est
// bien de le savoir"). Cocher la case n'efface jamais les heures de la
// coupure : elles sont seulement ignorees, et reviennent si on la decoche.
//
// onChange(horaires) est appele a chaque modification effective, avec un
// NOUVEL objet -- l'appelant enregistre et previent l'utilisateur.
export function renderHorairesEditor(host, horairesInitial, { onChange } = {}) {
  let horaires = clone(horairesInitial);
  let jourKey = jourKeyForDate(new Date());

  const emit = () => onChange?.(clone(horaires));
  const jourCourant = () => horaires[jourKey];
  const setJour = (patch) => {
    horaires[jourKey] = { ...horaires[jourKey], ...patch };
    emit();
  };

  function tabsHtml() {
    return JOURS.map((j) => {
      const jour = horaires[j.key];
      const etat = jour?.ferme ? "closed" : jourEstVide(jour) ? "" : "set";
      return `<button type="button" class="hours-day ${j.key === jourKey ? "active" : ""} ${etat}" data-jour="${j.key}" aria-label="${escapeHtml(j.label)}${jour?.ferme ? ", fermé" : ""}">${j.label}<span class="hours-dot"></span></button>`;
    }).join("");
  }

  function champsHtml(jour) {
    if (jour.continu) {
      return `
        <div class="hours-grid">
          <label>Ouvre à<input type="time" data-h="matinDebut" value="${escapeHtml(jour.matinDebut)}"></label>
          <label>Ferme à<input type="time" data-h="apremFin" value="${escapeHtml(jour.apremFin)}"></label>
        </div>`;
    }
    return `
      <div class="hours-grid">
        <label>Matin, ouvre à<input type="time" data-h="matinDebut" value="${escapeHtml(jour.matinDebut)}"></label>
        <label>Matin, ferme à<input type="time" data-h="matinFin" value="${escapeHtml(jour.matinFin)}"></label>
        <label>Après-midi, ouvre à<input type="time" data-h="apremDebut" value="${escapeHtml(jour.apremDebut)}"></label>
        <label>Après-midi, ferme à<input type="time" data-h="apremFin" value="${escapeHtml(jour.apremFin)}"></label>
      </div>`;
  }

  function resumeTexte(jour) {
    return resumeJour(jour) || "Aucun horaire ce jour : passage possible à toute heure.";
  }

  function bindTabs() {
    host.querySelectorAll("[data-jour]").forEach((btn) => {
      btn.addEventListener("click", () => {
        jourKey = btn.dataset.jour;
        render();
      });
    });
  }

  function render() {
    const jour = jourCourant();
    host.innerHTML = `
      <div class="hours-editor">
        <div class="hours-days">${tabsHtml()}</div>
        <div class="hours-modes">
          <label class="hours-check">
            <input type="checkbox" data-h="ferme" ${jour.ferme ? "checked" : ""}>
            <span>Fermé toute la journée</span>
          </label>
          <label class="hours-check" ${jour.ferme ? "hidden" : ""}>
            <input type="checkbox" data-h="continu" ${jour.continu ? "checked" : ""}>
            <span>Journée continue (pas de coupure)</span>
          </label>
        </div>
        ${jour.ferme ? "" : champsHtml(jour)}
        <p class="muted hours-resume">${escapeHtml(resumeTexte(jour))}</p>
        <div class="hours-copy">
          <button type="button" data-copy="ouvres">Copier sur lun–ven</button>
          <button type="button" data-copy="tous">Copier sur tous les jours</button>
        </div>
      </div>
    `;

    bindTabs();

    for (const champ of ["ferme", "continu"]) {
      host.querySelector(`input[type="checkbox"][data-h="${champ}"]`)?.addEventListener("change", (e) => {
        setJour({ [champ]: e.target.checked });
        render();
      });
    }

    // Les heures : "change" (valeur validee), pas "blur" -- sur iOS la roue du
    // selecteur d'heure valide sans forcement quitter le champ. Pas de
    // re-rendu complet ici (il fermerait le selecteur) : seuls les onglets et
    // le resume sont rafraichis.
    host.querySelectorAll('input[type="time"][data-h]').forEach((input) => {
      input.addEventListener("change", () => {
        setJour({ [input.dataset.h]: input.value });
        host.querySelector(".hours-days").innerHTML = tabsHtml();
        bindTabs();
        host.querySelector(".hours-resume").textContent = resumeTexte(jourCourant());
      });
    });

    host.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        horaires = appliquerJour(horaires, jourKey, btn.dataset.copy === "ouvres" ? JOURS_OUVRES : TOUS_LES_JOURS);
        emit();
        render();
      });
    });
  }

  render();
  return { get: () => clone(horaires) };
}

function clone(horaires) {
  const vide = { ferme: false, continu: false, matinDebut: "", matinFin: "", apremDebut: "", apremFin: "" };
  const out = {};
  for (const j of JOURS) out[j.key] = { ...vide, ...(horaires?.[j.key] || {}) };
  return out;
}
