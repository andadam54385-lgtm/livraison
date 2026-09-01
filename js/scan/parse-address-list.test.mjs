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

console.log("\n=== groupLinesIntoBlocks : seuil relatif a la hauteur de ligne ===");
{
  // Lignes petites (10px), ecart de 20px doit quand meme couper (ratio > 1.6)
  const smallLines = [line("A", 0, 10), line("B", 12, 10), line("C", 40, 10)];
  const blocks = groupLinesIntoBlocks(smallLines);
  assertEqual(blocks.length, 2, "coupure detectee meme avec de petites lignes (seuil relatif, pas absolu)");
}

console.log(failures === 0 ? "\nTOUS LES TESTS SONT PASSES" : `\n${failures} ECHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
