// Pool schedulable/active flags do not include an account's temporary 429 window.
export function accountRateLimit(account, now = Date.now()) {
  const value = account?.rate_limit_reset_at;
  const numeric = typeof value === "number" || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value);
  const reset = value == null || value === "" ? NaN : numeric
    ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value);
  if (Number.isFinite(reset) && Math.abs(reset) <= 8.64e15) return { limited: reset > now, until: new Date(reset).toISOString() };
  const status = String(account?.status || "").toLowerCase();
  const error = typeof account?.error_message === "string" ? account.error_message : JSON.stringify(account?.error_message || "");
  return { limited: status === "rate_limited" || account?.is_rate_limited === true
    || status === "error" && /\b429\b|rate_limit_exceeded|usage_limit_reached/i.test(error), until: null };
}
