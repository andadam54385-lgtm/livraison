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
const VIEWS = ["tour", "settings"];
const viewModules = {};

async function loadViewModule(name) {
  if (viewModules[name]) return viewModules[name];
  let mod;
  if (name === "tour") mod = await import("./tour/tour-ui.js");
  else if (name === "settings") mod = await import("./settings/settings-ui.js");
  viewModules[name] = mod;
  return mod;
}

// Plus de nav du bas depuis la fusion Carte + Tournee (un seul ecran) :
// Reglages s'ouvre par l'engrenage du header ou le menu de la carte, et les
// anciens liens/l'historique "#map" retombent sur "#tour" via onHashChange.
async function navigate(name) {
  for (const v of VIEWS) {
    document.getElementById(`${v}-view`).hidden = v !== name;
  }
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

// Bug reel observe sur l'appareil (build 88) : l'ecran affichait le nouveau
// numero de build tout en gardant l'ANCIENNE interface. sw.js fait
// skipWaiting() + clients.claim(), donc le nouveau worker prend la main sur
// une page dont les modules ES sont deja charges en memoire -- les imports
// dynamiques suivants (l'ecran Reglages, et donc version.js/APP_BUILD)
// passent par le nouveau cache pendant que le reste de la page reste sur
// l'ancien code. Etat mi-ancien mi-nouveau, et un numero de build qui ment
// precisement quand on l'interroge pour diagnostiquer une mise a jour.
//
// Correctif : quand un nouveau worker prend le controle, on recharge la page
// pour repartir d'un code homogene.
let bootDone = false;
let reloadPending = false;
let reloadDone = false;

// Un <video> vivant dans le DOM = viseur code-barres ou analyse d'une video de
// liste en cours. Ce sont les deux seuls moments ou un rechargement detruit un
// travail non enregistre (une analyse dure plusieurs minutes et ne sauvegarde
// qu'a la fin) : on differe jusqu'a ce que l'ecran soit revenu au calme.
function rechargementSansRisque() {
  return !document.querySelector("video");
}

function applyServiceWorkerUpdate() {
  if (reloadDone) return;
  if (!rechargementSansRisque()) {
    reloadPending = true;
    return;
  }
  reloadDone = true;
  location.reload();
}

function setupServiceWorkerReload() {
  // Aucun controleur au chargement = toute premiere installation : la page
  // tourne deja sur le code le plus recent, recharger n'apporterait rien et
  // couperait l'import initial (plusieurs dizaines de Mo) en plein milieu.
  if (!navigator.serviceWorker.controller) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Jamais pendant l'import : il ecrit en IndexedDB et retelechargerait
    // tout depuis zero. On differe jusqu'a la fin du demarrage.
    if (!bootDone) {
      reloadPending = true;
      return;
    }
    applyServiceWorkerUpdate();
  });
}

// Verification EXPLICITE des mises a jour (retour terrain : un build refusait
// d'arriver sur l'iPhone alors que le serveur etait sain, tous les fichiers du
// precache en 200). En PWA standalone, iOS ne relance quasiment jamais le
// controle d'octets sur sw.js tout seul : l'appli est restauree depuis un
// instantane, sans vraie navigation, donc sans "soft update". On force donc le
// controle au demarrage, puis a chaque retour au premier plan.
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let derniereVerifMaj = 0;

function setupUpdateChecks(reg) {
  const verifier = () => {
    const maintenant = Date.now();
    if (maintenant - derniereVerifMaj < UPDATE_CHECK_INTERVAL_MS) return;
    derniereVerifMaj = maintenant;
    // Echec silencieux : hors ligne, c'est le cas nominal de cette appli.
    reg.update().catch(() => {});
  };
  verifier();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    verifier();
    // Un rechargement mis en attente pendant un scan peut repartir ici.
    if (reloadPending && bootDone) applyServiceWorkerUpdate();
  });
}

async function boot() {
  installGlobalErrorCapture();

  if ("serviceWorker" in navigator) {
    setupServiceWorkerReload();
    // updateViaCache "none" : le navigateur ne doit JAMAIS servir sw.js
    // depuis son cache HTTP, sinon les octets qui declenchent la mise a
    // jour sont ceux d'une version perimee et rien ne bouge.
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((reg) => {
        setupUpdateChecks(reg);
      })
      .catch((err) => {
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
    // Reglages n'est pas un onglet de la nav du bas (accessible depuis le
    // menu de l'ecran Carte) : history.back() ramene a l'ecran d'ou on vient
    // plutot que vers une destination fixe supposee.
    if (history.length > 1) history.back();
    else location.hash = "#tour";
  });

  await openDb();
  await runImportIfNeeded(renderImportProgress);

  importView.hidden = true;
  bootDone = true;
  if (reloadPending) applyServiceWorkerUpdate();

  // Menage sur la retention de l'historique de tournees (chantier F) : pas
  // sur le chemin critique du demarrage, une erreur ici ne doit jamais
  // bloquer l'affichage de l'appli.
  getSetting("tourHistoryPurgeMonths")
    .then((months) => purgeOldTours(months))
    .catch((err) => console.warn("Purge de l'historique des tournées échouée:", err));

  window.addEventListener("hashchange", onHashChange);
  await onHashChange();

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
