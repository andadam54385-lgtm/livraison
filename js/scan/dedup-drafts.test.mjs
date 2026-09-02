import { isSameAddress, mergeDraftInto, ingestDrafts } from "./dedup-drafts.js";

let failures = 0;
function assertEqual(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

const d = (rue, ville = null, cp = null, nom = null) => ({ rue, ville, cp, nom, bbox: null });

console.log("=== Fiche coupee par le bord BAS du cadre (fragment = debut de la rue) ===");
{
  assertEqual(
    isSameAddress(d("15 RUE DU MARECHAL"), d("15 RUE DU MARECHAL LANNES SAVONNIERES DEVANT BAR")),
    true,
    "un prefixe suffisamment long identifie la meme fiche"
  );
}

console.log("\n=== Fiche coupee par le bord HAUT du cadre (fragment = fin de la rue) ===");
{
  // Cas reels releves dans le compte rendu OCR d'une video de 63 arrets
  // (terrain 2026-09-01) : l'ecran defile, chaque image coupe la fiche du
  // haut, et le fragment perd son DEBUT. Le test par prefixe ne voyait rien
  // et chacun de ces fragments devenait un arret fantome de plus.
  assertEqual(
    isSameAddress(d("ERATION AVE"), d("10 LIBERATION AVE")),
    true,
    "'ERATION AVE' est reconnu comme la fin de '10 LIBERATION AVE'"
  );
  assertEqual(isSameAddress(d("SSAGE RUE"), d("12 PASSAGE RUE")), true, "'SSAGE RUE' = fin de '12 PASSAGE RUE'");
}

console.log("\n=== Garde-fou : deux numeros differents de la MEME rue restent distincts ===");
{
  // "rue des allies" est la fin de "1 rue des allies" comme de "3 rue des
  // allies" : sans garde-fou, la correspondance par la fin fusionnerait deux
  // livraisons bien reelles. Un fragment de bord de cadre a justement perdu
  // son numero, donc un texte qui COMMENCE par un numero n'en est pas un.
  assertEqual(isSameAddress(d("1 RUE DES ALLIES"), d("3 RUE DES ALLIES")), false, "1 vs 3 rue des Allies : distincts");
  assertEqual(
    isSameAddress(d("12 ROCHELLE BLVD"), d("8 ROCHELLE BLVD")),
    false,
    "12 vs 8 boulevard de la Rochelle : distincts"
  );
}

console.log("\n=== Clients reels SANS numero de voie (entreprises) : jamais absorbes ===");
{
  // Retour terrain du build 121 ("il a trouve moins d'adresses qu'en
  // realite") : trois clients reels de la meme rue, dont un sans numero.
  const yzance = d("GRANDE TERRE ALL", "BAR-LE-DUC", "55000", "YZANCE");
  const bridji = d("1 GRANDE TERRE ALL", "BAR LE DUC", "55000", "Kader Bridji");
  const audition = d("6 GRANDE TERRE ALL MEUSE", "BAR-LE-DUC", "55000", "AUDITION MUTUALISTE");
  assertEqual(isSameAddress(yzance, bridji), false, "YZANCE (sans numero) distinct de 1 GRANDE TERRE ALL");
  assertEqual(isSameAddress(yzance, audition), false, "YZANCE distinct de 6 GRANDE TERRE ALL MEUSE");
  assertEqual(isSameAddress(bridji, audition), false, "les deux clients numerotes restent distincts");
  const collected = [];
  ingestDrafts(collected, [yzance]);
  ingestDrafts(collected, [bridji, audition]);
  assertEqual(collected.length, 3, "trois arrets retenus pour trois clients");
}

console.log("\n=== Meme fiche lue avec et sans tirets dans la commune : dedupliquee ===");
{
  assertEqual(
    isSameAddress(d("10 LIBERATION AVE", "FAINS-VEEL", "55000"), d("10 LIBERATION AVE", "FAINS VEEL", "55000")),
    true,
    "FAINS-VEEL et FAINS VEEL sont la meme commune"
  );
}

console.log("\n=== Un CP ou une commune qui divergent tranchent toujours ===");
{
  assertEqual(isSameAddress(d("53 FOUR RUE", null, "55000"), d("53 FOUR RUE", null, "55500")), false, "CP differents");
  assertEqual(
    isSameAddress(d("ERATION AVE", "Bar-le-Duc"), d("10 LIBERATION AVE", "Fains-Veel")),
    false,
    "communes differentes : pas de fusion malgre la fin commune"
  );
}

console.log("\n=== Fragment trop court : jamais fusionne au hasard ===");
{
  assertEqual(isSameAddress(d("RUE"), d("10 LIBERATION AVE")), false, "'RUE' seul ne suffit pas");
}

console.log("\n=== mergeDraftInto complete les champs manquants ===");
{
  const existant = d("ERATION AVE");
  mergeDraftInto(existant, d("10 LIBERATION AVE", "Fains-Veel", "55000", "Fenetre du Barrois"));
  assertEqual(existant.rue, "10 LIBERATION AVE", "la rue la plus complete gagne");
  assertEqual(existant.cp, "55000", "le CP absent est repris");
  assertEqual(existant.ville, "Fains-Veel", "la commune absente est reprise");
  assertEqual(existant.nom, "Fenetre du Barrois", "le nom absent est repris");
}

console.log("\n=== ingestDrafts : 4 images d'une meme fiche -> 1 seul arret ===");
{
  const collected = [];
  // Ce que quatre images successives d'un ecran qui defile produisent pour
  // UNE seule fiche : coupee en bas, entiere, coupee en haut, entiere.
  ingestDrafts(collected, [d("10 LIBERATION")]);
  ingestDrafts(collected, [d("10 LIBERATION AVE", "Fains-Veel", "55000")]);
  ingestDrafts(collected, [d("ERATION AVE")]);
  ingestDrafts(collected, [d("10 LIBERATION AVE", "Fains-Veel", "55000", "Fenetre du Barrois")]);
  assertEqual(collected.length, 1, "un seul arret retenu");
  assertEqual(collected[0].cp, "55000", "les champs des meilleures lectures sont conserves");
  assertEqual(collected[0].nom, "Fenetre du Barrois", "le nom lu plus tard est repris");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
