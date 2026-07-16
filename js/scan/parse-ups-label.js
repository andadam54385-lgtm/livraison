// Parsing par template UPS fixe. Fonction pure (pas de DOM) pour rester
// facilement testable : entree = texte brut OCR, sortie = champs structures.
//
// Principe : le bloc expediteur est toujours situe avant/au-dessus de
// "SHIP TO:" -> tout ce qui precede cette ancre est ignore. Le bloc utile
// (telephone, nom, rue, CP+ville) suit apres l'ancre, jusqu'a la ligne
// CP+ville (fin d'adresse -- Ref.1/mentions UPS apres ne sont pas pertinents
// pour nom/rue/tel).
//
// L'ORDRE des lignes (nom/tel/rue) n'est PAS fixe sur de vraies etiquettes
// (verifie sur 5 etiquettes reelles secteur 54/55) : on classifie donc
// chaque ligne independamment de sa position, plutot que de supposer une
// sequence. Voir classifyShipToBlock().

const SHIP_TO_RE = /SHIP\s*TO\s*:?/i;
const TRACKING_RE = /1Z\s?[0-9A-Z]{6}\s?[0-9A-Z]{2}\s?\d{4}\s?\d{4}/;
const REF_TEL_RE = /Ref\.?\s*1\s*:?\s*TEL\s*(0\d{9})/i;
const CP_VILLE_RE = /^(\d{5})\s+([A-ZÀ-Ü'\- ]+)$/;

const STREET_KEYWORDS = [
  "RUE", "AVENUE", "AV", "BD", "BOULEVARD", "ROUTE", "CHEMIN", "IMPASSE",
  "ALLEE", "ALLÉE", "ZONE", "ZI", "ZAC", "LIEU-DIT", "LIEU DIT", "HAMEAU",
  "LOTISSEMENT", "RESIDENCE", "RÉSIDENCE", "PLACE", "COURS", "QUAI", "VOIE",
  "TER", "BIS", "FAUBOURG",
];

// Regle unique, sans branchement par longueur de prefixe : le prefixe
// parasite (006, 336, 00336, 33336, +33, 0033...) est toujours AVANT le
// vrai numero francais a 9 chiffres significatifs -- en prenant
// systematiquement les 9 DERNIERS chiffres, on l'elimine automatiquement
// sans avoir besoin de savoir combien de chiffres de prefixe il y a. Un
// numero deja propre a 10 chiffres n'est pas affecte (resultat inchange).
function normalizeFrenchPhone(rawLine) {
  const digits = rawLine.replace(/\D/g, "");
  if (digits.length < 9) return { phone: null, confidence: "basse" };
  const normalized = `0${digits.slice(-9)}`;
  return { phone: normalized, confidence: digits.length <= 14 ? "haute" : "basse" };
}

// Classifie chaque ligne du bloc SHIP TO (jusqu'a CP+ville inclus) : ligne
// CP+ville, "FRANCE" (ignoree), candidat telephone, ligne de rue (contient
// un chiffre ou un mot-cle de voie), ou candidat nom/societe (le reste).
function classifyShipToBlock(lines) {
  const result = { phones: [], names: [], streets: [], cp: null, ville: null };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const cpMatch = line.match(CP_VILLE_RE);
    if (cpMatch) {
      result.cp = cpMatch[1];
      result.ville = cpMatch[2].trim();
      continue;
    }
    if (/^FRANCE$/i.test(line)) continue;
    if (TRACKING_RE.test(line)) continue; // jamais un nom/rue, meme si present dans le bloc

    const digits = line.replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 14) {
      // Marqueur explicite, OU la ligne est deja un numero francais "propre"
      // (10 chiffres, commence par 0[1-9], aucun prefixe parasite a retirer)
      // : sa forme meme ne laisse pas de place au doute, contrairement a une
      // suite de 9 chiffres sans 0 initial qui pourrait etre autre chose
      // (ex: reference client).
      const isCleanFrenchShape = digits.length === 10 && /^0[1-9]/.test(digits);
      const hasMarker = /TEL|PHONE|GSM/i.test(line) || /^\+|^00/.test(line) || isCleanFrenchShape;
      const norm = normalizeFrenchPhone(line);
      result.phones.push({
        raw: line,
        phone: norm.phone,
        // Marqueur explicite (TEL/PHONE/GSM/+/00) = confiance haute ; une
        // suite de chiffres nue (ex: reference client type "789331367") est
        // ambigue -> confiance moyenne, jamais acceptee sans verification.
        confidence: hasMarker ? "haute" : "moyenne",
      });
      continue;
    }

    const hasStreetWord = STREET_KEYWORDS.some((k) => line.toUpperCase().includes(k));
    if (/\d/.test(line) || hasStreetWord) {
      result.streets.push(line);
    } else {
      result.names.push(line);
    }
  }

  return result;
}

export function parseUpsLabel(rawText) {
  const text = (rawText || "").replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const shipToLineIdx = lines.findIndex((l) => SHIP_TO_RE.test(l));
  let block = shipToLineIdx === -1 ? lines : lines.slice(shipToLineIdx + 1);
  if (shipToLineIdx !== -1) {
    // L'OCR fusionne parfois "SHIP TO:" et le debut du nom sur la meme ligne.
    const sameLineRest = lines[shipToLineIdx].replace(SHIP_TO_RE, "").trim();
    if (sameLineRest) block = [sameLineRest, ...block];
  }

  // Tracking : cherche sur tout le texte (peut apparaitre pres du code-barres,
  // hors du bloc SHIP TO).
  const trackingMatch = text.match(TRACKING_RE);
  const tracking = trackingMatch ? trackingMatch[0].replace(/\s+/g, "") : null;

  // Ne classifie que jusqu'a la ligne CP+ville incluse : au-dela (Ref.1,
  // mentions UPS...) n'est jamais pertinent pour nom/rue/tel.
  const cpLineIdx = block.findIndex((l) => CP_VILLE_RE.test(l.trim()));
  const relevantBlock = cpLineIdx === -1 ? block : block.slice(0, cpLineIdx + 1);

  const classified = classifyShipToBlock(relevantBlock);

  // Nom : le DERNIER candidat nom/societe avant la 1ere ligne de rue (pas le
  // premier) -- verifie sur les cas reels ou une societe (ex: transporteur,
  // enseigne) precede le vrai nom du destinataire, et ou le nom est parfois
  // duplique (abrege puis complet juste avant la rue).
  const nom = classified.names.length > 0 ? classified.names[classified.names.length - 1] : null;

  // Rue : toutes les lignes de rue concatenees (certaines adresses s'etalent
  // sur 2 lignes : zone d'activite + lieu-dit, par ex.).
  const rue = classified.streets.length > 0 ? classified.streets.join(" ") : null;

  // Telephone : priorite au candidat avec marqueur explicite ; a defaut, le
  // premier candidat trouve (confiance moyenne -> affiche "a verifier").
  const phoneEntry = classified.phones.find((p) => p.confidence === "haute") || classified.phones[0] || null;

  // Validation croisee optionnelle avec "Ref.1: TEL 0XXXXXXXXX" en bas
  // d'etiquette, quand present : concordance -> confiance haute.
  const refTelMatch = text.match(REF_TEL_RE);
  let telConfidence = phoneEntry ? phoneEntry.confidence : "a_verifier";
  if (phoneEntry && refTelMatch && phoneEntry.phone === refTelMatch[1]) {
    telConfidence = "haute";
  }
  if (telConfidence === "moyenne" || telConfidence === "basse") telConfidence = "a_verifier";

  return {
    tracking,
    nom,
    tel: phoneEntry ? phoneEntry.phone : null,
    telConfidence,
    rue,
    cp: classified.cp,
    ville: classified.ville,
  };
}
