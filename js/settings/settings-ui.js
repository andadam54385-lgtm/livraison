import { getAllSettings, setSetting, DEFAULTS } from "./settings-store.js";
import { getDb } from "../db/schema.js";
import { clear, get } from "../lib/idb.js";
import { listFavoris, updateFavori, deleteFavori } from "../favoris/favoris-store.js";
import { saveColis } from "../scan/colis-store.js";
import { showToast } from "../lib/toast.js";
import { renderOcrDebug } from "../scan/ocr-debug-ui.js";
import { renderBugReports } from "../debug/bug-reports-ui.js";
import { exportToursCsv } from "../export/export-tours.js";
import { renderManualAddressSearch, formatEntry } from "../geocode/geocode-ui.js";
import { getActiveTour } from "../routing/tour-store.js";
import { insertStopCheapest } from "../routing/insert-stop.js";
import { icon } from "../ui/icons.js";
import { escapeHtml } from "../lib/escape.js";
import { APP_BUILD } from "../version.js";

let containerRef = null;
let showDebugOcr = false;
let showBugReports = false;
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

  // Repere de version des donnees locales (noeuds/aretes du graphe + hash
  // court) -- affiche ici pour pouvoir verifier a l'oeil, apres une
  // resynchronisation, que la zone attendue est bien celle chargee (sans ca,
  // aucun moyen de le savoir depuis l'appli -- source d'un vrai flou terrain).
  const db = await getDb();
  const graphMeta = await get(db, "graphMeta", "current");
  const graphInfo = graphMeta
    ? `Graphe routier : ${graphMeta.nodeCount.toLocaleString("fr-FR")} nœuds / ${graphMeta.edgeCount.toLocaleString("fr-FR")} arêtes (version ${graphMeta.version.slice(0, 8)})`
    : "Graphe routier : non chargé.";

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
            <button type="button" data-favori-addtour>${icon("plus")}Ajouter à la tournée</button>
            <button type="button" class="danger" data-favori-delete>${icon("trash-2")}Supprimer</button>
          </div>
        </div>`
          )
          .join("");

  containerRef.innerHTML = `
    <div class="card">
      <div class="card-title">Dépôt</div>
      <p class="muted" id="s-depot-current" style="margin-top:-4px;">${escapeHtml(settings.depotLabel)}</p>
      <div id="s-depot-search-slot"></div>
      <button type="button" id="s-depot-change">${icon("pencil")}Changer l'adresse du dépôt</button>
      <p class="muted" style="margin:10px 0 0;">Le départ (dépôt ou position) et le retour au dépôt en fin de tournée se choisissent à chaque calcul, dans l'onglet Tournée.</p>
    </div>
    <div class="card">
      <div class="card-title">${icon("navigation")}Navigation</div>
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
      <p class="muted" style="margin:-6px 0 0;">Enchaîne directement vers l'arrêt suivant sans retaper sur "Naviguer".</p>
    </div>
    <div class="card">
      <div class="card-title">${icon("zap")}Calcul de tournée</div>
      <div class="field">
        <label>Heure limite des colis "avant 12h"</label>
        <input type="time" id="s-limite-avant12h" value="${escapeHtml(settings.heureLimiteAvant12h)}">
      </div>
      <p class="muted" style="margin:-6px 0 12px;">Un colis marqué doit être servi avant cette heure. Tant qu'il y arrive, l'ordre du reste de la tournée reste libre — les autres arrêts peuvent tomber avant ou après.</p>
      <div class="field" style="margin-bottom:0;">
        <label>Durée moyenne par arrêt (minutes)</label>
        <input type="number" min="0" step="1" id="s-duree-arret" value="${settings.dureeArretMinutes}">
      </div>
      <p class="muted" style="margin:6px 0 0;">Utilisée pour estimer l'heure d'arrivée à chaque arrêt, et pour vérifier les heures limites ci-dessus.</p>
    </div>
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
      <p class="muted">Stockage persistant : ${persisted ? `activé ${icon("check", { spaced: false })}` : "non activé"}</p>
      <p class="muted">${graphInfo}</p>
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
        <div class="card-title" style="margin-bottom:0;">${icon("search")}Debug OCR</div>
        <span class="muted">${showDebugOcr ? icon("chevron-up", { spaced: false }) : icon("chevron-down", { spaced: false })}</span>
      </div>
      <p class="muted" style="margin-top:6px;">Texte OCR brut et classification ligne par ligne d'un scan, pour comprendre pourquoi un nom/une rue n'a pas été trouvé.</p>
      <div id="debug-ocr-content" ${showDebugOcr ? "" : "hidden"} style="margin-top:10px;"></div>
    </div>
    <div class="card" style="margin-top:20px;">
      <div class="card-row" style="cursor:pointer;" id="bug-reports-toggle">
        <div class="card-title" style="margin-bottom:0;">${icon("alert-triangle")}Signaler un bug</div>
        <span class="muted">${showBugReports ? icon("chevron-up", { spaced: false }) : icon("chevron-down", { spaced: false })}</span>
      </div>
      <p class="muted" style="margin-top:6px;">Note un souci à chaud, ou consulte/exporte les problèmes techniques capturés automatiquement.</p>
      <div id="bug-reports-content" ${showBugReports ? "" : "hidden"} style="margin-top:10px;"></div>
    </div>
    <div class="card" style="margin-top:20px;">
      <div class="card-title">Export</div>
      <p class="muted">Liste de toutes les tournées (en cours et archivées), un arrêt par ligne : nom, adresse, statut, heure — pour un suivi d'activité ou une preuve de livraison.</p>
      <button type="button" id="s-export-csv">${icon("clipboard-list")}Exporter les tournées (CSV)</button>
    </div>
    <div class="card" style="margin-top:20px;">
      <div class="card-title">Zone dangereuse</div>
      <p class="muted">Efface tous les colis et tournées (le graphe routier, les adresses et les favoris restent, pas besoin de réimporter).</p>
      <button type="button" class="danger" id="s-reset">Effacer tous les colis et tournées</button>
    </div>
    <p class="muted" style="text-align:center;margin-top:16px;">Version : build ${APP_BUILD}</p>
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

  // Adresse du depot : recherche BAN (comme partout ailleurs dans l'app),
  // plus de latitude/longitude a taper a la main -- sauvegarde immediate au
  // choix, pas besoin de cliquer "Enregistrer" apres.
  containerRef.querySelector("#s-depot-change").addEventListener("click", () => {
    const slot = containerRef.querySelector("#s-depot-search-slot");
    renderManualAddressSearch(slot, {
      initialQuery: settings.depotLabel,
      onPick: async (entry) => {
        const label = formatEntry(entry);
        await setSetting("depotLat", entry.lat);
        await setSetting("depotLon", entry.lon);
        await setSetting("depotLabel", label);
        containerRef.querySelector("#s-depot-current").textContent = label;
        slot.innerHTML = "";
        showToast("Dépôt mis à jour.");
      },
      onCancel: () => {
        slot.innerHTML = "";
      },
    });
  });

  containerRef.querySelector("#s-save").addEventListener("click", async () => {
    await setSetting("navApp", containerRef.querySelector("#s-nav-app").value);
    await setSetting("autoNavAfterDeliver", containerRef.querySelector("#s-auto-nav").checked);
    // Un champ <input type="time"> vide renvoie "" : on retombe alors sur la
    // valeur par defaut plutot que d'enregistrer une heure invalide, que
    // hhmmToSec traduirait en "contrainte absente" sans rien dire.
    const heure = (sel, fallback) => containerRef.querySelector(sel).value || fallback;
    await setSetting("heureLimiteAvant12h", heure("#s-limite-avant12h", DEFAULTS.heureLimiteAvant12h));
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

  // Meme correctif que #s-auto-nav ci-dessus, applique ici aussi (bug reel
  // signale : "je choisis Waze/Google mais ca revient tout seul sur Apple
  // Plans") -- ce choix est justement celui qu'on va tester tout de suite en
  // quittant Reglages pour taper "Naviguer" sur un arret, avant meme de
  // penser a cliquer "Enregistrer" plus bas : sans sauvegarde immediate, le
  // changement etait perdu des qu'on changeait d'onglet.
  containerRef.querySelector("#s-nav-app").addEventListener("change", (e) => {
    setSetting("navApp", e.target.value);
  });

  containerRef.querySelector("#s-export-csv").addEventListener("click", async () => {
    await exportToursCsv();
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
      const colis = await saveColis({
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
      // Bug reel corrige ici : ce bouton creait le colis mais ne l'inserait
      // jamais dans une tournee deja en cours (contrairement au scan, voir
      // tour-ui.js's handleColisSaved) -- il restait "pret" hors-tournee
      // jusqu'au prochain recalcul complet, invisible entre-temps.
      const activeTour = await getActiveTour();
      if (activeTour) {
        const result = await insertStopCheapest(activeTour, colis);
        if (result) {
          await saveColis({ ...colis, statut: "en_tournee" });
          showToast(`"${favori.rue || "Favori"}" ajouté à la tournée en cours (position ${result.position}).`);
          return;
        }
      }
      showToast(`"${favori.rue || "Favori"}" ajouté aux colis à trier.`);
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
      showToast("Note enregistrée.");
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

  containerRef.querySelector("#bug-reports-toggle").addEventListener("click", () => {
    showBugReports = !showBugReports;
    render();
  });
  if (showBugReports) {
    renderBugReports(containerRef.querySelector("#bug-reports-content"));
  }
}
