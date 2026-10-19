export function showToast(message, { variant = "default", durationMs = 4000 } = {}) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const el = document.createElement("div");
  el.className = variant === "warn" ? "toast toast-warn" : variant === "danger" ? "toast toast-danger" : "toast";
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}
