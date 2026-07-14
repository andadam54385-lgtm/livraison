import { getDb } from "../db/schema.js";
import { get, put } from "../lib/idb.js";

// Depot par defaut repris de data-prep/config/zone.json (Saint-Mihiel).
export const DEFAULTS = {
  depotLat: 48.883,
  depotLon: 5.533,
  depotLabel: "Saint-Mihiel (dépôt)",
  navApp: "apple", // "apple" | "waze"
  ocrLangs: "fra",
  avant12hPenaltyMinutes: 20,
  storagePersisted: false,
};

export async function getSetting(key) {
  const db = await getDb();
  const record = await get(db, "settings", key);
  return record ? record.value : DEFAULTS[key];
}

export async function getAllSettings() {
  const db = await getDb();
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const record = await get(db, "settings", key);
    if (record) out[key] = record.value;
  }
  return out;
}

export async function setSetting(key, value) {
  const db = await getDb();
  await put(db, "settings", { key, value });
}
