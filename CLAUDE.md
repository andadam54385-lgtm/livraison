# pwa/ — Tournée UPS (app de tri/livraison, 100% locale)

PWA installée en standalone sur iPhone (Safari), pour un livreur solo. **Aucune API, aucun
compte, aucun appel réseau après le premier chargement en wifi** — respecte ça dans tout
changement. Composant "B" ; `../data-prep/` (Composant A, en lecture seule, ne jamais y
exécuter quoi que ce soit) générait à l'origine `graph.json`/`ban.json` consommés ici.

**`assets/ban.json.gz` est depuis le 2026-07-24 régénéré indépendamment de data-prep**
(demande explicite : élargir la couverture à tout le 54 + 55, sans exécuter data-prep) —
téléchargement direct des exports officiels BAN par département
(`https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-{54,55}.csv.gz`),
transformés en JSON avec le `normalizeStreet`/`normalizeCity` de
`js/geocode/normalize-address.js` (le même que celui utilisé au runtime, donc compatible
avec `match-address.js` sans rien changer côté code). 366 396 entrées, bbox
`{minLat:48.36, maxLat:49.62, minLon:4.91, maxLon:7.10}` — plus étroite à l'ouest que
l'ancienne (qui débordait sur un bout de département voisin), plus large à l'est (54
s'étend jusqu'à la frontière). Script de regénération non conservé dans le repo (lancé une
fois depuis le scratchpad) — à refaire à l'identique si besoin : télécharger les deux CSV,
parser avec les colonnes `numero;rep;nom_voie;code_postal;nom_commune;lon;lat`, construire
`{n,rep,r,rn,cp,c,cn,lat,lon}` par ligne + `bbox` global, gzip, remplacer le fichier, puis
`node tools/gen-data-manifest.js`.

**`assets/graph.json.gz` a été élargi au 54+55 le 2026-07-26**, indépendamment de
data-prep (même contrainte : jamais rien exécuter dans `data-prep/`) — reimplémentation
complète depuis zéro de l'algorithme (lu en lecture seule dans
`data-prep/scripts/lib/graph-builder.js` pour en comprendre les règles exactes : vitesses
par type de voie, sens unique implicite, restrictions de virage via-nœud, plus grande
composante connexe), aucun code data-prep importé/exécuté. Pipeline (non conservé dans le
repo, lancé depuis le scratchpad) :
1. Télécharger les routes carrossables + relations `type=restriction` via l'API Overpass
   publique, en 4 tuiles (quadrants NE/NW/SE/SW de la bbox BAN 54+55) pour rester sous les
   limites de l'API — miroirs `overpass-api.de`/`overpass.kumi.systems`/
   `overpass.private.coffee`, requête `[out:xml]` avec `(._;>>;)` pour résoudre tous les
   nœuds référencés.
2. Parser le XML "out body" (un élément par ligne, y compris les `<node>` porteurs de tags
   type feu tricolore/jonction — pas auto-fermés, piège rencontré une fois).
3. Construire le graphe étendu par arête (même format que `graph-loader.js` attend :
   `nodeCoords`/`edges`/`edgeAdjacency`/`nodeOutgoingEdges`/`nodeIncomingEdges`/`bbox`).
4. Dédupliquer les voies/relations par id OSM (les 4 tuiles se chevauchent volontairement
   aux frontières).

**Contrainte mémoire réelle rencontrée** : cette machine n'a que 6 Go de RAM au total — une
première tentative fidèle à l'algorithme de référence (arêtes stockées comme objets JS
`{fromNode,toNode,seconds}`, sortie via un unique `JSON.stringify()`) a fait planter Node en
"JavaScript heap out of memory" à la construction du graphe. Corrigé en réécrivant les
structures chaudes (arêtes, coordonnées) en tableaux typés (`Int32Array`/`Float32Array`/
`Float64Array`, croissance amortie par doublement) et en écrivant le JSON en streaming
directement vers gzip (jamais de chaîne JSON complète ni de structure imbriquée entière en
mémoire) — validé de bout en bout sur un cas synthétique avant de relancer la construction
réelle. Retenir pour toute prochaine reconstruction/élargissement : ne JAMAIS repartir de
l'implémentation "tableaux d'objets" naïve sur une zone de cette taille.

**Résultat** : bbox `{minLat:48.355505, maxLat:49.615402, minLon:4.906709,
maxLon:7.103224}` (= bbox de `ban.json.gz`), 1 687 908 nœuds, 3 243 223 arcs, 276 291 voies
retenues, 5629/6126 restrictions de virage appliquées. **267 Mo décompressé / 71,5 Mo
gzippé** — plus gros que les 222,8 Mo (zone 80km) déjà jugés "trop risqués pour l'iPhone"
lors d'un essai antérieur documenté dans `config/zone.json` (côté data-prep) et jamais
déployés pour cette raison. Déployé quand même le 2026-07-26 **sur demande explicite de
l'utilisateur, après l'avoir prévenu du dépassement de ce seuil** (`AskUserQuestion` :
choix "Déployer tel quel" plutôt que réduire la zone ou garder l'ancien graphe). Si un
souci de mémoire/plantage à l'import est un jour rapporté sur l'appareil réel, la piste de
réduction la plus rentable est d'exclure les voies `service`/`living_street` (nombreuses en
zone urbaine/village, contribuent peu au routage inter-communes) et de recadrer la bbox
pour retirer le débordement constaté côté Luxembourg (coin nord-est).

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
  de `#tour-view`) visible dans les 2 états.
  **Fusion Carte + Tournée (2026-08-31, simplifiée le 2026-09-01)** : plus AUCUNE nav
  du bas, un seul écran, et la carte est le **fond permanent dans les DEUX états**
  (retour terrain explicite). `#tour-map-slot` (frère statique de
  `#tour-sheet`/`#tour-content` dans `index.html`, jamais réécrit par les renders)
  héberge une instance MapLibre **persistante** — `map-ui.js` n'exporte plus `mount()`
  mais `ensureMap(slot, variant)` (idempotent, setData+resize en réutilisation),
  `refreshMapData()` et `isMapMounted()`. La feuille `#tour-sheet` (3 crans
  collapsed/half/full, gérée par tour-ui) porte la préparation OU la tournée ; les flux
  de saisie (scan, saisie manuelle, rafale, fiche colis) la déplient d'office. Le lasso
  de zones vit sur la carte de fond. **L'ancien mode "overlay" (X pour fermer) a existé
  un build (94) et a été supprimé** : il a coincé l'utilisateur réel. **Geste de la
  poignée** : un tap (mouvement < 12px — l'ancien seuil de 4px rendait le tap mort au
  doigt, bug terrain) DÉPLIE d'un cran ; un glissement franc (≥ 24px) va toujours au
  cran suivant dans le sens du geste, jamais de retour élastique. Réglages : engrenage
  du header + lien du menu carte. L'ancien hash `#map` retombe sur `#tour`.
- **Liste d'arrêts de l'État B = deux sections repliables** (`<details>`, build 129, « la liste
  des points doit être un menu déroulant qui reste sur le dernier point à faire ») : « Arrêts
  suivants (N) — prochain : … » puis « Déjà traités (M) », repliées par défaut et mémorisées
  pour la session (`suivantsOuverts`/`traitesOuverts` dans `tour-ui.js`) ; une recherche ou le
  mode réordonner forcent l'ouverture sans toucher à la mémoire. `renderEtatB` conserve
  `containerRef.scrollTop` d'un rendu à l'autre (chaque livraison re-rend tout le HTML).
  **Révision d'un scan de liste** (`renderReviewList`) : bouton « Ajouter une adresse
  manquante » (fiche vierge via `renderReviewForm`, `source: "manuel"`), et retour sur la ligne
  qu'on vient de corriger/ajouter/supprimer (`focusIdx` + `flash-target`) au lieu du haut de la
  liste. `renderReviewForm` accepte `onCancel` (bouton « Retour » à la place de « Rescanner ») ;
  une ligne enregistrée s'affiche avec les valeurs enregistrées, pas le brouillon OCR.
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
  une vraie photo plutôt qu'à l'aveugle, avec un bouton "Corriger ce colis" (ouvre
  `renderReviewForm` sur place).
  **Journal des corrections OCR** (`js/scan/ocr-corrections-store.js`, store IndexedDB
  `ocrCorrections`, ajouté 2026-07-23 suite retour terrain "beaucoup d'erreurs, faut que ça
  serve pour les suivants") : chaque fois qu'une correction manuelle change un champ
  (nom/tel/rue/cp/ville) par rapport à ce que `parse-ups-label.js` produit pour le texte OCR
  brut de ce colis, un enregistrement `{ocrRawText, parsed, corrected, champsModifies,
  dateCorrection}` est journalisé silencieusement. **Si l'utilisateur colle un export de ce
  journal (bouton copier dans le bloc "📋 Corrections enregistrées" du debug OCR) dans une
  future session : analyser les cas pour repérer des motifs récurrents (ex: un mot-clé mal
  classé, un format de rue non géré) et corriger `classifyShipToBlock`/les regex de
  `parse-ups-label.js` en conséquence — c'est exactement l'usage prévu de ce journal, pas
  juste un historique passif.**
- **Scan de liste par PHOTOS** (build 124, 2026-09-02, « si photo plus fiable on fait photo,
  c'est largement plus simple ») : `analyzePhotoFiles` dans `batch-scan-ui.js`, chemin
  principal de « Scanner une liste » — une photo par page de la liste prise avec l'appareil
  natif, puis sélection multiple dans la photothèque (`<input accept="image/*" multiple>`,
  sans `capture`). Décision mesurée sur deux vidéos réelles : 13 paires d'images strictement
  identiques sur 45 (défilement à l'arrêt) et du charabia sur celles prises pendant le
  défilement (flou de mouvement + compression vidéo). Même moteur que la vidéo (OCR, parser,
  `dedup-drafts.js`, compte rendu `source: "photos"`), seule la source change ; chargement
  via `preprocess.js`'s `loadImageToCanvas` (même plafond 2400 px que le scan d'étiquette,
  éprouvé sur l'appareil). Le conteneur porte `data-analyse-en-cours` pendant l'analyse :
  `app.js` diffère un rechargement de mise à jour tant qu'il existe (pas de `<video>` ici,
  contrairement au chemin vidéo). La vidéo et le direct restent disponibles en secours.
- **Compte rendu de scan de LISTE** (`js/scan/scan-reports-store.js`, store IndexedDB
  `scanReports`, ajouté 2026-09-01 — « l'OCR devrait faire un compte rendu quand c'est une
  vidéo, là j'ai rien »). Le journal des corrections ci-dessus ne couvre que le scan d'UNE
  étiquette ; quand une vidéo sort un mauvais résultat il n'existait aucune trace
  exploitable. Chaque analyse vidéo enregistre le **texte OCR brut image par image, avec la
  position verticale de chaque ligne** (indispensable : le découpage en fiches dépend des
  écarts entre lignes — sans les positions un cas réel n'est pas rejouable dans
  `parse-address-list.test.mjs`), plus ce que le parser en a tiré. Export copiable dans le
  debug OCR des Réglages, 3 comptes rendus conservés. **Si l'utilisateur colle un export :
  l'analyser comme le journal de corrections** — c'est l'usage prévu.
  Le premier export réel (2026-09-01, 63 arrêts / 45 images) a révélé trois causes
  distinctes, toutes corrigées au build 121 : fragments de bord d'écran (une fiche coupée
  par le HAUT perd son DÉBUT — `isSameAddress` ne testait que les préfixes), commune collée
  dans la rue en ordre `<rue> <VILLE> <CP>`, et ponctuation parasite (`55000 )`,
  `55000 ,, BAR LE DUC`) bloquant la lecture du code postal. **Et un défaut bien plus
  grave, trouvé en écrivant les tests : deux numéros différents de la même rue fusionnaient
  en un seul arrêt** (un colis disparaissait silencieusement de la tournée) — d'où
  `js/scan/dedup-drafts.js`, sorti de `batch-scan-ui.js` précisément pour être testable
  hors navigateur, avec sa suite `dedup-drafts.test.mjs`. Ne jamais remettre cette logique
  dans un module d'interface.
- **`js/tour/deep-links.js`** : la destination envoyée à Waze/Google/Plans est **toujours le
  point GPS** (`lat,lon`), jamais le texte de l'adresse. Bug réel (build 128) : on passait
  l'adresse canonique BAN et l'appli de navigation la regéocodait — « Grande Rue » existe
  dans des dizaines de communes du secteur, Waze en choisissait une autre et emmenait dans
  un mauvais village (le code postal dans la chaîne n'y suffit pas). L'adresse texte n'est
  plus qu'un repli quand il n'y a pas de point, et une étiquette (`dname` côté Apple).
  Ne jamais remettre `q=<adresse>` côté Waze, ni combiner `q` et `ll` (avec les deux, Waze
  *cherche* le texte autour du point). Testé par `deep-links.test.mjs`.
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
lendemain (historique de tournées) — **fait** (2026-09-01) : bouton « Fin de journée »
(`finDeJournee` dans `tour-store.js`) qui archive la tournée du jour sous un **secteur**
libre (`secteur` + `dateJournee` locale sur le tour) et remet automatiquement en `pret`
tout ce qui n'a pas été livré (`en_tournee`/`echec`, zones manuelles effacées) — `a_verifier`
est laissé tel quel (problème d'adresse, pas de livraison). Historique groupé par jour dans
Réglages (`getToursGroupedByDay`), secteurs déjà utilisés proposés à la clôture suivante
(`listSecteursConnus`). Rien n'est supprimé : `purgeOldTours` reste le seul effacement.
G. Notes persistantes par adresse (fusion avec favoris) — **entamé par l'usage** : les
favoris portent déjà note + horaires de fermeture (`fermeDebut`/`fermeFin`, pris en compte
par l'optimiseur), éditables depuis la fiche colis, la carte d'arrêt (touche horloge sur
les pros) et les Réglages (avec recherche).
  **Horaires JOUR PAR JOUR (build 126, 2026-09-02)** : `js/favoris/horaires.js` (module pur,
  testé par `horaires.test.mjs`) — un favori porte `horaires = {lun..dim: {ferme, continu,
  matinDebut, matinFin, apremDebut, apremFin}}` — **deux plages** (matin, après-midi)
  par défaut, une case « journée continue » n'en laisse qu'une, bornée elle aussi (« si ça
  ouvre à 12 mais en continu, c'est bien de le savoir », build 127) ; cocher la case
  n'efface pas les heures de la coupure, elle les ignore. `closedWindowsForJour` renvoie le
  **complément** des plages ouvertes (toute heure non explicitement ouverte est fermée —
  évite les trous des cas partiels) que `tourCost` pénalise
  (plusieurs fenêtres par arrêt, l'ancienne paire `[debut, fin]` reste acceptée). Les deux formats précédents (couple `fermeDebut`/`fermeFin` tous
  les jours, puis `ouverture`/`fermeture`+`pause*` du build 126) sont convertis à la lecture
  par `horairesOf` et mis à `""` dès qu'on enregistre. Éditeur unique `horaires-ui.js`
  (onglets Lun..Dim, un jour à la fois, « Copier sur lun–ven / tous les jours ») partagé par
  la fiche colis, la carte d'arrêt (touche horloge des pros) et les Réglages. **Cœur** dans
  l'en-tête de la fiche colis = mise en favori explicite (`saveFavoriInfo(..., {creer:true})`),
  retrait avec confirmation si note/horaires existent.
  **Position GPS** : le `GeolocateControl` de MapLibre est le **seul** consommateur de la
  géolocalisation de l'appli — `trackUserLocation` suit déjà la position en continu et
  affiche le point du livreur en permanence après le premier appui. Une surveillance maison
  (`js/map/live-position.js`) avait été ajoutée au build 126 à côté de lui : sur iOS, deux
  `watchPosition` concurrents se gênent, le contrôle ne recevait plus de position et son
  bouton restait bloqué (« recentre ne marche plus ») — module supprimé au build 127.
  **Ne jamais rajouter de `watchPosition` ailleurs.**
  **Recherche d'entreprise** : le nom retenu est le texte tapé dans la recherche en ligne
  s'il diffère de l'adresse brute proposée par défaut (« mets le dernier nom mis pour la
  recherche, pas celui que l'app a noté »).

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
- **`assets/map.pmtiles`** (64,6 Mo depuis le 2026-07-26, était 61 Mo) : extrait avec le CLI
  Go `pmtiles extract` (binaire officiel `go-pmtiles`, télécharger le zip Windows depuis les
  releases GitHub de `protomaps/go-pmtiles` s'il n'est pas déjà présent — pas besoin
  d'installer Go, c'est un binaire autonome) depuis le build quotidien
  `https://build.protomaps.com/YYYYMMDD.pmtiles` (extraction distante par plages HTTP,
  jamais téléchargé en entier — 137 Go au total, seuls les chunks couvrant la bbox sont
  récupérés), bbox = celle de `ban.json`/`graph.json` (`4.906709,48.355505,7.103224,
  49.615402` au format `--bbox=min_lon,min_lat,max_lon,max_lat`).
  **`--maxzoom=14` donnait 116 Mo, rejeté par GitHub (limite dure 100 Mo, pas de Git LFS ici
  — GitHub Pages ne sait pas servir des fichiers LFS de toute façon)** : ré-extrait à
  `--maxzoom=13` depuis le fichier zoom-14 déjà téléchargé (`pmtiles extract` accepte un
  fichier local en entrée, pas besoin de retélécharger depuis le serveur distant) → 64,6 Mo.
  MapLibre sur-zoome automatiquement au-delà du maxzoom de l'archive (comportement standard
  du protocole pmtiles, aucun code à changer) — largement suffisant pour un aperçu
  Circuit-like, pas du turn-by-turn. Commande complète :
  `pmtiles.exe extract "https://build.protomaps.com/AAAAMMJJ.pmtiles" map-z14.pmtiles --bbox=4.906709,48.355505,7.103224,49.615402 --maxzoom=14`
  puis `pmtiles.exe extract map-z14.pmtiles map.pmtiles --maxzoom=13` si le premier résultat
  dépasse 100 Mo. Vérifier avec `pmtiles.exe show map.pmtiles` (bounds/maxzoom affichés).
  **Ne fais jamais tourner `pmtiles extract`/le CLI dans `data-prep/`** — c'est un artefact
  indépendant, régénéré uniquement si la zone de tournée change (rebbox depuis `ban.json`,
  puis `node tools/gen-data-manifest.js`).
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
