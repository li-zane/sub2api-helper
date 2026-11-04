const record = value => value && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && value.trim().length <= 256 ? value.trim() : "";

// The provider can return both an alias and a canonical entry for one account.
// Merge by canonical ID before counting candidates; never discard a denial.
export function uniqueWorkspaceAccounts(payload) {
  const raw = payload?.accounts;
  const entries = Array.isArray(raw) ? raw : record(raw)
    ? Object.entries(raw).map(([id, value]) => ({ ...value, id: value?.id || id })) : [];
  const unique = new Map();
  for (const entry of entries) {
    if (!record(entry)) continue;
    const nested = record(entry.account) ? entry.account : {};
    const account = { ...entry, ...nested };
    if (entry.can_access_with_session === false || nested.can_access_with_session === false) account.can_access_with_session = false;
    for (const key of ["is_deactivated", "is_removed", "is_deleted"]) {
      if (entry[key] === true || nested[key] === true) account[key] = true;
    }
    const id = identifier(nested.account_id || nested.id || entry.account_id || entry.id || account.accountId);
    if (!id) continue;
    account.id = account.account_id = id;
    const previous = unique.get(id);
    if (!previous) { unique.set(id, account); continue; }
    const merged = { ...previous };
    for (const [key, value] of Object.entries(account)) {
      if (merged[key] === undefined || merged[key] === null || merged[key] === "") merged[key] = value;
    }
    for (const key of ["can_access_with_session", "canAccess"]) {
      if (previous[key] === false || account[key] === false) merged[key] = false;
    }
    for (const key of ["is_deactivated", "is_removed", "is_deleted", "isDeactivated", "isRemoved", "isDeleted"]) {
      if (previous[key] === true || account[key] === true) merged[key] = true;
    }
    for (const key of ["current", "is_current", "isCurrent", "selected", "is_selected", "isSelected"]) {
      if (previous[key] === true || account[key] === true) merged[key] = true;
    }
    for (const key of ["error", "access_error", "workspace_error", "accessError", "workspaceError"]) {
      if (record(previous[key]) && record(account[key])) merged[key] = { ...account[key], ...previous[key] };
      else if (account[key] && !previous[key]) merged[key] = account[key];
    }
    if (!isUsableWorkspaceAccount(previous) || !isUsableWorkspaceAccount(account)) merged.can_access_with_session = false;
    unique.set(id, merged);
  }
  return [...unique.values()];
}

export function isUsableWorkspaceAccount(account) {
  return Boolean(account && account.can_access_with_session !== false && account.canAccess !== false
    && !account.is_deactivated && !account.isDeactivated && !account.is_removed && !account.isRemoved
    && !account.is_deleted && !account.isDeleted && !account.error && !account.access_error && !account.accessError
    && !account.workspace_error && !account.workspaceError && !account.error_code && !account.errorCode
    && ![account.code, account.access_status, account.accessStatus].some(value => value && !/^(?:active|available|enabled|ok|success|2\d\d)$/i.test(String(value)))
    && ![account.status_code, account.http_status, account.statusCode, account.httpStatus].some(value => value !== null && value !== undefined && String(value).trim() && !/^2\d\d$/.test(String(value).trim()))
    && !/^(?:inactive|disabled|deactivated|banned|removed|deleted|suspended)$/i.test(account.status || ""));
}

export function isTeamWorkspaceAccount(account) {
  const structure = String(account.structure || account.kind || "").toLowerCase();
  if (structure === "personal") return false;
  return ["workspace", "organization", "team", "business", "enterprise"].includes(structure)
    || /^(?:team|business|enterprise|self_serve_business)(?:$|[_-])/.test(String(account.plan_type || account.planType || "").toLowerCase());
}
