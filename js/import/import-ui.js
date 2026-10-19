import { setInlineLoading } from "../lib/loading.js";

// Une phase sans total connu (decompression du graphe, lecture de la BAN,
// debut du telechargement de la carte) laisse la barre de progression figee
// a sa derniere valeur : l'anneau est alors le seul signe que l'appli
// travaille encore, sur un ecran d'import qui dure plusieurs minutes.
export function renderImportProgress(status) {
  const statusEl = document.getElementById("import-status");
  const fillEl = document.getElementById("import-progress-fill");
  const detailEl = document.getElementById("import-detail");
  if (!statusEl || !fillEl || !detailEl) return;

  const label = status.label || "Préparation…";
  if (status.phase === "done") statusEl.textContent = label;
  else setInlineLoading(statusEl, label);

  if (status.total) {
    const pct = Math.round((status.done / status.total) * 100);
    fillEl.style.width = `${pct}%`;
    detailEl.textContent = `${status.done} / ${status.total}`;
  } else if (status.phase === "done") {
    fillEl.style.width = "100%";
    detailEl.textContent = "";
  } else {
    detailEl.textContent = "";
  }
}
