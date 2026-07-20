import { getActiveTour, markStopDelivered, markStopFailed, archiveTour, moveStop, getTodayStats } from "../routing/tour-store.js";
import { getColis, saveColis, listAllColis, formatAdresseAffichage } from "../scan/colis-store.js";
import { getAllSettings } from "../settings/settings-store.js";
import { buildNavUrl } from "./deep-links.js";
import { renderSmsTemplate, smsUrl } from "./sms-template.js";
import { formatDurationShort } from "../lib/geo-utils.js";
import { runSort } from "../routing/routing-ui.js";
import { startScanFlow, startManualEntry } from "../scan/scan-ui.js";
import { renderColisDetail } from "../scan/colis-detail-ui.js";
import { insertStopCheapest } from "../routing/insert-stop.js";
import { showToast } from "../lib/toast.js";

// Ecran "Tournee" fusionne (chantier fusion Tournee/Scan) : machine a 2
// etats dans le MEME onglet/conteneur.
//   - Etat A (preparation) : pas de tournee active -> liste des colis
//     scannes + bouton "Optimiser la tournee".
//   - Etat B (execution) : tournee active -> arret courant en carte hero +
//     arrets suivants + retour depot + recalcul.
// Le detail d'un colis (fiche) est un 3e "mode" d'affichage superpose,
// atteignable depuis l'un ou l'autre etat par tap sur un item. Le bouton
// flottant camera (#scan-fab, dans le HTML statique de la vue) est visible
// dans les 2 etats et ouvre le meme flux de scan partout.

let containerRef = null;
let fabBound = false;
let view = "list"; // "list" | "detail"
let currentDetailColisId = null;
let reorderMode = false;
let filterIssuesOnly = false;
let selectedStart = "depot"; // "depot" | "gps", choix Etat A

// Etat du dernier rendu Etat B, reutilise par renderStopsList() pour
// filtrer/re-dessiner juste la liste (recherche) sans tout re-fetcher.
let lastTour = null;
let lastStopsWithColis = [];
let lastNavApp = "apple";
let lastEtas = new Map();

export async function mount(container) {
  containerRef = container;
  if (!fabBound) {
    const fab = document.getElementById("scan-fab");
    if (fab) fab.addEventListener("click", () => openScanFlow());
    fabBound = true;
  }
  view = "list";
  currentDetailColisId = null;
  await render();
}

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function updateHeader({ title, statsHtml = "", showProgress = false, progressPercent = 0 }) {
  const titleEl = document.getElementById("tour-header-title");
  const statsEl = document.getElementById("tour-header-stats");
  const progressWrap = document.getElementById("tour-header-progress");
  if (titleEl) titleEl.textContent = title;
  if (statsEl) statsEl.innerHTML = statsHtml;
  if (progressWrap) progressWrap.hidden = !showProgress;
  if (showProgress) {
    const fill = document.getElementById("tour-progress-fill");
    if (fill) fill.style.width = `${progressPercent}%`;
  }
}

function badgeForStatut(statut) {
  if (statut === "pret") return `<span class="badge badge-ok">Prêt</span>`;
  if (statut === "en_tournee") return `<span class="badge badge-ok">En tournée</span>`;
  if (statut === "echec") return `<span class="badge badge-warn">Échec</span>`;
  return `<span class="badge badge-pending">À vérifier</span>`;
}

// Apres un scan/saisie reussi (colis geocode + nomme -> "pret") : si une
// tournee est en cours, insere directement l'arret au moindre detour plutot
// que de le laisser invisible jusqu'au prochain recalcul complet.
async function handleColisSaved(colis) {
  const tour = await getActiveTour();
  if (tour && colis.statut === "pret" && colis.geocode?.status === "ok") {
    const result = await insertStopCheapest(tour, colis);
    if (result) {
      await saveColis({ ...colis, statut: "en_tournee" });
      showToast(`✓ "${colis.nom || formatAdresseAffichage(colis)}" ajouté en position ${result.position}.`);
    } else {
      showToast("Colis ajouté (sera inclus au prochain recalcul de tournée).");
    }
  }
  view = "list";
  await render();
}

function openScanFlow() {
  view = "list"; // valeur de repli si l'utilisateur annule avant la sauvegarde
  startScanFlow(containerRef, { onSaved: handleColisSaved });
}

function openManualEntry() {
  startManualEntry(containerRef, { onSaved: handleColisSaved });
}

function openDetail(colisId) {
  view = "detail";
  currentDetailColisId = colisId;
  render();
}

function closeDetail() {
  view = "list";
  currentDetailColisId = null;
  render();
}

// Toute action interne (tap sur un bouton, recherche, recalcul...) repasse
// par render() ou directement par renderEtatA()/renderEtatB() -- ces
// re-rendus internes ne sont PAS couverts par le try/catch de app.js
// (qui ne protege que le mount() initial). Un echec silencieux ici laisse
// l'ancien DOM affiche sans aucun retour visuel (deja arrive une fois, voir
// historique de discussion) : on capture donc et on affiche l'erreur au lieu
// de la laisser invisible dans la console.
async function render() {
  try {
    if (view === "detail" && currentDetailColisId) {
      updateHeader({ title: "Détail du colis", showProgress: false });
      await renderColisDetail(containerRef, currentDetailColisId, {
        onBack: closeDetail,
        onChange: () => {},
      });
      return;
    }

    const tour = await getActiveTour();
    if (!tour) {
      await renderEtatA();
    } else {
      await renderEtatB(tour);
    }
  } catch (err) {
    console.error("Erreur d'affichage de l'écran Tournée:", err);
    containerRef.innerHTML = `<div class="empty-state">Erreur d'affichage. Détail dans la console.</div>`;
  }
}

// ============================= Etat A : preparation =============================

function renderPrepCard(c) {
  const titre = c.nom || formatAdresseAffichage(c);
  return `
    <div class="card" data-colis-id="${escapeAttr(c.id)}" data-open-detail>
      <div class="card-row">
        <div class="card-title">${escapeHtml(titre)}</div>
        ${badgeForStatut(c.statut)}
      </div>
      <div class="muted">${escapeHtml(formatAdresseAffichage(c))}</div>
      <div class="stats-row">
        ${c.avant12h ? `<span class="badge badge-urgent">Avant 12h</span>` : ""}
        ${c.quantite > 1 ? `<span class="badge badge-pending">${c.quantite} colis</span>` : ""}
      </div>
    </div>
  `;
}

async function renderEtatA() {
  const [allColis, settings] = await Promise.all([listAllColis(), getAllSettings()]);
  // Tout ce qui n'est pas encore traite (livre/echec appartiennent a
  // l'historique d'une tournee precedente, pas a la preparation de la
  // prochaine) : "a_verifier" reste visible ici pour que l'utilisateur les
  // corrige avant d'optimiser.
  const prepColis = allColis.filter((c) => c.statut !== "livre" && c.statut !== "echec");
  const totalQty = prepColis.reduce((s, c) => s + (c.quantite || 1), 0);
  const issues = prepColis.filter((c) => c.statut === "a_verifier").length;

  updateHeader({
    title: "Tournée",
    statsHtml: `
      <span class="stat-pill">${totalQty} colis</span>
      <span class="stat-pill stat-pill-warn" id="etatA-issues-toggle" style="cursor:pointer;${filterIssuesOnly ? "outline:2px solid var(--warn);" : ""}">${issues} à vérifier</span>
    `,
    showProgress: false,
  });

  const visible = filterIssuesOnly ? prepColis.filter((c) => c.statut === "a_verifier") : prepColis;
  const listHtml =
    prepColis.length === 0
      ? `<div class="empty-state">Aucun colis pour l'instant. Scanne une étiquette ou ajoute une adresse à la main.</div>`
      : visible.length === 0
        ? `<div class="empty-state">Aucun colis "à vérifier".</div>`
        : visible
            .slice()
            .reverse()
            .map((c) => renderPrepCard(c))
            .join("");

  containerRef.innerHTML = `
    <div class="button-row" style="margin-bottom:14px;">
      <button type="button" id="etatA-manual">✏️ Saisie manuelle</button>
    </div>
    <div id="etatA-list">${listHtml}</div>
    <div class="card" style="margin-top:18px;">
      <div class="card-title">Départ</div>
      <div class="button-row" style="margin-top:8px;">
        <button type="button" id="etatA-start-depot" class="${selectedStart === "depot" ? "primary" : ""}">🏠 Dépôt</button>
        <button type="button" id="etatA-start-gps" class="${selectedStart === "gps" ? "primary" : ""}">📍 Ma position</button>
      </div>
      <div class="toggle-row">
        <label for="etatA-depot-return">Revenir au dépôt en fin de tournée</label>
        <input type="checkbox" id="etatA-depot-return" style="width:auto;min-height:0;" ${settings.depotReturn ? "checked" : ""}>
      </div>
      <button type="button" class="primary btn-lg" id="etatA-optimize" style="width:100%;margin-top:6px;">🚀 Optimiser la tournée</button>
      <p id="routing-status" class="muted" style="margin-top:10px;"></p>
      <div class="progress-bar"><div id="routing-progress-fill" class="progress-bar-fill" style="width:0%"></div></div>
    </div>
  `;

  containerRef.querySelector("#etatA-manual").addEventListener("click", () => openManualEntry());

  containerRef.querySelectorAll("[data-open-detail]").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.colisId));
  });

  // #etatA-issues-toggle vit dans l'en-tete (#tour-header-stats, hors de
  // containerRef -- voir updateHeader) : recherche globale, pas
  // containerRef.querySelector qui ne le trouverait jamais.
  document.getElementById("etatA-issues-toggle")?.addEventListener("click", () => {
    filterIssuesOnly = !filterIssuesOnly;
    render(); // passe par le routeur (filet de securite en cas d'echec, voir plus haut)
  });

  // Bascule directe des classes plutot qu'un re-rendu complet de l'ecran :
  // plus robuste (un choix aussi simple ne doit pas pouvoir etre bloque par
  // un souci ailleurs dans le rendu de la liste) et plus reactif.
  const startDepotBtn = containerRef.querySelector("#etatA-start-depot");
  const startGpsBtn = containerRef.querySelector("#etatA-start-gps");
  function updateStartButtons() {
    startDepotBtn.classList.toggle("primary", selectedStart === "depot");
    startGpsBtn.classList.toggle("primary", selectedStart === "gps");
  }
  startDepotBtn.addEventListener("click", () => {
    selectedStart = "depot";
    updateStartButtons();
  });
  startGpsBtn.addEventListener("click", () => {
    selectedStart = "gps";
    updateStartButtons();
  });

  containerRef.querySelector("#etatA-optimize").addEventListener("click", () => {
    const depotReturn = containerRef.querySelector("#etatA-depot-return").checked;
    const optimizeBtn = containerRef.querySelector("#etatA-optimize");
    runSort(containerRef, {
      useGps: selectedStart === "gps",
      depotReturn,
      disableButtons: [optimizeBtn],
      onDone: () => {
        view = "list";
        render();
      },
    });
  });
}

// ============================= Etat B : execution =============================

function isPending(stop) {
  return stop.statutLivraison !== "livre" && stop.statutLivraison !== "echec";
}

function formatHeure(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Heure d'arrivee estimee par arret : cumul des temps de trajet (legDureeSec,
// calcule au moment du tri) + temps moyen passe a chaque arret precedent.
// Absent sur les tournees creees avant cette fonctionnalite (legDureeSec
// undefined -> traite comme 0), et devient approximatif apres un
// reordonnancement manuel ou une insertion (les temps de trajet ne sont pas
// recalcules pour les arrets deplaces).
function computeEtas(tour, stopsSorted, dwellSec) {
  const start = new Date(tour.dateCreation).getTime();
  let cumulative = 0;
  const etas = new Map();
  for (const { stop } of stopsSorted) {
    cumulative += stop.legDureeSec || 0;
    etas.set(stop.colisId, new Date(start + cumulative * 1000));
    cumulative += dwellSec;
  }
  return etas;
}

async function promptAndMarkFailed(tourId, ordre) {
  const raison = prompt("Motif de l'échec (absent, accès impossible...) :", "");
  if (raison === null) return; // annule
  await markStopFailed(tourId, ordre, raison);
  render();
}

// Enchainement sans friction (chantier B) : appele juste apres que render()
// a affiche le NOUVEL arret courant (celui qui suit celui qu'on vient de
// livrer). Propose toujours de naviguer vers ce prochain arret (toast) et,
// si le reglage est active, ouvre directement le GPS sans tap supplementaire
// -- `render()` a deja rafraichi lastTour/lastStopsWithColis, pas besoin de
// re-interroger la base.
async function afterHeroDelivered() {
  if (!lastTour) return; // plus de tournee active (rare, ex: supprimee entre-temps)
  const heroEntry = lastStopsWithColis.find(({ stop, colis }) => isPending(stop) && colis);
  if (!heroEntry) {
    showToast("🎉 Tous les arrêts sont traités !");
    return;
  }
  const label = heroEntry.colis.nom || formatAdresseAffichage(heroEntry.colis);
  const settings = await getAllSettings();
  if (settings.autoNavAfterDeliver && heroEntry.colis.geocode?.lat != null) {
    const navUrl = buildNavUrl(settings.navApp, {
      lat: heroEntry.colis.geocode.lat,
      lon: heroEntry.colis.geocode.lon,
      label: heroEntry.colis.nom,
      adresse: formatAdresseAffichage(heroEntry.colis),
    });
    window.open(navUrl, "_blank", "noopener");
    showToast(`🧭 Direction : ${label}`);
  } else {
    showToast(`👉 Prochain arrêt : ${label}`);
  }
}

// La hero card affiche l'adresse sur 2 lignes (rue en tres grand, cp+ville
// en dessous) pour la hierarchie visuelle -- split de l'adresse canonique
// (adresseAffichage, "N Rue, CP Ville" apres geocodage) sur la 1ere virgule
// plutot que de repartir des champs bruts, pour beneficier de la correction
// de casse/completude confirmee par la BAN (voir formatAdresseAffichage).
function splitAdresseForHero(colis) {
  const full = formatAdresseAffichage(colis);
  const commaIdx = full.indexOf(",");
  if (commaIdx === -1) return { street: full, cityLine: "" };
  return { street: full.slice(0, commaIdx).trim(), cityLine: full.slice(commaIdx + 1).trim() };
}

function renderHeroCard(stop, colis, { navApp, eta, smsTemplate }) {
  const adresse = formatAdresseAffichage(colis);
  const navUrl = colis.geocode?.lat ? buildNavUrl(navApp, { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse }) : null;
  const { street, cityLine } = splitAdresseForHero(colis);
  // Minutes restantes reelles (arret courant d'une tournee active) : le seul
  // endroit ou {minutes_estimees} peut etre rempli avec une valeur fraiche
  // (recalculee a chaque render, pas figee au moment du scan).
  const minutesEstimees = eta ? Math.max(0, Math.round((eta.getTime() - Date.now()) / 60000)) : null;
  const smsHref = colis.tel
    ? smsUrl(colis.tel, renderSmsTemplate(smsTemplate, { nom: colis.nom, adresse, minutesEstimees }))
    : null;

  return `
    <div class="hero-card">
      <div class="hero-top">
        <span class="hero-eyebrow">Arrêt actuel · #${stop.ordre}</span>
        ${colis.avant12h ? '<span class="badge badge-urgent">⏰ Avant 12h</span>' : ""}
      </div>
      <div class="hero-addr" data-open-detail data-colis-id="${escapeAttr(colis.id)}">${escapeHtml(street)}</div>
      <div class="hero-city" data-open-detail data-colis-id="${escapeAttr(colis.id)}">${escapeHtml(cityLine)}</div>
      <div class="hero-meta">
        <div data-open-detail data-colis-id="${escapeAttr(colis.id)}">
          <div class="hero-name">${escapeHtml(colis.nom || "(nom inconnu — tap pour corriger)")}</div>
          <div class="hero-sub">${colis.quantite > 1 ? `${colis.quantite} colis` : "1 colis"}</div>
        </div>
      </div>
      <div class="hero-actions">
        <div class="button-row">
          ${navUrl ? `<a class="btn-link primary btn-lg" href="${navUrl}" target="_blank" rel="noopener">🧭 Naviguer</a>` : ""}
          ${colis.tel ? `<a class="btn-link btn-lg" style="flex:0 0 58px;" href="tel:${colis.tel}">📞</a>` : ""}
          ${smsHref ? `<a class="btn-link btn-lg" style="flex:0 0 58px;" href="${smsHref}">💬</a>` : ""}
        </div>
        <button type="button" class="ok btn-lg" data-deliver-ordre="${stop.ordre}" data-hero-deliver>✓ Livré</button>
        <button type="button" class="hero-fail-btn" data-fail-ordre="${stop.ordre}">Marquer en échec</button>
      </div>
    </div>
  `;
}

function renderStopCard(stop, colis, { navApp, eta, canMoveUp, canMoveDown }) {
  if (!colis) {
    return `<div class="card"><div class="muted">Colis introuvable (${escapeAttr(stop.colisId)})</div></div>`;
  }
  const delivered = stop.statutLivraison === "livre";
  const failed = stop.statutLivraison === "echec";
  const done = delivered || failed;
  const adresse = formatAdresseAffichage(colis);
  const navUrl = colis.geocode?.lat
    ? buildNavUrl(navApp, { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse })
    : null;
  let heureLabel = null;
  if (delivered) heureLabel = stop.heureLivraison ? `Livré à ${formatHeure(new Date(stop.heureLivraison))}` : "Livré";
  else if (failed) heureLabel = stop.heureEchec ? `Échec à ${formatHeure(new Date(stop.heureEchec))}` : "Échec";
  else if (eta) heureLabel = `≈ ${formatHeure(eta)}`;
  const hasPhoto = Boolean(colis.preuvePhoto);
  const reorderButtons = reorderMode
    ? `
      <div class="button-row" style="margin-top:6px;">
        <button type="button" data-move-ordre="${stop.ordre}" data-move-dir="-1" ${canMoveUp ? "" : "disabled"} aria-label="Monter">▲</button>
        <button type="button" data-move-ordre="${stop.ordre}" data-move-dir="1" ${canMoveDown ? "" : "disabled"} aria-label="Descendre">▼</button>
      </div>
    `
    : "";

  return `
    <div class="card" data-stop-card="${escapeAttr(colis.id)}" style="${done ? "opacity:0.55;" : ""}">
      <div class="card-row" data-open-detail data-colis-id="${escapeAttr(colis.id)}">
        <div class="card-title">#${stop.ordre} ${escapeHtml(colis.nom || "(nom inconnu)")}</div>
        <div style="display:flex;gap:4px;align-items:center;">
          ${heureLabel ? `<span class="badge ${failed ? "badge-warn" : "badge-pending"}">${heureLabel}</span>` : ""}
          ${colis.avant12h ? '<span class="badge badge-urgent">Avant 12h</span>' : ""}
        </div>
      </div>
      <div class="muted" data-open-detail data-colis-id="${escapeAttr(colis.id)}">${escapeHtml(adresse)}</div>
      ${failed && stop.raisonEchec ? `<div class="muted" style="margin-top:2px;">Motif : ${escapeHtml(stop.raisonEchec)}</div>` : ""}
      ${colis.quantite > 1 ? `<span class="badge badge-pending" style="margin-top:4px;">${colis.quantite} colis</span>` : ""}
      <div class="button-row">
        ${colis.tel ? `<a class="btn-link" href="tel:${colis.tel}">📞 Appeler</a>` : ""}
        ${navUrl ? `<a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener">🧭 Naviguer</a>` : ""}
        ${
          done
            ? `<button type="button" disabled>${delivered ? "Livré ✓" : "Échec"}</button>`
            : `<button type="button" class="ok" data-deliver-ordre="${stop.ordre}">Livré</button>`
        }
      </div>
      ${reorderButtons}
      <div class="button-row" style="margin-top:6px;">
        <button type="button" data-photo-colis="${escapeAttr(colis.id)}">${hasPhoto ? "📷 Photo ✓" : "📷 Photo (optionnel)"}</button>
        ${!done ? `<button type="button" class="hero-fail-btn" data-fail-ordre="${stop.ordre}">Échec</button>` : ""}
      </div>
    </div>
  `;
}

function renderDepotReturnCard(tour, navApp) {
  if (!tour.returnToDepot || !tour.depotArrivee) return "";
  const navUrl = buildNavUrl(navApp, {
    lat: tour.depotArrivee.lat,
    lon: tour.depotArrivee.lon,
    label: tour.depotArrivee.label,
    adresse: tour.depotArrivee.label,
  });
  return `
    <div class="card">
      <div class="card-title">🏠 Retour au dépôt</div>
      <div class="muted">${escapeAttr(tour.depotArrivee.label)}</div>
      <div class="button-row">
        <a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener">🧭 Naviguer</a>
      </div>
    </div>
  `;
}

function matchesFilter(colis, filterText) {
  if (!filterText) return true;
  const needle = filterText.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${colis.nom || ""} ${colis.adresseRaw?.rue || ""} ${colis.adresseRaw?.cp || ""} ${colis.adresseRaw?.ville || ""}`.toLowerCase();
  return haystack.includes(needle);
}

function bindActionEvents(tourId) {
  containerRef.querySelectorAll("[data-deliver-ordre]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const isHeroButton = btn.hasAttribute("data-hero-deliver");
      await markStopDelivered(tourId, Number(btn.dataset.deliverOrdre));
      await render();
      // Enchainement (chantier B) : uniquement depuis le bouton de l'arret
      // COURANT (hero), pas depuis la liste "a venir" -- marquer un arret
      // plus loin dans la liste n'a pas la meme semantique "je viens de
      // livrer ici, ou aller ensuite ?".
      if (isHeroButton) await afterHeroDelivered();
    });
  });

  containerRef.querySelectorAll("[data-fail-ordre]").forEach((btn) => {
    btn.addEventListener("click", () => promptAndMarkFailed(tourId, Number(btn.dataset.failOrdre)));
  });

  containerRef.querySelectorAll("[data-move-ordre]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await moveStop(tourId, Number(btn.dataset.moveOrdre), Number(btn.dataset.moveDir));
      render();
    });
  });

  containerRef.querySelectorAll("[data-open-detail]").forEach((el) => {
    el.addEventListener("click", () => openDetail(el.dataset.colisId));
  });

  containerRef.querySelectorAll("[data-photo-colis]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const { openCamera } = await import("../scan/capture.js");
        const file = await openCamera();
        const colis = await getColis(btn.dataset.photoColis);
        if (!colis) return;
        colis.preuvePhoto = file;
        await saveColis(colis);
        showToast("📷 Photo de preuve enregistrée.");
        render();
      } catch (err) {
        if (err.message !== "Aucune photo sélectionnée.") console.error(err);
      }
    });
  });
}

function renderStopsList(filterText) {
  const stopsContainer = containerRef.querySelector("#stops-container");
  if (!stopsContainer) return;

  const heroColisId = stopsContainer.dataset.heroColisId || null;
  // Un arret orphelin (colis supprime entre-temps) reste toujours visible --
  // pas de champ a filtrer dessus, et le masquer silencieusement cacherait
  // une incoherence de donnees plutot que de la signaler.
  const filtered = lastStopsWithColis.filter(
    ({ stop, colis }) => stop.colisId !== heroColisId && (!colis || matchesFilter(colis, filterText))
  );
  const pendingOrdered = lastStopsWithColis.filter(({ stop }) => isPending(stop)).map((s) => s.stop.ordre);

  stopsContainer.innerHTML =
    filtered.length === 0
      ? `<div class="empty-state">${filterText ? `Aucun arrêt ne correspond à "${escapeHtml(filterText)}".` : "Tous les autres arrêts sont traités."}</div>`
      : filtered
          .map(({ stop, colis }) => {
            const posInPending = pendingOrdered.indexOf(stop.ordre);
            const canMoveUp = posInPending > 0;
            const canMoveDown = posInPending !== -1 && posInPending < pendingOrdered.length - 1;
            return renderStopCard(stop, colis, {
              navApp: lastNavApp,
              eta: colis ? lastEtas.get(colis.id) : null,
              canMoveUp,
              canMoveDown,
            });
          })
          .join("");

  bindActionEvents(lastTour.id);
}

async function renderEtatB(tour) {
  const [settings, todayStats] = await Promise.all([getAllSettings(), getTodayStats()]);
  const navApp = settings.navApp;
  const stopsWithColis = await Promise.all(
    tour.stops
      .slice()
      .sort((a, b) => a.ordre - b.ordre)
      .map(async (stop) => ({ stop, colis: await getColis(stop.colisId) }))
  );

  lastTour = tour;
  lastStopsWithColis = stopsWithColis;
  lastNavApp = navApp;
  lastEtas = computeEtas(tour, stopsWithColis, (settings.dureeArretMinutes || 0) * 60);

  const delivered = stopsWithColis.filter((s) => s.stop.statutLivraison === "livre").length;
  const failed = stopsWithColis.filter((s) => s.stop.statutLivraison === "echec").length;
  const total = stopsWithColis.length;

  updateHeader({
    title: "Ma tournée",
    showProgress: true,
    progressPercent: total === 0 ? 0 : Math.round(((delivered + failed) / total) * 100),
  });

  const heroEntry = stopsWithColis.find(({ stop, colis }) => isPending(stop) && colis);
  const heroHtml = heroEntry
    ? renderHeroCard(heroEntry.stop, heroEntry.colis, { navApp, eta: lastEtas.get(heroEntry.colis.id), smsTemplate: settings.smsTemplate })
    : `<div class="card"><div class="card-title">🎉 Tournée traitée</div><p class="muted">${delivered} livré${delivered > 1 ? "s" : ""}${failed > 0 ? `, ${failed} échec${failed > 1 ? "s" : ""}` : ""}. Plus aucun arrêt en attente.</p></div>`;

  containerRef.innerHTML = `
    <div class="card">
      <div class="card-row">
        <span class="muted">${delivered + failed}/${total} traités</span>
        <span class="muted">${formatDurationShort(tour.totalDureeSec)} estimées</span>
      </div>
    </div>
    ${heroHtml}
    <div class="card">
      <div class="card-title">Aujourd'hui</div>
      <div class="stats-row" style="flex-wrap:wrap;">
        <span class="stat-pill">${todayStats.livres} livré${todayStats.livres > 1 ? "s" : ""}</span>
        ${todayStats.echecs > 0 ? `<span class="stat-pill stat-pill-warn">${todayStats.echecs} échec${todayStats.echecs > 1 ? "s" : ""}</span>` : ""}
        <span class="stat-pill">${todayStats.toursCount} tournée${todayStats.toursCount > 1 ? "s" : ""}</span>
        <span class="stat-pill">${formatDurationShort(todayStats.dureeEstimeeSec)} estimées</span>
      </div>
    </div>
    <div class="card-row" style="margin:4px 0 10px;">
      <div class="field" style="margin-bottom:0;flex:1;">
        <input type="search" id="tour-search" placeholder="🔍 Rechercher un arrêt…">
      </div>
      <button type="button" id="reorder-toggle" style="margin-left:8px;flex-shrink:0;">${reorderMode ? "✓ Terminé" : "↕️ Réordonner"}</button>
    </div>
    ${total > 0 ? `<p class="muted" style="margin:-4px 0 10px;">Horaires estimés à titre indicatif — recalcule la tournée après un réarrangement pour des horaires exacts.</p>` : ""}
    <div id="stops-container" data-hero-colis-id="${heroEntry ? escapeAttr(heroEntry.colis.id) : ""}"></div>
    ${renderDepotReturnCard(tour, navApp)}
    <div class="button-row">
      <button type="button" class="danger" id="recalc-tour-btn">Recalculer la tournée</button>
    </div>
  `;

  bindActionEvents(tour.id); // branche aussi les actions de la hero card
  renderStopsList("");

  containerRef.querySelector("#tour-search").addEventListener("input", (e) => {
    renderStopsList(e.target.value);
  });

  containerRef.querySelector("#reorder-toggle").addEventListener("click", () => {
    reorderMode = !reorderMode;
    render(); // passe par le routeur (filet de securite en cas d'echec, voir plus haut)
  });

  containerRef.querySelector("#recalc-tour-btn").addEventListener("click", async () => {
    if (!confirm("Recalculer la tournée ? Les arrêts déjà traités restent acquis, les autres seront re-triés (colis en attente inclus).")) return;
    await archiveTour(tour.id);
    reorderMode = false;
    render();
  });
}
