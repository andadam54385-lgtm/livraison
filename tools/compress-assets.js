// Compresse assets/graph.json et assets/ban.json en .gz (execute en local,
// jamais au runtime). Necessaire pour rester sous la limite de taille de
// fichier de GitHub (100 Mo, avec avertissement des 50 Mo) : le graphe
// routier brut peut largement depasser cette limite sur une zone large,
// mais compresse tres bien (donnees JSON numeriques repetitives).
// Cote PWA, import-data.js decompresse nativement via DecompressionStream
// (supporte Safari 16.4+, deja notre plancher iOS pour le WASM SIMD de
// Tesseract.js -- aucune dependance supplementaire necessaire).
//
// Usage: node tools/compress-assets.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ASSETS_DIR = path.join(__dirname, "..", "assets");

function compress(name) {
  const srcPath = path.join(ASSETS_DIR, name);
  const outPath = `${srcPath}.gz`;
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Fichier introuvable: ${srcPath}`);
  }
  const data = fs.readFileSync(srcPath);
  const compressed = zlib.gzipSync(data, { level: 9 });
  fs.writeFileSync(outPath, compressed);
  const ratio = (compressed.length / data.length) * 100;
  console.log(
    `OK: ${outPath} (${(data.length / (1024 * 1024)).toFixed(1)} Mo -> ${(compressed.length / (1024 * 1024)).toFixed(1)} Mo, ${ratio.toFixed(0)}%)`
  );
}

compress("graph.json");
compress("ban.json");
