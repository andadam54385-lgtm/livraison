import { openDatabase } from "../lib/idb.js";

export const DB_NAME = "delivery-tour";
export const DB_VERSION = 2;

let dbPromise = null;

function upgrade(db) {
  if (!db.objectStoreNames.contains("graphMeta")) {
    db.createObjectStore("graphMeta", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("graphCSR")) {
    db.createObjectStore("graphCSR", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("banMeta")) {
    db.createObjectStore("banMeta", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("banEntries")) {
    const store = db.createObjectStore("banEntries", { keyPath: "id", autoIncrement: true });
    store.createIndex("by_cp", "cp", { unique: false });
    store.createIndex("by_cn", "cn", { unique: false });
  }
  if (!db.objectStoreNames.contains("colis")) {
    const store = db.createObjectStore("colis", { keyPath: "id" });
    store.createIndex("by_statut", "statut", { unique: false });
    store.createIndex("by_dateScan", "dateScan", { unique: false });
  }
  if (!db.objectStoreNames.contains("tours")) {
    const store = db.createObjectStore("tours", { keyPath: "id" });
    store.createIndex("by_statut", "statut", { unique: false });
  }
  if (!db.objectStoreNames.contains("settings")) {
    db.createObjectStore("settings", { keyPath: "key" });
  }
  // Adresses favorites + notes (ex: "code portail 1234", "livrer a l'arriere").
  // Store distinct de colis/tours : le bouton "Effacer tous les colis et
  // tournees" des Reglages ne touche jamais ce store, les favoris et leurs
  // notes survivent donc a un reset.
  if (!db.objectStoreNames.contains("favoris")) {
    const store = db.createObjectStore("favoris", { keyPath: "id" });
    store.createIndex("by_cp", "cp", { unique: false });
  }
}

export function openDb() {
  if (!dbPromise) {
    dbPromise = openDatabase(DB_NAME, DB_VERSION, (db) => upgrade(db));
  }
  return dbPromise;
}

export async function getDb() {
  return openDb();
}
