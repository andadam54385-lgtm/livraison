// Calcule un hash de version pour assets/graph.json et assets/ban.json et
// ecrit assets/manifest-content.json, utilise par import-data.js pour savoir
// si les donnees deja en IndexedDB sont a jour (evite de reimporter a chaque
// lancement). A relancer a chaque fois que graph.json/ban.json sont
// remplaces (ex: zone data-prep elargie).
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
  const graphPath = path.join(ASSETS_DIR, "graph.json");
  const banPath = path.join(ASSETS_DIR, "ban.json");

  if (!fs.existsSync(graphPath) || !fs.existsSync(banPath)) {
    throw new Error(
      `Fichiers manquants dans ${ASSETS_DIR}. Copie d'abord data-prep/output/graph.json et ban.json vers pwa/assets/.`
    );
  }

  const manifest = {
    graphVersion: hashFile(graphPath),
    banVersion: hashFile(banPath),
    generatedAt: new Date().toISOString(),
  };

  const outPath = path.join(ASSETS_DIR, "manifest-content.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`OK: ${outPath}`);
  console.log(manifest);
}

main();
