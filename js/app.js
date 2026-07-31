import { openDb } from "./db/schema.js";
import { runImportIfNeeded } from "./import/import-data.js";
import { renderImportProgress } from "./import/import-ui.js";
import { purgeOldTours } from "./routing/tour-store.js";
import { getSetting } from "./settings/settings-store.js";
import { icon } from "./ui/icons.js";
import { reportBug } from "./debug/bug-reports-store.js";

// Capture automatique des erreurs JS non attrapees (retour terrain : le
// livreur ne pense pas toujours a signaler un bug lui-meme) -- complement au
// bouton manuel "Signaler un bug" des Reglages, voir bug-reports-store.js.
// Best-effort : si l'ecriture IndexedDB elle-meme echoue (ex: DB pas encore
// ouverte au tout debut du boot), on avale silencieusement plutot que de
// provoquer une 2e erreur en cascade.
function installGlobalErrorCapture() {
  window.addEventListener("error", (e) => {
    reportBug({ type: "auto", message: e.message || String(e.error), stack: e.error?.stack, context: "window.onerror" }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    reportBug({
      type: "auto",
      message: reason?.message || String(reason),
      stack: reason?.stack,
      context: "unhandledrejection",
    }).catch(() => {});
  });
}

// Tournee est l'ecran d'accueil et heberge le scan (bouton flottant camera,
// voir tour-ui.js) : machine a 2 etats (preparation/execution), plus de tab
// Scan separe. Carte/Reglages restent a 1 tap.
const VIEWS = ["tour", "map", "settings"];
const viewModules = {};

async function loadViewModule(name) {
  if (viewModules[name]) return viewModules[name];
  let mod;
  if (name === "tour") mod = await import("./tour/tour-ui.js");
  else if (name === "map") mod = await import("./map/map-ui.js");
  else if (name === "settings") mod = await import("./settings/settings-ui.js");
  viewModules[name] = mod;
  return mod;
}

function setActiveNav(name) {
  for (const link of document.querySelectorAll("#bottom-nav a")) {
    link.classList.toggle("active", link.dataset.nav === name);
  }
}

async function navigate(name) {
  for (const v of VIEWS) {
    document.getElementById(`${v}-view`).hidden = v !== name;
  }
  setActiveNav(name);
  try {
    const mod = await loadViewModule(name);
    const container = document.getElementById(`${name}-content`);
    await mod.mount(container);
  } catch (err) {
    console.error(`Erreur d'affichage de la vue "${name}":`, err);
    reportBug({ type: "auto", message: err.message || String(err), stack: err.stack, context: `navigate("${name}")` }).catch(() => {});
    const container = document.getElementById(`${name}-content`);
    if (container) {
      container.innerHTML = `<div class="empty-state">Erreur d'affichage. Détail dans la console.</div>`;
    }
  }
}

function onHashChange() {
  const name = (location.hash || "#tour").slice(1);
  if (!VIEWS.includes(name)) {
    location.hash = "#tour";
    return Promise.resolve();
  }
  return navigate(name);
}

async function boot() {
  installGlobalErrorCapture();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker non enregistré:", err);
    });
  }

  const importView = document.getElementById("import-view");
  importView.hidden = false;

  // Le HTML statique ne peut pas appeler icon() (module JS) : les quelques
  // icones vivant hors des vues gerees par mount() sont injectees ici, une
  // fois, au demarrage.
  document.getElementById("scan-fab").innerHTML = icon("camera", { spaced: false, size: 26 });
  document.getElementById("settings-back").innerHTML = icon("arrow-left", { spaced: false });
  document.getElementById("settings-back").addEventListener("click", () => {
    // Reglages n'est plus un onglet de la nav du bas (accessible depuis le
    // menu de l'ecran Carte) : history.back() ramene a l'ecran d'ou on vient
    // plutot que vers une destination fixe supposee.
    if (history.length > 1) history.back();
    else location.hash = "#tour";
  });

  await openDb();
  await runImportIfNeeded(renderImportProgress);

  importView.hidden = true;

  // Menage sur la retention de l'historique de tournees (chantier F) : pas
  // sur le chemin critique du demarrage, une erreur ici ne doit jamais
  // bloquer l'affichage de l'appli.
  getSetting("tourHistoryPurgeMonths")
    .then((months) => purgeOldTours(months))
    .catch((err) => console.warn("Purge de l'historique des tournées échouée:", err));

  window.addEventListener("hashchange", onHashChange);
  // Attend que la vue initiale soit montee (et ses ecouteurs, notamment le
  // FAB de scan qui vit dans le HTML statique de #tour-view, branches) avant
  // de reveler la nav -- sinon un tap rapide juste apres l'affichage peut ne
  // rien faire (import dynamique de tour-ui.js pas encore resolu).
  await onHashChange();
  document.getElementById("bottom-nav").hidden = false;

  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

boot().catch((err) => {
  console.error("Echec du demarrage:", err);
  reportBug({ type: "auto", message: err.message || String(err), stack: err.stack, context: "boot()" }).catch(() => {});
  const importView = document.getElementById("import-view");
  importView.hidden = false;
  document.getElementById("import-status").textContent = "Erreur au démarrage.";
  document.getElementById("import-detail").textContent = String(err.message || err);
});
