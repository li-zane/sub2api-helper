export const ROTATE_UPLOAD_ACTION = "rotate-logout-reauthorize-upload";

// Rotation includes Web/OAuth reauthorization and upload. Keep legacy persisted
// queues' indexes intact; the runner skips redundant steps without rewriting it.
export function isRedundantTaskUpload(action, actions) {
  return action === "upload" && actions.includes(ROTATE_UPLOAD_ACTION);
}

export function isRedundantTaskAuthorization(action, actions) {
  return action === "authorize-codex" && actions.includes(ROTATE_UPLOAD_ACTION);
}

export function normalizeTaskUploadActions(actions) {
  return actions.filter(action => !isRedundantTaskUpload(action, actions) && !isRedundantTaskAuthorization(action, actions));
}

export function toggleTaskAutoAction(actions, action, checked) {
  const next = new Set(actions);
  if (checked) {
    next.add(action);
    if (action === "upload") next.delete(ROTATE_UPLOAD_ACTION);
    if (action === ROTATE_UPLOAD_ACTION) next.delete("upload");
  } else {
    next.delete(action);
    if (action === "authorize-codex") { next.delete("upload"); next.delete(ROTATE_UPLOAD_ACTION); }
  }
  if (checked && action === "upload") next.add("authorize-codex");
  return normalizeTaskUploadActions([...next]);
}
