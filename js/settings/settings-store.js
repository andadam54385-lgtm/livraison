import { getDb } from "../db/schema.js";
import { get, put } from "../lib/idb.js";

// Depot reel du livreur (250 rue du Champ Moyen, Fleville-devant-Nancy) --
// corrige apres coup, l'ancienne valeur par defaut (centre-ville de
// Saint-Mihiel, qui n'est que le nom de la zone de livraison) etait fausse.
export const DEFAULTS = {
  depotLat: 48.616944,
  depotLon: 6.20804,
  depotLabel: "250 Rue du Champ Moyen, 54710 Fléville-devant-Nancy",
  depotReturn: false, // revenir au depot en fin de tournee (arrivee), en plus du depart
  navApp: "apple", // "apple" | "waze" | "google"
  ocrLangs: "fra",
  avant12hPenaltyMinutes: 20,
  dureeArretMinutes: 3, // temps moyen passe a chaque arret (sonnette, remise en main propre...), utilise pour l'heure d'arrivee estimee
  autoNavAfterDeliver: false, // ouvre automatiquement le GPS vers l'arret suivant juste apres "Livre" (chantier B, enchainement sans tap)
  storagePersisted: false,
  // Variables : {nom}, {minutes_estimees}, {adresse} -- voir js/tour/sms-template.js.
  smsTemplate: "Bonjour {nom}, votre colis UPS arrive dans environ {minutes_estimees} min à : {adresse}.",
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
