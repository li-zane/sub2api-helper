import { uniqueWorkspaceAccounts } from "./workspace-accounts.mjs";

const MAX_WORKSPACES = 100, MAX_IDENTIFIER_LENGTH = 256, MAX_USAGE_TEXT_LENGTH = 128;
const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const firstRecord = (...values) => values.find(isRecord) || null;
const firstBoolean = (...values) => values.find(value => typeof value === "boolean") ?? null;
function normalizeIdentifier(value) { const text = String(value || "").trim(); return text.length > 0 && text.length <= MAX_IDENTIFIER_LENGTH ? text : ""; }
function normalizeUsageText(value) { return String(value ?? "").trim().slice(0, MAX_USAGE_TEXT_LENGTH); }
function publicText(value, fallback = "") { return String(value ?? "").trim().slice(0, 256) || fallback; }

export function normalizeAccountWorkspaces(payload, currentAccountId = "") {
  const source = isRecord(payload) ? payload : {};
  const defaultAccountId = normalizeIdentifier(source.default_account_id ?? source.defaultAccountId ?? source.default_account);
  const requestedAccountId = normalizeIdentifier(currentAccountId);
  const responseSelectedAccountId = normalizeIdentifier(
    source.current_account_id
      ?? source.currentAccountId
      ?? source.selected_account_id
      ?? source.selectedAccountId,
  );
  const accounts = uniqueWorkspaceAccounts(source);
  const accountIds = new Set(accounts.map((account) => normalizeIdentifier(account?.id ?? account?.account_id ?? account?.accountId)).filter(Boolean));
  const selectedAccountId = responseSelectedAccountId && accountIds.has(responseSelectedAccountId)
    ? responseSelectedAccountId
    : requestedAccountId && accountIds.has(requestedAccountId)
      ? requestedAccountId
      : responseSelectedAccountId || defaultAccountId || requestedAccountId;
  const workspaces = accounts
    .slice(0, MAX_WORKSPACES)
    .map((account) => normalizeAccountWorkspace(account, selectedAccountId))
    .filter(Boolean);
  if (!workspaces.some((workspace) => workspace.current)) {
    const fallback = workspaces.find((workspace) => isAccountWorkspaceAvailable(workspace)) || workspaces[0];
    if (fallback) fallback.current = true;
  }
  return {
    currentWorkspaceId: workspaces.find((workspace) => workspace.current)?.id || null,
    workspaces,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeAccountWorkspace(account, defaultAccountId) {
  if (!isRecord(account)) return null;
  const id = normalizeIdentifier(account.id ?? account.account_id ?? account.accountId);
  if (!id) return null;
  const structure = normalizeUsageText(account.structure || account.kind || "workspace").toLowerCase();
  const name = publicText(account.name, structure === "personal" ? "个人账户" : "未命名工作空间");
  const rawCanAccess = account.can_access_with_session !== false && account.canAccess !== false;
  const rawDeactivated = account.is_deactivated === true || account.isDeactivated === true;
  const availability = normalizeAccountWorkspaceAvailability(account, rawCanAccess, rawDeactivated);
  const currentMarker = firstBoolean(
    account.current,
    account.is_current,
    account.isCurrent,
    account.selected,
    account.is_selected,
    account.isSelected,
  );
  return {
    id,
    name,
    structure: structure || "workspace",
    planType: normalizeUsageText(account.plan_type ?? account.planType) || null,
    role: normalizeUsageText(account.account_user_role ?? account.role) || null,
    current: currentMarker === true || (currentMarker !== false && id === defaultAccountId),
    canAccess: rawCanAccess && availability.reason === "available",
    deactivated: rawDeactivated || availability.reason === "deactivated",
    availabilityReason: availability.reason,
    availabilityCode: availability.code,
    availabilityMessage: availability.message,
    availabilityLabel: availability.label,
  };
}

export function isAccountWorkspaceAvailable(workspace) {
  return Boolean(
    workspace
      && workspace.canAccess !== false
      && workspace.deactivated !== true
      && workspace.availabilityReason === "available",
  );
}

export function accountWorkspaceAvailabilityLabel(workspace) {
  if (!workspace) return "该工作空间当前不可用或已失去授权";
  return publicText(workspace.availabilityLabel, "该工作空间当前不可用或已失去授权");
}

function normalizeAccountWorkspaceAvailability(account, canAccess, deactivated) {
  const error = firstRecord(account.error, account.access_error, account.accessError, account.workspace_error, account.workspaceError);
  const errorDetails = firstRecord(error?.details, error?.data, error?.reason);
  const code = normalizeWorkspaceCode(
    account.error_code,
    account.errorCode,
    account.status_code,
    account.statusCode,
    account.http_status,
    account.httpStatus,
    account.code,
    error?.error_code,
    error?.errorCode,
    error?.status_code,
    error?.statusCode,
    error?.http_status,
    error?.httpStatus,
    error?.code,
    errorDetails?.error_code,
    errorDetails?.errorCode,
    errorDetails?.status_code,
    errorDetails?.statusCode,
    errorDetails?.code,
  );
  const status = normalizeWorkspaceCode(account.status, error?.status, errorDetails?.status);
  const message = publicText(
    account.error_message
      ?? account.errorMessage
      ?? account.access_error_message
      ?? account.accessErrorMessage
      ?? account.reason
      ?? account.access_reason
      ?? account.accessReason
      ?? account.message
      ?? error?.message
      ?? error?.reason
      ?? errorDetails?.message
      ?? errorDetails?.reason,
    "",
  );
  const signalText = [code, status, message, account.access_status, account.accessStatus]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
  const removed = firstBoolean(
    account.is_removed,
    account.isRemoved,
    account.is_deleted,
    account.isDeleted,
    error?.is_removed,
    error?.isRemoved,
    error?.is_deleted,
    error?.isDeleted,
  ) === true;
  const banned = isWorkspaceHttpStatus(code, status, 402)
    || /(?:^|[^a-z])(banned|blocked|suspended|space[_ -]?ban|workspace[_ -]?(?:ban|blocked)|payment[_ -]?required)(?:$|[^a-z])/.test(signalText);
  const removedBySignal = removed
    || /(?:removed|deleted|not[_ -]?(?:found|member)|not[_ -]?(?:in|a[_ -]?member)|no[_ -]?longer[_ -]?(?:a[_ -]?)?(?:member|available)|left[_ -]?(?:the[_ -]?)?(?:workspace|organization)|membership[_ -]?(?:revoked|removed|not[_ -]?found)|kicked[_ -]?out|workspace[_ -]?(?:removed|deleted)|org(?:anization)?[_ -]?removed)/.test(signalText);
  const deactivatedBySignal = deactivated
    || /(?:deactivated|disabled|inactive|account[_ -]?suspended)/.test(signalText);
  const inaccessibleBySignal = canAccess === false
    || /(?:forbidden|unauthorized|permission|access[_ -]?(?:denied|revoked|unavailable)|not[_ -]?authorized|no[_ -]?access)/.test(signalText)
    || ["401", "403"].includes(String(code));
  const diagnosticStatus = status && !/^(?:active|available|enabled|ok|success)$/i.test(status) ? status : null;
  const diagnosticCode = code && !/^(?:active|available|enabled|ok|success|2\d\d)$/i.test(code) ? code : null;
  let reason = "available";
  if (banned) reason = "banned";
  else if (removedBySignal) reason = "removed";
  else if (deactivatedBySignal) reason = "deactivated";
  else if (inaccessibleBySignal) reason = "inaccessible";
  else if (diagnosticCode || diagnosticStatus || message) reason = "unknown";
  const normalizedCode = diagnosticCode || diagnosticStatus;
  return {
    reason,
    code: normalizedCode,
    message: message || null,
    label: workspaceAvailabilityLabel(reason, normalizedCode),
  };
}

function normalizeWorkspaceCode(...values) {
  let successful = null;
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (text && text.length <= MAX_USAGE_TEXT_LENGTH) {
      if (!/^(?:active|available|enabled|ok|success|2\d\d)$/i.test(text)) return text;
      successful ||= text;
    }
  }
  return successful;
}

function isWorkspaceHttpStatus(...values) {
  const expected = values.pop();
  return values.some((value) => Number(value) === expected);
}

function workspaceAvailabilityLabel(reason, code) {
  const suffix = code ? `（${code}）` : "";
  switch (reason) {
    case "removed": return `已移出空间${suffix}`;
    case "banned": return `空间封禁${suffix}`;
    case "deactivated": return `空间已停用${suffix}`;
    case "inaccessible": return `无权访问${suffix}`;
    case "unknown": return `不可用${suffix}`;
    default: return "";
  }
}
