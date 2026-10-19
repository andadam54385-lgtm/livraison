import { getDb } from "../db/schema.js";
import { put, getAll } from "../lib/idb.js";
import { uuid } from "../lib/id.js";
import { parseUpsLabelDetailed } from "./parse-ups-label.js";

// Journal des corrections manuelles apres un scan OCR : ne sert PAS a
// corriger le colis lui-meme (deja fait par ailleurs) mais a accumuler des
// cas reels ou le parser (parse-ups-label.js) s'est trompe, exploitables
// plus tard pour ameliorer le code -- retour utilisateur explicite ("il y a
// beaucoup d'erreur", le but est d'aider les scans suivants, pas juste
// celui-ci). Compare toujours au texte OCR brut re-analyse a l'instant (pas
// aux valeurs actuelles du colis, potentiellement deja corrigees une
// premiere fois) : c'est la seule base stable pour juger si le parser se
// trompe sur CE texte.
const FIELDS = ["nom", "tel", "rue", "cp", "ville"];

export async function recordCorrectionIfNeeded(colis, corrected) {
  if (!colis.ocrRawText) return; // saisie manuelle : pas de baseline OCR a comparer
  const { result } = parseUpsLabelDetailed(colis.ocrRawText);

  const champsModifies = FIELDS.filter((f) => (result[f] || "") !== (corrected[f] || ""));
  if (champsModifies.length === 0) return; // rien a apprendre, le parser avait deja raison

  const db = await getDb();
  await put(db, "ocrCorrections", {
    id: uuid(),
    dateCorrection: new Date().toISOString(),
    colisId: colis.id,
    ocrRawText: colis.ocrRawText,
    ocrConfidence: colis.ocrConfidence ?? null,
    parsed: { nom: result.nom, tel: result.tel, rue: result.rue, cp: result.cp, ville: result.ville },
    corrected: { nom: corrected.nom, tel: corrected.tel, rue: corrected.rue, cp: corrected.cp, ville: corrected.ville },
    champsModifies,
  });
}

export async function listOcrCorrections() {
  const db = await getDb();
  const all = await getAll(db, "ocrCorrections");
  return all.sort((a, b) => (a.dateCorrection < b.dateCorrection ? 1 : -1)); // plus recent d'abord
}
