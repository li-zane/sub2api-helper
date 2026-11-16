import { overloadDashboard } from "./codex-dashboard.mjs";

export const OVERLOAD_FILTER_LABELS = { overloaded: "过载", normal: "不过载" };
export const FINGERPRINT_FILTER_LABELS = { mismatch: "降智", match: "不降智" };

export function overloadFilterValue(detection, cooldown) {
  if (cooldown?.enabled === true && ["pausing", "cooling"].includes(cooldown.phase)) return "overloaded";
  if (detection?.enabled !== true) return null;
  const { quarter, total } = overloadDashboard(detection, cooldown);
  const known = part => part.count !== null && Number.isFinite(part.limit) && part.limit > 0;
  if ([quarter, total].some(part => known(part) && part.count >= part.limit)) return "overloaded";
  return [quarter, total].every(known) ? "normal" : null;
}

export function fingerprintFilterValue(state) {
  if (state?.enabled !== true) return null;
  const records = [...(state?.recentResults || []), state?.result, state?.previousResult]
    .filter(record => record && Number.isFinite(Date.parse(record.checkedAt)))
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
  const status = records[0]?.status;
  return ["match", "mismatch"].includes(status) ? status : null;
}
