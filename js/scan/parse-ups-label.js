// Parsing par template UPS fixe. Fonction pure (pas de DOM) pour rester
// facilement testable : entree = texte brut OCR, sortie = champs structures.
//
// Principe : le bloc expediteur est toujours situe avant/au-dessus de
// "SHIP TO:" -> tout ce qui precede cette ancre est ignore. Le bloc utile
// (telephone, nom, rue, CP+ville) suit dans cet ordre juste apres l'ancre.

const SHIP_TO_RE = /SHIP\s*TO\s*:?/i;
const PHONE_RE = /(?:\+33[\s.-]?|0)[1-9](?:[\s.-]?\d{2}){4}/;
const CP_VILLE_RE = /\b(\d{5})\b\s+([A-ZÀ-Ü'\- ]+)/;
const TRACKING_RE = /1Z\s?[0-9A-Z]{6}\s?[0-9A-Z]{2}\s?\d{4}\s?\d{4}/;
const REF_TEL_RE = /Ref\.?\s*1\s*:?\s*TEL\s*(0\d{9})/i;

function normalizePhone(raw) {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("33") && digits.length === 11) digits = `0${digits.slice(2)}`;
  return digits;
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

  // Telephone : premiere ligne du bloc qui ressemble a un numero francais.
  let phoneFromBlock = null;
  let phoneLineIdx = -1;
  for (let i = 0; i < block.length; i++) {
    const m = block[i].match(PHONE_RE);
    if (m) {
      phoneFromBlock = m[0];
      phoneLineIdx = i;
      break;
    }
  }

  // Validation croisee : le meme telephone reapparait en bas d'etiquette
  // au format "Ref.1: TEL 0XXXXXXXXX".
  const refTelMatch = text.match(REF_TEL_RE);
  const phoneFromRef = refTelMatch ? refTelMatch[1] : null;

  const phoneRaw = phoneFromBlock || phoneFromRef;
  let telConfidence = "a_verifier";
  if (phoneFromBlock && phoneFromRef) {
    telConfidence = normalizePhone(phoneFromBlock) === normalizePhone(phoneFromRef) ? "haute" : "a_verifier";
  }

  // CP + ville : cherche dans tout le bloc (pas seulement la derniere ligne,
  // l'OCR peut fusionner des lignes).
  let cp = null;
  let ville = null;
  let cpLineIdx = -1;
  for (let i = 0; i < block.length; i++) {
    const m = block[i].match(CP_VILLE_RE);
    if (m) {
      cp = m[1];
      ville = m[2].trim();
      cpLineIdx = i;
      break;
    }
  }

  // Nom : 1-2 lignes non vides apres le telephone (ou en debut de bloc s'il
  // n'a pas ete trouve), avant d'atteindre la ligne CP/ville. On s'arrete des
  // qu'une ligne commence par un chiffre : en adresse francaise, c'est
  // quasi-toujours le numero de rue, donc le debut de la ligne "rue" et pas
  // une suite du nom.
  const nameLines = [];
  let cursor = phoneLineIdx === -1 ? 0 : phoneLineIdx + 1;
  while (nameLines.length < 2 && cursor < block.length && (cpLineIdx === -1 || cursor < cpLineIdx)) {
    const line = block[cursor];
    if (TRACKING_RE.test(line) || line.length <= 1) {
      cursor++;
      continue;
    }
    if (/^\d/.test(line)) break;
    nameLines.push(line);
    cursor++;
  }
  const nom = nameLines.join(" ").trim() || null;

  // Rue : ce qu'il reste entre le nom et la ligne CP/ville.
  let rue = null;
  while (cursor < block.length && (cpLineIdx === -1 || cursor < cpLineIdx)) {
    const line = block[cursor];
    if (!TRACKING_RE.test(line) && line.length > 1) {
      rue = rue ? `${rue} ${line}` : line;
    }
    cursor++;
  }

  return {
    tracking,
    nom,
    tel: phoneRaw ? normalizePhone(phoneRaw) : null,
    telConfidence: phoneRaw ? telConfidence : "a_verifier",
    rue,
    cp,
    ville,
  };
}
