const MAX_DIMENSION = 1800; // limite raisonnable perf/memoire OCR mobile, garde le texte lisible

export async function loadImageToCanvas(file) {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;

  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas;
}

export function cropCanvas(sourceCanvas, rect) {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(sourceCanvas.width - x, Math.round(rect.width));
  const h = Math.min(sourceCanvas.height - y, Math.round(rect.height));
  if (w <= 0 || h <= 0) return sourceCanvas;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
  return out;
}

export function toGrayscale(canvas) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    // Luminance ponderee (perception humaine), plus fidele qu'une moyenne simple.
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gray;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// Seuil optimal de binarisation par la methode d'Otsu : maximise la variance
// inter-classe entre pixels "texte" (sombres) et "fond" (clairs) a partir de
// l'histogramme des niveaux de gris. Standard pour la binarisation avant OCR.
export function computeOtsuThreshold(canvas) {
  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const histogram = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) histogram[data[i]]++;

  const total = canvas.width * canvas.height;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * histogram[t];

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumAll - sumBackground) / weightForeground;

    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  return threshold;
}

export function binarize(canvas, threshold) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const value = d[i] >= threshold ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = value;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// Pipeline complet applique automatiquement avant OCR (l'etape "manuelle" est
// le recadrage, gere separement par attachCropSelector -- le reste est fait
// systematiquement pour maximiser la fiabilite Tesseract, comme demande).
export function preprocessForOcr(canvas) {
  toGrayscale(canvas);
  const threshold = computeOtsuThreshold(canvas);
  binarize(canvas, threshold);
  return canvas;
}

// Recadrage manuel simple : l'utilisateur glisse un rectangle sur l'aperçu
// (Pointer Events, fonctionne au doigt comme a la souris). `onSelect(rect)`
// est appele a chaque glisser termine (rect en coordonnees canvas, ou null si
// le geste etait trop petit pour etre intentionnel) -- callback plutot que
// promesse a resolution unique pour permettre a l'utilisateur de recommencer
// son cadrage plusieurs fois avant de valider.
export function attachCropSelector(overlayEl, canvas, onSelect) {
  const scaleX = canvas.width / overlayEl.clientWidth;
  const scaleY = canvas.height / overlayEl.clientHeight;
  let startX = 0;
  let startY = 0;
  let box = null;

  function makeBox() {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.border = "2px solid #f59e0b";
    el.style.background = "rgba(245,158,11,0.15)";
    el.style.pointerEvents = "none";
    overlayEl.appendChild(el);
    return el;
  }

  overlayEl.addEventListener("pointerdown", (e) => {
    const rect = overlayEl.getBoundingClientRect();
    startX = e.clientX - rect.left;
    startY = e.clientY - rect.top;
    if (box) box.remove();
    box = makeBox();
    overlayEl.setPointerCapture(e.pointerId);
  });

  overlayEl.addEventListener("pointermove", (e) => {
    if (!box) return;
    const rect = overlayEl.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${Math.abs(curX - startX)}px`;
    box.style.height = `${Math.abs(curY - startY)}px`;
  });

  overlayEl.addEventListener("pointerup", (e) => {
    if (!box) return;
    const rect = overlayEl.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    const left = Math.min(startX, curX);
    const top = Math.min(startY, curY);
    const width = Math.abs(curX - startX);
    const height = Math.abs(curY - startY);

    if (width < 20 || height < 20) {
      box.remove();
      box = null;
      onSelect(null);
      return;
    }
    onSelect({
      x: left * scaleX,
      y: top * scaleY,
      width: width * scaleX,
      height: height * scaleY,
    });
  });
}
