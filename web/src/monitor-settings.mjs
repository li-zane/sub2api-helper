// Shared UI/server contract. Intervals control refresh scheduling, not chart buckets.
export const MONITOR_FIELDS = Object.freeze([
  { key: "accountStatusIntervalSeconds", group: "号池与用量同步", label: "号池状态刷新间隔", unit: "秒", min: 1, max: 86400, default: 15 },
  { key: "usageTotalsIntervalSeconds", group: "号池与用量同步", label: "累计用量与金额同步间隔", unit: "秒", min: 1, max: 86400, default: 60 },
  { key: "usageTotalsConcurrency", group: "号池与用量同步", label: "累计用量同步并发", unit: "请求", min: 1, max: 1000, default: 100 },
  { key: "profileSyncConcurrency", group: "号池与用量同步", label: "号池配置同步并发", unit: "请求", min: 1, max: 1000, default: 100 },
  { key: "poolMonitorIntervalSeconds", group: "号池异常恢复", label: "号池异常巡检间隔", unit: "秒", min: 1, max: 86400, default: 300 },
  { key: "poolRepairRetrySeconds", group: "号池异常恢复", label: "异常重新授权重试间隔", unit: "秒", min: 0, max: 86400, default: 300 },
  { key: "overloadIntervalSeconds", group: "号池与用量同步", label: "调用与过载次数同步间隔", unit: "秒", min: 1, max: 86400, default: 60 },
  { key: "overloadConcurrency", group: "号池与用量同步", label: "次数同步并发", unit: "请求", min: 1, max: 1000, default: 100 },
  { key: "overloadCooldownIntervalSeconds", group: "过载监控", label: "过载冷却检查间隔", unit: "秒", min: 1, max: 3600, default: 60 },
  { key: "overloadCooldownConcurrency", group: "过载监控", label: "过载冷却检查并发", unit: "请求", min: 1, max: 1000, default: 100 },
  { key: "webSessionScanIntervalSeconds", group: "WebSession 定时巡检", label: "到期任务扫描间隔", unit: "秒", min: 1, max: 3600, default: 30 },
  { key: "fingerprintScanIntervalSeconds", group: "巡检调度", label: "降智巡检调度扫描间隔", unit: "秒", min: 1, max: 3600, default: 60 },
]);
export const DEFAULT_MONITORING = Object.freeze(Object.fromEntries(MONITOR_FIELDS.map(f => [f.key, f.default])));
export const TASK_SETTINGS_VERSION = 3;

export function normalizeSavedMonitoring(saved, defaults = DEFAULT_MONITORING) {
  let monitoring = saved.monitoring;
  // Version 2 tied the default sync cadence to the 15-minute chart buckets.
  // Keep custom cadences; version 3 can explicitly opt into 900 seconds again.
  if ((saved.version ?? 1) < TASK_SETTINGS_VERSION && monitoring?.overloadIntervalSeconds === 900) {
    monitoring = { ...monitoring, overloadIntervalSeconds: DEFAULT_MONITORING.overloadIntervalSeconds };
  }
  return normalizeMonitoring(monitoring, defaults);
}

export function normalizeMonitoring(value = {}, previous = DEFAULT_MONITORING) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("自动监控设置必须为对象");
  for (const key of Object.keys(value)) if (!MONITOR_FIELDS.some(f => f.key === key)) throw new Error(`未知自动监控设置：${key}`);
  return Object.fromEntries(MONITOR_FIELDS.map(field => {
    const n = Object.hasOwn(value, field.key) ? value[field.key] : previous[field.key] ?? field.default;
    if (typeof n !== "number" || !Number.isInteger(n) || n < field.min || n > field.max) throw new Error(`${field.label}必须为 ${field.min}–${field.max} 的整数（${field.unit}）`);
    return [field.key, n];
  }));
}
