import { getDb } from "../db/schema.js";
import { put, del, getAllFromIndex, tx } from "../lib/idb.js";
import { uuid } from "../lib/id.js";
import { getColis, saveColis } from "../scan/colis-store.js";

// Lit, modifie et reecrit une tournee dans UNE SEULE transaction readwrite
// IndexedDB (stores "tours" + "colis") -- correctif d'audit : les mutations
// d'arret faisaient auparavant get() puis put() dans DEUX transactions
// separees ; deux mutations partant du meme etat (double-tap rapide sur
// "Livre" + "Echec", ou l'app ouverte dans deux onglets) pouvaient se
// chevaucher et la derniere ecriture ecrasait silencieusement l'autre.
// mutateTour DOIT etre synchrone (une transaction IndexedDB s'auto-commit
// des que le thread rend la main sans nouvelle requete en vol) ; pour
// mettre a jour le statut d'un colis dans la meme transaction, elle recoit
// un collecteur setColisStatut(colisId, statut) plutot que d'appeler
// getColis/saveColis (qui ouvriraient leurs propres transactions).
// Retourne la tournee mise a jour, ou null si tourId est introuvable.
function updateTourAtomic(db, tourId, mutateTour) {
  return tx(db, ["tours", "colis"], "readwrite", (t) =>
    new Promise((resolve, reject) => {
      const toursStore = t.objectStore("tours");
      const colisStore = t.objectStore("colis");
      const req = toursStore.get(tourId);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tour = req.result;
        if (!tour) {
          resolve(null);
          return;
        }
        const colisUpdates = [];
        mutateTour(tour, (colisId, statut) => colisUpdates.push({ colisId, statut }));
        const putReq = toursStore.put(tour);
        putReq.onerror = () => reject(putReq.error);
        let pending = colisUpdates.length;
        if (pending === 0) {
          resolve(tour);
          return;
        }
        for (const { colisId, statut } of colisUpdates) {
          const getReq = colisStore.get(colisId);
          getReq.onerror = () => reject(getReq.error);
          getReq.onsuccess = () => {
            const colis = getReq.result;
            if (colis) {
              // Garde colis.statut synchronise avec l'etat de la tournee,
              // sinon la fiche colis reste marquee "en_tournee" indefiniment.
              colis.statut = statut;
              const putColisReq = colisStore.put(colis);
              putColisReq.onerror = () => reject(putColisReq.error);
            }
            pending--;
            if (pending === 0) resolve(tour);
          };
        }
      };
    })
  );
}

export async function createTour({ depot, stops, totalDureeSec, returnToDepot = false, depotArrivee = null }) {
  const db = await getDb();
  const tour = {
    id: uuid(),
    dateCreation: new Date().toISOString(),
    statut: "en_cours",
    depot,
    stops,
    totalDureeSec,
    returnToDepot,
    depotArrivee,
  };
  await put(db, "tours", tour);
  return tour;
}

export async function getActiveTour() {
  const db = await getDb();
  const tours = await getAllFromIndex(db, "tours", "by_statut", "en_cours");
  return tours[0] || null;
}

export async function saveTour(tour) {
  const db = await getDb();
  await put(db, "tours", tour);
  return tour;
}

export async function archiveTour(tourId) {
  const db = await getDb();
  return updateTourAtomic(db, tourId, (tour) => {
    tour.statut = "archivee";
  });
}

export async function markStopDelivered(tourId, ordre) {
  const db = await getDb();
  return updateTourAtomic(db, tourId, (tour, setColisStatut) => {
    const stop = tour.stops.find((s) => s.ordre === ordre);
    if (stop) {
      stop.statutLivraison = "livre";
      stop.heureLivraison = new Date().toISOString();
      setColisStatut(stop.colisId, "livre");
    }
  });
}

// Echec de livraison (absent, acces impossible...) : distinct de "livre",
// avec une raison libre courte -- sert de base au chantier F (report des
// non-livres au lendemain, voir reporterColisEchec ci-dessous).
export async function markStopFailed(tourId, ordre, raison) {
  const db = await getDb();
  return updateTourAtomic(db, tourId, (tour, setColisStatut) => {
    const stop = tour.stops.find((s) => s.ordre === ordre);
    if (stop) {
      stop.statutLivraison = "echec";
      stop.raisonEchec = raison || "";
      stop.heureEchec = new Date().toISOString();
      setColisStatut(stop.colisId, "echec");
    }
  });
}

// Echange la position (ordre) d'un arret avec son voisin immediat --
// reordonnancement manuel simple (boutons ▲▼), plus fiable sur mobile qu'un
// glisser-deposer. direction: -1 (remonte, plus tot) ou +1 (descend, plus tard).
// Les temps de trajet (legDureeSec) restent ceux calcules pour l'ordre
// d'origine : apres un deplacement manuel, l'heure d'arrivee estimee est donc
// approximative tant que la tournee n'est pas recalculee.
export async function moveStop(tourId, ordre, direction) {
  const db = await getDb();
  return updateTourAtomic(db, tourId, (tour) => {
    const stops = tour.stops.slice().sort((a, b) => a.ordre - b.ordre);
    const idx = stops.findIndex((s) => s.ordre === ordre);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= stops.length) return;
    const tmp = stops[idx].ordre;
    stops[idx].ordre = stops[swapIdx].ordre;
    stops[swapIdx].ordre = tmp;
    tour.stops = stops;
  });
}

// Inverse le sens de parcours des arrets restants, sans recalcul de trajet
// (l'utilisateur a fait demi-tour, ou prefere finir par l'autre bout) --
// seuls les arrets pas encore traites sont concernes : ceux deja livres/en
// echec gardent leur position, on ne revient pas dessus. Meme limite que
// moveStop : les legDureeSec restent ceux d'origine, donc les heures
// estimees redeviennent approximatives tant qu'on n'a pas recalcule.
export async function reverseRemainingStops(tourId) {
  const db = await getDb();
  return updateTourAtomic(db, tourId, (tour) => {
    const stops = tour.stops.slice().sort((a, b) => a.ordre - b.ordre);
    // Bug reel corrige ici : un arret non traite a TOUJOURS statutLivraison =
    // "a_livrer" (jamais null/undefined, voir computeOptimizedStops et
    // insertStopCheapest) -- "!s.statutLivraison" etait donc toujours faux,
    // "pending" toujours vide, et le bouton "Inverser le sens" ne faisait
    // strictement rien, silencieusement. Meme condition que isPending()
    // (tour-ui.js) : un arret est "restant" s'il n'est ni livre ni en echec.
    const pending = stops.filter((s) => s.statutLivraison !== "livre" && s.statutLivraison !== "echec");
    if (pending.length < 2) return;
    const ordres = pending.map((s) => s.ordre);
    const reversed = pending.slice().reverse();
    reversed.forEach((stop, i) => {
      stop.ordre = ordres[i];
    });
    tour.stops = stops;
  });
}

async function listAllTours(db) {
  const [enCours, archivees] = await Promise.all([
    getAllFromIndex(db, "tours", "by_statut", "en_cours"),
    getAllFromIndex(db, "tours", "by_statut", "archivee"),
  ]);
  return [...enCours, ...archivees];
}

// Variante exportee (ouvre elle-meme la connexion) : utilisee par l'export
// CSV des Reglages (voir js/export/export-tours.js), seul appelant externe
// a ce jour a avoir besoin de TOUTES les tournees (en cours + archivees).
export async function getAllTours() {
  const db = await getDb();
  return listAllTours(db);
}

// Petit bilan du jour (colis livres, tournees calculees, duree estimee
// cumulee) -- calcule a la volee a partir des tournees en cours + archivees,
// pas d'agregat persiste separement.
export async function getTodayStats() {
  const db = await getDb();
  const todayStr = new Date().toISOString().slice(0, 10);
  const tours = await listAllTours(db);
  let livres = 0;
  let echecs = 0;
  let dureeEstimeeSec = 0;
  let toursCount = 0;
  for (const tour of tours) {
    if ((tour.dateCreation || "").slice(0, 10) === todayStr) {
      dureeEstimeeSec += tour.totalDureeSec || 0;
      toursCount++;
    }
    for (const stop of tour.stops) {
      if (stop.statutLivraison === "livre" && (stop.heureLivraison || "").slice(0, 10) === todayStr) {
        livres++;
      }
      if (stop.statutLivraison === "echec" && (stop.heureEchec || "").slice(0, 10) === todayStr) {
        echecs++;
      }
    }
  }
  return { livres, echecs, dureeEstimeeSec, toursCount };
}

// Marque un colis livre directement depuis la liste (hors ecran Tournee).
// Si le colis appartient a la tournee active, synchronise aussi l'arret
// correspondant pour eviter toute incoherence entre les deux ecrans.
export async function markColisDeliveredDirect(colisId) {
  const db = await getDb();
  const colis = await getColis(colisId);
  if (!colis) return null;
  colis.statut = "livre";
  await saveColis(colis);

  // La tournee active est relue et modifiee via updateTourAtomic (meme
  // garantie que markStopDelivered : pas de get/put en deux transactions
  // separees qui pourraient ecraser une mutation concurrente).
  const activeTour = await getActiveTour();
  if (activeTour) {
    await updateTourAtomic(db, activeTour.id, (tour) => {
      const stop = tour.stops.find((s) => s.colisId === colisId);
      if (stop && stop.statutLivraison !== "livre") {
        stop.statutLivraison = "livre";
        stop.heureLivraison = new Date().toISOString();
      }
    });
  }
  return colis;
}

// Chantier F : reintegre un colis en echec dans la preparation de la
// prochaine tournee. Remet juste colis.statut a "pret" -- adresse et
// geocodage restent intacts (aucune ressaisie), le prochain "Optimiser la
// tournee" l'inclura normalement. L'arret "echec" de l'ancienne tournee
// (deja archivee ou non) n'est jamais modifie : raisonEchec/heureEchec
// restent l'historique reel de cette tentative, seul le colis "vit" a nouveau.
export async function reporterColisEchec(colisId) {
  const colis = await getColis(colisId);
  if (!colis) return null;
  colis.statut = "pret";
  await saveColis(colis);
  return colis;
}

// Purge les tournees archivees plus vieilles que `moisRetention` mois.
// L'historique recent est garde deliberement (bilan sectoriel V3 B2B a
// venir, voir roadmap) -- ce n'est qu'un menage sur la retention, pas une
// suppression immediate apres livraison. Appelee une fois au demarrage
// (voir app.js).
export async function purgeOldTours(moisRetention) {
  const db = await getDb();
  const archivees = await getAllFromIndex(db, "tours", "by_statut", "archivee");
  const seuil = new Date();
  seuil.setMonth(seuil.getMonth() - moisRetention);
  for (const tour of archivees) {
    if (new Date(tour.dateCreation) < seuil) {
      await del(db, "tours", tour.id);
    }
  }
}
