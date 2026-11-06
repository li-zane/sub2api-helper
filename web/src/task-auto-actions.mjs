export const ROTATE_UPLOAD_ACTION = "rotate-logout-reauthorize-upload";

// Rotation already includes its own final upload. Keep legacy persisted queues'
// indexes intact; the runner skips the redundant step instead of removing it.
export function isRedundantTaskUpload(action, actions) {
  return action === "upload" && actions.includes(ROTATE_UPLOAD_ACTION);
}

export function normalizeTaskUploadActions(actions) {
  return actions.filter(action => !isRedundantTaskUpload(action, actions));
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
  if (checked && ["upload", ROTATE_UPLOAD_ACTION].includes(action)) next.add("authorize-codex");
  return normalizeTaskUploadActions([...next]);
}
