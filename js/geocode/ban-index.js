import { getDb } from "../db/schema.js";
import { getAllFromIndex } from "../lib/idb.js";

export async function queryByCp(cp) {
  if (!cp) return [];
  const db = await getDb();
  return getAllFromIndex(db, "banEntries", "by_cp", cp);
}

export async function queryByCommune(cn) {
  if (!cn) return [];
  const db = await getDb();
  return getAllFromIndex(db, "banEntries", "by_cn", cn);
}
