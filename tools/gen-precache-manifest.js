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

// Bug reel corrige ici (trouve en generalisant vers Tourneo, voir historique) :
// "graphify-out" (cache local du graphe de connaissance Graphify, exclu du
// depot par .gitignore -- voir CLAUDE.md) manquait de cette liste. Le
// manifeste genere en local listait donc jusqu'a 284 fichiers
// "./graphify-out/..." qui n'existent JAMAIS sur le site deploye (jamais
// pousses sur Git) -- sw.js's cache.addAll() etant tout-ou-rien, la moindre
// 404 parmi ces fichiers faisait echouer l'installation ENTIERE du service
// worker a chaque deploiement, silencieusement (aucune erreur visible cote
// utilisateur, juste "le mode hors-ligne ne marche jamais vraiment").
const EXCLUDE_DIRS = new Set(["tools", "test-fixtures", "node_modules", ".git", "graphify-out"]);
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

// Genere js/version.js a partir du SW_BUILD de sw.js -- AVANT le scan des
// fichiers, pour que le manifeste inclue la version fraiche. Un module
// precache (donc servi par le cache actif du service worker) est le SEUL
// endroit qui reflete fidelement la version REELLEMENT en train de tourner
// sur l'appareil : sw.js/precache-manifest.json relus par fetch renverraient
// la derniere version DEPLOYEE, pas celle chargee. Necessaire pour
// diagnostiquer a distance les "marche pas" dont la cause est simplement
// une mise a jour PWA pas encore activee (2 ouvertures parfois requises sur
// iOS) -- affiche dans Reglages, voir settings-ui.js.
function writeVersionModule() {
  const swSource = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const m = swSource.match(/const SW_BUILD = (\d+);/);
  if (!m) throw new Error("SW_BUILD introuvable dans sw.js");
  const content =
    "// GENERE par tools/gen-precache-manifest.js a partir du SW_BUILD de sw.js\n" +
    "// -- ne pas editer a la main, relancer le script apres un bump.\n" +
    `export const APP_BUILD = ${m[1]};\n`;
  fs.writeFileSync(path.join(ROOT, "js", "version.js"), content);
  return m[1];
}

function main() {
  const build = writeVersionModule();
  console.log(`js/version.js genere (build ${build})`);
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
