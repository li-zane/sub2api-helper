const countValue = value => Number.isFinite(value) && value >= 0 ? value : null;

export function overloadDashboard(detection, cooldown) {
  const points = (detection?.points || []).slice(-6);
  const threshold = Number.isFinite(cooldown?.settings?.threshold) && cooldown.settings.threshold > 0 ? cooldown.settings.threshold : null;
  const latest = points.at(-1);
  const statsAt = typeof latest?.end === "string" ? Date.parse(latest.end) : NaN;
  const cooldownAt = Date.parse(cooldown?.lastCheckedAt);
  const rolling = cooldown?.enabled !== false && cooldown?.settings?.windowMinutes === 15 && !cooldown.lastError
    && countValue(cooldown.windowCount) !== null
    && (countValue(latest?.count) === null || !Number.isFinite(statsAt) || cooldownAt >= statsAt);
  const quarter = rolling ? cooldown.windowCount : countValue(latest?.count);
  const complete = points.length === 6 && points.every(point => countValue(point.count) !== null);
  return {
    quarter: { count: quarter, limit: threshold, period: "15min", source: rolling ? "滚动 15 分钟" : "截至过载同步的最近 15 分钟", start: rolling ? null : latest?.start, end: rolling ? cooldown.lastCheckedAt : latest?.end },
    total: { count: complete ? points.reduce((sum, point) => sum + point.count, 0) : null, limit: threshold === null ? null : threshold * 3, period: "90min", source: "截至过载同步的最近 90 分钟累计", start: points[0]?.start, end: latest?.end },
  };
}

export function overloadEnergy(count, limit, enabled = true) {
  const known = enabled && countValue(count) !== null && Number.isFinite(limit) && limit > 0;
  const ratio = known ? Math.min(1, count / limit) : 0;
  return {
    known, ratio,
    tone: !known ? "unknown" : count === 0 ? "zero" : ratio >= 1 ? "full" : "active",
    color: !known ? "var(--surface-strong)" : count === 0 ? "var(--emerald)" : `hsl(${Math.round(45 * (1 - ratio))} 90% 48%)`,
  };
}
