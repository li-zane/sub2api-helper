export function normalizeLoginAutomationPause(value) {
  if (!value || !["mfa_failed", "phone_unverified", "codex_email_verification"].includes(value.reason)) return null;
  return { reason: value.reason, at: typeof value.at === "string" ? value.at : null };
}

export function loginAutomationBlocked(pause, kind = "oauth") {
  const value = normalizeLoginAutomationPause(pause);
  return Boolean(value && (kind === "oauth" || value.reason === "mfa_failed"));
}

export function loginAutomationPauseMessage(pause) {
  if (pause?.reason === "codex_email_verification") return "邮箱二验：自动 Codex OAuth 已暂停，可手动重新授权";
  return pause?.reason === "mfa_failed"
    ? "上次 2FA 验证未完成，自动 Web/OAuth 登录已暂停，请手动触发登录后恢复"
    : "手机号验证尚未完成，自动 OAuth 已暂停，请手动触发授权后恢复";
}

export function displayLoginStatus(job) {
  const idle = ["completed", "failed", "canceled", "reauth_required", "resume_available"].includes(job.status);
  return idle && !job.autoRepairBlocked && job.codexEmailGate?.required ? "codex_email_verification" : job.status;
}
