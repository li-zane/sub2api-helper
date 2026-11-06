export const DEFAULT_LOGIN_TIMEOUT_MINUTES = 3;
export const DEFAULT_SMS_TIMEOUT_MINUTES = 10;
export function normalizeLoginTimeoutMinutes(value = DEFAULT_LOGIN_TIMEOUT_MINUTES) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error("登录超时必须为 1–1440 的整数（分钟）");
  }
  return value;
}

export function normalizeSmsTimeoutMinutes(value = DEFAULT_SMS_TIMEOUT_MINUTES) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error("接码超时必须为 1–1440 的整数（分钟）");
  }
  return value;
}
