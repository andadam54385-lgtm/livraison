// Tests unitaires du parser d'etiquette UPS. Aucun framework (coherent avec
// le "pas de build complexe" du projet) : execute directement via
// `node js/scan/parse-ups-label.test.mjs` (extension .mjs pour forcer le
// mode ES module sans avoir besoin d'un package.json).
import { parseUpsLabel } from "./parse-ups-label.js";

let failures = 0;

function assertEqual(actual, expected, label) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label} (attendu: ${JSON.stringify(expected)}, obtenu: ${JSON.stringify(actual)})`);
}

// --- Cas 1 (etiquette reelle) : nom duplique, telephone propre ---
console.log("\n=== Cas 1 : nom duplique, tel propre ===");
{
  const text = [
    "JULIEN BUNIET",
    "0607222071",
    "JULIEN BUNIET",
    "RUE DE L'EGLISE 6",
    "54470 ANSAUVILLE",
  ].join("\n");
  const r = parseUpsLabel(`SHIP TO:\n${text}`);
  assertEqual(r.nom, "JULIEN BUNIET", "nom");
  assertEqual(r.tel, "0607222071", "tel");
  assertEqual(r.telConfidence, "haute", "telConfidence");
  assertEqual(r.rue, "RUE DE L'EGLISE 6", "rue");
  assertEqual(r.cp, "54470", "cp");
  assertEqual(r.ville, "ANSAUVILLE", "ville");
}

// --- Cas 2 (etiquette reelle) : societe avant le vrai nom, tel ambigu ---
console.log("\n=== Cas 2 : societe avant le nom, tel sans marqueur (ambigu) ===");
{
  const text = [
    "NIKE DIGITAL",
    "789331367",
    "DOUCET BENOIT",
    "2 RUE DE L EAU",
    "55260 RUPT DEVANT SAINT MIHIEL",
  ].join("\n");
  const r = parseUpsLabel(`SHIP TO:\n${text}`);
  assertEqual(r.nom, "DOUCET BENOIT", "nom (pas NIKE DIGITAL)");
  assertEqual(r.tel, "0789331367", "tel (9 derniers chiffres + 0)");
  assertEqual(r.telConfidence, "a_verifier", "telConfidence (aucun marqueur -> a verifier)");
  assertEqual(r.rue, "2 RUE DE L EAU", "rue");
  assertEqual(r.cp, "55260", "cp");
  assertEqual(r.ville, "RUPT DEVANT SAINT MIHIEL", "ville");
}

// --- Cas 3 (etiquette reelle) : nom abrege puis complet, societe intercalee, rue sur 2 lignes ---
console.log("\n=== Cas 3 : nom abrege + complet, societe intercalee, rue sur 2 lignes ===");
{
  const text = [
    "M.PETITJEAN",
    "+33675088974",
    "ROYAL CANIN CHAMPAGNE LORRAINE",
    "JULIEN PETITJEAN",
    "ZONE D'ACTIVITE DES SOUHESMES",
    "ZI LIEU-DIT L'ATRIE",
    "55220 LES SOUHESMES RAMPONT",
  ].join("\n");
  const r = parseUpsLabel(`SHIP TO:\n${text}`);
  assertEqual(r.nom, "JULIEN PETITJEAN", "nom (dernier candidat avant la rue)");
  assertEqual(r.tel, "0675088974", "tel (prefixe +33 elimine)");
  assertEqual(r.telConfidence, "haute", "telConfidence (marqueur +)");
  assertEqual(r.rue, "ZONE D'ACTIVITE DES SOUHESMES ZI LIEU-DIT L'ATRIE", "rue (2 lignes concatenees)");
  assertEqual(r.cp, "55220", "cp");
  assertEqual(r.ville, "LES SOUHESMES RAMPONT", "ville");
}

// --- Regression : bloc expediteur ignore, tracking hors bloc, Ref.1 TEL concordant ---
console.log("\n=== Regression : expediteur ignore + tracking + Ref.1 TEL concordant ===");
{
  const text = [
    "ACME DISTRIBUTION",
    "5 RUE DE LA GARE",
    "54000 NANCY",
    "",
    "SHIP TO:",
    "CLAIRE MOREAU",
    "1 AVENUE DE L EUROPE",
    "55300 SAINT-MIHIEL",
    "",
    "1Z444XY50987654321",
    "",
    "Ref.1: TEL 0329891234",
  ].join("\n");
  const r = parseUpsLabel(text);
  assertEqual(r.nom, "CLAIRE MOREAU", "nom (expediteur ignore)");
  assertEqual(r.tracking, "1Z444XY50987654321", "tracking");
  assertEqual(r.rue, "1 AVENUE DE L EUROPE", "rue");
  assertEqual(r.cp, "55300", "cp");
  assertEqual(r.ville, "SAINT-MIHIEL", "ville");
  // Pas de tel dans le bloc SHIP TO ici -> tel vient uniquement de Ref.1, non
  // cross-validable contre lui-meme -> reste "a verifier" (comportement
  // attendu : Ref.1 seul ne suffit jamais a etablir une confiance haute).
  assertEqual(r.tel, null, "tel (aucun candidat dans le bloc SHIP TO)");
}

// --- Regression : prefixes internationaux varies sur un numero propre ---
console.log("\n=== Regression : prefixes internationaux varies ===");
{
  const cases = [
    ["TEL 0642158790", "0642158790"],
    ["TEL +33642158790", "0642158790"],
    ["TEL 0033642158790", "0642158790"],
    ["TEL 00336642158790", "0642158790"], // prefixe parasite double, toujours les 9 derniers chiffres
  ];
  for (const [line, expected] of cases) {
    const text = `SHIP TO:\nJEAN DUPONT\n${line}\n3 IMPASSE DES LILAS\n55300 SAINT MIHIEL`;
    const r = parseUpsLabel(text);
    assertEqual(r.tel, expected, `tel pour "${line}"`);
  }
}

// --- Regression : bruit OCR (chiffre isole dans le nom, confusion O/0)
// faisait disparaitre le nom avant ce correctif (toute la ligne partait en
// "rue" a cause d'un test /\d/ trop large -- voir historique de discussion,
// bug terrain "(nom inconnu)" systematique) ---
console.log("\n=== Regression : bruit OCR O/0 dans le nom (ne doit plus le faire disparaitre) ===");
{
  const text = ["MARTIN S0PHIE", "0642158790", "6 RUE DE L EGLISE", "54470 ANSAUVILLE"].join("\n");
  const r = parseUpsLabel(`SHIP TO:\n${text}`);
  assertEqual(r.nom, "MARTIN S0PHIE", "nom (present malgre le chiffre parasite)");
  assertEqual(r.rue, "6 RUE DE L EGLISE", "rue (pas contaminee par le nom)");
  assertEqual(r.cp, "54470", "cp");
  assertEqual(r.ville, "ANSAUVILLE", "ville");
}

console.log(`\n${failures === 0 ? "TOUS LES TESTS SONT PASSES" : `${failures} ECHEC(S)`}`);
process.exit(failures === 0 ? 0 : 1);
