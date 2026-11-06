// Keep historical logs intact while correcting the old, misleading UI wording.
export function oauthErrorMessage(value) {
  return typeof value === "string" && value.startsWith("CODEX_AUTH_LOGIN_REQUIRED:")
    ? "CODEX_AUTH_LOGIN_REQUIRED: Codex 要求继续账号身份验证；这不代表 Web 会话已失效"
    : value;
}
