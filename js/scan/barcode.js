// Lecture de code-barres Code128 (numero de tracking UPS) via zxing-wasm,
// vendorise localement sous lib/zxing/ (jamais de CDN -- zxing-wasm pointe
// par defaut vers jsDelivr pour son .wasm, d'ou l'override locateFile
// ci-dessous). Complement a l'OCR, pas un remplacement : voir viewfinder-ui.js
// pour le flux (scan live en continu, repli sur la photo+OCR habituelle si
// rien n'est detecte).

function moduleRelativeUrl(relativePath) {
  return new URL(relativePath, import.meta.url).href;
}

let prepared = false;

function ensurePrepared() {
  if (prepared) return;
  window.ZXingWASM.prepareZXingModule({
    overrides: {
      locateFile: (path) => moduleRelativeUrl(`../../lib/zxing/${path}`),
    },
  });
  prepared = true;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`Échec chargement ${src}`)));
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      resolve();
    });
    el.addEventListener("error", () => reject(new Error(`Échec chargement ${src}`)));
    document.head.appendChild(el);
  });
}

let libLoadPromise = null;

// zxing-wasm (~40 Ko de JS + 1 Mo de wasm) n'est charge qu'a l'ouverture du
// viewfinder de scan, jamais au boot de l'appli.
export function loadZxingLib() {
  if (!libLoadPromise) {
    libLoadPromise = loadScriptOnce(moduleRelativeUrl("../../lib/zxing/zxing-reader.js")).then(ensurePrepared);
  }
  return libLoadPromise;
}

// Retourne le texte du premier code-barres Code128 valide trouve dans
// l'image, ou null si aucun. tryHarder desactive : appele plusieurs fois par
// seconde pendant le viewfinder live, la vitesse prime sur l'exhaustivite
// (une image ratee est retentee a la frame suivante de toute facon).
export async function decodeCode128(imageData) {
  const results = await window.ZXingWASM.readBarcodes(imageData, {
    formats: ["Code128"],
    tryHarder: false,
  });
  const hit = results.find((r) => r.isValid && r.text);
  return hit ? hit.text : null;
}
