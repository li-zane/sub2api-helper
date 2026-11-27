export const DEFAULT_PROXY_ROTATION = Object.freeze({
  enabled: false, intervalMinutes: 60, relogin: false,
  rotateMatched: true, rotateMismatched: true,
});

export function normalizeProxyRotation(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("IP 轮换设置必须是对象");
  const merged = { ...DEFAULT_PROXY_ROTATION, ...value };
  if (!Number.isSafeInteger(merged.intervalMinutes) || merged.intervalMinutes < 1 || merged.intervalMinutes > 43200) {
    throw Error("IP 轮换间隔必须是 1–43200 分钟的整数");
  }
  for (const field of ["enabled", "relogin", "rotateMatched", "rotateMismatched"]) {
    if (typeof merged[field] !== "boolean") throw Error("IP 轮换开关必须为布尔值");
  }
  return Object.fromEntries(Object.keys(DEFAULT_PROXY_ROTATION).map(key => [key, merged[key]]));
}
