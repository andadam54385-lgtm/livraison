import { loadZxingLib, decodeCode128 } from "./barcode.js";

const SCAN_INTERVAL_MS = 220; // ~4-5 tentatives/s : reactif sans saturer le CPU mobile
const MAX_CONSECUTIVE_ERRORS = 5; // au-dela, ce n'est plus un raté isole -- afficher l'erreur plutot que boucler en silence

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Scan live du code-barres (flux camera getUserMedia, pas la capture photo
// native utilisee ailleurs dans l'app -- voir capture.js pour pourquoi celle-
// ci est preferee pour l'OCR). Resout avec le texte du tracking si un
// Code128 est detecte, ou `null` si l'utilisateur choisit de passer
// directement a la photo. Rejette si l'utilisateur annule entierement, avec
// le meme message que capture.js pour reutiliser le meme filtre
// "annulation silencieuse" cote appelant.
// Retour terrain : "la lecture au code-barres ne donne rien" -- un
// getUserMedia/zxing qui echoue, ou un decodage qui plante a CHAQUE frame,
// tournait auparavant en boucle silencieuse (juste un console.warn/error,
// invisible pour l'utilisateur) avant de finir par se rabattre sur la photo
// sans jamais dire pourquoi. Toute erreur reelle est maintenant affichee a
// l'ecran (texte exact de l'erreur) plutot que silencieusement avalee --
// necessaire pour diagnostiquer a distance sans acces a la console.
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
    let consecutiveErrors = 0;

    function cleanup() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }

    // Remplace le viewfinder par un message d'erreur exploitable (visible,
    // pas juste dans la console) -- l'utilisateur peut alors le lire/le
    // rapporter au lieu de deviner pourquoi "ça ne donne rien".
    function showError(message) {
      cleanup();
      container.innerHTML = `
        <div class="card" style="border-color:var(--danger);">
          <div class="card-title">⚠ Scan code-barres indisponible</div>
          <p class="muted">${escapeHtml(message)}</p>
        </div>
        <div class="button-row">
          <button type="button" id="viewfinder-cancel-err">Annuler</button>
          <button type="button" class="primary" id="viewfinder-skip-err">📷 Prendre une photo à la place</button>
        </div>
      `;
      container.querySelector("#viewfinder-cancel-err").addEventListener("click", () => reject(new Error("Scan annulé.")));
      container.querySelector("#viewfinder-skip-err").addEventListener("click", () => resolve(null));
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
          consecutiveErrors = 0;
          if (text) {
            cleanup();
            resolve(text);
            return;
          }
        } catch (err) {
          consecutiveErrors++;
          console.error("[barcode] Erreur de décodage:", err);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            showError(`Le décodage échoue systématiquement : ${err?.message || err}`);
            return;
          }
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
        if (!stopped) showError(err?.message || String(err));
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
