import { getDb } from "../db/schema.js";
import { loadCsrFromDb } from "./graph-loader.js";
import { buildSpatialGrid, findNearestNode } from "./spatial-index.js";
import { buildTravelTimeMatrix } from "./matrix-builder.js";
import { optimizeTourOrder } from "./tsp.js";
import { listColisByStatut, saveColis, getColis } from "../scan/colis-store.js";
import { createTour, saveTour } from "./tour-store.js";
import { getAllSettings, setSetting } from "../settings/settings-store.js";
import { formatDurationShort } from "../lib/geo-utils.js";
import { emit } from "../lib/event-bus.js";

// Colis "eligibles" pour un (re)calcul de tournee : les tout juste geocodes
// ("pret") ET ceux d'une tournee precedente pas encore livres ("en_tournee").
// Inclure "en_tournee" est ce qui permet de recalculer une tournee en cours
// de route (nouveaux colis scannes, retard...) sans avoir a repasser
// manuellement chaque colis restant au statut "pret" -- seuls les colis deja
// "livre" sont exclus.
export async function listColisEligibles() {
  const [pret, enTournee] = await Promise.all([listColisByStatut("pret"), listColisByStatut("en_tournee")]);
  return [...pret, ...enTournee];
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Géolocalisation indisponible sur cet appareil."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

// Duree de chaque troncon (etape precedente -> etape courante), alignee sur
// `order` -- sert a la fois au total (somme) et a l'heure d'arrivee estimee
// par arret (cumul progressif, voir tour-ui.js).
function legDurationsSeconds(order, matrix, startIdx) {
  const legs = [];
  let current = startIdx;
  for (const idx of order) {
    legs.push(matrix[current][idx]);
    current = idx;
  }
  return legs;
}

// Coeur partage du tri : point de depart -> N arrets (+ retour depot
// optionnel) -> ordre optimise + duree de chaque troncon. Utilise a la fois
// pour la creation initiale (runSort) et pour le recalcul en place d'une
// tournee active (runRecalculate) -- statusEl/progressFill pilotent le texte
// de progression de l'appelant, progressFill est optionnel (Etat B n'a pas
// forcement de barre de progression dediee).
async function computeOptimizedStops({ eligibles, start, depotReturnPoint, settings, statusEl, progressFill }) {
  statusEl.textContent = "Chargement du graphe routier…";
  const db = await getDb();
  const csr = await loadCsrFromDb(db);
  if (!csr) {
    throw new Error("Graphe routier indisponible. Réimporte les données dans les réglages.");
  }

  statusEl.textContent = "Positionnement des arrêts sur le réseau routier…";
  const grid = buildSpatialGrid(csr.nodeLat, csr.nodeLon);

  // Si "revenir au depot" est active, le depot est ajoute une seconde fois
  // en tant que point d'arrivee fixe (voir fixedEndIdx plus bas) -- distinct
  // du point de depart, qui peut etre le depot ou la position GPS.
  const points = [
    start,
    ...eligibles.map((c) => ({ lat: c.geocode.lat, lon: c.geocode.lon })),
    ...(depotReturnPoint ? [depotReturnPoint] : []),
  ];
  const depotEndIdx = depotReturnPoint ? points.length - 1 : null;

  const pointNodeIndices = [];
  const unsnapped = [];
  for (let i = 0; i < points.length; i++) {
    const { nodeIndex, distanceMeters } = findNearestNode(grid, csr.nodeLat, csr.nodeLon, points[i].lat, points[i].lon);
    if (nodeIndex === -1 || distanceMeters > 2000) {
      unsnapped.push(i);
    }
    pointNodeIndices.push(nodeIndex === -1 ? 0 : nodeIndex);
  }
  if (unsnapped.length > 0) {
    statusEl.textContent = `${unsnapped.length} point(s) trop loin du réseau routier connu — ils seront quand même inclus avec une estimation approximative.`;
    await new Promise((r) => setTimeout(r, 1500));
  }

  statusEl.textContent = `Calcul des temps de trajet (0/${points.length})…`;
  const matrix = await buildTravelTimeMatrix(csr, pointNodeIndices, {
    maxSeconds: 3600,
    onProgress: (done, total) => {
      statusEl.textContent = `Calcul des temps de trajet (${done}/${total})…`;
      if (progressFill) progressFill.style.width = `${Math.round((done / total) * 100)}%`;
    },
  });

  statusEl.textContent = "Optimisation de l'ordre de tournée…";
  const avant12hFlags = {};
  eligibles.forEach((c, i) => {
    avant12hFlags[i + 1] = Boolean(c.avant12h);
  });
  const penaltyWeight = (settings.avant12hPenaltyMinutes || 0) * 60;

  // Zones manuelles (voir map-ui.js, selection au lasso sur l'ecran Carte) :
  // chaque colis peut porter un numero de zone (colis.zone) pose a la main
  // par le livreur pour forcer un MACRO-ordre de visite -- toutes les zones 1
  // avant toutes les zones 2, etc. -- tandis que l'algo choisit librement le
  // meilleur ordre A L'INTERIEUR de chaque zone (nearestNeighbor + 2-opt,
  // inchange). Les colis sans zone (undefined/null) forment un groupe
  // implicite place APRES toutes les zones numerotees : le livreur entoure en
  // priorite les secteurs dont il veut fixer l'ordre, le reste suit le tri
  // automatique habituel. Sans aucune zone assignee (cas normal, feature non
  // utilisee), un seul groupe couvre tous les arrets et le comportement est
  // identique a l'ancien appel optimizeTourOrder() unique sur la totalite.
  const zoneGroups = new Map();
  eligibles.forEach((c, i) => {
    const z = c.zone != null ? c.zone : Infinity;
    if (!zoneGroups.has(z)) zoneGroups.set(z, []);
    zoneGroups.get(z).push(i + 1);
  });
  const zoneKeys = [...zoneGroups.keys()].sort((a, b) => a - b);

  // Chaine les zones bout a bout : la zone N+1 part du dernier arret de la
  // zone N (pas du point de depart global) -- seule la DERNIERE zone recoit
  // le retour au depot comme fin fixe. Budget de temps 2-opt partage entre
  // zones (au prorata, avec un plancher) plutot que 5s par zone, qui
  // deviendrait excessif avec de nombreuses petites zones.
  const order = [];
  let chainStart = 0;
  const zoneBudgetMs = Math.max(800, Math.floor(5000 / zoneKeys.length));
  zoneKeys.forEach((z, zi) => {
    const isLastZone = zi === zoneKeys.length - 1;
    const indices = zoneGroups.get(z);
    const finalIndices = isLastZone && depotEndIdx != null ? [...indices, depotEndIdx] : indices;
    const { order: zoneOrder } = optimizeTourOrder(matrix, chainStart, finalIndices, {
      avant12hFlags,
      penaltyWeight,
      timeBudgetMs: zoneBudgetMs,
      fixedEndIdx: isLastZone ? depotEndIdx : null,
    });
    order.push(...zoneOrder);
    chainStart = zoneOrder[zoneOrder.length - 1];
  });

  const legs = legDurationsSeconds(order, matrix, 0);
  const totalDureeSec = legs.reduce((a, b) => a + b, 0);
  // fixedEndIdx (voir tsp.js) garantit que le point de retour au depot,
  // s'il existe, est toujours le tout dernier element de `order` -- les
  // legs des arrets de livraison correspondent donc directement aux
  // memes positions dans `order` (pas besoin de les re-associer).
  const deliveryOrder = depotEndIdx != null ? order.slice(0, -1) : order;

  const stops = deliveryOrder.map((pointIdx, i) => {
    const colis = eligibles[pointIdx - 1];
    return {
      colisId: colis.id,
      ordre: i + 1,
      statutLivraison: "a_livrer",
      heureLivraison: null,
      legDureeSec: legs[i],
    };
  });

  return { stops, totalDureeSec };
}

// Ecran appelant (tour-ui.js, Etat A) : doit fournir un conteneur avec
// #routing-status, #routing-progress-fill et les boutons de declenchement
// (peu importe leur nombre/libelle, seul `useGps`/`depotReturn` importent ici).
export async function runSort(container, { useGps, depotReturn, onDone, disableButtons = [] }) {
  const statusEl = container.querySelector("#routing-status");
  const progressFill = container.querySelector("#routing-progress-fill");
  disableButtons.forEach((b) => (b.disabled = true));

  try {
    const settings = await getAllSettings();
    const eligibles = await listColisEligibles();

    if (eligibles.length === 0) {
      statusEl.textContent = "Aucun colis prêt à trier (valide et géocode d'abord tes scans).";
      disableButtons.forEach((b) => (b.disabled = false));
      return;
    }

    // Choix fait ici, au demarrage de CETTE tournee (pas un reglage global
    // fige a l'avance) -- persiste quand meme comme valeur par defaut pour
    // pre-cocher la case au prochain calcul.
    const depotReturnChecked = Boolean(depotReturn);
    await setSetting("depotReturn", depotReturnChecked);

    let start = { lat: settings.depotLat, lon: settings.depotLon, label: settings.depotLabel };
    if (useGps) {
      statusEl.textContent = "Localisation en cours…";
      try {
        const pos = await getCurrentPosition();
        start = { ...pos, label: "Position actuelle" };
      } catch (err) {
        statusEl.textContent = `Position indisponible (${err.message}), utilisation du dépôt.`;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    const depotReturnPoint = depotReturnChecked ? { lat: settings.depotLat, lon: settings.depotLon } : null;
    const { stops, totalDureeSec } = await computeOptimizedStops({
      eligibles,
      start,
      depotReturnPoint,
      settings,
      statusEl,
      progressFill,
    });

    const tour = await createTour({
      depot: start,
      stops,
      totalDureeSec,
      returnToDepot: Boolean(depotReturnPoint),
      depotArrivee: depotReturnPoint ? { lat: settings.depotLat, lon: settings.depotLon, label: settings.depotLabel } : null,
    });

    for (const colis of eligibles) {
      await saveColis({ ...colis, statut: "en_tournee" });
    }

    emit("tour:computed", { tour });
    statusEl.textContent = `Tournée prête (${formatDurationShort(totalDureeSec)} estimées).`;
    onDone?.(tour);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Erreur: ${err.message || err}`;
  } finally {
    disableButtons.forEach((b) => (b.disabled = false));
  }
}

// Recalcul EN PLACE d'une tournee active (bouton "Recalculer" en Etat B,
// tour-ui.js) : contrairement a runSort (qui archive/remplace toute la
// tournee), garde les arrets deja livres/en echec intacts a leur place et ne
// retrie que les arrets restants -- en incluant les colis "pret" scannes
// entre-temps (voir listColisEligibles). Le point de depart du retri essaie
// la position GPS live (le camion a bouge depuis le calcul initial), puis le
// dernier arret deja traite, puis le point de depart d'origine de la tournee
// en dernier recours.
export async function runRecalculate(container, { tour, onDone, disableButtons = [] }) {
  const statusEl = container.querySelector("#routing-status");
  const progressFill = container.querySelector("#routing-progress-fill");
  disableButtons.forEach((b) => (b.disabled = true));

  try {
    const settings = await getAllSettings();
    const sortedStops = tour.stops.slice().sort((a, b) => a.ordre - b.ordre);
    const fixedStops = sortedStops.filter((s) => s.statutLivraison === "livre" || s.statutLivraison === "echec");
    const eligibles = await listColisEligibles();

    if (eligibles.length === 0) {
      statusEl.textContent = "Aucun arrêt en attente à recalculer.";
      disableButtons.forEach((b) => (b.disabled = false));
      return;
    }

    let start = tour.depot;
    statusEl.textContent = "Localisation en cours…";
    try {
      const pos = await getCurrentPosition();
      start = { ...pos, label: "Position actuelle" };
    } catch (err) {
      const lastFixed = fixedStops[fixedStops.length - 1];
      const lastColis = lastFixed ? await getColis(lastFixed.colisId) : null;
      if (lastColis?.geocode?.lat != null) {
        start = { lat: lastColis.geocode.lat, lon: lastColis.geocode.lon, label: "Dernier arrêt traité" };
      }
      statusEl.textContent = `Position indisponible (${err.message}), repli sur "${start.label}".`;
      await new Promise((r) => setTimeout(r, 1200));
    }

    const depotReturnPoint = tour.returnToDepot && tour.depotArrivee ? { lat: tour.depotArrivee.lat, lon: tour.depotArrivee.lon } : null;
    const { stops: pendingStops, totalDureeSec: pendingTotal } = await computeOptimizedStops({
      eligibles,
      start,
      depotReturnPoint,
      settings,
      statusEl,
      progressFill,
    });

    // Renumerote TOUT le tableau final (fixes + pending) par position, sans
    // garder les anciens numeros d'ordre des arrets fixes -- bug reel corrige
    // ici : si un arret livre/en echec avait ete traite hors ordre (ex: un
    // arret n'ayant pas l'ordre le plus bas parmi les "ordre <=
    // fixedStops.length"), son ancien "ordre" pouvait entrer en collision avec
    // celui, recalcule, d'un arret pending -- deux arrets partageant alors le
    // meme "ordre", et markStopDelivered(tourId, ordre) (qui fait juste
    // tour.stops.find(s => s.ordre === ordre)) retombait sur le mauvais arret
    // (le premier du tableau, deja livre) : le bouton "Livre" de la hero card
    // semblait alors "refuser" indefiniment, l'arret vise n'etant en realite
    // jamais marque livre.
    const allStops = [...fixedStops, ...pendingStops];
    allStops.forEach((s, i) => {
      s.ordre = i + 1;
    });
    const fixedTotal = fixedStops.reduce((a, s) => a + (s.legDureeSec || 0), 0);

    const updatedTour = await saveTour({
      ...tour,
      stops: allStops,
      totalDureeSec: fixedTotal + pendingTotal,
    });

    for (const colis of eligibles) {
      await saveColis({ ...colis, statut: "en_tournee" });
    }

    emit("tour:computed", { tour: updatedTour });
    statusEl.textContent = `Tournée recalculée (${formatDurationShort(pendingTotal)} restantes estimées).`;
    onDone?.(updatedTour);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Erreur: ${err.message || err}`;
  } finally {
    disableButtons.forEach((b) => (b.disabled = false));
  }
}
