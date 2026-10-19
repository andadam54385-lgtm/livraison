// Derniere position GPS connue du livreur, alimentee UNIQUEMENT par le
// GeolocateControl de la carte (son evenement "geolocate") -- jamais par une
// surveillance a part : deux watchPosition concurrents se genent sur iOS (voir
// CLAUDE.md, build 127). Sert a classer les adresses proposees de la plus
// proche a la plus lointaine (voir scan-ui.js).
const PEREMPTION_MS = 30 * 60 * 1000;
let derniere = null;

export function noterPosition(lat, lon) {
  if (lat == null || lon == null) return;
  derniere = { lat, lon, t: Date.now() };
}

// Position de moins de 30 min, ou null.
export function dernierePositionConnue(maintenant = Date.now()) {
  return derniere && maintenant - derniere.t < PEREMPTION_MS ? { lat: derniere.lat, lon: derniere.lon } : null;
}
