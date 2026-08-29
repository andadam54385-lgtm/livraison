import { recognizeCanvasWithLines } from "./ocr.js";
import { parseAddressList } from "./parse-address-list.js";
import { matchAddress, streetSimilarity, looseCommune } from "../geocode/match-address.js";
import { formatEntry } from "../geocode/geocode-ui.js";
import { normalizeStreet, normalizeCity } from "../geocode/normalize-address.js";
import { listDistinctCities } from "../geocode/ban-index.js";
import { saveColis } from "./colis-store.js";
import { splitNumeroRue, renderReviewForm } from "./scan-ui.js";
import { getSetting } from "../settings/settings-store.js";
import { uuid } from "../lib/id.js";
import { icon } from "../ui/icons.js";
import { escapeHtml } from "../lib/escape.js";

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

// Zone-guide de cadrage : rectangle fixe (en proportion du cadre camera) que
// l'utilisateur doit remplir avec la liste -- retour terrain "OCR quasi
// inexploitable" root-cause : l'ecran du terminal filme n'occupe souvent
// qu'une petite partie du cadre (tableau de bord/main tout autour), donc le
// texte reel ne fait plus que quelques pixels de haut une fois la capture
// mise a l'echelle. On n'OCRise desormais QUE cette zone (pas le cadre
// entier) : a resolution de capture egale, le texte utile devient
// nettement plus grand, ET le fond parasite (qui pouvait faire echouer la
// segmentation de page de Tesseract) disparait entierement.
const GUIDE_INSET_X = 0.08;
const GUIDE_INSET_Y = 0.14;

function guideRectNative(videoWidth, videoHeight) {
  const x0 = Math.round(videoWidth * GUIDE_INSET_X);
  const y0 = Math.round(videoHeight * GUIDE_INSET_Y);
  const w = Math.round(videoWidth * (1 - 2 * GUIDE_INSET_X));
  const h = Math.round(videoHeight * (1 - 2 * GUIDE_INSET_Y));
  return { x0, y0, w, h };
}

// Niveaux de gris + etirement de contraste (min/max -> 0-255) : simple mais
// efficace contre les reflets/eclairage inegal d'un ecran filme a travers un
// pare-brise, qui ecrasent souvent le contraste texte/fond dont Tesseract a
// besoin. Cout negligeable (une poignee de ms) face aux 1-3s de l'OCR
// lui-meme.
function preprocessForOcr(ctx, canvas) {
  const { width, height } = canvas;
  if (width === 0 || height === 0) return;
  const imageData = ctx.getImageData(0, 0, width, height);
  const d = imageData.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const stretched = Math.min(255, Math.max(0, Math.round(((gray - min) / range) * 255)));
    d[i] = stretched;
    d[i + 1] = stretched;
    d[i + 2] = stretched;
  }
  ctx.putImageData(imageData, 0, 0);
}


// Deduplication FLOUE (pas une simple cle exacte) : bug reel corrige ici,
// retour terrain "65 arrets reels -> 240 propositions". L'OCR d'un ecran
// filme (reflets, tremblement, texte minuscule) ne relit JAMAIS deux fois le
// MEME texte a l'identique pour une meme adresse physique -- une cle exacte
// (rue+cp+ville normalises) traitait donc chaque nouvelle variante de bruit
// comme une adresse toute neuve a chaque passage de l'OCR (la boucle tourne
// en continu tant que la camera reste pointee), d'ou la multiplication.
// On compare desormais chaque nouvelle detection a celles deja retenues via
// streetSimilarity (Levenshtein + trigrammes, deja utilise pour le
// geocodage BAN) : un CP present des deux cotes doit correspondre, une ville
// presente des deux cotes doit correspondre, et la rue doit depasser
// FUZZY_DEDUP_THRESHOLD -- suffisamment tolerant au bruit OCR sans fusionner
// deux rues reellement differentes du meme secteur.
const FUZZY_DEDUP_THRESHOLD = 0.62;

export function isSameAddress(a, b) {
  if (a.cp && b.cp && a.cp !== b.cp) return false;
  const villeA = normalizeCity(a.ville || "");
  const villeB = normalizeCity(b.ville || "");
  if (villeA && villeB && villeA !== villeB) return false;
  const streetA = normalizeStreet(a.rue || "");
  const streetB = normalizeStreet(b.rue || "");
  if (!streetA || !streetB) return Boolean(villeA) && villeA === villeB;
  return streetSimilarity(streetA, streetB) >= FUZZY_DEDUP_THRESHOLD;
}

// Complete en place un brouillon deja retenu avec les champs qu'une nouvelle
// capture aurait mieux lus (ex: CP/ville absents la premiere fois, texte de
// rue plus complet) -- profite du fait que l'OCR se trompe DIFFEREMMENT a
// chaque passage plutot que de garder seulement la toute premiere lecture,
// potentiellement la plus incomplete.
export function mergeDraftInto(existing, incoming) {
  if (!existing.cp && incoming.cp) existing.cp = incoming.cp;
  if (!existing.ville && incoming.ville) existing.ville = incoming.ville;
  if (!existing.nom && incoming.nom) existing.nom = incoming.nom;
  if (incoming.rue && (!existing.rue || incoming.rue.length > existing.rue.length + 3)) existing.rue = incoming.rue;
}

// Verification BAN EN AMONT de l'ecran de revision (pas seulement au moment
// d'"Enregistrer") : retour terrain "pourquoi ne pas verifier qu'une adresse
// existe avant de la valider, pour ne pas perdre de temps ?" -- on ne peut
// pas se permettre d'ECARTER automatiquement une adresse non reconnue (l'OCR
// reste faillible : CP correctement lu mais rue mal lue, ou l'inverse, ne
// veut pas dire que l'adresse n'existe pas -- meme regle que
// bulkGeocodeAndSave/feedback-colis-ready-rule : une adresse geocodee sans
// certitude reste proposee, jamais supprimee silencieusement). En revanche,
// signaler d'emblee dans la liste de revision LESQUELLES sont deja
// reconnues (l'oeil peut les survoler) et LESQUELLES ont vraiment besoin
// d'attention concentre le temps de revision sur ce qui le merite.
async function computeGeocodePreview(draft) {
  try {
    const { numero, rue: rueSansNumero } = splitNumeroRue(draft.rue || "");
    const { best, candidates } = await matchAddress({ rue: rueSansNumero, cp: draft.cp, commune: draft.ville, numero });
    if (best) return "ok";
    if (candidates.length > 0) return "ambigu";
    return "non_geocode";
  } catch (err) {
    console.error("[batch-scan] Erreur de verification d'adresse:", err);
    return "non_geocode";
  }
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
    let captureScale = 1; // rapport capture/zone-guide, pour reconvertir les bbox OCR en espace video natif (voir drawBoxes)
    let guide = null; // zone-guide en coordonnees natives video (voir guideRectNative), calculee des que la camera est prete
    const collected = []; // drafts confirmes, dans l'ordre de detection
    // Communes connues de la base BAN locale (voir classifyBlockLines dans
    // parse-address-list.js) : seul moyen fiable de distinguer une ligne
    // "ville" d'une ligne "nom" quand un terminal les affiche chacune sur
    // leur propre ligne sans aucun autre indice (pas de chiffre, pas de
    // mot-cle de voie). Chargee une fois au demarrage du scan (le resultat
    // est deja mis en cache par listDistinctCities() lui-meme -- gratuit si
    // un autre scan a deja tourne dans la session), en parallele de
    // l'initialisation camera plus bas.
    let knownCities = new Set();
    listDistinctCities()
      .then((cities) => {
        // looseCommune (pas juste c.cn tel quel) : voir le meme choix cote
        // parse-address-list.js, tolerance aux tirets/apostrophes absents
        // d'un affichage d'ecran par rapport a l'orthographe BAN canonique.
        knownCities = new Set(cities.map((c) => looseCommune(c.cn)));
      })
      .catch((err) => console.error("[batch-scan] Échec chargement des communes connues:", err));

    function cleanup() {
      stopped = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }

    function updateCount() {
      countEl.textContent = String(collected.length);
    }

    // Dessine la zone-guide (toujours visible, pointilles) puis les cadres de
    // detection, en coordonnees NATIVES de la video : le viewBox du SVG (fixe
    // une fois pour toutes a l'initialisation, voir plus bas) se charge de la
    // mise a l'echelle vers la taille reellement affichee a l'ecran. Les bbox
    // OCR sont relatives a la capture CROPEE sur la zone-guide (voir loop()) :
    // on divise par captureScale puis on rajoute le decalage du guide pour
    // retrouver leur position dans le cadre video complet.
    function drawBoxes(results) {
      const guideRectSvg = guide
        ? `<rect x="${guide.x0}" y="${guide.y0}" width="${guide.w}" height="${guide.h}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3" stroke-dasharray="12 8" rx="12"></rect>`
        : "";
      const boxesSvg = results
        .map(({ bbox, isNew }) => {
          const x = bbox.x0 / captureScale + guide.x0;
          const y = bbox.y0 / captureScale + guide.y0;
          const w = (bbox.x1 - bbox.x0) / captureScale;
          const h = (bbox.y1 - bbox.y0) / captureScale;
          const color = isNew ? "#22c55e" : "#94a3b8";
          return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="4" rx="8"></rect>`;
        })
        .join("");
      overlay.innerHTML = guideRectSvg + boxesSvg;
    }

    // Affiche la zone-guide seule, avant meme la premiere passe OCR (qui
    // prend 1 a plusieurs secondes) -- sans ca, l'utilisateur ne voit ou
    // cadrer qu'apres un delai frustrant.
    function drawGuideOnly() {
      overlay.innerHTML = guide
        ? `<rect x="${guide.x0}" y="${guide.y0}" width="${guide.w}" height="${guide.h}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="3" stroke-dasharray="12 8" rx="12"></rect>`
        : "";
    }

    async function loop() {
      if (stopped) return;
      const loopStart = Date.now();
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const isFirstFrame = guide === null;
        guide = guideRectNative(video.videoWidth, video.videoHeight);
        if (isFirstFrame) drawGuideOnly();
        captureScale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(guide.w, guide.h));
        captureCanvas.width = Math.round(guide.w * captureScale);
        captureCanvas.height = Math.round(guide.h * captureScale);
        ctx.drawImage(video, guide.x0, guide.y0, guide.w, guide.h, 0, 0, captureCanvas.width, captureCanvas.height);
        preprocessForOcr(ctx, captureCanvas);

        try {
          const langs = (await getSetting("ocrLangs")) || "fra";
          const { lines } = await recognizeCanvasWithLines(captureCanvas, { langs });
          const drafts = parseAddressList(lines, { knownCities });

          // isNew : ne correspond (floue, voir isSameAddress) a aucun
          // brouillon deja retenu -> vient d'etre ajoutee (cadre vert).
          // Correspond a un brouillon existant -> pas rajoutee (cadre gris),
          // seulement complete si elle apporte des champs manquants
          // (mergeDraftInto) -- une meme adresse physique redonne
          // generalement un texte OCR legerement different a chaque passage.
          const boxResults = [];
          for (const draft of drafts) {
            const matchIdx = collected.findIndex((existing) => isSameAddress(existing, draft));
            const isNew = matchIdx === -1;
            if (isNew) {
              collected.push(draft);
            } else {
              mergeDraftInto(collected[matchIdx], draft);
            }
            boxResults.push({ bbox: draft.bbox, isNew });
          }
          if (!stopped) {
            drawBoxes(boxResults);
            updateCount();
            statusEl.textContent =
              collected.length > 0
                ? `${collected.length} adresse${collected.length > 1 ? "s" : ""} détectée${collected.length > 1 ? "s" : ""} — continue à balayer ou termine.`
                : "Cadre la liste dans le rectangle, au plus près…";
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
        // Retour terrain : "ça devient noir" avant meme de prendre la photo
        // -- l'attribut autoplay seul ne demarre pas toujours fiablement la
        // lecture dans Safari iOS en PWA standalone (getUserMedia reussit,
        // le flux est bien attache, mais rien ne s'affiche). Un appel EXPLICITE
        // a .play() force la lecture ; .catch() volontairement ignore (voir
        // le meme correctif dans viewfinder-ui.js).
        video.play().catch(() => {});
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
    async (drafts) => {
      if (drafts.length === 0) return [];
      // Verification BAN de tout le lot AVANT d'afficher la revision (voir
      // computeGeocodePreview) -- requetes IndexedDB locales, rapides meme
      // pour plusieurs dizaines d'entrees en parallele, mais un court
      // message evite que l'ecran semble fige pendant l'attente.
      container.innerHTML = `<div class="empty-state">Vérification des adresses…</div>`;
      const previews = await Promise.all(drafts.map((d) => computeGeocodePreview(d)));
      drafts.forEach((d, i) => {
        d.geocodePreview = previews[i];
        // Retour terrain : "au pire on oublie les noms, il prend que rue/CP/
        // ville deja connus" -- si l'adresse elle-meme ne correspond a RIEN
        // de connu dans la BAN (non_geocode), le nom capture au meme moment,
        // par le meme OCR douteux, n'a aucune raison d'etre plus fiable :
        // souvent un badge/statut d'interface non reconnu par
        // looksLikeUiChrome (ex: un mot-cle a plusieurs mots, forme non
        // couverte). Mieux vaut un champ vide (le livreur complete a la main,
        // comme n'importe quel colis sans nom) qu'un mot au hasard affiche
        // avec assurance. "ambigu" (candidats trouves mais sous le seuil de
        // confiance) garde le nom : l'adresse elle-meme est plausible, ce
        // n'est que le classement final qui est incertain.
        if (d.geocodePreview === "non_geocode") {
          d.nom = null;
        }
      });
      return renderReviewList(container, drafts);
    },
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
          // Badge de reconnaissance BAN (voir computeGeocodePreview) : jamais
          // un motif d'ecarter la ligne, seulement d'orienter l'oeil vers
          // celles qui meritent vraiment d'etre ouvertes/corrigees.
          const previewBadge =
            item.status === "pending" && item.draft.geocodePreview === "ok"
              ? `<span class="badge badge-ok">${icon("check", { spaced: false })} Reconnue</span>`
              : item.status === "pending" && item.draft.geocodePreview
                ? `<span class="badge badge-warn">À vérifier</span>`
                : "";
          return `
            <div class="card-row" style="padding:10px 0;border-bottom:1px solid var(--border);align-items:flex-start;">
              <div style="flex:1;min-width:0;">
                <div class="card-title" style="margin-bottom:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  ${item.status === "saved" ? `${icon("check", { spaced: false })} ` : ""}${escapeHtml(label)} ${previewBadge}
                </div>
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
      const reconnues = visible.filter((s) => s.status === "pending" && s.draft.geocodePreview === "ok").length;
      const aVerifier = visible.filter((s) => s.status === "pending").length - reconnues;

      container.innerHTML = `
        <div class="import-screen" style="text-align:left;">
          <h1>Vérifie les adresses (${visible.length})</h1>
          <p class="muted">
            ${reconnues} reconnue${reconnues > 1 ? "s" : ""} automatiquement, ${aVerifier} à vérifier —
            corrige ou supprime celles qui ne sont pas bonnes, les autres seront enregistrées telles quelles.
          </p>
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
