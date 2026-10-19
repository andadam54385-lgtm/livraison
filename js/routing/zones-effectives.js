// Zone EFFECTIVE de chaque colis pour l'optimisation (voir
// computeOptimizedStops dans routing-ui.js). Fonction pure, testee par
// zones-effectives.test.mjs.
//
// Bug reel corrige ici (retour terrain 2026-09-30 : "regarde l'ordre qu'il
// m'a fait, c'est bizarre") : la tournee du jour allait Saizerais -> Liverdun
// -> Pompey -> Frouard -> Bouxieres-aux-Dames... puis REVENAIT a Pompey pour
// les deux derniers arrets, 11 min de route en arriere. Les colis sans zone
// formaient un groupe place APRES toutes les zones numerotees : il suffisait
// que deux adresses echappent au lasso (ou soient scannees apres le trace)
// pour qu'elles partent en fin de tournee, quelle que soit leur position.
//
// Regle : un colis sans zone rejoint la zone du colis ZONE le plus proche en
// temps de trajet (dans un sens ou dans l'autre), puis l'optimiseur le place
// librement A L'INTERIEUR de cette zone, comme les autres. Jamais de chainage
// (un sans-zone ne se rattache qu'a un colis zone a la main). Sans aucune
// zone posee, rien ne change : un seul groupe, tri automatique habituel.
//
// eligibles : colis dans l'ordre des points de la matrice (point i+1 =
//   eligibles[i], le point 0 etant le depart).
// matrix : matrix[a][b] = secondes de a vers b (Infinity si injoignable).
// Retour : tableau aligne sur eligibles -- numero de zone, ou Infinity pour
//   "aucune zone du tout" (cas sans zones).
export function zonesEffectives(eligibles, matrix) {
  const zones = eligibles.map((c) => (c.zone != null ? c.zone : null));
  const colisZones = zones.map((z, i) => ({ z, i })).filter(({ z }) => z != null);
  if (colisZones.length === 0) return eligibles.map(() => Infinity);

  return zones.map((z, i) => {
    if (z != null) return z;
    let meilleure = null;
    let meilleurTemps = Infinity;
    for (const { z: zj, i: j } of colisZones) {
      const aller = matrix[i + 1]?.[j + 1];
      const retour = matrix[j + 1]?.[i + 1];
      const t = Math.min(Number.isFinite(aller) ? aller : Infinity, Number.isFinite(retour) ? retour : Infinity);
      // A egalite, la plus petite zone : resultat stable d'un calcul a l'autre.
      if (t < meilleurTemps || (t === meilleurTemps && meilleure != null && zj < meilleure)) {
        meilleurTemps = t;
        meilleure = zj;
      }
    }
    // Injoignable de tous les colis zones (point hors reseau) : a vol
    // d'oiseau plutot qu'en fin de tournee.
    if (meilleure == null) meilleure = zoneLaPlusProcheAVolDOiseau(eligibles[i], colisZones.map(({ z: zj, i: j }) => ({ zone: zj, colis: eligibles[j] })));
    return meilleure;
  });
}

function zoneLaPlusProcheAVolDOiseau(colis, zones) {
  let meilleure = zones[0].zone;
  let meilleureDist = Infinity;
  for (const { zone, colis: c } of zones) {
    const dLat = (c.geocode?.lat ?? 0) - (colis.geocode?.lat ?? 0);
    const dLon = ((c.geocode?.lon ?? 0) - (colis.geocode?.lon ?? 0)) * Math.cos(((colis.geocode?.lat ?? 0) * Math.PI) / 180);
    const d = dLat * dLat + dLon * dLon;
    if (d < meilleureDist || (d === meilleureDist && zone < meilleure)) {
      meilleureDist = d;
      meilleure = zone;
    }
  }
  return meilleure;
}
