import { emit } from "../lib/event-bus.js";
import { loadZxingLib, decodeCode128 } from "./barcode.js";
import { icon } from "../ui/icons.js";
import { escapeHtml } from "../lib/escape.js";
import { showToast } from "../lib/toast.js";

const SCAN_INTERVAL_MS = 220; // ~4-5 tentatives/s : reactif sans saturer le CPU mobile
const MAX_CONSECUTIVE_ERRORS = 5; // au-dela, ce n'est plus un raté isole -- afficher l'erreur plutot que boucler en silence
// Retour terrain (recurrent) : "ecran noir, la camera ne s'affiche pas" --
// sur iOS en PWA standalone, getUserMedia peut REUSSIR sans jamais livrer
// la moindre image (flux "muet" apres un retour d'arriere-plan, ou camera
// restee occupee par un flux precedent pas relache). La boucle tick()
// attendait cette premiere image pour toujours : viseur noir, aucune
// erreur, aucun delai limite. Le correctif play() explicite d'un
// signalement anterieur ne couvrait pas ce cas. Desormais : pas d'image
// au bout de ce delai -> on coupe et on retente la camera UNE fois ;
// toujours rien -> bascule automatique sur la photo native (resolve(null),
// meme contrat que le bouton "Prendre une photo a la place"), avec un
// toast pour dire pourquoi. Le livreur ne doit jamais rester bloque
// devant un ecran noir.
const FIRST_FRAME_TIMEOUT_MS = 2500;
// Retour terrain : "la page scan ne veut plus bouger" -- decodeCode128 (WASM
// zxing) s'execute de façon synchrone/bloquante sur le thread principal (pas
// de Worker ici, contrairement au routage/OCR). Decoder une frame a la
// resolution complete de la camera (1920x1080, relevee cette session pour
// fiabiliser la lecture) + tryHarder:true geleait visiblement l'interface a
// chaque tentative (toutes les 220ms). Le code-barres n'a besoin que d'etre
// bien cadre (voir .viewfinder-frame), pas de la pleine resolution : la
// frame est downscalee avant decodage, la video affichee a l'ecran reste
// elle en pleine resolution (aucun impact visuel).
const MAX_DECODE_DIMENSION = 900;

// Un seul flux camera a la fois pour tout le module : si un rendu exterieur
// remplace le DOM du viseur sans passer par cleanup() (la promesse reste
// pendante, plus aucune reference au flux), la camera resterait "occupee"
// et tous les viseurs suivants demarreraient noirs jusqu'au redemarrage de
// l'app. Toute nouvelle ouverture commence donc par couper le flux
// precedent, quel qu'il soit.
let activeStream = null;
function stopActiveStream() {
  if (activeStream) {
    activeStream.getTracks().forEach((t) => t.stop());
    activeStream = null;
  }
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
  emit("camera:open"); // meme raison que dans capture.js : la carte se suspend
  return new Promise((resolve, reject) => {
    container.innerHTML = `
      <div class="viewfinder-wrap">
        <video id="scan-video" autoplay playsinline muted></video>
        <div class="viewfinder-frame"></div>
      </div>
      <p class="muted" style="text-align:center;">Vise le code-barres de l'étiquette.</p>
      <div class="button-row">
        <button type="button" id="viewfinder-cancel">Annuler</button>
        <button type="button" class="primary" id="viewfinder-skip">${icon("camera")}Prendre une photo à la place</button>
      </div>
    `;

    const video = container.querySelector("#scan-video");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let stream = null;
    let stopped = false;
    let timer = null;
    let watchdog = null;
    let consecutiveErrors = 0;
    let gotFrame = false; // au moins une image reellement livree par la camera
    let tickStarted = false;
    let attempt = 0;

    function cleanup() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        if (activeStream === stream) activeStream = null;
        stream = null;
      }
    }

    // Remplace le viewfinder par un message d'erreur exploitable (visible,
    // pas juste dans la console) -- l'utilisateur peut alors le lire/le
    // rapporter au lieu de deviner pourquoi "ça ne donne rien".
    function showError(message) {
      cleanup();
      container.innerHTML = `
        <div class="card" style="border-color:var(--danger);">
          <div class="card-title">${icon("alert-triangle")}Scan code-barres indisponible</div>
          <p class="muted">${escapeHtml(message)}</p>
        </div>
        <div class="button-row">
          <button type="button" id="viewfinder-cancel-err">Annuler</button>
          <button type="button" class="primary" id="viewfinder-skip-err">${icon("camera")}Prendre une photo à la place</button>
        </div>
      `;
      container.querySelector("#viewfinder-cancel-err").addEventListener("click", () => reject(new Error("Scan annulé.")));
      container.querySelector("#viewfinder-skip-err").addEventListener("click", () => resolve(null));
    }

    async function tick() {
      if (stopped) return;
      if (!video.isConnected) {
        // Le DOM du viseur a ete remplace par un rendu exterieur sans passer
        // par cleanup() : sans ce garde-fou, cette boucle continuait de
        // decoder dans le vide pour toujours (CPU) avec le flux camera
        // jamais coupe (camera "occupee" pour les scans suivants).
        cleanup();
        return;
      }
      if (video.readyState >= 2 && video.videoWidth > 0) {
        gotFrame = true; // la camera livre bien des images -- desarme le chien de garde
        const scale = Math.min(1, MAX_DECODE_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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

    // Demarre (ou redemarre) le flux camera, arme le chien de garde de
    // premiere image -- voir FIRST_FRAME_TIMEOUT_MS pour le pourquoi.
    function startStream() {
      attempt++;
      stopActiveStream(); // coupe un eventuel flux fuite (camera "occupee")
      // Sans contrainte de resolution, certains navigateurs livrent un flux
      // webcam par defaut (~640x480) bien trop bas pour lire un code-barres
      // qui ne remplit qu'une partie du cadre a distance de bras -- "ideal"
      // demande le mieux disponible sans planter si la camera ne le permet pas.
      navigator.mediaDevices
        .getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
        .then((s) => {
          if (stopped) {
            s.getTracks().forEach((t) => t.stop()); // annule pendant le chargement
            return;
          }
          stream = s;
          activeStream = s;
          video.srcObject = s;
          // Retour terrain : "ça devient noir" avant meme de prendre la photo
          // -- l'attribut autoplay seul ne demarre pas toujours fiablement la
          // lecture dans Safari iOS en PWA standalone (getUserMedia reussit,
          // le flux est bien attache, mais rien ne s'affiche). Un appel EXPLICITE
          // a .play() force la lecture ; .catch() volontairement ignore (si le
          // navigateur la bloque quand meme, le chien de garde ci-dessous
          // prend le relais).
          video.play().catch(() => {});
          if (!tickStarted) {
            tickStarted = true;
            tick();
          }
          if (watchdog) clearTimeout(watchdog);
          watchdog = setTimeout(() => {
            if (stopped || gotFrame) return;
            if (attempt === 1) {
              // Premier echec : couper puis redemander la camera suffit
              // parfois (flux muet apres un retour d'arriere-plan iOS).
              if (stream) {
                stream.getTracks().forEach((t) => t.stop());
                if (activeStream === stream) activeStream = null;
                stream = null;
              }
              setTimeout(() => {
                if (!stopped) startStream();
              }, 300);
            } else {
              // Deux tentatives sans la moindre image : la camera live ne
              // viendra pas. Photo native directement, jamais d'ecran noir.
              cleanup();
              showToast("Caméra indisponible — passage direct à la photo.");
              resolve(null);
            }
          }, FIRST_FRAME_TIMEOUT_MS);
        })
        .catch((err) => {
          if (!stopped) showError(err?.message || String(err));
        });
    }

    loadZxingLib()
      .then(() => startStream())
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
