import { openDb } from "./db/schema.js";
import { runImportIfNeeded } from "./import/import-data.js";
import { renderImportProgress } from "./import/import-ui.js";

const VIEWS = ["scan", "routing", "tour", "map", "settings"];
const viewModules = {};

async function loadViewModule(name) {
  if (viewModules[name]) return viewModules[name];
  let mod;
  if (name === "scan") mod = await import("./scan/scan-ui.js");
  else if (name === "routing") mod = await import("./routing/routing-ui.js");
  else if (name === "tour") mod = await import("./tour/tour-ui.js");
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
    const container = document.getElementById(`${name}-content`);
    if (container) {
      container.innerHTML = `<div class="empty-state">Erreur d'affichage. Détail dans la console.</div>`;
    }
  }
}

function onHashChange() {
  const name = (location.hash || "#scan").slice(1);
  if (!VIEWS.includes(name)) {
    location.hash = "#scan";
    return Promise.resolve();
  }
  return navigate(name);
}

async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker non enregistré:", err);
    });
  }

  const importView = document.getElementById("import-view");
  importView.hidden = false;

  await openDb();
  await runImportIfNeeded(renderImportProgress);

  importView.hidden = true;

  window.addEventListener("hashchange", onHashChange);
  // Attend que la vue initiale soit montee (et ses ecouteurs, notamment le
  // FAB de scan qui vit dans le HTML statique, branches) avant de reveler la
  // nav -- sinon un tap rapide juste apres l'affichage peut ne rien faire
  // (import dynamique de scan-ui.js pas encore resolu).
  await onHashChange();
  document.getElementById("bottom-nav").hidden = false;

  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }
}

boot().catch((err) => {
  console.error("Echec du demarrage:", err);
  const importView = document.getElementById("import-view");
  importView.hidden = false;
  document.getElementById("import-status").textContent = "Erreur au démarrage.";
  document.getElementById("import-detail").textContent = String(err.message || err);
});
