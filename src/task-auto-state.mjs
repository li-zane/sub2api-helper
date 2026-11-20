export function hasJobTotpKey(job) {
  return Boolean(job?.totpSecret || job?.hasTotpCredential);
}

export function isTotpRotationComplete(job) {
  return Boolean(
    job?.status === "completed"
      && job?.lastOperationType === "replace_2fa"
      && hasJobTotpKey(job)
      && !job?.totpRotationIncomplete,
  );
}

export function isReauthorizationComplete(job) {
  return Boolean(
    job?.status === "completed"
      && ["relogin", "reauthorize"].includes(job?.lastOperationType)
      && job?.resultSaved,
  );
}

const AUTHORIZATION_TASKS = new Set(["authorize-codex", "upload", "rotate-logout-reauthorize-upload"]);
const POST_AUTHORIZATION_TASKS = new Set(["enable-overload-detection", "enable-overload-cooldown", "check-model-fingerprint"]);

// A later successful authorization can satisfy a failed import's prerequisite.
// Only recover the saved, unfinished follow-up actions still selected by the
// current plan. Never replay credential rotation, logout, authorization or upload.
export function postAuthorizationRecoveryActions(job, configuredActions) {
  if (job?.autoTaskStatus !== "failed" || job.status !== "completed" || !job.resultSaved
    || !["reauthorize", "relogin", "automatic_relogin"].includes(job.lastOperationType)
    || job.poolRefreshAction || job.poolRefreshError || job.totpRotationIncomplete || job.totpRotationRemoteDisabled) return [];
  const actions = job.autoTaskActions, index = job.autoTaskIndex || 0;
  if (!Array.isArray(actions) || !Number.isSafeInteger(index) || index < 0 || !AUTHORIZATION_TASKS.has(actions[index])) return [];
  return [...new Set(actions.slice(index).filter(action => POST_AUTHORIZATION_TASKS.has(action) && configuredActions.includes(action)))];
}
