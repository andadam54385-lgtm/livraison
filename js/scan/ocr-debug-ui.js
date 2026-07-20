import { listAllColis } from "./colis-store.js";
import { parseUpsLabelDetailed } from "./parse-ups-label.js";

// Ecran de diagnostic (Reglages) : montre le texte OCR brut d'un colis
// scanne et le detail de la classification ligne par ligne (nom / rue /
// telephone / cp+ville), pour comprendre EXACTEMENT ou un parsing rate sur
// une vraie photo -- plutot que de deviner a distance. Lecture seule, ne
// modifie jamais le colis.

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

export async function renderOcrDebug(container) {
  const allColis = await listAllColis();
  const scans = allColis.filter((c) => c.source === "ocr").reverse(); // plus recent d'abord

  if (scans.length === 0) {
    container.innerHTML = `<p class="muted">Aucun colis scanné par OCR pour l'instant.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="field">
      <label>Choisir un scan à inspecter</label>
      <select id="ocr-debug-select">
        ${scans
          .map(
            (c, i) =>
              `<option value="${i}">${escapeHtml(c.nom || "(nom inconnu)")} — ${new Date(c.dateScan).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</option>`
          )
          .join("")}
      </select>
    </div>
    <div id="ocr-debug-detail"></div>
  `;

  const select = container.querySelector("#ocr-debug-select");
  const detail = container.querySelector("#ocr-debug-detail");

  function showSelected() {
    detail.innerHTML = renderClassificationDetail(scans[Number(select.value)]);
  }

  select.addEventListener("change", showSelected);
  showSelected();
}
