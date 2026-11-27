export const DEFAULT_DEGRADATION_COOLDOWN = Object.freeze({ enabled: false, longTerm: false, rotating: false, cooldownMinutes: 60 });

export function normalizeDegradationCooldown(value = {}) {
  const invalid = message => Object.assign(new Error(message), { status: 400 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("降智冷却设置必须为对象");
  const settings = { ...DEFAULT_DEGRADATION_COOLDOWN, ...value };
  for (const field of ["enabled", "longTerm", "rotating"]) {
    if (typeof settings[field] !== "boolean") throw invalid("降智冷却开关必须为布尔值");
  }
  const raw = settings.cooldownMinutes, minutes = Number(raw);
  if (typeof raw === "boolean" || raw === null || String(raw).trim() === "" || !Number.isInteger(minutes) || minutes < 1 || minutes > 43200) {
    throw invalid("降智冷却时长必须为 1–43200 分钟的整数");
  }
  return { enabled: settings.enabled, longTerm: settings.longTerm, rotating: settings.rotating, cooldownMinutes: minutes };
}

export function degradationCooldownApplies(settings, validity) {
  return settings.enabled && (validity === "长效" && settings.longTerm || validity === "轮转" && settings.rotating);
}
