import { getAllTours } from "../routing/tour-store.js";
import { getColis, formatAdresseAffichage } from "../scan/colis-store.js";

// Export CSV des tournees (en cours + archivees) : une ligne par arret,
// destine a un suivi d'activite/comptabilite/preuve de livraison -- pas un
// format d'echange technique (voir bug-reports-ui.js/ocr-debug-ui.js pour les
// exports JSON destines a etre repartages avec le developpeur).

const COLUMNS = ["Date tournée", "Ordre", "Nom", "Adresse", "Téléphone", "Statut", "Heure", "Raison échec", "Quantité"];

const STATUT_LABELS = { livre: "Livré", echec: "Échec", a_livrer: "À livrer" };

// Champ CSV standard (RFC 4180) : entoure de guillemets des qu'il contient
// une virgule, un guillemet ou un retour a la ligne ; les guillemets internes
// sont doubles.
function csvField(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(values) {
  return values.map(csvField).join(",");
}

export async function buildToursCsv() {
  const tours = await getAllTours();
  // Plus ancienne d'abord (ordre chronologique naturel pour un export
  // d'activite, oppose a l'ordre "plus recent d'abord" des ecrans de l'app).
  tours.sort((a, b) => (a.dateCreation < b.dateCreation ? -1 : 1));

  const rows = [csvRow(COLUMNS)];

  for (const tour of tours) {
    const dateTournee = new Date(tour.dateCreation).toLocaleDateString("fr-FR");
    const stops = tour.stops.slice().sort((a, b) => a.ordre - b.ordre);
    for (const stop of stops) {
      const colis = await getColis(stop.colisId);
      if (!colis) continue; // colis supprime depuis -- pas de ligne fantome
      const heure = stop.heureLivraison || stop.heureEchec;
      rows.push(
        csvRow([
          dateTournee,
          stop.ordre,
          colis.nom || "",
          formatAdresseAffichage(colis),
          colis.tel || "",
          STATUT_LABELS[stop.statutLivraison] || stop.statutLivraison,
          heure ? new Date(heure).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "",
          stop.raisonEchec || "",
          colis.quantite || 1,
        ])
      );
    }
  }

  // ﻿ (BOM UTF-8) : sans lui, Excel sur Windows n'affiche pas
  // correctement les accents d'un CSV (les interprete dans une autre
  // encodage par defaut) -- inoffensif pour tout autre lecteur CSV
  // (LibreOffice, Numbers, etc.), qui l'ignorent silencieusement.
  return "﻿" + rows.join("\r\n");
}

export function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportToursCsv() {
  const csv = await buildToursCsv();
  const today = new Date().toISOString().slice(0, 10);
  downloadCsv(`tournees-${today}.csv`, csv);
}
