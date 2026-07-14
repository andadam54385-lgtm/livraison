const target = new EventTarget();

export function on(eventName, handler) {
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
}

export function once(eventName, handler) {
  target.addEventListener(eventName, handler, { once: true });
}

export function emit(eventName, detail) {
  target.dispatchEvent(new CustomEvent(eventName, { detail }));
}
