import { appleMapsUrl, wazeUrl, googleMapsUrl, buildNavUrl, googleMapsSearchUrl } from "./deep-links.js";

let failures = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}
function assert(cond, label) {
  if (!cond) failures++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
}

// Cas reel du bug : "Grande Rue" existe dans des dizaines de communes du
// secteur, Waze en choisissait une autre que Rigny-la-Salle.
const arret = { lat: 48.5731, lon: 5.6842, label: "THIERRY LANTOINE", adresse: "11 Grande Rue, 55140 Rigny-la-Salle" };

console.log("=== La destination est le point GPS, jamais le texte de l'adresse ===");
{
  const waze = wazeUrl(arret);
  assertEqual(waze, "https://waze.com/ul?ll=48.5731,5.6842&navigate=yes", "Waze : coordonnees");
  assert(!waze.includes("Grande"), "Waze : le nom de rue n'est pas transmis (pas de re-geocodage)");
  assert(!waze.includes("q="), "Waze : jamais de recherche texte quand on a le point");

  const google = googleMapsUrl(arret);
  assert(google.includes("destination=48.5731%2C5.6842"), "Google : coordonnees en destination");
  assert(!google.includes("Grande"), "Google : le nom de rue n'est pas transmis");

  const apple = appleMapsUrl(arret);
  assert(apple.includes("daddr=48.5731%2C5.6842"), "Apple : coordonnees en destination");
  assert(apple.includes("dname=THIERRY+LANTOINE"), "Apple : le nom reste comme etiquette");
  assert(!apple.includes("Grande"), "Apple : le nom de rue n'est pas transmis");
}

console.log("\n=== Repli sur l'adresse texte quand il n'y a pas de point ===");
{
  const sansPoint = { lat: null, lon: null, label: "Client", adresse: "3 Rue des Lilas, 54200 Toul" };
  assert(wazeUrl(sansPoint).includes("q=3%20Rue%20des%20Lilas"), "Waze : recherche texte en repli");
  assert(googleMapsUrl(sansPoint).includes("destination=3%20Rue%20des%20Lilas"), "Google : adresse en repli");
  assert(appleMapsUrl(sansPoint).includes("daddr=3+Rue+des+Lilas"), "Apple : adresse en repli");
  // Colis geocode par coordonnees collees a la main : point present, pas
  // d'adresse canonique (formatAdresseForNav renvoie null) -- le point suffit.
  const manuel = { lat: 48.69, lon: 6.18, label: "ZI Est", adresse: null };
  assertEqual(wazeUrl(manuel), "https://waze.com/ul?ll=48.69,6.18&navigate=yes", "Waze : point seul");
  assert(googleMapsUrl(manuel).includes("destination=48.69%2C6.18"), "Google : point seul");
  assert(appleMapsUrl(manuel).includes("daddr=48.69%2C6.18"), "Apple : point seul");
}

console.log("\n=== Coordonnees invalides : traitees comme absentes ===");
{
  for (const mauvais of [{ lat: NaN, lon: 5 }, { lat: undefined, lon: undefined }, { lat: "48.5", lon: "5.6" }]) {
    const url = wazeUrl({ ...mauvais, adresse: "1 Rue A, 54000 Nancy" });
    assert(url.includes("q="), `repli texte pour lat=${String(mauvais.lat)} lon=${String(mauvais.lon)}`);
  }
}

console.log("\n=== buildNavUrl aiguille vers la bonne appli ===");
{
  assert(buildNavUrl("waze", arret).startsWith("https://waze.com/ul"), "waze");
  assert(buildNavUrl("google", arret).startsWith("https://www.google.com/maps/dir/"), "google");
  assert(buildNavUrl("apple", arret).startsWith("https://maps.apple.com/"), "apple");
  assert(buildNavUrl(undefined, arret).startsWith("https://maps.apple.com/"), "defaut : apple");
}

console.log("\n=== La recherche par nom, elle, reste bien du texte ===");
{
  assert(googleMapsSearchUrl("SAFRAN Commercy").includes("query=SAFRAN%20Commercy"), "recherche d'entreprise inchangee");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
