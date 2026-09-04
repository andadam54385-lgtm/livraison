import { getActiveTour, markStopDelivered, markStopFailed, archiveTour, moveStop, reverseRemainingStops, getTodayStats, reporterColisEchec, finDeJournee, listSecteursConnus } from "../routing/tour-store.js";
import { getColis, saveColis, listAllColis, deleteColis, formatAdresseAffichage, formatAdresseForNav, verbeAction } from "../scan/colis-store.js";
import { getAllSettings } from "../settings/settings-store.js";
import { buildNavUrl } from "./deep-links.js";
import { buildSmsOptions } from "./sms-template.js";
import { formatDurationShort } from "../lib/geo-utils.js";
import { runSort, runRecalculate } from "../routing/routing-ui.js";
import { startScanFlow, startManualEntry } from "../scan/scan-ui.js";
import { startBatchScan } from "../scan/batch-scan-ui.js";
import { renderColisDetail, saveFavoriInfo } from "../scan/colis-detail-ui.js";
import { findNearbyFavori } from "../favoris/favoris-store.js";
import { horairesOf } from "../favoris/horaires.js";
import { renderHorairesEditor } from "../favoris/horaires-ui.js";
import { insertStopCheapest } from "../routing/insert-stop.js";
import { showToast } from "../lib/toast.js";
import { escapeHtml, escapeAttr } from "../lib/escape.js";
import { icon } from "../ui/icons.js";
import { ensureMap, refreshMapData, isMapMounted } from "../map/map-ui.js";
import { on } from "../lib/event-bus.js";
import { reportBug } from "../debug/bug-reports-store.js";

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
// Mode selection de l'Etat A (retour terrain : "des fois on en enleve juste
// avant de partir") : cases a cocher sur les cartes de preparation +
// recherche pour retrouver vite un colis dans une longue liste. L'ensemble
// vit ici (pas dans le DOM) pour survivre aux re-rendus declenches par la
// frappe dans le champ de recherche.
let selectionMode = false;
let selectedIds = new Set();
let prepFilterText = "";
let selectedStart = "depot"; // "depot" | "gps", choix Etat A

// Etat du dernier rendu Etat B, reutilise par renderStopsList() pour
// filtrer/re-dessiner juste la liste (recherche) sans tout re-fetcher.
let lastTour = null;
let lastStopsWithColis = [];
// Etat des deux sections repliables de la liste d'arrets (Etat B), memorise
// pour la session : "la liste des points doit etre un menu deroulant qui reste
// sur le dernier point a faire" (retour terrain). Repliees au depart, l'arret
// courant (hero card) reste seul sous les yeux ; ouvertes une fois par le
// livreur, elles le restent d'un rendu a l'autre (chaque livraison re-rend).
let suivantsOuverts = false;
let traitesOuverts = false;
let lastNavApp = "apple";
let lastEtas = new Map();
let lastDepotEta = null;

export async function mount(container) {
  containerRef = container;
  if (!fabBound) {
    const fab = document.getElementById("scan-fab");
    if (fab) fab.addEventListener("click", () => openScanFlow());
    // Fusion Carte + Tournee : chrome statique de #tour-view, lie une seule
    // fois (comme le FAB) -- ces elements survivent a tous les renders.
    const settingsBtn = document.getElementById("tour-settings-btn");
    settingsBtn.innerHTML = icon("settings", { spaced: false, size: 20 });
    settingsBtn.addEventListener("click", () => { location.hash = "#settings"; });
    // Recalcul dans le header (retour terrain : "a cote de Reglages en
    // haut") : toujours accessible sans deplier la feuille. Visible en Etat
    // B uniquement (voir render()) ; le retour visuel (statut + barre de
    // progression) reste DANS la feuille, la ou l'oeil suit la liste.
    const recalcBtn = document.getElementById("tour-recalc-btn");
    recalcBtn.innerHTML = icon("rotate-ccw", { spaced: false, size: 20 });
    recalcBtn.addEventListener("click", () => {
      if (recalcBtn.disabled || !lastTour) return;
      runRecalculate(containerRef, {
        tour: lastTour,
        disableButtons: [recalcBtn],
        onDone: () => {
          reorderMode = false;
          render();
        },
      });
    });
    sheetControl = setupTourSheet();
    // Tap sur un point de la carte -> la feuille s'ouvre et defile jusqu'a
    // la carte du colis (voir l'emit dans map-ui.js). Bind unique, comme le
    // FAB : l'ecouteur survit a tous les renders.
    on("map:stop-tap", (e) => focusColisInSheet(e.detail?.colisId));
    fabBound = true;
  }
  view = "list";
  currentDetailColisId = null;
  await render();
}

// ============== Fusion Carte + Tournee : chrome carte/feuille ==============

// Retour terrain (2026-09-01) : la carte est le fond PERMANENT de l'ecran,
// preparation comprise -- la liste (preparation ou tournee) vit dans la
// feuille du bas dans les deux etats. L'ancien mode "overlay" (carte plein
// ecran a la demande avec bouton X) a ete supprime : c'est lui qui a piege
// l'utilisateur ("je n'arrive pas a retourner dans la liste"), et il n'a
// plus de raison d'etre quand la carte est toujours visible.
let mapChromeReady = false;
let sheetControl = null;

function applyMapChrome() {
  if (mapChromeReady) return;
  mapChromeReady = true;
  document.getElementById("tour-view").classList.add("map-backdrop");
  document.getElementById("tour-map-slot").hidden = false;
  document.getElementById("tour-sheet-handle").hidden = false;
}

// Ouvre la feuille (si repliee) et met la carte du colis en evidence --
// cible les trois formes possibles : carte d'arret (Etat B), carte de
// preparation (Etat A), et la hero card (l'arret courant n'a pas de carte
// dans la liste, on remonte alors en haut de la feuille).
function focusColisInSheet(colisId) {
  if (!colisId) return;
  const sheet = document.getElementById("tour-sheet");
  if (sheet.dataset.state === "collapsed") sheetControl?.applyState("half");
  setTimeout(() => {
    const el =
      containerRef.querySelector(`[data-stop-card="${colisId}"]`) ||
      containerRef.querySelector(`.prep-card[data-colis-id="${colisId}"]`) ||
      (containerRef.querySelector(`.hero-card [data-colis-id="${colisId}"]`) ? containerRef.querySelector(".hero-card") : null);
    if (!el) return;
    // La carte peut vivre dans une section repliee (voir renderStopsList) :
    // scrollIntoView n'y fait rien, un element non affiche n'a pas de
    // position -- "la selection d'un point sur la carte ne marche plus
    // toujours" (retour terrain, juste apres l'arrivee des sections). On
    // ouvre la section, et on le memorise comme si le livreur l'avait fait.
    const section = el.closest("details.stops-section");
    if (section && !section.open) {
      section.open = true;
      if (section.dataset.section === "suivants") suivantsOuverts = true;
      else if (section.dataset.section === "traites") traitesOuverts = true;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("flash-target");
    setTimeout(() => el.classList.remove("flash-target"), 2600);
  }, 260); // laisse la feuille finir sa transition avant de defiler
}

// Feuille coulissante de l'Etat B : memes crans que l'ancienne liste
// d'arrets de l'ecran Carte (collapsed/half/full), poignee statique.
const TOUR_SHEET_STATES = { collapsed: 88, half: 0.48, full: 0.88 };

function setupTourSheet() {
  const sheet = document.getElementById("tour-sheet");
  const handle = document.getElementById("tour-sheet-handle");
  const heightFor = (name) =>
    name === "collapsed" ? TOUR_SHEET_STATES.collapsed : Math.round(window.innerHeight * TOUR_SHEET_STATES[name]);
  let state = "half";
  let dragStartY = null;
  let dragStartHeight = null;
  let lastDy = 0;

  function applyState(name, animate = true) {
    state = name;
    sheet.style.transition = animate ? "height 0.22s var(--ease)" : "none";
    sheet.style.height = `${heightFor(name)}px`;
    sheet.dataset.state = name;
  }

  const ORDER = ["collapsed", "half", "full"];
  function stepFrom(name, dir) {
    const i = Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(name) + dir));
    return ORDER[i];
  }
  function nearestState(height) {
    let best = "collapsed";
    let bestDist = Infinity;
    for (const name of ORDER) {
      const d = Math.abs(height - heightFor(name));
      if (d < bestDist) {
        bestDist = d;
        best = name;
      }
    }
    return best;
  }

  // Bug reel remonte du terrain ("je n'arrive pas a retourner dans la
  // liste") : l'ancien seuil de 4px transformait CHAQUE tap en glissement --
  // un doigt qui tape bouge toujours de quelques pixels, contrairement a une
  // souris. Le tap ne cyclait donc jamais les crans, et un glissement court
  // retombait au cran le plus proche (celui de depart) : feuille repliee =
  // feuille morte. Deux remedes, tous deux appliques aussi a la liste
  // interne de la carte (setupStopPanelSheet, meme defaut) :
  // - tap = mouvement total < 12px, et il OUVRE (jamais ne replie) ;
  // - un glissement franc (>= 24px) va TOUJOURS au cran suivant dans le sens
  //   du geste, meme s'il est court -- plus de retour elastique au depart.
  handle.addEventListener("pointerdown", (e) => {
    dragStartY = e.clientY;
    dragStartHeight = sheet.getBoundingClientRect().height;
    lastDy = 0;
    sheet.style.transition = "none";
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (dragStartY === null) return;
    lastDy = dragStartY - e.clientY; // >0 = geste vers le haut
    const h = Math.min(heightFor("full"), Math.max(heightFor("collapsed"), dragStartHeight + lastDy));
    sheet.style.height = `${h}px`;
  });
  function endDrag() {
    if (dragStartY === null) return;
    dragStartY = null;
    if (Math.abs(lastDy) < 12) {
      // Tap : deplie d'un cran (une feuille deja pleine reste pleine -- le
      // repli, geste volontaire, se fait en tirant vers le bas).
      applyState(stepFrom(state, 1));
    } else if (Math.abs(lastDy) >= 24) {
      applyState(stepFrom(state, lastDy > 0 ? 1 : -1));
    } else {
      applyState(nearestState(sheet.getBoundingClientRect().height));
    }
  }
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  return {
    applyState,
    reset() {
      // Hors mode backdrop la feuille redevient un simple conteneur en flux
      // (display:contents via CSS) : la hauteur inline doit disparaitre.
      sheet.style.height = "";
      sheet.style.transition = "";
      delete sheet.dataset.state;
      state = "half";
    },
  };
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
  return `<span class="badge badge-check">${icon("alert-triangle", { spaced: false, size: 12, style: "margin-right:4px;" })}À vérifier</span>`;
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
      showToast(`"${colis.nom || formatAdresseAffichage(colis)}" ajouté en position ${result.position}.`);
    } else {
      showToast("Colis ajouté (sera inclus au prochain recalcul de tournée).");
    }
  }
  view = "list";
  await render();
}

function openScanFlow() {
  sheetControl?.applyState("full");
  view = "list"; // valeur de repli si l'utilisateur annule avant la sauvegarde
  // onCancelled : sans ca, "Annuler" pendant le scan laissait l'ecran
  // bloque sur le viseur camera mort -- voir startScanFlow(onCancelled)
  // dans scan-ui.js pour le detail du bug corrige.
  startScanFlow(containerRef, { onSaved: handleColisSaved, onCancelled: () => render() });
}

function openManualEntry() {
  sheetControl?.applyState("full");
  startManualEntry(containerRef, { onSaved: handleColisSaved });
}

// Meme insertion-au-moindre-detour que handleColisSaved, mais pour tout un
// lot d'un coup (scan en rafale, voir batch-scan-ui.js) -- un seul toast
// recapitulatif et un seul rendu final plutot que de repeter les deux N
// fois, potentiellement inutile/couteux pour une dizaine de colis d'un coup.
async function handleColisSavedBatch(colisList) {
  view = "list";
  if (colisList.length === 0) {
    await render();
    return;
  }
  const tour = await getActiveTour();
  let inserted = 0;
  for (const colis of colisList) {
    if (tour && colis.statut === "pret" && colis.geocode?.status === "ok") {
      const result = await insertStopCheapest(tour, colis);
      if (result) {
        await saveColis({ ...colis, statut: "en_tournee" });
        inserted++;
      }
    }
  }
  showToast(
    `${colisList.length} colis enregistré${colisList.length > 1 ? "s" : ""}` +
      (inserted > 0 ? `, ${inserted} ajouté${inserted > 1 ? "s" : ""} à la tournée en cours.` : ".")
  );
  await render();
}

function openBatchScan() {
  sheetControl?.applyState("full");
  view = "list";
  startBatchScan(containerRef).then(handleColisSavedBatch, () => render()); // annulation : juste revenir a la liste
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
      // La fiche s'ouvre dans la feuille : la deplier, sinon le detail se
      // lit par le trou d'une feuille a mi-course.
      sheetControl?.applyState("full");
      updateHeader({ title: "Détail du colis", showProgress: false });
      await renderColisDetail(containerRef, currentDetailColisId, {
        onBack: closeDetail,
        onChange: () => {},
      });
      return;
    }

    const firstChrome = !mapChromeReady;
    applyMapChrome();
    if (firstChrome) sheetControl?.applyState("half", false);

    const tour = await getActiveTour();
    const headerRecalc = document.getElementById("tour-recalc-btn");
    if (headerRecalc) headerRecalc.hidden = !tour || view === "detail";
    if (!tour) {
      await renderEtatA();
    } else {
      await renderEtatB(tour);
    }
    // Fond de carte : cree au premier rendu, ensuite simple setData/resize
    // -- l'instance MapLibre persiste (slot statique, jamais reecrit).
    // Dans son PROPRE try/catch : un echec de la carte ne doit JAMAIS
    // emporter la liste (bug reel : "Erreur d'affichage" plein ecran sur
    // l'appareil alors que la preparation elle-meme n'avait rien). L'erreur
    // est quand meme capturee dans le journal de bugs pour diagnostic.
    try {
      await ensureMap(document.getElementById("tour-map-slot"), "backdrop");
      // Et toute mutation qui vient de re-rendre l'ecran (scan, livraison,
      // echec, insertion, recalcul) doit se refleter sur la carte.
      if (isMapMounted()) await refreshMapData();
    } catch (mapErr) {
      console.error("Erreur carte (liste conservee):", mapErr);
      reportBug({ type: "auto", message: mapErr.message || String(mapErr), stack: mapErr.stack, context: "tour-ui render() carte" }).catch(() => {});
    }
  } catch (err) {
    console.error("Erreur d'affichage de l'écran Tournée:", err);
    reportBug({ type: "auto", message: err.message || String(err), stack: err.stack, context: "tour-ui render()" }).catch(() => {});
    containerRef.innerHTML = `<div class="empty-state">Erreur d'affichage. Détail dans la console.</div>`;
  }
}

// ============================= Etat A : preparation =============================

function renderPrepCard(c) {
  const adresse = formatAdresseAffichage(c);
  // Sans nom, le titre valait l'adresse et la ligne muted etait supprimee pour
  // ne pas la dupliquer -- correct sur le fond, mais la carte perdait sa 2e
  // ligne et la liste "sautait" d'une hauteur a l'autre, en promettant en plus
  // une adresse en gras comme si c'etait un nom. Repli neutre a la place :
  // structure identique pour tous les colis, adresse toujours a la meme place.
  // Un nom manquant n'est PAS une erreur (voir CLAUDE.md : statut "pret" =
  // geocodage OK, point final), d'ou un repli discret et pas une alerte.
  const titreHtml = c.nom
    ? `<div class="card-title">${escapeHtml(c.nom)}</div>`
    : `<div class="card-title card-title-empty">Sans nom</div>`;
  // La rangee de badges n'est rendue que si elle a quelque chose a montrer :
  // vide, elle ajoutait quand meme sa marge a CHAQUE carte de la liste.
  const badges = [
    c.avant12h ? `<span class="badge badge-urgent">Avant 12h</span>` : "",
    // Purement informatifs (choix explicite) : savoir en preparant que c'est
    // un pro ou une ramasse change ce a quoi on s'attend en arrivant.
    c.operation === "ramasse" ? `<span class="badge badge-info">Ramasse</span>` : "",
    c.typeClient === "pro" ? `<span class="badge badge-info">Pro</span>` : "",
    c.quantite > 1 ? `<span class="badge badge-pending">${c.quantite} colis</span>` : "",
  ].join("");
  // En mode selection, la carte NE s'ouvre plus au tap (data-open-detail
  // retire) : le tap coche/decoche, sinon impossible de cocher sans partir
  // dans la fiche a chaque fois.
  if (selectionMode) {
    const checked = selectedIds.has(c.id);
    return `
      <div class="card prep-card${checked ? " prep-card-selected" : ""}" data-select-colis="${escapeAttr(c.id)}">
        <div class="card-row">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <span class="prep-check">${checked ? icon("check", { spaced: false, size: 14 }) : ""}</span>
            ${titreHtml}
          </div>
          ${badgeForStatut(c.statut)}
        </div>
        <div class="muted prep-card-addr" style="padding-left:26px;">${escapeHtml(adresse)}</div>
      </div>
    `;
  }
  return `
    <div class="card prep-card" data-colis-id="${escapeAttr(c.id)}" data-open-detail>
      <div class="card-row">
        ${titreHtml}
        ${badgeForStatut(c.statut)}
      </div>
      <div class="muted prep-card-addr">${escapeHtml(adresse)}</div>
      ${badges ? `<div class="stats-row prep-card-badges">${badges}</div>` : ""}
    </div>
  `;
}

// Chantier F : un colis en echec (absent, acces impossible...) ne doit pas
// simplement disparaitre de la vue -- sans ca, le report au lendemain
// depend de la memoire du livreur plutot que de l'appli.
function renderEchecCard(c) {
  const titre = c.nom || formatAdresseAffichage(c);
  return `
    <div class="card" style="border-color:var(--warn);">
      <div class="card-row">
        <div class="card-title" data-colis-id="${escapeAttr(c.id)}" data-open-detail>${escapeHtml(titre)}</div>
        <span class="badge badge-warn">Échec</span>
      </div>
      <div class="muted" data-colis-id="${escapeAttr(c.id)}" data-open-detail>${escapeHtml(formatAdresseAffichage(c))}</div>
      <button type="button" class="ok" style="margin-top:8px;width:100%;" data-report-colis="${escapeAttr(c.id)}">${icon("rotate-ccw")}Reporter à cette tournée</button>
    </div>
  `;
}

async function renderEtatA() {
  const [allColis, settings] = await Promise.all([listAllColis(), getAllSettings()]);
  // Tout ce qui n'est pas encore traite (livre appartient a l'historique
  // d'une tournee precedente, pas a la preparation de la prochaine) :
  // "a_verifier" reste visible ici pour que l'utilisateur les corrige avant
  // d'optimiser. "echec" est affiche a part (voir echecColis) avec un bouton
  // de report explicite plutot que de se re-fondre silencieusement ici.
  const prepColis = allColis.filter((c) => c.statut !== "livre" && c.statut !== "echec");
  const echecColis = allColis.filter((c) => c.statut === "echec");
  const totalQty = prepColis.reduce((s, c) => s + (c.quantite || 1), 0);
  const issues = prepColis.filter((c) => c.statut === "a_verifier").length;

  updateHeader({
    title: "Tournée",
    statsHtml: `
      <span class="stat-pill">${totalQty} colis</span>
      <span class="stat-pill stat-pill-check" id="etatA-issues-toggle" style="cursor:pointer;${filterIssuesOnly ? "outline:2px solid var(--text-muted);" : ""}">${issues} à vérifier</span>
    `,
    showProgress: false,
  });

  const sheetLabelA = document.getElementById("tour-sheet-label");
  if (sheetLabelA) sheetLabelA.textContent = totalQty > 0 ? `${totalQty} colis à préparer` : "Préparation";

  const visible = (filterIssuesOnly ? prepColis.filter((c) => c.statut === "a_verifier") : prepColis).filter((c) =>
    matchesFilter(c, prepFilterText)
  );
  // Purge les ids disparus (colis supprimes/livres entre deux rendus) pour
  // que le compteur de selection ne mente jamais.
  const visibleIds = new Set(prepColis.map((c) => c.id));
  selectedIds = new Set([...selectedIds].filter((id) => visibleIds.has(id)));
  const listHtml =
    prepColis.length === 0
      ? `<div class="empty-state">Aucun colis pour l'instant. Scanne une étiquette ou ajoute une adresse à la main.</div>`
      : visible.length === 0
        ? `<div class="empty-state">${prepFilterText ? `Aucun colis ne correspond à "${escapeHtml(prepFilterText)}".` : 'Aucun colis "à vérifier".'}</div>`
        : visible
            .slice()
            .reverse()
            .map((c) => renderPrepCard(c))
            .join("");

  containerRef.innerHTML = `
    <div class="button-row" style="margin-bottom:14px;">
      <button type="button" class="btn-compact" id="etatA-manual">${icon("pencil")}Saisie manuelle</button>
      <button type="button" class="btn-compact" id="etatA-batch-scan">${icon("camera")}Scanner une liste</button>
    </div>
    ${
      echecColis.length > 0
        ? `
      <div class="card-title" style="margin:4px 0 8px;">Non livrés (${echecColis.length}) — à reporter ?</div>
      <div id="etatA-echec-list">${echecColis.map((c) => renderEchecCard(c)).join("")}</div>
    `
        : ""
    }
    <div class="card" style="margin-bottom:14px;">
      <div class="card-title">Départ</div>
      <div class="button-row" style="margin-top:8px;">
        <button type="button" id="etatA-start-depot" class="${selectedStart === "depot" ? "primary" : ""}">${icon("home")}Dépôt</button>
        <button type="button" id="etatA-start-gps" class="${selectedStart === "gps" ? "primary" : ""}">${icon("map-pin")}Ma position</button>
      </div>
      <div class="toggle-row">
        <label for="etatA-depot-return">Revenir au dépôt en fin de tournée</label>
        <input type="checkbox" id="etatA-depot-return" style="width:auto;min-height:0;" ${settings.depotReturn ? "checked" : ""}>
      </div>
      <button type="button" class="primary btn-lg" id="etatA-optimize" style="width:100%;margin-top:6px;">${icon("zap")}Optimiser la tournée</button>
      <p id="routing-status" class="muted" style="margin-top:10px;"></p>
      <div class="progress-bar"><div id="routing-progress-fill" class="progress-bar-fill" style="width:0%"></div></div>
    </div>
    <div class="button-row" style="margin:0 0 8px;">
      <input type="search" id="etatA-search" placeholder="Rechercher un colis..." value="${escapeAttr(prepFilterText)}" style="flex:1;min-height:38px;">
      <button type="button" class="btn-compact" id="etatA-select-toggle" style="flex:0 0 auto;">${icon(selectionMode ? "x" : "check")}${selectionMode ? "Annuler" : "Sélectionner"}</button>
    </div>
    ${
      selectionMode
        ? `
      <div class="card" style="margin-bottom:8px;">
        <div class="card-row">
          <span class="muted">${selectedIds.size} sélectionné${selectedIds.size > 1 ? "s" : ""}</span>
          <button type="button" class="btn-compact" id="etatA-select-all" style="flex:0 0 auto;">${selectedIds.size === visible.length && visible.length > 0 ? "Tout décocher" : "Tout cocher"}</button>
        </div>
        <div class="button-row" style="margin-top:8px;">
          <button type="button" class="danger" id="etatA-delete-selected" ${selectedIds.size === 0 ? "disabled" : ""}>${icon("trash-2")}Supprimer (${selectedIds.size})</button>
        </div>
        <button type="button" class="hero-fail-btn" id="etatA-delete-all" style="margin-top:2px;">Supprimer TOUS les colis en préparation (${prepColis.length})</button>
      </div>`
        : ""
    }
    <div id="etatA-list">${listHtml}</div>
  `;

  // --- Recherche : re-rend la liste sans perdre le focus ni le curseur
  const searchEl = containerRef.querySelector("#etatA-search");
  if (searchEl) {
    searchEl.addEventListener("input", async () => {
      const pos = searchEl.selectionStart;
      prepFilterText = searchEl.value;
      await renderEtatA();
      const next = containerRef.querySelector("#etatA-search");
      if (next) {
        next.focus();
        next.setSelectionRange(pos, pos);
      }
    });
  }

  containerRef.querySelector("#etatA-select-toggle")?.addEventListener("click", async () => {
    selectionMode = !selectionMode;
    selectedIds = new Set();
    await renderEtatA();
  });

  containerRef.querySelectorAll("[data-select-colis]").forEach((card) => {
    card.addEventListener("click", async () => {
      const id = card.dataset.selectColis;
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      await renderEtatA();
    });
  });

  containerRef.querySelector("#etatA-select-all")?.addEventListener("click", async () => {
    const ids = [...containerRef.querySelectorAll("[data-select-colis]")].map((el) => el.dataset.selectColis);
    const toutCoche = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    if (toutCoche) ids.forEach((id) => selectedIds.delete(id));
    else ids.forEach((id) => selectedIds.add(id));
    await renderEtatA();
  });

  // Tout supprimer, depuis le mode selection (retour terrain "un bouton
  // supprimer tous les colis au cas ou") : ne touche QUE la preparation --
  // les tournees archivees, l'historique et les favoris restent intacts,
  // contrairement au "Effacer tous les colis et tournees" des Reglages.
  containerRef.querySelector("#etatA-delete-all")?.addEventListener("click", async () => {
    const n = prepColis.length;
    if (n === 0) return;
    if (!confirm(`Supprimer les ${n} colis en préparation ? L'historique des journées et les favoris ne sont pas touchés.`)) return;
    for (const c of prepColis) await deleteColis(c.id);
    selectedIds = new Set();
    selectionMode = false;
    prepFilterText = "";
    showToast(`${n} colis supprimé${n > 1 ? "s" : ""}.`);
    await render();
  });

  containerRef.querySelector("#etatA-delete-selected")?.addEventListener("click", async () => {
    const n = selectedIds.size;
    if (n === 0) return;
    if (!confirm(`Supprimer ${n} colis ? Cette action est irréversible.`)) return;
    for (const id of selectedIds) await deleteColis(id);
    selectedIds = new Set();
    selectionMode = false;
    showToast(`${n} colis supprimé${n > 1 ? "s" : ""}.`);
    await render();
  });

  containerRef.querySelector("#etatA-manual").addEventListener("click", () => openManualEntry());
  containerRef.querySelector("#etatA-batch-scan").addEventListener("click", () => openBatchScan());

  containerRef.querySelectorAll("[data-report-colis]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await reporterColisEchec(btn.dataset.reportColis);
      showToast("Colis remis dans la préparation de tournée.");
      render();
    });
  });

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

// Une date invalide arrive des que la matrice de trajets contient un Infinity
// (deux points que le graphe routier ne relie pas, ou au-dela du plafond de
// buildTravelTimeMatrix) : le cumul devient Infinity et new Date(...) est
// invalide. Sans ce garde-fou, l'en-tete affichait litteralement
// "Fin = Invalid Date". formatDurationShort faisait deja ce repli de son cote.
function formatHeure(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function heureConnue(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

// Heure d'arrivee estimee par arret : cumul des temps de trajet (legDureeSec,
// calcule au moment du tri) + temps moyen passe a chaque arret precedent, a
// partir du dernier arret REELLEMENT valide (livre/echec) plutot que de la
// creation de la tournee -- un livreur en avance ou en retard sur le plan
// initial doit voir des heures qui suivent son rythme reel, pas figees au
// moment du tri. Sans arret encore valide, repli sur la creation de la
// tournee (premier depart). Absent sur les tournees creees avant cette
// fonctionnalite (legDureeSec undefined -> traite comme 0), et devient
// approximatif apres un reordonnancement manuel ou une insertion (les temps
// de trajet ne sont pas recalcules pour les arrets deplaces).
// Retourne aussi l'heure d'arrivee estimee au depot (retour en fin de
// tournee) quand applicable : le trajet retour n'est pas un "arret" au sens
// stops[], son temps de trajet se deduit de totalDureeSec (qui inclut TOUS
// les troncons, y compris le retour) moins la somme des troncons deja
// comptes pour les arrets -- voir routing-ui.js ou `legs` est calcule.
function computeEtas(tour, stopsSorted, dwellSec) {
  let anchorTime = new Date(tour.dateCreation).getTime();
  let anchorIndex = -1;
  stopsSorted.forEach(({ stop }, i) => {
    const isTraite = stop.statutLivraison === "livre" || stop.statutLivraison === "echec";
    if (!isTraite) return;
    const heure = stop.heureLivraison || stop.heureEchec;
    if (heure) {
      anchorTime = new Date(heure).getTime();
      anchorIndex = i;
    }
  });

  let cumulative = 0;
  const etas = new Map();
  for (let i = anchorIndex + 1; i < stopsSorted.length; i++) {
    const { stop } = stopsSorted[i];
    cumulative += stop.legDureeSec || 0;
    etas.set(stop.colisId, new Date(anchorTime + cumulative * 1000));
    cumulative += dwellSec;
  }

  let depotEta = null;
  if (tour.returnToDepot) {
    const sumStopLegs = stopsSorted.reduce((s, { stop }) => s + (stop.legDureeSec || 0), 0);
    const returnLegSec = Math.max(0, (tour.totalDureeSec || 0) - sumStopLegs);
    depotEta = new Date(anchorTime + (cumulative + returnLegSec) * 1000);
  }

  return { etas, depotEta };
}

// Heure de fin de tournee estimee, affichee en haut de l'ecran (retour
// terrain : "on ne voit pas comment on avance") -- avec retour au depot,
// c'est la vraie fin de journee (depotEta) ; sinon, l'heure d'arrivee au
// DERNIER arret par ordre (deja calculee par computeEtas), ou son heure
// reelle si ce dernier arret est deja traite (tournee sur le point de finir).
function computeFinEstimee(tour, stopsSorted, etas, depotEta) {
  if (tour.returnToDepot && depotEta) return depotEta;
  const lastEntry = stopsSorted[stopsSorted.length - 1];
  if (!lastEntry) return null;
  const { stop, colis } = lastEntry;
  if (stop.statutLivraison === "livre") return stop.heureLivraison ? new Date(stop.heureLivraison) : null;
  if (stop.statutLivraison === "echec") return stop.heureEchec ? new Date(stop.heureEchec) : null;
  return colis ? etas.get(colis.id) || null : null;
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
    showToast("Tous les arrêts sont traités !");
    return;
  }
  const label = heroEntry.colis.nom || formatAdresseAffichage(heroEntry.colis);
  const settings = await getAllSettings();
  if (settings.autoNavAfterDeliver && heroEntry.colis.geocode?.lat != null) {
    const navUrl = buildNavUrl(settings.navApp, {
      lat: heroEntry.colis.geocode.lat,
      lon: heroEntry.colis.geocode.lon,
      label: heroEntry.colis.nom,
      adresse: formatAdresseForNav(heroEntry.colis),
    });
    window.open(navUrl, "_blank", "noopener");
    showToast(`Direction : ${label}`);
  } else {
    showToast(`Prochain arrêt : ${label}`);
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

function renderSmsOptionsHtml(smsOptions) {
  if (smsOptions.length === 0) return "";
  return `
    <div class="candidate-list" id="hero-sms-options" hidden style="margin-top:8px;">
      ${smsOptions
        .map(
          (o) => `<a class="candidate-item btn-link" href="${o.href}">${escapeHtml(o.label || `Modèle ${o.index + 1}`)}<span class="muted">${escapeHtml(o.body)}</span></a>`
        )
        .join("")}
    </div>
  `;
}

function renderHeroCard(stop, colis, { navApp, eta, smsTemplates }) {
  const adresse = formatAdresseAffichage(colis);
  const navUrl = colis.geocode?.lat
    ? buildNavUrl(navApp, { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse: formatAdresseForNav(colis) })
    : null;
  const { street, cityLine } = splitAdresseForHero(colis);
  // Minutes restantes reelles (arret courant d'une tournee active) : le seul
  // endroit ou {minutes_estimees} peut etre rempli avec une valeur fraiche
  // (recalculee a chaque render, pas figee au moment du scan).
  const minutesEstimees = eta ? Math.max(0, Math.round((eta.getTime() - Date.now()) / 60000)) : null;
  const smsOptions = colis.tel ? buildSmsOptions(smsTemplates, colis.tel, { nom: colis.nom, adresse, minutesEstimees }) : [];

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
          ${navUrl ? `<a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener">${icon("navigation")}Naviguer</a>` : ""}
          ${colis.tel ? `<a class="btn-link" style="flex:0 0 48px;" href="tel:${escapeAttr(colis.tel)}">${icon("phone", { spaced: false })}</a>` : ""}
          ${smsOptions.length > 0 ? `<button type="button" class="btn-link" style="flex:0 0 48px;" id="hero-sms-toggle">${icon("message-circle", { spaced: false })}</button>` : ""}
        </div>
        ${renderSmsOptionsHtml(smsOptions)}
        <button type="button" class="ok" data-deliver-ordre="${stop.ordre}" data-hero-deliver>${icon("check")}${verbeAction(colis)}</button>
        <button type="button" class="hero-fail-btn" data-fail-ordre="${stop.ordre}">Marquer en échec</button>
      </div>
    </div>
  `;
}

// Carte compacte (retour terrain : "trop de place prise" avec potentiellement
// 20+ arrets a faire defiler d'une traite) -- memes actions qu'avant (rien
// retire : appeler/naviguer/photo/livre/echec/reordonner), juste densifiees
// sur UNE seule ligne d'icones plutot que deux lignes de boutons pleine
// largeur + une 3e ligne pour le reordonnancement. Voir .stop-card* en CSS.
function renderStopCard(stop, colis, { navApp, eta, canMoveUp, canMoveDown }) {
  if (!colis) {
    return `<div class="card stop-card"><div class="muted">Colis introuvable (${escapeAttr(stop.colisId)})</div></div>`;
  }
  const delivered = stop.statutLivraison === "livre";
  const failed = stop.statutLivraison === "echec";
  const done = delivered || failed;
  const adresse = formatAdresseAffichage(colis);
  const navUrl = colis.geocode?.lat
    ? buildNavUrl(navApp, { lat: colis.geocode.lat, lon: colis.geocode.lon, label: colis.nom, adresse: formatAdresseForNav(colis) })
    : null;
  let heureLabel = null;
  if (delivered) heureLabel = stop.heureLivraison ? formatHeure(new Date(stop.heureLivraison)) : "Livré";
  else if (failed) heureLabel = stop.heureEchec ? formatHeure(new Date(stop.heureEchec)) : "Échec";
  else if (heureConnue(eta)) heureLabel = `≈ ${formatHeure(eta)}`;
  const hasPhoto = Boolean(colis.preuvePhoto);
  const reorderButtons = reorderMode
    ? `
        <button type="button" data-move-ordre="${stop.ordre}" data-move-dir="-1" ${canMoveUp ? "" : "disabled"} aria-label="Monter">${icon("chevron-up", { spaced: false })}</button>
        <button type="button" data-move-ordre="${stop.ordre}" data-move-dir="1" ${canMoveDown ? "" : "disabled"} aria-label="Descendre">${icon("chevron-down", { spaced: false })}</button>
    `
    : "";

  return `
    <div class="card stop-card" data-stop-card="${escapeAttr(colis.id)}" style="${done ? "opacity:0.55;" : ""}">
      <div class="card-row" data-open-detail data-colis-id="${escapeAttr(colis.id)}">
        <div class="card-title">#${stop.ordre} ${escapeHtml(colis.nom || "(nom inconnu)")}</div>
        <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
          ${heureLabel ? `<span class="badge ${failed ? "badge-warn" : "badge-pending"}">${heureLabel}</span>` : ""}
          ${colis.avant12h ? '<span class="badge badge-urgent">12h</span>' : ""}
          ${colis.typeClient === "pro" ? '<span class="badge badge-info">Pro</span>' : ""}
          ${colis.operation === "ramasse" ? '<span class="badge badge-info">Ramasse</span>' : ""}
        </div>
      </div>
      <div class="muted stop-card-addr" data-open-detail data-colis-id="${escapeAttr(colis.id)}">${escapeHtml(adresse)}${colis.quantite > 1 ? ` · ${colis.quantite} colis` : ""}</div>
      ${failed && stop.raisonEchec ? `<div class="muted" style="margin-top:2px;">Motif : ${escapeHtml(stop.raisonEchec)}</div>` : ""}
      <div class="stop-card-actions">
        ${colis.tel ? `<a class="btn-link" href="tel:${escapeAttr(colis.tel)}" aria-label="Appeler">${icon("phone", { spaced: false })}</a>` : ""}
        ${navUrl ? `<a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener" aria-label="Naviguer">${icon("navigation", { spaced: false })}</a>` : ""}
        <button type="button" data-photo-colis="${escapeAttr(colis.id)}" aria-label="Photo">${icon(hasPhoto ? "check" : "camera", { spaced: false })}</button>
        ${colis.typeClient === "pro" && colis.geocode?.lat != null ? `<button type="button" data-pro-hours="${escapeAttr(colis.id)}" aria-label="Horaires de fermeture">${icon("clock", { spaced: false })}</button>` : ""}
        ${
          done
            ? `<button type="button" disabled aria-label="${delivered ? "Livré" : "Échec"}">${delivered ? icon("check", { spaced: false }) : icon("x", { spaced: false })}</button>`
            : `<button type="button" class="ok" data-deliver-ordre="${stop.ordre}" aria-label="Livré">${icon("check", { spaced: false })}</button>`
        }
        ${!done ? `<button type="button" class="hero-fail-btn" data-fail-ordre="${stop.ordre}" aria-label="Échec">${icon("x", { spaced: false })}</button>` : ""}
        ${reorderButtons}
      </div>
    </div>
  `;
}

function renderDepotReturnCard(tour, navApp, depotEta) {
  if (!tour.returnToDepot || !tour.depotArrivee) return "";
  const navUrl = buildNavUrl(navApp, {
    lat: tour.depotArrivee.lat,
    lon: tour.depotArrivee.lon,
    label: tour.depotArrivee.label,
    adresse: tour.depotArrivee.label,
  });
  return `
    <div class="card">
      <div class="card-row">
        <div class="card-title" style="margin-bottom:0;">${icon("home")}Retour au dépôt</div>
        ${heureConnue(depotEta) ? `<span class="badge badge-pending">≈ ${formatHeure(depotEta)}</span>` : ""}
      </div>
      <div class="muted">${escapeAttr(tour.depotArrivee.label)}</div>
      <div class="button-row">
        <a class="btn-link primary" href="${navUrl}" target="_blank" rel="noopener">${icon("navigation")}Naviguer</a>
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
  // Touche directe "horaires de fermeture" sur les cartes pro (retour
  // terrain) : deplie un mini-editeur sous la carte, pre-rempli depuis le
  // favori de l'adresse (cree au besoin, meme mecanique implicite que la
  // note de la fiche colis). Enregistre en quittant un champ ; pris en
  // compte au prochain calcul/recalcul de tournee.
  containerRef.querySelectorAll("[data-pro-hours]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".stop-card");
      const existing = card.querySelector(".pro-hours-editor");
      if (existing) {
        existing.remove();
        return;
      }
      const entry = lastStopsWithColis.find(({ colis }) => colis && colis.id === btn.dataset.proHours);
      if (!entry) return;
      const colis = entry.colis;
      const favori = await findNearbyFavori(colis.geocode.lat, colis.geocode.lon);
      const editor = document.createElement("div");
      editor.className = "pro-hours-editor";
      editor.style.cssText = "margin-top:8px;";
      card.appendChild(editor);
      // Meme editeur jour par jour que la fiche colis et les Reglages (voir
      // favoris/horaires-ui.js).
      renderHorairesEditor(editor, horairesOf(favori), {
        onChange: async (horaires) => {
          await saveFavoriInfo(colis, { horaires, fermeDebut: "", fermeFin: "" });
          showToast("Horaires enregistrés — pris en compte au prochain recalcul.");
        },
      });
    });
  });

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
        showToast("Photo de preuve enregistrée.");
        render();
      } catch (err) {
        if (err.message !== "Aucune photo sélectionnée.") console.error(err);
      }
    });
  });

  // Choix du modele de SMS (hero card) : simple affichage/masquage, pas de
  // re-rendu (les liens sms: sont deja construits dans le HTML).
  const smsToggle = containerRef.querySelector("#hero-sms-toggle");
  if (smsToggle) {
    smsToggle.addEventListener("click", () => {
      containerRef.querySelector("#hero-sms-options")?.toggleAttribute("hidden");
    });
  }
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

  const carte = ({ stop, colis }) => {
    const posInPending = pendingOrdered.indexOf(stop.ordre);
    return renderStopCard(stop, colis, {
      navApp: lastNavApp,
      eta: colis ? lastEtas.get(colis.id) : null,
      canMoveUp: posInPending > 0,
      canMoveDown: posInPending !== -1 && posInPending < pendingOrdered.length - 1,
    });
  };

  // Deux sections repliables (voir suivantsOuverts) : les arrets ENCORE A
  // FAIRE d'abord, les traites ensuite -- avant, la liste suivait l'ordre de
  // tournee, donc commencait par tous les arrets deja livres, et il fallait
  // les faire defiler a chaque fois pour retrouver le prochain. Une recherche
  // ou le mode reordonner ouvrent tout : une liste repliee n'y sert a rien.
  const suivants = filtered.filter(({ stop }) => isPending(stop));
  const traites = filtered.filter(({ stop }) => !isPending(stop));
  const forcerOuvert = Boolean(filterText) || reorderMode;
  const prochain = suivants[0]?.colis;
  // Sous-titre ("prochain : ...") sur sa propre ligne : sur un ecran de
  // telephone il etait tronque apres trois lettres du nom.
  const section = (cle, titre, sousTitre, entries, ouverte) => `
    <details class="stops-section" data-section="${cle}" ${ouverte ? "open" : ""}>
      <summary>
        <span class="stops-summary-text">
          <span>${titre}</span>
          ${sousTitre ? `<span class="muted stops-summary-sub">${sousTitre}</span>` : ""}
        </span>
        <span class="stops-chevron">${icon("chevron-down", { spaced: false })}</span>
      </summary>
      <div class="stops-section-body">${entries.map(carte).join("")}</div>
    </details>`;

  let html = "";
  if (filtered.length === 0) {
    html = `<div class="empty-state">${filterText ? `Aucun arrêt ne correspond à "${escapeHtml(filterText)}".` : "Tous les autres arrêts sont traités."}</div>`;
  } else {
    if (suivants.length > 0) {
      html += section(
        "suivants",
        `Arrêts suivants (${suivants.length})`,
        prochain ? `prochain : #${suivants[0].stop.ordre} ${escapeHtml(prochain.nom || formatAdresseAffichage(prochain))}` : "",
        suivants,
        suivantsOuverts || forcerOuvert
      );
    } else if (!filterText) {
      html += `<div class="empty-state">Tous les autres arrêts sont traités.</div>`;
    }
    if (traites.length > 0) {
      html += section("traites", `Déjà traités (${traites.length})`, "", traites, traitesOuverts || forcerOuvert);
    }
  }
  stopsContainer.innerHTML = html;

  // Memorise ce que le livreur a ouvert/ferme lui-meme -- pas ce qu'une
  // recherche ou le mode reordonner ont force.
  if (!forcerOuvert) {
    stopsContainer.querySelectorAll("details.stops-section").forEach((d) => {
      d.addEventListener("toggle", () => {
        if (d.dataset.section === "suivants") suivantsOuverts = d.open;
        else traitesOuverts = d.open;
      });
    });
  }

  bindActionEvents(lastTour.id);
}

// Cloture de journee (chantier F) : un seul geste pour archiver la tournee
// du jour sous un nom de SECTEUR et renvoyer les colis non livres dans la
// preparation du lendemain (voir finDeJournee dans tour-store.js). Panneau
// dedie plutot qu'un confirm() : il faut saisir le secteur ET annoncer
// clairement ce qui va etre reporte, avant de valider.
async function openFinDeJournee() {
  const [stats, secteurs] = await Promise.all([getTodayStats(), listSecteursConnus()]);
  const aReporter = (lastStopsWithColis || []).filter(({ stop }) => isPending(stop)).length;
  sheetControl?.applyState("full");
  view = "list";
  containerRef.innerHTML = `
    <div class="card">
      <div class="card-title">${icon("flag")}Fin de journée</div>
      <p class="muted">La tournée du jour part dans l'historique. ${
        aReporter > 0
          ? `<strong>${aReporter} arrêt${aReporter > 1 ? "s" : ""} non livré${aReporter > 1 ? "s" : ""}</strong> ${aReporter > 1 ? "reviennent" : "revient"} automatiquement dans la préparation de demain.`
          : "Tous les arrêts ont été traités."
      }</p>
      <div class="stats-row" style="flex-wrap:wrap;margin-bottom:10px;">
        <span class="stat-pill">${stats.livres} livré${stats.livres > 1 ? "s" : ""}</span>
        ${stats.echecs > 0 ? `<span class="stat-pill stat-pill-check">${stats.echecs} échec${stats.echecs > 1 ? "s" : ""}</span>` : ""}
      </div>
      <div class="field">
        <label for="fin-secteur">Secteur du jour (facultatif)</label>
        <input type="text" id="fin-secteur" list="fin-secteurs-connus" placeholder="Bar-le-Duc, Toul..." autocomplete="off">
        <datalist id="fin-secteurs-connus">${secteurs.map((s) => `<option value="${escapeAttr(s)}"></option>`).join("")}</datalist>
      </div>
      <p class="muted" style="margin-top:-6px;">Sert à retrouver et comparer les journées plus tard (Réglages → Historique).</p>
      <div class="button-row">
        <button type="button" id="fin-cancel">Annuler</button>
        <button type="button" class="primary" id="fin-confirm">${icon("check")}Clôturer</button>
      </div>
    </div>
  `;
  containerRef.querySelector("#fin-cancel").addEventListener("click", () => render());
  containerRef.querySelector("#fin-confirm").addEventListener("click", async () => {
    const secteur = containerRef.querySelector("#fin-secteur").value;
    const resume = await finDeJournee({ secteur });
    reorderMode = false;
    showToast(
      resume.reportes > 0
        ? `Journée clôturée — ${resume.reportes} colis reporté${resume.reportes > 1 ? "s" : ""} à demain.`
        : "Journée clôturée."
    );
    await render();
  });
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
  const etaResult = computeEtas(tour, stopsWithColis, (settings.dureeArretMinutes || 0) * 60);
  lastEtas = etaResult.etas;
  lastDepotEta = etaResult.depotEta;

  const delivered = stopsWithColis.filter((s) => s.stop.statutLivraison === "livre").length;
  const failed = stopsWithColis.filter((s) => s.stop.statutLivraison === "echec").length;
  const total = stopsWithColis.length;
  const finEstimee = computeFinEstimee(tour, stopsWithColis, lastEtas, lastDepotEta);

  updateHeader({
    title: "Ma tournée",
    statsHtml: heureConnue(finEstimee) ? `<span class="stat-pill">${icon("clock", { spaced: false })} Fin ≈ ${formatHeure(finEstimee)}</span>` : "",
    showProgress: true,
    progressPercent: total === 0 ? 0 : Math.round(((delivered + failed) / total) * 100),
  });

  const pendingCount = stopsWithColis.filter(({ stop }) => isPending(stop)).length;
  const sheetLabel = document.getElementById("tour-sheet-label");
  if (sheetLabel) sheetLabel.textContent = pendingCount > 0 ? `${pendingCount} arrêt${pendingCount > 1 ? "s" : ""} restant${pendingCount > 1 ? "s" : ""}` : "Tournée traitée";

  // Le rendu remplace tout le HTML, donc le defilement repartirait de zero a
  // chaque livraison : on le remet ou il etait, pour "rester sur le dernier
  // point a faire" (retour terrain) au lieu de renvoyer en haut.
  const scrollAvant = containerRef.scrollTop;

  const heroEntry = stopsWithColis.find(({ stop, colis }) => isPending(stop) && colis);
  const heroHtml = heroEntry
    ? renderHeroCard(heroEntry.stop, heroEntry.colis, { navApp, eta: lastEtas.get(heroEntry.colis.id), smsTemplates: settings.smsTemplates })
    : `<div class="card"><div class="card-title">${icon("check")}Tournée traitée</div><p class="muted">${delivered} livré${delivered > 1 ? "s" : ""}${failed > 0 ? `, ${failed} échec${failed > 1 ? "s" : ""}` : ""}. Plus aucun arrêt en attente.</p></div>`;

  containerRef.innerHTML = `
    <div class="card">
      <div class="card-row">
        <span class="muted">${delivered + failed}/${total} traités</span>
        <span class="muted">${formatDurationShort(tour.totalDureeSec)} estimées</span>
      </div>
    </div>
    <p id="routing-status" class="muted" style="margin:-2px 0 6px;"></p>
    <div class="progress-bar" style="margin:-2px 0 12px;"><div id="routing-progress-fill" class="progress-bar-fill" style="width:0%"></div></div>
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
        <input type="search" id="tour-search" placeholder="Rechercher un arrêt…">
      </div>
      <button type="button" id="reorder-toggle" style="margin-left:8px;flex-shrink:0;">${reorderMode ? `${icon("check")}Terminé` : `${icon("move-vertical")}Réordonner`}</button>
    </div>
    <div class="button-row" style="margin:-4px 0 10px;">
      <button type="button" class="btn-compact" id="etatB-manual">${icon("plus")}Ajouter une adresse</button>
      <button type="button" class="btn-compact" id="etatB-batch-scan">${icon("camera")}Scanner une liste</button>
    </div>
    ${
      reorderMode
        ? `<div class="button-row" style="margin:-4px 0 10px;"><button type="button" id="reverse-order-btn">${icon("repeat")}Inverser le sens des arrêts restants</button></div>`
        : ""
    }
    ${total > 0 ? `<p class="muted" style="margin:-4px 0 10px;">Horaires estimés à titre indicatif — recalcule la tournée après un réarrangement pour des horaires exacts.</p>` : ""}
    <div id="stops-container" data-hero-colis-id="${heroEntry ? escapeAttr(heroEntry.colis.id) : ""}"></div>
    ${renderDepotReturnCard(tour, navApp, lastDepotEta)}
    <div class="button-row">
      <button type="button" id="end-tour-btn">${icon("flag")}Fin de journée</button>
    </div>
  `;

  bindActionEvents(tour.id); // branche aussi les actions de la hero card
  renderStopsList("");
  if (scrollAvant > 0) containerRef.scrollTop = scrollAvant;

  containerRef.querySelector("#tour-search").addEventListener("input", (e) => {
    renderStopsList(e.target.value);
  });

  // Retour terrain : aucun moyen de saisir une adresse a la main une fois la
  // tournee calculee (seul le FAB camera etait accessible en Etat B) --
  // reutilise le meme circuit que le scan (handleColisSaved fait deja
  // l'insertion au meilleur endroit sans recalcul complet, voir plus haut).
  containerRef.querySelector("#etatB-manual").addEventListener("click", () => openManualEntry());
  containerRef.querySelector("#etatB-batch-scan").addEventListener("click", () => openBatchScan());

  containerRef.querySelector("#reorder-toggle").addEventListener("click", () => {
    reorderMode = !reorderMode;
    render(); // passe par le routeur (filet de securite en cas d'echec, voir plus haut)
  });

  containerRef.querySelector("#reverse-order-btn")?.addEventListener("click", async () => {
    await reverseRemainingStops(tour.id);
    render();
  });



  containerRef.querySelector("#end-tour-btn").addEventListener("click", () => openFinDeJournee());
}
