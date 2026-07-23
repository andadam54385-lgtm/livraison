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
  // 3 modeles prets a l'emploi mais librement modifiables (titre ET texte,
  // retour terrain : une seule situation-type ne suffit pas). Variables
  // reconnues dans `body` : {nom}, {minutes_estimees}, {adresse} -- voir
  // js/tour/sms-template.js.
  smsTemplates: [
    { label: "Arrivée imminente", body: "Bonjour {nom}, votre colis UPS arrive dans environ {minutes_estimees} min à : {adresse}." },
    { label: "Colis déposé", body: "Bonjour {nom}, votre colis UPS a été déposé à : {adresse}. Bonne réception !" },
    {
      label: "Absent au passage",
      body: "Bonjour {nom}, je suis passé livrer votre colis UPS à {adresse} mais vous étiez absent. Merci de me rappeler pour un nouveau passage.",
    },
  ],
  // Purge des tournees archivees plus vieilles que ca (chantier F) -- garde
  // volontairement un historique pour un futur bilan sectoriel (V3 B2B).
  tourHistoryPurgeMonths: 6,
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
