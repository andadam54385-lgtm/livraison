import { openCamera } from "./capture.js";
import { startBarcodeViewfinder } from "./viewfinder-ui.js";
import { loadImageToCanvas, cropCanvas, preprocessForOcr, attachCropSelector } from "./preprocess.js";
import { recognizeCanvas } from "./ocr.js";
import { parseUpsLabel } from "./parse-ups-label.js";
import { saveColis, isDuplicateTracking } from "./colis-store.js";
import { matchAddress } from "../geocode/match-address.js";
import { renderCandidatePicker, renderManualAddressSearch, formatEntry } from "../geocode/geocode-ui.js";
import { listDistinctCities } from "../geocode/ban-index.js";
import { normalizeCity } from "../geocode/normalize-address.js";
import { getSetting } from "../settings/settings-store.js";
import { findNearbyFavori } from "../favoris/favoris-store.js";
import { googleMapsSearchUrl } from "../tour/deep-links.js";
import { showToast } from "../lib/toast.js";
import { emit } from "../lib/event-bus.js";
import { uuid } from "../lib/id.js";

// Flux de capture/validation d'un colis (photo -> OCR -> fiche editable ->
// geocodage), independant de tout onglet : utilise a la fois par le bouton
// flottant camera (Etat A/B de l'ecran Tournee, voir tour-ui.js) et par le
// bouton "Corriger" de la fiche colis (colis-detail-ui.js). Chaque fonction
// est parametree par son `container` (pas de conteneur global module-level)
// pour rester appelable depuis n'importe quel ecran.

function escapeAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;");
}
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Separe le numero de rue (champ dedie dans la saisie manuelle) du reste --
// gere le numero en tete ("6 Rue de l'Eglise", forme la plus courante) ET en
// fin ("Rue de l'Eglise 6", forme reelle rencontree sur une etiquette UPS
// scannee, voir parse-ups-label.test.mjs cas 1). L'ancienne extraction dans
// runGeocodeAndSave ne gerait que le numero en tete (`/^(\d+)/`) : un vrai
// bug qui privait matchAddress de son bonus numero pour ce cas reel.
function splitNumeroRue(rueComplete) {
  if (!rueComplete) return { numero: "", rue: "" };
  const s = rueComplete.trim();
  let m = s.match(/^(\d+\s*(?:bis|ter|quater)?)\s+(.+)$/i);
  if (m) return { numero: m[1].trim(), rue: m[2].trim() };
  m = s.match(/^(.+?)\s+(\d+\s*(?:bis|ter|quater)?)$/i);
  if (m) return { numero: m[2].trim(), rue: m[1].trim() };
  return { numero: "", rue: s };
}

function joinNumeroRue(numero, rue) {
  const n = (numero || "").trim();
  const r = (rue || "").trim();
  return n ? `${n} ${r}`.trim() : r;
}

export async function startScanFlow(container, { onSaved } = {}) {
  try {
    // Scan live du code-barres d'abord (plus fiable que l'OCR pour le
    // tracking, suite exacte de chiffres/lettres) ; barcodeTracking vaut
    // null si rien n'est detecte / camera live indisponible / l'utilisateur
    // choisit "Prendre une photo à la place" -- dans tous ces cas on
    // enchaine quand meme sur la photo+OCR habituelle pour le nom/adresse.
    const barcodeTracking = await startBarcodeViewfinder(container);
    const file = await openCamera();
    await runOcrPipeline(container, file, { onSaved, barcodeTracking });
  } catch (err) {
    if (err.message !== "Aucune photo sélectionnée." && err.message !== "Scan annulé.") {
      console.error(err);
      container.innerHTML = `<div class="empty-state">Erreur photo: ${err.message}</div>`;
    }
    // Annulation (scan ou photo) : on laisse l'ecran appelant tel quel (pas de reset ici).
  }
}

// Repli quand le scan/OCR ne fonctionne pas ou pas bien (mauvaise photo,
// pas d'appareil photo, colis hors UPS...) : ouvre directement la fiche
// vide, sans passer par capture/recadrage/OCR.
export function startManualEntry(container, { onSaved } = {}) {
  const colis = {
    id: uuid(),
    tracking: null,
    trackingConfidence: null,
    nom: "",
    tel: "",
    telConfidence: "a_verifier",
    adresseRaw: { rue: "", cp: "", ville: "" },
    adresseAffichage: null,
    geocode: { status: "non_geocode", lat: null, lon: null, candidates: [] },
    avant12h: false,
    quantite: 1,
    statut: "a_verifier",
    source: "manuel",
    ocrRawText: "",
    dateScan: new Date().toISOString(),
  };
  renderReviewForm(container, colis, { isNew: true, duplicate: false, onSaved });
}

async function showCropStep(container, canvas) {
  return new Promise((resolve) => {
    container.innerHTML = `
      <p class="muted">Recadre l'étiquette si besoin (glisse un rectangle), ou passe directement.</p>
      <div id="crop-overlay" style="position:relative; touch-action:none;">
        <canvas id="crop-preview" style="width:100%; display:block; border-radius:12px;"></canvas>
      </div>
      <div class="button-row">
        <button type="button" id="crop-skip">Passer le recadrage</button>
        <button type="button" class="primary" id="crop-confirm" disabled>Valider le cadrage</button>
      </div>
    `;
    const previewCanvas = container.querySelector("#crop-preview");
    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
    previewCanvas.getContext("2d").drawImage(canvas, 0, 0);

    const overlay = container.querySelector("#crop-overlay");
    const confirmBtn = container.querySelector("#crop-confirm");
    let currentRect = null;

    attachCropSelector(overlay, canvas, (rect) => {
      currentRect = rect;
      confirmBtn.disabled = !rect;
    });

    container.querySelector("#crop-skip").addEventListener("click", () => resolve(null));
    confirmBtn.addEventListener("click", () => resolve(currentRect));
  });
}

async function runOcrPipeline(container, file, { onSaved, barcodeTracking } = {}) {
  container.innerHTML = `<div class="empty-state">Chargement de la photo…</div>`;
  const rawCanvas = await loadImageToCanvas(file);

  const cropRect = await showCropStep(container, rawCanvas);
  const working = cropRect ? cropCanvas(rawCanvas, cropRect) : rawCanvas;

  container.innerHTML = `<div class="empty-state">Lecture de l'étiquette (OCR)…</div>`;
  preprocessForOcr(working);

  const ocrLangs = (await getSetting("ocrLangs")) || "fra";
  const { text, confidence } = await recognizeCanvas(working, { langs: ocrLangs });
  const parsed = parseUpsLabel(text);
  // Le code-barres scanne en direct (suite exacte de caracteres) prime sur
  // le tracking devine par l'OCR (chiffres/lettres facilement confondus) --
  // voir viewfinder-ui.js.
  const tracking = barcodeTracking || parsed.tracking;

  const duplicate = tracking ? await isDuplicateTracking(tracking) : false;

  const colis = {
    id: tracking || uuid(),
    tracking,
    trackingConfidence: barcodeTracking ? "code_barre" : parsed.tracking ? "haute" : null,
    nom: parsed.nom || "",
    tel: parsed.tel || "",
    telConfidence: parsed.telConfidence,
    adresseRaw: { rue: parsed.rue || "", cp: parsed.cp || "", ville: parsed.ville || "" },
    adresseAffichage: null,
    geocode: { status: "non_geocode", lat: null, lon: null, candidates: [] },
    avant12h: false,
    quantite: 1,
    statut: "a_verifier",
    source: "ocr",
    ocrRawText: text,
    ocrConfidence: confidence,
    dateScan: new Date().toISOString(),
  };

  renderReviewForm(container, colis, { isNew: true, duplicate, onSaved });
}

// Suggestions de ville au fil de la frappe (prefixe, communes connues de la
// BAN locale) : purement une aide a la saisie, ne bloque rien -- le
// geocodage final revalide toujours via matchAddress independamment de ce
// qui est tape ici. datalist HTML n'est pas utilisable (pas de suggestions
// sur Safari iOS), d'ou cette liste custom.
function bindVilleAutocomplete(container) {
  const input = container.querySelector("#f-ville");
  const list = container.querySelector("#f-ville-suggestions");
  const cpInput = container.querySelector("#f-cp");
  let debounceTimer = null;

  function hide() {
    list.innerHTML = "";
  }

  async function showMatches(prefix) {
    const cities = await listDistinctCities();
    const matches = cities.filter((c) => c.cn.startsWith(prefix)).slice(0, 6);
    if (matches.length === 0) {
      hide();
      return;
    }
    list.innerHTML = matches
      .map((c, i) => `<button type="button" class="candidate-item" data-idx="${i}">${escapeHtml(c.c)} <span class="muted">${escapeHtml(c.cp)}</span></button>`)
      .join("");
    list.querySelectorAll(".candidate-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const picked = matches[Number(btn.dataset.idx)];
        input.value = picked.c;
        if (!cpInput.value.trim()) cpInput.value = picked.cp;
        hide();
      });
    });
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const prefix = normalizeCity(input.value.trim());
    if (prefix.length < 2) {
      hide();
      return;
    }
    debounceTimer = setTimeout(() => showMatches(prefix), 150);
  });
  input.addEventListener("blur", () => {
    // Laisse le temps au clic sur une suggestion de se declencher avant de
    // la faire disparaitre (blur tire avant click sinon).
    setTimeout(hide, 150);
  });
}

export function renderReviewForm(container, colis, { isNew, duplicate = false, onSaved } = {}) {
  const telBadge =
    colis.source === "manuel"
      ? "" // saisie directe par l'utilisateur : pas de validation croisee a afficher
      : colis.telConfidence === "haute"
        ? '<span class="badge badge-ok">confiance haute</span>'
        : '<span class="badge badge-pending">à vérifier</span>';

  // Ordre retour terrain : adresse d'abord (numero -> rue -> ville -> code
  // postal), le nom en dernier -- seule l'adresse conditionne le geocodage
  // (voir colis-ready-rule), le nom peut se determiner sur place.
  const { numero, rue: rueSansNumero } = splitNumeroRue(colis.adresseRaw.rue);

  container.innerHTML = `
    ${duplicate ? `<div class="card" style="border-color:var(--danger);"><strong>⚠ Ce tracking a déjà été scanné.</strong></div>` : ""}
    <div class="field">
      <label>Numéro</label>
      <input type="text" id="f-numero" class="field-lg" inputmode="numeric" value="${escapeAttr(numero)}">
    </div>
    <div class="field">
      <label>Rue</label>
      <input type="text" id="f-rue" class="field-lg" value="${escapeAttr(rueSansNumero)}">
    </div>
    <div class="field">
      <label>Ville</label>
      <input type="text" id="f-ville" class="field-lg" value="${escapeAttr(colis.adresseRaw.ville)}" autocomplete="off">
      <div id="f-ville-suggestions" class="candidate-list"></div>
    </div>
    <div class="field">
      <label>Code postal</label>
      <input type="text" id="f-cp" class="field-lg" inputmode="numeric" value="${escapeAttr(colis.adresseRaw.cp)}">
    </div>
    <div class="field">
      <label>Nom</label>
      <input type="text" id="f-nom" class="field-lg" value="${escapeAttr(colis.nom)}">
    </div>
    <div class="field">
      <label>Téléphone ${telBadge}</label>
      <input type="tel" id="f-tel" class="field-lg" value="${escapeAttr(colis.tel)}">
    </div>
    <div class="field">
      <label>Tracking</label>
      <input type="text" id="f-tracking" class="field-lg" value="${escapeAttr(colis.tracking)}">
    </div>
    <div class="field">
      <label>Nombre de colis à cette adresse</label>
      <input type="number" id="f-quantite" class="field-lg" inputmode="numeric" min="1" step="1" value="${colis.quantite || 1}">
    </div>
    <div class="toggle-row">
      <label for="f-avant12h">Livrer avant 12h</label>
      <input type="checkbox" id="f-avant12h" ${colis.avant12h ? "checked" : ""} style="width:26px;height:26px;">
    </div>
    <div class="button-row">
      <button type="button" id="f-rescan">Rescanner</button>
      <button type="button" class="primary btn-lg" id="f-valider">Valider</button>
    </div>
  `;

  bindVilleAutocomplete(container);

  container.querySelector("#f-rescan").addEventListener("click", () => startScanFlow(container, { onSaved }));
  container.querySelector("#f-valider").addEventListener("click", async () => {
    colis.nom = container.querySelector("#f-nom").value.trim();
    colis.tel = container.querySelector("#f-tel").value.trim();
    colis.adresseRaw = {
      rue: joinNumeroRue(container.querySelector("#f-numero").value.trim(), container.querySelector("#f-rue").value.trim()),
      cp: container.querySelector("#f-cp").value.trim(),
      ville: container.querySelector("#f-ville").value.trim(),
    };
    // Champs corriges a la main : l'ancienne adresse canonique (si un
    // geocodage precedent en avait pose une) ne correspond plus forcement,
    // on la laisse etre recalculee par le prochain geocodage reussi.
    colis.adresseAffichage = null;
    const trackingInput = container.querySelector("#f-tracking").value.trim();
    if (isNew && trackingInput && trackingInput !== colis.tracking) {
      colis.id = trackingInput; // corrige a la main avant 1ere sauvegarde -> aligne la cle
    }
    colis.tracking = trackingInput || null;
    colis.avant12h = container.querySelector("#f-avant12h").checked;
    const quantiteInput = parseInt(container.querySelector("#f-quantite").value, 10);
    colis.quantite = Number.isFinite(quantiteInput) && quantiteInput > 0 ? quantiteInput : 1;

    container.innerHTML = `<div class="empty-state">Géocodage…</div>`;
    await runGeocodeAndSave(container, colis, { onSaved });
  });
}

export async function runGeocodeAndSave(container, colis, { onSaved } = {}) {
  // Numero retire du texte compare a la BAN (entry.rn n'a jamais le numero,
  // c'est un champ separe) : le laisser dans `rue` polluait legerement la
  // similarite de rue (un "6 " ou " 6" en trop compte comme des caracteres
  // qui ne correspondent a rien), en plus de ne jamais alimenter le bonus
  // numero pour la forme "rue puis numero" (voir splitNumeroRue).
  const { numero: extractedNumero, rue: rueSansNumero } = splitNumeroRue(colis.adresseRaw.rue);
  const numero = extractedNumero || null;

  const { best, candidates } = await matchAddress({
    rue: rueSansNumero,
    cp: colis.adresseRaw.cp,
    commune: colis.adresseRaw.ville,
    numero,
  });

  if (best) {
    colis.geocode = { status: "ok", lat: best.entry.lat, lon: best.entry.lon, candidates: [] };
    // Adresse canonique de la BAN (bien casee, complete) : remplace
    // l'affichage par cette forme confirmee plutot que le texte OCR/saisi
    // brut, qui peut etre tronque ou mal casse. Ne touche jamais adresseRaw
    // (sert au matching/a l'edition), ni une quelconque forme normalisee.
    colis.adresseAffichage = formatEntry(best.entry);
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

  // Le nom n'est PAS bloquant (retour utilisateur : une adresse correcte
  // suffit, le nom peut se determiner sur place) -- seul le geocodage
  // conditionne "pret". Absence de nom : la carte affiche l'adresse en titre
  // a la place (voir renderPrepCard/renderStopCard/renderHeroCard), simple
  // repli d'affichage, pas un blocage de statut.
  colis.statut = colis.geocode.status === "ok" ? "pret" : "a_verifier";

  await saveColis(colis);
  emit("colis:saved", { colis });

  if (colis.geocode.status === "ok") {
    await warnIfFavoriMatch(colis);
    onSaved?.(colis);
  } else {
    renderGeocodePicker(container, colis, { onSaved });
  }
}

// Alerte le livreur quand un colis fraichement geocode correspond a une
// adresse deja notee en favori (ex: code portail, consigne de livraison).
async function warnIfFavoriMatch(colis) {
  const fav = await findNearbyFavori(colis.geocode.lat, colis.geocode.lon);
  if (fav && fav.note) {
    showToast(`⭐ Adresse favorite : ${fav.note}`, { variant: "warn", durationMs: 7000 });
  }
}

// Parse "48.6921, 6.1844" (ou variantes d'espacement) -- format qu'on
// retrouve tel quel quand on fait un appui long sur un point Google Maps puis
// "Copier les coordonnees". Retourne null si la latitude/longitude n'est pas
// un nombre plausible plutot que de planter le geocodage manuel.
function parseLatLon(text) {
  const parts = String(text || "").split(",").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lat, lon] = parts;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function renderGeocodePicker(container, colis, { onSaved }) {
  const rawQuery = `${colis.adresseRaw.rue} ${colis.adresseRaw.cp} ${colis.adresseRaw.ville}`.trim();
  container.innerHTML = `
    <div class="card">
      <div class="card-title">Adresse à confirmer</div>
      <p class="muted">${escapeAttr(colis.adresseRaw.rue)}, ${escapeAttr(colis.adresseRaw.cp)} ${escapeAttr(colis.adresseRaw.ville)}</p>
    </div>
    <div id="geocode-picker-slot"></div>
    <div class="card" style="margin-top:8px;">
      <div class="card-title">Introuvable ? (entreprise, zone industrielle…)</div>
      <p class="muted">La BAN ne connaît que les adresses officielles, pas les noms d'entreprise. Cherche sur Google Maps, puis fais un appui long sur le point → "Copier les coordonnées", et colle-les ici.</p>
      <a class="btn-link" href="${googleMapsSearchUrl(rawQuery)}" target="_blank" rel="noopener">🔍 Chercher "${escapeHtml(rawQuery)}" sur Google Maps</a>
      <div class="field" style="margin-top:10px;">
        <label>Coordonnées GPS collées</label>
        <input type="text" id="geocode-manual-coords" class="field-lg" placeholder="ex: 48.6921, 6.1844" inputmode="decimal">
      </div>
      <button type="button" id="geocode-manual-coords-btn">Valider ces coordonnées</button>
    </div>
    <div class="button-row">
      <button type="button" id="geocode-later">Plus tard (revoir dans la liste)</button>
    </div>
  `;
  const slot = container.querySelector("#geocode-picker-slot");

  async function acceptEntry(entry) {
    colis.geocode = { status: "ok", lat: entry.lat, lon: entry.lon, candidates: [] };
    colis.adresseAffichage = formatEntry(entry);
    colis.statut = "pret"; // adresse confirmee ici (choix manuel/candidat) -> le nom n'est pas bloquant
    await saveColis(colis);
    emit("colis:saved", { colis });
    await warnIfFavoriMatch(colis);
    onSaved?.(colis);
  }

  // Meme chemin que acceptEntry mais sans entree BAN (pas de nom d'entreprise
  // dans ce registre) : adresseAffichage reste null, formatAdresseAffichage()
  // se rabat alors sur adresseRaw (le texte scanne/tape, ex: le nom de
  // l'entreprise) pour l'affichage.
  async function acceptManualCoords(lat, lon) {
    colis.geocode = { status: "ok", lat, lon, candidates: [], manual: true };
    colis.statut = "pret";
    await saveColis(colis);
    emit("colis:saved", { colis });
    await warnIfFavoriMatch(colis);
    onSaved?.(colis);
  }

  function showManual() {
    renderManualAddressSearch(slot, {
      initialQuery: `${colis.adresseRaw.rue} ${colis.adresseRaw.cp}`.trim(),
      onPick: acceptEntry,
      onCancel: () => renderGeocodePicker(container, colis, { onSaved }),
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

  container.querySelector("#geocode-manual-coords-btn").addEventListener("click", () => {
    const parsed = parseLatLon(container.querySelector("#geocode-manual-coords").value);
    if (!parsed) {
      showToast("⚠ Coordonnées invalides (format attendu : 48.6921, 6.1844)");
      return;
    }
    acceptManualCoords(parsed.lat, parsed.lon);
  });
  container.querySelector("#geocode-later").addEventListener("click", () => onSaved?.(colis));
}
