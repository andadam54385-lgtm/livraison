import { getDb } from "../db/schema.js";
import { put, getAll, clear, del } from "../lib/idb.js";
import { uuid } from "../lib/id.js";

// Journal des bugs signales : deux sources possibles --
// - "manuel" : le livreur appuie sur "Signaler un bug" (Reglages) et tape une
//   note libre pendant/juste apres l'incident, pendant que c'est frais.
// - "auto" : capture silencieuse d'une erreur JS non attrapee (voir
//   installGlobalErrorCapture() dans app.js) ou d'un catch existant qui log
//   deja dans la console (tour-ui.js/map-ui.js) -- objectif : ne plus
//   dependre du livreur pour remonter les erreurs techniques qu'il ne pense
//   pas forcement a signaler lui-meme.
// Stocke en local uniquement (comme tout le reste de l'app) -- a exporter
// manuellement (bouton "Copier tout") pour partager avec le developpeur.

export async function reportBug({ type = "manuel", message, context = null, stack = null } = {}) {
  if (!message) return null;
  const db = await getDb();
  const entry = {
    id: uuid(),
    date: new Date().toISOString(),
    type,
    message: String(message).slice(0, 4000),
    context: context || null,
    stack: stack ? String(stack).slice(0, 4000) : null,
    ecran: location.hash || "#tour",
  };
  await put(db, "bugReports", entry);
  return entry;
}

export async function listBugReports() {
  const db = await getDb();
  const all = await getAll(db, "bugReports");
  return all.sort((a, b) => (a.date < b.date ? 1 : -1)); // plus recent d'abord
}

export async function deleteBugReport(id) {
  const db = await getDb();
  await del(db, "bugReports", id);
}

export async function clearBugReports() {
  const db = await getDb();
  await clear(db, "bugReports");
}
