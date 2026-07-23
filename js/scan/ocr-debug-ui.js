import { listAllColis } from "./colis-store.js";
import { parseUpsLabelDetailed } from "./parse-ups-label.js";
import { renderReviewForm } from "./scan-ui.js";
import { listOcrCorrections } from "./ocr-corrections-store.js";

// Ecran de diagnostic (Reglages) : montre le texte OCR brut d'un colis
// scanne et le detail de la classification ligne par ligne (nom / rue /
// telephone / cp+ville), pour comprendre EXACTEMENT ou un parsing rate sur
// une vraie photo -- plutot que de deviner a distance. Vu le volume
// d'erreurs OCR reel, un bouton "Corriger ce colis" ouvre directement la
// fiche d'edition habituelle (scan-ui.js's renderReviewForm) dans ce meme
// ecran -- diagnostiquer puis corriger sans changer d'onglet.

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderClassificationDetail(colis) {
  if (!colis.ocrRawText) {
    return `<p class="muted">Ce colis n'a pas de texte OCR enregistré (saisie manuelle).</p>`;
  }
  const { lines, block, classified, result } = parseUpsLabelDetailed(colis.ocrRawText);

  const lineRole = (line) => {
    if (classified.names.includes(line)) return "nom";
    if (classified.streets.includes(line)) return "rue";
    if (classified.phones.some((p) => p.raw === line)) return "téléphone";
    if (`${classified.cp} ${classified.ville}`.trim() === line || (classified.cp && line.includes(classified.cp))) return "cp+ville";
    return "(ignorée)";
  };

  return `
    <div class="field">
      <label>Texte OCR brut (${lines.length} lignes)</label>
      <pre style="white-space:pre-wrap;background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:0.8rem;max-height:160px;overflow-y:auto;">${escapeHtml(colis.ocrRawText)}</pre>
    </div>
    <div class="field">
      <label>Bloc retenu après l'ancre SHIP TO (${block.length} ligne${block.length > 1 ? "s" : ""}) et classification</label>
      <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;">
        ${block
          .map(
            (line, i) => `
          <div class="card-row" style="padding:6px 10px;${i % 2 ? "background:var(--bg-elevated);" : ""}">
            <span style="font-size:0.82rem;">${escapeHtml(line)}</span>
            <span class="badge badge-pending">${lineRole(line)}</span>
          </div>
        `
          )
          .join("")}
      </div>
    </div>
    <div class="field">
      <label>Résultat final</label>
      <p class="muted" style="margin:0;">
        nom : <strong style="color:${result.nom ? "var(--text)" : "var(--warn)"};">${result.nom ? escapeHtml(result.nom) : "(non trouvé)"}</strong><br>
        tel : ${result.tel ? escapeHtml(result.tel) : "(non trouvé)"} (${result.telConfidence})<br>
        rue : ${result.rue ? escapeHtml(result.rue) : "(non trouvée)"}<br>
        cp/ville : ${result.cp || "?"} ${escapeHtml(result.ville || "")}
      </p>
    </div>
  `;
}

// Journal exportable des corrections (voir ocr-corrections-store.js) : le but
// n'est pas de corriger CE colis (deja fait par le bouton ci-dessus) mais
// d'accumuler des cas reels a partager plus tard pour ameliorer
// parse-ups-label.js -- copier/coller ce JSON dans une prochaine session.
function renderCorrectionsSection(corrections) {
  return `
    <div class="card" style="margin-top:16px;">
      <div class="card-title">📋 Corrections enregistrées (${corrections.length})</div>
      <p class="muted">Chaque correction faite via "Corriger ce colis" est journalisée ici (texte OCR brut, ce que le parser a produit, ce que tu as validé) — copie ce texte (tap dedans pour tout sélectionner) et partage-le pour améliorer le parsing.</p>
      ${
        corrections.length > 0
          ? `<textarea id="ocr-corrections-export" readonly class="field-lg" rows="6" style="min-height:0;font-family:monospace;font-size:0.72rem;">${escapeHtml(JSON.stringify(corrections, null, 2))}</textarea>`
          : `<p class="muted">Aucune correction enregistrée pour l'instant.</p>`
      }
    </div>
  `;
}

export async function renderOcrDebug(container, { preselectColisId } = {}) {
  const allColis = await listAllColis();
  const scans = allColis.filter((c) => c.source === "ocr").reverse(); // plus recent d'abord
  const corrections = await listOcrCorrections();
  const correctionsHtml = renderCorrectionsSection(corrections);

  if (scans.length === 0) {
    container.innerHTML = `<p class="muted">Aucun colis scanné par OCR pour l'instant.</p>${correctionsHtml}`;
    return;
  }

  const initialIndex = preselectColisId ? Math.max(0, scans.findIndex((c) => c.id === preselectColisId)) : 0;

  container.innerHTML = `
    <div class="field">
      <label>Choisir un scan à inspecter</label>
      <select id="ocr-debug-select">
        ${scans
          .map(
            (c, i) =>
              `<option value="${i}" ${i === initialIndex ? "selected" : ""}>${escapeHtml(c.nom || "(nom inconnu)")} — ${new Date(c.dateScan).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</option>`
          )
          .join("")}
      </select>
    </div>
    <div id="ocr-debug-detail"></div>
    ${correctionsHtml}
  `;

  const select = container.querySelector("#ocr-debug-select");
  const detail = container.querySelector("#ocr-debug-detail");
  const exportEl = container.querySelector("#ocr-corrections-export");
  exportEl?.addEventListener("click", () => exportEl.select());

  function showSelected() {
    const colis = scans[Number(select.value)];
    detail.innerHTML = `
      ${renderClassificationDetail(colis)}
      <div class="button-row" style="margin-top:10px;">
        <button type="button" id="ocr-debug-correct">✏️ Corriger ce colis</button>
      </div>
    `;
    detail.querySelector("#ocr-debug-correct").addEventListener("click", () => {
      renderReviewForm(detail, colis, {
        isNew: false,
        // Recharge tout l'ecran (pas juste le detail) : la correction vient
        // de journaliser une nouvelle entree, le compteur/export doivent la
        // refleter immediatement -- reste sur le meme colis plutot que de
        // revenir au tout premier de la liste.
        onSaved: () => renderOcrDebug(container, { preselectColisId: colis.id }),
      });
    });
  }

  select.addEventListener("change", showSelected);
  showSelected();
}
