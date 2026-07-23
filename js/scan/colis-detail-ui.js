import { getColis, saveColis, deleteColis, formatAdresseAffichage } from "./colis-store.js";
import { addFavori, updateFavori, findNearbyFavori } from "../favoris/favoris-store.js";
import { getActiveTour, markStopDelivered, markStopFailed } from "../routing/tour-store.js";
import { getSetting } from "../settings/settings-store.js";
import { buildNavUrl } from "../tour/deep-links.js";
import { buildSmsOptions } from "../tour/sms-template.js";
import { renderReviewForm } from "./scan-ui.js";
import { showToast } from "../lib/toast.js";

// Fiche colis consolidee : point d'entree UNIQUE pour voir le detail d'un
// colis et agir dessus (Corriger/Favori/Supprimer), qu'on y arrive depuis la
// liste de preparation (Etat A) ou la tournee en cours (Etat B). Supprimer et
// Favori ne vivent QUE ici -- plus jamais de bouton direct sur une carte de
// liste (voir historique de discussion, chantier fusion Tournee/Scan).

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
  const navUrl = colis.geocode?.lat != null ? buildNavUrl(await getSetting("navApp"), { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse }) : null;
  const canFavori = colis.geocode?.status === "ok";
  const titre = colis.nom || adresse;
  const existingFavori = canFavori ? await findNearbyFavori(colis.geocode.lat, colis.geocode.lon) : null;
  // Pas d'estimation de temps ici (ce calcul vit dans tour-ui.js, couteux a
  // refaire pour une seule fiche) -- {minutes_estimees} reste vide, voir
  // buildSmsOptions. Version avec minutes reelles : hero card (arret courant).
  const smsOptions = colis.tel ? buildSmsOptions(await getSetting("smsTemplates"), colis.tel, { nom: colis.nom, adresse }) : [];

  container.innerHTML = `
    <div class="card-row" style="margin-bottom:10px;">
      <button type="button" id="detail-back">← Retour</button>
      ${badgeForStatut(colis.statut)}
    </div>
    <div class="card">
      <div class="card-title" style="font-size:1.2rem;">${escapeHtml(titre)}</div>
      <div class="muted">${escapeHtml(adresse)}</div>
      ${colis.tel ? `<a class="btn-link" style="margin-top:10px;" href="tel:${escapeHtml(colis.tel)}">📞 ${escapeHtml(colis.tel)}</a>` : ""}
      ${smsOptions.length > 0 ? `<button type="button" class="btn-link" style="margin-top:8px;" id="detail-sms-toggle">💬 SMS</button>` : ""}
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
      ${colis.tracking ? `<p class="muted" style="margin-top:8px;">Tracking : ${escapeHtml(colis.tracking)}</p>` : ""}
      ${colis.quantite > 1 ? `<span class="badge badge-pending" style="margin-top:6px;">${colis.quantite} colis à cette adresse</span>` : ""}
    </div>
    <div class="toggle-row">
      <label for="detail-avant12h">⏰ Livrer avant 12h</label>
      <input type="checkbox" id="detail-avant12h" ${colis.avant12h ? "checked" : ""} style="width:26px;height:26px;">
    </div>
    ${
      canFavori
        ? `
      <div class="field">
        <label>⭐ Note pour cette adresse</label>
        <textarea id="detail-note" class="field-lg" rows="2" style="min-height:0;" placeholder="Code portail, chien, consigne...">${escapeHtml(existingFavori?.note || "")}</textarea>
      </div>
    `
        : ""
    }
    ${
      showDeliveryActions
        ? `
      <div class="button-row">
        ${navUrl ? `<a class="btn-link primary btn-lg" href="${navUrl}" target="_blank" rel="noopener">🧭 Naviguer</a>` : ""}
      </div>
      <div class="button-row">
        <button type="button" class="ok btn-lg" id="detail-deliver">✓ Livré</button>
      </div>
      <button type="button" class="hero-fail-btn" id="detail-fail">Marquer en échec</button>
    `
        : ""
    }
    <div class="button-row" style="margin-top:16px;">
      <button type="button" id="detail-correct">✏️ Corriger</button>
    </div>
    <div class="button-row">
      <button type="button" class="danger" id="detail-delete">🗑 Supprimer</button>
    </div>
  `;

  container.querySelector("#detail-back").addEventListener("click", () => onBack?.());

  container.querySelector("#detail-avant12h").addEventListener("change", async (e) => {
    colis.avant12h = e.target.checked;
    await saveColis(colis);
    onChange?.();
  });

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
      showToast("⭐ Note enregistrée.");
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
