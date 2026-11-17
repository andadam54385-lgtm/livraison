// Position GPS ponctuelle, pour choisir l'adresse de depart (depot) sans la
// taper : onboarding (zone-onboarding-ui.js) et Reglages.
//
// UNE lecture (getCurrentPosition), jamais de suivi continu : le
// GeolocateControl de MapLibre doit rester le SEUL watchPosition de l'app
// (voir CLAUDE.md, build 127 -- un second suivi bloquait le bouton
// « recentrer » sur iOS).

export function positionActuelle() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject({ code: "indisponible" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, precision: pos.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

// Codes de GeolocationPositionError : 1 refuse, 2 indisponible, 3 delai.
export function messageErreurPosition(err) {
  if (err?.code === 1) return "Position refusée. Autorise la localisation pour Tourneo dans les réglages du téléphone, ou tape l'adresse.";
  if (err?.code === 3) return "Le GPS met trop de temps. Réessaie dehors, ou tape l'adresse.";
  if (err?.code === "indisponible") return "Ce téléphone ne donne pas sa position. Tape l'adresse.";
  return "Position introuvable. Réessaie, ou tape l'adresse.";
}

export function libelleDepotGps(lat, lon) {
  return `Ma position GPS (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
}

// Bouton + message d'etat, a placer au-dessus de la recherche d'adresse.
// `onPosition({lat, lon, label})` est appele une fois la position obtenue.
export function boutonPositionHtml(id) {
  return `
    <button type="button" class="primary" id="${id}" style="width:100%;margin-bottom:6px;">Utiliser ma position actuelle</button>
    <p class="muted" id="${id}-etat" style="margin:0 0 10px;"></p>`;
}

export function brancherBoutonPosition(container, id, onPosition) {
  const bouton = container.querySelector(`#${id}`);
  const etat = container.querySelector(`#${id}-etat`);
  bouton.addEventListener("click", async () => {
    bouton.disabled = true;
    etat.textContent = "Recherche de ta position…";
    try {
      const { lat, lon } = await positionActuelle();
      etat.textContent = "";
      await onPosition({ lat, lon, label: libelleDepotGps(lat, lon) });
    } catch (err) {
      etat.textContent = messageErreurPosition(err);
    } finally {
      bouton.disabled = false;
    }
  });
}
