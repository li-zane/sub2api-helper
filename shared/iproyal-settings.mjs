export const IPROYAL_DEFAULTS = Object.freeze({
  enabled: false, intervalMinutes: 5, autoPause: false, thresholdGbPerIp: 10,
  syncCost: false, usdToCny: null,
  usageCooldownEnabled: false, usageThreshold: 50, usageUnit: 'GB', usageCooldownMinutes: 60,
});

export function iproyalSettings(patch, previous = IPROYAL_DEFAULTS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Object.assign(Error('巡检设置格式无效'), { status: 400 });
  const next = { ...previous };
  for (const key of Object.keys(IPROYAL_DEFAULTS)) if (Object.hasOwn(patch, key)) next[key] = patch[key];
  const fail = message => { throw Object.assign(Error(message), { status: 400 }); };
  for (const key of ['enabled', 'autoPause', 'syncCost', 'usageCooldownEnabled']) if (typeof next[key] !== 'boolean') fail('巡检开关需要布尔值');
  if (!Number.isInteger(next.intervalMinutes) || next.intervalMinutes < 1 || next.intervalMinutes > 1440) fail('巡检间隔须为 1–1440 分钟的整数');
  if (!Number.isFinite(next.thresholdGbPerIp) || next.thresholdGbPerIp < 0 || next.thresholdGbPerIp > 1000000) fail('单 IP 阈值须为 0–1000000 GB');
  if (next.usdToCny !== null && (!Number.isFinite(next.usdToCny) || next.usdToCny <= 0 || next.usdToCny > 1000)) fail('请填写有效的美元兑人民币汇率');
  if (next.syncCost && next.usdToCny === null) fail('同步成本前请填写美元兑人民币汇率');
  if (!['MB', 'GB'].includes(next.usageUnit)) fail('用量单位须为 MB 或 GB');
  if (!Number.isFinite(next.usageThreshold) || next.usageThreshold <= 0 || next.usageThreshold > 1000000) fail('新增用量阈值须大于 0 且不超过 1000000');
  if (!Number.isInteger(next.usageCooldownMinutes) || next.usageCooldownMinutes < 1 || next.usageCooldownMinutes > 43200) fail('用量冷却时间须为 1–43200 分钟的整数');
  return next;
}
