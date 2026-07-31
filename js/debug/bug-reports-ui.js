import { reportBug, listBugReports, deleteBugReport } from "./bug-reports-store.js";
import { showToast } from "../lib/toast.js";
import { icon } from "../ui/icons.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Section Reglages : signalement manuel a chaud ("Signaler un bug", texte
// libre horodate) + liste/export de tout ce qui a ete capture, manuel ET
// automatique (voir bug-reports-store.js / installGlobalErrorCapture dans
// app.js) -- meme principe que le journal de corrections OCR (Debug OCR),
// generalise a n'importe quel souci technique.
export async function renderBugReports(container) {
  const reports = await listBugReports();

  container.innerHTML = `
    <div class="field">
      <label>Décrire le souci (ce qui s'est passé, ce que tu attendais)</label>
      <textarea id="bug-report-text" class="field-lg" rows="3" style="min-height:0;" placeholder="Ex : le bouton Livré n'a rien fait sur l'arrêt 4..."></textarea>
    </div>
    <button type="button" id="bug-report-submit">${icon("plus")}Enregistrer ce signalement</button>
    <div style="margin-top:14px;">
      <div class="card-title" style="margin-bottom:6px;">${icon("clipboard-list")}Signalements enregistrés (${reports.length})</div>
      <p class="muted">Manuels et automatiques (erreurs techniques capturées sans action de ta part). Copie ce texte (tap dedans pour tout sélectionner) et partage-le.</p>
      ${
        reports.length > 0
          ? `<textarea id="bug-reports-export" readonly class="field-lg" rows="6" style="min-height:0;font-family:monospace;font-size:0.72rem;">${escapeHtml(JSON.stringify(reports, null, 2))}</textarea>
             <div class="button-row" style="margin-top:8px;">
               <button type="button" class="danger" id="bug-reports-clear-shown">${icon("trash-2")}Effacer les signalements affichés</button>
             </div>`
          : `<p class="muted">Aucun signalement pour l'instant.</p>`
      }
    </div>
  `;

  container.querySelector("#bug-report-submit").addEventListener("click", async () => {
    const textEl = container.querySelector("#bug-report-text");
    const message = textEl.value.trim();
    if (!message) return;
    await reportBug({ type: "manuel", message, context: "reglages" });
    textEl.value = "";
    showToast("Signalement enregistré.");
    renderBugReports(container);
  });

  const exportEl = container.querySelector("#bug-reports-export");
  exportEl?.addEventListener("click", () => exportEl.select());

  container.querySelector("#bug-reports-clear-shown")?.addEventListener("click", async () => {
    if (!confirm(`Effacer les ${reports.length} signalement(s) affiché(s) ? Cette action est irréversible.`)) return;
    for (const r of reports) await deleteBugReport(r.id);
    renderBugReports(container);
  });
}
