// Tests unitaires des formatteurs d'adresse purs de colis-store.js (aucun
// acces IndexedDB necessaire pour ces deux fonctions). Execute directement
// via `node js/scan/colis-store.test.mjs`, comme parse-ups-label.test.mjs.
import { formatAdresseAffichage, formatAdresseForNav } from "./colis-store.js";

let failures = 0;

function assertEqual(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

// --- Cas nominal : colis geocode via la BAN, adresseAffichage posee ---
console.log("\n=== Cas nominal : adresseAffichage posee par un match BAN ===");
{
  const colis = {
    adresseAffichage: "6 Rue de l'Église, 54470 Ansauville",
    adresseRaw: { rue: "6 RUE DE L EGLISE", cp: "54470", ville: "ANSAUVILLE" },
    geocode: { status: "ok", lat: 48.69, lon: 6.18 },
  };
  assertEqual(formatAdresseAffichage(colis), "6 Rue de l'Église, 54470 Ansauville", "affichage (BAN)");
  assertEqual(formatAdresseForNav(colis), "6 Rue de l'Église, 54470 Ansauville", "nav (BAN, identique a l'affichage)");
}

// --- Regression (bug terrain "adresse compressee envoyee au GPS") :
// coordonnees GPS collees a la main (adresse introuvable dans la BAN, ex:
// entreprise/zone industrielle, voir scan-ui.js's acceptManualCoords) --
// adresseAffichage reste null, formatAdresseAffichage retombe sur le texte
// brut qui a deja ECHOUE le geocodage automatique. Ce texte ne doit JAMAIS
// etre envoye a buildNavUrl/wazeUrl/googleMapsUrl/appleMapsUrl a la place des
// coordonnees precises que le livreur vient de fournir -- formatAdresseForNav
// doit retourner null dans ce cas pour forcer le repli sur lat/lon (voir
// deep-links.js, qui ne retombe sur lat/lon que si `adresse` est absent). ---
console.log("\n=== Regression : geocode.manual -> formatAdresseForNav doit renvoyer null ===");
{
  const colis = {
    adresseAffichage: null,
    adresseRaw: { rue: "ZI DES ACACIAS", cp: "54000", ville: "NANCY" },
    geocode: { status: "ok", lat: 48.6905, lon: 6.1826, candidates: [], manual: true },
  };
  assertEqual(
    formatAdresseAffichage(colis),
    "ZI DES ACACIAS, 54000 NANCY",
    "affichage (repli adresseRaw, texte qui a echoue le geocodage -- OK pour un simple libelle)"
  );
  assertEqual(
    formatAdresseForNav(colis),
    null,
    "nav (JAMAIS ce texte -- doit etre null pour que buildNavUrl retombe sur lat/lon)"
  );
}

// --- Cas limite : geocode.manual mais adresseRaw entierement vide ---
console.log("\n=== Cas limite : geocode.manual, adresseRaw vide ===");
{
  const colis = {
    adresseAffichage: null,
    adresseRaw: { rue: "", cp: "", ville: "" },
    geocode: { status: "ok", lat: 48.6905, lon: 6.1826, manual: true },
  };
  assertEqual(formatAdresseAffichage(colis), "(adresse à vérifier)", "affichage (repli texte vide)");
  assertEqual(formatAdresseForNav(colis), null, "nav (toujours null pour geocode.manual, quel que soit adresseRaw)");
}

console.log(`\n${failures === 0 ? "TOUS LES TESTS SONT PASSES" : `${failures} ECHEC(S)`}`);
process.exit(failures === 0 ? 0 : 1);
