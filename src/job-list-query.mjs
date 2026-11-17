import { hasJobTotpKey } from "./task-auto-state.mjs";

const STATUSES = [
  "queued", "starting", "working", "password", "mfa_otp", "totp_starting", "password_add_starting",
  "totp_setup_otp", "email_otp", "phone", "phone_otp", "finalizing", "refreshing", "completed",
  "failed", "mfa_failed", "banned", "canceled", "reauth_required", "resume_available",
];
const oneOf = (value, allowed) => allowed.includes(value) ? value : "";
const lower = value => String(value || "").trim().toLowerCase();

export function normalizeJobFilters(source = {}) {
  return {
    summary: oneOf(source.summary, ["active", "queued", "normal", "abnormal"]),
    search: String(source.search || "").trim(),
    lockedOnly: source.lockedOnly === true || source.lockedOnly === "true",
    webSession: oneOf(source.webSession, ["absent", "saved", "valid", "expired", "unavailable", "banned"]),
    accountType: oneOf(lower(source.accountType), ["password_totp", "pool_only"]),
    status: oneOf(lower(source.status), STATUSES),
    planType: String(source.planType || "").trim(),
    sub2apiPool: oneOf(lower(source.sub2apiPool), ["added", "error", "not_added", "unknown"]),
    sub2apiEnabled: oneOf(lower(source.sub2apiEnabled), ["enabled", "disabled", "unknown"]),
    overload: oneOf(source.overload, ["overloaded", "normal"]),
    fingerprint: oneOf(source.fingerprint, ["match", "mismatch"]),
  };
}

function matches(row, f, query, poolValue, enabledValue, isCheckingSession) {
  const { job, pool, health, active, blocked, planType } = row;
  if (f.summary === "active" && !active && !isCheckingSession(job)) return false;
  if (f.summary === "queued" && job.status !== "queued") return false;
  if ((f.summary === "normal" || f.summary === "abnormal") && f.summary !== health) return false;
  if (f.lockedOnly && job.status !== "banned" && !job.autoRepairBlocked) return false;
  if (f.status && job.status !== f.status) return false;
  if (f.planType && (planType || "__unknown__") !== f.planType) return false;
  if (f.sub2apiPool && poolValue !== f.sub2apiPool) return false;
  if (f.sub2apiEnabled && enabledValue !== f.sub2apiEnabled) return false;
  if (f.webSession && (blocked ? "banned" : job.webSessionStatus || "absent") !== f.webSession) return false;
  if (f.accountType === "pool_only" && !job.poolOnly) return false;
  if (f.accountType === "password_totp" && (job.poolOnly || job.loginMode !== "password" || !hasJobTotpKey(job))) return false;
  return !query || String(job.loginEmail || job.email).toLowerCase().includes(query)
    || String(job.remark || "").toLowerCase().includes(query)
    || String(planType || "").toLowerCase().includes(query) || String(pool.planType || "").toLowerCase().includes(query)
    || Boolean(job.assignedProxyId && String(job.assignedProxyId).includes(query));
}

// Synchronous projection over the records refreshed for this request. The
// HTTP layer owns I/O; domain-specific monitor snapshots are only consulted
// for survivors of the cheap predicates when that filter was requested.
export function projectJobList(jobs, { filters, emails, requestedPage, pageSize, webSessionChecks }, {
  readRow, isCheckingSession, matchesMonitoring, toSelection, toDetail,
}) {
  const plans = new Set(), pools = new Set(), enabled = new Set(), statuses = new Set();
  const stats = { normal: 0, abnormal: 0, pending: 0, active: webSessionChecks, webSessionChecks, queued: 0, completed: 0 };
  const emailSet = emails?.length ? new Set(emails) : null;
  const query = filters.search.toLowerCase();
  const monitorFilter = filters.overload || filters.fingerprint;
  const targetPage = Math.max(1, requestedPage);
  const selection = [], pageRows = [];
  let planTypeUnknown = false;
  for (const job of jobs) {
    const row = readRow(job);
    const { pool, planType, health, active } = row;
    const poolValue = pool.inPool === true ? (pool.remoteStatus === "error" ? "error" : "added")
      : pool.inPool === false ? "not_added" : "unknown";
    const enabledValue = pool.enabled === true ? "enabled" : pool.enabled === false ? "disabled" : "unknown";
    if (planType) plans.add(planType); else planTypeUnknown = true;
    pools.add(poolValue); enabled.add(enabledValue); statuses.add(job.status);
    stats[health]++;
    if (active) stats.active++;
    if (job.status === "queued") stats.queued++;
    if (job.status === "completed") stats.completed++;
    if (emailSet && !emailSet.has(job.loginEmail.toLowerCase())) continue;
    if (!matches(row, filters, query, poolValue, enabledValue, isCheckingSession)) continue;
    if (monitorFilter && !matchesMonitoring(row, filters)) continue;
    const index = selection.length;
    selection.push(toSelection(row));
    // Keep just the requested page, or the last partial page if the requested
    // page doesn't exist. Cross-page selection doesn't need each full row.
    if (Math.floor(index / pageSize) + 1 <= targetPage) {
      if (index % pageSize === 0) pageRows.length = 0;
      pageRows.push(row);
    }
  }
  const total = selection.length, totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(targetPage, totalPages), start = (page - 1) * pageSize;
  return {
    jobs: pageRows.map((row, i) => toDetail(row, selection[start + i])),
    selection,
    pagination: { page, pageSize, total, totalPages, totalAll: jobs.length },
    filter: { active: Boolean(emailSet) || Object.values(filters).some(Boolean), ...filters, requested: emails?.length || 0, matched: total },
    filterOptions: { statuses: STATUSES.filter(s => statuses.has(s)), planTypes: [...plans].sort(), planTypeUnknown,
      sub2apiPools: [...pools], sub2apiEnabled: [...enabled] },
    stats,
  };
}
