// Lien par adresse texte (adresse canonique confirmee par la BAN au
// geocodage, voir colis-store.js's formatAdresseAffichage -- jamais le texte
// brut OCR) quand disponible : retour terrain, la precision au point BAN est
// parfois moins bonne que le geocodage propre d'Apple/Waze/Google sur une
// adresse propre (notamment hameaux/lieux-dits). Repli sur les coordonnees
// GPS si l'adresse est absente (ne devrait pas arriver : elle est toujours
// posee des que geocode.lat existe).

export function appleMapsUrl({ lat, lon, label, adresse }) {
  const params = new URLSearchParams({ daddr: adresse || `${lat},${lon}` });
  if (label) params.set("dname", label);
  return `https://maps.apple.com/?${params.toString()}`;
}

export function wazeUrl({ lat, lon, adresse }) {
  if (adresse) return `https://waze.com/ul?q=${encodeURIComponent(adresse)}&navigate=yes`;
  return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
}

// Lien universel Google Maps (fonctionne sur iOS/Android/desktop, ouvre
// l'app native si installee, sinon le site) : voir
// https://developers.google.com/maps/documentation/urls/get-started
// (destination accepte une adresse texte aussi bien que "lat,lon")
export function googleMapsUrl({ lat, lon, adresse }) {
  const destination = adresse || `${lat},${lon}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving`;
}

export function buildNavUrl(navApp, point) {
  if (navApp === "waze") return wazeUrl(point);
  if (navApp === "google") return googleMapsUrl(point);
  return appleMapsUrl(point);
}

// Recherche (pas un itineraire) : utile quand la BAN ne connait pas un nom
// d'entreprise/zone industrielle -- Google Maps a un bien meilleur index des
// commerces/etablissements que la BAN (registre de voirie officiel, aucun nom
// d'entreprise). Voir geocode-ui.js's fallback "coordonnees GPS manuelles".
export function googleMapsSearchUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
