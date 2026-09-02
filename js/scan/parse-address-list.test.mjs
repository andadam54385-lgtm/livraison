import { parseAddressList, classifyBlockLines, groupLinesIntoBlocks } from "./parse-address-list.js";
import { looseCommune } from "../geocode/match-address.js";
import { normalizeCity } from "../geocode/normalize-address.js";

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

console.log("\n=== Cas 10 : terminal Chronopost (statut/code/compteur/heure/bandeau d'instruction) -- reproduit '118 adresses au lieu de 27' ===");
{
  // Retour terrain : un terminal plus charge visuellement qu'UPS (code de
  // tournee "C18"/"C13", statut "TRANSFERE"/"EN COURS", compteur enveloppe/
  // colis "0 / 1", heure seule en plus de la distance, et des bandeaux
  // d'instruction en texte libre suivis d'un numero de suivi) faisait
  // exploser chaque client en plusieurs faux clients (118 adresses extraites
  // pour 27 arrets reels) : chaque element non reconnu devenait soit un faux
  // nom ("TRANSFERE" pris pour le destinataire), soit un faux bloc a part
  // entiere, soit polluait la rue.
  const knownCities = new Set(["fremifontaine", "celles sur plaine"]);
  const ocrLines = [
    // Client 1 : carte simple (pas de bandeau), avec tout le bruit d'interface autour.
    line("SERGE CORCERET - SERGE CORCERET", 0),
    line("C18", 6, 18), // code tournee sur la meme rangee visuelle que le nom (petit decalage y, pas un vrai ecart de bloc)
    line("30 RUE DES TILLEULS", 30),
    line("88600 FREMIFONTAINE", 56),
    line("0 / 0", 82, 16),
    line("TRANSFERE", 100, 16),
    line("11 km", 118, 16),
    line("11:45", 136, 16),
    // grand ecart -> nouveau client
    line("RENAUD FROMENT", 260),
    line("C13", 266, 18),
    line("33 GRANDE RUE", 290),
    line("88110 CELLES SUR PLAINE", 316),
    line("0 / 1", 342, 16),
    line("EN COURS", 360, 16),
    line("42 km", 378, 16),
    line("12:26", 396, 16),
    // Bandeau d'instruction en texte libre + numero de suivi -- toujours DANS la carte du client 2, ne doit ni le fusionner avec un client 3 ni devenir sa propre entree.
    line("Attention consigne de livraison", 414, 16),
    line("Relais/BP interdit. 2e livraison demain si non livre", 432, 16),
    line("NX006123474FR", 450, 16),
  ];
  const result = parseAddressList(ocrLines, { knownCities });
  assertEqual(result.length, 2, "2 clients extraits (pas 8+ a cause du bruit/bandeau)");
  assertEqual(result[0].nom, "SERGE CORCERET - SERGE CORCERET", "client 1 : nom non ecrase par 'TRANSFERE'/'C18'/etc.");
  assertEqual(result[0].rue, "30 RUE DES TILLEULS", "client 1 : rue non polluee par le compteur/statut/distance/heure");
  assertEqual(result[1].nom, "RENAUD FROMENT", "client 2 : nom non ecrase malgre le bandeau d'instruction qui suit");
  assertEqual(result[1].rue, "33 GRANDE RUE", "client 2 : rue non polluee par le bandeau ni le numero de suivi");
  assertEqual(result[1].cp, "88110", "client 2 : CP toujours capture malgre le bruit avant/apres");
}

console.log("\n=== Cas 11 : bandeau d'instruction fusionne par l'OCR sur la MEME ligne qu'un vrai champ ===");
{
  // Cas observe reellement : l'OCR regroupe parfois plusieurs rangees
  // visuelles en une seule "ligne" detectee -- ici la distance ET le debut du
  // bandeau atterrissent sur la meme ligne que la rue. Seule la partie AVANT
  // l'ancre doit etre gardee.
  const ocrLines = [
    line("AKHRAZ HASSAN", 0),
    line("14 GENERAL LECLERC AVE 42 km Attention consigne de livraison", 26),
    line("Relais/BP interdit. 2e livraison demain si non livre", 52),
    line("NX006123474FR", 78),
    line("88600 Dommartin les Toul", 104),
  ];
  const result = parseAddressList(ocrLines, { knownCities: new Set() });
  assertEqual(result.length, 1, "1 seul client (pas de faux bloc a partir du bandeau)");
  assertEqual(result[0].rue, "14 GENERAL LECLERC AVE", "rue tronquee juste avant l'ancre du bandeau, distance/bandeau/suivi exclus");
  assertEqual(result[0].cp, "88600", "CP toujours capture apres le bandeau/numero de suivi");
}

console.log("\n=== Cas 12 : badge d'un transporteur JAMAIS rencontre -- verifie la generalisation (pas juste le vocabulaire Chronopost) ===");
{
  // Retour terrain : "il faut que ca marche peu importe la mise en forme" --
  // ce cas invente un mot-badge qui n'apparait dans AUCUN des motifs fixes
  // (NOISE_LINE_PATTERNS ne connait que TRANSFERE/EN COURS/AGENCE/PART/PRO/
  // C<n>/AGC). S'il est correctement ignore, c'est que looksLikeUiChrome
  // (forme : court, sans espace, tout en majuscules -- pas un vocabulaire
  // fixe) fonctionne bien au-dela des transporteurs deja vus.
  const ocrLines = [
    line("XPRESSDEP", 0), // badge fictif, jamais dans NOISE_LINE_PATTERNS
    line("Julie Renard", 26),
    line("5 Rue des Merles", 52),
    line("57000 Metz", 78),
  ];
  const result = parseAddressList(ocrLines, { knownCities: new Set() });
  assertEqual(result.length, 1, "1 seul bloc (le badge inconnu ne cree pas de faux client)");
  assertEqual(result[0].nom, "Julie Renard", "nom correct, pas ecrase par le badge inconnu");
  assertEqual(result[0].rue, "5 Rue des Merles", "rue non polluee par le badge inconnu");
}

console.log("\n=== Cas 13 : texte parasite a plusieurs mots (trop long pour un nom) -- rejete, contrairement a un vrai nom court ===");
{
  // Retour terrain : "un nom c'est 1 ou 2 mots, 3 grand max, on evite les
  // mots a rallonge" -- looksLikeUiChrome n'attrape que les badges SANS
  // espace ; un texte parasite plus long (fusion OCR de plusieurs elements)
  // passait encore au travers avant ce correctif.
  const ocrLines = [
    line("Vue synthese generale affichee ici maintenant", 0), // 6 mots, aucun mot-cle de voie -> rejete
    line("Marie Dupont", 26), // 2 mots -> accepte (dernier "nom" retenu)
    line("8 Rue des Tilleuls", 52),
    line("57000 Metz", 78),
  ];
  const result = parseAddressList(ocrLines, { knownCities: new Set() });
  assertEqual(result[0].nom, "Marie Dupont", "texte parasite ignore, vrai nom court retenu");
}
{
  // Motif reel a tiret ("SERGE CORCERET - SERGE CORCERET", voir Cas 10) :
  // verifie ici isolement que 2 clauses courtes de part et d'autre du tiret
  // restent acceptees (pas juste re-teste via un cas plus large).
  const ocrLines = [line("Jean Petit - Jean Petit", 0), line("2 Rue du Lac", 26), line("57000 Metz", 52)];
  const result = parseAddressList(ocrLines, { knownCities: new Set() });
  assertEqual(result[0].nom, "Jean Petit - Jean Petit", "nom repete avec tiret toujours accepte (2 mots de chaque cote)");
}
{
  // Mais un vrai texte long des DEUX cotes du tiret reste rejete (le tiret
  // seul ne doit pas devenir une echappatoire a la limite de mots).
  const ocrLines = [
    line("Message affiche pour information seulement - a traiter avant midi", 0),
    line("9 Cours du Lac", 26),
    line("57000 Metz", 52),
  ];
  const result = parseAddressList(ocrLines, { knownCities: new Set() });
  assertEqual(result[0].nom, null, "texte long de part et d'autre du tiret toujours rejete");
}

console.log("\n=== Cas 14 : terminal 'Itineraire' (retour terrain '138 points au lieu de 60') ===");
{
  // Transcrit d'une vraie video du terminal (2026-09-01) : colonne de droite
  // (badge "8000 | 0+1", creneaux, "999X99", telephones, distances) fusionnee
  // par l'OCR avec les lignes de gauche, ville et CP sur des lignes SEPAREES,
  // commune repliee sur plusieurs lignes avec duplication OCR, pied d'ecran.
  let y14 = 0;
  const L14 = (text, gapBefore = 4) => {
    y14 += gapBefore + 20;
    return { text, bbox: { x0: 0, y0: y14, x1: 300, y1: y14 + 20 } };
  };
  const lines14 = [
    L14("PRESSE"),
    L14("1 RUE DES ALLIES"),
    L14("LONGEVILLE-EN-BARROIS 14:30 - 18:30"),
    L14("LONGEVILLE-EN-BARROIS 33630369559"),
    L14("55000"),
    L14("BM TABAC PRESSE"),
    L14("THOMAS ANTHONY 8000 | 0+1", 40),
    L14("1 ALLIES RUE"),
    L14("LONGEVILLE EN BARROIS 15:10 - 17:10"),
    L14("55000"),
    L14("74.43km"),
    L14("Mickael Caillon 8000 | 0+1", 40),
    L14("83 BOURG RUE"),
    L14("BAR LE DUC 55000 15:20 - 17:20"),
    L14("79.01km"),
    L14("UPS AP LOCA EST 999X99", 40),
    L14("15 RUE DU MARECHAL"),
    L14("LANNES 14:30 - 17:30"),
    L14("SAVONNIERES DEVANT"),
    L14("BAR SAVONNIERES 0821233877"),
    L14("DEVANT BAR 55000"),
    L14("LOCA EST 77.02km"),
    L14("Eteindre le Diad", 40),
  ];
  const knownCities14 = new Set(
    ["Longeville-en-Barrois", "Bar-le-Duc", "Savonnières-devant-Bar", "Resson", "Culey"].map((c) => looseCommune(normalizeCity(c)))
  );
  const res14 = parseAddressList(lines14, { knownCities: knownCities14 });
  assertEqual(res14.length, 4, "4 clients exactement (pas 8+ par sur-decoupage, pied d'ecran ignore)");
  assertEqual(res14[0].rue, "1 RUE DES ALLIES", "relai : rue");
  assertEqual(res14[0].cp, "55000", "relai : CP seul sur sa ligne capture");
  assertEqual(res14[0].ville, "LONGEVILLE-EN-BARROIS", "relai : commune reconnue malgre creneau/telephone fusionnes");
  assertEqual(res14[1].nom, "THOMAS ANTHONY", "client 2 : nom sans le badge '8000 | 0+1'");
  assertEqual(res14[1].rue, "1 ALLIES RUE", "client 2 : rue");
  assertEqual(res14[1].ville, "LONGEVILLE EN BARROIS", "client 2 : ville sans le creneau fusionne");
  assertEqual(res14[1].cp, "55000", "client 2 : CP");
  assertEqual(res14[2].nom, "Mickael Caillon", "client 3 : nom sans badge");
  assertEqual(res14[2].cp, "55000", "client 3 : cp extrait de 'BAR LE DUC 55000 15:20 - 17:20'");
  assertEqual(res14[3].cp, "55000", "client 4 : UN seul bloc malgre commune repliee + telephone + 999X99");
  assertEqual((res14[3].rue || "").startsWith("15 RUE DU MARECHAL LANNES"), true, "client 4 : la rue commence par la vraie rue");
}

console.log("\n=== Cas 15 : video du terminal, bruit AU MILIEU des lignes (retour terrain 2026-09-01) ===");
{
  // Transcrit des captures reelles de l'ecran de verification : le bruit de
  // la colonne de droite se retrouve fusionne AU MILIEU du texte utile, et
  // plusieurs clients tombent dans un seul bloc (l'ecart vertical disparait
  // quand l'OCR fusionne des lignes).
  let y15 = 0;
  const L15 = (text, gapBefore = 4) => {
    y15 += gapBefore + 20;
    return { text, bbox: { x0: 0, y0: y15, x1: 300, y1: y15 + 20 } };
  };
  const knownCities15 = new Set(
    ["Bar-le-Duc", "Longeville-en-Barrois", "Ligny-en-Barrois", "Resson"].map((c) => looseCommune(normalizeCity(c)))
  );
  const knownCps15 = new Set(["55000", "55500", "55210"]);

  // (a) bruit collé au nom et à la ville, un seul vrai client
  const clientA = parseAddressList(
    [L15("ckael Caillon 8000 | 0:"), L15("83 BOURG RUE"), L15("BAR LE DUC 15:20-17:20 ©"), L15("55000")],
    { knownCities: knownCities15, knownCps: knownCps15 }
  );
  assertEqual(clientA.length, 1, "(a) un seul client");
  assertEqual(clientA[0].nom, "ckael Caillon", "(a) nom nettoye du badge '8000 | 0:'");
  assertEqual(clientA[0].rue, "83 BOURG RUE", "(a) rue");
  assertEqual(clientA[0].cp, "55000", "(a) CP");

  // (b) bloc FUSIONNE : deux clients, deux CP -> doit etre recoupe
  const fusionne = parseAddressList(
    [
      L15("12.61km Q OPTICIENS KRYS 8000 | 0+1"),
      L15("7 ANDRE MAGINOT 11:30-13:30 ©"),
      L15("BAR-LE-DUC"),
      L15("55000"),
      L15("PIED AURE 8000 | 0+2"),
      L15("11 ROCHELLE BLVD"),
      L15("BAR LE DUC 11:40 - 13:40 ©"),
      L15("55000"),
    ],
    { knownCities: knownCities15, knownCps: knownCps15 }
  );
  assertEqual(fusionne.length, 2, "(b) le bloc fusionne est recoupe en 2 clients");
  assertEqual(fusionne[0].rue, "7 ANDRE MAGINOT", "(b) client 1 : rue sans le creneau");
  assertEqual(fusionne[1].rue, "11 ROCHELLE BLVD", "(b) client 2 : rue");

  // (c) faux codes postaux inventes par l'OCR -> aucun client fabrique
  const fauxCp = parseAddressList(
    [L15("11:30-13:30 ® ., 55014 é"), L15("EXELMANS RUE BARYE DUC, 55096"), L15("35 AP LOCA EST 8000 | 0+1 @ 4 BAR VOIE lo RESSON 55000 15:50 - 17:50 (©, 99999")],
    { knownCities: knownCities15, knownCps: knownCps15 }
  );
  assertEqual(
    fauxCp.every((b) => !b.cp || knownCps15.has(b.cp)),
    true,
    "(c) aucun CP invente (55014/55096/99999) n'est retenu"
  );

  // (d) residus purs : jamais retenus comme clients
  for (const bruit of ["n° 1.73km Q", "8000 | 0+1 RD = -Itinéraire,", "0329783111 & * 2.24km Q,", "A9 9.73km Q"]) {
    const r = parseAddressList([L15(bruit)], { knownCities: knownCities15, knownCps: knownCps15 });
    assertEqual(r.length, 0, `(d) residu ecarte : ${bruit}`);
  }
}

console.log("\n=== Cas 16 : marqueurs de distance, chrome telephone, badges a espace (terrain 2026-09-01 soir) ===");
{
  let y16 = 0;
  const L16 = (text, gapBefore = 4) => {
    y16 += gapBefore + 20;
    return { text, bbox: { x0: 0, y0: y16, x1: 300, y1: y16 + 20 } };
  };
  const knownCities16 = new Set(["Bar-le-Duc", "Velaines"].map((c) => looseCommune(normalizeCity(c))));
  const knownCps16 = new Set(["55000", "55500"]);
  const opts16 = { knownCities: knownCities16, knownCps: knownCps16 };

  // (a) FUSION coupee sur les marqueurs de distance. Disposition FIDELE au
  // terminal : chaque fiche porte bien sa ligne "COMMUNE CP" (verifie sur le
  // compte rendu OCR d'une vraie video, images 4/5/7), ce que la premiere
  // version de ce cas omettait pour le client KULLMANN.
  const fusion = parseAddressList(
    [
      L16("10.5km Q PE 2 KULLMANN IMP 10:30 - 12:30 ®"),
      L16("BAR LE DUC 55000"),
      L16("10.84km Q EURLGREGAUTO 8000 | 0+1 D 4 9EME RI AVE BAR-LE-DUC"),
      L16("55000 10:30-12:30 © ,, BAR LE DUC"),
    ],
    opts16
  );
  assertEqual(fusion.length >= 2, true, "(a) la fusion est coupee sur les marqueurs de distance");
  assertEqual(
    fusion.some((b) => (b.rue || "").includes("KULLMANN")),
    true,
    "(a) le premier client (KULLMANN) est isole"
  );

  // (a-bis) L'intention d'origine de (a) : le marqueur de distance coupe TOUT
  // SEUL, sans l'aide d'un second code postal. Verifiee sans base de reference
  // (Sets vides), ou le filtre "fiche localisable" ne s'applique pas -- c'est
  // bien le decoupage qu'on teste ici, pas la retention.
  const fusionSansRef = parseAddressList([
    L16("10.5km Q PE 2 KULLMANN IMP 10:30 - 12:30 ®"),
    L16("10.84km Q EURLGREGAUTO 8000 | 0+1 D 4 9EME RI AVE BAR-LE-DUC"),
    L16("55000 10:30-12:30 © ,, BAR LE DUC"),
  ]);
  assertEqual(fusionSansRef.length >= 2, true, "(a-bis) le marqueur de distance coupe sans second CP");
  assertEqual(
    fusionSansRef.some((b) => (b.rue || "").includes("KULLMANN")),
    true,
    "(a-bis) KULLMANN isole sans base de reference"
  );

  // (b) chrome du telephone + de l'appli : jamais un client
  for (const chrome of [
    "19 F-Bouyques Telecom (2) 9 © 4 80% M = itineraire 2 @ : LISTE(63) | CARTE SYNTHESE | CREER",
    "LISTE(58) — CARTE -— SYNTHÈSE — CRÉER",
  ]) {
    assertEqual(parseAddressList([L16(chrome)], opts16).length, 0, `(b) chrome ecarte : ${chrome.slice(0, 28)}...`);
  }

  // (c) distance en METRES (pas seulement km)
  const metres = parseAddressList([L16("717.01m Q 3 ANTOINE LAVOISIERALL 4000 | 1140"), L16("55500")], opts16);
  assertEqual(
    metres.every((b) => !/717/.test(b.rue || "")),
    true,
    "(c) la distance en metres est retiree de la rue"
  );

  // (d) badge a ESPACE ("4000 | 140 87") nettoye du nom
  const badge = parseAddressList([L16("EDF 4000 | 140 87"), L16("2 NOTRE DAME RUE"), L16("55500")], opts16);
  assertEqual(badge.length, 1, "(d) un seul client");
  assertEqual(badge[0].nom, "EDF", "(d) nom nettoye du badge a espace");
}

console.log("\n=== Cas 17 : compte rendu OCR d'une vraie video (63 arrets, terrain 2026-09-01) ===");
{
  let y17 = 0;
  const L17 = (text, gapBefore = 4) => {
    y17 += gapBefore + 20;
    return { text, bbox: { x0: 0, y0: y17, x1: 300, y1: y17 + 20 } };
  };
  const knownCities17 = new Set(
    ["Bar-le-Duc", "Fains-Veel", "Velaines", "Ligny-en-Barrois", "Louppy-le-Chateau"].map((c) =>
      looseCommune(normalizeCity(c))
    )
  );
  const knownCps17 = new Set(["55000", "55500", "55800"]);
  const opts17 = { knownCities: knownCities17, knownCps: knownCps17 };

  // (a) Ordre "<rue> <VILLE> <CP>" sur une seule ligne, avec la ponctuation
  // parasite que l'OCR colle derriere le code postal. Avant : la commune
  // restait dans la rue et le CP n'etait pas vu du tout -> "a verifier".
  const villeAvantCp = parseAddressList([L17("AUDITION HUSSON"), L17("1 VERDUN RUE BAR LE DUC 55000 )")], opts17);
  assertEqual(villeAvantCp.length, 1, "(a) une seule fiche");
  assertEqual(villeAvantCp[0].rue, "1 VERDUN RUE", "(a) la commune est retiree de la rue");
  assertEqual(villeAvantCp[0].cp, "55000", "(a) le CP est lu malgre la parenthese qui le suit");
  assertEqual(villeAvantCp[0].ville, "BAR LE DUC", "(a) la commune est extraite");

  // (b) Meme chose avec un "@" parasite et une commune ecrite sans tiret.
  const arobase = parseAddressList([L17("crea tif"), L17("50 CHATEAU RUE FAINS VEEL 55000 @")], opts17);
  assertEqual(arobase.length, 1, "(b) une seule fiche");
  assertEqual(arobase[0].rue, "50 CHATEAU RUE", "(b) rue propre");
  assertEqual(arobase[0].ville, "FAINS VEEL", "(b) commune extraite malgre le @");

  // (c) FRAGMENTS coupes par le bord HAUT de l'ecran pendant le defilement :
  // ni CP ni commune (ces lignes-la sont restees hors du cadre). Ils
  // representaient une grande part des "a verifier" d'une video reelle et
  // n'etaient geocodables dans aucun cas.
  for (const fragment of [
    "ERATION AVE FAINSAUEEL DRDLU",
    "SSAGE RUE D ILLE EN BARROIS",
    "7ECHAL LANNES D 11ERES DEVANT",
  ]) {
    assertEqual(parseAddressList([L17(fragment)], opts17).length, 0, `(c) fragment ecarte : ${fragment.slice(0, 24)}`);
  }

  // (d) ... mais une fiche ENTIERE reste retenue, meme sans nom lisible.
  const entiere = parseAddressList([L17("10 LIBERATION AVE"), L17("FAINS-VEEL 55000")], opts17);
  assertEqual(entiere.length, 1, "(d) fiche entiere conservee");
  assertEqual(entiere[0].cp, "55000", "(d) CP present");

  // (e) Sans base de reference, aucun filtrage supplementaire : le repli
  // d'avant l'import BAN reste identique.
  assertEqual(parseAddressList([L17("ERATION AVE FAINSAUEEL DRDLU")]).length, 1, "(e) sans reference, rien n'est filtre");
}

console.log("\n=== Cas 18 : video reelle de 66 arrets (terrain 2026-09-02) -- positions reelles, CP suivi d'un creneau mal lu ===");
{
  // Lignes REELLES du compte rendu OCR (texte + position verticale), pour les
  // images qui portaient les six fiches perdues au build 121. Toutes avaient
  // la meme cause : le CP n'etait lu que s'il terminait la ligne, or ce
  // terminal ecrit "<COMMUNE> <CP> <creneau>" et l'OCR massacre le creneau.
  const R = (y0, y1, text) => ({ text, bbox: { x0: 0, y0, x1: 300, y1 } });
  const knownCities18 = new Set(
    ["Euville", "Sorcy-Saint-Martin", "Commercy", "Sauvigny", "Sepvigny", "Chalaines",
      "Rigny-la-Salle", "Laneuville-au-Rupt", "Domgermain", "Vignot"].map((c) => looseCommune(normalizeCity(c)))
  );
  const opts18 = { knownCities: knownCities18, knownCps: new Set(["55190", "55200", "55140", "54119", "54113"]) };
  const rues = (r) => r.map((b) => b.rue);

  // (a) image 7 : "EUVILLE 55200 40 - 11:40 ©)" -- creneau tronque derriere le CP
  const img7 = parseAddressList([
    R(365, 398, "A° 28.78km"), R(417, 452, "FAGUET VIRGINIE 8000 | 0+1"), R(449, 465, "5 GARE RUE"),
    R(463, 493, "SORCY ST MARTIN 55190 09:20- 11:20 (©"), R(636, 653, "17 SOUS LES VIGNES RUE"),
    R(663, 679, "EUVILLE 55200"), R(753, 774, "a"), R(798, 814, "EST RAMONAGE"),
    R(825, 841, "30 SOUS LES VIGNES RUE"), R(846, 878, "EUVILLE 55200 09:30 - 11:30 @ ="),
    R(934, 971, "# a 27.43km Q"), R(974, 1014, "Sidoli thibaut Toner"),
    R(993, 1032, "2 MOULIN CHMN 8000 | 0+1 3"), R(1040, 1070, "EUVILLE 55200 40 - 11:40 ©)"),
  ], opts18);
  assertEqual(img7.length, 4, "(a) quatre fiches");
  const sidoli = img7.find((b) => (b.nom || "").startsWith("Sidoli"));
  assertEqual(sidoli && sidoli.rue, "2 MOULIN CHMN", "(a) Sidoli retrouve, rue propre (plus de residu '3')");
  assertEqual(sidoli && sidoli.cp, "55200", "(a) Sidoli : CP lu malgre le creneau tronque");
  assertEqual(sidoli && sidoli.ville, "EUVILLE", "(a) Sidoli : commune");
  const faguet = img7.find((b) => (b.nom || "").startsWith("FAGUET"));
  assertEqual(faguet && faguet.rue, "5 GARE RUE", "(a) 'SORCY ST MARTIN' detache de la rue (ST = SAINT)");
  assertEqual(faguet && faguet.ville, "SORCY ST MARTIN", "(a) commune abregee reconnue");

  // (b) image 9 : "EUVILLE 55200 09:40 - 11:40 (D" -- une lettre parasite apres le creneau
  const img9 = parseAddressList([
    R(392, 428, "Noelyne CANDAS 8000 | 0+1 v"), R(425, 449, "27 JEANNE D'ARC RUE ‘"),
    R(446, 471, "EUVILLE 55200 09:40 - 11:40 (D"), R(529, 573, "AR 30.1km Q"),
    R(588, 624, "LYSE HENRY 8000 | 0+1 D"), R(619, 635, "SORCY RTE"), R(635, 666, "EUVILLE 55200 09:50 - 11:50 © ,"),
  ], opts18);
  const candas = img9.find((b) => (b.nom || "").startsWith("Noelyne"));
  assertEqual(candas && candas.nom, "Noelyne CANDAS", "(b) Noelyne CANDAS retrouvee, sans residu 'v'");
  assertEqual(candas && candas.rue, "27 JEANNE D'ARC RUE", "(b) rue sans l'apostrophe parasite");
  assertEqual(candas && candas.cp, "55200", "(b) CP lu malgre '(D'");

  // (c) image 18 : marqueur de distance reduit a "a" -> la coupure par CP
  // doit separer trois clients consecutifs.
  const img18 = parseAddressList([
    R(426, 465, "Thieriot Kevin 8000 | 0+1 v"), R(455, 472, "9 HAPTOUTE RUE"), R(476, 509, "COMMERCY 55200 10:40-12:40 © ,"),
    R(622, 668, "Mme regnier massera 8000 | 0+1 VU"), R(625, 678, "LS) valerie"),
    R(675, 709, "17 HAPTOUTE RUE 10:40 - 12:40 © «"), R(706, 725, "COMMERCY 55200"), R(772, 794, "a"),
    R(805, 845, "LHERITIER MAINTENANCE ©"), R(846, 865, "14 ARTILLEURS AVE"), R(874, 909, "COMMERCY 55200 10:40 - 12:40 © q"),
  ], opts18);
  assertEqual(rues(img18), ["9 HAPTOUTE RUE", "17 HAPTOUTE RUE", "14 ARTILLEURS AVE"], "(c) trois clients separes malgre le marqueur perdu");
  assertEqual(img18[2].ville, "COMMERCY", "(c) 'q' n'est plus pris pour la commune");

  // (d) image 35/40 : "SEPVIGNY 55140 1220-1420", "DOMGERMAIN 54119 @ A", "15:10-1710"
  const img35 = parseAddressList([
    R(577, 629, "… GUARRACINO GILLES 8000 | TS"), R(614, 634, "8 PETITE BOUCHERIE RUE"), R(640, 672, "SEPVIGNY 55140 1220-1420 ® ,"),
  ], opts18);
  assertEqual(img35.length === 1 && img35[0].cp, "55140", "(d) GUARRACINO : CP lu malgre '1220-1420'");
  assertEqual(img35[0] && img35[0].ville, "SEPVIGNY", "(d) GUARRACINO : commune");
  const img40 = parseAddressList([
    R(619, 665, "Gazon Philippe 8000 | 0+1 VU"), R(646, 665, "39 TUILERIE RUE"), R(673, 706, "DOMGERMAIN 54119 15:00 - 17:00 @ A"),
    R(763, 801, "a 11.64km Q"), R(809, 832, "maison individuelle ; 7"), R(828, 847, "8000 | 0+1"),
    R(823, 860, "7 ROSIERE RUE ! ©"), R(857, 905, "DOMGERMAIN 54119 15:10-1710 © ,"),
  ], opts18);
  assertEqual(rues(img40), ["39 TUILERIE RUE", "7 ROSIERE RUE"], "(d) Gazon Philippe et 'maison individuelle' retrouves");
  assertEqual(img40.map((b) => b.cp), ["54119", "54119"], "(d) les deux CP lus");

  // (e) rangee d'icone sans distance ("Û 27.11km 9" -> "9") : plus jamais
  // le debut d'une rue ("9 Alan morisot v 5 PRESSOIRS RUE" observe).
  const img30 = parseAddressList([
    R(396, 458, "Û 27.11km 9"), R(475, 511, "Alan morisot 8000 | 0+1 v"), R(502, 519, "5 PRESSOIRS RUE"),
    R(523, 554, "BUREY EN VAUX 55140 12:10-1410 (© ,"),
  ], { knownCities: new Set([looseCommune(normalizeCity("Burey-en-Vaux"))]), knownCps: new Set(["55140"]) });
  assertEqual(img30.length === 1 && img30[0].rue, "5 PRESSOIRS RUE", "(e) residu du marqueur ecarte de la rue");
  assertEqual(img30[0] && img30[0].nom, "Alan morisot", "(e) nom propre");
}

console.log("\n=== Cas 19 : scan par PHOTOS d'une vraie tournee (44 arrets, terrain 2026-09-02) ===");
{
  // Lignes REELLES du compte rendu OCR du premier scan par photos. L'OCR est
  // bien plus propre qu'en video ; les erreurs restantes sont d'autres
  // familles : un chiffre du CP mal lu (mais formant un AUTRE CP valide),
  // des residus d'icones, des noms sur deux lignes.
  const R = (y0, y1, text) => ({ text, bbox: { x0: 0, y0, x1: 300, y1 } });
  const villes19 = [
    ["Commercy", "55200"], ["Vaucouleurs", "55140"], ["Sauvigny", "55140"], ["Rigny-la-Salle", "55140"],
    ["Broussey-en-Blois", "55190"], ["Domgermain", "54119"], ["Mont-le-Vignoble", "54113"], ["Uruffe", "54112"],
    ["Gye", "54113"], ["Blenod-les-Toul", "54113"], ["Stenay", "55700"],
  ];
  const knownCities19 = new Set(villes19.map(([c]) => looseCommune(normalizeCity(c))));
  const knownCps19 = new Set(villes19.map(([, cp]) => cp));
  const cityCps19 = new Map();
  for (const [c, cp] of villes19) {
    const k = looseCommune(normalizeCity(c));
    if (!cityCps19.has(k)) cityCps19.set(k, new Set());
    cityCps19.get(k).add(cp);
  }
  const opts19 = { knownCities: knownCities19, knownCps: knownCps19, cityCps: cityCps19 };

  // (a) "COMMERCY 55700" : 55700 (Stenay) est un vrai CP de la zone, seule
  // la commune permet de le corriger.
  const img2 = parseAddressList([
    R(663, 694, "CDM COMMERCY UTML"), R(718, 749, "22 CHARLES DE GAULLE"), R(772, 803, "PL"), R(827, 855, "COMMERCY 55700"),
    R(930, 1008, "# #e 1.17km Q"), R(1026, 1116, "BIJOUTERIE CENTRALE 8000 | 0+1 D"), R(1097, 1131, "5 CHARLES DE GAULLE PL"),
    R(1135, 1197, "COMMERCY 55200 10:30 - 12:30 (©"),
  ], opts19);
  assertEqual(img2.map((b) => b.cp), ["55200", "55200"], "(a) le CP mal lu est corrige par la commune");
  assertEqual(img2[1].nom, "BIJOUTERIE CENTRALE", "(a) majuscule isolee retiree du nom");
  assertEqual(img2[0].rue, "22 CHARLES DE GAULLE PL", "(a) rue repliee sur deux lignes");

  // (b) nom sur deux lignes, "@p" en fin de nom, "COMMERCY COMMERCY" comme
  // ligne de commune d'une fiche de ramasse
  const img3 = parseAddressList([
    R(951, 1024, "Mme regnier massera 8000 | 0+1 ç"), R(1022, 1053, "valerie"), R(1042, 1102, "17 HAPTOUTE RUE 10:40 - 12:40 © e"),
    R(1117, 1151, "COMMERCY 55200 ="), R(1200, 1275, "A9 1.28km Q"), R(1304, 1369, "LHERITIER MAINTENANCE | 8000 |0+2@p"),
    R(1360, 1396, "14 ARTILLEURS AVE"), R(1387, 1445, "COMMERCY 55200 10:40 - 12:40 ©"), R(1545, 1618, "A° 1.5km Q"),
    R(1650, 1714, "CHAUSSEA COMMERCY oSRO3E"), R(1683, 1779, "nG CHEMIN DES VERPILLERES"), R(1732, 1789, "COMMERCY COMMERCY 09:00 -16:00 (©"),
    R(1808, 1837, "55200"),
  ], opts19);
  assertEqual(img3.map((b) => b.nom), ["Mme regnier massera valerie", "LHERITIER MAINTENANCE", "CHAUSSEA COMMERCY"], "(b) noms : deux lignes jointes, residus retires");
  assertEqual(img3[2].rue, "CHEMIN DES VERPILLERES", "(b) 'nG' retire, commune non collee a la rue");
  assertEqual(img3[2].ville, "COMMERCY", "(b) 'COMMERCY COMMERCY' reconnu comme la commune");

  // (c) "55140 |" n'est pas un badge ; CP complete par la commune ; residus
  const img8 = parseAddressList([
    R(1303, 1367, "THIERRY LANTOINE 8000 | 041 ÉD"), R(1358, 1390, "GRANDE RUE"), R(1385, 1441, "RIGNY-LA-SALLE 55140 | 12:40-14:40 (©"),
  ], opts19);
  assertEqual(img8[0] && img8[0].cp, "55140", "(c) '55140 |' garde son CP");
  const img4 = parseAddressList([R(1031, 1063, "3 BASSE RUE ["), R(1066, 1124, "BROUSSEY EN BLOIS 11:10-13:10 © ,")], opts19);
  assertEqual(img4[0] && img4[0].cp, "55190", "(c) CP absent complete par la commune");
  const img7 = parseAddressList([R(1744, 1779, "Brunel Andre"), R(1731, 1829, "19 BOIS RUE 3000 ( 9#) &"), R(1815, 1879, "SAUVIGNY 55140 12:10 - 14:10 © ë")], opts19);
  assertEqual(img7[0] && img7[0].rue, "19 BOIS RUE", "(c) '3000 ( 9#) &' retire de la rue");
  const img9 = parseAddressList([R(1374, 1462, "maison individuelle 3000 | 0+1 V©"), R(1421, 1480, "4 7 ROSIERE RUE"), R(1476, 1532, "DOMGERMAIN 54119 15:10-17:10 ®")], opts19);
  assertEqual(img9[0] && img9[0].rue, "7 ROSIERE RUE", "(c) icone lue '4' devant le numero retiree");
  assertEqual(img9[0] && img9[0].nom, "maison individuelle", "(c) nom propre");
  assertEqual(parseAddressList([R(0, 20, "EURLGREGAUTO"), R(24, 44, "4 9EME RI AVE"), R(48, 68, "COMMERCY 55200")], opts19)[0].rue, "4 9EME RI AVE", "(c) '4 9EME RI AVE' garde son numero");

  // (d) raison sociale longue sur deux lignes, jeton parasite en tete, badge
  // residuel devant un numero
  const img10 = parseAddressList([
    R(646, 714, "SYND MIXTE DESEAUXDU | 8000} 041 @D"), R(695, 723, "TOULOIS"), R(733, 790, "31 LEOPOLD CABRET RUE 15:20-17:20(® ,"),
    R(793, 823, "MONT-LE-VIGNOBLE 54113 :"), R(890, 956, "A° 25.72km Q"), R(972, 1058, "eus FARGE FREDERIC 8000 | 0+1"),
    R(1040, 1070, "8 MORLOTS RUE"), R(1076, 1132, "URUFFE 54112 15:20 - 17:20 ©"), R(1580, 1646, "A° 26.87km ç"),
    R(1683, 1747, "8000 | 0+2 3"), R(1726, 1758, "5 SAINT MANSUY RUE"), R(1765, 1822, "GYE 54113 15:30 - 17:30 ® …"),
  ], opts19);
  assertEqual(img10.map((b) => b.nom), ["SYND MIXTE DESEAUXDU TOULOIS", "FARGE FREDERIC", null], "(d) noms");
  assertEqual(img10[2].rue, "5 SAINT MANSUY RUE", "(d) residu de badge '3' retire devant le numero");

  // (e) code de ramasse dans le nom, creneau "18:0C", commune en minuscules
  const img11 = parseAddressList([
    R(1126, 1169, "DOMAINE CLAUDE A1912WF"), R(1147, 1240, "nG VOSGIEN"), R(1217, 1249, "37 - 39 Route de Toul 09:00 - 18:0C"),
    R(1265, 1296, "Blenod-les-Toul"), R(1311, 1342, "Blenod-les-Toul 54113"),
  ], opts19);
  assertEqual(img11[0] && img11[0].nom, "DOMAINE CLAUDE VOSGIEN", "(e) code de ramasse retire, nom joint");
  assertEqual(img11[0] && img11[0].rue, "37 - 39 Route de Toul", "(e) creneau '18:0C' retire de la rue");
  assertEqual(img11[0] && img11[0].cp, "54113", "(e) CP");
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
