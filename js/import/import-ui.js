export function renderImportProgress(status) {
  const statusEl = document.getElementById("import-status");
  const fillEl = document.getElementById("import-progress-fill");
  const detailEl = document.getElementById("import-detail");
  if (!statusEl || !fillEl || !detailEl) return;

  statusEl.textContent = status.label || "Préparation…";

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
