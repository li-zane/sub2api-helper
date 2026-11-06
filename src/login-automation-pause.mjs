export function normalizeLoginAutomationPause(value) {
  if (!value || !["mfa_failed", "phone_unverified"].includes(value.reason)) return null;
  return { reason: value.reason, at: typeof value.at === "string" ? value.at : null };
}

export function loginAutomationBlocked(pause, kind = "oauth") {
  const value = normalizeLoginAutomationPause(pause);
  return Boolean(value && (kind === "oauth" || value.reason === "mfa_failed"));
}

export function loginAutomationPauseMessage(pause) {
  return pause?.reason === "mfa_failed"
    ? "上次 2FA 验证未完成，自动 Web/OAuth 登录已暂停，请手动触发登录后恢复"
    : "手机号验证尚未完成，自动 OAuth 已暂停，请手动触发授权后恢复";
}
