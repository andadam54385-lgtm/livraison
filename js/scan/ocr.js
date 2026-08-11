import Tesseract from "../../lib/tesseract/tesseract.esm.min.js";

// Tout est vendorise localement (aucun CDN) : voir pwa/lib/tesseract/.
// corePath pointe directement sur le fichier .js (pas un dossier) pour
// eviter la detection de feature SIMD a l'exécution -- on cible directement
// iPhone recent (iOS 16.4+, SIMD garanti) donc pas besoin de repli non-SIMD.
function assetUrl(relFromPwaRoot) {
  return new URL(`../../${relFromPwaRoot}`, import.meta.url).href;
}

let workerPromise = null;
let workerLangs = null;

async function getWorker(langs) {
  if (workerPromise && workerLangs === langs) return workerPromise;
  if (workerPromise) {
    const prev = await workerPromise;
    await prev.terminate();
  }
  workerLangs = langs;
  workerPromise = Tesseract.createWorker(langs, Tesseract.OEM.LSTM_ONLY, {
    workerPath: assetUrl("lib/tesseract/worker.min.js"),
    corePath: assetUrl("lib/tesseract/tesseract-core-simd-lstm.wasm.js"),
    langPath: assetUrl("lib/tesseract/"),
    gzip: true,
    cacheMethod: "none", // deja mis en cache par notre propre service worker
    logger: () => {},
  });
  return workerPromise;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{langs?: string}} options
 * @returns {Promise<{text: string, confidence: number}>}
 */
export async function recognizeCanvas(canvas, { langs = "fra" } = {}) {
  const worker = await getWorker(langs);
  // PSM explicite (AUTO, le defaut Tesseract) : le worker est partage avec
  // recognizeCanvasWithLines (voir plus bas), qui le bascule sur un autre
  // mode -- sans le remettre ici, un scan liste juste avant un scan
  // etiquette heriterait du mauvais mode de segmentation.
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO });
  const { data } = await worker.recognize(canvas);
  return { text: data.text, confidence: data.confidence };
}

// Aplati la structure hierarchique de Tesseract (blocks[].paragraphs[].
// lines[]) en un tableau plat {text, bbox} -- utilise par le scan en rafale
// (batch-scan-ui.js) pour positionner un cadre sur chaque ligne detectee et
// regrouper les lignes en blocs d'adresse (voir parse-address-list.js).
// Plusieurs formes possibles selon la version de Tesseract.js -- on essaie
// blocks, puis paragraphs, puis lines directement, plutot que de supposer
// une seule forme et planter si elle differe.
function extractLines(data) {
  const lines = [];
  try {
    if (Array.isArray(data.blocks)) {
      for (const block of data.blocks) {
        for (const para of block.paragraphs || []) {
          for (const l of para.lines || []) {
            if (l.text && l.bbox) lines.push({ text: l.text.trim(), bbox: l.bbox });
          }
        }
      }
    } else if (Array.isArray(data.paragraphs)) {
      for (const para of data.paragraphs) {
        for (const l of para.lines || []) {
          if (l.text && l.bbox) lines.push({ text: l.text.trim(), bbox: l.bbox });
        }
      }
    } else if (Array.isArray(data.lines)) {
      for (const l of data.lines) {
        if (l.text && l.bbox) lines.push({ text: l.text.trim(), bbox: l.bbox });
      }
    }
  } catch (err) {
    console.warn("[ocr] Échec d'extraction des lignes structurées:", err);
  }
  return lines.filter((l) => l.text);
}

// Variante utilisee par le scan en rafale (plusieurs adresses par photo,
// voir batch-scan-ui.js) : demande a Tesseract les positions (bbox) de
// chaque ligne en plus du texte, necessaires pour dessiner un cadre et
// regrouper les lignes en blocs d'adresse. Repli sur un tableau `lines`
// vide (jamais une exception) si la demande de sortie structuree echoue --
// le texte brut reste utilisable, seul le cadrage visuel se degrade.
export async function recognizeCanvasWithLines(canvas, { langs = "fra" } = {}) {
  const worker = await getWorker(langs);
  // SINGLE_COLUMN plutot que AUTO (defaut) : le scan en rafale n'OCRise que
  // la zone-guide de cadrage (voir batch-scan-ui.js), pensee pour contenir
  // UNE colonne de liste -- AUTO tente de reconnaitre une mise en page de
  // page complete (titres, colonnes multiples...) et se perd plus facilement
  // sur du texte d'appli/ecran, moins structure qu'un document classique.
  await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_COLUMN });
  try {
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    return { text: data.text, confidence: data.confidence, lines: extractLines(data) };
  } catch (err) {
    console.warn("[ocr] Sortie structuree (blocks) indisponible, repli texte seul:", err);
    const { data } = await worker.recognize(canvas);
    return { text: data.text, confidence: data.confidence, lines: [] };
  }
}
