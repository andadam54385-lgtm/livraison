import { getDb } from "../db/schema.js";
import { put, getAll, clear } from "../lib/idb.js";
import { uuid } from "../lib/id.js";

// Compte rendu d'un scan de LISTE (video importee ou camera live) -- retour
// terrain : "l'OCR devrait faire un compte rendu quand c'est une video, la
// j'ai rien". Le journal des corrections (ocr-corrections-store.js) ne
// couvre que le scan d'UNE etiquette : quand une video sort un resultat
// mediocre, il n'existait aucune trace exploitable a exporter pour
// comprendre pourquoi -- ni pour l'utilisateur, ni pour le developpeur.
//
// On enregistre le TEXTE OCR BRUT image par image, plus ce que le parser en
// a tire. C'est exactement ce qu'il faut pour rejouer un cas reel dans
// parse-address-list.test.mjs sans avoir a le retranscrire depuis une
// capture d'ecran (ce qui a ete fait a la main pour les cas 14, 15 et 16).

// Un seul compte rendu conserve : c'est un outil de diagnostic du DERNIER
// scan, pas un historique. Un scan de 45 images represente deja plusieurs
// centaines de lignes de texte.
const MAX_REPORTS = 3;

export async function saveScanReport({ source, frames, drafts, dureeMs, photosTotal = null, illisibles = [] }) {
  const db = await getDb();
  const report = {
    id: uuid(),
    date: new Date().toISOString(),
    source, // "photos" | "video" | "live"
    dureeMs,
    framesAnalysees: frames.length,
    // Photos : nombre selectionne et celles que l'appli n'a pas su lire (nom,
    // type, taille, erreur) -- un scan incomplet doit se voir dans le compte
    // rendu, pas seulement dans la console.
    photosTotal,
    illisibles,
    adressesRetenues: drafts.length,
    // Texte brut par image, avec la position verticale de chaque ligne : la
    // matiere premiere du diagnostic. Les anciens comptes rendus stockaient
    // des chaines nues -- listScanReports normalise les deux formes.
    frames: frames.map((f) => ({ index: f.index, lignes: f.lignes })),
    // Ce que le parser a retenu au final (rue/cp/ville/nom), pour comparer
    // d'un coup d'oeil avec le texte brut ci-dessus.
    resultats: drafts.map((d) => ({ nom: d.nom, rue: d.rue, cp: d.cp, ville: d.ville })),
  };
  await put(db, "scanReports", report);

  const tous = await listScanReports();
  for (const vieux of tous.slice(MAX_REPORTS)) {
    await deleteScanReport(vieux.id);
  }
  return report;
}

export async function listScanReports() {
  const db = await getDb();
  const tous = await getAll(db, "scanReports");
  // Normalise les lignes en {texte, y0, y1} : les comptes rendus enregistres
  // avant l'ajout des positions ne contiennent que des chaines.
  for (const r of tous) {
    for (const f of r.frames || []) {
      f.lignes = (f.lignes || []).map((l) => (typeof l === "string" ? { texte: l, y0: null, y1: null } : l));
    }
  }
  return tous.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

export async function deleteScanReport(id) {
  const db = await getDb();
  const { del } = await import("../lib/idb.js");
  return del(db, "scanReports", id);
}

export async function clearScanReports() {
  const db = await getDb();
  return clear(db, "scanReports");
}
