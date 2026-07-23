import { getAllSettings, setSetting, DEFAULTS } from "./settings-store.js";
import { getDb } from "../db/schema.js";
import { clear } from "../lib/idb.js";
import { listFavoris, updateFavori, deleteFavori } from "../favoris/favoris-store.js";
import { saveColis } from "../scan/colis-store.js";
import { showToast } from "../lib/toast.js";
import { renderOcrDebug } from "../scan/ocr-debug-ui.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let containerRef = null;
let showDebugOcr = false;
// Copie de travail des 3 templates (menu deroulant : un seul visible/edite a
// la fois, voir plus bas) -- initialisee une fois par mount() pour survivre
// aux re-rendus internes (suppression d'un favori, etc.) sans perdre une
// modification pas encore enregistree.
let smsDraft = null;
let smsActiveIndex = 0;

// Accepte aussi l'ancien format (simple chaine, sans titre modifiable) pour
// ne pas planter sur un reglage deja enregistre avant l'ajout des titres.
function normalizeSmsTemplates(raw) {
  return (raw || []).map((t, i) => {
    if (typeof t === "string") return { label: DEFAULTS.smsTemplates[i]?.label || `Modèle ${i + 1}`, body: t };
    return { label: t.label || `Modèle ${i + 1}`, body: t.body || "" };
  });
}

export async function mount(container) {
  containerRef = container;
  const settings = await getAllSettings();
  smsDraft = normalizeSmsTemplates(settings.smsTemplates);
  smsActiveIndex = 0;
  await render();
}

async function render() {
  const settings = await getAllSettings();

  let storageInfo = "Indisponible sur cet appareil.";
  if (navigator.storage?.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      storageInfo = `${(usage / (1024 * 1024)).toFixed(1)} Mo utilisés / ${(quota / (1024 * 1024)).toFixed(0)} Mo disponibles`;
    } catch {
      // ignore, garde le message par defaut
    }
  }
  let persisted = false;
  if (navigator.storage?.persisted) {
    persisted = await navigator.storage.persisted();
  }

  const favoris = await listFavoris();
  const favorisHtml =
    favoris.length === 0
      ? `<p class="muted">Aucune adresse favorite pour l'instant. Tape une note sur la fiche d'un colis géocodé pour l'enregistrer ici automatiquement.</p>`
      : favoris
          .map(
            (f) => `
        <div class="card" data-favori-id="${escapeHtml(f.id)}" style="margin-top:8px;">
          <div class="card-title">${escapeHtml(f.rue) || "(adresse)"}</div>
          <p class="muted">${escapeHtml(f.cp)} ${escapeHtml(f.ville)}</p>
          <div class="field" style="margin-top:8px;margin-bottom:0;">
            <textarea data-favori-note class="field-lg" rows="2" style="min-height:0;" placeholder="Code portail, chien, consigne...">${escapeHtml(f.note)}</textarea>
          </div>
          <div class="button-row" style="margin-top:8px;">
            <button type="button" data-favori-addtour>➕ Ajouter à la tournée</button>
            <button type="button" class="danger" data-favori-delete>🗑 Supprimer</button>
          </div>
        </div>`
          )
          .join("");

  containerRef.innerHTML = `
    <div class="field">
      <label>Latitude dépôt</label>
      <input type="number" step="0.0001" id="s-depot-lat" value="${settings.depotLat}">
    </div>
    <div class="field">
      <label>Longitude dépôt</label>
      <input type="number" step="0.0001" id="s-depot-lon" value="${settings.depotLon}">
    </div>
    <div class="field">
      <label>Nom du dépôt</label>
      <input type="text" id="s-depot-label" value="${settings.depotLabel}">
    </div>
    <p class="muted" style="margin-top:-6px;margin-bottom:12px;">Le départ (dépôt ou position) et le retour au dépôt en fin de tournée se choisissent à chaque calcul, dans l'onglet Tournée.</p>
    <div class="field">
      <label>Application de navigation</label>
      <select id="s-nav-app">
        <option value="apple" ${settings.navApp === "apple" ? "selected" : ""}>Apple Plans</option>
        <option value="waze" ${settings.navApp === "waze" ? "selected" : ""}>Waze</option>
        <option value="google" ${settings.navApp === "google" ? "selected" : ""}>Google Maps</option>
      </select>
    </div>
    <div class="toggle-row">
      <label for="s-auto-nav">Ouvrir le GPS automatiquement après "Livré"</label>
      <input type="checkbox" id="s-auto-nav" style="width:auto;min-height:0;" ${settings.autoNavAfterDeliver ? "checked" : ""}>
    </div>
    <p class="muted" style="margin-top:-6px;margin-bottom:12px;">Enchaîne directement vers l'arrêt suivant sans retaper sur "Naviguer".</p>
    <div class="field">
      <label>Pénalité "avant 12h" (minutes par position dans l'ordre)</label>
      <input type="number" min="0" step="5" id="s-penalty" value="${settings.avant12hPenaltyMinutes}">
    </div>
    <div class="field">
      <label>Durée moyenne par arrêt (minutes)</label>
      <input type="number" min="0" step="1" id="s-duree-arret" value="${settings.dureeArretMinutes}">
    </div>
    <p class="muted" style="margin-top:-6px;margin-bottom:12px;">Utilisée pour estimer l'heure d'arrivée à chaque arrêt (sonnette, remise en main propre...).</p>
    <div class="card">
      <div class="card-title">Modèles de SMS</div>
      <p class="muted" style="margin-top:-4px;">
        Variables : <code>{nom}</code>, <code>{adresse}</code>, <code>{minutes_estimees}</code> (temps restant estimé,
        disponible seulement sur l'arrêt courant d'une tournée active). Au moment d'envoyer, un choix entre les 3
        s'affiche. Le SMS s'ouvre pré-rempli dans Messages — jamais envoyé automatiquement.
      </p>
      <div class="field">
        <label>Modèle à modifier</label>
        <select id="s-sms-template-select">
          ${smsDraft.map((t, i) => `<option value="${i}" ${i === smsActiveIndex ? "selected" : ""}>${escapeHtml(t.label)}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>Titre du modèle</label>
        <input type="text" id="s-sms-template-label" class="field-lg" value="${escapeHtml(smsDraft[smsActiveIndex].label)}">
      </div>
      <div class="field">
        <label>Message</label>
        <textarea id="s-sms-template-active" class="field-lg" rows="3" style="min-height:0;">${escapeHtml(smsDraft[smsActiveIndex].body)}</textarea>
      </div>
      <button type="button" id="s-sms-template-reset">Réinitialiser ce modèle</button>
    </div>
    <div class="card">
      <div class="card-title">Stockage local</div>
      <p class="muted">${storageInfo}</p>
      <p class="muted">Stockage persistant : ${persisted ? "activé ✓" : "non activé"}</p>
    </div>
    <div class="button-row">
      <button type="button" class="primary" id="s-save">Enregistrer</button>
    </div>
    <div class="card" style="margin-top:20px;">
      <div class="card-title">Adresses favorites</div>
      <p class="muted">Conservées même après "Effacer tous les colis et tournées".</p>
      ${favorisHtml}
    </div>
    <div class="card" style="margin-top:20px;">
      <div class="card-row" style="cursor:pointer;" id="debug-ocr-toggle">
        <div class="card-title" style="margin-bottom:0;">🔍 Debug OCR</div>
        <span class="muted">${showDebugOcr ? "▲" : "▼"}</span>
      </div>
      <p class="muted" style="margin-top:6px;">Texte OCR brut et classification ligne par ligne d'un scan, pour comprendre pourquoi un nom/une rue n'a pas été trouvé.</p>
      <div id="debug-ocr-content" ${showDebugOcr ? "" : "hidden"} style="margin-top:10px;"></div>
    </div>
    <div class="card" style="margin-top:20px;">
      <div class="card-title">Zone dangereuse</div>
      <p class="muted">Efface tous les colis et tournées (le graphe routier, les adresses et les favoris restent, pas besoin de réimporter).</p>
      <button type="button" class="danger" id="s-reset">Effacer tous les colis et tournées</button>
    </div>
  `;

  const smsSelect = containerRef.querySelector("#s-sms-template-select");
  const smsLabelInput = containerRef.querySelector("#s-sms-template-label");
  const smsTextarea = containerRef.querySelector("#s-sms-template-active");

  smsLabelInput.addEventListener("input", () => {
    smsDraft[smsActiveIndex].label = smsLabelInput.value;
    smsSelect.options[smsActiveIndex].text = smsLabelInput.value || `Modèle ${smsActiveIndex + 1}`;
  });
  smsTextarea.addEventListener("input", () => {
    smsDraft[smsActiveIndex].body = smsTextarea.value;
  });
  smsSelect.addEventListener("change", () => {
    smsActiveIndex = Number(smsSelect.value);
    smsLabelInput.value = smsDraft[smsActiveIndex].label || "";
    smsTextarea.value = smsDraft[smsActiveIndex].body || "";
  });
  containerRef.querySelector("#s-sms-template-reset").addEventListener("click", () => {
    smsDraft[smsActiveIndex] = { ...DEFAULTS.smsTemplates[smsActiveIndex] };
    smsLabelInput.value = smsDraft[smsActiveIndex].label;
    smsTextarea.value = smsDraft[smsActiveIndex].body;
    smsSelect.options[smsActiveIndex].text = smsDraft[smsActiveIndex].label;
  });

  containerRef.querySelector("#s-save").addEventListener("click", async () => {
    await setSetting("depotLat", parseFloat(containerRef.querySelector("#s-depot-lat").value));
    await setSetting("depotLon", parseFloat(containerRef.querySelector("#s-depot-lon").value));
    await setSetting("depotLabel", containerRef.querySelector("#s-depot-label").value.trim());
    await setSetting("navApp", containerRef.querySelector("#s-nav-app").value);
    await setSetting("autoNavAfterDeliver", containerRef.querySelector("#s-auto-nav").checked);
    await setSetting("avant12hPenaltyMinutes", parseFloat(containerRef.querySelector("#s-penalty").value));
    await setSetting("dureeArretMinutes", parseFloat(containerRef.querySelector("#s-duree-arret").value));
    // Capture le modele affiche au moment d'enregistrer (input deja tenu a
    // jour pour les autres, celui-ci peut avoir le focus sans avoir declenche
    // son evenement "input" si l'utilisateur clique direct sur Enregistrer).
    smsDraft[smsActiveIndex] = { label: smsLabelInput.value.trim() || `Modèle ${smsActiveIndex + 1}`, body: smsTextarea.value.trim() };
    await setSetting("smsTemplates", smsDraft.map((t) => ({ ...t })));
    alert("Réglages enregistrés.");
  });

  // Bascule immediate (pas besoin de cliquer "Enregistrer" apres) : un
  // toggle qu'on coche puis qu'on oublie de sauvegarder avant de changer
  // d'onglet repart silencieusement a sa valeur par defaut, ce qui donnait
  // l'impression que le reglage "se desactivait tout seul".
  containerRef.querySelector("#s-auto-nav").addEventListener("change", (e) => {
    setSetting("autoNavAfterDeliver", e.target.checked);
  });

  containerRef.querySelector("#s-reset").addEventListener("click", async () => {
    if (!confirm("Effacer tous les colis et tournées ? Cette action est irréversible.")) return;
    const db = await getDb();
    await clear(db, "colis");
    await clear(db, "tours");
    alert("Données effacées.");
    render();
  });

  containerRef.querySelectorAll("[data-favori-addtour]").forEach((el) => {
    el.addEventListener("click", async () => {
      const id = el.closest("[data-favori-id]").dataset.favoriId;
      const favori = favoris.find((f) => f.id === id);
      if (!favori) return;
      await saveColis({
        nom: favori.rue || "Favori",
        adresseRaw: { rue: favori.rue, cp: favori.cp, ville: favori.ville },
        geocode: { lat: favori.lat, lon: favori.lon, status: "ok" },
        statut: "pret",
        dateScan: new Date().toISOString(),
        tel: "",
        quantite: 1,
        avant12h: false,
        sourceFavoriId: favori.id,
      });
      showToast(`⭐ "${favori.rue || "Favori"}" ajouté aux colis à trier.`);
    });
  });

  // Enregistrement silencieux en quittant le champ (pas de bouton dedie, pas
  // de boite de dialogue) : uniquement si le texte a change.
  containerRef.querySelectorAll("[data-favori-note]").forEach((el) => {
    const initialNote = el.value;
    el.addEventListener("blur", async () => {
      if (el.value === initialNote) return;
      const id = el.closest("[data-favori-id]").dataset.favoriId;
      await updateFavori(id, { note: el.value });
      showToast("⭐ Note enregistrée.");
    });
  });

  containerRef.querySelectorAll("[data-favori-delete]").forEach((el) => {
    el.addEventListener("click", async () => {
      const id = el.closest("[data-favori-id]").dataset.favoriId;
      if (!confirm("Supprimer cette adresse favorite ?")) return;
      await deleteFavori(id);
      render();
    });
  });

  containerRef.querySelector("#debug-ocr-toggle").addEventListener("click", () => {
    showDebugOcr = !showDebugOcr;
    render();
  });
  if (showDebugOcr) {
    renderOcrDebug(containerRef.querySelector("#debug-ocr-content"));
  }
}
