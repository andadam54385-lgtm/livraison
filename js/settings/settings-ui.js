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

export async function mount(container) {
  containerRef = container;
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
      ? `<p class="muted">Aucune adresse favorite pour l'instant. Marque un colis livré comme favori depuis sa fiche (bouton ⭐).</p>`
      : favoris
          .map(
            (f) => `
        <div class="card" data-favori-id="${escapeHtml(f.id)}" style="margin-top:8px;">
          <div class="card-title">${escapeHtml(f.rue) || "(adresse)"}</div>
          <p class="muted">${escapeHtml(f.cp)} ${escapeHtml(f.ville)}</p>
          ${f.note ? `<p>${escapeHtml(f.note)}</p>` : `<p class="muted">Pas de note.</p>`}
          <div class="button-row">
            <button type="button" data-favori-addtour>➕ Ajouter à la tournée</button>
            <button type="button" data-favori-edit>✏ Note</button>
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
    <div class="field">
      <label>Modèle de SMS</label>
      <textarea id="s-sms-template" class="field-lg" rows="3" style="min-height:0;">${escapeHtml(settings.smsTemplate)}</textarea>
      <button type="button" id="s-sms-template-reset" style="margin-top:6px;">Réinitialiser le modèle</button>
    </div>
    <p class="muted" style="margin-top:-6px;margin-bottom:12px;">
      Variables : <code>{nom}</code>, <code>{adresse}</code>, <code>{minutes_estimees}</code> (temps restant estimé,
      disponible seulement sur l'arrêt courant d'une tournée active). Le SMS s'ouvre pré-rempli dans Messages —
      jamais envoyé automatiquement.
    </p>
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

  containerRef.querySelector("#s-save").addEventListener("click", async () => {
    await setSetting("depotLat", parseFloat(containerRef.querySelector("#s-depot-lat").value));
    await setSetting("depotLon", parseFloat(containerRef.querySelector("#s-depot-lon").value));
    await setSetting("depotLabel", containerRef.querySelector("#s-depot-label").value.trim());
    await setSetting("navApp", containerRef.querySelector("#s-nav-app").value);
    await setSetting("autoNavAfterDeliver", containerRef.querySelector("#s-auto-nav").checked);
    await setSetting("avant12hPenaltyMinutes", parseFloat(containerRef.querySelector("#s-penalty").value));
    await setSetting("dureeArretMinutes", parseFloat(containerRef.querySelector("#s-duree-arret").value));
    await setSetting("smsTemplate", containerRef.querySelector("#s-sms-template").value.trim());
    alert("Réglages enregistrés.");
  });

  containerRef.querySelector("#s-sms-template-reset").addEventListener("click", () => {
    containerRef.querySelector("#s-sms-template").value = DEFAULTS.smsTemplate;
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

  containerRef.querySelectorAll("[data-favori-edit]").forEach((el) => {
    el.addEventListener("click", async () => {
      const id = el.closest("[data-favori-id]").dataset.favoriId;
      const favori = favoris.find((f) => f.id === id);
      const note = prompt("Note pour cette adresse favorite :", favori?.note || "");
      if (note === null) return;
      await updateFavori(id, { note });
      render();
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
