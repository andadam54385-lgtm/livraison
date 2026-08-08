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

console.log("\n=== groupLinesIntoBlocks : seuil relatif a la hauteur de ligne ===");
{
  // Lignes petites (10px), ecart de 20px doit quand meme couper (ratio > 1.6)
  const smallLines = [line("A", 0, 10), line("B", 12, 10), line("C", 40, 10)];
  const blocks = groupLinesIntoBlocks(smallLines);
  assertEqual(blocks.length, 2, "coupure detectee meme avec de petites lignes (seuil relatif, pas absolu)");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
