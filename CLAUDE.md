# pwa/ — Tournée UPS (app de tri/livraison, 100% locale)

PWA installée en standalone sur iPhone (Safari), pour un livreur solo. **Aucune API, aucun
compte, aucun appel réseau après le premier chargement en wifi** — respecte ça dans tout
changement. Composant "B" ; `../data-prep/` (Composant A, en lecture seule, ne jamais y
exécuter quoi que ce soit) génère `graph.json`/`ban.json` consommés ici.

## Graphe de connaissance du code (Graphify)

Un graphe navigable du code (fonctions/classes/imports/appels, pas le "métier") a été
généré avec [Graphify](https://graphify.com) (`pipx install graphifyy` / `py -m pipx
install graphifyy` sur cette machine, PATH pas configuré → binaire à
`~/.local/bin/graphify.exe`).

- **Régénérer** (après un refactor important) :
  ```
  graphify extract "chemin/vers/pwa" --code-only --force
  graphify cluster-only "chemin/vers/pwa" --no-label
  node tools/graphify-to-obsidian.js
  ```
  `--code-only` = analyse AST locale uniquement, aucun appel LLM/API.
  `.graphifyignore` exclut `lib/tesseract/` (bibliothèque tierce vendue et minifiée —
  sans ça le graphe est noyé sous des noms de fonctions à une lettre).
- **Consulter sans tout re-générer** : `graphify query "<question>"`, `graphify explain
  "nomDeFonction"`, `graphify path "A" "B"` sur `graphify-out/graph.json`.
- **Vault Obsidian** : `graphify-out/obsidian/` (`Index.md` = point d'entrée), généré par
  `tools/graphify-to-obsidian.js` (pas un export natif de Graphify — un vault n'est qu'un
  dossier de `.md` avec des `[[wikilinks]]`, script maison).
- Pas de hook `graphify install` posé (choix explicite : usage consultatif seulement, pas
  d'automatisation qui tourne à chaque session).

## Architecture (état au 2026-07-19)

- **`js/tour/tour-ui.js`** = écran "Tournée" fusionné, machine à 2 états dans le même
  conteneur : État A (pas de tournée active → liste de préparation des colis + "Optimiser
  la tournée") / État B (tournée active → carte "hero" pour l'arrêt courant + liste des
  suivants). Plus d'onglet Scan séparé — bouton caméra flottant (`#scan-fab`, HTML statique
  de `#tour-view`) visible dans les 2 états. Nav = 3 onglets : Tournée / Carte / Réglages.
- **`js/scan/colis-detail-ui.js`** = fiche colis consolidée (seul endroit avec
  Corriger/Favori/Supprimer — jamais sur les cartes de liste).
- **`js/scan/scan-ui.js`** = fonctions de flux (pas de vue auto-montée), paramétrées par
  `container` : `startScanFlow`, `startManualEntry`, `renderReviewForm`,
  `runGeocodeAndSave` — réutilisées par le FAB et par "Corriger".
- **Affichage adresse** : toujours passer par `colis-store.js`'s `formatAdresseAffichage(colis)`
  (adresse canonique BAN une fois géocodé, jamais une forme normalisée/interne). Ne jamais
  concaténer `adresseRaw.rue/cp/ville` à la main dans une nouvelle vue.
  **Statut "prêt" = géocodage OK, point final** — le nom/tél manquant n'est PAS bloquant
  (juste un repli d'affichage), retour utilisateur explicite, ne pas réintroduire de
  condition sur `colis.nom` ici.
- **`parse-ups-label.js`** : classification ligne à ligne du bloc SHIP TO ; un chiffre doit
  être **en début** de ligne pour classer en "rue" (`/^\d/`, pas `/\d/` — un bruit OCR
  isolé dans un nom ne doit plus faire disparaître ce nom). Écran de debug OCR dans
  Réglages (`js/scan/ocr-debug-ui.js`) pour diagnostiquer un futur échec de parsing avec
  une vraie photo plutôt qu'à l'aveugle.
- **`js/routing/insert-stop.js`** : insertion au moindre détour d'un colis scanné pendant
  une tournée en cours (pas de re-optimisation globale).
- **Statuts colis** : `a_verifier` → `pret` → `en_tournee` → `livre` **ou** `echec`
  (nouveau, avec motif libre — distinct de `a_verifier`, qui est une alerte de qualité
  géocodage/OCR, pas un statut de livraison).
- **4 couleurs sémantiques strictes** (voir `css/app.css`) : livré=vert, échec=rouge,
  avant12h=orange clair, à_livrer=neutre (couleur d'accent bleu). Mode clair/sombre auto
  (`prefers-color-scheme`, + override `data-theme`).

## Déploiement / test local

- Server local : `npx http-server -p 8123 -c-1` depuis `pwa/`, puis
  `http://localhost:8123/index.html` (`?fixtures=1` charge un petit jeu de données factice
  — **ce choix persiste dans `localStorage` même sans le paramètre dans l'URL ensuite**,
  vérifier `localStorage.getItem('useTestFixtures')` en cas de doute).
- **Après TOUT changement sous `js/`, `css/`, ou `index.html`** : incrémenter `SW_BUILD`
  dans `sw.js` et relancer `node tools/gen-precache-manifest.js` — sinon les navigateurs
  ayant déjà installé une version antérieure restent bloqués sur leur ancien cache
  indéfiniment (les octets de `sw.js` sont le seul signal de mise à jour détecté par le
  navigateur).
- Tests unitaires du parser : `node js/scan/parse-ups-label.test.mjs`.

## Roadmap (7 chantiers, un à la fois sauf exception notée, validation utilisateur entre chaque)

A. Refonte visuelle — **fait**. B. Enchaînement GPS fluide (Naviguer→Livré→suivant) —
**fait**. C. Carte d'aperçu (MapLibre + PMTiles + Protomaps) — **fait** (2026-07-20), voir
section dédiée ci-dessous. D. Scan code-barres (zxing-wasm) — **fait** (2026-07-20, en
parallèle de E : zéro recouvrement de fichiers entre les deux, jugé sûr à combiner —
contrairement à F/G qui touchent tous deux le stockage local et restent séquentiels).
E. Templates SMS personnalisables — **fait** (2026-07-20). F. Report des non-livrés au
lendemain (historique de tournées) — à faire, prochain chantier. G. Notes persistantes
par adresse (fusion avec favoris) — après F, pas en parallèle (les deux touchent le
stockage local).

## Chantier D — scan code-barres (fait le 2026-07-20)

L'app ne filme jamais en direct pour l'OCR (capture.js utilise `<input capture>`, la
caméra native iOS pour UNE photo -- plus fiable qu'un flux vidéo en PWA standalone, choix
déjà en place). Le document de travail original prévoyait pourtant un scan "douchette" en
flux vidéo continu pour le code-barres, ce qui aurait rajouté un flux `getUserMedia` que ce
choix évite explicitement -- discrepancy signalée à l'utilisateur, tranchée par lui :
**flux mixte, scan live en repli sur photo**.

- **`js/scan/viewfinder-ui.js`** (nouveau) : `startBarcodeViewfinder(container)` — ouvre un
  vrai flux caméra live (`getUserMedia`, `facingMode: "environment"`), boucle de détection
  ~4-5 fois/seconde (`setTimeout`, pas `requestAnimationFrame` — pas besoin de cadence
  écran pour du décodage CPU). Résout avec le texte décodé si un Code128 est trouvé, `null`
  si l'utilisateur tape "📷 Prendre une photo à la place" (ou si la caméra live/zxing est
  indisponible — repli silencieux, jamais bloquant), rejette si "Annuler" (même contrat que
  `capture.js`'s `openCamera()`, filtré pareil côté appelant).
- **`js/scan/barcode.js`** (nouveau) : charge `lib/zxing/zxing-reader.js` (build IIFE
  vendorisée de `zxing-wasm`, `readBarcodes`/`prepareZXingModule` exposés sur
  `window.ZXingWASM`) en différé, seulement à l'ouverture du viewfinder. `locateFile`
  surchargé vers `lib/zxing/zxing_reader.wasm` local (le package pointe par défaut vers
  jsDelivr). Reader-only (`dist/reader/`, pas `dist/full/` qui inclut aussi l'écriture de
  codes-barres, inutile ici) — 1.1 Mo de wasm au lieu de 1.5 Mo.
- **`js/scan/scan-ui.js`**'s `startScanFlow` : appelle le viewfinder AVANT `openCamera()`.
  Le tracking décodé par code-barres (exact) prime toujours sur celui deviné par l'OCR
  (chiffres/lettres faciles à confondre) dans `runOcrPipeline`, mais le nom/l'adresse/le
  téléphone continuent de venir de la photo+OCR comme avant — le scan ne remplace jamais
  cette étape, juste la précision du tracking. Nouvelle valeur `trackingConfidence:
  "code_barre"` (champ non lu ailleurs pour l'instant, juste plus precis que "haute").

## Chantier E — templates SMS (fait le 2026-07-20)

- **`js/tour/sms-template.js`** (nouveau) : `renderSmsTemplate(template, {nom,
  minutesEstimees, adresse})` (substitution simple, variable manquante → retirée, jamais
  affichée en `{brut}`) et `smsUrl(tel, body)`. **Format iOS `sms:NUMERO&body=TEXTE`
  (esperluette, pas `?`)** — comportement non documenté/non garanti par Apple (leur doc dit
  même explicitement que l'URL ne doit pas contenir de texte) mais c'est le format qui
  fonctionne en pratique ; à re-vérifier si un futur iOS casse le pré-remplissage.
- **`settings-store.js`** : nouveau réglage `smsTemplate` (`DEFAULTS`), éditable dans
  Réglages (`textarea` + bouton "Réinitialiser le modèle"), sauvegardé via le bouton
  "Enregistrer" existant (pas de sauvegarde immédiate — contrairement à `autoNavAfterDeliver`,
  ce n'est pas un toggle qu'on oublie de valider).
- **Bouton 💬 SMS** : sur la fiche colis (`colis-detail-ui.js`, `{minutes_estimees}` toujours
  vide ici — recalculer une ETA pour une seule fiche hors contexte de tournée serait coûteux
  pour peu de valeur) et sur la hero card de l'arrêt courant (`tour-ui.js`'s
  `renderHeroCard`, `{minutes_estimees}` réel via `lastEtas`, recalculé à chaque rendu à
  partir de `Date.now()` — jamais figé au moment du scan). N'envoie jamais automatiquement :
  ouvre Messages pré-rempli, l'utilisateur appuie lui-même sur Envoyer.

## Chantier C — carte MapLibre GL (fait le 2026-07-20)

`js/map/map-ui.js` a été entièrement réécrit : la carte SVG maison (rues dessinées à la
main depuis le graphe routier) est remplacée par un vrai fond de carte vectoriel
MapLibre GL JS + PMTiles + basemap Protomaps, 100% local, zéro requête réseau une fois
importé.

- **Fichiers vendorisés** (`lib/maplibre/`, jamais de CDN) : `maplibre-gl.js`/`.css`
  (5.24.0), `pmtiles.js` (copie UMD autonome tirée du tarball npm de maplibre-gl — la
  build officielle du package `pmtiles` est un module ESM qui importe `fflate`, pas
  utilisable en `<script>` classique), `basemap-assets/styles/{light,dark}.json` (générés
  une fois depuis `protomaps-themes-base`, langue FR, puis patchés à la main : `sources`
  pointe sur `pmtiles://map.pmtiles`, `sprite`/`glyphs` sur des chemins locaux),
  `basemap-assets/sprites/` (light/dark, 1x/2x) et `basemap-assets/fonts/Noto Sans
  {Regular,Medium,Italic}/0-255.pbf` (seule la plage Latin-1 est nécessaire pour le
  français — c'est tout ce que la palette de styles FR référence).
- **`assets/map.pmtiles`** (61 Mo) : extrait avec le CLI Go `pmtiles extract` depuis le
  build quotidien `https://build.protomaps.com/YYYYMMDD.pmtiles` (extraction distante par
  plages HTTP, jamais téléchargé en entier), bbox = celle déjà présente dans
  `ban.json`'s `bbox`, zoom 0-14 (assez pour un aperçu Circuit-like, pas pour du
  turn-by-turn). **Ne fais jamais tourner `pmtiles extract`/le CLI dans `data-prep/`** —
  c'est un artefact indépendant, régénéré uniquement si la zone de tournée change (rebbox
  depuis `ban.json`, puis `node tools/gen-data-manifest.js`).
- **Stockage** : `map.pmtiles` est trop gros pour le precache SW classique (voir
  `EXCLUDE_FILES` dans `tools/gen-precache-manifest.js`, même traitement que
  graph/ban.json.gz). Il est téléchargé une fois pendant l'import Wifi initial
  (`js/map/pmtiles-store.js`'s `ensureMapDownloaded`, appelé depuis
  `import-data.js`'s `runImportIfNeeded`) et stocké **en IndexedDB** (champ `file` du
  record `mapMeta`/`current`, un Blob directement — pas un ArrayBuffer). **OPFS a été
  essayé en premier puis abandonné** (2026-07-20) : `navigator.storage.getDirectory()`
  s'est révélé indisponible sur un appareil de test réel (Réglages y affichait aussi
  "Stockage local : indisponible" pour `navigator.storage.estimate()`, signe que
  `navigator.storage` entier n'était pas fiable sur cet appareil/navigateur précis) —
  IndexedDB fonctionne déjà partout ailleurs dans cette appli (BAN, colis, tournées) donc
  bien plus sûr comme socle. Un Blob stocké en IndexedDB reste géré par le moteur du
  navigateur comme une référence disque (pas chargé entièrement en mémoire JS tant qu'on
  ne fait que `.slice().arrayBuffer()` dessus), donc pas de perte de l'avantage recherché.
  Version suivie via `mapMeta.version` (schema bump à `DB_VERSION = 3` pour ce store),
  comparée à `manifest-content.json`'s `mapVersion` (hash SHA1 du fichier, ajouté par
  `tools/gen-data-manifest.js`). Si un appareil affiche encore "Fond de carte non
  téléchargé" après une synchro Wifi, vérifier `navigator.storage` dans la console de cet
  appareil précis avant de soupçonner autre chose.
- **Rendu** : arrêts = source GeoJSON `stops` (cercles colorés par statut + numéro,
  mêmes 4 couleurs sémantiques qu'avant), trajet = source `route` **suivant les rues
  réelles** (Dijkstra sur le graphe OSM local via `js/map/map-ui.js`'s
  `buildRouteSegments` — même logique que l'ancienne carte SVG, juste rendue en GeoJSON
  MapLibre maintenant ; repli en ligne droite par tronçon si le graphe n'est pas chargé,
  avec pastille d'avertissement dans la légende), position GPS live =
  `maplibregl.GeolocateControl` natif (watchPosition géré par MapLibre, pas de code
  maison). Thème clair/sombre suit `prefers-color-scheme` en live (`matchMedia` +
  `map.setStyle()`).
- **Chargement différé** : MapLibre GL (~1 Mo) et `pmtiles.js` ne sont injectés
  (`<script>`/`<link>` dynamiques) qu'à l'ouverture de l'onglet Carte, pas au boot de
  l'appli.
- `mount(container)` recrée entièrement l'instance `maplibregl.Map` à chaque appel
  (l'app appelle `mount()` à chaque fois que l'onglet Carte est rouvert, voir
  `app.js`'s `navigate()`) — coûteux mais simple, et cohérent avec le comportement de
  l'ancienne carte SVG qui perdait déjà pan/zoom à chaque "Marquer livré". Un futur
  chantier pourrait passer à un `Map` persistant + `.setData()` incrémental si ça devient
  sensible en usage réel.
