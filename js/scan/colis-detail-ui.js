import {
  getColis,
  saveColis,
  deleteColis,
  formatAdresseAffichage,
  formatAdresseForNav,
  TYPE_CLIENT_OPTIONS,
  OPERATION_OPTIONS,
  AVANT12H_OPTIONS,
  verbeAction,
} from "./colis-store.js";
import { segmentedHtml, bindSegmented, readSegmented } from "../ui/segmented.js";
import { addFavori, updateFavori, findNearbyFavori } from "../favoris/favoris-store.js";
import { getActiveTour, markStopDelivered, markStopFailed } from "../routing/tour-store.js";
import { getSetting } from "../settings/settings-store.js";
import { buildNavUrl } from "../tour/deep-links.js";
import { buildSmsOptions } from "../tour/sms-template.js";
import { renderReviewForm } from "./scan-ui.js";
import { showToast } from "../lib/toast.js";
import { icon } from "../ui/icons.js";
import { escapeHtml, escapeAttr } from "../lib/escape.js";

// Fiche colis consolidee : point d'entree UNIQUE pour voir le detail d'un
// colis et agir dessus (Corriger/Favori/Supprimer), qu'on y arrive depuis la
// liste de preparation (Etat A) ou la tournee en cours (Etat B). Supprimer et
// Favori ne vivent QUE ici -- plus jamais de bouton direct sur une carte de
// liste (voir historique de discussion, chantier fusion Tournee/Scan).


function badgeForStatut(statut) {
  if (statut === "pret") return `<span class="badge badge-ok">Prêt</span>`;
  if (statut === "en_tournee") return `<span class="badge badge-ok">En tournée</span>`;
  if (statut === "livre") return `<span class="badge badge-ok">Livré</span>`;
  if (statut === "echec") return `<span class="badge badge-warn">Échec</span>`;
  return `<span class="badge badge-pending">À vérifier</span>`;
}

// Note par adresse (chantier G, simplifiee suite retour terrain : plus de
// boite de dialogue navigateur, un champ texte normal dans la fiche qui
// s'enregistre en quittant le champ). Cree le favori silencieusement au 1er
// caractere tape s'il n'existait pas encore -- "favori" ici n'est qu'une
// adresse qui porte une note, pas une action separee a declencher a la main.
async function saveNote(colis, note) {
  const existing = await findNearbyFavori(colis.geocode.lat, colis.geocode.lon);
  if (existing) {
    await updateFavori(existing.id, { note });
  } else if (note.trim()) {
    await addFavori({
      rue: colis.adresseRaw.rue,
      cp: colis.adresseRaw.cp,
      ville: colis.adresseRaw.ville,
      lat: colis.geocode.lat,
      lon: colis.geocode.lon,
      note,
    });
  }
}

export async function renderColisDetail(container, colisId, { onBack, onChange } = {}) {
  const colis = await getColis(colisId);
  if (!colis) {
    container.innerHTML = `<div class="empty-state">Colis introuvable.</div>`;
    return;
  }

  const activeTour = await getActiveTour();
  const stop = activeTour?.stops.find((s) => s.colisId === colisId) || null;
  // "Livre" n'apparait ici qu'en secondaire, et seulement si ce colis est
  // effectivement un arret de la tournee en cours pas encore traite --
  // jamais au depot (Etat A, pas de tournee active -> pas de stop).
  const showDeliveryActions = stop && stop.statutLivraison !== "livre" && stop.statutLivraison !== "echec";

  const adresse = formatAdresseAffichage(colis);
  const navUrl = colis.geocode?.lat != null ? buildNavUrl(await getSetting("navApp"), { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse: formatAdresseForNav(colis) }) : null;
  const canFavori = colis.geocode?.status === "ok";
  const titre = colis.nom || adresse;
  const existingFavori = canFavori ? await findNearbyFavori(colis.geocode.lat, colis.geocode.lon) : null;
  // Pas d'estimation de temps ici (ce calcul vit dans tour-ui.js, couteux a
  // refaire pour une seule fiche) -- {minutes_estimees} reste vide, voir
  // buildSmsOptions. Version avec minutes reelles : hero card (arret courant).
  const smsOptions = colis.tel ? buildSmsOptions(await getSetting("smsTemplates"), colis.tel, { nom: colis.nom, adresse }) : [];

  container.innerHTML = `
    <div class="card-row" style="margin-bottom:10px;">
      <button type="button" id="detail-back">${icon("arrow-left")}Retour</button>
      ${badgeForStatut(colis.statut)}
    </div>
    <div class="card">
      <div class="card-title" style="font-size:1.2rem;">${escapeHtml(titre)}</div>
      ${colis.nom ? `<div class="muted">${escapeHtml(adresse)}</div>` : ""}
      ${colis.tel ? `<a class="btn-link" style="margin-top:10px;" href="tel:${escapeAttr(colis.tel)}">${icon("phone")}${escapeHtml(colis.tel)}</a>` : ""}
      ${smsOptions.length > 0 ? `<button type="button" class="btn-link" style="margin-top:8px;" id="detail-sms-toggle">${icon("message-circle")}SMS</button>` : ""}
      ${
        smsOptions.length > 0
          ? `<div class="candidate-list" id="detail-sms-options" hidden style="margin-top:8px;">
              ${smsOptions
                .map(
                  (o) =>
                    `<a class="candidate-item btn-link" href="${o.href}">${escapeHtml(o.label || `Modèle ${o.index + 1}`)}<span class="muted">${escapeHtml(o.body)}</span></a>`
                )
                .join("")}
            </div>`
          : ""
      }
      ${colis.quantite > 1 ? `<span class="badge badge-pending" style="margin-top:6px;">${colis.quantite} colis à cette adresse</span>` : ""}
    </div>
    <div class="field">
      <label>Type de client</label>
      ${segmentedHtml("typeClient", TYPE_CLIENT_OPTIONS, colis.typeClient || "particulier")}
    </div>
    <div class="field">
      <label>Opération</label>
      ${segmentedHtml("operation", OPERATION_OPTIONS, colis.operation || "livraison")}
    </div>
    <div class="field">
      <label>Heure</label>
      ${segmentedHtml("avant12h", AVANT12H_OPTIONS, colis.avant12h ? "oui" : "non")}
    </div>
    ${
      canFavori
        ? `
      <div class="field">
        <label>${icon("star")}Note pour cette adresse</label>
        <textarea id="detail-note" class="field-lg" rows="2" style="min-height:0;" placeholder="Code portail, chien, consigne...">${escapeHtml(existingFavori?.note || "")}</textarea>
      </div>
    `
        : ""
    }
    ${
      showDeliveryActions
        ? `
      <div class="button-row">
        ${navUrl ? `<a class="btn-link primary btn-lg" href="${navUrl}" target="_blank" rel="noopener">${icon("navigation")}Naviguer</a>` : ""}
      </div>
      <div class="button-row">
        <button type="button" class="ok btn-lg" id="detail-deliver">${icon("check")}${verbeAction(colis)}</button>
      </div>
      <button type="button" class="hero-fail-btn" id="detail-fail">Marquer en échec</button>
    `
        : ""
    }
    <div class="button-row" style="margin-top:16px;">
      <button type="button" id="detail-correct">${icon("pencil")}Corriger</button>
    </div>
    <div class="button-row">
      <button type="button" class="danger" id="detail-delete">${icon("trash-2")}Supprimer</button>
    </div>
  `;

  container.querySelector("#detail-back").addEventListener("click", () => onBack?.());

  // Contrairement au formulaire de scan (relu d'un bloc a la validation), la
  // fiche colis n'a pas de bouton "Enregistrer" : chaque choix est applique
  // immediatement, comme l'ancienne case a cocher qu'il remplace.
  for (const champ of ["typeClient", "operation", "avant12h"]) {
    bindSegmented(container, champ);
    for (const btn of container.querySelectorAll(`[data-segmented="${champ}"]`)) {
      btn.addEventListener("click", async () => {
        colis.typeClient = readSegmented(container, "typeClient") || "particulier";
        colis.operation = readSegmented(container, "operation") || "livraison";
        colis.avant12h = readSegmented(container, "avant12h") === "oui";
        await saveColis(colis);
        onChange?.();
      });
    }
  }

  container.querySelector("#detail-sms-toggle")?.addEventListener("click", () => {
    container.querySelector("#detail-sms-options")?.toggleAttribute("hidden");
  });

  // Enregistrement silencieux en quittant le champ (pas de bouton dedie, pas
  // de boite de dialogue) : uniquement si le texte a reellement change, pour
  // ne pas ecrire/toaster a chaque simple tap dans le champ puis en dehors.
  const noteEl = container.querySelector("#detail-note");
  if (noteEl) {
    const initialNote = noteEl.value;
    noteEl.addEventListener("blur", async () => {
      if (noteEl.value === initialNote) return;
      await saveNote(colis, noteEl.value);
      showToast("Note enregistrée.");
    });
  }

  if (showDeliveryActions) {
    container.querySelector("#detail-deliver").addEventListener("click", async () => {
      await markStopDelivered(activeTour.id, stop.ordre);
      onChange?.();
      onBack?.();
    });
    container.querySelector("#detail-fail").addEventListener("click", async () => {
      const raison = prompt("Motif de l'échec (absent, accès impossible...) :", "");
      if (raison === null) return;
      await markStopFailed(activeTour.id, stop.ordre, raison);
      onChange?.();
      onBack?.();
    });
  }

  container.querySelector("#detail-correct").addEventListener("click", () => {
    renderReviewForm(container, colis, {
      isNew: false,
      onSaved: () => {
        onChange?.();
        renderColisDetail(container, colisId, { onBack, onChange });
      },
    });
  });

  container.querySelector("#detail-delete").addEventListener("click", async () => {
    if (!confirm("Supprimer ce colis ? Cette action est irréversible.")) return;
    await deleteColis(colisId);
    onChange?.();
    onBack?.();
  });
}
