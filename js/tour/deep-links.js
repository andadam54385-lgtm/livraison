// La DESTINATION passee a l'appli de navigation est TOUJOURS le point GPS
// quand on l'a -- c'est-a-dire quasiment toujours, un colis n'entrant dans une
// tournee qu'une fois geocode.
//
// Bug reel corrige ici (retour terrain : "le transfert a Waze amenait dans un
// mauvais village") : on envoyait le TEXTE de l'adresse canonique BAN
// ("11 Grande Rue, 55140 Rigny-la-Salle") et l'appli de navigation la
// re-geocodait de son cote. Un nom de voie tres repandu -- "Grande Rue",
// "Rue de l'Eglise", "Route Nationale" -- existe dans des dizaines de
// communes du secteur : le moteur de Waze en choisit une, pas forcement la
// bonne, et le livreur part a plusieurs kilometres de la. Le code postal dans
// la chaine n'y suffit pas.
//
// Le choix precedent (adresse texte prioritaire) venait d'une observation
// inverse : sur un hameau/lieu-dit, le geocodage propre d'Apple/Waze/Google
// peut viser plus juste que le point BAN. C'est vrai, mais l'echec est sans
// commune mesure -- se tromper de commune fait perdre un quart d'heure et une
// livraison, alors qu'un point BAN imprecis laisse dans la bonne rue, a
// quelques dizaines de metres. Les coordonnees priment donc, et l'adresse
// texte ne sert plus que de repli quand il n'y a pas de point (et d'etiquette
// affichee, la ou l'API le permet).
//
// Repli sur l'adresse texte : appelants, passez colis-store.js's
// formatAdresseForNav(colis) plutot que formatAdresseAffichage(colis) pour
// `adresse` ici -- il renvoie null pour un colis geocode par coordonnees
// collees a la main, plutot que le texte qui vient justement d'echouer au
// geocodage automatique.

function coordsOuNull(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) ? `${lat},${lon}` : null;
}

export function appleMapsUrl({ lat, lon, label, adresse }) {
  const params = new URLSearchParams({ daddr: coordsOuNull(lat, lon) || adresse || "" });
  if (label) params.set("dname", label);
  return `https://maps.apple.com/?${params.toString()}`;
}

export function wazeUrl({ lat, lon, adresse }) {
  const coords = coordsOuNull(lat, lon);
  // Jamais "q" et "ll" ensemble : avec les deux, Waze CHERCHE le texte autour
  // du point au lieu d'y aller directement -- on retomberait sur le meme
  // probleme d'homonymie de rue.
  if (coords) return `https://waze.com/ul?ll=${coords}&navigate=yes`;
  return `https://waze.com/ul?q=${encodeURIComponent(adresse)}&navigate=yes`;
}

// Lien universel Google Maps (fonctionne sur iOS/Android/desktop, ouvre
// l'app native si installee, sinon le site) : voir
// https://developers.google.com/maps/documentation/urls/get-started
// (destination accepte "lat,lon" aussi bien qu'une adresse texte)
export function googleMapsUrl({ lat, lon, adresse }) {
  const destination = coordsOuNull(lat, lon) || adresse || "";
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
