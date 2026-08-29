import { openCamera } from "./capture.js";
import { startBarcodeViewfinder } from "./viewfinder-ui.js";
import { loadImageToCanvas, cropCanvas, preprocessForOcr, attachCropSelector } from "./preprocess.js";
import { recognizeCanvas } from "./ocr.js";
import { parseUpsLabel } from "./parse-ups-label.js";
import { saveColis, isDuplicateTracking } from "./colis-store.js";
import { recordCorrectionIfNeeded } from "./ocr-corrections-store.js";
import { matchAddress, looseCommune } from "../geocode/match-address.js";
import { renderCandidatePicker, renderManualAddressSearch, formatEntry } from "../geocode/geocode-ui.js";
import { listDistinctCities, queryByStreetPrefix, queryByCp } from "../geocode/ban-index.js";
import { normalizeCity, normalizeStreet } from "../geocode/normalize-address.js";
import { getSetting } from "../settings/settings-store.js";
import { findNearbyFavori } from "../favoris/favoris-store.js";
import { googleMapsSearchUrl } from "../tour/deep-links.js";
import { showToast } from "../lib/toast.js";
import { emit } from "../lib/event-bus.js";
import { uuid } from "../lib/id.js";
import { icon } from "../ui/icons.js";

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
//
// Bug reel corrige ici (retour terrain : "accepte pas les bis ou les a/b") :
// le suffixe de repetition ne reconnaissait que les mots complets
// bis/ter/quater, jamais une lettre seule (6A, 6B...), pourtant tout aussi
// courante sur une adresse francaise. "6a Rue de l'Eglise" (colle, sans
// espace) ne matchait NI le motif "numero en tete" NI celui "numero en fin"
// -- toute la chaine retombait en "rue" avec un numero vide, faisant perdre
// le bonus numero du matching ET polluant la comparaison de similarite de
// rue avec un "6a" parasite. La lettre seule est testee apres les mots
// complets (jamais avant) et exige une frontiere de mot juste apres, pour
// ne jamais confondre la premiere lettre du nom de rue qui suit avec un
// suffixe ("6 Rue..." ne doit jamais lire "R" comme un suffixe -- "R" est
// suivi de "u", pas d'une frontiere de mot, donc rejete).
const REP_SUFFIX_WORDS = "bis|ter|quater|quinquies";
// Exportee pour reutilisation par batch-scan-ui.js (scan en rafale, plusieurs
// adresses par photo) -- meme logique d'extraction numero/suffixe que la
// saisie manuelle, pas de raison de la dupliquer.
export function splitNumeroRue(rueComplete) {
  if (!rueComplete) return { numero: "", rue: "" };
  const s = rueComplete.trim();
  let m = s.match(new RegExp(`^(\\d+)\\s?(${REP_SUFFIX_WORDS})\\b\\.?\\s*(.*)$`, "i"));
  if (m) return { numero: `${m[1]} ${m[2]}`.trim(), rue: m[3].trim() };
  m = s.match(/^(\d+)\s?([a-z])\b\.?\s+(.+)$/i);
  if (m) return { numero: `${m[1]}${m[2]}`.trim(), rue: m[3].trim() };
  m = s.match(/^(\d+)\s+(.+)$/);
  if (m) return { numero: m[1].trim(), rue: m[2].trim() };
  m = s.match(new RegExp(`^(.+?)\\s+(\\d+\\s?(?:${REP_SUFFIX_WORDS}|[a-z])?)$`, "i"));
  if (m) return { numero: m[2].replace(/\s+/g, "").trim(), rue: m[1].trim() };
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

// Isole numero / rue / CP-deja-tape / debut-de-ville-deja-tape d'une saisie
// EN CONTINU sur une seule ligne ("4 rue des jardins", puis en continuant a
// taper "4 rue des jardins 54000" ou "4 rue des jardins nancy"). Bug reel
// corrige ici, retour terrain : "je met 4 rue des jardins il propose des
// choses[,] quand je met le debut du village ou le code postal[,] plus de
// proposition" -- avant ce correctif, TOUT ce qui suivait le numero
// (y compris le CP/la ville qu'on continue de taper a la suite) partait
// dans la recherche de nom de RUE, qui ne matchait plus rien des qu'on
// depassait la rue elle-meme (aucune vraie rue ne s'appelle "rue des
// jardins nancy"). Coupe au premier signal clair de transition rue ->
// ville/CP : un groupe de 5 chiffres consecutifs (code postal), ou une
// virgule -- signaux non ambigus, toujours appliques.
//
// allowPartialCp (repli LEGER, pas de requete BAN supplementaire) : le CP
// se tape chiffre par chiffre -- avant que les 5 chiffres complets ne soient
// atteints, "4 rue des jardins 88" n'etait reconnu par AUCUN signal (ni CP
// complet, ni virgule), donc traite comme une rue "rue des jardins 88" qui
// ne matche jamais rien -- les suggestions disparaissaient pendant toute la
// frappe du CP, pas seulement une fois les 5 chiffres tapes. Coupe un groupe
// de 1 a 4 chiffres FINAL comme CP en cours de frappe.
//
// knownCityPrefixes (optionnel, noms de commune deja normalises via
// looseCommune+normalizeCity) : repli pour une ville collee SANS aucune
// ponctuation ni CP ("rue des jardins nancy"), en testant si les 1 a 3
// derniers mots forment le debut d'une commune CONNUE.
//
// Les deux replis sont volontairement PAS appliques par defaut (voir
// bindAdresseAutocomplete) : une vraie rue peut se terminer par un chiffre
// ("Route Nationale 4") ou un mot qui ressemble a une commune ("Rue de
// Nancy" existe ailleurs qu'a Nancy) -- ne sont tentes qu'en repli, apres
// qu'une recherche sans coupure n'a rien trouve, jamais en premier essai.
function splitVilleSuffix(street, knownCityPrefixes) {
  const words = street.split(/\s+/).filter(Boolean);
  for (let take = Math.min(3, words.length - 1); take >= 1; take--) {
    const tail = words.slice(words.length - take).join(" ");
    const tailNorm = looseCommune(normalizeCity(tail));
    if (tailNorm.length >= 2 && knownCityPrefixes.some((p) => p.startsWith(tailNorm))) {
      return { street: words.slice(0, words.length - take).join(" "), villeTyped: tail };
    }
  }
  return null;
}

export function splitAdresseInput(rawInput, { knownCityPrefixes = null, allowPartialCp = false } = {}) {
  const { numero, rue: afterNumero } = splitNumeroRue(rawInput);
  let street = afterNumero || rawInput || "";
  let cpTyped = "";
  let villeTyped = "";

  const cpMatch = street.match(/^(.*?)[,]?\s*(\d{5})\s*(.*)$/);
  if (cpMatch) {
    street = cpMatch[1].trim();
    cpTyped = cpMatch[2];
    villeTyped = cpMatch[3].trim();
  } else {
    const commaIdx = street.indexOf(",");
    if (commaIdx !== -1) {
      villeTyped = street.slice(commaIdx + 1).trim();
      street = street.slice(0, commaIdx).trim();
    } else {
      const partialCpMatch = allowPartialCp && street.match(/^(.*\S)\s+(\d{1,4})$/);
      if (partialCpMatch) {
        street = partialCpMatch[1].trim();
        cpTyped = partialCpMatch[2];
      } else if (knownCityPrefixes) {
        const villeSplit = splitVilleSuffix(street, knownCityPrefixes);
        if (villeSplit) {
          street = villeSplit.street;
          villeTyped = villeSplit.villeTyped;
        }
      }
    }
  }

  return { numero, street, cpTyped, villeTyped };
}

// Suggestions d'ADRESSE COMPLETE au fil de la frappe (numero+rue(+ville/CP)
// en une ligne, adresses connues de la BAN locale) -- retour terrain : "une
// ligne pour l'adresse ou tu me fais des propositions en fonction de ce qui
// existent [...] complètement avec l'adresse sur une ligne", meme principe
// que bindVilleAutocomplete ci-dessous mais sur toute l'adresse plutot que
// la seule ville. Purement une aide a la saisie (choisir une suggestion
// remplit les 4 champs details d'un coup, mais ils restent modifiables
// ensuite) : le geocodage final revalide toujours via matchAddress
// independamment de ce qui est tape ici.
// Recupere les adresses candidates pour un `parsed` (voir splitAdresseInput)
// donne. Bug reel corrige ici, retour terrain concret : "4 rue des jardins
// 54385" (adresse des parents de l'utilisateur, a Rosieres-en-Haye) ne
// proposait JAMAIS la bonne commune, meme une fois les 5 chiffres du CP
// entierement tapes -- alors que le filtre par CP existait deja et semblait
// correct sur le papier.
//
// Root cause : queryByStreetPrefix, pour rester rapide sur ~366k adresses,
// plafonne a `limit` LIGNES BRUTES lues dans l'index par-nom-de-rue AVANT
// tout filtrage par CP -- mais "Rue des Jardins" a elle seule compte 805
// occurrences dans la seule base 54+55 ("Grande Rue", le nom le plus
// courant, en compte plus de 13 000). Rosieres-en-Haye n'etait tout
// simplement JAMAIS parmi les 60 premieres lignes brutes remontees par le
// curseur (ordre d'insertion de la base, sans rapport avec le CP) -- le
// filtre par CP appliquee ENSUITE, cote client, ne pouvait donc rien
// trouver, quel que soit le CP tape, meme complet. Repli sur "montrer les
// resultats non filtres" (voir plus bas) : d'ou une liste figee, toujours
// la meme, qui ne correspondait jamais a la ville demandee.
//
// Fix : des qu'un CP COMPLET (5 chiffres) est connu, on interroge
// directement par CP EXACT (index by_cp, deja existant) -- une commune
// compte au plus quelques centaines/milliers d'adresses, jamais tronque,
// puis on filtre localement par prefixe de rue (operation en memoire,
// triviale sur ce volume).
//
// Meme probleme, retour terrain complementaire : "si je met 55 il devrait
// deja m'enlever les villes dans le 54" -- avec un CP PARTIEL (1 a 4
// chiffres) ou une ville deja identifiee, la recherche restait sur le
// plafond de 60 lignes brutes par nom de rue, donc le filtrage par
// departement/ville ensuite (voir showMatches) ne pouvait pas plus
// fonctionner que pour le CP complet -- meme cause, meme effet. Des qu'un
// indice de narrowing (CP meme partiel, ou ville) existe, on releve donc
// ce plafond a 3000 -- couvre la quasi-totalite des noms de rue de la base
// (au-dela de "Rue de l'Eglise", le nom le plus courant apres "Grande Rue",
// qui culmine a ~2400 occurrences sur 54+55), le filtrage par CP/ville se
// faisant ensuite normalement sur l'ensemble recupere. Volontairement PAS
// illimite : "Grande Rue" a elle seule depasse 13 000 occurrences, et un
// curseur IndexedDB qui en lirait autant a CHAQUE frappe degraderait
// nettement la reactivite -- ce cas extreme reste, en pratique, un repli
// imparfait (liste non filtree) le temps que le CP se precise encore. Le
// plafond de 60 ne reste utilise que pour une recherche encore totalement
// non qualifiee (aucun CP ni ville tape).
async function fetchAdresseCandidates(parsed, streetPrefix) {
  if (parsed.cpTyped && parsed.cpTyped.length === 5) {
    const cpCandidates = await queryByCp(parsed.cpTyped);
    return cpCandidates.filter((c) => (c.rn || "").startsWith(streetPrefix));
  }
  const limit = parsed.cpTyped || parsed.villeTyped ? 3000 : 60;
  return queryByStreetPrefix(streetPrefix, limit);
}

// Mots-type de voie francais courants, souvent omis a l'oral/a la frappe
// rapide ("12 nationale" pour "12 Route Nationale", "l'eglise" pour "Rue de
// l'Eglise"...). Bug reel corrige ici, retour terrain : "12 nationale
// doncourt-aux-templiers" (une vraie adresse) ne proposait rien du tout,
// alors que "Route Nationale" existe bien dans la base a cette commune --
// la recherche par PREFIXE (voir by_rn) ne peut matcher que depuis le DEBUT
// du nom normalise ("route nationale"), donc omettre le premier mot casse
// tout match, meme si le reste est identique.
const STREET_TYPE_WORDS = [
  "rue", "route", "chemin", "impasse", "avenue", "allee", "place", "boulevard",
  "quai", "square", "faubourg", "cours", "sentier", "montee", "cite", "clos",
  "hameau", "venelle", "traverse", "ruelle", "passage", "voie",
];

// Retente en anteposant chacun des mots-type ci-dessus au prefixe de rue
// deja calcule -- reutilise fetchAdresseCandidates (CP exact si connu,
// sinon prefixe de rue) pour rester coherent avec la recherche normale.
// N'est tente QUE si la recherche telle quelle (sans mot-type ajoute) n'a
// rien donne, et jamais si le 1er mot tape est deja lui-meme un mot-type
// (rien a ajouter dans ce cas).
async function fetchWithStreetTypeWordFallback(parsed, streetPrefix) {
  const firstWord = streetPrefix.split(" ")[0];
  if (STREET_TYPE_WORDS.includes(firstWord)) return [];
  for (const typeWord of STREET_TYPE_WORDS) {
    const candidates = await fetchAdresseCandidates(parsed, `${typeWord} ${streetPrefix}`);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

async function fetchAdresseCandidatesWithFallback(parsed, streetPrefix) {
  const candidates = await fetchAdresseCandidates(parsed, streetPrefix);
  if (candidates.length > 0) return candidates;
  return fetchWithStreetTypeWordFallback(parsed, streetPrefix);
}

function bindAdresseAutocomplete(container) {
  const input = container.querySelector("#f-adresse-complete");
  const list = container.querySelector("#f-adresse-complete-suggestions");
  const numeroInput = container.querySelector("#f-numero");
  const rueInput = container.querySelector("#f-rue");
  const villeInput = container.querySelector("#f-ville");
  const cpInput = container.querySelector("#f-cp");
  let debounceTimer = null;

  function hide() {
    list.innerHTML = "";
  }

  async function showMatches(rawInput) {
    // numero ne sert qu'a TRIER les resultats ensuite (jamais a les
    // exclure : une entree sans numero tape encore reste utile a montrer).
    // cpTyped/villeTyped, si presents, FILTRENT/priorisent par commune --
    // voir splitAdresseInput ci-dessus pour le detail du bug corrige.
    let parsed = splitAdresseInput(rawInput);
    let streetPrefix = normalizeStreet(parsed.street);
    if (streetPrefix.length < 3) {
      hide();
      return;
    }
    let candidates = await fetchAdresseCandidatesWithFallback(parsed, streetPrefix);

    // Repli EN DEUXIEME ESSAI seulement (voir splitAdresseInput) : la
    // recherche "rue seule" n'a rien trouve et aucune coupure fiable
    // (virgule/CP complet) n'avait ete detectee.
    if (candidates.length === 0 && !parsed.cpTyped && !parsed.villeTyped) {
      // 2a (leger, pas de requete supplementaire) : CP en cours de frappe,
      // pas encore les 5 chiffres complets.
      const retryPartial = splitAdresseInput(rawInput, { allowPartialCp: true });
      if (retryPartial.cpTyped) {
        const retryPrefix = normalizeStreet(retryPartial.street);
        if (retryPrefix.length >= 3) {
          const retryCandidates = await fetchAdresseCandidatesWithFallback(retryPartial, retryPrefix);
          if (retryCandidates.length > 0) {
            parsed = retryPartial;
            streetPrefix = retryPrefix;
            candidates = retryCandidates;
          }
        }
      }
    }
    // 2b : toujours rien -- essaie de couper un debut de ville colle a la
    // fin, sans ponctuation (necessite la liste des communes connues).
    if (candidates.length === 0 && !parsed.cpTyped && !parsed.villeTyped) {
      const cities = await listDistinctCities();
      const knownCityPrefixes = cities.map((c) => looseCommune(c.cn));
      const retryVille = splitAdresseInput(rawInput, { knownCityPrefixes });
      if (retryVille.villeTyped) {
        const retryPrefix = normalizeStreet(retryVille.street);
        if (retryPrefix.length >= 3) {
          const retryCandidates = await fetchAdresseCandidatesWithFallback(retryVille, retryPrefix);
          if (retryCandidates.length > 0) {
            parsed = retryVille;
            streetPrefix = retryPrefix;
            candidates = retryCandidates;
          }
        }
      }
    }

    if (candidates.length === 0) {
      hide();
      return;
    }
    const { numero, cpTyped, villeTyped } = parsed;
    let filtered = candidates;
    if (cpTyped) {
      const byCp = candidates.filter((c) => String(c.cp || "").startsWith(cpTyped));
      if (byCp.length > 0) filtered = byCp; // repli sinon (CP tape ne correspond a rien connu) : montrer quand meme les rues trouvees
    } else if (villeTyped) {
      const villePrefix = looseCommune(normalizeCity(villeTyped));
      const byVille = candidates.filter((c) => looseCommune(normalizeCity(c.c || "")).startsWith(villePrefix));
      if (byVille.length > 0) filtered = byVille;
    }
    const numeroDigits = numero.replace(/\D/g, "");
    const sorted = numeroDigits
      ? [...filtered].sort((a, b) => {
          const aMatch = String(a.n || "") === numeroDigits ? 0 : 1;
          const bMatch = String(b.n || "") === numeroDigits ? 0 : 1;
          return aMatch - bMatch;
        })
      : filtered;
    const matches = sorted.slice(0, 6);
    list.innerHTML = matches
      .map((entry, i) => `<button type="button" class="candidate-item" data-idx="${i}">${escapeHtml(formatEntry(entry))}</button>`)
      .join("");
    list.querySelectorAll(".candidate-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const picked = matches[Number(btn.dataset.idx)];
        numeroInput.value = picked.n ? `${picked.n}${picked.rep || ""}`.trim() : "";
        rueInput.value = picked.r || "";
        villeInput.value = picked.c || "";
        cpInput.value = picked.cp || "";
        input.value = formatEntry(picked);
        hide();
      });
    });
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const value = input.value.trim();
    if (value.length < 4) {
      hide();
      return;
    }
    debounceTimer = setTimeout(() => showMatches(value), 200);
  });
  input.addEventListener("blur", () => {
    // Laisse le temps au clic sur une suggestion de se declencher avant de
    // la faire disparaitre (blur tire avant click sinon).
    setTimeout(hide, 150);
  });
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
    ${duplicate ? `<div class="card" style="border-color:var(--danger);"><strong>${icon("alert-triangle")}Ce tracking a déjà été scanné.</strong></div>` : ""}
    <div class="button-row">
      <button type="button" id="f-rescan">Rescanner</button>
      <button type="button" class="primary btn-lg" id="f-valider">Valider</button>
    </div>
    <div class="field">
      <label>Adresse</label>
      <input type="text" id="f-adresse-complete" class="field-lg" placeholder="ex: 12 rue de la Liberté" autocomplete="off">
      <div id="f-adresse-complete-suggestions" class="candidate-list"></div>
      <p class="muted" style="margin-top:4px;">Choisis une suggestion pour remplir les champs ci-dessous d'un coup, ou complète-les toi-même.</p>
    </div>
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
      <label>Nombre de colis à cette adresse</label>
      <input type="number" id="f-quantite" class="field-lg" inputmode="numeric" min="1" step="1" value="${colis.quantite || 1}">
    </div>
    <div class="field">
      <label>Téléphone ${telBadge}</label>
      <input type="tel" id="f-tel" class="field-lg" value="${escapeAttr(colis.tel)}">
    </div>
    <div class="field">
      <label>Nom</label>
      <input type="text" id="f-nom" class="field-lg" value="${escapeAttr(colis.nom)}">
    </div>
    <div class="toggle-row">
      <label for="f-avant12h">Livrer avant 12h</label>
      <input type="checkbox" id="f-avant12h" ${colis.avant12h ? "checked" : ""} style="width:26px;height:26px;">
    </div>
  `;

  bindAdresseAutocomplete(container);
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
    // Tracking : plus de champ de saisie manuelle (retour terrain : peu
    // fiable/peu utile a corriger a la main) -- colis.tracking reste tel
    // qu'extrait automatiquement par l'OCR (ou null), utilise seulement pour
    // la detection de doublon (voir isDuplicateTracking).
    colis.avant12h = container.querySelector("#f-avant12h").checked;
    const quantiteInput = parseInt(container.querySelector("#f-quantite").value, 10);
    colis.quantite = Number.isFinite(quantiteInput) && quantiteInput > 0 ? quantiteInput : 1;

    // Journal des corrections OCR (retour terrain : "beaucoup d'erreurs",
    // le but est d'ameliorer le parser pour les scans suivants, pas juste ce
    // colis) -- voir ocr-corrections-store.js, no-op silencieux si ce colis
    // n'a pas de texte OCR ou si rien n'a change par rapport a ce que le
    // parser produit.
    await recordCorrectionIfNeeded(colis, {
      nom: colis.nom,
      tel: colis.tel,
      rue: colis.adresseRaw.rue,
      cp: colis.adresseRaw.cp,
      ville: colis.adresseRaw.ville,
    });

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
    showToast(`Adresse favorite : ${fav.note}`, { variant: "warn", durationMs: 7000 });
  }
}

// Parse "48.6921, 6.1844" (ou variantes d'espacement) -- format qu'on
// retrouve tel quel quand on fait un appui long sur un point Google Maps puis
// "Copier les coordonnees". Google Maps entoure parfois la paire de
// parentheses ("(48.6921, 6.1844)", ex: fiche d'un etablissement) -- bug reel
// corrige ici : parseFloat("(48.6921") echoue silencieusement ("(" n'est pas
// un debut de nombre valide), le collage direct depuis Google Maps
// necessitait donc de retirer les parentheses a la main avant de coller.
// Retourne null si la latitude/longitude n'est pas un nombre plausible
// plutot que de planter le geocodage manuel.
function parseLatLon(text) {
  const cleaned = String(text || "").replace(/[()]/g, "");
  const parts = cleaned.split(",").map((s) => parseFloat(s.trim()));
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
      <p class="muted">La BAN ne connaît que les adresses officielles, pas les noms d'entreprise.</p>
      <a class="btn-link" href="${googleMapsSearchUrl(rawQuery)}" target="_blank" rel="noopener">${icon("search")}Chercher "${escapeHtml(rawQuery)}" sur Google Maps</a>
      <details style="margin-top:8px;">
        <summary>Comment récupérer les coordonnées GPS ?</summary>
        <ol class="muted" style="margin:6px 0 0; padding-left:18px;">
          <li>Sur la carte qui s'ouvre, repère l'endroit exact (entrée du bâtiment, portail…).</li>
          <li>Appui long sur ce point précis : un repère (épingle) apparaît.</li>
          <li>Les coordonnées GPS s'affichent — en bas de l'écran sous le nom du lieu, ou en remontant la fiche du repère si besoin. Appuie dessus pour les copier ("Copier les coordonnées" ou une pression longue sur le texte).</li>
          <li>Reviens ici et colle-les dans le champ ci-dessous.</li>
        </ol>
      </details>
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
      showToast("Coordonnées invalides (format attendu : 48.6921, 6.1844)");
      return;
    }
    acceptManualCoords(parsed.lat, parsed.lon);
  });
  container.querySelector("#geocode-later").addEventListener("click", () => onSaved?.(colis));
}
