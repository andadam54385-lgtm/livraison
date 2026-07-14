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
  const { data } = await worker.recognize(canvas);
  return { text: data.text, confidence: data.confidence };
}
