// Convertit graphify-out/graph.json (genere par `graphify extract --code-only`,
// voir README/CLAUDE.md) en vault Obsidian navigable -- Graphify n'a pas
// d'export Obsidian natif, mais un vault n'est qu'un dossier de fichiers
// .md avec des liens [[wiki]], donc rien d'exotique a produire ici.
//
// Usage : node tools/graphify-to-obsidian.js
// (a relancer apres chaque `graphify extract`/`cluster-only` pour rafraichir)
//
// Sortie : graphify-out/obsidian/ (un fichier .md par noeud de code, plus un
// fichier par communaute et un index) -- pointer Obsidian sur ce dossier.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const GRAPH_PATH = path.join(ROOT, "graphify-out", "graph.json");
const OUT_DIR = path.join(ROOT, "graphify-out", "obsidian");

function sanitizeFilename(id) {
  return id.replace(/[\\/:*?"<>|]/g, "_");
}

function nodeDisplay(node) {
  return `${node.label} — ${node.source_file}`;
}

function main() {
  if (!fs.existsSync(GRAPH_PATH)) {
    console.error(`Introuvable : ${GRAPH_PATH}. Lance d'abord "graphify extract <dossier> --code-only".`);
    process.exit(1);
  }
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8"));
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  const outgoing = new Map(); // id -> [{link, relation, confidence}]
  const incoming = new Map();
  for (const link of graph.links) {
    if (!outgoing.has(link.source)) outgoing.set(link.source, []);
    if (!incoming.has(link.target)) incoming.set(link.target, []);
    outgoing.get(link.source).push(link);
    incoming.get(link.target).push(link);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const byCommunity = new Map(); // community_name -> [node]
  for (const node of graph.nodes) {
    const key = node.community_name || `Communauté ${node.community}`;
    if (!byCommunity.has(key)) byCommunity.set(key, []);
    byCommunity.get(key).push(node);
  }

  // Une note par noeud de code : identite, communaute, appels sortants/entrants.
  for (const node of graph.nodes) {
    const file = path.join(OUT_DIR, `${sanitizeFilename(node.id)}.md`);
    const out = outgoing.get(node.id) || [];
    const inc = incoming.get(node.id) || [];
    const communityKey = node.community_name || `Communauté ${node.community}`;

    const lines = [];
    lines.push(`# ${node.label}`);
    lines.push("");
    lines.push(`- **Fichier** : \`${node.source_file}\`${node.source_location ? ` (${node.source_location})` : ""}`);
    lines.push(`- **Type** : ${node.file_type || "?"}`);
    lines.push(`- **Communauté** : [[${sanitizeFilename("community-" + communityKey)}|${communityKey}]]`);
    lines.push("");

    if (out.length > 0) {
      lines.push(`## Appelle / référence (${out.length})`);
      for (const l of out) {
        const t = nodesById.get(l.target);
        if (!t) continue;
        const tag = l.confidence === "INFERRED" ? " _(inféré)_" : "";
        lines.push(`- **${l.relation}** → [[${sanitizeFilename(t.id)}|${nodeDisplay(t)}]]${tag}`);
      }
      lines.push("");
    }

    if (inc.length > 0) {
      lines.push(`## Appelé par / référencé par (${inc.length})`);
      for (const l of inc) {
        const s = nodesById.get(l.source);
        if (!s) continue;
        const tag = l.confidence === "INFERRED" ? " _(inféré)_" : "";
        lines.push(`- [[${sanitizeFilename(s.id)}|${nodeDisplay(s)}]] **${l.relation}**${tag}`);
      }
      lines.push("");
    }

    if (out.length === 0 && inc.length === 0) {
      lines.push("_Aucune connexion détectée (constante/variable isolée, ou usage non capté par l'analyse statique)._");
      lines.push("");
    }

    fs.writeFileSync(file, lines.join("\n"));
  }

  // Une note par communaute, listant ses membres.
  for (const [communityKey, members] of byCommunity) {
    const file = path.join(OUT_DIR, `${sanitizeFilename("community-" + communityKey)}.md`);
    const lines = [`# ${communityKey}`, "", `${members.length} nœud(s) :`, ""];
    for (const m of members.sort((a, b) => a.label.localeCompare(b.label))) {
      lines.push(`- [[${sanitizeFilename(m.id)}|${nodeDisplay(m)}]]`);
    }
    fs.writeFileSync(file, lines.join("\n"));
  }

  // Index racine.
  const indexLines = [
    "# Index du graphe de code",
    "",
    `Généré depuis \`graphify-out/graph.json\` (${graph.nodes.length} nœuds, ${graph.links.length} liens).`,
    "",
    "## Communautés",
    "",
  ];
  for (const [communityKey, members] of [...byCommunity.entries()].sort((a, b) => b[1].length - a[1].length)) {
    indexLines.push(`- [[${sanitizeFilename("community-" + communityKey)}|${communityKey}]] (${members.length})`);
  }
  fs.writeFileSync(path.join(OUT_DIR, "Index.md"), indexLines.join("\n"));

  console.log(`OK : ${graph.nodes.length + byCommunity.size + 1} fichiers .md écrits dans ${OUT_DIR}`);
  console.log(`Ouvre ce dossier comme vault dans Obsidian (ou pointe un vault existant dessus), en partant de Index.md.`);
}

main();
