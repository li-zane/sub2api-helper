import crypto from "node:crypto";
import fs from "node:fs/promises";
import { isIP } from "node:net";
import { CookieJar, ProtocolClient } from "./protocol-login.mjs";
import { readAccountWebSession, writeAccountWebSession, webSessionPathForJob, setWebSessionState } from "./account-web-session.mjs";

import {
  TlsFingerprintTransport,
} from "./tls-transport.mjs";

const DEFAULT_CHATGPT_BASE = "https://chatgpt.com";
const DEFAULT_AUTH_BASE = "https://auth.openai.com";
const DEFAULT_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// chrome142 is the last profile currently accepted by the bundled curl_cffi on x1;
// deployments can override it with TOSUB2_TLS_PROFILE after a profile probe.
const DEFAULT_TLS_PROFILE = "chrome142";
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_SKEW_SECONDS = 60;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_DEVICES = 500;
const MAX_USAGE_TEXT_LENGTH = 128;
const MAX_USAGE_WINDOW_SECONDS = 31_536_000;
const MAX_WORKSPACES = 100;

/**
 * Read the official ChatGPT usage endpoint through the same Web session
 * used by the session manager. Only the normalized public shape is returned.
 */
export async function fetchAccountUsage(job) {
  const result = await requestWithWebSession(job, "GET", "/wham/usage");
  return {
    ...normalizeAccountUsage(result.data),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * List every ChatGPT account/workspace available to the saved Web session.
 * The response intentionally omits access/refresh tokens and other credentials.
 */
export async function listAccountWorkspaces(job, { forceWebRefresh = false, refreshOnUnauthorized = true } = {}) {
  const result = await requestWithWebSession(job, "GET", "/accounts/check/v4-2023-04-27", undefined, { forceWebRefresh, refreshOnUnauthorized });
  return normalizeAccountWorkspaces(result.data, result.session.web?.workspaceId);
}

// A live check, unlike inspectAccountWebSession(), which only reads a file.
// Confirm workspace loss from a successful account listing, never from 403/5xx.
export async function probeAccountWebSession(job) {
  const listing = await listAccountWorkspaces(job, { forceWebRefresh: true, refreshOnUnauthorized: false });
  const session = await readAccountWebSession(job);
  const bundle = await readOAuthBundle(job).catch(() => null);
  const savedId = session.web?.workspaceId || bundle?.accountId || listing.currentWorkspaceId;
  const selected = listing.workspaces.find(w => w.id === savedId);
  const available = selected && isAccountWorkspaceAvailable(selected);
  const devices = available ? (await listAccountSessions(job, { refreshOnUnauthorized: false })).devices.map(d => ({
    displayName: d.displayName, platform: d.platform, isCurrentDevice: d.isCurrentDevice,
    lastSignedInTimestamp: d.lastSignedInTimestamp, lastSignedInIp: d.lastSignedInIp,
  })) : undefined;
  const previousPlan = job.workspacePlanType || job.planType;
  const workspaces = listing.workspaces.map(w => ({ id: w.id, name: w.name, structure: w.structure,
    planType: w.planType, current: w.current, canAccess: w.canAccess, deactivated: w.deactivated,
    availabilityReason: w.availabilityReason }));
  return {
    devices, workspaces, currentWorkspaceId: savedId,
    planType: available ? selected.planType : null,
    repairReason: !available ? "workspace_unavailable"
      : previousPlan && selected.planType && previousPlan !== selected.planType ? "plan_changed" : null,
  };
}

export async function switchAccountWorkspace(job, workspaceId) {
  const targetId = normalizeIdentifier(workspaceId);
  if (!targetId) throw new Error("WORKSPACE_TARGET_INVALID: 工作空间 ID 无效");
  const listingResponse = await requestWithWebSession(job, "GET", "/accounts/check/v4-2023-04-27");
  let bundle = null;
  try { await fs.access(job.outputPath); bundle = await readOAuthBundle(job); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const listing = normalizeAccountWorkspaces(listingResponse.data, listingResponse.session.web?.workspaceId);
  const target = listing.workspaces.find((workspace) => workspace.id === targetId);
  if (!target || !isAccountWorkspaceAvailable(target)) {
    throw new Error(`WORKSPACE_TARGET_UNAVAILABLE: ${accountWorkspaceAvailabilityLabel(target)}`);
  }

  const account = Array.isArray(bundle?.data?.accounts) ? bundle.data.accounts[0] : null;
  if (bundle) {
    if (!account || typeof account !== "object") throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 授权文件缺少账号数据");
    const credentials = account.credentials && typeof account.credentials === "object" ? account.credentials : {};
    const extra = account.extra && typeof account.extra === "object" ? account.extra : {};
    credentials.chatgpt_account_id = target.id;
    credentials.account_id = target.id;
    credentials.plan_type = target.planType || null;
    account.credentials = credentials;
    account.account_id = target.id;
    account.extra = {
      ...extra,
      account_id: target.id,
      chatgpt_account_id: target.id,
      workspace_id: target.id,
      workspace_name: target.name,
      workspace_structure: target.structure,
      plan_type: target.planType || null,
    };
    account.plan_type = target.planType || null;
    await writeOAuthBundle(bundle);
  }
  listingResponse.session.web = { ...listingResponse.session.web, workspaceId: target.id };
  await writeAccountWebSession(webSessionPathForJob(job), listingResponse.session);
  return {
    currentWorkspaceId: target.id,
    workspace: target,
    workspaces: listing.workspaces.map((workspace) => ({
      ...workspace,
      current: workspace.id === target.id,
    })),
    planType: target.planType || null,
  };
}

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
  const rawAccounts = Array.isArray(source.accounts) ? source.accounts
    : isRecord(source.accounts) ? Object.entries(source.accounts).map(([id, value]) => ({ ...value, id: value?.id || id })) : [];
  const accounts = rawAccounts.map((entry) => ({ ...entry, ...(isRecord(entry?.account) ? entry.account : {}),
    id: entry?.account?.account_id || entry?.account?.id || entry?.account_id || entry?.id }));
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
  const rawCanAccess = account.can_access_with_session !== false;
  const rawDeactivated = account.is_deactivated === true;
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
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (text && text.length <= MAX_USAGE_TEXT_LENGTH) return text;
  }
  return null;
}

function isWorkspaceHttpStatus(...values) {
  const expected = values.pop();
  return values.some((value) => Number(value) === expected);
}

function workspaceAvailabilityLabel(reason, code) {
  const suffix = code ? `（${code}）` : "";
  switch (reason) {
    case "removed": return `已移出空间${suffix}`;
    case "banned": return `空间封禁${suffix || "（402）"}`;
    case "deactivated": return `空间已停用${suffix}`;
    case "inaccessible": return `无权访问${suffix}`;
    case "unknown": return `不可用${suffix}`;
    default: return "";
  }
}

export function normalizeAccountUsage(payload) {
  const source = isRecord(payload) ? payload : {};
  const rateLimit = firstRecord(source.rate_limit, source.rateLimit);
  const usage = firstRecord(source.usage, source.message_cap, source.messageCap);
  const primary = normalizeUsageWindow(
    firstRecord(rateLimit?.primary_window, rateLimit?.primaryWindow, usage?.primary_window, usage?.primaryWindow)
      || (hasUsageWindowFields(rateLimit) ? rateLimit : null)
      || (hasUsageWindowFields(usage) ? usage : null),
  );
  const secondary = normalizeUsageWindow(
    firstRecord(rateLimit?.secondary_window, rateLimit?.secondaryWindow, usage?.secondary_window, usage?.secondaryWindow),
  );
  const creditsSource = firstRecord(source.credits, source.credit_grant, source.creditGrant);
  const planType = normalizeUsageText(
    source.plan_type
      || source.planType
      || source.account?.plan_type
      || source.account?.planType,
  );
  return {
    planType: planType || null,
    allowed: firstBoolean(
      rateLimit?.allowed,
      rateLimit?.is_allowed,
      rateLimit?.isAllowed,
      source.allowed,
    ),
    limitReached: firstBoolean(
      rateLimit?.limit_reached,
      rateLimit?.limitReached,
      rateLimit?.is_quota_exceeded,
      rateLimit?.isQuotaExceeded,
      source.limit_reached,
      source.limitReached,
    ),
    primary,
    secondary,
    credits: normalizeUsageCredits(creditsSource),
  };
}

export async function listAccountSessions(job, { refreshOnUnauthorized = true } = {}) {
  const result = await requestWithWebSession(job, "GET", "/accounts/sessions?include_trusted_devices=true", undefined, { refreshOnUnauthorized });
  return {
    showSessionManager: result.data?.show_session_manager !== false,
    devices: normalizeSessionDevices(result.data),
    fetchedAt: new Date().toISOString(),
  };
}

export async function revokeAccountSession(job, input = {}) {
  const sessionId = normalizeIdentifier(input.sessionId);
  const deviceIdHash = normalizeIdentifier(input.deviceIdHash);
  if ((sessionId && deviceIdHash) || (!sessionId && !deviceIdHash)) {
    throw new Error("SESSION_TARGET_INVALID: 必须提供 sessionId 或 deviceIdHash 其中一个");
  }

  const listed = await listAccountSessions(job);
  const target = listed.devices.find((device) => (
    sessionId ? device.sessionId === sessionId : device.deviceIdHash === deviceIdHash
  ));
  if (!target) throw new Error("SESSION_TARGET_NOT_FOUND: 目标设备或会话已不存在，请刷新后重试");
  if (target.isCurrentDevice) throw new Error("SESSION_CURRENT_DEVICE: 当前设备请使用一键登出后再重新登录");
  if (deviceIdHash && !target.isTrustedDevice) {
    throw new Error("SESSION_TARGET_INVALID: 设备信任标识无效");
  }

  const endpoint = deviceIdHash ? "/accounts/trusted_devices/revoke" : "/accounts/sessions/revoke";
  const body = deviceIdHash ? { device_id_hash: deviceIdHash } : { session_id: sessionId };
  await requestWithWebSession(job, "POST", endpoint, body);
  return { ok: true, target: publicSessionDevice(target) };
}

export async function revokeAllAccountSessions(job) {
  await requestWithWebSession(job, "POST", "/accounts/logout_all", {});
  return { ok: true };
}

export function normalizeSessionDevices(payload) {
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  return devices.slice(0, MAX_DEVICES).map((device, index) => normalizeSessionDevice(device, index)).filter(Boolean);
}

export function normalizeSessionDevice(device, index = 0) {
  if (!device || typeof device !== "object") return null;
  const sessionId = normalizeIdentifier(device.session_id);
  const deviceIdHash = normalizeIdentifier(device.hashed_device_id);
  const renderId = normalizeIdentifier(device.render_id);
  if (!sessionId && !deviceIdHash) return null;
  const appSessions = Array.isArray(device.app_sessions)
    ? device.app_sessions
      .map((item) => String(item?.client_name || "").trim())
      .filter(Boolean)
      .slice(0, 32)
    : [];
  return {
    id: renderId || sessionId || deviceIdHash || `device-${index + 1}`,
    sessionId: sessionId || null,
    deviceIdHash: deviceIdHash || null,
    displayName: publicText(device.display_name, "未知设备"),
    description: publicText(device.human_readable_description, ""),
    platform: publicText(device.platform, ""),
    osVersion: publicText(device.os_version, ""),
    deviceModel: publicText(device.device_model, ""),
    isTrustedDevice: Boolean(device.is_trusted_device),
    isCurrentDevice: Boolean(device.is_current_device),
    canUntrust: Boolean(device.can_untrust),
    lastSignedInTimestamp: normalizeTimestamp(device.last_signed_in_timestamp_second),
    lastSignedInCity: publicText(device.last_signed_in_city, ""),
    lastSignedInRegionCode: publicText(device.last_signed_in_region_code, ""),
    lastSignedInCountry: publicText(device.last_signed_in_country, ""),
    lastSignedInIp: normalizeSessionIp(
      device.last_signed_in_ip_address,
      device.last_signed_in_ip,
      device.lastSignedInIp,
      device.ip_address,
      device.ipAddress,
      device.ip,
    ),
    appSessions,
  };
}

function normalizeSessionIp(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length <= 45 && !text.includes("%") && isIP(text)) return text;
  }
  return null;
}

function publicSessionDevice(device) {
  return {
    id: device.id,
    displayName: device.displayName,
    isTrustedDevice: device.isTrustedDevice,
    isCurrentDevice: device.isCurrentDevice,
  };
}

const webSessionRequests = new Map();

async function requestWithWebSession(job, method, endpoint, jsonBody = undefined, options = {}) {
  const key = webSessionPathForJob(job);
  const previous = webSessionRequests.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => performWebRequest(job, method, endpoint, jsonBody, options));
  webSessionRequests.set(key, pending);
  try { return await pending; }
  finally { if (webSessionRequests.get(key) === pending) webSessionRequests.delete(key); }
}

async function performWebRequest(job, method, endpoint, jsonBody, { forceWebRefresh = false, refreshOnUnauthorized = true } = {}) {
  const session = await readAccountWebSession(job);
  const chatgptBase = String(process.env.CHATGPT_BASE || DEFAULT_CHATGPT_BASE).replace(/\/$/, "");
  const transport = process.env.NODE_ENV !== "production" && process.env.TOSUB2_SESSION_NATIVE_HTTP === "1"
    ? null : new TlsFingerprintTransport({
      enabled: true, profile: session.identity.tlsProfile, pinnedProfile: true,
      maxProxySessionAttempts: process.env.CHATGPT_PROXY_MAX_ATTEMPTS || 10,
      rotateProxySessions: !job?.fixedProxy,
      sameProxyRiskRetryDelayMs: process.env.CHATGPT_SAME_PROXY_RISK_RETRY_DELAY_MS,
    });
  const client = new ProtocolClient({ jar: CookieJar.fromJSON(session.cookies), transport, browserIdentity: session.identity });
  let loggedOut = false;
  const parse = (response) => {
    try { return JSON.parse(response.text); }
    catch {
      if (response.res.ok) throw new Error(`SESSION_PROVIDER_ERROR: HTTP ${response.res.status}: 上游未返回有效 JSON，尚未确认会话失效`);
      return {};
    }
  };
  async function refreshWebToken() {
    session.accessToken = null;
    const response = await client.request("GET", `${chatgptBase}/api/auth/session`, { referer: `${chatgptBase}/`, timeoutMs: REQUEST_TIMEOUT_MS });
    const data = parse(response);
    const email = String(data.user?.email || "").trim().toLowerCase();
    if (email && email !== session.email) throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: Web 会话返回了其他账号，请重新登录");
    const token = data.accessToken || data.access_token;
    if (response.res.status === 401 || (response.res.ok && (typeof token !== "string" || !token))) {
      throw new Error("SESSION_TOKEN_EXPIRED: Web 登录态已失效，请为此账号重新登录");
    }
    if (!response.res.ok) throw providerError(response.res.status, data);
    session.accessToken = token;
    session.expiresAt = data.expires || null;
  }
  async function send() {
    const headers = { authorization: `Bearer ${session.accessToken}`, accept: "application/json",
      "x-requested-with": "XMLHttpRequest", priority: "u=1, i" };
    // Account discovery must still work when the previously selected space died.
    if (session.web?.workspaceId && endpoint !== "/accounts/check/v4-2023-04-27") headers["chatgpt-account-id"] = session.web.workspaceId;
    return client.request(method, `${chatgptBase}/backend-api${endpoint}`, {
      headers, referer: `${chatgptBase}/`, origin: chatgptBase,
      ...(jsonBody === undefined ? {} : { json: jsonBody }), timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }
  try {
    // Use the account's saved transport profile; unsupported profiles must never silently change its browser.
    if (transport) await transport.configure(job?.proxyUrl || null, { force: true });
    if (forceWebRefresh || !session.accessToken || !tokenExpiresAfter(session.accessToken, TOKEN_REFRESH_SKEW_SECONDS)) await refreshWebToken();
    let response = await send();
    if (response.res.status === 401 && refreshOnUnauthorized) { await refreshWebToken(); response = await send(); }
    const data = parse(response);
    if (!response.res.ok) {
      if (response.res.status === 401) throw new Error("SESSION_TOKEN_EXPIRED: Web 登录态已失效，请重新登录 Web");
      throw providerError(response.res.status, data);
    }
    session.validation = { status: "valid", verifiedAt: new Date().toISOString() };
    setWebSessionState(job, "valid", session.validation.verifiedAt);
    loggedOut = method === "POST" && endpoint === "/accounts/logout_all";
    return { data, status: response.res.status, session };
  } catch (error) {
    if (/SESSION_TOKEN_EXPIRED|Web 会话返回了其他账号/.test(error.message)) {
      session.validation = { status: "expired", verifiedAt: session.validation?.verifiedAt || null };
      setWebSessionState(job, "expired", session.validation.verifiedAt);
    }
    throw error;
  } finally {
    session.cookies = client.jar.toJSON();
    try {
      if (loggedOut) { await fs.rm(webSessionPathForJob(job), { force: true }); setWebSessionState(job, "absent"); }
      else await writeAccountWebSession(webSessionPathForJob(job), session);
    }
    finally { if (transport) await transport.close(); }
  }
}

function providerError(status, data) {
  const raw = data?.error?.message || data?.message || data?.error || `HTTP ${status}`;
  const message = String(raw)
    .replace(/[\r\n]+/g, " ")
    .replace(/(bearer\s+|access_token\s*[=:]\s*|refresh_token\s*[=:]\s*)[^\s,}]+/gi, "$1<redacted>")
    .slice(0, 240);
  return new Error(`SESSION_PROVIDER_ERROR: HTTP ${status}: ${message}`);
}

async function readOAuthBundle(job) {
  if (!job?.outputPath) throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 账号没有授权文件");
  let data;
  try {
    data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
  } catch {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 无法读取账号授权文件");
  }
  const account = Array.isArray(data?.accounts) ? data.accounts[0] : null;
  const credentials = account?.credentials;
  if (!credentials || typeof credentials !== "object") {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 授权文件缺少 OAuth 凭据");
  }
  const accessToken = String(credentials.access_token || "").trim();
  const refreshToken = String(credentials.refresh_token || "").trim();
  if (!accessToken && !refreshToken) {
    throw new Error("SESSION_CREDENTIALS_UNAVAILABLE: 授权文件缺少访问令牌");
  }
  return {
    data,
    account,
    credentials,
    accessToken,
    refreshToken,
    clientId: String(account?.extra?.client_id || process.env.TOSUB2_CODEX_CLIENT_ID || DEFAULT_CODEX_CLIENT_ID).trim(),
    accountId: normalizeIdentifier(
      credentials.chatgpt_account_id
        || credentials.account_id
        || account?.chatgpt_account_id
        || account?.account_id
        || account?.extra?.chatgpt_account_id
        || account?.extra?.account_id,
    ),
    chatgptBase: String(process.env.CHATGPT_BASE || DEFAULT_CHATGPT_BASE).replace(/\/$/, ""),
    authBase: String(process.env.AUTH_BASE || DEFAULT_AUTH_BASE).replace(/\/$/, ""),
    outputPath: job.outputPath,
  };
}

async function writeOAuthBundle(bundle) {
  const tempPath = `${bundle.outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(bundle.data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, bundle.outputPath);
}

function tokenExpiresAfter(token, seconds) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return false;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(claims.exp) > Math.floor(Date.now() / 1000) + seconds;
  } catch {
    return false;
  }
}

function normalizeIdentifier(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= MAX_IDENTIFIER_LENGTH ? text : "";
}

function publicText(value, fallback = "") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text.length <= 256 ? text : text.slice(0, 256);
}

function normalizeTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeUsageWindow(source) {
  if (!isRecord(source)) return null;
  const usedPercent = normalizeUsagePercent(
    firstNumber(source.used_percent, source.usedPercent, source.percent, source.percentage),
  );
  const used = normalizeUsageNumber(firstNumber(source.used, source.used_count, source.usedCount));
  const limit = normalizeUsageNumber(firstNumber(source.limit, source.max, source.total));
  const remaining = normalizeUsageNumber(firstNumber(source.remaining, source.remaining_count, source.remainingCount));
  const limitWindowSeconds = normalizeUsageSeconds(
    firstNumber(source.limit_window_seconds, source.limitWindowSeconds, source.window_seconds, source.windowSeconds),
  );
  const resetAfterSeconds = normalizeUsageSeconds(
    firstNumber(source.reset_after_seconds, source.resetAfterSeconds, source.reset_after, source.resetAfter),
  );
  const resetAt = normalizeUsageDate(source.reset_at ?? source.resetAt);
  if ([usedPercent, used, limit, remaining, limitWindowSeconds, resetAfterSeconds, resetAt].every((value) => value === null)) {
    return null;
  }
  return {
    usedPercent,
    used,
    limit,
    remaining,
    limitWindowSeconds,
    resetAfterSeconds,
    resetAt,
  };
}

function normalizeUsageCredits(source) {
  if (!isRecord(source)) return null;
  const balance = source.balance ?? source.remaining ?? source.amount;
  const normalizedBalance = balance === null || balance === undefined
    ? null
    : normalizeUsageText(balance);
  const hasCredits = firstBoolean(source.has_credits, source.hasCredits);
  const unlimited = firstBoolean(source.unlimited, source.is_unlimited, source.isUnlimited);
  const overageLimitReached = firstBoolean(source.overage_limit_reached, source.overageLimitReached);
  if (normalizedBalance === null && hasCredits === null && unlimited === null && overageLimitReached === null) return null;
  return { balance: normalizedBalance, hasCredits, unlimited, overageLimitReached };
}

function hasUsageWindowFields(source) {
  if (!isRecord(source)) return false;
  return [
    "used_percent",
    "usedPercent",
    "percent",
    "used",
    "limit",
    "remaining",
    "reset_at",
    "resetAt",
    "reset_after_seconds",
    "resetAfterSeconds",
  ].some((key) => source[key] !== undefined && source[key] !== null);
}

function firstRecord(...values) {
  return values.find((value) => isRecord(value)) || null;
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (value !== null && value !== undefined && value !== "" && Number.isFinite(number)) return number;
  }
  return null;
}

function normalizeUsageNumber(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function normalizeUsagePercent(value) {
  const number = normalizeUsageNumber(value);
  return number === null ? null : Math.min(100, Math.max(0, number));
}

function normalizeUsageSeconds(value) {
  const number = normalizeUsageNumber(value);
  return number === null || number < 0 || number > MAX_USAGE_WINDOW_SECONDS ? null : number;
}

function normalizeUsageDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number) && number <= 0) return null;
  const date = Number.isFinite(number)
    ? new Date(number > 1_000_000_000_000 ? number : number * 1000)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeUsageText(value) {
  const text = String(value ?? "").trim();
  return text && text.length <= MAX_USAGE_TEXT_LENGTH ? text : text.slice(0, MAX_USAGE_TEXT_LENGTH);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
