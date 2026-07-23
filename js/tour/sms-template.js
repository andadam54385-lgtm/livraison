// Templates SMS personnalisables (chantier E). Variables reconnues :
// {nom}, {minutes_estimees}, {adresse} -- une variable sans valeur connue
// (ex: minutes_estimees hors tournee active) est simplement retiree du texte,
// jamais affichee telle quelle ("{minutes_estimees}" en dur serait pire
// qu'une phrase incomplete).

export function renderSmsTemplate(template, { nom, minutesEstimees, adresse } = {}) {
  return (template || "")
    .replaceAll("{nom}", nom || "")
    .replaceAll("{minutes_estimees}", minutesEstimees != null ? String(minutesEstimees) : "")
    .replaceAll("{adresse}", adresse || "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Format du lien "sms:" pre-rempli : iOS n'accepte QUE "&body=" (pas
// "?body=", cote officiellement non documente/non garanti par Apple -- leur
// doc dit meme explicitement que l'URL "ne doit pas" contenir de texte,
// mais c'est le format qui fonctionne en pratique sur iOS). Jamais d'envoi
// automatique : ça ouvre juste l'app Messages, pre-remplie, l'utilisateur
// appuie lui-meme sur Envoyer.
export function smsUrl(tel, body) {
  return `sms:${encodeURIComponent(tel)}&body=${encodeURIComponent(body)}`;
}

// 3 modeles minimum (retour terrain : une seule situation-type ne suffit
// pas -- arrivee/depose/absent n'ont rien a voir). Retourne des donnees
// brutes (pas de HTML ici : chaque UI appelante a sa propre fonction
// d'echappement) pour construire un petit choix au moment d'envoyer.
export function buildSmsOptions(templates, tel, vars) {
  return (templates || []).map((template, index) => {
    const body = renderSmsTemplate(template, vars);
    return { index, body, href: smsUrl(tel, body) };
  });
}
