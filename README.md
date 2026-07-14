# pwa — Composant B : app de tri de tournée

PWA 100% locale (aucun backend, aucune API externe, aucun appel réseau après
le premier chargement). Consomme `graph.json`/`ban.json` produits par
`data-prep/` (Composant A) — voir `assets/` et `../data-prep/README.md`.

## Tester en local (PC, avant déploiement)

Aucun build requis — juste un serveur HTTP statique (les modules ES et le
service worker exigent une origine `http://`/`https://`, pas `file://`).

```
cd pwa
npx http-server -p 8123
```

Puis ouvre `http://localhost:8123/index.html` dans un navigateur. Le premier
chargement importe `assets/graph.json` (~11 Mo) et `assets/ban.json` (~10 Mo)
dans IndexedDB — ça prend quelques secondes, une barre de progression
s'affiche.

Pour tester avec les petites fixtures (`test-fixtures/`) sans charger les
vrais fichiers : `http://localhost:8123/index.html?fixtures=1`.

## Installer sur iPhone

1. Héberge le dossier `pwa/` sur un serveur HTTPS accessible depuis
   l'iPhone (nécessaire une seule fois, en wifi — ensuite l'app tourne
   entièrement hors-ligne). N'importe quel hébergement statique fait
   l'affaire (GitHub Pages, Netlify, un serveur perso, etc.) : aucune
   logique serveur n'est requise, juste servir les fichiers tels quels.
2. Ouvre l'URL dans Safari sur l'iPhone.
3. Attends la fin de l'import (barre de progression).
4. Bouton Partager → "Sur l'écran d'accueil" pour l'installer en PWA
   standalone.
5. Relance l'app depuis l'icône (pas depuis Safari) pour la suite —
   c'est le mode standalone qui active le service worker offline complet.
6. Réglages → vérifie/ajuste le dépôt par défaut si besoin.

Prérequis : iOS 16.4+ (support WASM SIMD requis par le moteur OCR
Tesseract.js vendorisé — voir `lib/tesseract/`).

## Mettre à jour les données (nouvelle zone ou zone élargie)

Après avoir relancé le pipeline `data-prep` (`npm run fetch-osm && npm run
build-graph && npm run build-ban` avec une `config/zone.json` mise à jour) :

```
cp ../data-prep/output/graph.json assets/graph.json
cp ../data-prep/output/ban.json assets/ban.json
node tools/gen-data-manifest.js       # recalcule assets/manifest-content.json
node tools/gen-precache-manifest.js   # regenere precache-manifest.json pour le service worker
```

Redéploie les fichiers modifiés. L'app détecte le changement de version au
prochain lancement (comparaison `manifest-content.json` vs IndexedDB) et
réimporte automatiquement, avec écran de progression.

Si tu modifies le code de l'app (n'importe quel fichier sous `js/`, `css/`,
`index.html`...), relance uniquement `node tools/gen-precache-manifest.js`
avant de redéployer, sinon le service worker continuera de servir une
version en cache.

## Structure

Voir les commentaires en tête de chaque fichier. Résumé rapide :

- `js/import/` — 1er lancement : charge `assets/*.json` → IndexedDB
- `js/scan/` — capture photo, prétraitement image, OCR (Tesseract.js
  vendorisé), parsing étiquette UPS, fiche colis éditable
- `js/geocode/` — matching adresse OCR ↔ BAN locale (normalisation +
  tolérance aux fautes)
- `js/routing/` — CSR du graphe routier, Dijkstra (Web Worker), TSP
  (nearest-neighbor + 2-opt)
- `js/tour/` — liste d'exécution, liens `tel:`/Apple Plans/Waze
- `js/settings/` — dépôt, appli nav par défaut, reset

## Prérequis navigateur

- Modules ES natifs, IndexedDB, Web Workers (module workers), Service
  Worker, `navigator.storage.persist()`, WASM SIMD (via Tesseract.js).
- Ciblé pour Safari iOS 16.4+ en PWA standalone. Fonctionne aussi tel quel
  dans Chrome/Edge/Firefox desktop récents pour le développement.
