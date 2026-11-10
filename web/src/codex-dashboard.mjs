import { overloadGrid } from "./overload-grid.mjs";

const countValue = value => Number.isFinite(value) && value >= 0 ? value : null;

export function overloadDashboard(detection, cooldown) {
  const fixed = Number.isInteger(detection?.bucketMinutes);
  const grid = overloadGrid(detection?.bucketMinutes);
  const windowMinutes = detection?.windowMinutes ?? cooldown?.settings?.windowMinutes ?? 15;
  const points = (detection?.points || []).slice(-grid.pointCount);
  const threshold = Number.isFinite(cooldown?.settings?.threshold) && cooldown.settings.threshold > 0 ? cooldown.settings.threshold : null;
  const latest = points.at(-1);
  const statsAt = Date.parse(detection?.overloadUpdatedAt || detection?.updatedAt || (typeof latest?.end === "string" ? latest.end : ""));
  const cooldownAt = Date.parse(cooldown?.lastCheckedAt);
  const rolling = cooldown?.enabled !== false && cooldown?.settings?.windowMinutes === windowMinutes && !cooldown.lastError
    && countValue(cooldown.windowCount) !== null
    && (countValue(fixed ? detection?.recentCount : latest?.count) === null || !Number.isFinite(statsAt) || cooldownAt >= statsAt);
  const quarter = rolling ? cooldown.windowCount : countValue(fixed ? detection?.recentCount : latest?.count);
  const complete = points.length === grid.pointCount && points.every(point => countValue(point.count) !== null);
  return {
    quarter: { count: quarter, limit: threshold, period: `${windowMinutes}min`, source: rolling ? `滚动 ${windowMinutes} 分钟` : `截至过载同步的最近 ${windowMinutes} 分钟`, start: rolling ? null : Number.isFinite(statsAt) ? new Date(statsAt - windowMinutes * 60_000).toISOString() : latest?.start, end: rolling ? cooldown.lastCheckedAt : detection?.overloadUpdatedAt || latest?.end },
    total: { count: complete ? points.reduce((sum, point) => sum + point.count, 0) : null, limit: threshold === null ? null : threshold * 3, period: `${grid.historyMinutes}min`, source: fixed ? `图表 ${grid.pointCount} 个过载统计窗口（每格 ${grid.bucketMinutes} 分钟）累计，含当前未结束区间` : "截至过载同步的最近 90 分钟累计", start: points[0]?.start, end: detection?.overloadUpdatedAt || latest?.end },
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
