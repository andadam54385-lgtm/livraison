import { queryByCp } from "./ban-index.js";

// Exportee : sert aussi a construire adresseAffichage (adresse canonique,
// bien casee) une fois un colis geocode -- voir colis-store.js.
export function formatEntry(entry) {
  const numero = entry.n ? `${entry.n}${entry.rep || ""} ` : "";
  return `${numero}${entry.r}, ${entry.cp} ${entry.c}`;
}

export function renderCandidatePicker(container, { candidates, onPick, onManual }) {
  const listHtml =
    candidates.length === 0
      ? `<p class="muted">Aucune adresse correspondante trouvée.</p>`
      : `<div class="candidate-list">
          ${candidates
            .map(
              (c, i) => `
            <button type="button" class="candidate-item" data-idx="${i}">
              ${formatEntry(c.entry)}
              <span class="muted">confiance ${Math.min(100, Math.round(c.score * 100))}%</span>
            </button>`
            )
            .join("")}
        </div>`;

  container.innerHTML = `
    ${listHtml}
    <div class="button-row">
      <button type="button" id="geocode-manual-btn">Saisie manuelle</button>
    </div>
  `;

  container.querySelectorAll(".candidate-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      onPick(candidates[idx].entry);
    });
  });
  container.querySelector("#geocode-manual-btn").addEventListener("click", onManual);
}

export function renderManualAddressSearch(container, { initialQuery = "", onPick, onCancel }) {
  container.innerHTML = `
    <div class="field">
      <label>Recherche libre (numéro, rue et code postal)</label>
      <input type="text" id="manual-search-input" placeholder="ex: 12 rue de la paix 55300" value="${initialQuery}">
    </div>
    <div id="manual-search-results" class="candidate-list"></div>
    <div class="button-row">
      <button type="button" id="manual-search-cancel">Retour</button>
    </div>
  `;

  const input = container.querySelector("#manual-search-input");
  const results = container.querySelector("#manual-search-results");
  let debounceTimer = null;

  async function runSearch(query) {
    const cpMatch = query.match(/\b\d{5}\b/);
    if (!cpMatch) {
      results.innerHTML = `<p class="muted">Ajoute le code postal (5 chiffres) pour chercher.</p>`;
      return;
    }
    const pool = await queryByCp(cpMatch[0]);
    const rest = query.replace(cpMatch[0], "").trim().toLowerCase();
    // Tous les mots tapes filtrent (ET logique), pas seulement le premier --
    // avec une adresse du genre "6 rue de l'eglise", ne garder que le premier
    // mot ("6") ne filtrait quasiment rien (un numero de porte revient dans
    // des dizaines d'entrees) et rendait impossible d'affiner la recherche en
    // tapant le nom de rue/commune (bug reel : correction jamais possible sur
    // un nom de rue courant partage par plusieurs communes du meme CP).
    const terms = rest.split(/\s+/).filter(Boolean);
    const filtered = terms.length
      ? pool.filter((e) => {
          const haystack = `${e.n}${e.rep || ""} ${e.r} ${e.c}`.toLowerCase();
          return terms.every((t) => haystack.includes(t));
        })
      : pool;

    results.innerHTML =
      filtered.length === 0
        ? `<p class="muted">Aucun résultat.</p>`
        : filtered
            .slice(0, 8)
            .map((e, i) => `<button type="button" class="candidate-item" data-idx="${i}">${formatEntry(e)}</button>`)
            .join("");

    results.querySelectorAll(".candidate-item").forEach((btn) => {
      btn.addEventListener("click", () => onPick(filtered[Number(btn.dataset.idx)]));
    });
  }

  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    debounceTimer = setTimeout(() => {
      if (query.length >= 4) runSearch(query);
    }, 200);
  });

  container.querySelector("#manual-search-cancel").addEventListener("click", onCancel);

  if (initialQuery.length >= 4) runSearch(initialQuery);
}
