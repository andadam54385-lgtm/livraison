// Calcule un hash de version pour assets/graph.json.gz, assets/ban.json.gz et
// assets/map.pmtiles (si present), et ecrit assets/manifest-content.json,
// utilise par import-data.js pour
// savoir si les donnees deja en IndexedDB sont a jour (evite de reimporter a
// chaque lancement). A relancer a chaque fois que ces fichiers sont
// remplaces (ex: zone data-prep elargie) -- APRES compress-assets.js.
//
// Usage: node tools/gen-data-manifest.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
}

function main() {
  const graphPath = path.join(ASSETS_DIR, "graph.json.gz");
  const banPath = path.join(ASSETS_DIR, "ban.json.gz");
  const mapPath = path.join(ASSETS_DIR, "map.pmtiles");

  if (!fs.existsSync(graphPath) || !fs.existsSync(banPath)) {
    throw new Error(
      `Fichiers manquants dans ${ASSETS_DIR}. Copie data-prep/output/graph.json et ban.json vers pwa/assets/, ` +
        `puis lance "node tools/compress-assets.js" avant celui-ci.`
    );
  }

  const manifest = {
    graphVersion: hashFile(graphPath),
    banVersion: hashFile(banPath),
    // map.pmtiles est optionnel (chantier C) : absent, la carte MapLibre
    // reste indisponible mais le reste de l'appli fonctionne normalement.
    mapVersion: fs.existsSync(mapPath) ? hashFile(mapPath) : null,
    generatedAt: new Date().toISOString(),
  };

  const outPath = path.join(ASSETS_DIR, "manifest-content.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`OK: ${outPath}`);
  console.log(manifest);
}

main();
