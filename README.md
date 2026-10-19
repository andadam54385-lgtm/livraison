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
chargement télécharge `assets/graph.json.gz`/`assets/ban.json.gz`
(compressés, décompressés nativement dans le navigateur via
`DecompressionStream`) puis les importe dans IndexedDB. Sur une grosse zone
(60km+), ça peut prendre plusieurs minutes (essentiellement le temps
d'écriture IndexedDB des dizaines/centaines de milliers d'adresses, pas le
téléchargement) — une barre de progression s'affiche.

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
node tools/compress-assets.js         # genere assets/graph.json.gz et ban.json.gz
rm assets/graph.json assets/ban.json  # sources non compressees, jetables (pas deployees, trop grosses pour Git au-dela d'une petite zone)
node tools/gen-data-manifest.js       # recalcule assets/manifest-content.json (hash des .gz)
node tools/gen-precache-manifest.js   # regenere precache-manifest.json pour le service worker
```

**Pourquoi la compression** : `graph.json` peut largement dépasser la limite
de taille de fichier de GitHub (100 Mo) au-delà d'une petite zone (~30km). Le
gzip réduit le graphe d'environ 3.6x et les adresses d'environ 11.7x (JSON
numérique/textuel très répétitif) — largement suffisant pour rester sous la
limite sur une zone raisonnable (~60-80km). Seuls les `.gz` sont commités
dans Git et déployés ; `assets/graph.json`/`ban.json` non compressés sont
dans `.gitignore` (sources locales jetables, régénérées à la demande depuis
`data-prep/output/`).

**Pourquoi ces 2 fichiers ne sont PAS dans le précache du service worker** :
`import-data.js` les télécharge et les décompresse lui-même au premier
lancement pour les mettre en IndexedDB — une fois importés, ils ne sont plus
jamais relus tels quels. Les précacher en plus via le service worker
ferait télécharger/écrire ces gros fichiers deux fois en parallèle au
premier lancement (mesuré : ralentissement sévère par contention disque).
`tools/gen-precache-manifest.js` les exclut explicitement.

Redéploie les fichiers modifiés (dont les `.gz`, dans `assets/`).
L'app détecte le changement de version au prochain lancement (comparaison
`manifest-content.json` vs IndexedDB) et réimporte automatiquement, avec
écran de progression.

Si tu modifies le code de l'app (n'importe quel fichier sous `js/`, `css/`,
`index.html`...), relance `node tools/gen-precache-manifest.js` avant de
redéployer. **Important** : les navigateurs ne détectent une mise à jour du
service worker qu'en comparant les octets de `sw.js` lui-même (pas ceux des
fichiers qu'il précache) — si ton changement ne touche pas `sw.js`,
incrémente manuellement `SW_BUILD` en haut de ce fichier, sinon les
appareils ayant déjà installé une version antérieure resteront bloqués sur
leur ancien cache indéfiniment.

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
