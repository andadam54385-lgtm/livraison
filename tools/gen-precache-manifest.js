// Script Node local (jamais execute par la PWA elle-meme) qui scanne pwa/ et
// ecrit precache-manifest.json a la racine, consomme par sw.js pour son
// installation cache-first. A relancer a chaque modification des fichiers
// de l'app (nouveau module JS, etc).
//
// assets/graph.json.gz et assets/ban.json.gz sont volontairement EXCLUS du
// precache : import-data.js les telecharge et les decompresse lui-meme au
// premier lancement pour les mettre en IndexedDB, ce qui est leur seule
// destination utile (une fois importes, plus jamais relus tels quels). Les
// precacher EN PLUS via le SW ferait telecharger/ecrire ces gros fichiers
// deux fois en parallele au premier lancement (SW + import), doublant
// inutilement la charge disque/reseau sans aucun benefice (voir mesures :
// l'ecriture concurrente du cache HTTP + de l'IndexedDB a cause un vrai
// ralentissement lors des tests).
//
// Usage: node tools/gen-precache-manifest.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");

const EXCLUDE_DIRS = new Set(["tools", "test-fixtures", "node_modules", ".git"]);
// map.pmtiles (60+ Mo) est gere par js/map/pmtiles-store.js (import initial
// vers OPFS, avec sa propre barre de progression), pas par le precache SW --
// meme raison que graph.json.gz/ban.json.gz : trop gros pour le Cache Storage
// "installe d'un bloc" du service worker, doit pouvoir etre suivi/repris.
const EXCLUDE_FILES = new Set(["precache-manifest.json", "graph.json.gz", "ban.json.gz", "map.pmtiles"]);

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(full, files);
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      files.push(rel);
    }
  }
  return files;
}

function main() {
  const files = walk(ROOT, []);
  files.sort();

  const hash = crypto.createHash("sha1");
  for (const rel of files) {
    hash.update(rel);
    hash.update(fs.readFileSync(path.join(ROOT, rel)));
  }
  const version = hash.digest("hex").slice(0, 12);

  const assets = ["./", ...files.map((f) => `./${f}`)];

  const manifest = { version, generatedAt: new Date().toISOString(), assets };
  const outPath = path.join(ROOT, "precache-manifest.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(ROOT, f)).size, 0);
  console.log(
    `OK: ${outPath}\n  ${files.length} fichiers, version ${version}, ~${(totalBytes / (1024 * 1024)).toFixed(1)} Mo au total`
  );
}

main();
