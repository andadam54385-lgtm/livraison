import { listFavoris, updateFavori, deleteFavori } from "./favoris-store.js";
import { horairesOf } from "./horaires.js";
import { renderHorairesEditor } from "./horaires-ui.js";
import { filtrerFavoris, resumeFavori, adresseDepuisEntree } from "./favoris-liste.js";
import { renderManualAddressSearch } from "../geocode/geocode-ui.js";
import { boutonPositionHtml, brancherBoutonPosition } from "../geocode/position-actuelle.js";
import { saveColis } from "../scan/colis-store.js";
import { getActiveTour } from "../routing/tour-store.js";
import { insertStopCheapest } from "../routing/insert-stop.js";
import { showToast } from "../lib/toast.js";
import { icon } from "../ui/icons.js";
import { escapeHtml } from "../lib/escape.js";

// Ecran « Favoris » (etoile en haut de l'ecran Tournee, retour terrain
// 2026-11-17 : « dans les Reglages, tout deplie, ca prend trop de place, on
// ne s'y retrouve pas »). Liste COMPACTE, une ligne par adresse, toutes
// repliees ; toucher une ligne ouvre l'edition de CETTE adresse seulement
// (une seule ouverte a la fois). Le panneau d'edition n'est construit qu'a
// l'ouverture : avec 100 favoris, on ne fabrique pas 100 editeurs d'horaires.

let containerRef = null;
let favoris = [];
let recherche = "";
let ouvertId = null;

export async function mount(container) {
  containerRef = container;
  ouvertId = null;
  favoris = await listFavoris();
  renderCadre();
}

function renderCadre() {
  containerRef.innerHTML = `
    <input type="search" id="fav-recherche" placeholder="Rechercher (rue, ville, note)…" value="${escapeHtml(recherche)}" style="margin-bottom:8px;">
    <p class="muted" id="fav-compte" style="margin:0 0 8px;"></p>
    <div id="fav-liste" class="fav-liste"></div>
  `;
  containerRef.querySelector("#fav-recherche").addEventListener("input", (e) => {
    recherche = e.target.value;
    renderListe();
  });
  renderListe();
}

function ligneHtml(f) {
  const r = resumeFavori(f);
  const ouvert = f.id === ouvertId;
  return `
    <div class="fav-item ${ouvert ? "ouvert" : ""}" data-favori-id="${escapeHtml(f.id)}">
      <button type="button" class="fav-ligne" data-fav-toggle aria-expanded="${ouvert}">
        <span class="fav-ligne-texte">
          <span class="fav-titre">${escapeHtml(r.titre)}</span>
          <span class="fav-sous-titre">${escapeHtml(r.sousTitre)}</span>
        </span>
        ${r.aNote ? `<span class="fav-repere" title="Note">${icon("pencil", { spaced: false, size: 14 })}</span>` : ""}
        ${r.aHoraires ? `<span class="fav-repere" title="Horaires">${icon("clock", { spaced: false, size: 14 })}</span>` : ""}
        ${icon(ouvert ? "chevron-up" : "chevron-down", { spaced: false, size: 18 })}
      </button>
      ${ouvert ? `<div class="fav-panneau" data-fav-panneau></div>` : ""}
    </div>`;
}

function renderListe() {
  const visibles = filtrerFavoris(favoris, recherche);
  const compte = containerRef.querySelector("#fav-compte");
  const liste = containerRef.querySelector("#fav-liste");

  if (favoris.length === 0) {
    compte.textContent = "";
    liste.innerHTML = `<div class="empty-state">Aucune adresse favorite. Tape une note sur la fiche d'un colis : l'adresse arrive ici toute seule.</div>`;
    return;
  }
  compte.textContent = recherche.trim()
    ? `${visibles.length} sur ${favoris.length} adresse${favoris.length > 1 ? "s" : ""}`
    : `${favoris.length} adresse${favoris.length > 1 ? "s" : ""}`;
  liste.innerHTML = visibles.length > 0 ? visibles.map(ligneHtml).join("") : `<div class="empty-state">Aucun favori ne correspond.</div>`;

  liste.querySelectorAll("[data-fav-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.closest("[data-favori-id]").dataset.favoriId;
      ouvertId = ouvertId === id ? null : id;
      renderListe();
      if (ouvertId) liste.querySelector(`[data-favori-id="${CSS.escape(ouvertId)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  });

  const panneau = liste.querySelector("[data-fav-panneau]");
  if (panneau) renderPanneau(panneau, favoris.find((f) => f.id === ouvertId));
}

function renderPanneau(panneau, favori) {
  if (!favori) return;
  const adresseTexte = [favori.rue, [favori.cp, favori.ville].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  panneau.innerHTML = `
    <div class="field" style="margin-bottom:10px;">
      <label>Nom (client, entreprise…)</label>
      <input type="text" data-fav-nom class="field-lg" value="${escapeHtml(favori.nom || "")}" placeholder="Ex : Garage Martin">
    </div>
    <div class="field" style="margin-bottom:10px;">
      <label>Adresse</label>
      <p style="margin:0 0 6px;">${escapeHtml(adresseTexte || "(aucune)")}</p>
      <button type="button" data-fav-adresse style="width:100%;">${icon("pencil")}Modifier l'adresse</button>
      <div data-fav-adresse-slot hidden style="margin-top:8px;">
        ${boutonPositionHtml("fav-gps")}
        <p class="muted" style="margin:0 0 6px;">Le point GPS est placé là où tu te trouves ; l'adresse écrite ne change pas. Ou cherche une autre adresse :</p>
        <div data-fav-recherche></div>
      </div>
    </div>
    <div class="field" style="margin-bottom:10px;">
      <label>Note (code portail, chien, consigne…)</label>
      <textarea data-fav-note class="field-lg" rows="2" style="min-height:0;">${escapeHtml(favori.note)}</textarea>
    </div>
    <details class="fav-horaires" data-fav-horaires-details>
      <summary>${icon("clock")}Horaires d'ouverture${resumeFavori(favori).aHoraires ? "" : ` <span class="muted">(aucun)</span>`}</summary>
      <p class="muted" style="margin:6px 0;">La tournée évite les heures fermées.</p>
      <div data-fav-horaires></div>
    </details>
    <button type="button" class="primary" data-fav-addtour style="width:100%;">${icon("plus")}Ajouter à la tournée</button>
    <button type="button" class="danger" data-fav-delete style="width:100%;margin-top:8px;">${icon("trash-2")}Supprimer ce favori</button>
  `;

  // Nom : enregistre en quittant le champ ; la ligne de la liste (titre) suit.
  const nom = panneau.querySelector("[data-fav-nom]");
  nom.addEventListener("change", async () => {
    const valeur = nom.value.trim();
    if (valeur === (favori.nom || "")) return;
    await updateFavori(favori.id, { nom: valeur });
    favori.nom = valeur;
    showToast("Nom enregistré.");
    renderListe();
  });

  // Adresse : recherche BAN (le point GPS suit l'adresse choisie), ou point
  // pose sur la position actuelle (devant le client) sans toucher au texte.
  const slot = panneau.querySelector("[data-fav-adresse-slot]");
  panneau.querySelector("[data-fav-adresse]").addEventListener("click", () => {
    slot.hidden = !slot.hidden;
    if (slot.hidden || slot.dataset.construit === "1") return;
    slot.dataset.construit = "1";
    renderManualAddressSearch(slot.querySelector("[data-fav-recherche]"), {
      initialQuery: [favori.rue, favori.cp].filter(Boolean).join(" "),
      onPick: async (entree) => {
        const patch = adresseDepuisEntree(entree);
        await updateFavori(favori.id, patch);
        Object.assign(favori, patch);
        showToast("Adresse enregistrée.");
        renderListe();
      },
      onCancel: () => {
        slot.hidden = true;
      },
    });
    brancherBoutonPosition(slot, "fav-gps", async ({ lat, lon }) => {
      await updateFavori(favori.id, { lat, lon });
      Object.assign(favori, { lat, lon });
      showToast("Point GPS placé sur ta position.");
      slot.hidden = true;
    });
  });

  // Note : enregistree en quittant le champ, seulement si elle a change.
  const note = panneau.querySelector("[data-fav-note]");
  note.addEventListener("blur", async () => {
    if (note.value === (favori.note || "")) return;
    await updateFavori(favori.id, { note: note.value });
    favori.note = note.value;
    showToast("Note enregistrée.");
  });

  // Horaires repliees par defaut (l'editeur 7 jours est haut) : construit au
  // premier depli seulement.
  const details = panneau.querySelector("[data-fav-horaires-details]");
  details.addEventListener("toggle", () => {
    if (!details.open || details.dataset.construit === "1") return;
    details.dataset.construit = "1";
    renderHorairesEditor(details.querySelector("[data-fav-horaires]"), horairesOf(favori), {
      onChange: async (horaires) => {
        await updateFavori(favori.id, { horaires, fermeDebut: "", fermeFin: "" });
        Object.assign(favori, { horaires, fermeDebut: "", fermeFin: "" });
        showToast("Horaires enregistrés.");
      },
    });
  });

  panneau.querySelector("[data-fav-addtour]").addEventListener("click", () => ajouterALaTournee(favori));

  panneau.querySelector("[data-fav-delete]").addEventListener("click", async () => {
    if (!confirm("Supprimer cette adresse favorite ?")) return;
    await deleteFavori(favori.id);
    favoris = favoris.filter((f) => f.id !== favori.id);
    ouvertId = null;
    renderListe();
  });
}

// Deplace tel quel depuis les Reglages : cree le colis ET l'insere dans une
// tournee deja en cours (bug reel corrige auparavant : sans l'insertion, il
// restait « pret » hors tournee jusqu'au prochain recalcul complet).
async function ajouterALaTournee(favori) {
  const colis = await saveColis({
    nom: favori.nom || favori.rue || "Favori",
    adresseRaw: { rue: favori.rue, cp: favori.cp, ville: favori.ville },
    geocode: { lat: favori.lat, lon: favori.lon, status: "ok" },
    statut: "pret",
    dateScan: new Date().toISOString(),
    tel: "",
    quantite: 1,
    avant12h: false,
    sourceFavoriId: favori.id,
  });
  const activeTour = await getActiveTour();
  if (activeTour) {
    const result = await insertStopCheapest(activeTour, colis);
    if (result) {
      await saveColis({ ...colis, statut: "en_tournee" });
      showToast(`"${favori.nom || favori.rue || "Favori"}" ajouté à la tournée en cours (position ${result.position}).`);
      return;
    }
  }
  showToast(`"${favori.nom || favori.rue || "Favori"}" ajouté aux colis à trier.`);
}
