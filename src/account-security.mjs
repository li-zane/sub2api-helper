const flag = value => typeof value === "boolean" ? value : null;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

export function normalizeSecurityState(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  const mfa = flag(value.mfa_enabled_v2) ?? flag(value.mfa_enabled);
  const totpEnabled = flag(value.totpEnabled) ?? mfa;
  const passwordEnabled = flag(value.passwordEnabled) ?? flag(value.password_enabled) ?? flag(value.has_password);
  const checkedAt = date(value.checkedAt);
  return {
    totpEnabled, passwordEnabled, checkedAt,
    totpCheckedAt: date(value.totpCheckedAt) || (totpEnabled !== null ? checkedAt : null),
    passwordCheckedAt: date(value.passwordCheckedAt) || (passwordEnabled !== null ? checkedAt : null),
  };
}

export function mergeSecurityState(previous, patch, now = new Date().toISOString()) {
  const old = normalizeSecurityState(previous), next = normalizeSecurityState(patch);
  const hasTotp = next.totpEnabled !== null || Boolean(next.totpCheckedAt);
  const hasPassword = next.passwordEnabled !== null || Boolean(next.passwordCheckedAt);
  return { totpEnabled: hasTotp ? next.totpEnabled : old.totpEnabled,
    passwordEnabled: hasPassword ? next.passwordEnabled : old.passwordEnabled,
    totpCheckedAt: hasTotp ? next.totpCheckedAt || next.checkedAt || now : old.totpCheckedAt,
    passwordCheckedAt: hasPassword ? next.passwordCheckedAt || next.checkedAt || now : old.passwordCheckedAt,
    checkedAt: hasTotp || hasPassword ? next.checkedAt || now : old.checkedAt };
}

// Stored credentials are not evidence that a sign-in method is enabled.
// Historical successful authentication/activation is evidence, even if a local
// credential was subsequently cleared. Explicit remote booleans take priority.
export function publicSecurityState(job) {
  const state = normalizeSecurityState(job.securityState);
  if (state.passwordEnabled === null && !state.passwordCheckedAt && (job.passwordAddedAt || job.lastAuthRequirements?.password && job.lastAuthAutomatedAt)) {
    state.passwordEnabled = true; state.passwordCheckedAt = date(job.passwordAddedAt) || date(job.lastAuthAutomatedAt);
  }
  if (state.totpEnabled === null && !state.totpCheckedAt && (job.totpRotationStage === "confirmed" || job.lastAuthRequirements?.mfa && job.lastAuthAutomatedAt)) {
    state.totpEnabled = true; state.totpCheckedAt = date(job.lastAuthAutomatedAt);
  }
  return state;
}
