// Liens par coordonnees (deja geocodees au Module 2), pas par adresse texte :
// plus fiable, evite un re-geocodage cote Apple/Waze avec une adresse mal
// formatee, et fonctionne meme si le libelle contient des caracteres speciaux.

export function appleMapsUrl({ lat, lon, label }) {
  const params = new URLSearchParams({ daddr: `${lat},${lon}` });
  if (label) params.set("dname", label);
  return `https://maps.apple.com/?${params.toString()}`;
}

export function wazeUrl({ lat, lon }) {
  return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
}

export function buildNavUrl(navApp, point) {
  return navApp === "waze" ? wazeUrl(point) : appleMapsUrl(point);
}
