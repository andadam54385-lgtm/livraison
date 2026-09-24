// Photo d'un colis (Blob IndexedDB) : object URLs partagees + visionneuse
// plein ecran. Utilise par la fiche colis et la hero card pour la photo
// "retrouver le colis dans le camion" (colis.photoColis, distincte de la
// photo de preuve de livraison colis.preuvePhoto).
//
// Les URLs sont memorisees par Blob (WeakMap) : la meme photo re-rendue N
// fois (chaque render() de la tournee re-cree tout le HTML) reutilise son
// URL au lieu d'en creer une nouvelle a chaque rendu. Une photo remplacee
// laisse fuir son ancienne URL jusqu'au rechargement de la page --
// negligeable (quelques photos par journee), et bien plus simple que de
// tracer la duree de vie de chaque rendu.
const urls = new WeakMap();

export function objectUrlFor(blob) {
  if (!blob) return null;
  if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
  return urls.get(blob);
}

// Visionneuse minimale : un tap n'importe ou referme. Pas de zoom maison --
// l'image plein ecran suffit pour reconnaitre un colis dans le camion.
// Une seule visionneuse a la fois : certains declencheurs sont lies deux
// fois (bindActionEvents tourne pour la hero card ET pour la liste des
// arrets sur le meme DOM) -- sans ce verrou, deux visionneuses empilees et
// le premier tap semblait ne pas refermer.
export function showPhotoViewer(blob) {
  if (!blob) return;
  document.querySelector(".photo-viewer")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "photo-viewer";
  const img = document.createElement("img");
  img.src = objectUrlFor(blob);
  img.alt = "Photo du colis";
  overlay.appendChild(img);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}
