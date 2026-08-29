const EARTH_RADIUS_M = 6371000;
const DEG2RAD = Math.PI / 180;

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function formatDurationShort(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem}`;
}

// Horaires "HH:MM" <-> secondes depuis minuit. Utilise par les contraintes
// horaires du tri de tournee (voir tourCost dans routing/tsp.js) et par les
// champs correspondants des Reglages. Une saisie invalide renvoie null plutot
// que NaN : l'appelant traite alors la contrainte comme absente, jamais comme
// une contrainte a 0 (= "avant minuit", qui rendrait tout en retard).
export function hhmmToSec(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 3600 + min * 60;
}

export function secToHhmm(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function secondsSinceMidnight(date) {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}
