# Fixtures de test PWA

`mini-graph.json` et `mini-ban.json` sont générés par le **vrai pipeline** de
`data-prep/` (pas écrits à la main), pour garantir un format strictement
identique aux fichiers réels (`graph.json`/`ban.json`).

## Contenu

- `mini-graph.json` : 5 nœuds, 6 arcs orientés (2 voies : "Rue de la Paix" à
  double sens, "Avenue du General Leclerc" à sens unique 4→2→5).
- `mini-ban.json` : 4 adresses ("Rue de la Paix" n°1 et 3, "Avenue du General
  Leclerc" n°12 et n°7 rep B), toutes à Toul (54200).

Coordonnées approximatives : lat ~48.680, lon ~5.890 (à l'intérieur de la
bbox `toul-test`).

## Régénérer ces fixtures

Si `data-prep/test-data/mini.osm.xml` ou `mini-ban.csv` changent, régénère
les fixtures PWA en rejouant le pipeline réel (procédure documentée dans
`data-prep/README.md`, section "Jeu de test") :

```
cd data-prep

# 1. Sauvegarder les vraies sorties/config
cp output/graph.json output/graph.json.bak
cp output/ban.json output/ban.json.bak
cp config/zone.json config/zone.json.bak

# 2. Basculer sur les fixtures
cp test-data/mini.osm.xml input/test-zone.osm.xml
cp test-data/mini-ban.csv input/adresses-99.csv
# éditer config/zone.json : "name": "test-zone", "banDepartments": ["99"]
# (la bbox actuelle couvre déjà les coordonnées fictives, pas besoin d'y toucher)

# 3. Générer
npm run build-graph && npm run build-ban

# 4. Copier vers la PWA
cp output/graph.json ../pwa/test-fixtures/mini-graph.json
cp output/ban.json ../pwa/test-fixtures/mini-ban.json

# 5. Restaurer les vraies sorties/config
cp config/zone.json.bak config/zone.json
cp output/graph.json.bak output/graph.json
cp output/ban.json.bak output/ban.json
rm output/*.bak config/zone.json.bak input/test-zone.osm.xml input/adresses-99.csv
```

## Utilisation dans la PWA

En développement, `import-data.js` peut charger ces fixtures à la place de
`assets/graph.json`/`assets/ban.json` (via un flag ou une URL différente)
pour tester tout le pipeline (import IDB → CSR → Dijkstra → géocodage) sans
manipuler les fichiers réels de 6.5+ Mo.
