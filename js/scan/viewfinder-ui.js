import { loadZxingLib, decodeCode128 } from "./barcode.js";

const SCAN_INTERVAL_MS = 220; // ~4-5 tentatives/s : reactif sans saturer le CPU mobile

// Scan live du code-barres (flux camera getUserMedia, pas la capture photo
// native utilisee ailleurs dans l'app -- voir capture.js pour pourquoi celle-
// ci est preferee pour l'OCR). Resout avec le texte du tracking si un
// Code128 est detecte, ou `null` si l'utilisateur choisit de passer
// directement a la photo (camera live indisponible y compris : pas d'erreur
// bloquante, simple repli). Rejette si l'utilisateur annule entierement,
// avec le meme message que capture.js pour reutiliser le meme filtre
// "annulation silencieuse" cote appelant.
export function startBarcodeViewfinder(container) {
  return new Promise((resolve, reject) => {
    container.innerHTML = `
      <div class="viewfinder-wrap">
        <video id="scan-video" autoplay playsinline muted></video>
        <div class="viewfinder-frame"></div>
      </div>
      <p class="muted" style="text-align:center;">Vise le code-barres de l'étiquette.</p>
      <div class="button-row">
        <button type="button" id="viewfinder-cancel">Annuler</button>
        <button type="button" class="primary" id="viewfinder-skip">📷 Prendre une photo à la place</button>
      </div>
    `;

    const video = container.querySelector("#scan-video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let stream = null;
    let stopped = false;
    let timer = null;

    function cleanup() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }

    async function tick() {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        try {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const text = await decodeCode128(imageData);
          if (text) {
            cleanup();
            resolve(text);
            return;
          }
        } catch (err) {
          console.error("[barcode] Erreur de décodage:", err);
        }
      }
      if (!stopped) timer = setTimeout(tick, SCAN_INTERVAL_MS);
    }

    loadZxingLib()
      .then(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }))
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop()); // annule pendant le chargement
          return;
        }
        stream = s;
        video.srcObject = s;
        tick();
      })
      .catch((err) => {
        // Camera live/permission/zxing indisponible : repli silencieux sur
        // le flux photo existant plutot qu'une erreur bloquante.
        console.warn("[barcode] Scan live indisponible, repli photo:", err);
        if (!stopped) {
          cleanup();
          resolve(null);
        }
      });

    container.querySelector("#viewfinder-cancel").addEventListener("click", () => {
      cleanup();
      reject(new Error("Scan annulé."));
    });
    container.querySelector("#viewfinder-skip").addEventListener("click", () => {
      cleanup();
      resolve(null);
    });
  });
}
