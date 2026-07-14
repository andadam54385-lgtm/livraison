import { openCamera } from "./capture.js";
import { loadImageToCanvas, cropCanvas, preprocessForOcr, attachCropSelector } from "./preprocess.js";
import { recognizeCanvas } from "./ocr.js";
import { parseUpsLabel } from "./parse-ups-label.js";
import { saveColis, isDuplicateTracking, listAllColis, getColis } from "./colis-store.js";
import { matchAddress } from "../geocode/match-address.js";
import { renderCandidatePicker, renderManualAddressSearch } from "../geocode/geocode-ui.js";
import { getSetting } from "../settings/settings-store.js";
import { emit } from "../lib/event-bus.js";
import { uuid } from "../lib/id.js";

let fabBound = false;
let containerRef = null;

export async function mount(container) {
  containerRef = container;
  if (!fabBound) {
    document.getElementById("scan-fab").addEventListener("click", () => startScanFlow());
    fabBound = true;
  }
  await renderList();
}

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}

function badgeForStatut(statut) {
  if (statut === "pret") return `<span class="badge badge-ok">Prêt</span>`;
  if (statut === "en_tournee") return `<span class="badge badge-ok">En tournée</span>`;
  if (statut === "livre") return `<span class="badge badge-ok">Livré</span>`;
  return `<span class="badge badge-warn">À vérifier</span>`;
}

function renderColisCard(c) {
  const adresse = `${c.adresseRaw?.rue || "(adresse à vérifier)"}, ${c.adresseRaw?.cp || ""} ${c.adresseRaw?.ville || ""}`;
  return `
    <div class="card" data-colis-id="${escapeAttr(c.id)}">
      <div class="card-row">
        <div class="card-title">${c.nom || "(nom inconnu)"}</div>
        ${badgeForStatut(c.statut)}
      </div>
      <div class="muted">${adresse}</div>
      ${c.avant12h ? `<span class="badge badge-warn" style="margin-top:4px;">Avant 12h</span>` : ""}
    </div>
  `;
}

async function renderList() {
  const colis = await listAllColis();
  const total = colis.length;
  const issues = colis.filter((c) => c.statut === "a_verifier").length;
  const totalEl = document.getElementById("scan-count-total");
  const issuesEl = document.getElementById("scan-count-issues");
  if (totalEl) totalEl.textContent = `${total} colis`;
  if (issuesEl) issuesEl.textContent = `${issues} à vérifier`;

  if (colis.length === 0) {
    containerRef.innerHTML = `<div class="empty-state">Aucun colis scanné. Appuie sur 📷 pour commencer.</div>`;
    return;
  }

  containerRef.innerHTML = colis
    .slice()
    .reverse()
    .map((c) => renderColisCard(c))
    .join("");

  containerRef.querySelectorAll("[data-colis-id]").forEach((el) => {
    el.addEventListener("click", () => reviewExistingColis(el.dataset.colisId));
  });
}

async function reviewExistingColis(id) {
  const colis = await getColis(id);
  if (!colis) return;
  renderReviewForm(colis, { isNew: false });
}

async function startScanFlow() {
  try {
    const file = await openCamera();
    await runOcrPipeline(file);
  } catch (err) {
    if (err.message !== "Aucune photo sélectionnée.") {
      console.error(err);
      containerRef.innerHTML = `<div class="empty-state">Erreur photo: ${err.message}</div>`;
    } else {
      renderList();
    }
  }
}

async function showCropStep(canvas) {
  return new Promise((resolve) => {
    containerRef.innerHTML = `
      <p class="muted">Recadre l'étiquette si besoin (glisse un rectangle), ou passe directement.</p>
      <div id="crop-overlay" style="position:relative; touch-action:none;">
        <canvas id="crop-preview" style="width:100%; display:block; border-radius:12px;"></canvas>
      </div>
      <div class="button-row">
        <button type="button" id="crop-skip">Passer le recadrage</button>
        <button type="button" class="primary" id="crop-confirm" disabled>Valider le cadrage</button>
      </div>
    `;
    const previewCanvas = containerRef.querySelector("#crop-preview");
    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
    previewCanvas.getContext("2d").drawImage(canvas, 0, 0);

    const overlay = containerRef.querySelector("#crop-overlay");
    const confirmBtn = containerRef.querySelector("#crop-confirm");
    let currentRect = null;

    attachCropSelector(overlay, canvas, (rect) => {
      currentRect = rect;
      confirmBtn.disabled = !rect;
    });

    containerRef.querySelector("#crop-skip").addEventListener("click", () => resolve(null));
    confirmBtn.addEventListener("click", () => resolve(currentRect));
  });
}

async function runOcrPipeline(file) {
  containerRef.innerHTML = `<div class="empty-state">Chargement de la photo…</div>`;
  const rawCanvas = await loadImageToCanvas(file);

  const cropRect = await showCropStep(rawCanvas);
  const working = cropRect ? cropCanvas(rawCanvas, cropRect) : rawCanvas;

  containerRef.innerHTML = `<div class="empty-state">Lecture de l'étiquette (OCR)…</div>`;
  preprocessForOcr(working);

  const ocrLangs = (await getSetting("ocrLangs")) || "fra";
  const { text, confidence } = await recognizeCanvas(working, { langs: ocrLangs });
  const parsed = parseUpsLabel(text);

  const duplicate = parsed.tracking ? await isDuplicateTracking(parsed.tracking) : false;

  const colis = {
    id: parsed.tracking || uuid(),
    tracking: parsed.tracking,
    trackingConfidence: parsed.tracking ? "haute" : null,
    nom: parsed.nom || "",
    tel: parsed.tel || "",
    telConfidence: parsed.telConfidence,
    adresseRaw: { rue: parsed.rue || "", cp: parsed.cp || "", ville: parsed.ville || "" },
    geocode: { status: "non_geocode", lat: null, lon: null, candidates: [] },
    avant12h: false,
    statut: "a_verifier",
    ocrRawText: text,
    ocrConfidence: confidence,
    dateScan: new Date().toISOString(),
  };

  renderReviewForm(colis, { isNew: true, duplicate });
}

function renderReviewForm(colis, { isNew, duplicate = false }) {
  const telBadge =
    colis.telConfidence === "haute"
      ? '<span class="badge badge-ok">confiance haute</span>'
      : '<span class="badge badge-warn">à vérifier</span>';

  containerRef.innerHTML = `
    ${duplicate ? `<div class="card" style="border-color:var(--danger);"><strong>⚠ Ce tracking a déjà été scanné.</strong></div>` : ""}
    <div class="field">
      <label>Nom</label>
      <input type="text" id="f-nom" value="${escapeAttr(colis.nom)}">
    </div>
    <div class="field">
      <label>Téléphone ${telBadge}</label>
      <input type="tel" id="f-tel" value="${escapeAttr(colis.tel)}">
    </div>
    <div class="field">
      <label>Rue</label>
      <input type="text" id="f-rue" value="${escapeAttr(colis.adresseRaw.rue)}">
    </div>
    <div class="field">
      <label>Code postal</label>
      <input type="text" id="f-cp" inputmode="numeric" value="${escapeAttr(colis.adresseRaw.cp)}">
    </div>
    <div class="field">
      <label>Ville</label>
      <input type="text" id="f-ville" value="${escapeAttr(colis.adresseRaw.ville)}">
    </div>
    <div class="field">
      <label>Tracking</label>
      <input type="text" id="f-tracking" value="${escapeAttr(colis.tracking)}">
    </div>
    <div class="toggle-row">
      <label for="f-avant12h">Livrer avant 12h</label>
      <input type="checkbox" id="f-avant12h" ${colis.avant12h ? "checked" : ""} style="width:24px;height:24px;">
    </div>
    <div class="button-row">
      <button type="button" id="f-rescan">Rescanner</button>
      <button type="button" class="primary" id="f-valider">Valider</button>
    </div>
  `;

  containerRef.querySelector("#f-rescan").addEventListener("click", () => startScanFlow());
  containerRef.querySelector("#f-valider").addEventListener("click", async () => {
    colis.nom = containerRef.querySelector("#f-nom").value.trim();
    colis.tel = containerRef.querySelector("#f-tel").value.trim();
    colis.adresseRaw = {
      rue: containerRef.querySelector("#f-rue").value.trim(),
      cp: containerRef.querySelector("#f-cp").value.trim(),
      ville: containerRef.querySelector("#f-ville").value.trim(),
    };
    const trackingInput = containerRef.querySelector("#f-tracking").value.trim();
    if (isNew && trackingInput && trackingInput !== colis.tracking) {
      colis.id = trackingInput; // corrige a la main avant 1ere sauvegarde -> aligne la cle
    }
    colis.tracking = trackingInput || null;
    colis.avant12h = containerRef.querySelector("#f-avant12h").checked;

    containerRef.innerHTML = `<div class="empty-state">Géocodage…</div>`;
    await runGeocodeAndSave(colis);
  });
}

async function runGeocodeAndSave(colis) {
  const numeroMatch = (colis.adresseRaw.rue || "").match(/^(\d+)/);
  const numero = numeroMatch ? numeroMatch[1] : null;

  const { best, candidates } = await matchAddress({
    rue: colis.adresseRaw.rue,
    cp: colis.adresseRaw.cp,
    commune: colis.adresseRaw.ville,
    numero,
  });

  if (best) {
    colis.geocode = { status: "ok", lat: best.entry.lat, lon: best.entry.lon, candidates: [] };
  } else if (candidates.length > 0) {
    colis.geocode = {
      status: "ambigu",
      lat: null,
      lon: null,
      candidates: candidates.map((c) => ({ ...c.entry, score: c.score })),
    };
  } else {
    colis.geocode = { status: "non_geocode", lat: null, lon: null, candidates: [] };
  }

  colis.statut = colis.geocode.status === "ok" && colis.telConfidence === "haute" ? "pret" : "a_verifier";

  await saveColis(colis);
  emit("colis:saved", { colis });

  if (colis.geocode.status === "ok") {
    renderList();
  } else {
    renderGeocodePicker(colis);
  }
}

function renderGeocodePicker(colis) {
  containerRef.innerHTML = `
    <div class="card">
      <div class="card-title">Adresse à confirmer</div>
      <p class="muted">${escapeAttr(colis.adresseRaw.rue)}, ${escapeAttr(colis.adresseRaw.cp)} ${escapeAttr(colis.adresseRaw.ville)}</p>
    </div>
    <div id="geocode-picker-slot"></div>
    <div class="button-row">
      <button type="button" id="geocode-later">Plus tard (revoir dans la liste)</button>
    </div>
  `;
  const slot = containerRef.querySelector("#geocode-picker-slot");

  async function acceptEntry(entry) {
    colis.geocode = { status: "ok", lat: entry.lat, lon: entry.lon, candidates: [] };
    colis.statut = colis.telConfidence === "haute" ? "pret" : "a_verifier";
    await saveColis(colis);
    emit("colis:saved", { colis });
    renderList();
  }

  function showManual() {
    renderManualAddressSearch(slot, {
      initialQuery: `${colis.adresseRaw.rue} ${colis.adresseRaw.cp}`.trim(),
      onPick: acceptEntry,
      onCancel: () => renderGeocodePicker(colis),
    });
  }

  if (colis.geocode.candidates.length > 0) {
    renderCandidatePicker(slot, {
      candidates: colis.geocode.candidates.map((c) => ({ entry: c, score: c.score })),
      onPick: acceptEntry,
      onManual: showManual,
    });
  } else {
    showManual();
  }

  containerRef.querySelector("#geocode-later").addEventListener("click", () => renderList());
}
