import { parseAddressList, classifyBlockLines, groupLinesIntoBlocks } from "./parse-address-list.js";

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

// Fabrique des lignes OCR factices avec bbox : chaque ligne fait 20px de
// haut, espacees de `gap` px entre elles (gap grand = coupure de bloc).
function line(text, y, height = 20) {
  return { text, bbox: { x0: 0, y0: y, x1: 200, y1: y + height } };
}

console.log("=== Cas 1 : 3 clients, 3 lignes chacun (nom/rue/ville), separes par un grand espace ===");
{
  const ocrLines = [
    line("Jean Dupont", 0),
    line("6 Rue de l'Eglise", 24),
    line("54470 Ansauville", 48),
    // grand ecart ici (trait separateur)
    line("Marie Martin", 150),
    line("12 Avenue de la Liberation", 174),
    line("54000 Nancy", 198),
    line("8 Impasse des Lilas", 300),
    line("57000 Metz", 324),
  ];
  const result = parseAddressList(ocrLines);
  assertEqual(result.length, 3, "3 blocs detectes");
  assertEqual(result[0].nom, "Jean Dupont", "bloc 1 : nom");
  assertEqual(result[0].rue, "6 Rue de l'Eglise", "bloc 1 : rue");
  assertEqual(result[0].ville, "Ansauville", "bloc 1 : ville");
  assertEqual(result[1].nom, "Marie Martin", "bloc 2 : nom");
  assertEqual(result[2].nom, null, "bloc 3 : pas de nom (colis sans nom, pas grave)");
  assertEqual(result[2].rue, "8 Impasse des Lilas", "bloc 3 : rue");
  assertEqual(result[2].cp, "57000", "bloc 3 : cp");
}

console.log("\n=== Cas 2 : rue et debut de ville colles sur la meme ligne ===");
{
  const ocrLines = [line("12 Avenue de la Liberation 54000 Nancy", 0)];
  const result = parseAddressList(ocrLines);
  assertEqual(result.length, 1, "1 bloc detecte");
  assertEqual(result[0].rue, "12 Avenue de la Liberation", "rue extraite sans le cp/ville colle");
  assertEqual(result[0].cp, "54000", "cp extrait de la ligne colle");
  assertEqual(result[0].ville, "Nancy", "ville extraite de la ligne colle");
}

console.log("\n=== Cas 3 : casse normale (pas tout en majuscules, contrairement a une etiquette imprimee) ===");
{
  const ocrLines = [line("Sophie Avril", 0), line("3 rue des Acacias", 24), line("54470 ansauville", 48)];
  const result = parseAddressList(ocrLines);
  assertEqual(result[0].nom, "Sophie Avril", "nom en casse normale non confondu avec un mot-cle de voie (Avril contient 'av')");
  assertEqual(result[0].ville, "ansauville", "ville en minuscules correctement extraite");
}

console.log("\n=== Cas 4 : bloc sans aucune adresse exploitable (bruit) ignore ===");
{
  const ocrLines = [line("Ma Tournee du Jour", 0), line("6 Rue de l'Eglise", 24), line("54470 Ansauville", 48)];
  const result = parseAddressList(ocrLines);
  assertEqual(result.length, 1, "le titre sans rue/cp au-dessus n'est pas retenu comme bloc separe");
}

console.log("\n=== Cas 5 : vrai format terminal UPS -- rue / ville / CP sur 3 lignes SEPAREES (pas 'cp ville' colle) ===");
{
  const knownCities = new Set(["dommartin les toul"]); // forme "loose" (sans tirets) -- voir looseCommune
  const ocrLines = [
    line("AKHRAZ HASSAN", 0),
    line("14 GENERAL LECLERC AVE", 24),
    line("DOMMARTIN LES TOUL", 48),
    line("54200", 72),
  ];
  const result = parseAddressList(ocrLines, { knownCities });
  assertEqual(result.length, 1, "1 bloc detecte");
  assertEqual(result[0].nom, "AKHRAZ HASSAN", "nom correctement isole (pas ecrase par la ville)");
  assertEqual(result[0].rue, "14 GENERAL LECLERC AVE", "rue sans le CP colle a tort (ancien bug)");
  assertEqual(result[0].ville, "DOMMARTIN LES TOUL", "ville reconnue via knownCities malgre l'absence de CP sur la meme ligne");
  assertEqual(result[0].cp, "54200", "CP seul sur sa ligne correctement isole (ancien bug : partait dans la rue)");
}

console.log("\n=== Cas 6 : retour a la ligne d'une rue trop longue (continuation rattachee a la rue, pas au nom) ===");
{
  const ocrLines = [
    line("Paul Petit", 0),
    line("3 Rue du General de", 24),
    line("Gaulle", 48),
    line("54470 Ansauville", 72),
  ];
  const result = parseAddressList(ocrLines);
  assertEqual(result[0].nom, "Paul Petit", "nom non pollue par la 2e ligne de la rue");
  assertEqual(result[0].rue, "3 Rue du General de Gaulle", "rue reconstituee sur ses 2 lignes");
}

console.log("\n=== Cas 7 : ville affichee en double (libelle de zone + ville reelle) -- pas de concatenation ===");
{
  const knownCities = new Set(["dommartin les toul"]); // forme "loose" (sans tirets) -- voir looseCommune
  const ocrLines = [
    line("CHAUSSEA", 0),
    line("Dommartin-les-Toul", 24), // libelle de zone au-dessus du bloc (meme ville, redondant)
    line("JONCHERY RUE", 48),
    line("Dommartin-les-Toul", 72), // ville propre de l'adresse
    line("54200", 96),
  ];
  const result = parseAddressList(ocrLines, { knownCities });
  assertEqual(result[0].ville, "Dommartin-les-Toul", "dernier match l'emporte, pas de doublon concatene");
}

console.log("\n=== Cas 8 : sans knownCities (Set vide, comportement par defaut), une ville seule sans CP est rattachee a la rue (repli continuation) ===");
{
  // Degradation gracieuse documentee : sans base de reference, impossible de
  // distinguer une ville d'un nom par la seule forme du texte -- le repli
  // "continuation du champ precedent" (ligne suivant une rue) l'emporte,
  // donc la ville finit ajoutee a la rue plutot que de corrompre le nom.
  // Le bloc reste retenu (rue non vide), juste sans ville extraite.
  const ocrLines = [line("14 GENERAL LECLERC AVE", 0), line("DOMMARTIN LES TOUL", 24)];
  const result = parseAddressList(ocrLines);
  assertEqual(result[0].rue, "14 GENERAL LECLERC AVE DOMMARTIN LES TOUL", "rue englobe la ligne non identifiee (repli, pas une perte)");
  assertEqual(result[0].ville, null, "ville non extraite sans knownCities (attendu, pas une regression)");
}

console.log("\n=== Cas 9 : bruit d'interface (distance 'Xkm') entre deux clients -- reproduit un bug reel de fusion de blocs ===");
{
  // Retour terrain : "il y avait 4 adresses sur la photo, tu m'en a sorti
  // qu'une" -- reproduit ici avec les VRAIES 4 adresses et la ligne de
  // distance qui s'affiche entre chaque client sur le vrai terminal, tres
  // proche du CP precedent. Avant le correctif : la ligne "Xkm" cassait
  // l'ecart en deux plus petits (ni l'un ni l'autre au-dessus du seuil),
  // 2 clients fusionnaient en un seul bloc corrompu.
  const knownCities = new Set(["dommartin les toul"]);
  const ocrLines = [
    line("CHAUSSEA", 0), line("Dommartin-les-Toul", 26), line("JONCHERY RUE", 52), line("DOMMARTIN-LES-TOUL", 78), line("54200", 104),
    line("21.8km", 112),
    line("Marie-Adele GLOTZ", 180), line("6 8EME BCP RUE", 206), line("DOMMARTIN LES TOUL", 232), line("54200", 258),
    line("22.44km", 266),
    line("JEANNE D'ARC RUE", 340), line("DOMMARTIN-LES-TOUL", 366), line("54200", 392),
    line("22.34km", 400),
    line("AKHRAZ HASSAN", 460), line("14 GENERAL LECLERC AVE", 486), line("DOMMARTIN LES TOUL", 512), line("54200", 538),
    line("22.83km", 546),
  ];
  const result = parseAddressList(ocrLines, { knownCities });
  assertEqual(result.length, 4, "les 4 adresses restent 4 blocs distincts (pas de fusion)");
  assertEqual(result[0].rue, "JONCHERY RUE", "rue non polluee par la distance (pas de '21.8km' ajoute)");
  assertEqual(result[3].nom, "AKHRAZ HASSAN", "4e adresse bien isolee, pas fusionnee avec la 3e");
}

console.log("\n=== groupLinesIntoBlocks : seuil relatif a la hauteur de ligne ===");
{
  // Lignes petites (10px), ecart de 20px doit quand meme couper (ratio > 1.6)
  const smallLines = [line("A", 0, 10), line("B", 12, 10), line("C", 40, 10)];
  const blocks = groupLinesIntoBlocks(smallLines);
  assertEqual(blocks.length, 2, "coupure detectee meme avec de petites lignes (seuil relatif, pas absolu)");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
