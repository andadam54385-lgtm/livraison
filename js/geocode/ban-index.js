import { getDb } from "../db/schema.js";
import { getAllFromIndex } from "../lib/idb.js";
import { stripAccents } from "./normalize-address.js";

export async function queryByCp(cp) {
  if (!cp) return [];
  const db = await getDb();
  return getAllFromIndex(db, "banEntries", "by_cp", cp);
}

export async function queryByCommune(cn) {
  if (!cn) return [];
  const db = await getDb();
  return getAllFromIndex(db, "banEntries", "by_cn", cn);
}

// Recherche par PREFIXE de rue normalisee (index by_rn), pour
// l'autocompletion "adresse complete sur une ligne" (voir bindAdresseAutocomplete
// dans scan-ui.js). Contrairement a listDistinctCities (tout le fichier tient
// en memoire, ~35k communes) : le volume d'adresses (plusieurs centaines de
// milliers de lignes) interdit de tout charger en JS pour un simple
// `.filter()` a chaque frappe -- requete IndexedDB par PLAGE sur l'index
// normalise, qui parcourt directement a partir du prefixe (cle >= prefix et
// < prefix+"\uFFFF") sans scanner toute la base. Plafonne a `limit` resultats
// bruts (avant tri/filtrage par numero cote appelant) : une rue tres courante
// ("Rue de la Gare"...) peut exister dans des centaines de communes.
export async function queryByStreetPrefix(prefix, limit = 60) {
  if (!prefix) return [];
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const results = [];
    const range = IDBKeyRange.bound(prefix, prefix + "\uFFFF");
    const req = db.transaction("banEntries", "readonly").objectStore("banEntries").index("by_rn").openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

let citiesCache = null;

// Liste dedupliquee des communes connues de la BAN locale, pour
// l'autocompletion "ville" (voir scan-ui.js). Parcourt l'index by_cn une
// seule fois en sautant directement au prochain nom de commune distinct
// (cursor.continue(cle), pas juste continue()) : sans ca, une grande ville
// avec des milliers d'adresses ferait defiler le curseur ligne par ligne pour
// rien. Calculee une seule fois par session (~35k communes en France,
// negligeable une fois en memoire) puis mise en cache.
export async function listDistinctCities() {
  if (citiesCache) return citiesCache;
  const db = await getDb();
  citiesCache = await new Promise((resolve, reject) => {
    const index = db.transaction("banEntries", "readonly").objectStore("banEntries").index("by_cn");
    const results = [];
    const req = index.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      const entry = cursor.value;
      results.push({ c: entry.c, cn: entry.cn, cp: entry.cp });
      // Cle strictement superieure a entry.cn la plus petite possible : saute
      // au prochain nom de commune distinct sans risquer d'en manquer un.
      cursor.continue(entry.cn + "\u0000");
    };
    req.onerror = () => reject(req.error);
  });
  return citiesCache;
}

// Decoupe un texte libre en mots comparables : accents retires, tout ce qui
// n'est pas lettre/chiffre devient un separateur (espace, virgule, TIRET,
// apostrophe...). Exportee (testable sans DOM/IndexedDB) : c'est le coeur de
// searchAdresses ci-dessous, et un tiret/une apostrophe dans le texte tape
// ("Doncourt-aux-Templiers") ne doit jamais empecher un mot de matcher
// l'equivalent en base, meme si la base le stocke avec une ponctuation
// differente (ou l'inverse).
// Les ligatures sont developpees AVANT le decoupage : "œ" n'est ni une lettre
// a-z ni un caractere que stripAccents decompose, il devenait donc un
// SEPARATEUR -- "Kœur-la-Grande" se decoupait en "k", "ur", "la", "grande",
// et taper "koeur" ne trouvait rien (retour terrain 2026-09-11 : "kœur il a
// du mal si je mets juste koeur"). 388 adresses de la zone sont concernees
// (Kœur-la-Grande/Petite, Vandœuvre-les-Nancy, Jœuf, Lalœuf).
export function tokenizeQuery(text) {
  return stripAccents(String(text || "").toLowerCase())
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

// "saint" <-> "st" dans les DEUX sens : la base ecrit les deux (13 542
// adresses avec "saint"/"sainte" en toutes lettres, 24 avec "st"/"ste"
// abrege), et le livreur tape indifferemment l'un ou l'autre.
// Retour terrain 2026-09-11 : "4 Notre dame St mihiel" ne proposait RIEN --
// la recherche demande que chaque mot tape soit le PREFIXE d'un mot de
// l'adresse, or "saint" ne commence pas par "st".
// Alias pose sur l'ENTREE, jamais en reecrivant le mot tape : reecrire
// casserait la frappe en cours ("ste" deviendrait "sainte" et ne trouverait
// plus Stenay).
const ALIAS_SAINT = { saint: "st", sainte: "ste", st: "saint", ste: "sainte" };

// Precalcule les mots de recherche d'une entree (rue + ville + code
// postal) -- exportee pour que les fixtures de test construisent leurs
// entrees exactement comme getAllBanEntriesCached, sans dupliquer/risquer
// de faire diverger la logique.
export function buildSearchTokens(entry) {
  const tokens = [...tokenizeQuery(entry.r), ...tokenizeQuery(entry.c), String(entry.cp || "")];
  for (const t of tokens) {
    const alias = ALIAS_SAINT[t];
    if (alias && !tokens.includes(alias)) tokens.push(alias);
  }
  return tokens;
}

let allEntriesCache = null;

let allEntriesLoading = null;

// Charge TOUTES les adresses de la base locale une seule fois (mise en
// cache pour la session), avec leurs mots de recherche precalcules (rue +
// ville + code postal) -- evite de retokeniser 366k lignes a CHAQUE frappe
// dans searchAdresses. Cout memoire ponctuel raisonnable au regard des
// autres gros assets deja charges par l'app (graph.json ~200Mo+ decompresse,
// map.pmtiles ~65Mo) -- voir searchAdresses pour le detail du choix
// d'architecture (recherche en memoire plutot que requete IndexedDB
// indexee). allEntriesLoading evite un double chargement si deux appels se
// chevauchent (ex: preloadBanEntries lance au focus du champ + recherche
// declenchee par la 1ere frappe avant que le preload ait fini).
async function getAllBanEntriesCached() {
  if (allEntriesCache) return allEntriesCache;
  if (!allEntriesLoading) {
    allEntriesLoading = (async () => {
      const db = await getDb();
      const rows = await new Promise((resolve, reject) => {
        const store = db.transaction("banEntries", "readonly").objectStore("banEntries");
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      allEntriesCache = rows.map((e) => ({ ...e, _searchTokens: buildSearchTokens(e) }));
      return allEntriesCache;
    })().finally(() => {
      allEntriesLoading = null;
    });
  }
  return allEntriesLoading;
}

// Demarre le chargement en arriere-plan (voir getAllBanEntriesCached),
// sans attendre le resultat -- a appeler des que possible avant la
// premiere frappe (ex: au focus du champ adresse) pour masquer le cout
// ponctuel du chargement complet derriere le temps que l'utilisateur met a
// taper ses premiers caracteres. Erreurs volontairement avalees ici :
// searchAdresses retentera et remontera l'erreur normalement le moment venu.
export function preloadBanEntries() {
  getAllBanEntriesCached().catch(() => {});
}

// Coeur de la recherche "a la Google Maps / Plans" -- PURE (pas de DB, donc
// testable directement) : `entries` doit deja porter un champ
// `_searchTokens` precalcule (voir getAllBanEntriesCached et le fixture du
// fichier de test). Tape les mots dans N'IMPORTE QUEL ORDRE (numero, rue,
// ville, CP melanges, mot-type de voie omis ou non...) et chacun doit juste
// etre le PREFIXE d'un des mots de l'adresse (rue OU ville OU code postal)
// -- sans avoir a deviner ou commence quoi. Remplace l'ancienne approche
// par POSITION STRICTE (numero puis rue puis CP/ville dans cet ordre, avec
// une cascade de retentatives pour chaque cas particulier : CP en cours de
// frappe, ville collee, mot-type omis...) -- retour terrain explicite
// apres 3 bugs distincts sur cette meme fonctionnalite malgre chaque
// correctif individuellement verifie : "rien ne marche fais un truc plus
// simple qui marche mieux un peu comme fonctionne une recherche plan ou
// google map". Un seul mecanisme uniforme remplace desormais TOUTES les
// retentatives precedentes : taper "54385" filtre par CP (prefixe exact du
// token cp), taper "55" filtre par departement (prefixe partiel du meme
// token), taper "nationale" matche "Route Nationale" (chaque mot de la rue
// est son propre token, peu importe sa position) -- le meme mecanisme
// couvre les 3 signalements reels sans code special pour aucun d'eux.
//
// `pres` ({lat, lon}, optionnel) : les adresses les plus PROCHES de ce point
// passent en premier (retour terrain 2026-10-09 : "quand on ajoute une
// adresse, mettre en premier les adresses les plus proches"). Avant, la
// recherche gardait les 200 premieres correspondances dans l'ordre de la
// base : "40 rue de metz" pouvait proposer Nancy ou Toul avant Frouard. Avec
// `pres` : numero exact d'abord, puis distance, et UNE suggestion par rue et
// par commune (six fois la meme rue avec six numeros differents ne servait a
// rien). Sans `pres`, comportement d'origine inchange.
// `pres` peut aussi etre une LISTE de points (retour terrain 2026-10-09 :
// "sinon proche des points deja installes, si pas de GPS ou si on prepare au
// depot") : la distance d'une adresse est alors celle au point le plus proche
// de la liste -- une tournee etalee sur plusieurs villages n'est pas resumee
// par un centre qui tomberait au milieu des champs.
export function matchAdresseEntries(entries, rawQuery, limit = 8, { pres = null } = {}) {
  const allTokens = tokenizeQuery(rawQuery);
  if (allTokens.length === 0) return [];
  const refs = pointsDeReferenceUniques(pres);
  if (refs.length > 0) return matchAdresseEntriesProches(entries, allTokens, limit, refs);

  // Le numero de rue, si tape en tete, ne sert qu'a TRIER le resultat
  // ensuite (jamais a filtrer : une entree sans numero tape encore reste
  // utile a montrer) -- meme principe que l'ancien splitNumeroRue.
  let numeroDigits = null;
  let wordTokens = allTokens;
  if (/^\d+[a-z]?$/.test(allTokens[0])) {
    numeroDigits = allTokens[0].replace(/\D/g, "");
    wordTokens = allTokens.slice(1);
  }
  if (wordTokens.length === 0) return [];

  const matches = [];
  // Garde-fou perf : s'arrete tres au-dela de `limit` (marge pour le tri
  // par numero ensuite), jamais besoin de scanner les 366k lignes une fois
  // suffisamment de correspondances trouvees.
  const scanCap = Math.max(limit * 30, 200);
  for (const e of entries) {
    if (wordTokens.every((t) => e._searchTokens.some((h) => h.startsWith(t)))) {
      matches.push(e);
      if (matches.length >= scanCap) break;
    }
  }

  if (numeroDigits) {
    matches.sort((a, b) => {
      const aMatch = String(a.n || "") === numeroDigits ? 0 : 1;
      const bMatch = String(b.n || "") === numeroDigits ? 0 : 1;
      return aMatch - bMatch;
    });
  }
  return matches.slice(0, limit);
}

// Variante "les plus proches d'abord" (voir `pres` ci-dessus). Ne garde que la
// meilleure entree par rue+commune (memoire bornee par le nombre de rues).
//
// Performance : parcourir les 366 000 adresses a chaque lettre tapee coutait
// 200 a 750 ms sur PC (davantage sur iPhone) -- l'ancien mode s'arretait des
// 200 correspondances. Les adresses a moins de RAYON_PROCHE_KM du point sont
// donc mises de cote UNE fois par point (cache), et chaque frappe ne cherche
// que la-dedans ; le reste de la base n'est parcouru que si moins de `limit`
// rues proches correspondent. Consequence voulue : une rue proche passe
// devant la meme rue au bon numero mais a l'autre bout du departement.
const RAYON_PROCHE_KM = 20;
const cacheProches = new WeakMap(); // entries -> { cle, proches, loin }

// Points de reference valides, dedoublonnes a ~500 m pres : 60 colis repartis
// dans 8 villages ne donnent qu'une vingtaine de points a comparer.
function pointsDeReferenceUniques(pres) {
  const liste = (Array.isArray(pres) ? pres : [pres]).filter((p) => p?.lat != null && p?.lon != null);
  const vus = new Map();
  for (const p of liste) {
    const cle = `${Math.round(p.lat / 0.005)}|${Math.round(p.lon / 0.005)}`;
    if (!vus.has(cle)) vus.set(cle, { lat: p.lat, lon: p.lon });
  }
  return [...vus.values()];
}

function decouperParDistance(entries, refs) {
  const cle = refs.map((p) => `${p.lat},${p.lon}`).join(";");
  const enCache = cacheProches.get(entries);
  if (enCache && enCache.cle === cle) return enCache;
  // Une seule correction de longitude pour toute la zone (quelques dizaines
  // de km) : largement assez precis pour classer.
  const latMoy = refs.reduce((t, p) => t + p.lat, 0) / refs.length;
  const cosLat = Math.cos((latMoy * Math.PI) / 180);
  const rayonDeg2 = (RAYON_PROCHE_KM / 111) ** 2;
  const proches = [];
  const loin = [];
  for (const e of entries) {
    let d2 = Infinity;
    if (e.lat != null && e.lon != null) {
      for (const p of refs) {
        const dy = e.lat - p.lat;
        const dx = (e.lon - p.lon) * cosLat;
        const d = dx * dx + dy * dy;
        if (d < d2) d2 = d;
      }
    }
    (d2 <= rayonDeg2 ? proches : loin).push({ e, d2 });
  }
  const resultat = { cle, proches, loin };
  cacheProches.set(entries, resultat);
  return resultat;
}

function matchAdresseEntriesProches(entries, allTokens, limit, refs) {
  let numeroDigits = null;
  let wordTokens = allTokens;
  if (/^\d+[a-z]?$/.test(allTokens[0])) {
    numeroDigits = allTokens[0].replace(/\D/g, "");
    wordTokens = allTokens.slice(1);
  }
  if (wordTokens.length === 0) return [];

  const { proches, loin } = decouperParDistance(entries, refs);
  const classer = (liste) => {
    const meilleur = new Map(); // "rue|commune" -> { e, exact, d2 }
    for (const { e, d2 } of liste) {
      if (!wordTokens.every((t) => e._searchTokens.some((h) => h.startsWith(t)))) continue;
      const exact = numeroDigits != null && String(e.n || "") === numeroDigits ? 0 : 1;
      const cle = `${e.rn || e.r}|${e.cn || e.c}`;
      const actuel = meilleur.get(cle);
      if (!actuel || exact < actuel.exact || (exact === actuel.exact && d2 < actuel.d2)) {
        meilleur.set(cle, { e, exact, d2 });
      }
    }
    return [...meilleur.values()].sort((a, b) => a.exact - b.exact || a.d2 - b.d2);
  };

  const resultats = classer(proches);
  if (resultats.length < limit) resultats.push(...classer(loin));
  return resultats.slice(0, limit).map((x) => x.e);
}

// Fine couche DB : charge (et met en cache) toutes les entrees avec leurs
// tokens precalcules, puis delegue le matching a matchAdresseEntries.
export async function searchAdresses(rawQuery, limit = 8, options = {}) {
  const entries = await getAllBanEntriesCached();
  return matchAdresseEntries(entries, rawQuery, limit, options);
}
