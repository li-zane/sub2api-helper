export const TOAST_EVENT = "helper:toast";
let sequence = 0;

export function notify(message, { tone = "success" } = {}) {
  if (!message || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, {
    detail: { id: ++sequence, message: String(message), tone, expiresAt: Date.now() + 3000 },
  }));
}
