// Capture via <input capture="environment"> plutot que getUserMedia : delegue
// a l'appareil photo natif iOS (mise au point, flash, HDR geres par le systeme),
// plus fiable en PWA standalone et plus simple qu'un flux video maison (voir le
// plan, §4, pour la justification complete).

export function openCamera({ gallery = false } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (!gallery) input.capture = "environment";
    input.style.position = "fixed";
    input.style.top = "-9999px";
    document.body.appendChild(input);

    function cleanup() {
      input.remove();
    }

    input.addEventListener(
      "change",
      () => {
        const file = input.files && input.files[0];
        cleanup();
        if (file) resolve(file);
        else reject(new Error("Aucune photo sélectionnée."));
      },
      { once: true }
    );

    input.click();
  });
}
