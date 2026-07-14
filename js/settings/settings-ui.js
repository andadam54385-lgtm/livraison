import { getAllSettings, setSetting } from "./settings-store.js";
import { getDb } from "../db/schema.js";
import { clear } from "../lib/idb.js";

let containerRef = null;

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
    <div class="field">
      <label>Application de navigation</label>
      <select id="s-nav-app">
        <option value="apple" ${settings.navApp === "apple" ? "selected" : ""}>Apple Plans</option>
        <option value="waze" ${settings.navApp === "waze" ? "selected" : ""}>Waze</option>
      </select>
    </div>
    <div class="field">
      <label>Pénalité "avant 12h" (minutes par position dans l'ordre)</label>
      <input type="number" min="0" step="5" id="s-penalty" value="${settings.avant12hPenaltyMinutes}">
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
      <div class="card-title">Zone dangereuse</div>
      <p class="muted">Efface tous les colis et tournées (le graphe routier et les adresses restent, pas besoin de réimporter).</p>
      <button type="button" class="danger" id="s-reset">Effacer tous les colis et tournées</button>
    </div>
  `;

  containerRef.querySelector("#s-save").addEventListener("click", async () => {
    await setSetting("depotLat", parseFloat(containerRef.querySelector("#s-depot-lat").value));
    await setSetting("depotLon", parseFloat(containerRef.querySelector("#s-depot-lon").value));
    await setSetting("depotLabel", containerRef.querySelector("#s-depot-label").value.trim());
    await setSetting("navApp", containerRef.querySelector("#s-nav-app").value);
    await setSetting("avant12hPenaltyMinutes", parseFloat(containerRef.querySelector("#s-penalty").value));
    alert("Réglages enregistrés.");
  });

  containerRef.querySelector("#s-reset").addEventListener("click", async () => {
    if (!confirm("Effacer tous les colis et tournées ? Cette action est irréversible.")) return;
    const db = await getDb();
    await clear(db, "colis");
    await clear(db, "tours");
    alert("Données effacées.");
    render();
  });
}
