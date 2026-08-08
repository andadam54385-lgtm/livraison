import { recognizeCanvasWithLines } from "./ocr.js";
import { parseAddressList } from "./parse-address-list.js";
import { matchAddress } from "../geocode/match-address.js";
import { formatEntry } from "../geocode/geocode-ui.js";
import { normalizeStreet, normalizeCity } from "../geocode/normalize-address.js";
import { saveColis } from "./colis-store.js";
import { splitNumeroRue, renderReviewForm } from "./scan-ui.js";
import { getSetting } from "../settings/settings-store.js";
import { uuid } from "../lib/id.js";
import { icon } from "../ui/icons.js";

// Scan en rafale : filme un ECRAN affichant plusieurs adresses a la fois
// (ex: appli/portail du transporteur listant une tournee), par opposition au
// scan habituel (une etiquette imprimee = une photo = un colis, voir
// scan-ui.js/startScanFlow, totalement inchange -- ce module est un point
// d'entree ADDITIONNEL, pas un remplacement). Camera live (comme le scan
// code-barres, voir viewfinder-ui.js) : analyse en continu, un cadre vert
// s'affiche sur chaque adresse reconnue, gris si deja vue plus tot pendant
// le meme balayage (evite les doublons quand on scrolle et qu'une meme
// adresse repasse a l'ecran -- chaque adresse n'existe normalement qu'une
// fois dans la liste source, voir discussion). A la fin, ecran de revision
// avant enregistrement (correction/suppression possibles).
//
// L'OCR (Tesseract) prend reellement 1 a plusieurs secondes par image sur
// mobile -- impossible de traiter chaque frame video. La boucle capture une
// image, lance l'OCR, attend le resultat, puis recommence : le debit reel
// depend de la vitesse de l'appareil, pas d'un framerate fixe.

const OCR_MIN_INTERVAL_MS = 400; // pause mini entre 2 passes meme si l'OCR est tres rapide sur l'appareil
const MAX_CAPTURE_DIMENSION = 1400; // plus grand que le decodage code-barres (900px) : l'OCR a besoin de plus de details qu'un simple code-barres

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Cle de deduplication : rue+cp+ville normalises (meme normalisation que le
// geocodage, coherent avec le reste de l'appli) -- le nom n'entre pas dans
// la cle (souvent absent/variable), l'adresse suffit a identifier un client.
function draftKey(draft) {
  return `${normalizeStreet(draft.rue || "")}|${draft.cp || ""}|${normalizeCity(draft.ville || "")}`;
}

function draftToColis(draft) {
  return {
    id: uuid(),
    dateScan: new Date().toISOString(),
    source: "ocr-liste",
    ocrRawText: (draft.rawLines || []).join("\n"),
    ocrConfidence: null,
    nom: draft.nom || "",
    tel: "",
    tracking: null,
    adresseRaw: { rue: draft.rue || "", cp: draft.cp || "", ville: draft.ville || "" },
    adresseAffichage: null,
    geocode: { status: "pending", lat: null, lon: null, candidates: [] },
    statut: "a_verifier",
    quantite: 1,
    avant12h: false,
  };
}

// Variante "silencieuse" de runGeocodeAndSave (scan-ui.js) : celle-ci ouvre
// un picker interactif des que le geocodage est ambigu, inutilisable pour
// traiter N colis d'affilee sans intervention. Ici, un geocodage ambigu ou
// manque enregistre quand meme le colis en statut "a_verifier" -- meme
// convention que partout ailleurs dans l'appli (voir feedback-colis-ready-
// rule) : il reste modifiable ensuite comme n'importe quel colis "a
// verifier", pas besoin d'un circuit de resolution dedie ici.
async function bulkGeocodeAndSave(colis) {
  const { numero, rue: rueSansNumero } = splitNumeroRue(colis.adresseRaw.rue);
  const { best, candidates } = await matchAddress({
    rue: rueSansNumero,
    cp: colis.adresseRaw.cp,
    commune: colis.adresseRaw.ville,
    numero,
  });
  if (best) {
    colis.geocode = { status: "ok", lat: best.entry.lat, lon: best.entry.lon, candidates: [] };
    colis.adresseAffichage = formatEntry(best.entry);
    colis.statut = "pret";
  } else if (candidates.length > 0) {
    colis.geocode = { status: "ambigu", lat: null, lon: null, candidates: candidates.map((c) => ({ ...c.entry, score: c.score })) };
    colis.statut = "a_verifier";
  } else {
    colis.geocode = { status: "non_geocode", lat: null, lon: null, candidates: [] };
    colis.statut = "a_verifier";
  }
  await saveColis(colis);
  return colis;
}

// Resout avec le tableau des colis finalement enregistres (peut etre vide si
// tout est annule/supprime), ou rejette si l'utilisateur annule avant meme
// d'avoir rien detecte.
export function startBatchScan(container) {
  return new Promise((resolve, reject) => {
    container.innerHTML = `
      <div class="batch-viewfinder-wrap">
        <video id="batch-video" autoplay playsinline muted></video>
        <svg id="batch-overlay" class="batch-overlay"></svg>
      </div>
      <p class="muted" id="batch-status" style="text-align:center;margin-top:8px;">Initialisation de la caméra…</p>
      <div class="button-row">
        <button type="button" id="batch-cancel">Annuler</button>
        <button type="button" class="primary" id="batch-finish">${icon("check")}Terminer (<span id="batch-count">0</span>)</button>
      </div>
    `;

    const video = container.querySelector("#batch-video");
    const overlay = container.querySelector("#batch-overlay");
    const statusEl = container.querySelector("#batch-status");
    const countEl = container.querySelector("#batch-count");
    const captureCanvas = document.createElement("canvas");
    const ctx = captureCanvas.getContext("2d", { willReadFrequently: true });

    let stream = null;
    let stopped = false;
    let captureScale = 1; // rapport capture/native, pour reconvertir les bbox OCR en espace video natif (voir drawBoxes)
    const collected = []; // drafts confirmes, dans l'ordre de detection
    const seenKeys = new Set();

    function cleanup() {
      stopped = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }

    function updateCount() {
      countEl.textContent = String(collected.length);
    }

    // Dessine les cadres directement en coordonnees NATIVES de la video : le
    // viewBox du SVG (fixe une fois pour toutes a l'initialisation, voir plus
    // bas) se charge de la mise a l'echelle vers la taille reellement
    // affichee a l'ecran -- aucun calcul de scale/offset a refaire ici, y
        // compris si la fenetre est redimensionnee.
    function drawBoxes(results) {
      overlay.innerHTML = results
        .map(({ bbox, isNew }) => {
          const x = bbox.x0 / captureScale;
          const y = bbox.y0 / captureScale;
          const w = (bbox.x1 - bbox.x0) / captureScale;
          const h = (bbox.y1 - bbox.y0) / captureScale;
          const color = isNew ? "#22c55e" : "#94a3b8";
          return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="4" rx="8"></rect>`;
        })
        .join("");
    }

    async function loop() {
      if (stopped) return;
      const loopStart = Date.now();
      if (video.readyState >= 2 && video.videoWidth > 0) {
        captureScale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
        captureCanvas.width = Math.round(video.videoWidth * captureScale);
        captureCanvas.height = Math.round(video.videoHeight * captureScale);
        ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

        try {
          const langs = (await getSetting("ocrLangs")) || "fra";
          const { lines } = await recognizeCanvasWithLines(captureCanvas, { langs });
          const drafts = parseAddressList(lines);

          // isNew : jamais vue avant dans ce balayage -> vient d'etre ajoutee
          // (cadre vert). Deja vue (le scroll repasse dessus) -> cadre gris,
          // pas rajoutee (une adresse n'existe normalement qu'une fois).
          const boxResults = [];
          for (const draft of drafts) {
            const key = draftKey(draft);
            const isNew = !seenKeys.has(key);
            if (isNew) {
              seenKeys.add(key);
              collected.push(draft);
            }
            boxResults.push({ bbox: draft.bbox, isNew });
          }
          if (!stopped) {
            drawBoxes(boxResults);
            updateCount();
            statusEl.textContent =
              collected.length > 0
                ? `${collected.length} adresse${collected.length > 1 ? "s" : ""} détectée${collected.length > 1 ? "s" : ""} — continue à balayer ou termine.`
                : "Vise la liste d'adresses…";
          }
        } catch (err) {
          console.error("[batch-scan] Erreur OCR:", err);
        }
      }
      const elapsed = Date.now() - loopStart;
      if (!stopped) setTimeout(loop, Math.max(0, OCR_MIN_INTERVAL_MS - elapsed));
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        video.srcObject = s;
        video.addEventListener(
          "loadedmetadata",
          () => {
            overlay.setAttribute("viewBox", `0 0 ${video.videoWidth} ${video.videoHeight}`);
            loop();
          },
          { once: true }
        );
      })
      .catch((err) => {
        cleanup();
        container.innerHTML = `
          <div class="card" style="border-color:var(--danger);">
            <div class="card-title">${icon("alert-triangle")}Caméra indisponible</div>
            <p class="muted">${escapeHtml(err?.message || String(err))}</p>
          </div>
          <div class="button-row"><button type="button" id="batch-cancel-err">Retour</button></div>
        `;
        container.querySelector("#batch-cancel-err").addEventListener("click", () => reject(new Error("Scan annulé.")));
      });

    container.querySelector("#batch-cancel").addEventListener("click", () => {
      cleanup();
      reject(new Error("Scan annulé."));
    });
    container.querySelector("#batch-finish").addEventListener("click", () => {
      cleanup();
      resolve(collected.slice());
    });
  }).then(
    (drafts) => (drafts.length === 0 ? [] : renderReviewList(container, drafts)),
    (err) => {
      throw err;
    }
  );
}

// Ecran de revision post-scan : une ligne par adresse detectee, correction
// (reutilise le meme formulaire que le scan normal) ou suppression
// possibles avant l'enregistrement groupe -- rien n'est enregistre tant que
// l'utilisateur n'a pas valide "Enregistrer" (ou corrige une ligne
// individuellement, qui s'enregistre alors immediatement, meme
// comportement que "Corriger ce colis" dans le debug OCR).
function renderReviewList(container, drafts) {
  return new Promise((resolve) => {
    const state = drafts.map((d) => ({ draft: d, status: "pending", savedColis: null }));

    function render() {
      const visible = state.filter((s) => s.status !== "discarded");
      const rows = visible
        .map((item) => {
          const idx = state.indexOf(item);
          const label = item.draft.nom || [item.draft.rue, item.draft.ville].filter(Boolean).join(", ") || "(adresse incomplète)";
          const sub = [item.draft.rue, `${item.draft.cp || ""} ${item.draft.ville || ""}`.trim()].filter(Boolean).join(" — ");
          return `
            <div class="card-row" style="padding:10px 0;border-bottom:1px solid var(--border);align-items:flex-start;">
              <div style="flex:1;min-width:0;">
                <div class="card-title" style="margin-bottom:0;">${item.status === "saved" ? `${icon("check", { spaced: false })} ` : ""}${escapeHtml(label)}</div>
                <div class="muted" style="font-size:0.85rem;">${escapeHtml(sub || "(adresse incomplète)")}</div>
              </div>
              ${
                item.status === "pending"
                  ? `<div class="stop-row-actions">
                       <button type="button" class="stop-row-btn" data-correct="${idx}" aria-label="Corriger">${icon("pencil", { spaced: false })}</button>
                       <button type="button" class="stop-row-btn" data-discard="${idx}" aria-label="Supprimer">${icon("x", { spaced: false })}</button>
                     </div>`
                  : ""
              }
            </div>
          `;
        })
        .join("");

      const pendingCount = state.filter((s) => s.status === "pending").length;

      container.innerHTML = `
        <div class="import-screen" style="text-align:left;">
          <h1>Vérifie les adresses (${visible.length})</h1>
          <p class="muted">Corrige ou supprime celles qui ne sont pas bonnes -- les autres seront enregistrées telles quelles.</p>
          <div>${rows || `<p class="muted">Plus rien à enregistrer.</p>`}</div>
          <div class="button-row" style="margin-top:14px;">
            <button type="button" id="batch-review-cancel">Tout annuler</button>
            <button type="button" class="primary" id="batch-review-save">${icon("check")}Enregistrer (${pendingCount})</button>
          </div>
        </div>
      `;

      container.querySelectorAll("[data-correct]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.correct);
          const colis = draftToColis(state[idx].draft);
          renderReviewForm(container, colis, {
            isNew: true,
            duplicate: false,
            onSaved: (savedColis) => {
              state[idx].status = "saved";
              state[idx].savedColis = savedColis;
              render();
            },
          });
        });
      });
      container.querySelectorAll("[data-discard]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state[Number(btn.dataset.discard)].status = "discarded";
          render();
        });
      });
      container.querySelector("#batch-review-cancel").addEventListener("click", () => {
        resolve(state.filter((s) => s.status === "saved").map((s) => s.savedColis));
      });
      container.querySelector("#batch-review-save").addEventListener("click", async () => {
        const btn = container.querySelector("#batch-review-save");
        btn.disabled = true;
        btn.textContent = "Enregistrement…";
        for (const item of state) {
          if (item.status === "pending") {
            const colis = draftToColis(item.draft);
            await bulkGeocodeAndSave(colis);
            item.status = "saved";
            item.savedColis = colis;
          }
        }
        resolve(state.filter((s) => s.status === "saved").map((s) => s.savedColis));
      });
    }

    render();
  });
}
