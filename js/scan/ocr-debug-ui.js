import { listAllColis } from "./colis-store.js";
import { parseUpsLabelDetailed } from "./parse-ups-label.js";
import { renderReviewForm } from "./scan-ui.js";
import { listOcrCorrections } from "./ocr-corrections-store.js";
import { listScanReports } from "./scan-reports-store.js";
import { icon } from "../ui/icons.js";
import { escapeHtml } from "../lib/escape.js";

// Ecran de diagnostic (Reglages) : montre le texte OCR brut d'un colis
// scanne et le detail de la classification ligne par ligne (nom / rue /
// telephone / cp+ville), pour comprendre EXACTEMENT ou un parsing rate sur
// une vraie photo -- plutot que de deviner a distance. Vu le volume
// d'erreurs OCR reel, un bouton "Corriger ce colis" ouvre directement la
// fiche d'edition habituelle (scan-ui.js's renderReviewForm) dans ce meme
// ecran -- diagnostiquer puis corriger sans changer d'onglet.


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
// Compte rendu du dernier scan de LISTE (video/live) -- retour terrain :
// "l'OCR devrait faire un compte rendu quand c'est une video, la j'ai rien".
// Contrairement au journal des corrections (qui ne couvre que le scan d'UNE
// etiquette), on expose ici le texte OCR BRUT image par image : c'est la
// seule matiere qui permette de comprendre apres coup pourquoi une adresse a
// ete ratee, et de rejouer le cas dans les tests du parser.
function renderScanReportsSection(reports) {
  if (reports.length === 0) {
    return `
      <div class="card" style="margin-top:16px;">
        <div class="card-title">${icon("camera")}Compte rendu du scan de liste</div>
        <p class="muted">Aucun scan de liste enregistré pour l'instant. Après un scan par vidéo, le texte OCR brut de chaque image apparaîtra ici, prêt à être copié.</p>
      </div>
    `;
  }
  const r = reports[0];
  const resume = [
    `Scan ${r.source === "video" ? "par vidéo" : "en direct"} du ${new Date(r.date).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`,
    `${r.framesAnalysees} image(s) analysée(s) en ${Math.round((r.dureeMs || 0) / 1000)} s`,
    `${r.adressesRetenues} adresse(s) retenue(s)`,
  ].join(" — ");
  const texte = [
    resume,
    "",
    "=== TEXTE OCR BRUT, IMAGE PAR IMAGE ===",
    ...r.frames.flatMap((f) => [`--- image ${f.index} ---`, ...f.lignes]),
    "",
    "=== ADRESSES RETENUES PAR LE PARSER ===",
    ...r.resultats.map((x, i) => `${i + 1}. nom=${JSON.stringify(x.nom)} rue=${JSON.stringify(x.rue)} cp=${JSON.stringify(x.cp)} ville=${JSON.stringify(x.ville)}`),
  ].join("\n");
  return `
    <div class="card" style="margin-top:16px;">
      <div class="card-title">${icon("camera")}Compte rendu du scan de liste</div>
      <p class="muted">${escapeHtml(resume)}</p>
      <p class="muted">Texte OCR brut de chaque image, puis ce que le parser en a tiré — tap dedans pour tout sélectionner, puis copie et partage pour améliorer la reconnaissance.</p>
      <textarea id="scan-report-export" readonly class="field-lg" rows="8" style="min-height:0;font-family:monospace;font-size:0.72rem;">${escapeHtml(texte)}</textarea>
    </div>
  `;
}

function renderCorrectionsSection(corrections) {
  return `
    <div class="card" style="margin-top:16px;">
      <div class="card-title">${icon("clipboard-list")}Corrections enregistrées (${corrections.length})</div>
      <p class="muted">Chaque correction faite via "Corriger ce colis" est journalisée ici (texte OCR brut, ce que le parser a produit, ce que tu as validé) — copie ce texte (tap dedans pour tout sélectionner) et partage-le pour améliorer le parsing.</p>
      ${
        corrections.length > 0
          ? `<textarea id="ocr-corrections-export" readonly class="field-lg" rows="6" style="min-height:0;font-family:monospace;font-size:0.72rem;">${escapeHtml(JSON.stringify(corrections, null, 2))}</textarea>`
          : `<p class="muted">Aucune correction enregistrée pour l'instant.</p>`
      }
    </div>
  `;
}

// Tap dans un export = tout selectionner (pas de bouton "copier" : le
// presse-papier programmatique est capricieux en PWA standalone iOS, la
// selection native suivie du menu Copier est plus fiable).
function bindExports(container) {
  for (const id of ["#scan-report-export", "#ocr-corrections-export"]) {
    const el = container.querySelector(id);
    el?.addEventListener("click", () => el.select());
  }
}

export async function renderOcrDebug(container, { preselectColisId } = {}) {
  const allColis = await listAllColis();
  const scans = allColis.filter((c) => c.source === "ocr").reverse(); // plus recent d'abord
  const corrections = await listOcrCorrections();
  const correctionsHtml = renderCorrectionsSection(corrections);
  const scanReportsHtml = renderScanReportsSection(await listScanReports());

  if (scans.length === 0) {
    container.innerHTML = `<p class="muted">Aucun colis scanné par OCR pour l'instant.</p>${scanReportsHtml}${correctionsHtml}`;
    bindExports(container);
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
    ${scanReportsHtml}
    ${correctionsHtml}
  `;

  const select = container.querySelector("#ocr-debug-select");
  const detail = container.querySelector("#ocr-debug-detail");
  bindExports(container);

  function showSelected() {
    const colis = scans[Number(select.value)];
    detail.innerHTML = `
      ${renderClassificationDetail(colis)}
      <div class="button-row" style="margin-top:10px;">
        <button type="button" id="ocr-debug-correct">${icon("pencil")}Corriger ce colis</button>
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
