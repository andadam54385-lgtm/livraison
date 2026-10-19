// Recherche en ligne de lieux/entreprises -- retour terrain : "je veux que
// depuis l'app on trouve l'adresse" (d'une entreprise/zone industrielle
// introuvable dans la BAN, qui ne connait que les adresses officielles,
// jamais les noms d'etablissements). Avant ce module, le seul recours etait
// d'ouvrir Google Maps a cote, faire un appui long sur le bon point, copier
// les coordonnees et revenir les coller -- penible et source d'erreurs.
//
// Deux sources interrogees EN PARALLELE, toutes deux sur les donnees
// OpenStreetMap, gratuites et sans cle :
// - Photon (photon.komoot.io) : recherche floue pensee pour les noms de
//   lieux/commerces -- tolere les fautes, l'ordre des mots, les mots en trop.
//   C'est la source principale : retour terrain "trop de fois ou il ne
//   trouve pas l'entreprise", en grande partie parce que Nominatim seul
//   exige une correspondance quasi exacte. Interroge borne a la bbox de la
//   zone (constate en pratique : sans ca, "garage renault toul" renvoie des
//   garages Renault de toute la France, mieux notes sur le NOM que le vrai
//   etablissement de Toul) avec une limite large, puis RE-CLASSE ici : les
//   resultats dont la commune apparait dans la requete passent devant --
//   Photon classe par similarite de nom et ignore la ville tapee, alors que
//   c'est l'indice le plus fort qu'un livreur fournisse.
// - Nominatim : recherche stricte mais meilleure sur les adresses/lieux-dits
//   tapes en entier. Garde en complement, ses resultats completent ceux de
//   Photon quand la requete ressemble plus a une adresse qu'a un nom.
// Les deux listes sont fusionnees (doublons a moins de ~150 m ecartes) et
// les resultats DANS la zone de tournee (bbox 54+55, voir CLAUDE.md --
// a mettre a jour si la zone change) passent devant les autres.
//
// Limite assumee : un etablissement present sur Google mais absent
// d'OpenStreetMap reste introuvable ici -- aucune API Google gratuite et
// sans cle n'existe pour ca. Le repli reste le detour Google Maps + collage
// de coordonnees deja present dans l'ecran appelant (scan-ui.js).
//
// Seule fonctionnalite de l'app a DEPENDRE du reseau (le reste est
// offline-first) : assume, ce cas d'usage est irrealisable hors ligne et
// l'ancien detour par Google Maps exigeait deja du reseau. L'appelant doit
// donc toujours prevoir le cas "echec reseau" (voir scan-ui.js).
//
// Politiques d'usage (Nominatim : max 1 req/s ; Photon : fair use) --
// respectees par construction : recherche declenchee par un BOUTON explicite
// (jamais a la frappe), pour une poignee de colis par jour au pire.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const PHOTON_URL = "https://photon.komoot.io/api/";

// Bbox de la zone de tournee (departements 54+55, = celle de ban.json.gz).
const ZONE = { minLat: 48.355505, maxLat: 49.615402, minLon: 4.906709, maxLon: 7.103224 };
const ZONE_CENTER = { lat: (ZONE.minLat + ZONE.maxLat) / 2, lon: (ZONE.minLon + ZONE.maxLon) / 2 };

function inZone(p) {
  return p.lat >= ZONE.minLat && p.lat <= ZONE.maxLat && p.lon >= ZONE.minLon && p.lon <= ZONE.maxLon;
}

async function searchPhoton(query, limit) {
  const params = new URLSearchParams({
    q: query,
    lang: "fr",
    // Limite volontairement large : le bon etablissement est souvent la
    // mais mal classe (similarite de nom oblige), le re-classement local
    // fait le tri ensuite.
    limit: String(Math.max(15, limit * 3)),
    // Filtre strict a la zone de tournee : tout ce qui est livrable est
    // dedans par construction (meme bbox que ban.json/graph.json), et
    // Nominatim reste interroge sans borne en complement.
    bbox: `${ZONE.minLon},${ZONE.minLat},${ZONE.maxLon},${ZONE.maxLat}`,
  });
  const res = await fetch(`${PHOTON_URL}?${params.toString()}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const data = await res.json();
  return (data.features || [])
    .map((f) => {
      const [lon, lat] = f.geometry?.coordinates || [];
      const p = f.properties || {};
      // Libelle compact : nom + adresse, sans la cascade administrative
      // complete que renvoie display_name cote Nominatim.
      const rue = [p.housenumber, p.street].filter(Boolean).join(" ");
      const label = [p.name, rue, [p.postcode, p.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return { lat, lon, label: label || `${lat}, ${lon}`, city: p.city || "", postcode: p.postcode || "" };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

async function searchNominatim(query, limit) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    countrycodes: "fr",
    limit: String(limit),
    "accept-language": "fr",
    // Meme logique de biais que Photon (bounded absent = pas un filtre).
    viewbox: `${ZONE.minLon},${ZONE.maxLat},${ZONE.maxLon},${ZONE.minLat}`,
  });
  const res = await fetch(`${NOMINATIM_URL}?${params.toString()}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const rows = await res.json();
  return rows
    .map((r) => ({
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      label: r.display_name || r.name || `${r.lat}, ${r.lon}`,
      city: r.address?.city || r.address?.town || r.address?.village || "",
      postcode: r.address?.postcode || "",
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

// ~150 m en degres a cette latitude : suffisant pour reconnaitre "le meme
// etablissement vu par les deux sources" sans confondre deux voisins.
function sameSpot(a, b) {
  return Math.abs(a.lat - b.lat) < 0.0014 && Math.abs(a.lon - b.lon) < 0.002;
}

// Nombre de mots de la commune du resultat retrouves dans la requete
// ("garage renault toul" et la commune "Dommartin-les-Toul" -> 1 ; "saint
// mihiel" et "Saint-Mihiel" -> 2). Accents/tirets/apostrophes neutralises
// des deux cotes. C'est le signal le plus fort d'une recherche de livreur :
// il tape toujours nom + ville, jamais nom seul.
function cityMatchScore(result, queryTokens) {
  let score = 0;
  const cityTokens = normalizeTokens(result.city);
  for (const t of cityTokens) {
    if (t.length >= 3 && queryTokens.includes(t)) score++;
  }
  if (result.postcode && queryTokens.includes(result.postcode)) score += 2;
  return score;
}

function normalizeTokens(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export async function searchOnlinePlaces(query, { limit = 5 } = {}) {
  const [photon, nominatim] = await Promise.allSettled([searchPhoton(query, limit), searchNominatim(query, limit)]);

  // Les deux en echec = vraie erreur (probablement hors ligne) a montrer.
  // Une seule source en echec = on continue avec l'autre, silencieusement.
  if (photon.status === "rejected" && nominatim.status === "rejected") {
    throw photon.reason;
  }

  const merged = [];
  for (const r of [...(photon.value || []), ...(nominatim.value || [])]) {
    if (!merged.some((m) => sameSpot(m, r))) merged.push(r);
  }

  // Tri stable : commune citee dans la requete d'abord, puis zone de tournee
  // (un "Garage Dupont" a Bordeaux ne sert a rien mais reste en fin de liste
  // plutot que cache), puis l'ordre de pertinence des sources.
  const queryTokens = normalizeTokens(query);
  merged.sort(
    (a, b) => cityMatchScore(b, queryTokens) - cityMatchScore(a, queryTokens) || Number(inZone(b)) - Number(inZone(a))
  );
  return merged.slice(0, limit * 2);
}
