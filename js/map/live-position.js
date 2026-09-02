// Position GPS du livreur en continu -- retour terrain : "sur la carte,
// mettre le livreur la ou il est en permanence". UN seul watchPosition pour
// toute l'appli, demarre a la premiere carte et jamais coupe tant que la page
// vit : la carte, elle, se detruit et se reconstruit souvent (camera,
// arriere-plan, perte de contexte WebGL) et la position doit survivre a tout
// ca. Independant du GeolocateControl de MapLibre, qui RECENTRE la carte a
// chaque fixe : ici on ne touche jamais a la camera, on ne fait qu'afficher
// (voir la couche "me" dans map-ui.js). Le bouton du controle reste le moyen
// de se recentrer sur soi.
//
// Limite d'iOS, pas de l'appli : en PWA Safari la mesure ne continue qu'appli
// au premier plan ; a la reprise, le premier fixe repart tout seul.
let watchId = null;
let last = null;
const listeners = new Set();

export function startLivePosition() {
  if (watchId != null || !("geolocation" in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      last = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
        ts: pos.timestamp,
      };
      for (const fn of listeners) {
        try {
          fn(last);
        } catch (err) {
          console.error("[live-position] abonne en erreur:", err);
        }
      }
    },
    (err) => {
      // Refus ou indisponible : on ne relance pas en boucle, le bouton du
      // controle MapLibre redemandera la permission si l'utilisateur le
      // souhaite. Silencieux : un GPS absent n'empeche rien d'autre.
      console.warn("[live-position] geolocalisation indisponible:", err?.message || err);
      if (err?.code === 1) stopLivePosition(); // PERMISSION_DENIED : inutile d'insister
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
  );
}

export function stopLivePosition() {
  if (watchId != null && "geolocation" in navigator) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

// Abonne fn aux fixes GPS ; appelee tout de suite avec la derniere position
// connue s'il y en a une. Renvoie la fonction de desabonnement.
export function onLivePosition(fn) {
  listeners.add(fn);
  if (last) fn(last);
  return () => listeners.delete(fn);
}

export function getLastPosition() {
  return last;
}
