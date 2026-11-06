#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createDirectPublicIpReader } from "./direct-public-ip.mjs";
import { createStaticFrontend } from "./static-frontend.mjs";
import { createCredentialStore } from "./credential-store.mjs";
import { readAccountWebSession, webSessionPathForJob, inspectAccountWebSession, publicWebCredentialSync } from "./account-web-session.mjs";
import {
  listAccountSessions,
  revokeAccountSession,
  revokeAllAccountSessions,
  listAccountWorkspaces,
  probeAccountWebSession,
  switchAccountWorkspace,
  accountWorkspaceAvailabilityLabel,
  isAccountWorkspaceAvailable,
} from "./account-sessions.mjs";
import {
  fetchMailboxOtpCandidates,
  filterMailboxOtpCandidatesByRequestTime,
  validateMailApiUrl,
} from "./mail-otp.mjs";
import { createSmsProvider, publicSmsProviderDefinitions } from "./sms-providers.mjs";
import { hasJobTotpKey, isReauthorizationComplete, isTotpRotationComplete } from "./task-auto-state.mjs";
import { normalizeCodexAuthMode } from "./sub2api-oauth.mjs";
import { DirectTlsProfileProbe, proxySupportsSessionRotation } from "./tls-transport.mjs";
import { OverloadMonitor } from "./overload-monitor.mjs";
import { ProxyQualityService } from "./proxy-quality.mjs";
import { normalizeResetCredits } from "./sub2api-reset-credits.mjs";
import { DEFAULT_MONITORING, normalizeMonitoring } from "../web/src/monitor-settings.mjs";
import { limitPoolRequests } from "./pool-network.mjs";
import { createUsageTotalsReader, combineUsageTotals } from "./sub2api-usage-totals.mjs";
import { OverloadCooldown, DEFAULT_OVERLOAD_COOLDOWN, normalizeOverloadCooldown } from "./overload-cooldown.mjs";
import { ModelFingerprintService, normalizeFingerprintSettings } from "./model-fingerprint.mjs";
import { createFingerprintSampler, createFingerprintAccountReader } from "./model-fingerprint-request.mjs";
import { WebSessionMonitor, normalizeWebSessionMonitor, DEFAULT_WEB_SESSION_MONITOR } from "./web-session-monitor.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4399;
const DEFAULT_MAX_ACTIVE_JOBS = 4;
const MAX_ACTIVE_JOBS_LIMIT = 20;
const DEFAULT_TLS_PROFILE = "chrome146";
const MAX_BATCH_JOBS = 500;
const TASK_AUTO_PIPELINE_TIMEOUT_MS = 15 * 60_000;
const TASK_AUTO_POLL_INTERVAL_MS = 900;
const MAX_ACCOUNT_PROXY_COOLDOWN_MINUTES = 43_200;
const TASK_AUTO_ACTIONS = new Set(["upload", "rotate-logout-reauthorize-upload", "enable-overload-detection", "enable-overload-cooldown"]);
const TASK_AUTO_ACTION_LABELS = {
  upload: "上传到 Sub2API",
  "rotate-logout-reauthorize-upload": "一键轮换并上传",
  "enable-overload-detection": "自动开启过载检测",
  "enable-overload-cooldown": "自动开启过载冷却",
};
const MAX_PROXY_RISK_RETRIES = 10;
const MAX_PROXY_CONNECTION_FAILURES = 20;
const PROXY_CONNECTION_RETRY_BASE_MS = Math.max(1, Number(process.env.PROXY_CONNECTION_RETRY_BASE_MS || 1_000));
const PROXY_CONNECTION_RETRY_MAX_MS = 15_000;
const PAGE_SIZE = 20;
const MAX_LOG_CHARS = 80_000;
const JOB_STATUS_FILTER_VALUES = [
  "queued",
  "starting",
  "working",
  "password",
  "mfa_otp",
  "totp_starting",
  "password_add_starting",
  "totp_setup_otp",
  "email_otp",
  "phone",
  "phone_otp",
  "finalizing",
  "refreshing",
  "completed",
  "failed",
  "mfa_failed",
  "banned",
  "canceled",
  "reauth_required",
  "resume_available",
];
const SUB2API_ACCOUNT_STATUS_CACHE_TTL_MS = readDurationEnv("SUB2API_ACCOUNT_STATUS_CACHE_TTL_MS", 15_000, 1_000);
const JOB_META_FILENAME = "job-meta.json";
const LOGIN_CHECKPOINT_FILENAME = "login-checkpoint.json";
const TOTP_SETUP_RESULT_FILENAME = "totp-setup-result.json";
const PASSWORD_ADD_RESULT_FILENAME = "password-add-result.json";
const SUB2API_SETTINGS_FILENAME = "sub2api-settings.json";
const SUB2API_MONITOR_FILENAME = "sub2api-monitor.json";
const PLAN_TYPE_MAPPING_FILENAME = "plan-type-mapping.json";
const TASK_SETTINGS_FILENAME = "task-settings.json";
const SUB2API_WS_MODES = new Set(["off", "ctx_pool", "passthrough", "http_bridge"]);
// Profile proxy value meaning "explicitly no proxy".
const SUB2API_PROXY_DIRECT = "direct";
const SUB2API_PROXY_BALANCED = "balanced";
const SUB2API_PROFILE_FIELDS = [
  "groupIds",
  "proxyId",
  "concurrency",
  "loadFactor",
  "priority",
  "importDatePriority",
  "accountNameTemplate",
  "modelWhitelist",
  "codexFingerprintMode",
  "autoResetCreditEnabled",
  "autoResetCredit5hThresholdPercent",
  "autoResetCredit7dThresholdPercent",
  "wsMode",
];
const SUB2API_TARGET_GROUP_PLATFORMS = ["openai", "composite"];
const SUB2API_ACCOUNT_NAME_TEMPLATE_KEYS = new Set([
  "email",
  "planType",
  "planType_disp",
  "plan_type",
  "accountId",
  "account_id",
  "id",
  "name",
]);
const SUB2API_MONITOR_INTERVAL_MS = readDurationEnv("SUB2API_MONITOR_INTERVAL_MS", 5 * 60_000, 1_000);
const SUB2API_AUTO_REPAIR_COOLDOWN_MS = readDurationEnv("SUB2API_AUTO_REPAIR_COOLDOWN_MS", 5 * 60_000, 0);
const monitoringDefaults = {
  ...DEFAULT_MONITORING,
  accountStatusIntervalSeconds: SUB2API_ACCOUNT_STATUS_CACHE_TTL_MS / 1000,
  poolMonitorIntervalSeconds: SUB2API_MONITOR_INTERVAL_MS / 1000,
  poolRepairRetrySeconds: SUB2API_AUTO_REPAIR_COOLDOWN_MS / 1000,
};
let monitoringSettings = { ...monitoringDefaults };
const requestProfileSync = limitPoolRequests(requestSub2Api, () => monitoringSettings.profileSyncConcurrency);
let accountDataSyncTimers = [], accountDataSyncGeneration = 0;
const accountDataSyncOperations = new Set();
const MAIL_POLL_INTERVAL_MS = 2_500;
const MAIL_POLL_TIMEOUT_MS = 10 * 60_000;
const MAX_MAIL_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_MAIL_REQUEST_HEADERS = 64;
const FORBIDDEN_MAIL_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SMS_POLL_INTERVAL_MS = Number(process.env.SMS_POLL_INTERVAL_MS || process.env.LUBAN_SMS_POLL_INTERVAL_MS || 3_000);
const SMS_POLL_TIMEOUT_MS = Number(process.env.SMS_POLL_TIMEOUT_MS || process.env.LUBAN_SMS_POLL_TIMEOUT_MS || 10 * 60_000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(TOOL_ROOT, "web");
const PROTOCOL_SCRIPT = path.resolve(process.env.ONBOARDING_PROTOCOL_SCRIPT || path.join(__dirname, "protocol-login.mjs"));
const WORKSPACE_ROOT = TOOL_ROOT;
const OUTPUT_ROOT = path.resolve(
  process.env.ONBOARDING_OUTPUT_ROOT || path.join(WORKSPACE_ROOT, "tmp", "chatgpt-onboarding-console"),
);
const SUB2API_MONITOR_PATH = path.join(OUTPUT_ROOT, SUB2API_MONITOR_FILENAME);
const SUB2API_SETTINGS_PATH = path.join(OUTPUT_ROOT, SUB2API_SETTINGS_FILENAME);
const PLAN_TYPE_MAPPING_PATH = path.join(OUTPUT_ROOT, PLAN_TYPE_MAPPING_FILENAME);
const TASK_SETTINGS_PATH = path.join(OUTPUT_ROOT, TASK_SETTINGS_FILENAME);
const credentialStore = createCredentialStore();
const proxyQualityService = new ProxyQualityService({
  exitUrl: process.env.TOSUB2_PROXY_EXIT_CHECK_URL,
  chatgptUrl: process.env.NODE_ENV === "test" ? process.env.TOSUB2_PROXY_CHATGPT_CHECK_URL : undefined,
  profile: process.env.TOSUB2_TLS_PROFILE || DEFAULT_TLS_PROFILE,
  timeoutMs: process.env.NODE_ENV === "test" ? process.env.TOSUB2_PROXY_CHECK_TIMEOUT_MS : undefined,
});
const consoleToken = crypto.randomBytes(24).toString("base64url");
const jobs = new Map();
const automationBlockWrites = new Map();
const automationBlockRunning = new Set();
const customSmsPoolPositions = new Map();
const emailJobLocks = new Map();
let outputSyncPromise = null;
let lastOutputSyncAt = 0;
let shuttingDown = false;
let queueSchedulingPaused = false;
let maxActiveJobs = initialMaxActiveJobs();
let activeWebSessionChecks = 0;
let taskAutoActions = Object.create(null);
let globalProxyUrl = null;
let allowDirectFallback = false;
let accountProxyMode = "global";
let codexAuthMode = "local";
let accountProxyCooldownMinutes = 60;
let overloadAutoCooldownSettings = { ...DEFAULT_OVERLOAD_COOLDOWN };
let taskSettingsWritePromise = Promise.resolve();
let accountProxyAssignmentPromise = Promise.resolve();
const accountProxyReservations = new Map();
const poolRefreshTimers = new Map();
const poolRefreshOperations = new Set();
const manualWebSessionChecks = new Map();
const manualWebSessionCheckOperations = new Set();
let drainingWebSessionChecks = false;
let shutdownPromise = null;
let sub2ApiSettingsConfig = null;
let sub2ApiMonitorConfig = null;
// Upload profiles share the global Sub2API connection and monitor switch.
// The selected profile only carries account-pool/upload behavior.
let sub2ApiProfiles = new Map();
let sub2ApiPlanTypeBindings = {};
let sub2ApiActiveProfileId = "default";
let planTypeLabelMapping = {};
let planTypeLabelMappingConfigured = false;
let sub2ApiMonitorTimer = null;
let sub2ApiMonitorPromise = null;
let sub2ApiAccountStatusPromise = null;
const readUsageTotals = createUsageTotalsReader({
  getSettings: () => ({ ttlMs: monitoringSettings.usageTotalsIntervalSeconds * 1000, concurrency: monitoringSettings.usageTotalsConcurrency }),
  isBlocked: id => [...sub2ApiAccountStatusCache.accounts].some(([email, account]) => account.accountIds?.map(String).includes(String(id)) && accountAutomationBlocked(email)),
  request: (...args) => shuttingDown
  ? Promise.reject(new Error("Service is shutting down")) : requestSub2Api(...args) });
let sub2ApiAccountStatusCache = {
  backend: null,
  fetchedAt: null,
  accounts: new Map(),
};
let publicProxyCatalog = { backend: null, proxies: new Map() };
let mailRequestConfig = { method: "GET", url: null, headers: {} };
const sub2ApiRequestControllers = new Set();
const sub2ApiRequestPromises = new Set();
const sub2ApiAutoRepairPromises = new Set();
const directTlsProfileProbe = new DirectTlsProfileProbe({
  explicitProfile: process.env.TOSUB2_TLS_PROFILE,
  validationUrl: `${String(process.env.CHATGPT_BASE || "https://chatgpt.com").replace(/\/$/, "")}/`,
});
const directPublicIp = createDirectPublicIpReader();

const sub2ApiMonitorState = {
  running: false,
  lastCheckAt: null,
  nextCheckAt: null,
  lastError: null,
  lastResult: null,
  planTypes: Object.create(null),
  planTypesBackend: null,
};

const importDayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

let webSessionMonitorSettings = { ...DEFAULT_WEB_SESSION_MONITOR };
const webSessionMonitor = new WebSessionMonitor({
  filePath: path.join(OUTPUT_ROOT, "web-session-monitor.json"),
  getSettings: () => webSessionMonitorSettings,
  listJobs: async () => {
    // Resolve pool bans before missing-session recovery can enqueue a login at startup.
    await loadSub2ApiAccountStatus();
    return listUniqueJobs();
  },
  isBusy: job => shuttingDown || !canLoginWeb(job, { maintenance: true }) || accountAutomationBlocked(job.email) || job.status === "canceled" || Boolean(job.webSessionMaintenancePause),
  hasSession: async job => {
    try { await fs.access(webSessionPathForJob(job)); return true; }
    catch (error) { return error.code !== "ENOENT"; } // Permissions/I/O errors must reach the probe, not trigger a login.
  },
  restoreMissingSession: job => !job.webSessionMaintenancePause && ((job.resultSaved && !job.poolOnly) || Boolean(job.webLoginCompletedAt)),
  withSlot: withWebSessionCheckSlot,
  probe: async job => {
    let snapshot;
    try { snapshot = await probeAccountWebSession(job); }
    catch (error) {
      if (isPermanentAccountFailure(error.message)) {
        markAutoRepairBlocked(job, error.message);
        await automationBlockWrites.get(job.email.toLowerCase());
      }
      throw error;
    }
    await reconcilePlanAutomations(job, snapshot.planType);
    if (!job.resultSaved && snapshot.planType) {
      job.workspacePlanType = snapshot.planType;
      if (snapshot.repairReason === "plan_changed") snapshot.repairReason = null;
      await saveJobMetadata(job);
    }
    if (job.resultSaved && !snapshot.repairReason && accountProxyMode === "plan" && snapshot.planType) {
      const target = jobSub2ApiProxyConfig(job, snapshot.planType)?.proxyId;
      const fixedId = normalizeStoredProxyId(target);
      if ((target === SUB2API_PROXY_DIRECT && (job.assignedProxyId || job.proxyUrl))
        || (fixedId && fixedId !== normalizeStoredProxyId(job.assignedProxyId))
        || (target === SUB2API_PROXY_BALANCED && !normalizeStoredProxyId(job.assignedProxyId))) snapshot.repairReason = "binding_changed";
    }
    if (job.resultSaved && !snapshot.repairReason && job.poolRefreshAction && !job.poolRefreshReady && job.poolRefreshError) {
      snapshot.repairReason = "authorization_pending";
    }
    return snapshot;
  },
  lock: (job, fn) => withEmailJobLock(job.email, fn),
  repair: async (job, { reason }) => {
    const webOnly = !job.resultSaved || ["expired", "web_workspace_unavailable", "missing"].includes(reason);
    if (webOnly) {
      job.webSessionMonitorRepair = true;
      await startWebLogin(job, { maintenance: true });
    } else await forceReloginJob(job, {}, { webSessionMonitorRepair: true, poolRefreshAction: "relogin" });
    appendJobLog(job, webOnly ? "[web-session-monitor] 先独立恢复 Web 登录态；恢复后复查空间与绑定，保留现有 Codex 凭据。\n"
      : "[web-session-monitor] 已确认 Web 会话或空间/PlanType 变化，进入共享登录队列；完成后更新授权与号池绑定。\n");
    await saveJobMetadata(job);
    return true;
  },
});

const overloadMonitor = new OverloadMonitor({
  getMonitoringSettings: () => ({ intervalMs: monitoringSettings.overloadIntervalSeconds * 1000, concurrency: monitoringSettings.overloadConcurrency }),
  isBlocked: accountAutomationBlocked,
  filePath: path.join(OUTPUT_ROOT, "overload-monitor.json"),
  getConfig: () => sub2ApiSettingsConfig || sub2ApiMonitorConfig,
  backendIdentity: monitorBackendIdentity,
  request: requestSub2Api,
  listAccounts: async (config) => {
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw new Error("Sub2API 账号列表不完整，过载统计未完成");
    const mapping = new Map();
    for (const account of listing.accounts) {
      const email = sub2ApiAccountEmail(account);
      const id = normalizeSub2ApiAccountId(account.id);
      if (!email || !id || (account.platform && account.platform !== "openai")) continue;
      mapping.set(email, [...new Set([...(mapping.get(email) || []), id])]);
    }
    return mapping;
  },
});

const overloadCooldown = new OverloadCooldown({
  getMonitoringSettings: () => ({ intervalMs: monitoringSettings.overloadCooldownIntervalSeconds * 1000, concurrency: monitoringSettings.overloadCooldownConcurrency }),
  isBlocked: accountAutomationBlocked,
  filePath: path.join(OUTPUT_ROOT, "overload-cooldown.json"),
  getConfig: () => sub2ApiSettingsConfig || sub2ApiMonitorConfig,
  backendIdentity: monitorBackendIdentity,
  getSettings: () => overloadAutoCooldownSettings,
  request: requestSub2Api,
  onChange: invalidateSub2ApiAccountStatusCache,
  listAccounts: async config => {
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw new Error("Sub2API 账号列表不完整，自动冷却检查未完成");
    const mapping = new Map();
    for (const account of listing.accounts) {
      const email = sub2ApiAccountEmail(account);
      const id = normalizeSub2ApiAccountId(account.id);
      if (!email || !id || (account.platform && account.platform !== "openai")) continue;
      mapping.set(email, [...(mapping.get(email) || []), { id, enabled: sub2ApiAccountSchedulable(account) }]);
    }
    return mapping;
  },
});

const fingerprintAccountReader = createFingerprintAccountReader(requestSub2Api);
async function readFingerprintAccount(config, id) {
  const account = await fingerprintAccountReader(config, id);
  return { ...account, group_ids: sub2ApiAccountGroupIds(account) };
}
const fingerprintSampler = createFingerprintSampler({ getAccount: readFingerprintAccount, getProxies: listSub2ApiProxies,
  testUrl: process.env.NODE_ENV === "test" ? process.env.TOSUB2_FINGERPRINT_TEST_URL : undefined });
const modelFingerprint = new ModelFingerprintService({
  isBlocked: accountAutomationBlocked,
  filePath: path.join(OUTPUT_ROOT, "model-fingerprint.json"),
  getContext: () => ({ config: sub2ApiSettingsConfig, backend: sub2ApiSettingsConfig ? monitorBackendIdentity(sub2ApiSettingsConfig) : null,
    profiles: [...sub2ApiProfiles.values()].map(p => ({ id: p.id, name: p.name, groupIds: p.groupIds || [], planTypes: Object.keys(sub2ApiPlanTypeBindings).filter(t => sub2ApiPlanTypeBindings[t] === p.id) })),
    routing: JSON.stringify({ bindings: sub2ApiPlanTypeBindings, profiles: [...sub2ApiProfiles.values()].map(p => [p.id, p.groupIds]) }),
    jobs: listUniqueJobs().filter(j => !j.deleted && !isActive(j.status)).map(j => ({ email: j.email, planType: getJobPlanType(j) || "unknown" })) }),
  listTargets: async config => {
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw new Error("Sub2API 账号列表不完整");
    return listing.accounts.filter(a => a.platform === "openai" && sub2ApiAccountEmail(a)).map(a => ({ id: a.id, email: sub2ApiAccountEmail(a), profileId: resolveSub2ApiConfigForAccount(config, a).profileId }));
  },
  getAccount: readFingerprintAccount, sample: fingerprintSampler,
  onAccountFailure: recoverFingerprintAuthorization,
  updateGroups: async (config, id, ids) => requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ group_ids: ids.map(Number) }) }),
  onChange: invalidateSub2ApiAccountStatusCache,
});
async function recoverFingerprintAuthorization(email, failure) {
  return withEmailJobLock(email, async () => {
    const job = findJobByEmail(email);
    if (!job || shuttingDown || accountAutomationBlocked(email)) return;
    if (failure.code === "BANNED") {
      markAutoRepairBlocked(job, failure.upstreamCode || "account_deactivated");
      await automationBlockWrites.get(email.toLowerCase());
      return;
    }
    if (isActive(job.status) || job.autoRepairOperation || job.poolRefreshAction || job.webSessionMaintenancePause || isAutoRepairCoolingDown(job)) return;
    await reloadMissingJobCredentials(job);
    if (!getAutoRepairEligibility(job).eligible) {
      appendJobLog(job, "[fingerprint] 授权失效，但自动登录资料不完整，等待人工处理。\n");
      return;
    }
    const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw new Error("号池列表不完整，等待重试授权修复");
    await reconcileSub2ApiAccountBans(config, listing.accounts);
    if (accountAutomationBlocked(email)) return;
    const accounts = listing.accounts.filter(a => sub2ApiAccountEmail(a) === email && a.platform === "openai" && a.type === "oauth");
    if (!accounts.length) return;
    const operation = createSub2ApiAutoRepairOperation(config, accounts, snapshotSub2ApiProfileState());
    await forceReloginJob(job, {}, { autoRepair: operation, webSessionMonitorRepair: true });
    appendJobLog(job, "[fingerprint] 检测凭据已失效，已加入共享授权修复队列；先验证 Web，再恢复 OAuth。\n");
    await saveJobMetadata(job);
  });
}
function fingerprintGroupIds(config, account, groups, currentAccount = null) {
  return modelFingerprint.filterGroups(sub2ApiAccountEmail(account), extractPlanTypeFromAccount(account, { preferJwt: false }) || "unknown", config.profileId || "default", groups, currentAccount);
}

const hostArg = process.argv.find((item) => item.startsWith("--host="));
const hostIndex = process.argv.indexOf("--host");
const requestedHost = String(
  hostArg?.slice("--host=".length)
    || (hostIndex >= 0 ? process.argv[hostIndex + 1] : "")
    || process.env.ONBOARDING_HOST
    || DEFAULT_HOST,
).trim();
const portArg = process.argv.find((item) => item.startsWith("--port="));
const portIndex = process.argv.indexOf("--port");
const requestedPort = Number(
  portArg?.slice("--port=".length) || (portIndex >= 0 ? process.argv[portIndex + 1] : "") || DEFAULT_PORT,
);
const hmrPort = requestedPort <= 45_535 ? requestedPort + 20_000 : requestedPort - 20_000;

if (!requestedHost || requestedHost.startsWith("--")) {
  throw new Error("--host must be a valid hostname or IP address");
}

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  throw new Error("--port must be an integer between 1 and 65535");
}

await fs.mkdir(OUTPUT_ROOT, { recursive: true });
await loadTaskSettings();
await loadPlanTypeLabelMapping();
await loadSub2ApiSettingsConfiguration();
await loadSub2ApiMonitorConfiguration();
await overloadMonitor.load();
await overloadCooldown.load();
await modelFingerprint.load();
await syncCompletedOutputs(true);
await webSessionMonitor.load();
// Migrate both existing bans and Web-only failures before starting any timers.
for (const job of jobs.values()) {
  const failure = [job.lastError, job.webLoginError].find(isPermanentAccountFailure);
  if (job.status === "banned" || job.autoRepairBlocked || failure) {
    markAutoRepairBlocked(job, failure || job.autoRepairBlockedReason);
    await automationBlockWrites.get(job.email.toLowerCase());
  }
}
for (const job of jobs.values()) {
  if (job.poolRefreshAction) {
    schedulePoolRefresh(job, job.poolRefreshAction === "cooldown" && job.poolRefreshDueAt
      ? Math.max(0, Date.parse(job.poolRefreshDueAt) - Date.now())
      : 0);
  }
}
resumePendingTaskAutoActions();
scheduleQueuedJobs();
scheduleSub2ApiMonitor();
overloadMonitor.start();
overloadCooldown.start();
modelFingerprint.setTickMs(monitoringSettings.fingerprintScanIntervalSeconds * 1000);
modelFingerprint.start();
webSessionMonitor.setTickMs(monitoringSettings.webSessionScanIntervalSeconds * 1000);
webSessionMonitor.start();
scheduleAccountDataSync();

const production = process.env.NODE_ENV === "production";
const vite = production ? null : await (async () => {
  const [{ createServer }, { default: react }] = await Promise.all([import("vite"), import("@vitejs/plugin-react")]);
  return createServer({
  root: WEB_ROOT,
  configFile: false,
  cacheDir: path.join(OUTPUT_ROOT, ".vite"),
  appType: "spa",
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { port: hmrPort, clientPort: hmrPort },
  },
});
})();
const staticFrontend = production ? await createStaticFrontend(path.join(WEB_ROOT, "dist")) : null;

const server = http.createServer(async (req, res) => {
  try {
    enforceUtf8ContentType(res);
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${requestedHost}:${requestedPort}`}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, requestUrl);
      return;
    }
    if (staticFrontend) { await staticFrontend(req, res); return; }
    vite.middlewares(req, res, (error) => {
      if (error) sendJson(res, 500, { error: error.message || "Page rendering failed" });
    });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Internal server error" });
  }
});

function enforceUtf8ContentType(res) {
  const setHeader = res.setHeader;
  res.setHeader = function setUtf8Header(name, value) {
    if (String(name).toLowerCase() === "content-type") {
      value = addUtf8Charset(value);
    }
    return setHeader.call(this, name, value);
  };
}

function addUtf8Charset(value) {
  if (typeof value !== "string" || /;\s*charset=/i.test(value)) return value;
  if (/^(?:text\/(?:html|css|javascript|plain)|application\/(?:javascript|json))(?:\s*;|$)/i.test(value)) {
    return `${value}; charset=utf-8`;
  }
  return value;
}

server.listen(requestedPort, requestedHost, () => {
  const urls = getConsoleUrls(requestedHost, requestedPort);
  console.log(`[ok] ChatGPT onboarding console: ${urls[0]}`);
  for (const url of urls.slice(1)) console.log(`[ok] LAN access: ${url}`);
  console.log(`[info] Output directory: ${OUTPUT_ROOT}`);
  if (isWildcardHost(requestedHost)) {
    console.log("[note] LAN access is enabled without authentication. Keep downloaded OAuth files private.");
  } else {
    console.log("[note] This server only listens on the configured host. Keep downloaded OAuth files private.");
  }
});

function isWildcardHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function getConsoleUrls(host, port) {
  if (!isWildcardHost(host)) return [`http://${host}:${port}`];
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries || [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  return [
    `http://127.0.0.1:${port}`,
    ...[...new Set(addresses)].map((address) => `http://${address}:${port}`),
  ];
}

async function handleApi(req, res, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
    sendJson(res, 200, {
      token: consoleToken,
      taskSettings: publicTaskSettings(false),
      features: {
        retry: true,
        regenerate: true,
        phoneContext: true,
        batchDownload: true,
        bulkActions: true,
        pagination: true,
        uniqueEmail: true,
        smsProviders: publicSmsProviderDefinitions(),
        queue: true,
        taskSettings: true,
        sourceExport: true,
        cancelAll: true,
        sub2apiUpload: true,
        sub2apiPipeline: true,
        sub2apiMonitor: true,
        tlsFingerprint: true,
        totpSetup: true,
        credentialDetails: true,
        totpReplace: true,
        passwordAdd: true,
        forceRelogin: true,
        webLogin: true,
        accountSessions: true,
        accountWorkspaces: true,
        accountUsage: true,
        sub2apiAccountStatus: true,
        sub2apiAccountToggle: true,
        sub2apiAccountPriority: true,
        accountRemarks: true,
        overloadDetection: true,
        proxyQuality: true,
        overloadAutoCooldown: true,
        modelFingerprint: true,
      },
    });
    return;
  }

  if (req.headers["x-console-token"] !== consoleToken) {
    sendJson(res, 403, { error: "Invalid console token" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/task-settings") {
    sendJson(res, 200, { settings: publicTaskSettings() });
    return;
  }

  if (requestUrl.pathname === "/api/model-fingerprint/settings") {
    if (req.method === "POST") {
      const body = await readJson(req);
      await modelFingerprint.saveSettings(body.settings || body);
    } else if (req.method !== "GET") throw httpError(405, "Method not allowed");
    let groups = [];
    if (sub2ApiSettingsConfig?.baseUrl && sub2ApiSettingsConfig?.adminApiKey) {
      try { groups = (await listSub2ApiTargetGroups(sub2ApiSettingsConfig)).map(g => ({ id: String(g.id), name: String(g.name || g.id) })); } catch {}
    }
    sendJson(res, 200, { ...modelFingerprint.publicSettings(), groups }); return;
  }
  if (req.method === "GET" && requestUrl.pathname === "/api/model-fingerprint/reference") {
    sendJson(res, 200, await modelFingerprint.referenceInfo()); return;
  }
  const fingerprintHistoryMatch = /^\/api\/jobs\/([a-f0-9-]+)\/model-fingerprint\/history$/.exec(requestUrl.pathname);
  if (fingerprintHistoryMatch && req.method === "GET") {
    const job = jobs.get(fingerprintHistoryMatch[1]);
    if (!job || job.deleted) throw httpError(404, "账号不存在");
    sendJson(res, 200, modelFingerprint.history(job.email, getJobPlanType(job) || "unknown")); return;
  }
  const fingerprintMatch = /^\/api\/jobs\/([a-f0-9-]+)\/model-fingerprint(?:\/(check))?$/.exec(requestUrl.pathname);
  if (fingerprintMatch && req.method === "POST") {
    const job = jobs.get(fingerprintMatch[1]);
    if (!job || job.deleted) throw httpError(404, "账号不存在");
    const planType = getJobPlanType(job) || "unknown";
    if (fingerprintMatch[2]) {
      if (accountAutomationBlocked(job.email)) throw httpError(409, "账号已确认永久停用，降智检测已停止");
      if (isActive(job.status)) throw httpError(409, "账号任务正在执行，请完成后再检测");
      void modelFingerprint.run(job.email, planType, { manual: true }).catch(() => {});
      sendJson(res, 202, { job: publicJob(job) }); return;
    }
    else {
      const body = await readJson(req);
      if (accountAutomationBlocked(job.email) && body.enabled !== false) throw httpError(409, "账号已确认永久停用，请先手动恢复账号后再启用自动化");
      await modelFingerprint.saveOverride(job.email, body);
    }
    sendJson(res, 200, { job: publicJob(job) }); return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/proxy-quality/check") {
    if (shuttingDown) throw httpError(503, "服务正在关闭");
    const body = await readJson(req);
    let proxyUrl;
    let target;
    if (body.target === "global") {
      proxyUrl = globalProxyUrl;
      target = { type: "global", name: "全局代理" };
    } else if (body.target === "sub2api") {
      const proxyId = normalizeStoredProxyId(body.proxyId);
      if (!proxyId) throw httpError(400, "请选择有效的代理节点");
      const proxy = (await listSub2ApiProxies()).find(item => item.id === proxyId);
      if (!proxy) throw httpError(404, "代理节点不存在，请重新读取代理");
      proxyUrl = proxy.url;
      target = { type: "sub2api", proxyId, name: proxy.name };
    } else throw httpError(400, "请选择全局代理或 Sub2API 代理节点");
    if (!proxyUrl) throw httpError(409, "请先保存有效的代理地址");
    const controller = new AbortController();
    const stop = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", stop);
    try {
      const result = await proxyQualityService.check(proxyUrl, { signal: controller.signal, rotateSession: body.target === "global" });
      if (!res.destroyed) sendJson(res, 200, { target, result });
    } finally { res.off("close", stop); }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/direct-ip") {
    const ip = await directPublicIp.read();
    sendJson(res, 200, { ip: ip || null });
    return;
  }

  if (requestUrl.pathname === "/api/account-proxy-settings") {
    if (req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.proxyUrl !== "string" || typeof body.allowDirectFallback !== "boolean") {
        throw httpError(400, "代理地址必须是字符串，回退开关必须是布尔值");
      }
      const nextMode = Object.hasOwn(body, "mode") ? validateAccountProxyMode(body.mode) : accountProxyMode;
      const modeChange = await prepareAccountProxyModeChange(nextMode);
      await saveTaskSettings({ proxyUrl: body.proxyUrl, allowDirectFallback: body.allowDirectFallback, accountProxyMode: nextMode });
      await applyAccountProxyModeChange(modeChange);
    } else if (req.method !== "GET") {
      throw httpError(405, "Method not allowed");
    }
    sendJson(res, 200, { settings: { proxyUrl: globalProxyUrl || "", allowDirectFallback, mode: accountProxyMode } });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/web-session-monitor") {
    sendJson(res, 200, webSessionMonitor.snapshot());
    return;
  }
  if (req.method === "POST" && requestUrl.pathname === "/api/web-session-monitor/check") {
    await readJson(req);
    if (!webSessionMonitorSettings.enabled) throw httpError(409, "请先启用并保存 WebSession 定时巡检");
    await webSessionMonitor.run({ force: true });
    sendJson(res, 200, webSessionMonitor.snapshot());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/task-settings") {
    const body = await readJson(req);
    const modeChange = Object.hasOwn(body, "accountProxyMode")
      ? await prepareAccountProxyModeChange(validateAccountProxyMode(body.accountProxyMode))
      : null;
    const settings = await saveTaskSettings(body);
    await applyAccountProxyModeChange(modeChange);
    sendJson(res, 200, { settings: publicTaskSettings() });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/jobs") {
    const requestedPage = Math.max(1, Number.parseInt(requestUrl.searchParams.get("page") || "1", 10) || 1);
    await sendJobsPage(res, requestedPage, null, normalizeJobFilters({
      search: requestUrl.searchParams.get("search"),
      lockedOnly: requestUrl.searchParams.get("lockedOnly"),
      accountType: requestUrl.searchParams.get("accountType"),
      status: requestUrl.searchParams.get("status"),
      planType: requestUrl.searchParams.get("planType"),
      sub2apiPool: requestUrl.searchParams.get("sub2apiPool"),
      sub2apiEnabled: requestUrl.searchParams.get("sub2apiEnabled"),
      webSession: requestUrl.searchParams.get("webSession"),
    }));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/query") {
    const body = await readJson(req);
    const requestedPage = Math.max(1, Number.parseInt(body.page || "1", 10) || 1);
    await sendJobsPage(res, requestedPage, normalizeEmailFilter(body.emails), normalizeJobFilters(body));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/mail-request-config") {
    const body = await readJson(req);
    mailRequestConfig = normalizeMailRequestConfig(body.config);
    sendJson(res, 200, {
      config: {
        method: mailRequestConfig.method,
        urlConfigured: Boolean(mailRequestConfig.url),
        headerCount: Object.keys(mailRequestConfig.headers).length,
      },
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs") {
    const body = await readJson(req);
    const email = String(body.email || "").trim();
    if (!isEmail(email)) {
      sendJson(res, 400, { error: "Please enter a valid email address" });
      return;
    }
    const hasCredentialUpdate = ["password", "mailApiUrl", "mailRequestBody", "totpSecret"].some((key) => Object.hasOwn(body, key));
    const credentials = normalizeLoginCredentials(body);
    if (Object.hasOwn(body, "remark")) normalizeAccountRemark(body.remark);
    const hasProxyUpdate = Object.hasOwn(body, "proxyUrl");
    const requestedProxyUrl = hasProxyUpdate && String(body.proxyUrl || "").trim()
      ? normalizeProxyUrl(body.proxyUrl)
      : null;
    const result = await withEmailJobLock(email, async () => {
      const existing = findJobByEmail(email);
      if (existing) {
        if (accountProxyMode === "sub2api" && !existing.assignedProxyId) {
          const assignment = (await assignSub2ApiProxies([{ ...existing }])).get(existing.id);
          if (assignment) {
            existing.assignedProxyId = assignment.id;
            existing.proxyUrl = assignment.url;
            await saveStoredLoginCredentials(existing.email, existing);
            await saveJobMetadata(existing);
          }
        }
        const proxyUrl = effectiveAccountProxyUrl(existing.proxyUrl, globalProxyUrl, requestedProxyUrl);
        if (hasCredentialUpdate) await updateJobCredentials(existing, credentials, { proxyUrl, hasProxyUpdate: true });
        else if (hasProxyUpdate) await updateJobProxy(existing, proxyUrl);
        if (Object.hasOwn(body, "remark")) await updateJobRemark(existing, body.remark);
        return { job: existing, created: false, updated: hasCredentialUpdate || hasProxyUpdate || Object.hasOwn(body, "remark") };
      }
      const assignedProxy = accountProxyMode === "sub2api" ? (await assignSub2ApiProxies([{ email }])).get(email.toLowerCase()) : null;
      const proxyUrl = effectiveAccountProxyUrl(assignedProxy?.url, globalProxyUrl, requestedProxyUrl);
      const job = await startJob(email, { ...credentials, assignedProxyId: assignedProxy?.id, ...(Object.hasOwn(body, "remark") ? { remark: normalizeAccountRemark(body.remark) } : {}) }, proxyUrl);
      if (assignedProxy) await saveJobMetadata(job);
      if (Object.hasOwn(body, "remark")) await synchronizeSub2ApiRemark(job);
      return { job, created: true, updated: false };
    });
    sendJson(res, result.created ? 201 : 200, { ...result, job: publicJob(result.job) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/batch") {
    const body = await readJson(req);
    const entries = parseBatchEntries(body.text, mailRequestConfig);
    const requestedProxyUrl = String(body.proxyUrl || "").trim() ? normalizeProxyUrl(body.proxyUrl) : null;
    const assignmentEntries = entries
      .map((entry) => {
        const existing = findJobByEmail(entry.email);
        return existing ? { ...entry, id: existing.id, assignedProxyId: existing.assignedProxyId } : entry;
      })
      .filter((entry) => !entry.assignedProxyId);
    const assignedProxies = accountProxyMode === "sub2api" ? await assignSub2ApiProxies(assignmentEntries) : new Map();
    const results = await Promise.all(entries.map((entry) => withEmailJobLock(entry.email, async () => {
      const existing = findJobByEmail(entry.email);
      if (existing) {
        const proxyUrl = effectiveAccountProxyUrl(existing.proxyUrl, globalProxyUrl, requestedProxyUrl);
        const assignedProxy = assignedProxies.get(existing.id);
        if (assignedProxy) {
          existing.assignedProxyId = assignedProxy.id;
          existing.proxyUrl = assignedProxy.url;
        }
        await updateJobCredentials(existing, entry, { proxyUrl: assignedProxy?.url || proxyUrl || existing.proxyUrl, hasProxyUpdate: true });
        const sub2api = Object.hasOwn(entry, "remark") ? await updateJobRemark(existing, entry.remark) : null;
        existing.autoTaskEligible = true;
        existing.autoTaskActions = [];
        existing.autoTaskStatus = "idle";
        existing.autoTaskIndex = 0;
        existing.autoTaskError = null;
        await saveJobMetadata(existing);
        if (existing.resultSaved && !isActive(existing.status)) await queueConfiguredTaskActions(existing);
        return { job: existing, updated: true, sub2api };
      }
      const assignedProxy = assignedProxies.get(entry.email.toLowerCase()) || null;
      const proxyUrl = effectiveAccountProxyUrl(assignedProxy?.url, globalProxyUrl, requestedProxyUrl);
      const job = await startJob(entry.email, { ...entry, assignedProxyId: assignedProxy?.id }, proxyUrl);
      const sub2api = Object.hasOwn(entry, "remark") ? await synchronizeSub2ApiRemark(job) : null;
      job.autoTaskEligible = true;
      await saveJobMetadata(job);
      return { job, updated: false, sub2api };
    })));
    sendJson(res, 201, {
      jobs: results.map((item) => publicJob(item.job)),
      created: results.filter((item) => !item.updated).length,
      updated: results.filter((item) => item.updated).length,
      remarkSync: results.reduce((total, item) => ({ updated: total.updated + (item.sub2api?.updated || 0), failed: total.failed + (item.sub2api?.failed || 0), error: total.error || item.sub2api?.error || null }), { updated: 0, failed: 0, error: null }),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/download-batch") {
    const body = await readJson(req);
    await downloadBatchResult(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/export-source") {
    const body = await readJson(req);
    await exportSourceAccounts(res, body.ids);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/delete-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const emails = [...new Set(selected.map((job) => job.email.toLowerCase()))];
    const results = await Promise.all(emails.map((email) => withEmailJobLock(email, () => deleteJobsByEmail(email))));
    const sub2api = results.reduce((summary, result) => {
      summary.configured ||= result.sub2api.configured;
      summary.deleted += result.sub2api.deleted;
      summary.accountIds.push(...result.sub2api.accountIds);
      return summary;
    }, { configured: false, deleted: 0, accountIds: [] });
    sub2api.accountIds = [...new Set(sub2api.accountIds)];
    sendJson(res, 200, { deleted: emails.length, sub2api });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/reauthorize-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const unsupported = selected.find(
      (job) => !["completed", "failed", "mfa_failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    );
    if (unsupported) throw httpError(409, `${unsupported.email} 当前仍在进行中，不能重新授权`);
    await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (job.status === "completed") await regenerateJob(job, body);
      else await retryJob(job, body);
    })));
    sendJson(res, 200, { jobs: selected.map(publicJob), started: selected.length });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/web-session-check-progress") {
    const body = await readJson(req);
    if (!Array.isArray(body.attempts) || body.attempts.length > 10000 || body.attempts.some(p => !p || typeof p.id !== "string" || typeof p.attemptId !== "string")) throw httpError(400, "检测批次无效");
    const progress = body.attempts.map(({ id, attemptId }) => {
      const task = manualWebSessionChecks.get(id), job = jobs.get(id);
      if (!task || task.attemptId !== attemptId || !job || job.deleted) return { id, phase: "failed", error: "检测已被替代或服务已重启，请重新检测" };
      const phase = task.phase === "relogin" ? (job.status === "queued" ? "queued" : ["email_otp", "mfa_otp", "password"].includes(job.status) ? "input" : "running") : task.phase;
      return { id, email: job.email, phase, error: task.error || null, renewed: task.renewed === true };
    });
    sendJson(res, 200, { progress }); return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/web-session-check-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids), started = [], skippedJobs = [];
    for (const job of selected) {
      if (!canLoginWeb(job)) { skippedJobs.push({ id: job.id, email: job.email }); continue; }
      enqueueWebSessionCheck(job);
      started.push(job);
    }
    sendJson(res, 200, { jobs: started.map(publicJob), started: started.length, skipped: skippedJobs.length, skippedJobs, failed: [] });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/web-login-progress") {
    const body = await readJson(req);
    if (!Array.isArray(body.attempts) || body.attempts.length > 10000 || body.attempts.some(p => !p || typeof p.id !== "string" || typeof p.attemptId !== "string")) throw httpError(400, "登录批次无效");
    const progress = body.attempts.map(({ id, attemptId }) => {
      const job = jobs.get(id);
      if (!job || job.deleted) return { id, phase: "failed", error: "账号已删除" };
      if (job.webLoginAttemptId !== attemptId) return { id, email: job.email, phase: "failed", error: "已被后续登录任务替代" };
      const pending = Boolean(job.webLoginPreviousState);
      return { id, email: job.email, phase: pending ? (job.status === "queued" ? "queued" : ["email_otp", "mfa_otp", "password"].includes(job.status) ? "input" : "running")
        : job.webLoginError ? "failed" : "success", error: job.webLoginError || null, prompt: job.prompt };
    });
    sendJson(res, 200, { progress }); return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/web-login-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const outcomes = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canLoginWeb(job)) return { skipped: true, id: job.id, email: job.email };
      try { await startWebLogin(job); return { job }; }
      catch (error) { return { id: job.id, email: job.email, error: String(error.message || error).slice(0, 320) }; }
    })));
    const started = outcomes.filter(item => item.job).map(item => item.job);
    sendJson(res, 200, { jobs: started.map(publicJob), started: started.length,
      skipped: outcomes.filter(item => item.skipped).length, skippedJobs: outcomes.filter(item => item.skipped), failed: outcomes.filter(item => item.error) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/relogin-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canForceRelogin(job)) return null;
      await forceReloginJob(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能重新登录");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/cooldown-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const eligible = selected.filter((job) => canLogoutAllSessions(job) && canForceRelogin(job));
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能冷却");
    const delayMinutes = accountProxyCooldownMinutes;
    const results = await Promise.allSettled(eligible.map((job) => withEmailJobLock(job.email, async () => {
      if (!canLogoutAllSessions(job)) throw httpError(409, "账号状态已变化，请刷新后重试");
      await refreshJobProxyBinding(job);
      await revokeAllAccountSessions(job);
      beginPoolRefresh(job, "cooldown", new Date(Date.now() + delayMinutes * 60_000).toISOString());
      recordJobOperation(job, "cooldown");
      appendJobLog(job, `[cooldown] 已登出全部设备，保持当前代理，${delayMinutes} 分钟后重新登录并同步号池凭据。\n`);
      touch(job);
      await saveJobMetadata(job);
      schedulePoolRefresh(job, delayMinutes * 60_000);
      return job;
    })));
    const started = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    sendJson(res, 200, {
      jobs: started.map(publicJob),
      started: started.length,
      skipped: selected.length - started.length,
      failed: results.filter((result) => result.status === "rejected").map((result) => ({ email: eligible[results.indexOf(result)].email, error: String(result.reason?.message || result.reason).slice(0, 300) })),
      cooldownMinutes: delayMinutes,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/switch-proxy-batch") {
    const selected = resolveSelectedJobs((await readJson(req)).ids);
    if (!["sub2api", "plan"].includes(accountProxyMode)) throw httpError(409, "请先切换并保存 Sub2API 代理模式");
    if (!sub2ApiSettingsConfig?.baseUrl || !sub2ApiSettingsConfig?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
    const eligible = selected.filter((job) => jobCanSwitchProxy(job) && canLogoutAllSessions(job) && canForceRelogin(job));
    if (!eligible.length) throw httpError(409, "所选账号没有可切换项：当前方案需指定直连、固定代理或均衡分配，且账号已有授权、当前未运行任务");
    const results = await Promise.allSettled(eligible.map((job) => withEmailJobLock(job.email, async () => {
      if (!canLogoutAllSessions(job)) throw httpError(409, "账号状态已变化，请刷新后重试");
      const proxy = await resolveManualProxySwitch(job);
      // Use the replacement for logout too, including after a restart without cached proxy credentials.
      try {
        await revokeAllAccountSessions({ ...job, proxyUrl: proxy?.url || null, fixedProxy: true });
      } catch (error) {
        accountProxyReservations.delete(job.email.toLowerCase());
        throw error;
      }
      job.proxyFallbackActive = false;
      await saveJobProxyBinding(job, proxy);
      appendJobLog(job, `[proxy-switch] 已手动应用当前方案：${proxy ? `代理 #${proxy.id}` : "直连（清除原代理绑定）"}；方案配置保持不变。\n`);
      await forceReloginJob(job, { proxyUrl: job.proxyUrl }, { poolRefreshAction: "switch-proxy" });
      await saveJobMetadata(job);
      return job;
    })));
    const started = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    sendJson(res, 200, {
      jobs: started.map(publicJob),
      started: started.length,
      skipped: selected.length - eligible.length,
      failed: results.filter((result) => result.status === "rejected").map((result) => ({ email: eligible[results.indexOf(result)].email, error: String(result.reason?.message || result.reason).slice(0, 300) })),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/setup-2fa-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canSetupTotp(job)) return null;
      await startTotpSetup(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号都不能设置 2FA");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/add-password-batch") {
    const body = await readJson(req);
    const selected = resolveSelectedJobs(body.ids);
    const started = await Promise.all(selected.map((job) => withEmailJobLock(job.email, async () => {
      if (!canAddPassword(job)) return null;
      await startPasswordAdd(job, body);
      return job;
    })));
    const eligible = started.filter(Boolean);
    if (!eligible.length) throw httpError(409, "选中的账号当前都不能添加密码");
    sendJson(res, 200, {
      jobs: eligible.map(publicJob),
      started: eligible.length,
      skipped: selected.length - eligible.length,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs/cancel-all") {
    const canceled = await cancelAllJobs();
    sendJson(res, 200, { canceled });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/groups") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    sendJson(res, 200, {
      groups: await listSub2ApiTargetGroups(config),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/options") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const [groupPayload, proxyPayload] = await Promise.all([
      listSub2ApiTargetGroups(config),
      requestSub2Api(config, "/api/v1/admin/proxies/all"),
    ]);
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    const proxyCounts = new Map();
    const proxiesById = new Map(normalizeSub2ApiProxyList(proxyPayload).map((proxy) => [proxy.id, proxy]));
    publicProxyCatalog = { backend: monitorBackendIdentity(config), proxies: new Map([...proxiesById.values()].map((proxy) => [proxy.id, publicSub2ApiProxy(proxy)])) };
    const countedEmails = new Set();
    let directAccountCount = 0;
    for (const account of listing.accounts) {
      // Filter before email deduplication: an API Key with the same email must
      // not hide an OAuth account or contribute to either IP/direct counts.
      if (account.platform !== "openai" || account.type !== "oauth") continue;
      const email = sub2ApiAccountEmail(account);
      if (accountAutomationBlocked(email) || sub2ApiPermanentAccountFailure(account)) continue;
      if (email && countedEmails.has(email)) continue;
      if (email) countedEmails.add(email);
      const job = ["sub2api", "plan"].includes(accountProxyMode) ? findJobByEmail(email) : null;
      const proxyId = accountProxyMode === "plan" && hasPlanProxyBinding(job)
        ? normalizeStoredProxyId(job.assignedProxyId) : normalizeStoredProxyId(job?.assignedProxyId || account.proxy_id);
      if (!proxyId) directAccountCount += 1;
      const proxy = proxiesById.get(proxyId);
      if (!proxy) continue;
      const ip = proxyIpKey(proxy);
      proxyCounts.set(ip, (proxyCounts.get(ip) || 0) + 1);
    }
    if (["sub2api", "plan"].includes(accountProxyMode)) {
      for (const job of listUniqueJobs()) {
        // A login/canceled task is not an OAuth account until it has saved an
        // authorization result. Pool OAuth records were already counted above.
        if (accountAutomationBlocked(job.email) || !job.resultSaved || countedEmails.has(job.email.toLowerCase())) continue;
        if (!normalizeStoredProxyId(job.assignedProxyId)) directAccountCount += 1;
        const proxy = proxiesById.get(normalizeStoredProxyId(job.assignedProxyId));
        if (!proxy) continue;
        const ip = proxyIpKey(proxy);
        proxyCounts.set(ip, (proxyCounts.get(ip) || 0) + 1);
      }
    }
    sendJson(res, 200, {
      groups: groupPayload,
      proxies: [...proxiesById.values()].map((proxy) => ({ ...publicSub2ApiProxy(proxy), accountCount: proxyCounts.get(proxyIpKey(proxy)) || 0 })),
      directAccountCount,
      directIp: directPublicIp.peek(),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/upload") {
    const body = await readJson(req);
    const config = normalizeSub2ApiConfig(body.config);
    const requestProfileState = normalizeSub2ApiProfileState(body.config, config);
    const selected = resolveSelectedJobs(body.ids);
    sendJson(res, 200, await uploadJobsToSub2Api(selected, config, requestProfileState));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/account-status") {
    const forceRefresh = requestUrl.searchParams.get("refresh") === "1";
    const state = await loadSub2ApiAccountStatus({ forceRefresh });
    sendJson(res, 200, publicSub2ApiAccountStatusState(state));
    return;
  }

  const autoCooldownMatch = /^\/api\/jobs\/([a-f0-9-]+)\/overload-auto-cooldown$/.exec(requestUrl.pathname);
  if (req.method === "POST" && autoCooldownMatch) {
    const job = jobs.get(autoCooldownMatch[1]);
    if (!job) throw httpError(404, "Login flow not found");
    const body = await readJson(req);
    if (typeof body.enabled !== "boolean") throw httpError(400, "自动冷却状态必须是布尔值");
    if (body.enabled && accountAutomationBlocked(job.email)) throw httpError(409, "账号已确认永久停用，自动冷却已关闭");
    if (body.enabled && !overloadCooldown.snapshot(job.email).configured) throw httpError(409, "请先配置 Sub2API 后端地址和管理员 API Key");
    await overloadCooldown.setEnabled(job.email, body.enabled);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  const overloadMatch = /^\/api\/jobs\/([a-f0-9-]+)\/overload-detection$/.exec(requestUrl.pathname);
  if (req.method === "POST" && overloadMatch) {
    const job = jobs.get(overloadMatch[1]);
    if (!job) throw httpError(404, "Login flow not found");
    const body = await readJson(req);
    if (typeof body.enabled !== "boolean") throw httpError(400, "检测状态必须是布尔值");
    if (body.enabled && accountAutomationBlocked(job.email)) throw httpError(409, "账号已确认永久停用，过载检测已关闭");
    if (body.enabled && !overloadMonitor.snapshot(job.email).configured) {
      throw httpError(409, "请先配置 Sub2API 后端地址和管理员 API Key");
    }
    await withEmailJobLock(job.email, () => overloadMonitor.setEnabled(job.email, body.enabled));
    if (body.enabled) overloadMonitor.trigger();
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  const remarkMatch = /^\/api\/jobs\/([a-f0-9-]+)\/remark$/.exec(requestUrl.pathname);
  if ((req.method === "POST" || req.method === "PUT") && remarkMatch) {
    const body = await readJson(req);
    const job = jobs.get(remarkMatch[1]);
    if (!job) throw httpError(404, "Login flow not found");
    if (!Object.hasOwn(body, "remark")) throw httpError(400, "请提供备注内容");
    const sub2api = await withEmailJobLock(job.email, () => updateJobRemark(job, body.remark));
    sendJson(res, 200, { job: publicJob(job), sub2api });
    return;
  }

  const sub2ApiSchedulableMatch = /^\/api\/sub2api\/accounts\/([a-f0-9-]+)\/schedulable$/.exec(requestUrl.pathname);
  if (req.method === "POST" && sub2ApiSchedulableMatch) {
    const body = await readJson(req);
    if (typeof body.enabled !== "boolean") throw httpError(400, "启用状态必须是布尔值");
    const job = jobs.get(sub2ApiSchedulableMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "Login flow not found" });
      return;
    }
    if (body.enabled && accountAutomationBlocked(job.email)) throw httpError(409, "账号已确认封禁，请先完成重新登录授权以确认恢复");
    const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
    if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
    const state = await loadSub2ApiAccountStatus({ forceRefresh: true });
    const entry = state.accounts.get(job.email.toLowerCase());
    if (!entry?.accountIds?.length) throw httpError(409, `${job.email} 尚未加入 Sub2API 号池`);
    await overloadCooldown.manualOverride(job.email, entry.accountIds, () => Promise.all(entry.accountIds.map((accountId) => requestSub2Api(
      config,
      `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/schedulable`,
      {
        method: "POST",
        body: JSON.stringify({ schedulable: body.enabled }),
      },
    ))), { enabled: body.enabled });
    const nextEntry = {
      ...entry,
      enabled: body.enabled,
      fetchedAt: new Date().toISOString(),
    };
    state.accounts.set(job.email.toLowerCase(), nextEntry);
    state.fetchedAt = new Date().toISOString();
    sendJson(res, 200, { status: publicSub2ApiAccountStatusEntry(nextEntry) });
    return;
  }

  const sub2ApiPriorityMatch = /^\/api\/sub2api\/accounts\/([a-f0-9-]+)\/priority$/.exec(requestUrl.pathname);
  if ((req.method === "POST" || req.method === "PUT") && sub2ApiPriorityMatch) {
    const body = await readJson(req);
    const priority = parseOptionalSub2ApiInteger(body?.priority, "优先级", 0, 10000);
    if (priority === null) throw httpError(400, "优先级必须是 0 到 10000 的整数");
    const job = jobs.get(sub2ApiPriorityMatch[1]);
    if (!job) {
      sendJson(res, 404, { error: "Login flow not found" });
      return;
    }
    const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
    if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
    const state = await loadSub2ApiAccountStatus({ forceRefresh: true });
    const entry = state.accounts.get(job.email.toLowerCase());
    const accountIds = [...new Set(entry?.accountIds || [])];
    if (!accountIds.length) throw httpError(409, `${job.email} 尚未加入 Sub2API 号池`);
    try {
      await Promise.all(accountIds.map((accountId) => requestSub2Api(
        config,
        `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`,
        {
          method: "PUT",
          body: JSON.stringify({ priority }),
        },
      )));
    } finally {
      invalidateSub2ApiAccountStatusCache();
    }
    const refreshedState = await loadSub2ApiAccountStatus({ forceRefresh: true });
    const refreshedEntry = refreshedState.accounts.get(job.email.toLowerCase()) || {
      ...(entry || {}),
      email: job.email.toLowerCase(),
      accountIds,
      priority,
      fetchedAt: new Date().toISOString(),
    };
    sendJson(res, 200, {
      updated: accountIds.length,
      priority,
      status: publicSub2ApiAccountStatusEntry(refreshedEntry),
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/settings") {
    sendJson(res, 200, publicSub2ApiSettingsState());
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/plan-type-mapping") {
    sendJson(res, 200, {
      configured: planTypeLabelMappingConfigured,
      mapping: { ...planTypeLabelMapping },
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/plan-type-mapping") {
    const body = await readJson(req);
    const mapping = normalizePlanTypeLabelMapping(body.mapping);
    await persistPlanTypeLabelMapping(mapping);
    planTypeLabelMapping = mapping;
    planTypeLabelMappingConfigured = true;
    sendJson(res, 200, {
      configured: true,
      mapping: { ...planTypeLabelMapping },
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/settings") {
    const body = await readJson(req);
    const previousProfileState = snapshotSub2ApiProfileState();
    const config = applySub2ApiSettingsBody(body);
    const profileSyncTargets = diffSub2ApiProfileSyncTargets(previousProfileState, snapshotSub2ApiProfileState());
    sub2ApiProxyStateCache.clear();
    if (sub2ApiMonitorConfig) {
      sub2ApiMonitorConfig = { ...config, enabled: sub2ApiMonitorConfig.enabled === true };
      await persistSub2ApiMonitorConfiguration();
    }
    invalidateSub2ApiAccountStatusCache();
    await persistSub2ApiSettingsConfiguration();
    const profileSync = await syncSub2ApiProfileChanges(config, profileSyncTargets, snapshotSub2ApiProfileState());
    const datePrioritySync = await refreshImportDatePriorities(config);
    overloadMonitor.trigger();
    overloadCooldown.trigger();
    sendJson(res, 200, { ...publicSub2ApiSettingsState(), profileSync, datePrioritySync });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/sub2api/monitor") {
    sendJson(res, 200, publicSub2ApiMonitorState());
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor") {
    const body = await readJson(req);
    const previousProfileState = snapshotSub2ApiProfileState();
    const config = applySub2ApiSettingsBody(body);
    const profileSyncTargets = diffSub2ApiProfileSyncTargets(previousProfileState, snapshotSub2ApiProfileState());
    sub2ApiProxyStateCache.clear();
    invalidateSub2ApiAccountStatusCache();
    await persistSub2ApiSettingsConfiguration();
    sub2ApiMonitorConfig = { ...config, enabled: body.enabled === true };
    sub2ApiMonitorState.lastError = null;
    await persistSub2ApiMonitorConfiguration();
    scheduleSub2ApiMonitor();
    const profileSync = await syncSub2ApiProfileChanges(config, profileSyncTargets, snapshotSub2ApiProfileState());
    const datePrioritySync = await refreshImportDatePriorities(config);
    overloadMonitor.trigger();
    overloadCooldown.trigger();
    sendJson(res, 200, { ...publicSub2ApiMonitorState(), profileSync, datePrioritySync });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/sub2api/monitor/check") {
    if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "请先启用 Sub2API 号池监控");
    const result = await runSub2ApiMonitor("manual");
    sendJson(res, 200, { ...publicSub2ApiMonitorState(), result });
    return;
  }

  const providerOptionsMatch = /^\/api\/sms-providers\/([a-z0-9_-]+)\/options$/.exec(requestUrl.pathname);
  if (req.method === "POST" && providerOptionsMatch) {
    const body = await readJson(req);
    let smsClient;
    try {
      smsClient = createSmsProvider(providerOptionsMatch[1], body.config, {
        lubanApiBase: process.env.LUBAN_SMS_API_BASE,
        smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      });
      if (!smsClient.listNumberOptions) throw httpError(400, "该接码平台不支持价格查询");
      const options = await smsClient.listNumberOptions();
      sendJson(res, 200, { providerId: smsClient.id, options });
    } catch (error) {
      if (error?.status) throw error;
      throw httpError(502, safeSmsProviderError(error, body.config?.apiKey));
    }
    return;
  }

  const match = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(input|cancel|retry|regenerate|relogin|web-login|web-session-check|setup-2fa|replace-2fa|add-password|credentials|usage|logs|download|sms-number|luban-number|sessions(?:\/(?:logout|logout-all))?|workspaces(?:\/switch)?))?$/.exec(requestUrl.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const job = jobs.get(match[1]);
  if (!job) {
    sendJson(res, 404, { error: "Login flow not found" });
    return;
  }

  const action = match[2];
  if (/^(?:sessions|workspaces)(?:\/|$)/.test(action || "")) assertAccountWebActionsAllowed(job);
  if (req.method === "GET" && action === "logs") {
    sendJson(res, 200, { id: job.id, logs: job.logs });
    return;
  }
  if (req.method === "GET" && action === "credentials") {
    await reloadMissingJobCredentials(job);
    sendJson(res, 200, { credentials: await publicCredentialDetails(job) });
    return;
  }
  if (req.method === "GET" && action === "sessions") {
    try {
      await refreshJobProxyBinding(job);
      sendJson(res, 200, { sessions: await listAccountSessions(job) });
    } catch (error) {
      throw sessionApiError(error, job);
    }
    return;
  }
  if (req.method === "GET" && action === "workspaces") {
    if (!job.resultSaved && !job.webSessionAvailable) throw httpError(409, "请先登录 Web，再读取工作空间");
    try {
      await refreshJobProxyBinding(job);
      sendJson(res, 200, { workspaces: await listAccountWorkspaces(job) });
    } catch (error) {
      throw sessionApiError(error, job);
    }
    return;
  }
  if (req.method === "POST" && action === "workspaces/switch") {
    const body = await readJson(req);
    const workspaceId = normalizeSub2ApiAccountId(body?.workspaceId);
    if (!workspaceId) throw httpError(400, "工作空间 ID 无效");
    await withEmailJobLock(job.email, async () => {
      if ((!job.resultSaved && !job.webSessionAvailable) || !canForceRelogin(job)) {
        throw httpError(409, "当前账号不能切换工作空间，请等待当前操作完成");
      }
      const available = await listAccountWorkspaces(job);
      const target = available.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target || !isAccountWorkspaceAvailable(target)) {
        throw httpError(409, accountWorkspaceAvailabilityLabel(target));
      }
      const result = await switchAccountWorkspace(job, workspaceId);
      job.workspacePlanType = result.planType || target.planType || null;
      recordJobOperation(job, "workspace_switch");
      job.prompt = `已切换到 ${target.name || target.id}`;
      touch(job);
      await saveJobMetadata(job);
      // A workspace switch changes the OAuth account identity and PlanType in
      // the local import file. If this account already exists in Sub2API,
      // update those existing records in place so a later upload cannot create
      // a second account for the same email and leave the pool out of sync.
      let sub2api = null;
      try {
        sub2api = job.resultSaved ? await synchronizeSub2ApiWorkspaceAccount(job) : { configured: false, matched: 0, updated: 0 };
        if (sub2api?.updated) {
          appendJobLog(job, `[workspace] 已同步更新 Sub2API 号池中的 ${sub2api.updated} 条账号记录。\n`);
          touch(job);
          await saveJobMetadata(job);
        }
        // Refresh the status snapshot before returning the job so the UI
        // immediately shows the preserved remote id and new PlanType. This is
        // also needed when no matching remote row exists, otherwise an older
        // cached pool entry could survive the workspace switch response.
        if (sub2api?.configured) {
          try {
            await loadSub2ApiAccountStatus({ forceRefresh: true });
          } catch (error) {
            sub2api.statusRefreshError = String(error?.message || error).slice(0, 500);
          }
        }
      } catch (error) {
        const message = String(error?.message || error).slice(0, 500);
        sub2api = { configured: true, matched: 0, updated: 0, accountIds: [], error: message };
        appendJobLog(job, `[workspace] 工作空间已切换，但同步 Sub2API 号池失败：${message}\n`);
        touch(job);
        await saveJobMetadata(job);
      }
      sendJson(res, 200, { job: publicJob(job), workspaces: result, sub2api });
      return;
    });
    return;
  }
  if (req.method === "GET" && action === "usage") {
    if (!job.resultSaved) throw httpError(409, "账号授权尚未完成，暂时没有可读取的 Sub2API 用量");
    try {
      const usage = await getAccountUsage(job, requestUrl.searchParams.get("refresh") === "1");
      sendJson(res, 200, { usage });
    } catch (error) {
      throw accountUsageApiError(error);
    }
    return;
  }
  if (req.method === "GET" && action === "download") {
    await downloadResult(res, job);
    return;
  }
  if (req.method === "POST" && ["sms-number", "luban-number"].includes(action)) {
    const body = await readJson(req);
    const providerId = action === "luban-number" ? "luban" : body.providerId;
    const config = action === "luban-number"
      ? { apiKey: body.apiKey, serviceId: body.serviceId }
      : body.config;
    await withEmailJobLock(job.email, () => acquireSmsNumber(job, providerId, config));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "cancel") {
    await withEmailJobLock(job.email, () => cancelJob(job));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "retry") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => retryJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "regenerate") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => regenerateJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "web-session-check") {
    await readJson(req);
    if (!canLoginWeb(job)) throw httpError(409, "账号正在运行、已封禁或已有 Web 检测任务");
    enqueueWebSessionCheck(job);
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "web-login") {
    await readJson(req);
    await withEmailJobLock(job.email, () => startWebLogin(job));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "relogin") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => forceReloginJob(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "setup-2fa") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startTotpSetup(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "sessions/logout") {
    const body = await readJson(req);
    let result;
    try {
      result = await withEmailJobLock(job.email, async () => {
        await refreshJobProxyBinding(job);
        return revokeAccountSession(job, body);
      });
    } catch (error) {
      throw sessionApiError(error, job);
    }
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && action === "sessions/logout-all") {
    let result;
    try {
      result = await withEmailJobLock(job.email, async () => {
        if (!canLogoutAllSessions(job)) {
          throw httpError(409, "账号正在运行或没有已保存的授权，暂不能登出所有设备");
        }
        await refreshJobProxyBinding(job);
        const previousPause = job.webSessionMaintenancePause || null;
        job.webSessionMaintenancePause = { reason: "logout", at: new Date().toISOString() };
        await saveJobMetadata(job);
        try { return await revokeAllAccountSessions(job); }
        catch (error) { job.webSessionMaintenancePause = previousPause; await saveJobMetadata(job); throw error; }
      });
    } catch (error) {
      throw sessionApiError(error, job);
    }
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && action === "replace-2fa") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startTotpSetup(job, { ...body, replaceExisting: true }));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "PUT" && action === "credentials") {
    const body = await readJson(req);
    let persisted = false;
    await withEmailJobLock(job.email, async () => {
      persisted = await updateStoredCredentialFields(job, body);
    });
    sendJson(res, 200, { credentials: await publicCredentialDetails(job, persisted), job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "add-password") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => startPasswordAdd(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }
  if (req.method === "POST" && action === "input") {
    const body = await readJson(req);
    await withEmailJobLock(job.email, () => submitJobInput(job, body));
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function sendJobsPage(res, requestedPage, emailFilter = null, filters = {}) {
  await syncCompletedOutputs();
  try {
    await loadSub2ApiAccountStatus();
  } catch (error) {
    if (filters.sub2apiPool || filters.sub2apiEnabled) throw error;
  }
  const allJobs = listUniqueJobs();
  await Promise.all(allJobs.map(inspectAccountWebSession));
  const planTypes = [...new Set(allJobs.map((job) => getJobPlanType(job)).filter(Boolean))].sort();
  const planTypeUnknown = allJobs.some((job) => !getJobPlanType(job));
  const sub2apiPools = [...new Set(allJobs.map((job) => getSub2ApiPoolFilterValue(job)))];
  const sub2apiEnabled = [...new Set(allJobs.map((job) => getSub2ApiEnabledFilterValue(job)))];
  const statuses = JOB_STATUS_FILTER_VALUES.filter((status) => allJobs.some((job) => job.status === status));
  const emailSet = emailFilter?.length ? new Set(emailFilter) : null;
  const visibleJobs = allJobs.filter((job) => {
    if (emailSet && !emailSet.has(job.email.toLowerCase())) return false;
    return matchesJobFilters(job, filters);
  });
  const total = visibleJobs.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * PAGE_SIZE;
  sendJson(res, 200, {
    jobs: visibleJobs.slice(start, start + PAGE_SIZE).map(publicJob),
    selection: visibleJobs.map(publicSelectionJob),
    pagination: { page, pageSize: PAGE_SIZE, total, totalPages, totalAll: allJobs.length },
    filter: {
      active: Boolean(emailSet || filters.search || filters.lockedOnly || filters.accountType || filters.status || filters.planType || filters.sub2apiPool || filters.sub2apiEnabled || filters.webSession),
      search: filters.search || "",
      lockedOnly: Boolean(filters.lockedOnly),
      webSession: filters.webSession || "",
      accountType: filters.accountType || "",
      requested: emailFilter?.length || 0,
      matched: total,
      status: filters.status || "",
      planType: filters.planType || "",
      sub2apiPool: filters.sub2apiPool || "",
      sub2apiEnabled: filters.sub2apiEnabled || "",
    },
    filterOptions: {
      statuses,
      planTypes,
      planTypeUnknown,
      sub2apiPools,
      sub2apiEnabled,
    },
    stats: {
      active: allJobs.filter(occupiesActiveSlot).length + activeWebSessionChecks,
      webSessionChecks: activeWebSessionChecks,
      queued: allJobs.filter((job) => job.status === "queued").length,
      completed: allJobs.filter((job) => job.status === "completed").length,
    },
    taskSettings: publicTaskSettings(),
  });
}

function normalizeJobFilters(value) {
  const source = value && typeof value === "object" ? value : {};
  const search = String(source.search || "").trim();
  const lockedOnly = source.lockedOnly === true || source.lockedOnly === "true";
  const accountTypeValue = String(source.accountType || "").trim().toLowerCase();
  const statusValue = String(source.status || "").trim().toLowerCase();
  const planTypeValue = String(source.planType || "").trim();
  const sub2apiPoolValue = String(source.sub2apiPool || "").trim().toLowerCase();
  const sub2apiEnabledValue = String(source.sub2apiEnabled || "").trim().toLowerCase();
  const allowedPoolValues = new Set(["added", "error", "not_added", "unknown"]);
  const allowedEnabledValues = new Set(["enabled", "disabled", "unknown"]);
  return {
    search: search || null,
    lockedOnly,
    webSession: ["absent", "saved", "valid", "expired", "unavailable", "banned"].includes(source.webSession) ? source.webSession : null,
    accountType: ["password_totp", "pool_only"].includes(accountTypeValue) ? accountTypeValue : null,
    status: JOB_STATUS_FILTER_VALUES.includes(statusValue) ? statusValue : null,
    planType: planTypeValue || null,
    sub2apiPool: allowedPoolValues.has(sub2apiPoolValue) ? sub2apiPoolValue : null,
    sub2apiEnabled: allowedEnabledValues.has(sub2apiEnabledValue) ? sub2apiEnabledValue : null,
  };
}

function matchesJobFilters(job, filters) {
  const sub2ApiStatus = getSub2ApiAccountStatusForJob(job);
  if (filters.lockedOnly) {
    const isLocked = job.status === "banned" || Boolean(job.autoRepairBlocked);
    if (!isLocked) return false;
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const emailMatch = String(job.email || "").toLowerCase().includes(q);
    const remarkMatch = String(job.remark || "").toLowerCase().includes(q);
    const planMatch = String(getJobPlanType(job) || "").toLowerCase().includes(q)
      || String(sub2ApiStatus.planType || "").toLowerCase().includes(q);
    const proxyMatch = job.assignedProxyId ? String(job.assignedProxyId).includes(q) : false;
    if (!emailMatch && !remarkMatch && !planMatch && !proxyMatch) return false;
  }
  if (filters.webSession && (accountAutomationBlocked(job.email) ? "banned" : job.webSessionStatus || "absent") !== filters.webSession) return false;
  if (filters.accountType === "pool_only" && !job.poolOnly) return false;
  if (filters.accountType === "password_totp"
    && (job.poolOnly || job.loginMode !== "password" || !hasJobTotpKey(job))) return false;
  if (filters.status && job.status !== filters.status) return false;
  if (filters.planType) {
    const actualPlanType = getJobPlanType(job) || "__unknown__";
    if (actualPlanType !== filters.planType) return false;
  }
  if (filters.sub2apiPool && getSub2ApiPoolFilterValue(job, sub2ApiStatus) !== filters.sub2apiPool) return false;
  if (filters.sub2apiEnabled === "enabled" && sub2ApiStatus.enabled !== true) return false;
  if (filters.sub2apiEnabled === "disabled" && sub2ApiStatus.enabled !== false) return false;
  if (filters.sub2apiEnabled === "unknown" && sub2ApiStatus.enabled !== null) return false;
  return true;
}

function getSub2ApiPoolFilterValue(job, status = getSub2ApiAccountStatusForJob(job)) {
  const value = status.inPool;
  if (value === true && status.remoteStatus === "error") return "error";
  return value === true ? "added" : value === false ? "not_added" : "unknown";
}

function getSub2ApiEnabledFilterValue(job) {
  const value = getSub2ApiAccountStatusForJob(job).enabled;
  return value === true ? "enabled" : value === false ? "disabled" : "unknown";
}

function normalizeEmailFilter(value) {
  if (!Array.isArray(value) || value.length === 0) throw httpError(400, "请至少输入一个筛选邮箱");
  if (value.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多筛选 ${MAX_BATCH_JOBS} 个邮箱`);
  const unique = new Set();
  value.forEach((item, index) => {
    const email = String(item || "").trim().toLowerCase();
    if (!isEmail(email)) throw httpError(400, `第 ${index + 1} 个筛选邮箱格式错误`);
    unique.add(email);
  });
  return [...unique];
}

async function startJob(email, credentials = {}, proxyUrl = null) {
  proxyUrl = effectiveAccountProxyUrl(proxyUrl, globalProxyUrl);
  const { loginMode, mailApiUrl, mailRequestBody, password, totpSecret } = normalizeLoginCredentials(credentials);
  await saveStoredLoginCredentials(email, { password, totpSecret, proxyUrl });
  const id = crypto.randomUUID();
  const outputDir = path.join(OUTPUT_ROOT, id);
  const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
  const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
  const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
  const passwordAddResultPath = path.join(outputDir, PASSWORD_ADD_RESULT_FILENAME);
  await fs.mkdir(outputDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const job = {
    id,
    email,
    status: "queued",
    prompt: "已加入任务队列",
    createdAt,
    updatedAt: createdAt,
    lastOperationAt: createdAt,
    lastOperationType: "initial_authorization",
    completedAt: null,
    outputPath,
    checkpointPath,
    totpResultPath,
    passwordAddResultPath,
    logs: "",
    lastError: null,
    child: null,
    parserTail: "",
    resultSaved: false,
    planType: null,
    loginMode,
    password,
    totpSecret,
    remark: normalizeAccountRemark(credentials.remark || ""),
    remarkSyncPending: Object.hasOwn(credentials, "remark"),
    remarkRevision: crypto.randomUUID(),
    hasPasswordCredential: Boolean(password),
    hasTotpCredential: Boolean(totpSecret),
    proxyUrl,
    assignedProxyId: normalizeStoredProxyId(credentials.assignedProxyId),
    fixedProxy: accountProxyMode === "sub2api",
    poolRefreshAction: null,
    poolRefreshDueAt: null,
    poolRefreshError: null,
    poolRefreshReady: false,
    mailApiUrl,
    mailRequestBody,
    mailSeenCandidateKeys: new Set(),
    mailCandidateCounts: new Map(),
    mailStatus: mailApiUrl ? "baseline" : "manual",
    mailApiError: null,
    mailPollRunning: false,
    mailPollToken: null,
    mailOtpRequestedAt: null,
    currentPhone: null,
    phoneError: null,
    restartRequired: false,
    attempt: 1,
    runId: null,
    runMode: null,
    queuedMode: "full",
    queuedAt: new Date().toISOString(),
    queuedStartPrompt: "正在建立登录会话",
    directTlsFallbackAttempted: false,
    fallbackInProgress: false,
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpSetupReplaceExisting: false,
    totpRotationRemoteDisabled: false,
    totpRotationStage: null,
    totpRotationIncomplete: false,
    totpSetupResumesAuthorization: false,
    passwordAddError: null,
    passwordAddedAt: null,
    pendingNewPassword: null,
    passwordAddResumesAuthorization: false,
    loginCheckpointAvailable: false,
    totpKnownEnabled: false,
    totpSetupAttempt: 0,
    totpResultLoading: false,
    proxyRiskRetryCount: 0,
    proxyConnectionFailureCount: 0,
    proxyRiskRestarting: false,
    proxyFallbackAttempted: false,
    proxyFallbackActive: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
    queueRunId: null,
    startedAt: null,
    lastAuthAutomated: false,
    lastAuthAutomationReason: "尚未完成可验证的全自动登录",
    lastAuthAutomatedAt: null,
    lastAuthRequirements: null,
    authAutomationAttempt: null,
    autoRepairBlocked: false,
    autoRepairBlockedReason: null,
    autoRepairBlockedAt: null,
    autoRepairLastAttemptAt: null,
    autoRepairLastSuccessAt: null,
    autoRepairLastError: null,
    autoRepairPendingAccountIds: [],
    autoRepairPendingBackend: null,
    autoRepairOperation: null,
    autoTaskActions: [],
    autoTaskStatus: "idle",
    autoTaskIndex: 0,
    autoTaskError: null,
    autoTaskEligible: false,
    ...newSmsState(),
  };
  beginAuthorizationAutomationAttempt(job, "initial");
  jobs.set(id, job);
  await saveJobMetadata(job);
  scheduleQueuedJobs();
  return job;
}

function scheduleQueuedJobs() {
  if (shuttingDown || queueSchedulingPaused) return;
  let availableSlots = maxActiveJobs - [...jobs.values()].filter(occupiesActiveSlot).length - activeWebSessionChecks;
  if (availableSlots <= 0) return;
  const queuedJobs = [...jobs.values()]
    .filter((job) => job.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)));
  for (const job of queuedJobs.slice(0, availableSlots)) {
    const mode = job.queuedMode || "full";
    const queueRunId = crypto.randomUUID();
    job.queueRunId = queueRunId;
    job.status = mode === "refresh"
      ? "refreshing"
      : mode === "totp_setup"
        ? "totp_starting"
        : mode === "password_add"
          ? "password_add_starting"
          : "starting";
    job.prompt = job.queuedStartPrompt || (mode === "refresh"
      ? "正在使用已有刷新令牌直接生成新授权"
      : mode === "totp_setup"
        ? "正在重新验证账号并准备设置 2FA"
        : mode === "password_add"
          ? "正在重新验证账号并准备添加密码"
          : "正在建立登录会话");
    job.queuedAt = null;
    job.startedAt = new Date().toISOString();
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    void prepareAndLaunchJob(job, mode, queueRunId);
    availableSlots -= 1;
    if (availableSlots <= 0) break;
  }
  drainWebSessionChecks();
}

async function withWebSessionCheckSlot(_job, operation) {
  // Foreground login jobs get first use of available shared slots. Checks that
  // find the pool full remain due and are retried by the monitor's next tick.
  scheduleQueuedJobs();
  if (shuttingDown || queueSchedulingPaused || [...jobs.values()].filter(occupiesActiveSlot).length + activeWebSessionChecks >= maxActiveJobs) return;
  activeWebSessionChecks++;
  try { return await operation(); }
  finally { activeWebSessionChecks--; scheduleQueuedJobs(); }
}

async function prepareAndLaunchJob(job, mode, queueRunId) {
  try {
    let hasBinding = accountProxyMode === "plan" && hasPlanProxyBinding(job);
    if (accountProxyMode === "plan") {
      const knownPlanType = normalizePlanType(getJobPlanType(job));
      if (job.webSessionMonitorRepair && hasBinding) {
        await restorePlanProxyBinding(job);
      } else if (knownPlanType) {
        await preparePlanCodexProxy(job, knownPlanType, job.workspaceAccountId, { reapply: true });
        hasBinding = true;
        appendJobLog(job, `[proxy-plan] 已在登录前应用 PlanType ${knownPlanType} 的当前 IP 方案。\n`);
      } else if (hasBinding) await restorePlanProxyBinding(job);
      else if (mode !== "refresh" && !globalProxyUrl) throw httpError(409, "请先在代理 IP 配置中保存首次网页登录使用的动态代理");
      job.runProxyFixed = hasBinding;
    } else await refreshJobProxyBinding(job);
    if (!job.proxyFallbackActive && accountProxyMode !== "plan") job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl);
    const oauthSettings = accountProxyMode === "plan" && ["full", "web_login"].includes(mode)
      ? { codexAuthMode, phasedProxy: true, loginProxyFixed: hasBinding, loginProxyUrl: hasBinding ? job.proxyUrl : globalProxyUrl }
      : ["full", "refresh"].includes(mode) ? await codexOAuthSettingsForJob(job)
        : { codexAuthMode: "local", ...(accountProxyMode === "plan" && !hasBinding ? { phasedProxy: true, loginProxyUrl: globalProxyUrl } : {}) };
    if (["full", "web_login", "totp_setup", "password_add"].includes(mode) && job.mailApiUrl) await loadMailboxBaseline(job);
    if (!isActive(job.status) || job.status === "queued" || job.queueRunId !== queueRunId) return;
    launchJob(job, { mode, ...oauthSettings });
  } catch (error) {
    if (mode === "web_login") {
      await finishWebLogin(job, 1, null, `准备 Web 登录失败：${error.message}`);
    } else if (mode === "totp_setup") {
      await restoreTotpSetupFailure(job, `准备 2FA 设置失败：${error.message}`);
    } else if (mode === "password_add") {
      restorePasswordAddFailure(job, `准备添加密码失败：${error.message}`);
    } else {
      failJob(job, `准备登录任务失败：${error.message}`);
    }
    if (job.poolRefreshAction && job.status !== "completed") {
      job.poolRefreshError = job.lastError || job.prompt || `登录任务准备失败：${error.message}`;
      job.poolRefreshDueAt = null;
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
  }
}

function enqueueJob(job, mode, startPrompt) {
  job.queueRunId = null;
  job.status = "queued";
  job.prompt = "已加入任务队列";
  job.queuedMode = mode;
  job.queuedAt = new Date().toISOString();
  job.queuedStartPrompt = startPrompt;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

function helperLoginProxyRoute(job, proxyUrl) {
  if (!proxyUrl) return { kind: "direct", name: "直连" };
  const bound = proxyUrl === job.proxyUrl && Boolean(job.boundProxyName && normalizeStoredProxyId(job.assignedProxyId));
  return { kind: "proxy", name: bound ? job.boundProxyName : proxyUrl === globalProxyUrl ? "动态代理" : "自定义代理",
    proxyId: bound ? normalizeStoredProxyId(job.assignedProxyId) : null };
}

function launchJob(job, options = {}) {
  if (options.phasedProxy) job.runLoginProxyUrl = options.loginProxyUrl;
  else if (Object.hasOwn(options, "loginProxyUrl")) job.proxyUrl = options.loginProxyUrl;
  else if (!job.proxyFallbackActive) job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl);
  job.runProxyFixed = options.loginProxyFixed === true || !options.phasedProxy && (accountProxyMode === "sub2api" || Boolean(options.sub2ApiOAuth?.proxyId) || job.fixedProxy);
  const mode = options.mode || "full";
  if (mode === "full" && !job.authAutomationAttempt) {
    beginAuthorizationAutomationAttempt(job, "login");
  }
  const runId = crypto.randomUUID();
  job.runResultSaved = false;
  job.runId = runId;
  job.runMode = mode;
  job.mailOtpRequestedAt = null;
  const args = mode === "web_login"
    ? [PROTOCOL_SCRIPT, "--email", job.email, "--web-only", "--output-mode", "web",
      "--sub2api-out", job.outputPath, "--checkpoint", webLoginCheckpointPath(job), "--verbose"]
    : mode === "refresh"
    ? [
        PROTOCOL_SCRIPT,
        "--refresh-sub2api",
        job.outputPath,
        "--sub2api-out",
        job.outputPath,
        "--verbose",
      ]
    : mode === "totp_setup"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          job.totpSetupReplaceExisting ? "--replace-totp" : "--setup-totp",
          "--totp-result",
          job.totpResultPath,
          ...(job.totpSetupResumesAuthorization ? ["--resume-checkpoint", job.checkpointPath] : []),
          "--verbose",
        ]
    : mode === "password_add"
      ? [
          PROTOCOL_SCRIPT,
          "--email",
          job.email,
          "--add-password",
          "--password-add-result",
          job.passwordAddResultPath,
          ...(job.passwordAddResumesAuthorization ? ["--resume-checkpoint", job.checkpointPath] : []),
          "--verbose",
        ]
    : [
        PROTOCOL_SCRIPT,
        "--email",
        job.email,
        "--output-mode",
        "sub2api",
        "--sub2api-out",
        job.outputPath,
        "--checkpoint",
        job.checkpointPath,
        "--resume-checkpoint",
        job.checkpointPath,
        "--verbose",
      ];
  const child = spawn(process.execPath, args, {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      CHATGPT_LOGIN_PASSWORD: job.password || "",
      TOSUB2_BROWSER_IDENTITY_ROOT: path.join(OUTPUT_ROOT, "browser-identities"),
      TOSUB2_WEB_SESSION_PATH: path.join(path.dirname(job.outputPath), "web-session.json"),
      CHATGPT_TOTP_SECRET: job.totpSecret || "",
      CHATGPT_NEW_PASSWORD: mode === "password_add" ? job.pendingNewPassword || "" : "",
      CHATGPT_PROXY_URL: job.proxyFallbackActive ? "" : ((options.phasedProxy ? options.loginProxyUrl : job.proxyUrl) || ""),
      TOSUB2_WEB_LOGIN_PROXY: JSON.stringify(helperLoginProxyRoute(job, job.proxyFallbackActive ? null : options.phasedProxy ? options.loginProxyUrl : job.proxyUrl)),
      CHATGPT_PROXY_FIXED: job.runProxyFixed ? "1" : "0",
      TOSUB2_PHASED_PROXY: options.phasedProxy ? "1" : "0",
      TOSUB2_WEB_MONITOR_REPAIR: job.webSessionMonitorRepair ? "1" : "0",
      TOSUB2_CODEX_AUTH_MODE: options.codexAuthMode || "local",
      TOSUB2_OAUTH_BASE_URL: options.sub2ApiOAuth?.baseUrl || "",
      TOSUB2_OAUTH_ADMIN_KEY: options.sub2ApiOAuth?.adminApiKey || "",
      TOSUB2_OAUTH_PROXY_ID: options.sub2ApiOAuth?.proxyId ? String(options.sub2ApiOAuth.proxyId) : "",
      CHATGPT_PROXY_MAX_ATTEMPTS: String(Math.max(0, MAX_PROXY_RISK_RETRIES - (job.proxyRiskRetryCount || 0))),
      TOSUB2_TLS_PROFILE:
        String(process.env.TOSUB2_TLS_PROFILE || "").trim()
        || (!job.proxyUrl ? String(options.tlsProfile || DEFAULT_TLS_PROFILE) : ""),
    },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  job.child = child;

  child.on("message", (message) => {
    if (!options.phasedProxy || job.runId !== runId || job.child !== child || !isActive(job.status)) return;
    if (message?.type === "web-proxy-phase") { job.runProxyFixed = message.fixed === true; return; }
    if (message?.type !== "codex-proxy-request" || typeof message.id !== "string") return;
    void withEmailJobLock(job.email, async () => {
      if (job.runId !== runId || job.child !== child || !isActive(job.status)) return;
      try {
        if (job.proxyPhaseSelecting) throw httpError(409, "授权代理正在选择中");
        job.proxyPhaseSelecting = true;
        job.planAutomationPlanType ||= getJobPlanType(job);
        const route = await preparePlanCodexProxy(job, message.planType, message.workspaceId, { reapply: true });
        await reconcilePlanAutomations(job, message.planType);
        if (mode === "web_login") job.webLoginPlanType = message.planType;
        if (job.runId !== runId || job.child !== child || !isActive(job.status)) return;
        job.runProxyFixed = true;
        child.send({ type: "codex-proxy-response", id: message.id, route });
      } catch (error) {
        if (job.runId === runId && child.connected) child.send({ type: "codex-proxy-response", id: message.id, error: error.message });
      } finally {
        job.proxyPhaseSelecting = false;
      }
    }).catch((error) => {
      if (job.runId === runId && child.connected) child.send({ type: "codex-proxy-response", id: message.id, error: error.message });
    });
  });

  child.stdout.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    if (job.runId === runId) consumeOutput(job, chunk.toString("utf8"));
  });
  child.on("error", (error) => {
    void withEmailJobLock(job.email, async () => {
      if (job.runId !== runId) return;
      if (mode === "web_login") await finishWebLogin(job, 1, null, `无法启动 Web 登录进程：${error.message}`);
      else if (mode === "totp_setup") await restoreTotpSetupFailure(job, `无法启动 2FA 设置进程：${error.message}`);
      else if (mode === "password_add") restorePasswordAddFailure(job, `无法启动添加密码进程：${error.message}`);
      else failJob(job, `无法启动登录进程：${error.message}`);
      if (job.poolRefreshAction) {
        job.poolRefreshError = job.lastError || job.prompt || `登录进程启动失败：${error.message}`;
        job.poolRefreshDueAt = null;
        await saveJobMetadata(job);
      }
    });
  });
  child.on("close", (code, signal) => {
    void withEmailJobLock(job.email, () => handleChildClose(job, { code, signal, mode, runId }))
      .catch((error) => {
        void handleChildCloseFailure(job, mode, runId, error);
      });
  });
}

async function handleChildClose(job, { code, signal, mode, runId }) {
  if (job.runId !== runId) return;
  stopMailPolling(job);
  job.child = null;
  if (mode === "web_login") {
    await finishWebLogin(job, code, signal);
    return;
  }
  if (mode === "totp_setup") {
    await finishTotpSetup(job, code, signal);
    if (job.poolRefreshAction && job.status === "completed" && job.resultSaved) await synchronizePoolRefresh(job);
    scheduleQueuedJobs();
    return;
  }
  if (mode === "password_add") {
    await finishPasswordAdd(job, code, signal);
    scheduleQueuedJobs();
    return;
  }
  if (["canceled", "reauth_required"].includes(job.status)) {
    await finishSub2ApiAutoRepairFailure(job);
    scheduleQueuedJobs();
    return;
  }
  if (!isTerminalStatus(job.status) && code === 0 && job.runResultSaved && (await fileExists(job.outputPath))) {
    job.planType = await readPlanTypeFromOutput(job.outputPath);
    await reconcilePlanAutomations(job, job.planType);
    if (job.webSessionMonitorRepair) {
      job.workspacePlanType = job.planType || null;
      job.webSessionMonitorRepair = false;
      await webSessionMonitor.repairFinished(job.email);
    }
    if (mode === "full") {
      completeAuthorizationAutomationAttempt(job);
      // A successful new login supersedes an old Web-only ban diagnostic.
      job.webLoginError = null;
    }
    job.loginCheckpointAvailable = false;
    job.status = "completed";
    job.prompt = "授权完成，可以下载导入文件";
    job.completedAt = new Date().toISOString();
    if (job.poolRefreshAction) job.poolRefreshReady = true;
    touch(job);
    await saveJobMetadata(job);
    await finishSub2ApiAutoRepairSuccess(job);
    if (job.poolRefreshAction) await synchronizePoolRefresh(job);
    await queueConfiguredTaskActions(job);
    scheduleQueuedJobs();
    return;
  }
  if (!isTerminalStatus(job.status)) {
    if (job.status === "mfa_otp") {
      markMfaFailed(job, signal ? `2FA 验证阶段被 ${signal} 终止` : `2FA 验证阶段退出，代码 ${code ?? "未知"}`);
      await saveJobMetadata(job);
    } else if (await fileExists(job.checkpointPath)) {
      markResumeAvailable(job, signal ? `登录进程被 ${signal} 终止` : "登录流程中断");
    } else {
      failJob(job, signal ? `登录进程被 ${signal} 终止` : `登录进程退出，代码 ${code ?? "未知"}`);
    }
  }
  await finishSub2ApiAutoRepairFailure(job);
  if (job.webSessionMonitorRepair) {
    job.webSessionMonitorRepair = false;
    await webSessionMonitor.repairFinished(job.email, { success: false });
  }
  if (job.poolRefreshAction) {
    job.poolRefreshError = job.lastError || job.prompt || "重新授权未完成";
    job.poolRefreshDueAt = null;
    touch(job);
    await saveJobMetadata(job);
  }
  scheduleQueuedJobs();
}

function handleChildCloseFailure(job, mode, runId, error) {
  if (mode === "web_login") {
    if (job.runId === runId) void finishWebLogin(job, 1, null, `Web 登录收尾失败：${error.message}`);
    return;
  }
  if (job.runId !== runId && !(["totp_setup", "password_add"].includes(mode) && job.runId === null)) return;
  const message = `收尾处理失败：${error.message}`;
  if (mode === "totp_setup") {
    const replacingTotp = Boolean(job.totpSetupReplaceExisting);
    if (replacingTotp) job.totpRotationIncomplete = true;
    job.status = "completed";
    job.prompt = replacingTotp && job.totpRotationRemoteDisabled
      ? "原 2FA 状态可能已关闭，新 2FA 尚未激活；可以重试更换流程"
      : "原授权文件仍然可用，2FA 密钥尚未完成安全保存";
    job.totpSetupError = replacingTotp && job.totpRotationRemoteDisabled
      ? `${message}；远端 2FA 状态可能已关闭，结果文件已保留`
      : `${message}；已保留 2FA 结果文件，请重试保存`;
    job.totpRotationStage = replacingTotp ? (job.totpRotationStage || "failed") : null;
    job.totpSetupReplaceExisting = false;
    job.runMode = null;
    job.runId = null;
  } else if (mode === "password_add") {
    restorePasswordAddFailure(job, message);
  } else {
    failJob(job, message);
  }
  if (job.poolRefreshAction && !job.poolRefreshReady) {
    job.poolRefreshError = message;
    job.poolRefreshDueAt = null;
  }
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function retryJob(job, options = {}) {
  if (job.webLoginPreviousState) throw httpError(409, "Web 登录仍在运行，请等待完成或取消后再授权");
  if (!["failed", "mfa_failed", "canceled", "reauth_required", "resume_available"].includes(job.status)) {
    throw httpError(409, "当前任务不需要重新授权");
  }
  job.webSessionMaintenancePause = null;
  const retryingSecurityCheck = Boolean(job.securityCheckRequired);
  job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl);
  job.proxyFallbackAttempted = false;
  job.proxyFallbackActive = false;
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl, String(options.proxyUrl || "").trim() ? normalizeProxyUrl(options.proxyUrl) : null);
    const persisted = await saveStoredLoginCredentials(job.email, job);
  }
  const resumingCheckpoint = await fileExists(job.checkpointPath);
  job.loginCheckpointAvailable = resumingCheckpoint;
  stopMailPolling(job);
  if (resumingCheckpoint) stopSmsPolling(job);
  else releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  const startPrompt = retryingSecurityCheck && resumingCheckpoint
    ? "正在使用已有登录状态重试手机号绑定"
    : resumingCheckpoint ? "正在继续已有 Codex 授权检查点" : "正在重新建立登录会话";
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = resumingCheckpoint ? (job.currentPhone || job.smsNumber) : null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  clearAutoRepairBlock(job);
  job.autoRepairOperation = null;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  beginAuthorizationAutomationAttempt(job, "manual_retry");
  recordJobOperation(job, resumingCheckpoint ? "resume" : "reauthorize");
  beginPoolRefresh(job, "reauthorize");
  appendJobLog(
    job,
    retryingSecurityCheck
      ? `\n[retry] 开始第 ${job.attempt} 次手动重试；优先复用已有登录检查点。\n`
      : `\n[retry] 开始第 ${job.attempt} 次授权登录。\n`,
  );
  enqueueJob(job, "full", startPrompt);
}

async function regenerateJob(job, options = {}) {
  if (job.webLoginPreviousState) throw httpError(409, "Web 登录仍在运行，请等待完成或取消后再授权");
  if (job.status !== "completed" || !job.resultSaved) {
    throw httpError(409, "只能为已经完成的任务重新生成授权");
  }
  job.webSessionMaintenancePause = null;
  job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl);
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl, String(options.proxyUrl || "").trim() ? normalizeProxyUrl(options.proxyUrl) : null);
    await saveStoredLoginCredentials(job.email, job);
  }
  job.proxyFallbackAttempted = false;
  job.proxyFallbackActive = false;
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  releaseSmsNumber(job, "idle");
  job.restartRequired = false;
  job.completedAt = null;
  job.attempt += 1;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  recordJobOperation(job, "reauthorize");
  beginPoolRefresh(job, "reauthorize");
  appendJobLog(job, `\n[refresh] 第 ${job.attempt} 次生成：优先使用已有刷新令牌。\n`);
  enqueueJob(job, "refresh", "正在使用已有刷新令牌直接生成新授权");
}

function webLoginCheckpointPath(job) {
  return path.join(path.dirname(job.outputPath), "web-login-checkpoint.json");
}

function webSessionCheckPending(job) {
  return ["queued", "checking", "relogin"].includes(manualWebSessionChecks.get(job.id)?.phase);
}

function enqueueWebSessionCheck(job) {
  manualWebSessionChecks.set(job.id, { attemptId: crypto.randomUUID(), phase: "queued", renewed: false, error: null });
  scheduleQueuedJobs();
}

function drainWebSessionChecks() {
  if (drainingWebSessionChecks || shuttingDown) return;
  drainingWebSessionChecks = true;
  try {
    for (const [id, task] of manualWebSessionChecks) {
      if (task.phase !== "queued") continue;
      const job = jobs.get(id);
      if (!job || job.deleted || !canLoginWeb(job, { checking: true })) { task.phase = "failed"; task.error = "账号状态已变化，本次检测已跳过"; continue; }
      // withSlot reserves synchronously; retries keep this same shared slot.
      const operation = withWebSessionCheckSlot(job, () => {
        task.phase = "checking";
        touch(job);
        return withEmailJobLock(job.email, async () => {
          if (!canLoginWeb(job, { checking: true })) throw new Error("账号状态已变化，请稍后重试");
          job.webSessionMaintenancePause = null;
          await saveJobMetadata(job);
          try {
            const snapshot = await webSessionMonitor.probeWithRetries(job, {}, { isInterrupted: () => shuttingDown || accountAutomationBlocked(job.email) });
            if (["web_workspace_unavailable", "workspace_unavailable"].includes(snapshot.repairReason)) throw new Error("SESSION_WORKSPACE_UNAVAILABLE: Web 会话绑定空间已不可用");
            task.phase = "success";
            task.error = null;
            job.webLoginError = null;
            appendJobLog(job, `[web-session-check] 会话有效，已核对套餐与自动化开关${snapshot.repairReason ? "；授权或绑定差异交由巡检继续处理" : ""}。\n`);
            await saveJobMetadata(job);
          } catch (error) {
            const invalid = /^SESSION_(?:TOKEN_EXPIRED|CREDENTIALS_UNAVAILABLE|WORKSPACE_UNAVAILABLE):/.test(error.message || "");
            if (!invalid || task.renewed || accountAutomationBlocked(job.email)) throw error;
            // Clear pending admission while starting exactly one Web-only renewal.
            task.phase = "success";
            await startWebLogin(job);
            task.renewed = true;
            task.loginAttemptId = job.webLoginAttemptId;
            task.phase = "relogin";
          }
        });
      }).catch(error => { task.phase = "failed"; task.error = sessionApiError(error, job).message; touch(job); });
      manualWebSessionCheckOperations.add(operation);
      void operation.finally(() => manualWebSessionCheckOperations.delete(operation));
    }
  } finally { drainingWebSessionChecks = false; }
}

async function reconcilePlanAutomations(job, planType) {
  const plan = normalizePlanType(planType);
  if (!plan || accountAutomationBlocked(job.email)) return;
  const previousPlan = normalizePlanType(job.planAutomationPlanType || getJobPlanType(job));
  job.planAutomationPlanType = previousPlan;
  const changed = previousPlan !== plan;
  job.workspacePlanType = plan;
  // Re-evaluate ongoing switches only. One-shot uploads/2FA rotations stay one-shot.
  const actions = taskAutoActionsForPlanType(plan);
  for (const [action, service] of [["enable-overload-detection", overloadMonitor], ["enable-overload-cooldown", overloadCooldown]]) {
    const governed = Object.values(taskAutoActions).some(values => values.includes(action));
    if (!governed) continue;
    const allowed = actions.includes(action), state = service.snapshot(job.email);
    if ((!allowed && state.enabled) || (changed && allowed && !state.enabled && state.configured)) await service.setEnabled(job.email, allowed);
  }
  // Inherited fingerprint settings immediately use the live plan; explicit account
  // overrides keep their documented meaning. Abort work carrying an old plan.
  if (changed) modelFingerprint.invalidateAccount(job.email);
  job.planAutomationPlanType = plan;
  await saveJobMetadata(job);
}

async function startWebLogin(job, { maintenance = false } = {}) {
  if (accountAutomationBlocked(job.email)) throw httpError(409, "账号已确认封禁，已停止 Web 重登；如需确认解封，请使用重新开始授权");
  if (!canLoginWeb(job, { maintenance })) throw httpError(409, "账号正在运行或有待完成的号池操作，暂不能登录 Web");
  await reloadMissingJobCredentials(job);
  if (!canLoginWeb(job, { maintenance })) throw httpError(409, "账号当前不能登录 Web");
  if (!maintenance) job.webSessionMaintenancePause = null;
  const preserved = ["status", "prompt", "lastError", "completedAt", "startedAt", "attempt", "loginCheckpointAvailable",
    "securityCheckRequired", "restartRequired", "currentPhone", "phoneError", "proxyRiskRetryCount", "proxyConnectionFailureCount"];
  job.webLoginPreviousState = Object.fromEntries(preserved.map(key => [key, job[key]]));
  job.webLoginError = null;
  job.webLoginPlanType = null;
  job.webLoginAttemptId = crypto.randomUUID();
  job.webLoginResultSaved = false;
  job.lastError = null;
  job.parserTail = "";
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.proxyRiskRestarting = false;
  job.proxyFallbackAttempted = false;
  job.proxyFallbackActive = false;
  job.directTlsFallbackAttempted = false;
  job.proxySessionAttemptIds?.clear();
  job.proxyAttemptParserTail = "";
  await removePrivateFile(webLoginCheckpointPath(job));
  recordJobOperation(job, "web_login");
  appendJobLog(job, "\n[web-login] 仅登录 ChatGPT Web；不执行 Codex 授权、刷新或号池上传。\n");
  enqueueJob(job, "web_login", "正在登录 ChatGPT Web");
  await saveJobMetadata(job);
}

async function synchronizeWebLoginProxy(job) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  if (!config?.baseUrl || !hasPlanProxyBinding(job)) return;
  const listing = await listSub2ApiAccounts(config, { withMeta: true });
  if (!listing.complete) throw new Error("号池列表不完整");
  await reconcileSub2ApiAccountBans(config, listing.accounts);
  for (const account of listing.accounts) {
    if (accountAutomationBlocked(job.email)) return;
    if (account.platform !== "openai" || account.type !== "oauth" || sub2ApiAccountEmail(account) !== job.email.toLowerCase()) continue;
    const proxyId = normalizeStoredProxyId(job.assignedProxyId) || 0;
    if (Number(account.proxy_id || 0) === proxyId) continue;
    await requestProfileSync(config, `/api/v1/admin/accounts/${encodeURIComponent(account.id)}`, { method: "PUT", body: JSON.stringify({ proxy_id: proxyId }) });
  }
  invalidateSub2ApiAccountStatusCache();
}
async function finishWebLogin(job, code, signal, message = null) {
  stopMailPolling(job);
  let success = code === 0 && job.webLoginResultSaved;
  let webSession;
  if (success) {
    try { webSession = await readAccountWebSession(job); }
    catch (error) { success = false; message = error.message; }
  }
  const failure = message || job.lastError || (signal ? `Web 登录被 ${signal} 中断` : `Web 登录未完成，退出代码 ${code ?? "未知"}`);
  const previous = job.webLoginPreviousState;
  if (previous) Object.assign(job, previous);
  job.webLoginError = success ? null : failure;
  if (!success && isPermanentAccountFailure(failure)) {
    markAutoRepairBlocked(job, failure);
    await automationBlockWrites.get(job.email.toLowerCase());
  }
  if (success) {
    job.webLoginCompletedAt = new Date().toISOString();
    job.webSessionAvailable = true;
    const plan = webSession?.web?.planType || job.webLoginPlanType;
    await reconcilePlanAutomations(job, plan);
    if (plan && accountProxyMode === "plan" && !accountAutomationBlocked(job.email)) {
      try { await synchronizeWebLoginProxy(job); }
      catch (error) { appendJobLog(job, `[web-login] IP 绑定同步待号池巡检重试：${error.message}\n`); }
    }
    // Schedule a follow-up even for manual/Web-only entry points, without waiting 15 minutes.
    await webSessionMonitor.repairFinished(job.email, { success: true, webOnly: true });
  }
  if (accountAutomationBlocked(job.email)) job.status = "banned";
  job.prompt = accountAutomationBlocked(job.email) ? job.banProxyReleasePending ? "账号已确认封禁，IP 解绑待重试" : "账号已确认封禁，已停止自动化并解除 IP 绑定"
    : success ? "Web 登录成功，登录态已保存；原 Codex 授权保持不变" : `Web 登录未完成：${failure}`;
  job.webLoginPreviousState = null;
  job.webLoginResultSaved = false;
  if (job.webSessionMonitorRepair) {
    job.webSessionMonitorRepair = false;
    await webSessionMonitor.repairFinished(job.email, { success, webOnly: true });
  }
  job.runMode = null;
  job.runId = null;
  job.queueRunId = null;
  job.queuedMode = null;
  job.queuedAt = null;
  job.child = null;
  await removePrivateFile(webLoginCheckpointPath(job));
  appendJobLog(job, success ? "[web-login] Web 登录态已保存，已核对套餐、IP 绑定及自动开关；未重签 Codex 凭据。\n" : `[web-login] ${failure}\n`);
  const check = manualWebSessionChecks.get(job.id);
  if (check?.phase === "relogin" && check.loginAttemptId === job.webLoginAttemptId) {
    check.phase = success ? "queued" : "failed";
    check.error = success ? null : failure;
  }
  touch(job);
  await saveJobMetadata(job);
  scheduleQueuedJobs();
}

function restoreWebLoginState(job, metadata) {
  job.webSessionMonitorRepair = metadata.web_session_monitor_repair === true;
  job.webLoginAttemptId = metadata.web_login_attempt_id || null;
  job.webLoginCompletedAt = metadata.web_login_completed_at || null;
  job.webLoginError = metadata.web_login_error || null;
  const previous = metadata.web_login_previous_state;
  if (!previous || !isTerminalStatus(previous.status)) return;
  if (metadata.queued_mode === "web_login" && ["queued", "starting"].includes(metadata.status)) {
    job.webLoginPreviousState = previous;
    job.status = "queued";
    job.queuedMode = "web_login";
    job.queuedAt = metadata.queued_at || new Date().toISOString();
    job.queuedStartPrompt = "正在登录 ChatGPT Web";
    job.prompt = "服务重启后已恢复 Web 登录队列";
  } else {
    Object.assign(job, previous);
    job.webLoginPreviousState = null;
    job.webLoginError = "Web 登录因服务重启中断，请重新点击登录 Web";
    job.prompt = job.webLoginError;
    job.queuedMode = null;
  }
}

async function forceReloginJob(job, options = {}, context = {}) {
  await automationBlockWrites.get(job.email.toLowerCase());
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  await reloadMissingJobCredentials(job);
  if (!context.autoRepair && !context.webSessionMonitorRepair) job.webSessionMaintenancePause = null;
  job.webSessionMonitorRepair = context.webSessionMonitorRepair === true;
  job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl);
  if (!canForceRelogin(job)) {
    throw httpError(409, "当前任务正在进行中，不能重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl, String(options.proxyUrl || "").trim() ? normalizeProxyUrl(options.proxyUrl) : null);
    await saveStoredLoginCredentials(job.email, job);
  }
  job.proxyFallbackAttempted = false;
  job.proxyFallbackActive = false;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  await Promise.all([
    removePrivateFile(job.checkpointPath),
    removePrivateFile(job.totpResultPath),
  ]);
  job.loginCheckpointAvailable = false;
  job.lastError = null;
  job.parserTail = "";
  job.completedAt = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.mailCandidateCounts.clear();
  job.attempt += 1;
  if (!context.autoRepair) {
    clearAutoRepairBlock(job);
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
  }
  job.autoRepairOperation = context.autoRepair || null;
  if (context.autoRepair) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [...new Set(context.autoRepair.accountIds || [])];
    job.autoRepairPendingBackend = context.autoRepair.backend || null;
  }
  beginAuthorizationAutomationAttempt(job, context.autoRepair ? "sub2api_monitor" : "manual_relogin");
  recordJobOperation(job, context.autoRepair ? "automatic_relogin" : "relogin");
  if (!context.autoRepair) {
    beginPoolRefresh(job, context.poolRefreshAction || "relogin");
  }
  appendJobLog(job, `\n[relogin] 第 ${job.attempt} 次授权：跳过刷新令牌并强制重新登录。\n`);
  if (job.hasTotpCredential && !job.totpSecret) {
    appendJobLog(job, "[mfa] 本地未能读取已记录的 2FA 密钥，遇到 2FA 时需要手动输入验证码。\n");
  }
  enqueueJob(job, "full", "正在强制重新登录并完成授权");
}

async function reloadMissingJobCredentials(job) {
  const boundDirect = accountProxyMode === "plan" && hasPlanProxyBinding(job) && !normalizeStoredProxyId(job.assignedProxyId);
  if (boundDirect) job.proxyUrl = null;
  if (
    (job.password || !job.hasPasswordCredential)
    && (job.totpSecret || !job.hasTotpCredential)
    && (job.proxyUrl || boundDirect)
  ) return;
  const stored = await loadStoredLoginCredentials(job.email);
  job.password ||= stored.password;
  job.totpSecret ||= stored.totpSecret;
  if (!boundDirect) job.proxyUrl ||= stored.proxyUrl || globalProxyUrl;
  if (job.password) job.hasPasswordCredential = true;
  if (job.totpSecret) job.hasTotpCredential = true;
  if (stored.password || stored.totpSecret || stored.proxyUrl) {
    await saveStoredLoginCredentials(job.email, job);
  }
}

async function startTotpSetup(job, options = {}) {
  job.proxyFallbackAttempted = false;
  job.proxyFallbackActive = false;
  job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl);
  const replaceExisting = Boolean(options.replaceExisting);
  await reloadMissingJobCredentials(job);
  if (replaceExisting) {
    if (!canReplaceTotp(job)) {
      throw httpError(409, "只能为已完成授权且已知启用 2FA 的账号更换 2FA");
    }
  } else {
    if (!canSetupTotp(job)) {
      throw httpError(409, "只能为已完成授权，或已保存邮箱登录检查点且尚未设置 2FA 的账号设置 2FA");
    }
    if (hasJobTotpKey(job)) {
      throw httpError(409, "该账号已经保存了 2FA 密钥，无需重复设置");
    }
    if (job.totpKnownEnabled) {
      throw httpError(409, "该账号已经启用 2FA，但本地没有它的原始密钥，无法重复创建");
    }
  }
  const resumeAuthorization = replaceExisting ? false : !job.resultSaved;
  if (resumeAuthorization && !(await fileExists(job.checkpointPath))) {
    job.loginCheckpointAvailable = false;
    throw httpError(409, "邮箱登录检查点已丢失，请先重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl, String(options.proxyUrl || "").trim() ? normalizeProxyUrl(options.proxyUrl) : null);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.currentPhone = null;
  job.phoneError = null;
  const resumeDisabledRotation = replaceExisting
    && await hasIncompleteRemoteTotpRotation(job.totpResultPath, job.totpRotationRemoteDisabled);
  if (!resumeDisabledRotation) await removePrivateFile(job.totpResultPath);
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupError = null;
  job.totpSetupReplaceExisting = replaceExisting;
  job.totpRotationRemoteDisabled = resumeDisabledRotation;
  job.totpRotationStage = resumeDisabledRotation ? "disabled" : (replaceExisting ? "starting" : null);
  job.totpRotationIncomplete = replaceExisting;
  job.totpSetupAttempt = (job.totpSetupAttempt || 0) + 1;
  job.totpSetupResumesAuthorization = resumeAuthorization;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  recordJobOperation(job, replaceExisting ? "replace_2fa" : "setup_2fa");
  appendJobLog(
    job,
    replaceExisting
      ? `\n[2fa] 开始第 ${job.totpSetupAttempt} 次 2FA 更换；原授权文件保持不变，失败时可能需要重新启用 2FA。\n`
      : `\n[2fa] 开始第 ${job.totpSetupAttempt} 次 2FA 设置，原授权文件保持不变。\n`,
  );
  enqueueJob(job, "totp_setup", replaceExisting ? "正在重新验证账号并更换 2FA" : "正在重新验证账号并准备设置 2FA");
}

async function hasIncompleteRemoteTotpRotation(resultPath, metadataFlag = false) {
  if (metadataFlag) return fileExists(resultPath);
  try {
    const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
    return result?.version === 1
      && result?.operation === "replace_totp"
      && result?.activation_succeeded !== true
      && (result?.remote_disabled === true || result?.stage === "disabling");
  } catch {
    return false;
  }
}

async function startPasswordAdd(job, options = {}) {
  job.proxyFallbackAttempted = false;
  job.proxyFallbackActive = false;
  job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl);
  if (!canAddPassword(job)) {
    throw httpError(409, "只能为已完成授权，或已保存邮箱登录检查点且尚未保存密码的账号添加密码");
  }
  const resumeAuthorization = !job.resultSaved;
  if (resumeAuthorization && !(await fileExists(job.checkpointPath))) {
    job.loginCheckpointAvailable = false;
    throw httpError(409, "邮箱登录检查点已丢失，请先重新登录");
  }
  if (Object.hasOwn(options, "proxyUrl")) {
    job.proxyUrl = effectiveAccountProxyUrl(job.proxyUrl, globalProxyUrl, String(options.proxyUrl || "").trim() ? normalizeProxyUrl(options.proxyUrl) : null);
    await saveStoredLoginCredentials(job.email, job);
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.currentPhone = null;
  job.phoneError = null;
  await removePrivateFile(job.passwordAddResultPath);
  job.pendingNewPassword = generateStrongPassword();
  job.passwordAddResumesAuthorization = resumeAuthorization;
  job.passwordAddError = null;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.proxyRiskRestarting = false;
  job.proxySessionAttemptIds.clear();
  job.proxyAttemptParserTail = "";
  job.lastError = null;
  job.parserTail = "";
  recordJobOperation(job, "add_password");
  appendJobLog(job, "\n[password-add] 开始为无密码账号添加密码，新密码不会写入协议日志。\n");
  enqueueJob(job, "password_add", "正在重新验证账号并准备添加密码");
}

function generateStrongPassword() {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#%_";
  const all = `${lower}${upper}${digits}${symbols}`;
  const chars = [
    lower[crypto.randomInt(lower.length)],
    upper[crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)],
    symbols[crypto.randomInt(symbols.length)],
  ];
  while (chars.length < 18) chars.push(all[crypto.randomInt(all.length)]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const target = crypto.randomInt(index + 1);
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join("");
}

async function finishPasswordAdd(job, code, signal) {
  let result = null;
  try {
    result = JSON.parse(await fs.readFile(job.passwordAddResultPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") job.passwordAddError = `添加密码结果无法读取：${error.message}`;
  }

  if (
    result?.version === 1
    && String(result.email || "").toLowerCase() === job.email.toLowerCase()
    && typeof result.password === "string"
    && result.password === job.pendingNewPassword
  ) {
    job.password = result.password;
    job.hasPasswordCredential = true;
    job.loginMode = "password";
    job.passwordAddedAt = result.added_at || new Date().toISOString();
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.passwordAddError = persisted
      ? null
      : "当前系统不支持持久凭据存储，新密码仅在本次服务运行期间可用";
    job.prompt = persisted
      ? job.passwordAddResumesAuthorization
        ? "密码添加成功，可以继续未完成的 Codex 授权"
        : "密码添加成功，账号原始信息已经更新"
      : "密码添加成功，但新密码未能持久保存";
    appendJobLog(job, persisted
      ? "[password-add] 密码添加成功，新密码已安全保存，未写入协议日志。\n"
      : "[password-add] 密码添加成功，但当前系统不支持持久保存新密码。\n");
    if (persisted) await removePrivateFile(job.passwordAddResultPath);
  } else {
    job.prompt = job.passwordAddResumesAuthorization
      ? "本次添加密码未完成，原登录检查点仍可继续"
      : "原授权文件仍可使用，本次添加密码未完成";
    job.passwordAddError ||= signal
      ? `添加密码进程被 ${signal} 终止`
      : `添加密码进程退出，代码 ${code ?? "未知"}`;
    await removePrivateFile(job.passwordAddResultPath);
  }

  job.status = job.passwordAddResumesAuthorization ? "resume_available" : "completed";
  job.lastError = job.passwordAddResumesAuthorization
    ? "ChatGPT 登录状态已保留，点击“继续授权”即可重新开始 Codex 授权"
    : null;
  job.runMode = null;
  job.runId = null;
  job.pendingNewPassword = null;
  job.passwordAddResumesAuthorization = false;
  touch(job);
  await saveJobMetadata(job);
  if (job.poolRefreshAction && job.status === "completed" && job.resultSaved) await synchronizePoolRefresh(job);
}

function restorePasswordAddFailure(job, message) {
  const resumeAuthorization = Boolean(job.passwordAddResumesAuthorization);
  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.prompt = resumeAuthorization
    ? "本次添加密码未完成，原登录检查点仍可继续"
    : "原授权文件仍可使用，本次添加密码未完成";
  job.passwordAddError = message;
  job.lastError = resumeAuthorization ? "点击“继续授权”可恢复 Codex 授权" : null;
  job.runMode = null;
  job.runId = null;
  job.pendingNewPassword = null;
  job.passwordAddResumesAuthorization = false;
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void removePrivateFile(job.passwordAddResultPath).catch(() => {});
  void saveJobMetadata(job).catch(() => {});
  if (job.poolRefreshAction && !resumeAuthorization) void synchronizePoolRefresh(job).catch(() => {});
}

async function loadTotpSetupResult(job) {
  const data = JSON.parse(await fs.readFile(job.totpResultPath, "utf8"));
  if (data?.version !== 1) throw new Error("2FA 设置结果文件格式不正确");
  job.totpSetupReplaceExisting = data?.operation === "replace_totp";
  job.totpRotationRemoteDisabled = Boolean(data?.remote_disabled);
  job.totpRotationStage = typeof data?.stage === "string" ? data.stage : null;
  job.totpRotationIncomplete = data?.operation === "replace_totp" && data?.activation_succeeded !== true;
  if (data.already_enabled) {
    job.totpKnownEnabled = true;
    job.totpSetupSecret = null;
    job.totpSetupUri = null;
    return data;
  }
  const secret = normalizeTotpSecret(data.secret);
  const uri = String(data.otpauth_uri || "");
  if (!uri.startsWith("otpauth://totp/")) throw new Error("2FA 设置地址格式不正确");
  job.totpSetupSecret = secret;
  job.totpSetupUri = uri;
  if (data.activation_mode === "automatic") {
    if (job.status !== "totp_setup_otp") setStage(job, "working", "2FA 密钥已生成，正在自动激活");
  } else {
    setStage(job, "totp_setup_otp", "密钥已生成，请添加到验证器后输入当前 6 位验证码");
  }
  return data;
}

async function finishTotpSetup(job, code, signal) {
  const resumeAuthorization = Boolean(job.totpSetupResumesAuthorization);
  let result = null;
  try {
    result = await loadTotpSetupResult(job);
  } catch (error) {
    if (error?.code !== "ENOENT" && !job.totpSetupError) job.totpSetupError = error.message;
  }

  const activationSucceeded = result?.activation_succeeded === true;
  const replacingTotp = Boolean(job.totpSetupReplaceExisting || result?.operation === "replace_totp");
  let removeResult = false;
  if (code === 0 && result?.already_enabled) {
    job.totpKnownEnabled = true;
    job.prompt = "账号已经启用 2FA，但服务端不会返回原始密钥";
    job.totpSetupError = "如需自动登录，请重新导入这个账号原有的 2FA 密钥";
    removeResult = true;
  } else if ((code === 0 || activationSucceeded) && result?.secret) {
    const secret = normalizeTotpSecret(result.secret);
    job.totpSecret = secret;
    job.hasTotpCredential = true;
    job.totpKnownEnabled = true;
    job.totpRotationRemoteDisabled = false;
    job.totpRotationStage = result?.confirmation_succeeded === false ? "confirmation_failed" : "confirmed";
    job.totpRotationIncomplete = false;
    const persisted = await saveStoredLoginCredentials(job.email, job);
    job.prompt = activationSucceeded && code !== 0
      ? "2FA 已激活并保存，但最终状态确认未完成"
      : resumeAuthorization
        ? "2FA 已设置并安全保存，可以继续未完成的 Codex 授权"
        : "2FA 已设置并安全保存，可以继续下载或重新授权";
    job.totpSetupError = !persisted
      ? "当前系统不支持持久凭据存储，2FA 密钥已保留在私有结果文件中，请不要删除该任务目录"
      : activationSucceeded && code !== 0
      ? "激活接口已返回成功，但后续确认请求失败；密钥已保留"
      : null;
    appendJobLog(job, persisted
      ? (replacingTotp
        ? "[2fa] 2FA 更换成功，新密钥已写入系统凭据存储，未写入协议日志。\n"
        : "[2fa] 2FA 设置成功，密钥已写入系统凭据存储，未写入协议日志。\n")
      : (replacingTotp
        ? "[2fa] 2FA 更换成功，但当前系统不支持持久凭据存储；新密钥已保留在私有结果文件中。\n"
        : "[2fa] 2FA 设置成功，但当前系统不支持持久凭据存储；密钥已保留在私有结果文件中。\n"));
    removeResult = persisted;
  } else {
    const remoteDisabled = Boolean(job.totpRotationRemoteDisabled || result?.remote_disabled);
    job.totpRotationRemoteDisabled = replacingTotp && remoteDisabled;
    job.totpRotationStage = result?.stage || (replacingTotp ? "failed" : null);
    job.totpRotationIncomplete = replacingTotp;
    job.totpKnownEnabled = replacingTotp ? !remoteDisabled : job.totpKnownEnabled;
    job.prompt = replacingTotp && remoteDisabled
      ? "原 2FA 状态可能已关闭，新 2FA 尚未激活；可以重试更换流程"
      : resumeAuthorization
        ? "本次 2FA 设置未完成，原登录检查点仍可继续"
        : "授权文件仍然可用，本次 2FA 设置未完成";
    job.totpSetupError ||= replacingTotp && remoteDisabled
      ? "远端 2FA 状态可能已关闭，结果文件已保留；请重试以完成新密钥激活"
      : signal
        ? `2FA 设置进程被 ${signal} 终止`
        : `2FA 设置进程退出，代码 ${code ?? "未知"}`;
  }

  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.lastError = resumeAuthorization
    ? "ChatGPT 登录状态已保留，点击“继续授权”即可重新开始 Codex 授权"
    : null;
  job.runMode = null;
  job.runId = null;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupReplaceExisting = false;
  job.totpSetupResumesAuthorization = false;
  if (removeResult || (!replacingTotp && (!result?.secret || result?.activation_succeeded === false))) {
    await removePrivateFile(job.totpResultPath);
  }
  touch(job);
  await saveJobMetadata(job);
  if (job.poolRefreshAction && job.status === "completed" && job.resultSaved) await synchronizePoolRefresh(job);
}

async function removePrivateFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function restoreTotpSetupFailure(job, message) {
  const resumeAuthorization = Boolean(job.totpSetupResumesAuthorization);
  const replacingTotp = Boolean(job.totpSetupReplaceExisting);
  // Keep the remote-disabled flag conservative. The protocol persists the
  // disable state before enrollment, and re-checks mfa_info when a retry
  // resumes from the durable result file.
  if (replacingTotp) job.totpRotationIncomplete = true;
  job.status = resumeAuthorization ? "resume_available" : "completed";
  job.prompt = replacingTotp && job.totpRotationRemoteDisabled
    ? "原 2FA 已关闭，新 2FA 尚未激活；可以重试更换流程"
    : resumeAuthorization
    ? "本次 2FA 设置未完成，原登录检查点仍可继续"
    : "授权文件仍然可用，本次 2FA 设置未完成";
  job.totpSetupError = replacingTotp && job.totpRotationRemoteDisabled
    ? `${message}；远端 2FA 状态可能已关闭，结果文件已保留`
    : message;
  job.totpRotationStage = replacingTotp ? (job.totpRotationStage || "failed") : null;
  job.totpSetupSecret = null;
  job.totpSetupUri = null;
  job.totpSetupReplaceExisting = false;
  job.totpSetupResumesAuthorization = false;
  job.lastError = resumeAuthorization ? "点击“继续授权”可恢复 Codex 授权" : null;
  job.runMode = null;
  job.child?.kill("SIGTERM");
  job.child = null;
  if (!replacingTotp) void removePrivateFile(job.totpResultPath).catch(() => {});
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

async function fallbackFromRefresh(job) {
  if (job.runMode !== "refresh" || job.fallbackInProgress) return;
  job.fallbackInProgress = true;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.status = "starting";
  job.prompt = "已有授权状态已过期，正在重新进行邮箱登录";
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  beginAuthorizationAutomationAttempt(job, "refresh_fallback");
  appendJobLog(job, "[refresh] 刷新令牌已失效，自动回退到邮箱验证码登录。\n");
  job.fallbackInProgress = false;
  if (job.status !== "canceled") {
    enqueueJob(job, "full", "刷新令牌已失效，正在重新登录并授权");
  }
  touch(job);
}

function consumeOutput(job, rawText) {
  const proxyAttemptScan = `${job.proxyAttemptParserTail || ""}${rawText}`;
  job.proxyAttemptParserTail = proxyAttemptScan.slice(-160);
  let proxyAttemptNotices = "";
  for (const match of proxyAttemptScan.matchAll(/\[proxy-session-attempt\]\s+([a-f0-9-]{36})/gi)) {
    const attemptId = match[1].toLowerCase();
    if (job.proxySessionAttemptIds.has(attemptId)) continue;
    job.proxySessionAttemptIds.add(attemptId);
    job.proxyRiskRetryCount = Math.min(MAX_PROXY_RISK_RETRIES, (job.proxyRiskRetryCount || 0) + 1);
    job.proxyConnectionFailureCount = 0;
    proxyAttemptNotices += `[proxy] 正在检测第 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个新代理会话。\n`;
    void saveJobMetadata(job).catch(() => {});
  }
  const text = `${proxyAttemptNotices}${sanitizeLog(rawText)}`
    .replace(/^\[proxy-session-attempt\][^\r\n]*(?:\r?\n)?/gim, "");
  job.logs = `${job.logs}${text}`.slice(-MAX_LOG_CHARS);
  const scan = `${job.parserTail}${text}`;
  job.parserTail = scan.slice(-2_000);

  if (scan.includes("[3/5] Password login page reached.")) {
    markAuthorizationRequirement(job, "password");
    if (job.password) markAuthorizationAutomatic(job, "password");
  }
  if (scan.includes("[3/5] Email OTP page reached.")) {
    markAuthorizationRequirement(job, "emailOtp");
  }
  const mailRequestMarkers = [...scan.matchAll(/\[email-otp-requested-at\]\s+(\S+)/g)];
  const latestMailRequestAt = Date.parse(mailRequestMarkers.at(-1)?.[1] || "");
  if (Number.isFinite(latestMailRequestAt)) job.mailOtpRequestedAt = latestMailRequestAt;
  if (job.runMode !== "web_login" && (scan.includes("[checkpoint] Saved verified email login state.")
    || scan.includes("[checkpoint] Updated verified login state after adding the password.")
    || scan.includes("[checkpoint] Updated verified login state after setting 2FA."))) {
    job.loginCheckpointAvailable = true;
  }

  if (scan.includes("[proxy-risk-retry]")) {
    void restartAfterProxyRisk(job, {
      connectionFailure: scan.includes("PROXY_CONNECTION_RETRY"),
    }).catch((error) => {
      finishProxyRiskRetries(job, `自动更换代理会话失败：${error.message}`);
    });
    return;
  }

  if (job.runMode === "refresh" && scan.includes("REFRESH_TOKEN_INVALID")) {
    void fallbackFromRefresh(job);
    return;
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-setup-ready]") && !job.totpResultLoading && !job.totpSetupSecret) {
    job.totpResultLoading = true;
    setStage(job, "working", "2FA 密钥已经生成，正在安全读取");
    void loadTotpSetupResult(job)
      .catch((error) => {
        job.totpSetupError = `无法读取 2FA 密钥：${error.message}`;
        job.child?.kill("SIGTERM");
        touch(job);
      })
      .finally(() => {
        job.totpResultLoading = false;
      });
  }

  if (job.runMode === "totp_setup" && scan.includes("[2fa-already-enabled]")) {
    job.totpKnownEnabled = true;
    setStage(job, "working", "账号已经启用 2FA，正在收尾");
  }

  if (job.runMode === "totp_setup" && scan.includes("[ok] 2FA setup activated")) {
    setStage(job, "working", "2FA 已激活，正在安全保存密钥");
  }

  if (scan.includes("[security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "本次登录需要浏览器安全校验，2FA 尚未设置";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "添加密码需要浏览器安全校验，请稍后重试或更换代理 IP";
      touch(job);
      return;
    }
    requireBrowserSecurityCheck(job);
    return;
  }

  if (scan.includes("[profile-security-check-required]")) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "账号资料校验未通过，2FA 尚未设置";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "账号资料校验未通过，密码尚未添加";
      touch(job);
      return;
    }
    requireProfileSecurityCheck(job);
    return;
  }

  if (scan.includes("ACCOUNT_PROFILE_REQUIRED")) {
    failAccountProfileRequired(job);
    return;
  }

  const sessionErrorLines = [...scan.matchAll(/^\[error\]\s*([^\r\n]+)/gim)];
  const latestSessionError = sessionErrorLines.at(-1)?.[1] || "";
  if (/Your sign-in session is no longer valid|["']code["']\s*:\s*["'](?:invalid_state|invalid_auth_step)["']|Invalid authorization step/i.test(latestSessionError)) {
    if (job.runMode === "totp_setup") {
      job.totpSetupError = "设置 2FA 时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    if (job.runMode === "password_add") {
      job.passwordAddError = "添加密码时登录状态失效，请稍后重试";
      touch(job);
      return;
    }
    requireReauthorization(job, "当前登录状态已经失效，继续更换手机号也无法发送验证码");
    return;
  }

  if (scan.includes("[auth-expired]")) {
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.currentPhone = null;
    job.phoneError = null;
    setStage(job, "starting", "新登录状态被服务端拒绝，正在自动重新获取邮箱验证码");
  }

  if (scan.includes("Email OTP (r=resend, q=quit):")) {
    markAuthorizationRequirement(job, "emailOtp");
    const rejected = scan.includes("[email-otp-rejected]");
    setStage(
      job,
      "email_otp",
      rejected
        ? "邮箱验证码错误，请重新输入或重新发送"
        : job.mailApiUrl
          ? "正在等待收码接口返回新验证码，也可以手动输入"
          : "请输入邮箱验证码",
    );
    if (job.mailApiUrl) void beginMailPolling(job);
  }
  if (scan.includes("Password (q=quit):")) {
    markAuthorizationRequirement(job, "password");
    stopMailPolling(job);
    setStage(job, "password", "请输入账号密码");
  }
  if (scan.includes("2FA setup OTP (6 digits, q=quit):")) {
    setStage(job, "totp_setup_otp", "请将密钥添加到验证器后输入当前 6 位验证码");
  }
  const mfaReachedIndex = scan.lastIndexOf("[mfa] TOTP 2FA challenge reached.");
  const mfaPromptIndex = scan.lastIndexOf("2FA OTP (6 digits, q=quit):");
  if (mfaReachedIndex > mfaPromptIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "working", job.totpSecret ? "正在自动完成 2FA 验证" : "正在准备 2FA 验证");
  } else if (mfaPromptIndex > mfaReachedIndex) {
    markAuthorizationRequirement(job, "mfa");
    setStage(job, "mfa_otp", "请输入 6 位 2FA 验证码");
  }
  if (scan.includes("[mfa] Generated a 6-digit code from the configured 2FA key.")) {
    markAuthorizationAutomatic(job, "mfa");
  }
  const phoneNumberPromptIndex = scan.lastIndexOf("Phone number, E.164 format");
  const phoneOtpPromptIndex = scan.lastIndexOf("Phone OTP (r=resend, p=change phone, q=quit):");
  if (phoneNumberPromptIndex > phoneOtpPromptIndex) {
    stopMailPolling(job);
    setStage(job, "phone", "请输入需要绑定的手机号");
  } else if (phoneOtpPromptIndex > phoneNumberPromptIndex) {
    if (job.smsStatus !== "error") job.phoneError = null;
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `短信验证码已发送至 ${job.currentPhone}` : "请输入手机短信验证码",
    );
    if (job.smsOrderId && job.smsNumber === job.currentPhone) void beginSmsPolling(job);
  }

  const sendFailures = [...scan.matchAll(/\[warn\] Could not send SMS to (\+\d+):\s*([^\r\n]+)/g)];
  if (sendFailures.length) {
    const latest = sendFailures.at(-1);
    job.currentPhone = latest[1];
    job.phoneError = friendlyPhoneError(latest[2]);
    if (job.smsOrderId && job.smsNumber === job.currentPhone) {
      releaseSmsNumber(job, "error", "该平台手机号无法接收验证码，请重新取号或手动输入其他手机号");
    }
    setStage(job, "phone", `手机号 ${job.currentPhone} 无法接收验证码，请更换手机号`);
  }

  const validationFailures = [...scan.matchAll(/\[warn\] Phone OTP validation failed:\s*([^\r\n]+)/g)];
  if (validationFailures.length) {
    const validationMessage = validationFailures.at(-1)[1];
    job.phoneError = friendlyPhoneOtpError(validationMessage);
    stopSmsPolling(job);
    if (job.smsStatus === "submitted") {
      job.smsStatus = "error";
      job.smsError = "平台返回的验证码未通过验证，请重新发送或更换手机号";
    }
    setStage(
      job,
      "phone_otp",
      job.currentPhone ? `请重新输入发送至 ${job.currentPhone} 的验证码` : "请重新输入手机验证码",
    );
    if (shouldChangePhoneAfterOtpFailure(validationMessage)) {
      job.smsError = job.phoneError;
      appendJobLog(job, "[sms] 当前手机号已被服务端拒绝，停止提交旧验证码并自动返回换号步骤。\n");
      void submitJobInput(job, { action: "change_phone", value: "" }, {
        preservePhoneError: true,
      }).catch((error) => {
        failJob(job, `无法自动返回换号步骤：${error.message}`);
      });
      touch(job);
      return;
    }
  }
  if (scan.includes("[ok] Phone OTP validated")) {
    completeSmsNumber(job);
  }
  if (scan.includes("[5/5] Select workspace") || scan.includes("[6/6] Convert OAuth callback")) {
    setStage(job, "finalizing", "正在完成授权并生成文件");
  }
  if (scan.includes("[4/5] Existing workspace/session selected")) {
    setStage(job, "finalizing", "账号已绑定手机号，正在继续授权");
  }
  if (scan.includes("[ok] Saved sub2api import:")) {
    job.resultSaved = true;
    job.runResultSaved = true;
    setStage(job, "finalizing", "导入文件已生成，正在收尾");
  }
  if (scan.includes("[ok] Saved web session:")) {
    job.webSessionAvailable = true;
    if (job.runMode === "web_login") {
      job.webLoginResultSaved = true;
      setStage(job, "finalizing", "Web 登录成功，正在保存会话");
    }
  }
  if (scan.includes("[ok] Account password added and saved securely")) {
    setStage(job, "finalizing", "密码已添加，正在安全保存新密码");
  }
  const errorMatches = [...scan.matchAll(/\[error\]\s*([^\r\n]+)/g)];
  if (errorMatches.length) {
    const errorMessage = extractResponseMessage(errorMatches.at(-1)[1]);
    if (job.runMode === "web_login") {
      job.lastError = errorMessage;
    } else if (job.runMode === "totp_setup") {
      job.totpSetupError = errorMessage;
    } else if (job.runMode === "password_add") {
      job.passwordAddError = errorMessage;
    } else {
      failJob(job, errorMessage);
    }
  }
  touch(job);
}

async function restartAfterProxyRisk(job, options = {}) {
  if (job.proxyRiskRestarting || isTerminalStatus(job.status)) return;
  job.proxyRiskRestarting = true;
  const mode = job.runMode || job.queuedMode || "full";
  const runProxyUrl = accountProxyMode === "plan" && !job.runProxyFixed ? job.runLoginProxyUrl : job.proxyUrl;
  try {
    if (accountProxyMode === "sub2api" || job.runProxyFixed) {
      finishProxyRiskRetries(job, "账号固定代理连接失败或触发安全校验；已保留 IP 绑定，请重试或手动切换 IP");
      return;
    }
    if (!runProxyUrl || job.proxyFallbackActive) {
      if (job.directTlsFallbackAttempted) {
        finishProxyRiskRetries(job, "Cloudflare 安全校验未能完成，直连 TLS 指纹筛选已经使用过，请稍后重试");
        return;
      }
      job.directTlsFallbackAttempted = true;
      const fallbackProfile = await directTlsProfileProbe.resolve();
      appendJobLog(job, `[tls] Cloudflare 求解未完成，正在启用直连 TLS 指纹筛选兜底（${fallbackProfile}）。\n`);
    } else if (!proxySupportsSessionRotation(runProxyUrl)) {
      finishProxyRiskRetries(
        job,
        "当前代理没有可识别的会话编号，无法自动轮换；请更换代理配置后重试",
      );
      return;
    }
    if ((job.proxyRiskRetryCount || 0) >= MAX_PROXY_RISK_RETRIES) {
      finishProxyRiskRetries(job, `代理会话已自动更换 ${MAX_PROXY_RISK_RETRIES} 次，仍然触发安全校验`);
      return;
    }
    if (options.connectionFailure) {
      job.proxyConnectionFailureCount = (job.proxyConnectionFailureCount || 0) + 1;
      if (job.proxyConnectionFailureCount >= MAX_PROXY_CONNECTION_FAILURES) {
        finishProxyRiskRetries(
          job,
          `代理连接连续失败 ${MAX_PROXY_CONNECTION_FAILURES} 次，已停止自动重试`,
        );
        return;
      }
    }

    stopMailPolling(job);
    stopSmsPolling(job);
    releaseSmsNumber(job, "idle");
    job.queueRunId = null;
    job.runId = crypto.randomUUID();
    const restartRunId = job.runId;
    job.child?.kill("SIGTERM");
    job.child = null;
    if (mode === "full") await removePrivateFile(job.checkpointPath);
    job.parserTail = "";
    job.lastError = null;
    job.currentPhone = null;
    job.phoneError = null;
    job.securityCheckRequired = false;
    job.restartRequired = false;
    appendJobLog(
      job,
      options.connectionFailure
        ? `[proxy] 代理连接失败，HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}；连接失败 ${job.proxyConnectionFailureCount}/${MAX_PROXY_CONNECTION_FAILURES}。\n`
        : `[proxy] 登录阶段触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话，正在继续更换。\n`,
    );
    if (options.connectionFailure) {
      const retryDelay = Math.min(
        PROXY_CONNECTION_RETRY_MAX_MS,
        PROXY_CONNECTION_RETRY_BASE_MS * (2 ** Math.min(job.proxyConnectionFailureCount - 1, 4)),
      );
      job.status = "starting";
      job.prompt = `代理连接失败，${Math.ceil(retryDelay / 1_000)} 秒后更换会话`;
      touch(job);
      await saveJobMetadata(job);
      await delay(retryDelay);
      if (job.runId !== restartRunId || isTerminalStatus(job.status)) return;
    }
    job.proxyRiskRestarting = false;
    enqueueJob(
      job,
      mode,
      options.connectionFailure
        ? `代理连接失败，正在更换会话；HTTP 检测次数仍为 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES}`
        : `代理触发安全校验，已使用 ${job.proxyRiskRetryCount}/${MAX_PROXY_RISK_RETRIES} 个代理会话`,
    );
  } finally {
    job.proxyRiskRestarting = false;
  }
}

function finishProxyRiskRetries(job, message) {
  job.proxyRiskRestarting = false;
  const runProxyUrl = accountProxyMode === "plan" && !job.runProxyFixed ? job.runLoginProxyUrl : job.proxyUrl;
  if (accountProxyMode !== "sub2api" && !job.runProxyFixed && allowDirectFallback && runProxyUrl && !job.proxyFallbackAttempted) {
    void fallbackToDirectIp(job, message).catch((error) => {
      finishProxyRiskRetries(job, `本地出口回退失败：${error.message}`);
    });
    return;
  }
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    restoreTotpSetupFailure(job, message);
    return;
  }
  if (job.runMode === "password_add" || job.queuedMode === "password_add") {
    restorePasswordAddFailure(job, message);
    scheduleQueuedJobs();
    return;
  }
  if (job.resultSaved) {
    job.status = "completed";
    job.prompt = "原授权文件仍然可用，自动更换代理未能完成本次操作";
    job.lastError = message;
    job.runMode = null;
    job.child?.kill("SIGTERM");
    job.child = null;
    touch(job);
    void saveJobMetadata(job).catch(() => {});
    scheduleQueuedJobs();
    return;
  }
  failJob(job, message);
  job.child?.kill("SIGTERM");
  job.child = null;
  scheduleQueuedJobs();
}

async function fallbackToDirectIp(job, reason) {
  job.proxyFallbackAttempted = true;
  job.proxyFallbackActive = true;
  const mode = job.runMode || job.queuedMode || "full";
  stopMailPolling(job);
  stopSmsPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  const runId = job.runId;
  job.child?.kill("SIGTERM");
  job.child = null;
  if (mode === "full") await removePrivateFile(job.checkpointPath);
  if (job.runId !== runId || isTerminalStatus(job.status)) return;
  job.proxyRiskRetryCount = 0;
  job.proxyConnectionFailureCount = 0;
  job.directTlsFallbackAttempted = false;
  job.parserTail = "";
  job.lastError = null;
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  appendJobLog(job, `[proxy] ${reason}；按配置回退本地出口 IP，本次任务仅回退一次。\n`);
  enqueueJob(job, mode, "代理不可用，正在回退本地出口 IP");
}

function requireReauthorization(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "reauth_required";
  job.prompt = "登录状态已失效，需要重新授权";
  job.lastError = message;
  job.phoneError = null;
  job.restartRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireBrowserSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "手机号绑定需要浏览器安全校验";
  job.lastError = "邮箱登录已经成功，但服务端拒绝了本次纯协议短信请求；可以手动重试，若仍被拒绝则需要稍后再试";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
}

function requireProfileSecurityCheck(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号资料创建需要安全校验";
  job.lastError = "邮箱验证码已经通过，但账号资料创建仍被 Sentinel 安全校验拒绝；可以点击重新授权再次生成动态校验令牌";
  job.phoneError = null;
  job.securityCheckRequired = true;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function failAccountProfileRequired(job) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "failed";
  job.prompt = "账号注册资料未完成";
  job.lastError = "邮箱验证已经成功，但该邮箱还没有完成账号资料填写。请先在官方页面完成姓名和出生日期后再重新授权。";
  job.phoneError = null;
  job.child?.kill("SIGTERM");
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function markResumeAvailable(job, reason = "登录流程中断") {
  stopMailPolling(job);
  stopSmsPolling(job);
  job.status = "resume_available";
  job.prompt = "邮箱登录检查点仍然有效，可以继续手机号绑定";
  job.lastError = `${reason}，继续时会优先恢复已保存状态；状态失效才重新获取邮箱验证码`;
  job.child = null;
  job.currentPhone = null;
  job.loginCheckpointAvailable = true;
  touch(job);
}

function friendlyPhoneError(message) {
  const text = String(message || "");
  if (/suspicious behavior/i.test(text)) return "该手机号触发了风控，请更换手机号或稍后重试";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) return "短信发送过于频繁，请稍后重试或更换手机号";
  if (/already|used|unsupported|invalid phone/i.test(text)) return "该手机号不可用或已被使用，请更换手机号";
  return "短信验证码发送失败，请更换手机号后重试";
}

function extractResponseMessage(value) {
  const text = String(value || "").trim();
  const jsonAt = text.indexOf("{");
  if (jsonAt >= 0) {
    try {
      const payload = JSON.parse(text.slice(jsonAt));
      const message = payload?.error?.message || payload?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {}
  }
  const match = text.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (match) {
    try {
      return JSON.parse(`"${match[1]}"`).trim();
    } catch {
      return match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").trim();
    }
  }
  return text;
}

function friendlyPhoneOtpError(message) {
  const text = String(message || "");
  if (/phone_recently_used|phone number was recently used/i.test(text)) {
    return "该手机号近期已被使用，已停止重复提交，请更换手机号";
  }
  if (/phone_number_in_use|phone number already in use/i.test(text)) {
    return "该手机号已绑定其他账号，请更换手机号";
  }
  if (/expired/i.test(text)) return "手机验证码已过期，请重新发送或更换手机号";
  if (/too many|rate.?limit|HTTP 429/i.test(text)) {
    return "验证次数过多，已停止自动提交，请稍后更换手机号";
  }
  return "手机验证码不正确，请重新输入；也可以重新发送或更换手机号";
}

function shouldChangePhoneAfterOtpFailure(message) {
  return /phone_recently_used|phone number was recently used|phone_number_in_use|phone number already in use|too many|rate.?limit|HTTP 429/i
    .test(String(message || ""));
}

function acquireCustomSmsEntry(entries) {
  const poolKey = crypto.createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("base64url");
  const nextIndex = customSmsPoolPositions.get(poolKey) || 0;
  if (nextIndex >= entries.length) return null;
  customSmsPoolPositions.set(poolKey, nextIndex + 1);
  return entries[nextIndex];
}

async function acquireSmsNumber(job, providerId, config) {
  requireStage(job, "phone");
  if (job.smsStatus === "requesting") throw httpError(409, "正在获取手机号，请不要重复提交");

  let smsClient;
  try {
    smsClient = createSmsProvider(providerId, config, {
      lubanApiBase: process.env.LUBAN_SMS_API_BASE,
      smsBowerApiBase: process.env.SMSBOWER_API_BASE,
      acquireCustomSmsEntry,
    });
  } catch (error) {
    throw httpError(400, safeSmsProviderError(error, config?.apiKey));
  }

  releaseSmsNumber(job, "idle");
  job.smsClient = smsClient;
  job.smsProviderId = smsClient.id;
  job.smsProviderName = smsClient.name;
  job.smsServiceLabel = smsClient.serviceLabel;
  job.smsStatus = "requesting";
  job.smsError = null;
  touch(job);

  let order;
  try {
    order = await smsClient.getNumber();
    if (job.status !== "phone" || !job.child) {
      void smsClient.release(order.requestId).catch(() => {});
      throw httpError(409, "任务已经不在手机号输入步骤，平台号码已释放");
    }
    job.smsOrderId = order.requestId;
    job.smsNumber = order.number;
    job.smsStatus = "number_acquired";
    job.smsError = null;
    await saveJobMetadata(job);
    appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取手机号并提交，等待短信发送结果。\n`);
    await submitJobInput(job, { action: "phone", value: order.number }, { source: "sms-provider" });
  } catch (error) {
    if (order?.requestId && job.smsOrderId === order.requestId) releaseSmsNumber(job, "error");
    if (job.status === "phone") {
      job.smsStatus = "error";
      job.smsError = safeSmsProviderError(error, smsClient.apiKey);
      if (!order) job.smsClient = null;
      touch(job);
    }
    if (error?.status) throw error;
    throw httpError(502, safeSmsProviderError(error, smsClient.apiKey));
  }
}

async function beginSmsPolling(job) {
  if (
    !job.smsClient
    || !job.smsOrderId
    || job.smsPollToken
    || job.status !== "phone_otp"
    || !["number_acquired", "waiting_sms"].includes(job.smsStatus)
  ) return;
  const pollToken = crypto.randomUUID();
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const startedAt = Date.now();
  job.smsPollToken = pollToken;
  job.smsStatus = "waiting_sms";
  job.smsError = null;
  touch(job);

  try {
    if (smsClient.markReady) {
      await smsClient.markReady(requestId).catch((error) => {
        appendJobLog(job, `[sms] ${smsClient.name} 更新号码就绪状态失败：${safeSmsProviderError(error)}\n`);
      });
    }
    while (
      job.smsPollToken === pollToken &&
      job.smsOrderId === requestId &&
      job.status === "phone_otp" &&
      job.child &&
      Date.now() - startedAt < SMS_POLL_TIMEOUT_MS
    ) {
      try {
        const result = await smsClient.getSms(requestId);
        if (job.smsPollToken !== pollToken || job.status !== "phone_otp" || !job.child) return;
        if (result.status === "received") {
          if (job.smsLastSubmittedCode === result.code) {
            job.smsStatus = "error";
            job.smsError = "接码平台仍返回已提交过的验证码，已停止重复提交";
            appendJobLog(job, `[sms] ${smsClient.name} 返回了已提交过的验证码，已停止本次自动轮询。\n`);
            touch(job);
            return;
          }
          job.smsLastSubmittedCode = result.code;
          job.smsStatus = "submitting";
          job.smsError = null;
          appendJobLog(job, `[sms] 已从 ${smsClient.name} 获取短信验证码并自动提交。\n`);
          await submitJobInput(job, { action: "phone_otp", value: result.code }, { source: "sms-provider" });
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = null;
      } catch (error) {
        if (job.smsPollToken !== pollToken) return;
        if (error?.terminal) {
          job.smsStatus = "error";
          job.smsError = `${safeSmsProviderError(error)}，可以手动输入验证码或更换手机号`;
          touch(job);
          return;
        }
        job.smsStatus = "waiting_sms";
        job.smsError = `${safeSmsProviderError(error)}，正在自动重试`;
        touch(job);
      }
      await delay(SMS_POLL_INTERVAL_MS);
    }

    if (job.smsPollToken === pollToken && job.status === "phone_otp") {
      job.smsStatus = "error";
      job.smsError = "等待平台短信超时，可以手动输入验证码或更换手机号";
      touch(job);
    }
  } finally {
    if (job.smsPollToken === pollToken) {
      job.smsPollToken = null;
      touch(job);
    }
  }
}

function stopSmsPolling(job) {
  job.smsPollToken = null;
}

function releaseSmsNumber(job, nextStatus = "idle", errorMessage = null) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  const providerName = job.smsProviderName || smsClient?.name || "接码平台";
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsNumber = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = nextStatus;
  job.smsError = errorMessage;
  if (nextStatus === "idle") {
    job.smsProviderId = null;
    job.smsProviderName = null;
    job.smsServiceLabel = null;
  }
  if (requestId && smsClient) {
    void smsClient.release(requestId).catch(() => {
      appendJobLog(job, `[sms] ${providerName} 号码释放请求失败，请在平台控制台检查订单。\n`);
    });
  }
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function completeSmsNumber(job) {
  const requestId = job.smsOrderId;
  const smsClient = job.smsClient;
  if (!requestId || !smsClient) return;
  stopSmsPolling(job);
  job.smsOrderId = null;
  job.smsClient = null;
  job.smsLastSubmittedCode = null;
  job.smsStatus = "completed";
  job.smsError = null;
  appendJobLog(job, `[sms] 手机验证码已通过，正在完成 ${smsClient.name} 订单。\n`);
  if (smsClient.complete) {
    void smsClient.complete(requestId).catch((error) => {
      appendJobLog(job, `[sms] ${smsClient.name} 完成订单失败：${safeSmsProviderError(error)}\n`);
      touch(job);
    });
  }
  touch(job);
  if (job.outputPath) void saveJobMetadata(job).catch(() => {});
}

function newSmsState() {
  return {
    smsProviderId: null,
    smsProviderName: null,
    smsServiceLabel: null,
    smsOrderId: null,
    smsNumber: null,
    smsClient: null,
    smsStatus: "idle",
    smsError: null,
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function restoredSmsState(metadata = {}) {
  const orderId = metadata.sms_order_id || metadata.luban_request_id;
  const number = metadata.sms_number || metadata.luban_number;
  if (!orderId || !number) return newSmsState();
  return {
    smsProviderId: metadata.sms_provider_id || "luban",
    smsProviderName: metadata.sms_provider_name || (metadata.sms_provider_id === "smsbower" ? "SMSBower" : "LubanSMS"),
    smsServiceLabel: metadata.sms_service_label || metadata.luban_service_id || null,
    smsOrderId: String(orderId),
    smsNumber: String(number),
    smsClient: null,
    smsStatus: "error",
    smsError: "服务重启后已停止自动收短信，可手动输入验证码或换号",
    smsPollToken: null,
    smsLastSubmittedCode: null,
  };
}

function safeSmsProviderError(error, apiKey = "") {
  let message = String(error?.message || "接码平台请求失败");
  if (apiKey) message = message.replaceAll(apiKey, "<已隐藏密钥>");
  return message
    .replace(/apikey=[^&\s]+/gi, "apikey=<已隐藏>")
    .replace(/api_key=[^&\s]+/gi, "api_key=<已隐藏>")
    .replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 220);
}

async function submitJobInput(job, body, options = {}) {
  if (!job.child || !isActive(job.status)) {
    throw httpError(409, "This login flow is not waiting for input");
  }
  const action = String(body.action || "");
  const rawValue = String(body.value || "");
  const value = rawValue.trim();
  let inputValue = "";

  if (action === "password") {
    requireStage(job, "password");
    if (!rawValue) throw httpError(400, "密码不能为空");
    await saveStoredLoginCredentials(job.email, {
      password: rawValue,
      totpSecret: job.totpSecret,
      proxyUrl: job.proxyUrl,
    });
    job.loginMode = "password";
    job.password = rawValue;
    job.hasPasswordCredential = true;
    markAuthorizationManual(job, "password");
    await saveJobMetadata(job);
    inputValue = rawValue;
    setStage(job, "working", "正在验证账号密码");
  } else if (action === "mfa_otp") {
    requireStage(job, "mfa_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "2FA 验证码必须是 6 位数字");
    inputValue = value;
    markAuthorizationManual(job, "mfa");
    setStage(job, "working", "正在验证 2FA 验证码");
  } else if (action === "totp_setup_otp") {
    requireStage(job, "totp_setup_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "设置 2FA 的验证码必须是 6 位数字");
    inputValue = value;
    setStage(job, "working", "正在激活新的 2FA");
  } else if (action === "email_otp") {
    requireStage(job, "email_otp");
    if (!/^\d{6}$/.test(value)) throw httpError(400, "Email code must be 6 digits");
    stopMailPolling(job);
    job.parserTail = "";
    markAuthorizationManual(job, "emailOtp");
    inputValue = value;
    setStage(job, "working", "正在验证邮箱验证码");
  } else if (action === "resend_email") {
    requireStage(job, "email_otp");
    stopMailPolling(job);
    job.parserTail = "";
    inputValue = "r";
    setStage(job, "working", "正在重新发送邮箱验证码");
  } else if (action === "phone") {
    requireStage(job, "phone");
    if (!/^\+[1-9]\d{6,14}$/.test(value)) throw httpError(400, "Phone number must use E.164 format, for example +60123456789");
    if (options.source !== "sms-provider") releaseSmsNumber(job, "idle");
    job.currentPhone = value;
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", `正在向 ${value} 发送手机验证码`);
  } else if (action === "phone_otp") {
    requireStage(job, "phone_otp");
    if (!/^\d{4,8}$/.test(value)) throw httpError(400, "Phone code must be 4 to 8 digits");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = options.source === "sms-provider" ? "submitted" : "manual_submitted";
    job.phoneError = null;
    inputValue = value;
    setStage(job, "working", "正在验证手机验证码");
  } else if (action === "resend_phone") {
    requireStage(job, "phone_otp");
    stopSmsPolling(job);
    if (job.smsOrderId) job.smsStatus = "number_acquired";
    job.phoneError = null;
    inputValue = "r";
    setStage(job, "working", job.currentPhone ? `正在向 ${job.currentPhone} 重新发送验证码` : "正在重新发送手机验证码");
  } else if (action === "change_phone") {
    requireStage(job, "phone_otp");
    const preservedPhoneError = options.preservePhoneError ? job.phoneError : null;
    releaseSmsNumber(
      job,
      options.preservePhoneError ? "error" : "idle",
      options.preservePhoneError ? preservedPhoneError : null,
    );
    job.currentPhone = null;
    job.phoneError = preservedPhoneError;
    inputValue = "p";
    setStage(
      job,
      "working",
      options.preservePhoneError ? "当前手机号不可用，正在返回换号步骤" : "正在返回手机号输入",
    );
  } else {
    throw httpError(400, "Unsupported input action");
  }

  job.parserTail = "";
  job.child.stdin.write(`${inputValue}\n`);
  touch(job);
}

async function cancelJob(job) {
  if (!isActive(job.status)) return;
  if (job.webLoginPreviousState && (job.runMode === "web_login" || job.queuedMode === "web_login")) {
    job.runId = null;
    job.child?.kill("SIGTERM");
    job.child = null;
    if (!shuttingDown) job.webSessionMaintenancePause = { reason: "canceled", at: new Date().toISOString() };
    await finishWebLogin(job, 1, "SIGTERM", shuttingDown ? "Web 登录因服务停止中断，将由巡检重试" : "Web 登录已取消");
    return;
  }
  if (job.runMode === "totp_setup" || job.queuedMode === "totp_setup") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishTotpSetup(job, 1, "SIGTERM");
    if (!job.totpKnownEnabled && !job.totpRotationRemoteDisabled) {
      job.prompt = job.resultSaved
        ? "授权文件仍然可用，2FA 设置已取消"
        : "2FA 设置已取消，原登录检查点仍可继续";
      job.totpSetupError = "用户取消了本次 2FA 设置";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  if (job.runMode === "password_add" || job.queuedMode === "password_add") {
    stopMailPolling(job);
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    await finishPasswordAdd(job, 1, "SIGTERM");
    if (job.passwordAddError) {
      job.prompt = "原授权文件仍可使用，添加密码已取消";
      job.passwordAddError = "用户取消了本次添加密码";
      touch(job);
      await saveJobMetadata(job);
    }
    scheduleQueuedJobs();
    return;
  }
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  if (!shuttingDown) job.webSessionMaintenancePause = { reason: "canceled", at: new Date().toISOString() };
  const mfaPending = job.status === "mfa_otp";
  job.status = mfaPending ? "mfa_failed" : "canceled";
  job.prompt = mfaPending ? "2FA 未通过，流程已停止" : "流程已取消";
  if (mfaPending) job.lastError = "任务在 2FA 验证阶段停止，验证码未完成校验";
  if (job.poolRefreshAction && !job.poolRefreshReady && !shuttingDown) {
    job.poolRefreshError = "登录授权已取消，请重新登录后更新号池凭据";
    job.poolRefreshDueAt = null;
    clearPoolRefreshTimer(job);
  }
  job.child?.kill("SIGTERM");
  job.child = null;
  touch(job);
  void saveJobMetadata(job).catch(() => {});
  scheduleQueuedJobs();
}

async function cancelAllJobs() {
  const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
  if (!activeJobs.length) return 0;
  queueSchedulingPaused = true;
  try {
    await Promise.all(activeJobs.map((job) => withEmailJobLock(job.email, () => cancelJob(job))));
    await Promise.all(activeJobs.map((job) => saveJobMetadata(job)));
  } finally {
    queueSchedulingPaused = false;
  }
  scheduleQueuedJobs();
  return activeJobs.length;
}

async function downloadResult(res, job) {
  if (!job.resultSaved || !(await fileExists(job.outputPath))) {
    sendJson(res, 409, { error: "The sub2api import file is not ready" });
    return;
  }
  const safeEmail = job.email.replace(/[^a-zA-Z0-9@._+-]/g, "_");
  const payload = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
  payload.accounts = payload.accounts.map((account) => accountWithRemark(account, job));
  const data = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${safeEmail}-sub2api-import-oauth-${downloadTimestamp()}.json"`,
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(data);
}

async function downloadBatchResult(res, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw httpError(400, "请至少选择一个已完成任务");
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多下载 ${MAX_BATCH_JOBS} 个账号`);

  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  const downloadable = selected.filter((job) => job.resultSaved);
  if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");

  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts.map((account) => accountWithRemark(account, job)));
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }

  const payload = Buffer.from(`${JSON.stringify({
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  }, null, 2)}\n`);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="sub2api-import-oauth-${accounts.length}-accounts-${downloadTimestamp()}.json"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

async function buildSub2ApiUploadPayload(downloadable) {
  const accounts = [];
  const proxies = [];
  for (const job of downloadable) {
    if (!(await fileExists(job.outputPath))) throw httpError(409, `${job.email} 的导入文件不存在`);
    const data = JSON.parse(await fs.readFile(job.outputPath, "utf8"));
    if (data.type !== "sub2api-data" || !Array.isArray(data.accounts)) {
      throw httpError(409, `${job.email} 的导入文件格式不正确`);
    }
    accounts.push(...data.accounts.map((account) => accountWithRemark(account, job)));
    if (Array.isArray(data.proxies)) proxies.push(...data.proxies);
  }
  return {
    type: "sub2api-data",
    version: 1,
    exported_at: new Date().toISOString(),
    proxies: uniqueByJson(proxies),
    accounts,
  };
}

async function uploadJobsToSub2Api(selected, config, profileState = snapshotSub2ApiProfileState(), { recoverAuthorization = false } = {}) {
  const downloadable = selected.filter((job) => job.resultSaved && !accountAutomationBlocked(job.email));
  if (downloadable.length === 0) throw httpError(409, "选中的任务里没有已完成的导入文件");
  if (accountProxyMode === "sub2api") {
    const unassigned = downloadable.filter((job) => !normalizeStoredProxyId(job.assignedProxyId));
    const assignments = unassigned.length ? await assignSub2ApiProxies(unassigned) : new Map();
    for (const job of unassigned) {
      const proxy = assignments.get(job.id);
      if (!proxy) continue;
      job.assignedProxyId = proxy.id;
      job.proxyUrl = proxy.url;
      await saveStoredLoginCredentials(job.email, job);
      await saveJobMetadata(job);
    }
    for (const job of downloadable) await refreshJobProxyBinding(job);
  }
  const payload = await buildSub2ApiUploadPayload(downloadable);
  const idempotencyKey = `tosub2-upload-${crypto.randomUUID()}`;
  const accountsByProfile = new Map();
  for (const account of payload.accounts) {
    const accountConfig = await resolveSub2ApiWriteConfig(resolveSub2ApiConfigForAccount(config, account, profileState));
    const { proxy_key: _proxyKey, ...accountData } = account;
    const proxyFields = await sub2ApiProxyFieldsForAccount(accountConfig, sub2ApiAccountEmail(account));
    const credentials = { ...(account.credentials || {}) };
    const extra = buildSub2ApiAccountExtra(account.extra, accountConfig, account);
    const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, account);
    if (accountConfig.modelWhitelist.length) {
      credentials.model_mapping = Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model]));
    }
    const prepared = {
      ...accountData,
      ...(accountName ? { name: accountName } : {}),
      credentials,
      extra,
      status: "active",
      schedulable: !overloadCooldown.isPaused(sub2ApiAccountEmail(account)),
      group_ids: fingerprintGroupIds(accountConfig, account, accountConfig.groupIds.length ? accountConfig.groupIds : (account.group_ids || [])),
      ...proxyFields,
      ...(accountConfig.concurrency !== null ? { concurrency: accountConfig.concurrency } : {}),
      ...(accountConfig.loadFactor !== null ? { load_factor: accountConfig.loadFactor } : {}),
      ...(accountConfig.priority !== null && !accountConfig.importDatePriority?.enabled ? { priority: accountConfig.priority } : {}),
    };
    const profileId = accountConfig.profileId || "default";
    if (!accountsByProfile.has(profileId)) accountsByProfile.set(profileId, { config: accountConfig, accounts: [] });
    accountsByProfile.get(profileId).accounts.push(prepared);
  }

  const results = [];
  let profileBatchIndex = 0;
  let createdCount = 0;
  let updatedCount = 0;
  const updatedAccountIds = [];
  for (const { config: accountConfig, accounts } of accountsByProfile.values()) {
    const listing = await listSub2ApiAccounts(accountConfig, { withMeta: true });
    if (!listing.complete) throw new Error("Sub2API 账号列表不完整，已停止上传以避免创建重复账号");
    const profileNewAccounts = accounts.filter((account) => !listing.accounts.some((remote) => sub2ApiAccountEmail(account) === sub2ApiAccountEmail(remote)));
    // Replace each existing row's PlanType with the uploaded workspace PlanType
    // but keep its original pool import date. New rows join the same day ranks.
    const effective = listing.accounts.map((remote) => {
      const local = accounts.find((account) => sub2ApiAccountEmail(account) === sub2ApiAccountEmail(remote));
      return local ? { ...remote, ...local, id: remote.id, created_at: remote.created_at } : remote;
    });
    const dayPriorities = importDatePriorities([...effective, ...profileNewAccounts], config, profileState);
    const accountsToCreate = [];
    for (const account of accounts) {
      const email = sub2ApiAccountEmail(account);
      const matches = email
        ? listing.accounts.filter((remoteAccount) => sub2ApiAccountEmail(remoteAccount) === email)
        : [];
      if (!matches.length) {
        if (dayPriorities.has(account)) account.priority = dayPriorities.get(account);
        accountsToCreate.push(account);
        continue;
      }
      for (const remoteAccount of matches) {
        const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
        if (!accountId) continue;
        const accountUpdate = await buildSub2ApiAccountUpdate(account, accountConfig, remoteAccount);
        const dated = effective.find((item) => item.id === remoteAccount.id);
        if (dayPriorities.has(dated)) accountUpdate.priority = dayPriorities.get(dated);
        await requestSub2Api(accountConfig, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body: JSON.stringify(accountUpdate),
        });
        const recoveryJob = downloadable.find(job => job.email.toLowerCase() === email);
        if (recoverAuthorization && (remoteAccount.status === "error" || recoveryJob?.poolRefreshRecovery)) {
          await recoverSub2ApiAuthorization(accountConfig, accountId, email, { recoveryJob });
        }
        updatedCount += 1;
        updatedAccountIds.push(accountId);
      }
    }
    if (accountsToCreate.length) {
      createdCount += accountsToCreate.length;
      results.push(await requestSub2Api(accountConfig, "/api/v1/admin/accounts/batch", {
        method: "POST",
        headers: { "Idempotency-Key": `${idempotencyKey}-${profileBatchIndex++}` },
        body: JSON.stringify({ accounts: accountsToCreate }),
      }));
    }
  }
  const datePrioritySync = await refreshImportDatePriorities(config, profileState);
  invalidateSub2ApiAccountStatusCache();
  return {
    selected: selected.length,
    uploaded: downloadable.length,
    skipped: selected.length - downloadable.length,
    created: createdCount,
    updated: updatedCount,
    updatedAccountIds,
    datePrioritySync,
    groupIds: config.groupIds,
    result: results.length === 1 ? results[0] : results,
  };
}

function normalizeSub2ApiConfig(value, options = {}) {
  const config = value && typeof value === "object" ? value : {};
  const fallback = sub2ApiSettingsConfig || sub2ApiMonitorConfig || {};
  const stored = options.inheritStoredFields ? fallback : {};
  const baseUrl = String(config.baseUrl || fallback.baseUrl || "").trim().replace(/\/+$/, "");
  const adminApiKey = String(config.adminApiKey || fallback.adminApiKey || "").trim();
  if (!baseUrl) throw httpError(400, "请填写 Sub2API 后端地址");
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw httpError(400, "Sub2API 后端地址格式不正确");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "Sub2API 后端地址必须使用 HTTP 或 HTTPS");
  }
  if (!adminApiKey || adminApiKey.length > 512 || /[\r\n]/.test(adminApiKey)) {
    throw httpError(400, "请填写有效的 Sub2API 管理员 API Key");
  }
  const rawGroupIds = Array.isArray(config.groupIds)
    ? config.groupIds
    : Object.hasOwn(config, "groupId")
      ? (String(config.groupId || "").trim() ? [config.groupId] : [])
      : Array.isArray(stored.groupIds) ? stored.groupIds : [];
  const groupIds = [...new Set(rawGroupIds.map((value) => String(value).trim()).filter(Boolean))].map((value) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
      throw httpError(400, "目标号池 ID 无效");
    }
    return Number(value);
  });
  const rawProxyId = Object.hasOwn(config, "proxyId") ? config.proxyId : stored.proxyId;
  // Serialized legacy settings use 0 for "no proxy"; treat it as empty rather than
  // rejecting a configuration during the next process start.
  const rawProxyText = rawProxyId === 0 || String(rawProxyId ?? "").trim() === "0"
    ? ""
    : String(rawProxyId ?? "").trim().toLowerCase();
  const proxyText = rawProxyText;
  if (proxyText && ![SUB2API_PROXY_DIRECT, SUB2API_PROXY_BALANCED].includes(proxyText)
    && (!/^\d+$/.test(proxyText) || Number(proxyText) <= 0 || Number(proxyText) > Number.MAX_SAFE_INTEGER)) {
    throw httpError(400, "代理 ID 无效");
  }
  // 0 keeps the account's existing proxy, "direct" clears it, and a number pins it.
  const proxyId = [SUB2API_PROXY_DIRECT, SUB2API_PROXY_BALANCED].includes(proxyText) ? proxyText : proxyText ? Number(proxyText) : 0;
  const concurrency = parseOptionalSub2ApiInteger(
    Object.hasOwn(config, "concurrency") ? config.concurrency : stored.concurrency,
    "并发数",
    0,
    10000,
  );
  const loadFactor = parseOptionalSub2ApiInteger(
    Object.hasOwn(config, "loadFactor") ? config.loadFactor : stored.loadFactor,
    "负载因子",
    0,
    10000,
  );
  const priority = parseOptionalSub2ApiInteger(
    Object.hasOwn(config, "priority") ? config.priority : stored.priority,
    "优先级",
    0,
    10000,
  );
  const accountNameTemplate = normalizeSub2ApiAccountNameTemplate(
    Object.hasOwn(config, "accountNameTemplate") ? config.accountNameTemplate : stored.accountNameTemplate,
  );
  const modelWhitelist = parseSub2ApiModelWhitelist(
    Object.hasOwn(config, "modelWhitelist") ? config.modelWhitelist : stored.modelWhitelist,
  );
  const codexFingerprintMode = String(
    Object.hasOwn(config, "codexFingerprintMode") ? config.codexFingerprintMode : (stored.codexFingerprintMode || "session"),
  ).trim().toLowerCase() || "session";
  if (!["off", "device", "session", "full"].includes(codexFingerprintMode)) {
    throw httpError(400, "Codex 指纹收敛模式无效");
  }
  const wsMode = normalizeSub2ApiWsMode(
    config.wsMode
      ?? config.openaiWsMode
      ?? config.openaiOAuthResponsesWebsocketsV2Mode
      ?? stored.wsMode
      ?? "off",
  );
  const importDatePriority = normalizeImportDatePriority(config.importDatePriority ?? stored.importDatePriority);
  const autoResetCreditEnabled = config.autoResetCreditEnabled ?? stored.autoResetCreditEnabled ?? false;
  if (typeof autoResetCreditEnabled !== "boolean") throw httpError(400, "自动使用重置卡开关必须是布尔值");
  const autoResetCredit5hThresholdPercent = normalizeAutoResetCreditThreshold(config.autoResetCredit5hThresholdPercent ?? stored.autoResetCredit5hThresholdPercent ?? 100, "5h");
  const autoResetCredit7dThresholdPercent = normalizeAutoResetCreditThreshold(config.autoResetCredit7dThresholdPercent ?? stored.autoResetCredit7dThresholdPercent ?? 100, "7d");
  return { baseUrl, adminApiKey, groupIds, proxyId, concurrency, loadFactor, priority, importDatePriority, accountNameTemplate, modelWhitelist, codexFingerprintMode, autoResetCreditEnabled, autoResetCredit5hThresholdPercent, autoResetCredit7dThresholdPercent, wsMode, profileId: String(config.profileId || stored.profileId || "default") };
}

function normalizeAutoResetCreditThreshold(value, label) {
  const validType = typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()));
  const number = validType ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0.1 || number > 100) throw httpError(400, `${label} 自动用重置卡阈值必须为 0.1–100%`);
  return number;
}

function normalizeImportDatePriority(value) {
  if (value === undefined || value === null) return { enabled: false, min: 2, max: 5 };
  if (typeof value !== "object" || Array.isArray(value) || typeof value.enabled !== "boolean") throw httpError(400, "导入日期优先级开关必须是布尔值");
  const min = parseOptionalSub2ApiInteger(value.min, "日期优先级下限", 0, 10000);
  const max = parseOptionalSub2ApiInteger(value.max, "日期优先级上限", 0, 10000);
  if (min === null || max === null || min > max) throw httpError(400, "日期优先级范围必须是 0–10000 的整数，且下限不能大于上限");
  return { enabled: value.enabled, min, max };
}

function accountImportDay(account) {
  const remoteTimestamp = account.created_at ? Date.parse(account.created_at) : Number.NaN;
  if (Number.isFinite(remoteTimestamp)) return importDayFormatter.format(new Date(remoteTimestamp));
  const local = findJobByEmail(sub2ApiAccountEmail(account));
  for (const value of [local?.poolOnly ? null : local?.createdAt]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return importDayFormatter.format(new Date(timestamp));
  }
  return null;
}

function importDatePriorities(accounts, config, profileState) {
  const groups = new Map();
  for (const account of accounts) {
    if (accountSyncBlocked(account)) continue;
    if (account.platform && account.platform !== "openai" || account.type && account.type !== "oauth") continue;
    const accountConfig = resolveSub2ApiConfigForAccount(config, account, profileState);
    const profileId = accountConfig.profileId || "default";
    const rule = accountConfig.importDatePriority;
    const day = accountImportDay(account);
    if (!rule?.enabled || !day) continue;
    if (!groups.has(profileId)) groups.set(profileId, []);
    groups.get(profileId).push({ account, day, rule });
  }
  const priorities = new Map();
  for (const entries of groups.values()) {
    const days = [...new Set(entries.map((entry) => entry.day))].sort();
    const ranks = new Map(days.map((day, index) => [day, index]));
    for (const { account, day, rule } of entries) priorities.set(account, Math.min(rule.max, rule.min + ranks.get(day)));
  }
  return priorities;
}

async function syncImportDatePriorities(config, listing, profileState = snapshotSub2ApiProfileState()) {
  const result = { updated: 0, failed: 0, incomplete: !listing.complete, error: null };
  if (!listing.complete) return { ...result, error: "账号列表不完整，已停止日期优先级同步" };
  const priorities = importDatePriorities(listing.accounts, config, profileState);
  for (const [account, priority] of priorities) {
    const id = normalizeSub2ApiAccountId(account.id);
    if (!id || accountSyncBlocked(account) || sub2ApiAccountPriority(account) === priority) continue;
    try {
      await requestProfileSync(config, `/api/v1/admin/accounts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ priority }) });
      account.priority = priority;
      result.updated += 1;
    } catch (error) {
      result.failed += 1;
      result.error ||= String(error?.message || error).slice(0, 500);
    }
  }
  return result;
}

async function refreshImportDatePriorities(config, profileState = snapshotSub2ApiProfileState()) {
  profileState ||= snapshotSub2ApiProfileState();
  if (!config.importDatePriority?.enabled && ![...profileState.profiles.values()].some((profile) => profile.importDatePriority?.enabled)) return null;
  try {
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    const result = await syncImportDatePriorities(config, listing, profileState);
    if (result.updated) invalidateSub2ApiAccountStatusCache();
    return result;
  } catch (error) {
    return { updated: 0, failed: 0, error: String(error?.message || error).slice(0, 500) };
  }
}

function normalizeSub2ApiProxyId(stored = {}) {
  const raw = stored.proxyId ?? "";
  if (raw === 0 || String(raw).trim() === "0") return "";
  const text = String(raw).trim().toLowerCase();
  return text === SUB2API_PROXY_DIRECT ? SUB2API_PROXY_DIRECT : text;
}

function normalizeSub2ApiProfile(value, fallback = {}, id = "default") {
  const source = value && typeof value === "object" ? value : {};
  const merged = { ...fallback, ...source };
  merged.proxyId = normalizeSub2ApiProxyId(merged);
  const normalized = normalizeSub2ApiConfig({
    baseUrl: "http://127.0.0.1",
    adminApiKey: "profile-placeholder-key",
    ...merged,
  });
  const profileId = String(source.id ?? id).trim().slice(0, 128) || id;
  const name = String(source.name ?? profileId).trim().slice(0, 128) || profileId;
  return {
    id: profileId,
    name,
    ...Object.fromEntries(SUB2API_PROFILE_FIELDS.map((field) => [field, normalized[field]])),
  };
}

function profileConfig(profile, globalConfig) {
  if (!profile) return { ...globalConfig, profileId: globalConfig?.profileId || "default" };
  return {
    ...globalConfig,
    ...profile,
    profileId: profile.id,
    baseUrl: globalConfig.baseUrl,
    adminApiKey: globalConfig.adminApiKey,
  };
}

function normalizeSub2ApiPlanTypeBindings(value, profiles = sub2ApiProfiles) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const profileMap = profiles instanceof Map ? profiles : new Map();
  const bindings = {};
  for (const [rawPlanType, rawProfileId] of Object.entries(value)) {
    const planType = normalizePlanType(rawPlanType);
    const profileId = String(rawProfileId ?? "").trim();
    if (!planType || !profileId || !profileMap.has(profileId)) continue;
    const canonicalPlanType = planType.toLowerCase();
    if (["__proto__", "constructor", "prototype"].includes(canonicalPlanType)) continue;
    bindings[canonicalPlanType] = profileId;
  }
  return bindings;
}

function resolveSub2ApiProfileBinding(planType, bindings = sub2ApiPlanTypeBindings) {
  const normalized = normalizePlanType(planType);
  if (!normalized || !bindings || typeof bindings !== "object") return "";
  if (Object.hasOwn(bindings, normalized) && bindings[normalized]) return String(bindings[normalized]);
  const lower = normalized.toLowerCase();
  const match = Object.entries(bindings).find(([key]) => String(key).toLowerCase() === lower);
  return match ? String(match[1] || "") : "";
}

function normalizeSub2ApiProfileState(value, baseConfig) {
  const source = value && typeof value === "object" ? value : {};
  if (!Array.isArray(source.profiles)) return null;
  const profiles = new Map();
  for (const item of source.profiles) {
    const id = String(item?.id || "").trim();
    if (id) {
      const normalized = normalizeSub2ApiProfile(item, {}, id);
      profiles.set(normalized.id, normalized);
    }
  }
  if (!profiles.size) return null;
  if (!profiles.has("default")) {
    profiles.set("default", normalizeSub2ApiProfile({ ...baseConfig, id: "default" }, {}, "default"));
  }
  const bindings = normalizeSub2ApiPlanTypeBindings(source.planTypeBindings, profiles);
  return { profiles, bindings };
}

function resolveSub2ApiConfigForAccount(baseConfig, account, requestProfileState = null) {
  const planType = normalizePlanType(extractPlanTypeFromAccount(account, { preferJwt: false }) || "");
  const profileState = requestProfileState || { profiles: sub2ApiProfiles, bindings: sub2ApiPlanTypeBindings };
  const binding = resolveSub2ApiProfileBinding(planType, profileState.bindings);
  // Explicit upload config remains authoritative for legacy callers. A bound
  // plan type is the only case where the persisted profile overrides it.
  if (!binding) return { ...baseConfig, profileId: baseConfig?.profileId || "default" };
  const profileId = String(binding);
  const profile = profileState.profiles.get(profileId) || profileState.profiles.get("default");
  return profile ? profileConfig(profile, baseConfig) : { ...baseConfig, profileId };
}

function applySub2ApiSettingsBody(body = {}) {
  const rawConfig = body.config && typeof body.config === "object" ? body.config : body;
  const config = normalizeSub2ApiConfig(rawConfig, { inheritStoredFields: true });
  const rawProfiles = Array.isArray(body.profiles)
    ? body.profiles
    : Array.isArray(rawConfig.profiles) ? rawConfig.profiles : null;
  const nextProfiles = new Map();
  if (rawProfiles) {
    for (const item of rawProfiles) {
      const id = String(item?.id || "").trim();
      if (!id || id.length > 128) throw httpError(400, "配置方案 ID 无效");
      const previous = sub2ApiProfiles.get(id) || {};
      const normalized = normalizeSub2ApiProfile(item, previous, id);
      nextProfiles.set(normalized.id, normalized);
    }
  } else {
    // Older clients only send the legacy top-level profile fields. Preserve
    // every stored profile in that case and update only the active one.
    for (const [id, profile] of sub2ApiProfiles.entries()) {
      nextProfiles.set(profile.id || id, { ...profile });
    }
    const profileId = String(rawConfig.profileId || sub2ApiActiveProfileId || "default").trim() || "default";
    const previous = nextProfiles.get(profileId) || {};
    nextProfiles.set(profileId, normalizeSub2ApiProfile(rawConfig, previous, profileId));
  }
  if (!nextProfiles.size) {
    const profileId = String(rawConfig.profileId || sub2ApiActiveProfileId || "default");
    const normalized = normalizeSub2ApiProfile(rawConfig, sub2ApiProfiles.get(profileId) || {}, profileId);
    nextProfiles.set(normalized.id, normalized);
  }
  if (!nextProfiles.has("default")) {
    nextProfiles.set("default", normalizeSub2ApiProfile({ ...config, id: "default" }, {}, "default"));
  }
  sub2ApiProfiles = nextProfiles;
  const bindings = body.planTypeBindings ?? rawConfig.planTypeBindings ?? sub2ApiPlanTypeBindings;
  sub2ApiPlanTypeBindings = normalizeSub2ApiPlanTypeBindings(bindings, sub2ApiProfiles);
  sub2ApiActiveProfileId = String(
    body.activeProfileId
      || rawConfig.activeProfileId
      || rawConfig.profileId
      || sub2ApiActiveProfileId
      || "default",
  );
  if (!sub2ApiProfiles.has(sub2ApiActiveProfileId)) sub2ApiActiveProfileId = "default";
  sub2ApiSettingsConfig = profileConfig(sub2ApiProfiles.get(sub2ApiActiveProfileId), config);
  return sub2ApiSettingsConfig;
}

function normalizeSub2ApiAccountNameTemplate(value) {
  const text = String(value ?? "").trim();
  if (text.length > 256) throw httpError(400, "账号命名模板最多 256 个字符");
  if (/[\r\n]/.test(text)) throw httpError(400, "账号命名模板不能包含换行");
  const unsupported = [...text.matchAll(/\{([^{}]*)\}/g)]
    .map((match) => match[1])
    .filter((key) => !SUB2API_ACCOUNT_NAME_TEMPLATE_KEYS.has(key));
  if (unsupported.length) {
    throw httpError(400, `账号命名模板包含不支持的占位符：${unsupported[0]}`);
  }
  return text;
}

function renderSub2ApiAccountName(template, account) {
  if (!template) return String(account?.name || "").trim().slice(0, 256);
  const email = sub2ApiAccountEmail(account) || "";
  const planType = extractPlanTypeFromAccount(account, { preferJwt: false }) || "";
  const planTypeDisp = displayPlanTypeLabel(planType);
  const accountId = String(
    account?.id
      ?? account?.account_id
      ?? account?.credentials?.chatgpt_account_id
      ?? account?.credentials?.account_id
      ?? account?.credentials?.accountId
      ?? "",
  ).trim();
  const values = {
    email,
    planType,
    planType_disp: planTypeDisp,
    plan_type: planType,
    accountId,
    account_id: accountId,
    id: accountId,
    name: String(account?.name || "").trim(),
  };
  const rendered = template.replace(/\{(email|planType_disp|planType|plan_type|accountId|account_id|id|name)\}/g, (_match, key) => values[key] || "").trim();
  return (rendered || values.name || email).slice(0, 256);
}

function displayPlanTypeLabel(planType) {
  const raw = normalizePlanType(planType);
  if (!raw) return "";
  if (planTypeLabelMapping[raw]) return planTypeLabelMapping[raw];
  const lower = raw.toLowerCase();
  const match = Object.entries(planTypeLabelMapping).find(([key]) => String(key).toLowerCase() === lower);
  return match ? String(match[1]) : raw;
}

function normalizeSub2ApiWsMode(value) {
  const mode = String(value ?? "").trim().toLowerCase() || "off";
  if (!SUB2API_WS_MODES.has(mode)) throw httpError(400, "Sub2API WS mode 无效");
  return mode;
}

function buildSub2ApiAccountExtra(value, config, account = {}) {
  const extra = value && typeof value === "object" ? { ...value } : {};
  // OpenAI OAuth accounts imported by toSub2 are always opted out of model
  // training. Keep this in the shared payload builder so new uploads,
  // workspace switches, and credential repairs use the same privacy state.
  extra.privacy_mode = "training_off";
  extra.codex_fingerprint_mode = config.codexFingerprintMode;
  if (account.parent_account_id == null) {
    extra.auto_reset_credit_enabled = config.autoResetCreditEnabled === true;
    extra.auto_reset_credit_5h_threshold = config.autoResetCredit5hThresholdPercent / 100;
    extra.auto_reset_credit_7d_threshold = config.autoResetCredit7dThresholdPercent / 100;
  }
  else for (const key of ["auto_reset_credit_enabled", "auto_reset_credit_5h_threshold", "auto_reset_credit_7d_threshold"]) delete extra[key];
  delete extra.codex_auto_reset_credit_state;
  extra.openai_oauth_responses_websockets_v2_mode = config.wsMode;
  extra.openai_oauth_responses_websockets_v2_enabled = config.wsMode !== "off";
  delete extra.responses_websockets_v2_enabled;
  delete extra.openai_ws_enabled;
  return extra;
}

function readDurationEnv(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function initialMaxActiveJobs() {
  const value = Number(process.env.TOSUB2_MAX_ACTIVE_JOBS);
  return Number.isInteger(value) && value >= 1 && value <= MAX_ACTIVE_JOBS_LIMIT
    ? value : DEFAULT_MAX_ACTIVE_JOBS;
}

function validateMaxActiveJobs(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVE_JOBS_LIMIT) {
    throw httpError(400, `同时运行任务数必须是 1 到 ${MAX_ACTIVE_JOBS_LIMIT} 的整数`);
  }
  return value;
}

function normalizeTaskAutoActions(value) {
  if (value === undefined) return Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "PlanType 自动任务配置必须是对象");
  }
  const normalized = Object.create(null);
  for (const [rawPlanType, rawActions] of Object.entries(value).slice(0, 100)) {
    const planType = normalizePlanType(rawPlanType);
    if (!planType || ["__proto__", "constructor", "prototype"].includes(planType.toLowerCase())) continue;
    if (!Array.isArray(rawActions)) throw httpError(400, `PlanType ${planType} 的自动任务必须是数组`);
    const actions = [...new Set(rawActions.map((action) => String(action || "").trim()).filter(Boolean))];
    if (actions.some((action) => !TASK_AUTO_ACTIONS.has(action))) {
      throw httpError(400, `PlanType ${planType} 的自动任务包含不支持的命令`);
    }
    if (actions.length) normalized[planType] = [
      ...actions.filter((action) => !["enable-overload-detection", "enable-overload-cooldown"].includes(action)),
      ...["enable-overload-detection", "enable-overload-cooldown"].filter((action) => actions.includes(action)),
    ];
  }
  return normalized;
}

function taskAutoActionsForPlanType(planType) {
  const normalized = normalizePlanType(planType).toLowerCase();
  if (!normalized) return [];
  const match = Object.entries(taskAutoActions).find(([key]) => key.toLowerCase() === normalized);
  return match ? [...match[1]] : [];
}

function publicTaskSettings(includeProxy = true) {
  return {
    maxActiveJobs,
    ...(includeProxy ? { proxyUrl: globalProxyUrl || "" } : {}),
    accountProxyMode,
    codexAuthMode,
    accountProxyCooldownMinutes,
    overloadAutoCooldown: { ...overloadAutoCooldownSettings },
    webSessionMonitor: { ...webSessionMonitorSettings },
    modelFingerprint: modelFingerprint.settings,
    monitoring: { ...monitoringSettings },
    allowDirectFallback,
    min: 1,
    max: MAX_ACTIVE_JOBS_LIMIT,
    default: DEFAULT_MAX_ACTIVE_JOBS,
    autoActions: Object.fromEntries(Object.entries(taskAutoActions).map(([key, actions]) => [key, [...actions]])),
    autoActionOptions: Object.entries(TASK_AUTO_ACTION_LABELS).map(([value, label]) => ({ value, label })),
  };
}

async function loadTaskSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(TASK_SETTINGS_PATH, "utf8"));
    maxActiveJobs = validateMaxActiveJobs(saved.maxActiveJobs);
    taskAutoActions = normalizeTaskAutoActions(saved.autoActions);
    globalProxyUrl = saved.proxyUrl ? normalizeProxyUrl(saved.proxyUrl) : null;
    allowDirectFallback = saved.allowDirectFallback === true;
    accountProxyMode = normalizeAccountProxyMode(saved.accountProxyMode);
    codexAuthMode = normalizeCodexAuthMode(saved.codexAuthMode);
    accountProxyCooldownMinutes = normalizeCooldownMinutes(saved.accountProxyCooldownMinutes);
    overloadAutoCooldownSettings = normalizeOverloadCooldown(saved.overloadAutoCooldown);
    webSessionMonitorSettings = normalizeWebSessionMonitor(saved.webSessionMonitor);
    monitoringSettings = normalizeMonitoring(saved.monitoring, monitoringDefaults);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`任务设置读取失败：${error.message}`);
    }
    taskAutoActions = Object.create(null);
  }
}

async function saveTaskSettings(body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (Object.hasOwn(source, "monitoring")) {
    try { normalizeMonitoring(source.monitoring, monitoringSettings); }
    catch (error) { throw httpError(400, error.message); }
  }
  let nextWebSessionMonitor = webSessionMonitorSettings;
  if (Object.hasOwn(source, "webSessionMonitor")) {
    try { nextWebSessionMonitor = normalizeWebSessionMonitor(source.webSessionMonitor); }
    catch (error) { throw httpError(400, error.message); }
  }
  if (Object.hasOwn(source, "modelFingerprint") && (!source.modelFingerprint || typeof source.modelFingerprint !== "object" || Array.isArray(source.modelFingerprint))) throw httpError(400, "降智检测默认规则必须为对象");
  const fingerprintPatch = Object.hasOwn(source, "modelFingerprint") ? Object.fromEntries(["models", "intervalMinutes", "minProbability", "maxConcurrentAccounts"].filter(key => Object.hasOwn(source.modelFingerprint, key)).map(key => [key, source.modelFingerprint[key]])) : null;
  if (fingerprintPatch) {
    try { normalizeFingerprintSettings({ ...modelFingerprint.settings, ...fingerprintPatch }); }
    catch (error) { throw httpError(400, error.message); }
  }
  let nextCodexAuthMode = codexAuthMode;
  if (Object.hasOwn(source, "codexAuthMode")) {
    try { nextCodexAuthMode = normalizeCodexAuthMode(source.codexAuthMode); }
    catch (error) { throw httpError(400, error.message); }
    if (nextCodexAuthMode === "sub2api" && (!sub2ApiSettingsConfig?.baseUrl || !sub2ApiSettingsConfig?.adminApiKey)) {
      throw httpError(409, "请先保存 Sub2API 后端地址和管理员 API Key，再选择 Sub2API 授权");
    }
  }
  const nextLimit = Object.hasOwn(source, "maxActiveJobs") ? validateMaxActiveJobs(source.maxActiveJobs) : maxActiveJobs;
  const nextAutoActions = normalizeTaskAutoActions(
    Object.hasOwn(source, "autoActions") ? source.autoActions : taskAutoActions,
  );
  const nextProxyUrl = Object.hasOwn(source, "proxyUrl")
    ? (String(source.proxyUrl || "").trim() ? normalizeProxyUrl(source.proxyUrl) : null)
    : globalProxyUrl;
  const nextAllowDirectFallback = Object.hasOwn(source, "allowDirectFallback")
    ? source.allowDirectFallback === true
    : allowDirectFallback;
  const nextAccountProxyMode = Object.hasOwn(source, "accountProxyMode")
    ? validateAccountProxyMode(source.accountProxyMode)
    : accountProxyMode;
  const nextCooldownMinutes = Object.hasOwn(source, "accountProxyCooldownMinutes")
    ? normalizeCooldownMinutes(source.accountProxyCooldownMinutes)
    : accountProxyCooldownMinutes;
  let nextOverloadAutoCooldown = overloadAutoCooldownSettings;
  if (Object.hasOwn(source, "overloadAutoCooldown")) {
    try { nextOverloadAutoCooldown = normalizeOverloadCooldown(source.overloadAutoCooldown); }
    catch (error) { throw httpError(400, error.message); }
  }
  // Serialize writes so memory and the last persisted setting always agree.
  const operation = taskSettingsWritePromise.catch(() => {}).then(async () => {
    const effectiveMonitoring = Object.hasOwn(source, "monitoring") ? normalizeMonitoring(source.monitoring, monitoringSettings) : monitoringSettings;
    const nextFingerprint = fingerprintPatch ? normalizeFingerprintSettings({ ...modelFingerprint.settings, ...fingerprintPatch }) : null;
    const effectiveLimit = Object.hasOwn(source, "maxActiveJobs") ? nextLimit : maxActiveJobs;
    const effectiveAutoActions = Object.hasOwn(source, "autoActions") ? nextAutoActions : taskAutoActions;
    const effectiveProxyUrl = Object.hasOwn(source, "proxyUrl") ? nextProxyUrl : globalProxyUrl;
    const effectiveFallback = Object.hasOwn(source, "allowDirectFallback") ? nextAllowDirectFallback : allowDirectFallback;
    const effectiveAccountProxyMode = Object.hasOwn(source, "accountProxyMode") ? nextAccountProxyMode : accountProxyMode;
    const effectiveCodexAuthMode = Object.hasOwn(source, "codexAuthMode") ? nextCodexAuthMode : codexAuthMode;
    const effectiveCooldownMinutes = Object.hasOwn(source, "accountProxyCooldownMinutes") ? nextCooldownMinutes : accountProxyCooldownMinutes;
    const effectiveOverloadAutoCooldown = Object.hasOwn(source, "overloadAutoCooldown") ? nextOverloadAutoCooldown : overloadAutoCooldownSettings;
    const effectiveWebSessionMonitor = Object.hasOwn(source, "webSessionMonitor") ? nextWebSessionMonitor : webSessionMonitorSettings;
    const tempPath = `${TASK_SETTINGS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify({
        version: 2,
        maxActiveJobs: effectiveLimit,
        autoActions: Object.fromEntries(Object.entries(effectiveAutoActions).map(([key, actions]) => [key, [...actions]])),
        proxyUrl: effectiveProxyUrl || "",
        allowDirectFallback: effectiveFallback,
        accountProxyMode: effectiveAccountProxyMode,
        codexAuthMode: effectiveCodexAuthMode,
        accountProxyCooldownMinutes: effectiveCooldownMinutes,
        overloadAutoCooldown: effectiveOverloadAutoCooldown,
        webSessionMonitor: effectiveWebSessionMonitor,
        monitoring: effectiveMonitoring,
      }, null, 2)}\n`, { mode: 0o600 });
      const previousSettingsBytes = nextFingerprint ? await fs.readFile(TASK_SETTINGS_PATH).catch(error => { if (error.code === "ENOENT") return null; throw error; }) : null;
      await fs.rename(tempPath, TASK_SETTINGS_PATH);
      if (nextFingerprint) {
        try { await modelFingerprint.saveSettings(nextFingerprint); }
        catch (error) { if (previousSettingsBytes) await fs.writeFile(TASK_SETTINGS_PATH, previousSettingsBytes, { mode: 0o600 }); else await fs.rm(TASK_SETTINGS_PATH, { force: true }); throw error; }
      }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    maxActiveJobs = effectiveLimit;
    taskAutoActions = effectiveAutoActions;
    globalProxyUrl = effectiveProxyUrl;
    allowDirectFallback = effectiveFallback;
    accountProxyMode = effectiveAccountProxyMode;
    codexAuthMode = effectiveCodexAuthMode;
    accountProxyCooldownMinutes = effectiveCooldownMinutes;
    overloadAutoCooldownSettings = effectiveOverloadAutoCooldown;
    webSessionMonitorSettings = effectiveWebSessionMonitor;
    const previousMonitoring = monitoringSettings;
    monitoringSettings = effectiveMonitoring;
    applyMonitoringSettings(previousMonitoring);
    webSessionMonitor.trigger(Object.hasOwn(source, "webSessionMonitor"));
    overloadCooldown.trigger();
    // Reducing the limit leaves running jobs alone; they drain before new work
    // starts. Increasing it immediately makes extra slots available.
    scheduleQueuedJobs();
    return publicTaskSettings();
  });
  taskSettingsWritePromise = operation;
  return operation;
}

function parseOptionalSub2ApiInteger(value, label, min, max) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw httpError(400, `${label}必须是数字`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw httpError(400, `${label}范围必须是 ${min} 到 ${max}`);
  return parsed;
}

function parseSub2ApiModelWhitelist(value) {
  const models = String(value || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (models.length > 200) throw httpError(400, "支持模型最多填写 200 个");
  if (models.some((model) => model.length > 200 || /[\r\n]/.test(model))) throw httpError(400, "支持模型名称格式不正确");
  return [...new Set(models)];
}

function requestSub2Api(config, endpoint, options = {}) {
  const requestPromise = performSub2ApiRequest(config, endpoint, options);
  sub2ApiRequestPromises.add(requestPromise);
  void requestPromise.then(
    () => sub2ApiRequestPromises.delete(requestPromise),
    () => sub2ApiRequestPromises.delete(requestPromise),
  );
  return requestPromise;
}

async function performSub2ApiRequest(config, endpoint, options = {}) {
  const { timeoutMs = 120_000, ...fetchOptions } = options;
  const controller = new AbortController();
  sub2ApiRequestControllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${endpoint}`, {
      ...fetchOptions,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": config.adminApiKey,
        ...(fetchOptions.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = sub2ApiResponseMessage(payload, text).slice(0, 500);
      const error = httpError(502, `Sub2API 返回 HTTP ${response.status}${message ? `：${message}` : ""}`);
      error.remoteStatus = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.status) throw error;
    if (error?.name === "AbortError") {
      throw httpError(shuttingDown ? 503 : 504, shuttingDown ? "Sub2API 请求已因服务关闭而取消" : "Sub2API 请求超时");
    }
    throw httpError(502, `无法连接 Sub2API 后端：${error.message}`);
  } finally {
    clearTimeout(timeout);
    sub2ApiRequestControllers.delete(controller);
  }
}

function sub2ApiResponseMessage(payload, text) {
  const message = payload?.error?.message || payload?.message || payload?.error || "";
  return typeof message === "string" && message.trim()
    ? message.trim()
    : extractResponseMessage(text);
}

function serializeSub2ApiConfig(config) {
  return {
    baseUrl: config.baseUrl,
    adminApiKey: config.adminApiKey,
    groupIds: config.groupIds,
    proxyId: config.proxyId,
    concurrency: config.concurrency,
    loadFactor: config.loadFactor,
    priority: config.priority,
    importDatePriority: config.importDatePriority,
    accountNameTemplate: config.accountNameTemplate,
    modelWhitelist: config.modelWhitelist,
    codexFingerprintMode: config.codexFingerprintMode,
    autoResetCreditEnabled: config.autoResetCreditEnabled,
    autoResetCredit5hThresholdPercent: config.autoResetCredit5hThresholdPercent,
    autoResetCredit7dThresholdPercent: config.autoResetCredit7dThresholdPercent,
    wsMode: config.wsMode,
    profileId: config.profileId || "default",
  };
}

function publicSub2ApiConfig(config) {
  if (!config) return null;
  const { adminApiKey: _adminApiKey, ...publicConfig } = serializeSub2ApiConfig(config);
  return publicConfig;
}

function publicSub2ApiSettingsState() {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  const publicProfiles = [...sub2ApiProfiles.values()].map((profile) => ({ ...profile }));
  return {
    configured: Boolean(config?.baseUrl && config?.adminApiKey),
    hasAdminApiKey: Boolean(config?.adminApiKey),
    monitorEnabled: Boolean(sub2ApiMonitorConfig?.enabled),
    config: publicSub2ApiConfig(config),
    baseUrl: config?.baseUrl || null,
    profiles: publicProfiles,
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
  };
}

async function loadSub2ApiSettingsConfiguration() {
  try {
    const saved = JSON.parse(await fs.readFile(SUB2API_SETTINGS_PATH, "utf8"));
    let needsMigration = saved.version !== 2 || !Array.isArray(saved.profiles);
    sub2ApiSettingsConfig = normalizeSub2ApiConfig(saved.config || saved);
    sub2ApiProfiles = new Map();
    const profiles = Array.isArray(saved.profiles) ? saved.profiles : [];
    for (const item of profiles) {
      const id = String(item?.id || "").trim();
      if (id) {
        const normalized = normalizeSub2ApiProfile(item, {}, id);
        sub2ApiProfiles.set(normalized.id, normalized);
      }
    }
    if (!sub2ApiProfiles.size) {
      sub2ApiProfiles.set("default", normalizeSub2ApiProfile(saved.config || {}, {}, "default"));
    } else if (!sub2ApiProfiles.has("default")) {
      // Keep the settings invariant even for hand-edited or partially written
      // v2 files. The first profile remains available under its original ID.
      const firstProfile = sub2ApiProfiles.values().next().value;
      sub2ApiProfiles.set("default", normalizeSub2ApiProfile({ ...firstProfile, id: "default" }, {}, "default"));
      needsMigration = true;
    }
    sub2ApiActiveProfileId = String(saved.activeProfileId || sub2ApiSettingsConfig.profileId || "default");
    if (!sub2ApiProfiles.has(sub2ApiActiveProfileId)) {
      sub2ApiActiveProfileId = sub2ApiProfiles.has("default")
        ? "default"
        : sub2ApiProfiles.keys().next().value;
      needsMigration = true;
    }
    sub2ApiPlanTypeBindings = normalizeSub2ApiPlanTypeBindings(saved.planTypeBindings, sub2ApiProfiles);
    sub2ApiSettingsConfig = profileConfig(sub2ApiProfiles.get(sub2ApiActiveProfileId), sub2ApiSettingsConfig);
    if (needsMigration) await persistSub2ApiSettingsConfiguration();
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] Sub2API 设置配置无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    sub2ApiSettingsConfig = null;
  }
}

async function persistSub2ApiSettingsConfiguration() {
  if (!sub2ApiSettingsConfig) return;
  const payload = {
    version: 2,
    config: serializeSub2ApiConfig(sub2ApiSettingsConfig),
    profiles: [...sub2ApiProfiles.values()].map((profile) => ({ ...profile })),
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${SUB2API_SETTINGS_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, SUB2API_SETTINGS_PATH);
}

async function loadSub2ApiMonitorConfiguration() {
  try {
    const saved = JSON.parse(await fs.readFile(SUB2API_MONITOR_PATH, "utf8"));
    if (!sub2ApiSettingsConfig) {
      // Older deployments only persisted the monitor file. Migrate its
      // connection/profile fields once, then use the canonical settings state.
      const legacyConfig = normalizeSub2ApiConfig(saved.config || saved);
      sub2ApiSettingsConfig = legacyConfig;
      if (!sub2ApiProfiles.size) {
        const savedProfiles = Array.isArray(saved.profiles) ? saved.profiles : [];
        for (const item of savedProfiles) {
          const id = String(item?.id || "").trim();
          if (!id) continue;
          const normalized = normalizeSub2ApiProfile(item, {}, id);
          sub2ApiProfiles.set(normalized.id, normalized);
        }
      }
      if (!sub2ApiProfiles.size) sub2ApiProfiles.set("default", normalizeSub2ApiProfile(legacyConfig, {}, "default"));
      if (!sub2ApiProfiles.has("default")) {
        const firstProfile = sub2ApiProfiles.values().next().value;
        sub2ApiProfiles.set("default", normalizeSub2ApiProfile({ ...firstProfile, id: "default" }, {}, "default"));
      }
      sub2ApiPlanTypeBindings = normalizeSub2ApiPlanTypeBindings(saved.planTypeBindings, sub2ApiProfiles);
      sub2ApiActiveProfileId = String(saved.activeProfileId || "default");
      if (!sub2ApiProfiles.has(sub2ApiActiveProfileId)) sub2ApiActiveProfileId = "default";
      sub2ApiSettingsConfig = profileConfig(sub2ApiProfiles.get(sub2ApiActiveProfileId), legacyConfig);
      await persistSub2ApiSettingsConfiguration();
    }
    sub2ApiMonitorConfig = { ...sub2ApiSettingsConfig, enabled: saved.enabled === true };
    sub2ApiMonitorState.lastCheckAt = saved.state?.lastCheckAt || null;
    sub2ApiMonitorState.lastError = saved.state?.lastError || null;
    sub2ApiMonitorState.lastResult = saved.state?.lastResult && typeof saved.state.lastResult === "object"
      ? saved.state.lastResult
      : null;
    sub2ApiMonitorState.planTypes = normalizeSub2ApiPlanTypeState(saved.state?.planTypes);
    sub2ApiMonitorState.planTypesBackend = typeof saved.state?.planTypesBackend === "string"
      ? saved.state.planTypesBackend
      : null;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] Sub2API 号池监控配置无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    sub2ApiMonitorConfig = sub2ApiSettingsConfig
      ? { ...sub2ApiSettingsConfig, enabled: false }
      : null;
  }
}

async function persistSub2ApiMonitorConfiguration() {
  if (!sub2ApiMonitorConfig) return;
  const payload = {
    version: 1,
    enabled: Boolean(sub2ApiMonitorConfig.enabled),
    config: serializeSub2ApiConfig(sub2ApiMonitorConfig),
    profiles: [...sub2ApiProfiles.values()].map((profile) => ({ ...profile })),
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
    state: {
      lastCheckAt: sub2ApiMonitorState.lastCheckAt,
      lastError: sub2ApiMonitorState.lastError,
      lastResult: sub2ApiMonitorState.lastResult,
      planTypes: sub2ApiMonitorState.planTypes,
      planTypesBackend: sub2ApiMonitorState.planTypesBackend,
    },
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${SUB2API_MONITOR_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, SUB2API_MONITOR_PATH);
}

function publicSub2ApiMonitorState() {
  const config = sub2ApiMonitorConfig || sub2ApiSettingsConfig;
  return {
    configured: Boolean(config?.baseUrl && config?.adminApiKey),
    hasAdminApiKey: Boolean(config?.adminApiKey),
    enabled: Boolean(sub2ApiMonitorConfig?.enabled),
    baseUrl: config?.baseUrl || null,
    groupIds: config?.groupIds || [],
    config: publicSub2ApiConfig(config),
    profiles: [...sub2ApiProfiles.values()].map((profile) => ({ ...profile })),
    planTypeBindings: { ...sub2ApiPlanTypeBindings },
    activeProfileId: sub2ApiActiveProfileId,
    intervalMinutes: monitoringSettings.poolMonitorIntervalSeconds / 60,
    intervalSeconds: monitoringSettings.poolMonitorIntervalSeconds,
    cooldownMinutes: monitoringSettings.poolRepairRetrySeconds / 60,
    running: sub2ApiMonitorState.running,
    lastCheckAt: sub2ApiMonitorState.lastCheckAt,
    nextCheckAt: sub2ApiMonitorState.nextCheckAt,
    lastError: sub2ApiMonitorState.lastError,
    lastResult: sub2ApiMonitorState.lastResult,
  };
}

function normalizePlanTypeLabelMapping(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "PlanType 映射必须是对象");
  }
  const mapping = {};
  for (const [rawKey, rawLabel] of Object.entries(value).slice(0, 100)) {
    const key = String(rawKey || "").trim();
    const label = String(rawLabel || "").trim();
    if (!key && !label) continue;
    if (!key || !label || key.length > 128 || label.length > 128 || /[\r\n]/.test(key) || /[\r\n]/.test(label)) {
      throw httpError(400, "PlanType 映射项格式不正确");
    }
    if (["__proto__", "constructor", "prototype"].includes(key.toLowerCase())) continue;
    mapping[key] = label;
  }
  return mapping;
}

async function loadPlanTypeLabelMapping() {
  try {
    const saved = JSON.parse(await fs.readFile(PLAN_TYPE_MAPPING_PATH, "utf8"));
    planTypeLabelMapping = normalizePlanTypeLabelMapping(saved.mapping ?? saved);
    planTypeLabelMappingConfigured = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[warn] PlanType 映射无法读取：${String(error?.message || error).slice(0, 180)}`);
    }
    planTypeLabelMapping = {};
    planTypeLabelMappingConfigured = false;
  }
}

async function persistPlanTypeLabelMapping(mapping) {
  const payload = {
    version: 1,
    mapping: { ...mapping },
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${PLAN_TYPE_MAPPING_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, PLAN_TYPE_MAPPING_PATH);
}

function scheduleSub2ApiMonitor() {
  if (sub2ApiMonitorTimer) {
    clearInterval(sub2ApiMonitorTimer);
    sub2ApiMonitorTimer = null;
  }
  sub2ApiMonitorState.nextCheckAt = null;
  if (!sub2ApiMonitorConfig?.enabled || shuttingDown) return;
  const interval = monitoringSettings.poolMonitorIntervalSeconds * 1000;
  sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
  sub2ApiMonitorTimer = setInterval(() => {
    sub2ApiMonitorState.nextCheckAt = new Date(Date.now() + interval).toISOString();
    void runSub2ApiMonitor("scheduled").catch((error) => {
      console.warn(`[warn] Sub2API 号池巡检失败：${String(error?.message || error).slice(0, 180)}`);
    });
  }, interval);
  sub2ApiMonitorTimer.unref?.();
}

async function runSub2ApiMonitor(trigger = "scheduled") {
  if (!sub2ApiMonitorConfig?.enabled) throw httpError(409, "Sub2API 号池监控未启用");
  if (sub2ApiMonitorPromise) return sub2ApiMonitorPromise;
  const config = { ...sub2ApiMonitorConfig, groupIds: [...sub2ApiMonitorConfig.groupIds] };
  const profileState = snapshotSub2ApiProfileState();
  const monitorGroupIds = sub2ApiMonitorGroupIds(config, profileState);
  const backend = monitorBackendIdentity(config);
  sub2ApiMonitorPromise = (async () => {
    sub2ApiMonitorState.running = true;
    sub2ApiMonitorState.lastError = null;
    const summary = {
      trigger,
      checked: 0,
      matched: 0,
      started: 0,
      updated: 0,
      missingTask: 0,
      ineligible: 0,
      blocked: 0,
      busy: 0,
      cooldown: 0,
      outsideGroups: 0,
      missingEmail: 0,
      planTypeChecked: 0,
      planTypeChanged: 0,
      planTypeChanges: 0,
      planTypeUpdated: 0,
      planTypeSkipped: 0,
      planTypeUpdateFailed: 0,
      planTypeScanIncomplete: false,
      proxyFallbackUpdated: 0,
      proxyFallbackFailed: 0,
    };
    try {
      await syncCompletedOutputs(true);
      const refreshRetries = await Promise.allSettled([...jobs.values()]
        .filter((job) => job.poolRefreshAction && job.poolRefreshReady && job.poolRefreshError && job.status === "completed")
        .map((job) => withEmailJobLock(job.email, () => synchronizePoolRefresh(job))));
      const refreshFailure = refreshRetries.find((result) => result.status === "rejected");
      if (refreshFailure) summary.poolCredentialSyncFailed = refreshRetries.filter((result) => result.status === "rejected").length;
      await retryPendingSub2ApiUploads(config, summary, profileState);
      if (shuttingDown) throw httpError(503, "服务正在关闭，已停止号池巡检");
      const accountListing = await listSub2ApiAccounts(config, { withMeta: true });
      const allRemoteAccounts = accountListing.accounts;
      if (accountListing.complete) {
        await reconcileSub2ApiAccountBans(config, allRemoteAccounts);
        summary.datePrioritySync = await syncImportDatePriorities(config, accountListing, profileState);
        await fallBackExpiredSub2ApiProxies(config, profileState, allRemoteAccounts, summary);
        const previousPlanTypes = sub2ApiMonitorState.planTypesBackend === backend
          ? normalizeSub2ApiPlanTypeState(sub2ApiMonitorState.planTypes)
          : Object.create(null);
        const nextPlanTypes = Object.create(null);
        for (const account of allRemoteAccounts) {
          if (accountSyncBlocked(account)) continue;
          const accountId = normalizeSub2ApiAccountId(account?.id);
          if (!accountId) continue;
          summary.planTypeChecked += 1;
          const planType = normalizePlanType(extractPlanTypeFromAccount(account, { preferJwt: false }) || "");
          const previous = Object.hasOwn(previousPlanTypes, accountId)
            ? normalizePlanType(previousPlanTypes[accountId] || "")
            : "";
          // A transiently missing PlanType must not erase a known baseline;
          // otherwise the next restored value would look like a first sighting.
          if (!planType && previous) {
            nextPlanTypes[accountId] = previous;
            continue;
          }
          nextPlanTypes[accountId] = planType || null;
          if (!previous || !planType || previous === planType) continue;
          const profileId = resolveSub2ApiProfileBinding(planType, profileState.bindings);
          const profile = profileId ? profileState.profiles.get(profileId) : null;
          if (!profile) {
            summary.planTypeSkipped += 1;
            continue;
          }
          summary.planTypeChanged += 1;
          summary.planTypeChanges += 1;
          try {
            if (await updateSub2ApiAccountFromProfile(config, account, profile)) summary.planTypeUpdated += 1;
          } catch (error) {
            summary.planTypeUpdateFailed += 1;
            // Keep the previous value so the next scheduled check retries the PUT.
            nextPlanTypes[accountId] = previous || null;
            console.warn(`[warn] Sub2API 账号 ${accountId} 配置方案更新失败：${String(error?.message || error).slice(0, 180)}`);
          }
        }
        sub2ApiMonitorState.planTypes = nextPlanTypes;
        sub2ApiMonitorState.planTypesBackend = backend;
        if (summary.planTypeUpdated) invalidateSub2ApiAccountStatusCache();
      } else {
        summary.planTypeScanIncomplete = true;
        // Keep the last complete baseline. Applying changes from a partial
        // page could mistake a temporarily truncated response for a PlanType
        // transition and update the wrong account.
      }
      const remoteAccounts = await listSub2ApiErrorAccounts(config);
      summary.checked = remoteAccounts.length;
      const grouped = new Map();
      for (const account of remoteAccounts) {
        if (!isSub2ApiAccountInMonitoredGroups(account, monitorGroupIds)) {
          summary.outsideGroups += 1;
          continue;
        }
        const email = sub2ApiAccountEmail(account);
        if (!email) {
          summary.missingEmail += 1;
          continue;
        }
        if (!grouped.has(email)) grouped.set(email, []);
        grouped.get(email).push(account);
      }

      for (const [email, accounts] of grouped) {
        await withEmailJobLock(email, async () => {
          const job = findJobByEmail(email);
          if (!job) {
            summary.missingTask += accounts.length;
            return;
          }
          summary.matched += accounts.length;
          if (job.autoRepairBlocked) {
            summary.blocked += accounts.length;
            return;
          }
          if (isActive(job.status) || job.autoRepairOperation) {
            summary.busy += accounts.length;
            return;
          }
          if (job.poolRefreshAction || isAutoRepairCoolingDown(job)) {
            summary.cooldown += accounts.length;
            return;
          }
          await reloadMissingJobCredentials(job);
          const eligibility = getAutoRepairEligibility(job);
          if (!eligibility.eligible) {
            summary.ineligible += accounts.length;
            return;
          }

          const operation = createSub2ApiAutoRepairOperation(config, accounts, profileState);
          await forceReloginJob(job, {}, { autoRepair: operation });
          appendJobLog(job, `[monitor] Sub2API 号池发现 ${accounts.length} 条异常记录，已自动加入重新登录并授权队列。\n`);
          await saveJobMetadata(job);
          summary.started += accounts.length;
        });
      }

      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastResult = summary;
      await persistSub2ApiMonitorConfiguration();
      return summary;
    } catch (error) {
      sub2ApiMonitorState.lastCheckAt = new Date().toISOString();
      sub2ApiMonitorState.lastError = String(error?.message || error).slice(0, 500);
      await persistSub2ApiMonitorConfiguration().catch(() => {});
      throw error;
    } finally {
      sub2ApiMonitorState.running = false;
    }
  })().finally(() => {
    sub2ApiMonitorPromise = null;
  });
  return sub2ApiMonitorPromise;
}

const SUB2API_PROFILE_FIELD_LABELS = {
  groupIds: "号池",
  proxyId: "代理",
  concurrency: "并发数",
  loadFactor: "负载因子",
  priority: "优先级",
  importDatePriority: "按导入日期设置优先级",
  accountNameTemplate: "账号命名模板",
  modelWhitelist: "模型白名单",
  codexFingerprintMode: "Codex 指纹模式",
  autoResetCreditEnabled: "自动使用重置卡",
  autoResetCredit5hThresholdPercent: "5h 自动用卡阈值",
  autoResetCredit7dThresholdPercent: "7d 自动用卡阈值",
  wsMode: "WS mode",
};
const SUB2API_PROXY_STATE_TTL_MS = 60_000;
const sub2ApiProxyStateCache = new Map();

function isSub2ApiProxyExpired(proxy, now = Date.now()) {
  if (["expired", "deleted", "removed", "disabled", "inactive"].includes(String(proxy?.status || "").trim().toLowerCase())) return true;
  const expiresAt = proxy?.expires_at ? Date.parse(proxy.expires_at) : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

async function getSub2ApiProxyState(config, proxyId) {
  const key = `${monitorBackendIdentity(config)}:${proxyId}`;
  const cached = sub2ApiProxyStateCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SUB2API_PROXY_STATE_TTL_MS) return cached.state;
  let state;
  try {
    const payload = await requestSub2Api(config, `/api/v1/admin/proxies/${encodeURIComponent(proxyId)}`);
    const proxy = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (!proxy || Number(proxy.id) !== Number(proxyId)) return { found: null };
    state = { found: true, proxy };
  } catch (error) {
    // Some Sub2API versions expose only /proxies/all. Confirm a 404 against
    // that list before treating the configured proxy as deleted.
    if (error?.remoteStatus !== 404) return { found: null };
    try {
      const payload = await requestSub2Api(config, "/api/v1/admin/proxies/all");
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.data) ? payload.data : [];
      const proxy = items.find((item) => Number(item?.id) === Number(proxyId));
      state = proxy ? { found: true, proxy } : { found: false };
    } catch (listError) {
      // A transient failure must not switch accounts to direct. Only a
      // successful list that omits the ID is treated as a deletion.
      return { found: null };
    }
  }
  sub2ApiProxyStateCache.set(key, { fetchedAt: Date.now(), state });
  return state;
}

/**
 * Resolve the proxy that should actually be written for a configured proxy ID.
 * An expired or deleted proxy falls back to direct, unless Sub2API itself was
 * configured to fall back to a backup proxy that is still usable. When the
 * state cannot be read, the configured proxy is kept unchanged.
 */
async function resolveSub2ApiProxyFallback(config, proxyId) {
  const state = await getSub2ApiProxyState(config, proxyId);
  if (state.found === null) return proxyId;
  if (state.found && !isSub2ApiProxyExpired(state.proxy)) return proxyId;
  const backupId = Number(state.proxy?.backup_proxy_id);
  if (state.found && state.proxy.fallback_mode === "proxy" && Number.isSafeInteger(backupId) && backupId > 0 && backupId !== proxyId) {
    const backup = await getSub2ApiProxyState(config, backupId);
    if (backup.found && !isSub2ApiProxyExpired(backup.proxy)
      && String(backup.proxy.status || "active").toLowerCase() === "active") {
      return backupId;
    }
  }
  return SUB2API_PROXY_DIRECT;
}

async function resolveSub2ApiWriteConfig(accountConfig) {
  if (accountProxyMode === "sub2api") return accountConfig;
  const proxyId = Number(accountConfig?.proxyId);
  if (!Number.isSafeInteger(proxyId) || proxyId <= 0) return accountConfig;
  const target = await resolveSub2ApiProxyFallback(accountConfig, proxyId);
  return target === proxyId ? accountConfig : { ...accountConfig, proxyId: target, proxyFallbackFrom: proxyId };
}

function sub2ApiProxyFields(accountConfig) {
  if (accountConfig?.proxyId === SUB2API_PROXY_BALANCED) return {};
  if (String(accountConfig?.proxyId || "").trim().toLowerCase() === SUB2API_PROXY_DIRECT) {
    return { proxy_id: 0 };
  }
  return accountConfig.proxyId ? { proxy_id: accountConfig.proxyId } : {};
}

/**
 * Move pool accounts off proxies that a profile uses but that have expired or
 * been deleted. Accounts Sub2API already moved (to direct or a backup proxy)
 * no longer reference the expired ID and are left alone.
 */
async function fallBackExpiredSub2ApiProxies(config, profileState, accounts, summary) {
  if (["sub2api", "plan"].includes(accountProxyMode)) {
    for (const account of accounts) {
      if (shuttingDown) return;
      const job = findJobByEmail(sub2ApiAccountEmail(account));
      if (accountSyncBlocked(account)) continue;
      if (accountProxyMode === "plan" && !hasPlanProxyBinding(job)) continue;
      const accountId = normalizeSub2ApiAccountId(account?.id);
      const assignedProxyId = normalizeStoredProxyId(job?.assignedProxyId);
      if (!accountId || (!assignedProxyId && accountProxyMode !== "plan")) continue;
      try {
        if (assignedProxyId) {
          const state = await getSub2ApiProxyState(config, assignedProxyId);
          if (state.found !== true || isSub2ApiProxyExpired(state.proxy)) throw new Error("账号绑定代理已失效或状态未知，请修复代理或手动切换 IP");
          if (accountProxyMode === "plan") assertBoundProxyIp(job, normalizeSub2ApiProxyList([state.proxy])[0]);
        }
        const proxyId = assignedProxyId || 0;
        if (Number(account?.proxy_id) === Number(proxyId)) continue;
        await requestProfileSync(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body: JSON.stringify({ proxy_id: proxyId }),
        });
        summary.proxyFallbackUpdated += 1;
      } catch (error) {
        summary.proxyFallbackFailed += 1;
        console.warn(`[warn] Sub2API 账号 ${accountId} 代理回退失败：${String(error?.message || error).slice(0, 180)}`);
      }
    }
    if (summary.proxyFallbackUpdated) invalidateSub2ApiAccountStatusCache();
    return;
  }
  const proxyIds = [...new Set([...profileState.profiles.values()]
    .map((profile) => Number(profile.proxyId))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  for (const proxyId of proxyIds) {
    if (shuttingDown) return;
    const target = await resolveSub2ApiProxyFallback(config, proxyId);
    if (target === proxyId) continue;
    for (const account of accounts) {
      const accountId = normalizeSub2ApiAccountId(account?.id);
      if (accountSyncBlocked(account)) continue;
      if (!accountId || Number(account?.proxy_id) !== proxyId) continue;
      try {
        await requestProfileSync(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body: JSON.stringify({ proxy_id: target === SUB2API_PROXY_DIRECT ? 0 : target }),
        });
        summary.proxyFallbackUpdated += 1;
      } catch (error) {
        summary.proxyFallbackFailed += 1;
        console.warn(`[warn] Sub2API 账号 ${accountId} 代理回退失败：${String(error?.message || error).slice(0, 180)}`);
      }
    }
  }
  if (summary.proxyFallbackUpdated) invalidateSub2ApiAccountStatusCache();
}

/**
 * Compare the profile state before and after a settings save and return the
 * PlanTypes whose bound profile parameters changed. Only PlanTypes that were
 * explicitly bound both before and after the save qualify: for a newly bound
 * PlanType the parameters currently stored on its pool accounts are unknown,
 * and unbound PlanTypes follow the fallback profile, which is deliberately
 * never pushed automatically.
 */
function diffSub2ApiProfileSyncTargets(previous, next) {
  const targets = [];
  for (const [planType, profileId] of Object.entries(next.bindings || {})) {
    const previousProfileId = resolveSub2ApiProfileBinding(planType, previous.bindings);
    if (!previousProfileId) continue;
    const before = previous.profiles.get(previousProfileId);
    const after = next.profiles.get(profileId);
    if (!before || !after) continue;
    const fields = SUB2API_PROFILE_FIELDS.filter((field) => (
      JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)
    ));
    if (fields.length) targets.push({ planType, profileId, fields });
  }
  return targets;
}

// A cleared profile value means "keep whatever the account already has" on
// every other write path, so a save never clears these fields remotely either.
function unsyncableSub2ApiProfileFields(accountConfig, fields) {
  return fields.filter((field) => {
    if (field === "groupIds") return !accountConfig.groupIds.length;
    if (field === "proxyId") return ["sub2api", "plan"].includes(accountProxyMode) || !accountConfig.proxyId || accountConfig.proxyId === SUB2API_PROXY_BALANCED;
    if (["concurrency", "loadFactor", "priority"].includes(field)) return accountConfig[field] === null;
    if (field === "accountNameTemplate") return !accountConfig.accountNameTemplate;
    if (field === "modelWhitelist") return !accountConfig.modelWhitelist.length;
    return false;
  });
}

async function buildSub2ApiProfileSyncUpdate(remoteAccount, accountConfig, fields) {
  const changed = new Set(fields);
  const body = {};
  if (changed.has("groupIds")) body.group_ids = fingerprintGroupIds(accountConfig, remoteAccount, accountConfig.groupIds, remoteAccount);
  if (changed.has("proxyId")) Object.assign(body, await sub2ApiProxyFieldsForAccount(accountConfig, sub2ApiAccountEmail(remoteAccount), remoteAccount));
  if (changed.has("concurrency")) body.concurrency = accountConfig.concurrency;
  if (changed.has("loadFactor")) body.load_factor = accountConfig.loadFactor;
  if (changed.has("priority") && !accountConfig.importDatePriority?.enabled) body.priority = accountConfig.priority;
  if (changed.has("importDatePriority") && !accountConfig.importDatePriority?.enabled && accountConfig.priority !== null) body.priority = accountConfig.priority;
  if (changed.has("accountNameTemplate")) {
    const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, remoteAccount);
    if (accountName) body.name = accountName;
  }
  const resetCreditChanged = ["autoResetCreditEnabled", "autoResetCredit5hThresholdPercent", "autoResetCredit7dThresholdPercent"].some((field) => changed.has(field));
  if (changed.has("codexFingerprintMode") || changed.has("wsMode") || resetCreditChanged) {
    const originalExtra = normalizeSub2ApiExtra(remoteAccount.extra);
    body.extra = changed.has("codexFingerprintMode") || changed.has("wsMode")
      ? buildSub2ApiAccountExtra(originalExtra, accountConfig)
      : { ...originalExtra };
    delete body.extra.codex_auto_reset_credit_state;
    if (resetCreditChanged) {
      body.extra.auto_reset_credit_enabled = accountConfig.autoResetCreditEnabled === true;
      body.extra.auto_reset_credit_5h_threshold = accountConfig.autoResetCredit5hThresholdPercent / 100;
      body.extra.auto_reset_credit_7d_threshold = accountConfig.autoResetCredit7dThresholdPercent / 100;
    } else {
      for (const key of ["auto_reset_credit_enabled", "auto_reset_credit_5h_threshold", "auto_reset_credit_7d_threshold"]) {
        if (Object.hasOwn(originalExtra, key)) body.extra[key] = originalExtra[key];
        else delete body.extra[key];
      }
    }
    if (remoteAccount.parent_account_id != null) {
      for (const key of ["auto_reset_credit_enabled", "auto_reset_credit_5h_threshold", "auto_reset_credit_7d_threshold"]) delete body.extra[key];
    }
  }
  if (changed.has("modelWhitelist")) {
    body.credentials = {
      ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
      model_mapping: Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model])),
    };
  }
  return body;
}

/**
 * Push changed profile parameters to every pool account whose PlanType is
 * bound to the edited profile. Only the changed fields are written, so
 * per-account adjustments to other fields (for example a manually edited
 * priority) survive unrelated profile edits. The settings are already saved
 * when this runs; failures are reported back instead of failing the save.
 */
async function syncSub2ApiProfileChanges(config, targets, profileState) {
  if (!targets.length) return null;
  const syncTargets = [];
  for (const target of targets) {
    const profile = profileState.profiles.get(target.profileId);
    const accountConfig = await resolveSub2ApiWriteConfig(profileConfig(profile, config));
    const skipped = unsyncableSub2ApiProfileFields(accountConfig, target.fields);
    syncTargets.push({ ...target, accountConfig, fields: target.fields.filter((field) => !skipped.includes(field)), skipped });
  }
  const fields = [...new Set(syncTargets.flatMap((target) => target.fields))];
  const skippedFields = [...new Set(syncTargets.flatMap((target) => target.skipped))];
  const result = {
    planTypes: syncTargets.map((target) => target.planType),
    fields,
    fieldLabels: fields.map((field) => SUB2API_PROFILE_FIELD_LABELS[field] || field),
    skippedFields,
    skippedFieldLabels: skippedFields.map((field) => SUB2API_PROFILE_FIELD_LABELS[field] || field),
    matched: 0,
    updated: 0,
    failed: 0,
    incomplete: false,
    error: null,
  };
  const pushTargets = new Map(syncTargets
    .filter((target) => target.fields.length)
    .map((target) => [target.planType.toLowerCase(), target]));
  if (!pushTargets.size) return result;
  if (!config?.baseUrl || !config?.adminApiKey) {
    result.error = "尚未配置 Sub2API 后端地址和管理员 API Key";
    return result;
  }

  let listing;
  try {
    listing = await listSub2ApiAccounts(config, { withMeta: true });
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 500);
    return result;
  }
  result.incomplete = !listing.complete;
  const work = [];
  for (const account of listing.accounts) {
    if (accountSyncBlocked(account)) continue;
    const accountId = normalizeSub2ApiAccountId(account?.id);
    const planType = normalizePlanType(extractPlanTypeFromAccount(account, { preferJwt: false }) || "");
    const target = planType ? pushTargets.get(planType.toLowerCase()) : null;
    if (accountId && target) work.push({ accountId, account, target });
  }
  result.matched = work.length;

  let cursor = 0;
  const worker = async () => {
    while (cursor < work.length && !shuttingDown) {
      const { accountId, account, target } = work[cursor];
      cursor += 1;
      try {
        const body = await buildSub2ApiProfileSyncUpdate(account, target.accountConfig, target.fields);
        if (!Object.keys(body).length || accountSyncBlocked(account)) continue;
        await requestProfileSync(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        result.updated += 1;
      } catch (error) {
        result.failed += 1;
        result.error ||= String(error?.message || error).slice(0, 500);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(monitoringSettings.profileSyncConcurrency, work.length) }, worker));
  if (result.updated) invalidateSub2ApiAccountStatusCache();
  return result;
}

async function updateSub2ApiAccountFromProfile(globalConfig, remoteAccount, profile) {
  if (accountSyncBlocked(remoteAccount)) return false;
  const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
  if (!accountId) return false;
  const accountConfig = await resolveSub2ApiWriteConfig(profileConfig(profile, globalConfig));
  const body = {};
  if (Array.isArray(accountConfig.groupIds) && accountConfig.groupIds.length) body.group_ids = fingerprintGroupIds(accountConfig, remoteAccount, accountConfig.groupIds, remoteAccount);
  Object.assign(body, await sub2ApiProxyFieldsForAccount(accountConfig, sub2ApiAccountEmail(remoteAccount), remoteAccount));
  if (accountConfig.concurrency !== null) body.concurrency = accountConfig.concurrency;
  if (accountConfig.loadFactor !== null) body.load_factor = accountConfig.loadFactor;
  if (accountConfig.priority !== null && !accountConfig.importDatePriority?.enabled) body.priority = accountConfig.priority;
  const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, remoteAccount);
  if (accountName) body.name = accountName;
  body.extra = buildSub2ApiAccountExtra(remoteAccount.extra, accountConfig, remoteAccount);
  if (accountConfig.modelWhitelist.length) {
    body.credentials = {
      ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
      model_mapping: Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model])),
    };
  }
  if (accountSyncBlocked(remoteAccount)) return false;
  await requestProfileSync(globalConfig, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return true;
}

async function buildSub2ApiAccountUpdate(localAccount, accountConfig, remoteAccount = {}) {
  const remarkJob = findJobByEmail(sub2ApiAccountEmail(localAccount));
  // Routine uploads/workspace changes must not overwrite a newer pool edit.
  // Explicit local changes remain pending until their notes write succeeds.
  const remark = remarkJob ? (remarkJob.remarkSyncPending ? remarkJob.remark || "" : undefined) : localAccount.notes;
  const remoteCredentials = remoteAccount?.credentials && typeof remoteAccount.credentials === "object"
    ? remoteAccount.credentials
    : {};
  const localCredentials = localAccount?.credentials && typeof localAccount.credentials === "object"
    ? localAccount.credentials
    : {};
  const credentials = {
    // Keep fields managed by Sub2API (usage snapshots, error metadata, or
    // provider-specific values) while letting the freshly selected workspace
    // OAuth bundle replace the credential values.
    ...remoteCredentials,
    ...localCredentials,
  };
  const targetPlanType = normalizePlanType(
    localAccount?.plan_type
      || localCredentials.plan_type
      || localAccount?.extra?.plan_type
      || extractPlanTypeFromAccount(localAccount, { preferJwt: false })
      || "",
  );
  if (targetPlanType) credentials.plan_type = targetPlanType;
  if (accountConfig.modelWhitelist.length) {
    credentials.model_mapping = Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model]));
  }
  // Sub2API deployments may serialize `extra` as a JSON string. Normalize
  // both sides before merging so usage snapshots and provider metadata do
  // not disappear when a workspace switch updates the credentials.
  const remoteExtra = normalizeSub2ApiExtra(remoteAccount?.extra);
  const localExtra = normalizeSub2ApiExtra(localAccount?.extra);
  const mergedExtra = { ...remoteExtra, ...localExtra };
  if (targetPlanType) mergedExtra.plan_type = targetPlanType;
  const extra = buildSub2ApiAccountExtra(mergedExtra, accountConfig, remoteAccount);
  const accountId = normalizeSub2ApiAccountId(remoteAccount?.id || localAccount?.id);
  const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, {
    ...localAccount,
    id: accountId || localAccount?.id,
  });
  return {
    credentials,
    extra,
    ...(remark !== undefined ? { notes: remark } : {}),
    ...(targetPlanType ? { plan_type: targetPlanType } : {}),
    ...(accountName ? { name: accountName } : {}),
    ...(accountConfig.groupIds.length
      ? { group_ids: fingerprintGroupIds(accountConfig, localAccount, accountConfig.groupIds, remoteAccount) }
      : { group_ids: sub2ApiAccountGroupIds(remoteAccount) }),
    ...await sub2ApiProxyFieldsForAccount(accountConfig, sub2ApiAccountEmail(localAccount), remoteAccount),
    ...(accountConfig.concurrency !== null ? { concurrency: accountConfig.concurrency } : {}),
    ...(accountConfig.loadFactor !== null ? { load_factor: accountConfig.loadFactor } : {}),
    ...(accountConfig.priority !== null && !accountConfig.importDatePriority?.enabled ? { priority: accountConfig.priority } : {}),
  };
}

async function sub2ApiProxyFieldsForAccount(accountConfig, email, remoteAccount = {}) {
  if (accountAutomationBlocked(email)) return { proxy_id: 0 };
  if (accountProxyMode === "plan") {
    const job = findJobByEmail(email);
    return hasPlanProxyBinding(job) ? { proxy_id: normalizeStoredProxyId(job.assignedProxyId) || 0 } : {};
  }
  if (accountProxyMode !== "sub2api") return sub2ApiProxyFields(accountConfig);
  const assignedProxyId = normalizeStoredProxyId(findJobByEmail(email)?.assignedProxyId)
    || normalizeStoredProxyId(remoteAccount.proxy_id);
  if (!assignedProxyId) return Object.hasOwn(remoteAccount, "proxy_id") && Number(remoteAccount.proxy_id) === 0
    ? { proxy_id: 0 }
    : {};
  return { proxy_id: assignedProxyId };
}

function normalizeAccountRemark(value) {
  if (typeof value !== "string") throw httpError(400, "备注必须是文本");
  if (value.length > 2000 || value.includes("\u0000")) throw httpError(400, "备注最多 2000 字，不能包含空字符");
  return value;
}

function accountWithRemark(account, job) {
  return { ...account, notes: job.remark || "" };
}

function restoredRemarkState(metadata) {
  return {
    remarkSyncPending: metadata.remark_sync_pending === true,
    remarkSyncBackend: typeof metadata.remark_sync_backend === "string" ? metadata.remark_sync_backend : null,
    remarkRemoteSnapshot: metadata.remark_remote_snapshot && typeof metadata.remark_remote_snapshot === "object" ? metadata.remark_remote_snapshot : {},
    remarkRevision: metadata.remark_revision || null,
  };
}

async function updateJobRemark(job, value) {
  const remark = normalizeAccountRemark(value);
  const matching = [...jobs.values()].filter((item) => item.email.toLowerCase() === job.email.toLowerCase());
  await Promise.all(matching.map(async (item) => {
    item.remark = remark;
    item.remarkRevision = crypto.randomUUID();
    item.remarkSyncPending = true;
    touch(item);
    await saveJobMetadata(item);
  }));
  return synchronizeSub2ApiRemark(job);
}

async function synchronizeSub2ApiRemark(job, context = {}) {
  const config = context.config || sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  const result = { configured: Boolean(config?.baseUrl && config?.adminApiKey), matched: 0, updated: 0, failed: 0, error: null };
  if (!result.configured || accountAutomationBlocked(job.email)) return result;
  const remark = job.remark || "";
  const revision = job.remarkRevision;
  try {
    const listing = context.listing || await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw new Error("Sub2API 账号列表不完整，备注已保存在本地，请重试同步");
    const matching = new Map(listing.accounts
      .filter((account) => sub2ApiAccountEmail(account) === job.email.toLowerCase())
      .map((account) => [normalizeSub2ApiAccountId(account.id), account])
      .filter(([id]) => id));
    result.matched = matching.size;
    for (const [id, account] of matching) {
      const notes = remark;
      if (notes === account.notes || accountSyncBlocked(account)) continue;
      try {
        await requestProfileSync(config, `/api/v1/admin/accounts/${encodeURIComponent(id)}`, {
          method: "PUT", body: JSON.stringify({ notes }),
        });
        result.updated += 1;
        account.notes = notes;
      } catch (error) {
        result.failed += 1;
        result.error ||= String(error?.message || error).slice(0, 500);
      }
    }
    if (result.matched && !result.failed && job.remarkRevision === revision) {
      const backend = monitorBackendIdentity(config);
      await Promise.all([...jobs.values()].filter((item) => item.email.toLowerCase() === job.email.toLowerCase()).map(async (item) => {
        item.remarkSyncPending = false;
        item.remarkSyncBackend = backend;
        item.remarkRemoteSnapshot = Object.fromEntries([...matching].map(([id, account]) => [id, account.notes ?? ""]));
        await saveJobMetadata(item);
      }));
    }
    if (result.updated) invalidateSub2ApiAccountStatusCache();
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 500);
  }
  return result;
}

async function pullSub2ApiRemarks(listing, config, versions) {
  const backend = monitorBackendIdentity(config);
  const grouped = new Map();
  for (const account of listing.accounts) {
    const email = sub2ApiAccountEmail(account);
    if (!email || !normalizeSub2ApiAccountId(account.id)) continue;
    if (!grouped.has(email)) grouped.set(email, []);
    grouped.get(email).push(account);
  }
  for (const [email, remote] of grouped) {
    // Status refresh can run inside a workspace/delete operation holding this
    // same lock. Defer busy accounts until the next refresh instead of nesting.
    if (emailJobLocks.has(email) || accountAutomationBlocked(email)) continue;
    await withEmailJobLock(email, async () => {
      const job = findJobByEmail(email);
      if (!job || job.remarkRevision !== versions.get(job.id)) return;
      if (job.remarkSyncPending) {
        await synchronizeSub2ApiRemark(job, { listing, config });
        return;
      }
      const candidates = remote.filter((account) => Object.hasOwn(account, "notes") && (typeof account.notes === "string" || account.notes === null));
      if (!candidates.length) return;
      const snapshot = job.remarkSyncBackend === backend ? job.remarkRemoteSnapshot || {} : {};
      const changed = candidates.filter((account) => snapshot[account.id] !== (account.notes ?? ""));
      // Prefer records changed since the last snapshot, then the latest remote
      // timestamp; ID makes conflicts deterministic when timestamps are absent.
      const source = (changed.length ? changed : candidates).sort((left, right) =>
        (Date.parse(right.updated_at || "") || 0) - (Date.parse(left.updated_at || "") || 0)
        || String(left.id).localeCompare(String(right.id), "en", { numeric: true })
      )[0];
      const remark = !changed.length && Object.keys(snapshot).length ? job.remark || "" : source.notes ?? "";
      const nextSnapshot = Object.fromEntries(candidates.map((account) => [account.id, account.notes ?? ""]));
      const matching = [...jobs.values()].filter((item) => item.email.toLowerCase() === email);
      await Promise.all(matching.map(async (item) => {
        if (item.remark === remark && item.remarkSyncBackend === backend && JSON.stringify(item.remarkRemoteSnapshot) === JSON.stringify(nextSnapshot)) return;
        item.remark = remark;
        item.remarkSyncBackend = backend;
        item.remarkRemoteSnapshot = nextSnapshot;
        touch(item);
        await saveJobMetadata(item);
      }));
    });
  }
}

/**
 * Update existing pool records after a workspace switch, retaining remote
 * IDs and updating historical duplicates matched by email without creation.
 */
async function synchronizeSub2ApiWorkspaceAccount(job) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  if (!config?.baseUrl || !config?.adminApiKey) {
    return { configured: false, matched: 0, updated: 0, accountIds: [] };
  }
  const payload = await buildSub2ApiUploadPayload([job]);
  const localAccount = payload.accounts.find((account) => sub2ApiAccountEmail(account) === String(job.email || "").trim().toLowerCase())
    || payload.accounts[0];
  if (!localAccount?.credentials) throw new Error("授权文件中没有可同步的账号凭据");

  const listing = await listSub2ApiAccounts(config, { withMeta: true });
  if (!listing.complete) throw new Error("Sub2API 账号列表不完整，已停止工作空间同步以避免写错账号");
  const email = sub2ApiAccountEmail(localAccount) || String(job.email || "").trim().toLowerCase();
  const matches = listing.accounts.filter((account) => sub2ApiAccountEmail(account) === email);
  if (!matches.length) {
    invalidateSub2ApiAccountStatusCache();
    return { configured: true, matched: 0, updated: 0, accountIds: [] };
  }

  const profileState = snapshotSub2ApiProfileState();
  const accountIds = [];
  for (const remoteAccount of matches) {
    const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
    if (!accountId) continue;
    const accountConfig = await resolveSub2ApiWriteConfig(resolveSub2ApiConfigForAccount(config, localAccount, profileState));
    const accountUpdate = await buildSub2ApiAccountUpdate(localAccount, accountConfig, remoteAccount);
    await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      body: JSON.stringify(accountUpdate),
    });
    accountIds.push(accountId);
  }
  if (accountIds.length) invalidateSub2ApiAccountStatusCache();
  return { configured: true, matched: matches.length, updated: accountIds.length, accountIds };
}

function createSub2ApiAutoRepairOperation(config, accounts, profileState = snapshotSub2ApiProfileState()) {
  const validAccounts = accounts.filter((account) => {
    const id = Number(account?.id);
    return Number.isSafeInteger(id) && id > 0;
  });
  return {
    accountIds: validAccounts.map((account) => Number(account.id)),
    accounts: validAccounts,
    backend: monitorBackendIdentity(config),
    config,
    profileState,
    startedAt: new Date().toISOString(),
  };
}

async function retryPendingSub2ApiUploads(config, summary, profileState = snapshotSub2ApiProfileState()) {
  const backend = monitorBackendIdentity(config);
  const legacyBackend = legacyMonitorBackendIdentity(config);
  for (const candidate of listUniqueJobs()) {
    await withEmailJobLock(candidate.email, async () => {
      const job = findJobByEmail(candidate.email);
      const pendingIds = [...new Set(job?.autoRepairPendingAccountIds || [])]
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      if (
        !job
        || pendingIds.length === 0
        || ![backend, legacyBackend].includes(job.autoRepairPendingBackend)
        || !job.resultSaved
        || job.status !== "completed"
        || job.autoRepairOperation
        || isAutoRepairCoolingDown(job)
      ) return;
      const accounts = [];
      const missingIds = [];
      const expectedEmail = String(job.email || "").trim().toLowerCase();
      try {
        for (const accountId of pendingIds) {
          const account = await getSub2ApiAccount(config, accountId);
          const remoteEmail = account && sub2ApiAccountEmail(account);
          if (account && remoteEmail === expectedEmail) accounts.push(account);
          else {
            missingIds.push(accountId);
            if (account) {
              appendJobLog(job, `[monitor] 待重传账号 ${accountId} 的邮箱与任务不一致，已停止更新以避免覆盖错误账号。\n`);
            }
          }
        }
      } catch (error) {
        job.autoRepairLastAttemptAt = new Date().toISOString();
        job.autoRepairLastError = String(error?.message || error).slice(0, 500);
        appendJobLog(job, `[monitor] 读取待重传的 Sub2API 账号失败：${job.autoRepairLastError}。\n`);
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      if (missingIds.length) {
        const missing = new Set(missingIds);
        job.autoRepairPendingAccountIds = pendingIds.filter((id) => !missing.has(id));
        appendJobLog(job, `[monitor] ${missingIds.length} 条待重传账号已从 Sub2API 删除，已停止重试。\n`);
      }
      if (!accounts.length) {
        job.autoRepairPendingBackend = null;
        job.autoRepairLastError = null;
        touch(job);
        await saveJobMetadata(job);
        return;
      }

      job.autoRepairOperation = createSub2ApiAutoRepairOperation(config, accounts, profileState);
      job.autoRepairLastAttemptAt = new Date().toISOString();
      appendJobLog(job, `[monitor] 正在重传 ${accounts.length} 条上次未完成的 Sub2API 更新，不重复登录。\n`);
      if (await finishSub2ApiAutoRepairSuccess(job)) summary.updated += accounts.length;
    });
  }
}

async function getSub2ApiAccount(config, accountId) {
  try {
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts/${accountId}`);
    const account = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    if (!account || normalizeSub2ApiAccountId(account.id) !== normalizeSub2ApiAccountId(accountId)) {
      throw new Error(`Sub2API 账号 ${accountId} 返回数据不完整`);
    }
    return account;
  } catch (error) {
    if (error?.remoteStatus === 404) return null;
    throw error;
  }
}

async function listSub2ApiErrorAccounts(config) {
  const accounts = [];
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: "100",
      platform: "openai",
      status: "error",
    });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    accounts.push(...items.filter((account) => account && String(account.platform || "openai") === "openai" && String(account.status || "error") === "error"));
    const reportedPages = Number(data?.pages);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : items.length >= 100 ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  return accounts;
}

function sub2ApiAccountEmail(account) {
  const direct = [
    account?.email,
    account?.account_email,
    account?.credentials?.email,
    account?.credentials?.account_email,
    account?.extra?.email,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .find(isEmail);
  if (direct) return direct;
  const match = String(account?.name || "").toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match && isEmail(match[0]) ? match[0] : null;
}

async function loadSub2ApiAccountStatus({ forceRefresh = false } = {}) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  if (!config?.baseUrl || !config?.adminApiKey) {
    sub2ApiAccountStatusCache = { backend: null, fetchedAt: null, accounts: new Map() };
    return sub2ApiAccountStatusCache;
  }
  const backend = monitorBackendIdentity(config);
  const cacheAge = sub2ApiAccountStatusCache.fetchedAt
    ? Date.now() - Date.parse(sub2ApiAccountStatusCache.fetchedAt)
    : Number.POSITIVE_INFINITY;
  if (!forceRefresh && sub2ApiAccountStatusCache.backend === backend && cacheAge < monitoringSettings.accountStatusIntervalSeconds * 1000) {
    return sub2ApiAccountStatusCache;
  }
  if (sub2ApiAccountStatusPromise) return sub2ApiAccountStatusPromise;
  sub2ApiAccountStatusPromise = (async () => {
    const versions = new Map([...jobs.values()].map((job) => [job.id, job.remarkRevision]));
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw new Error("Sub2API 账号列表不完整，已保留本地备注和状态");
    const remoteAccounts = listing.accounts;
    await listSub2ApiProxies(config).catch(() => []);
    await importSub2ApiPoolOnlyAccounts(remoteAccounts);
    await reconcileSub2ApiAccountBans(config, remoteAccounts);
    await syncImportDatePriorities(config, listing);
    await pullSub2ApiRemarks(listing, config, versions);
    const accounts = new Map();
    const fetchedAt = new Date().toISOString();
    const previousAccounts = sub2ApiAccountStatusCache.backend === backend
      ? sub2ApiAccountStatusCache.accounts
      : new Map();
    for (const remoteAccount of remoteAccounts) {
      const email = sub2ApiAccountEmail(remoteAccount);
      const accountId = normalizeSub2ApiAccountId(remoteAccount?.id);
      if (!email || !accountId) continue;
      const groupIds = sub2ApiAccountGroupIds(remoteAccount);
      const enabled = sub2ApiAccountSchedulable(remoteAccount);
      const priority = sub2ApiAccountPriority(remoteAccount);
      const usage = normalizeSub2ApiUsage(remoteAccount, fetchedAt);
      const remoteStatus = String(remoteAccount?.status || "").trim().toLowerCase() || null;
      const current = accounts.get(email);
      const previous = previousAccounts.get(email);
      if (!current) {
        accounts.set(email, {
          email,
          remark: findJobByEmail(email)?.remark ?? null,
          accountIds: [accountId],
          proxyIds: [normalizeStoredProxyId(remoteAccount.proxy_id)].filter(Boolean),
          groupIds,
          enabled,
          priority,
          planType: extractPlanTypeFromAccount(remoteAccount, { preferJwt: false }) || null,
          remoteStatus,
          usage: mergeSub2ApiUsage(previous?.usage || null, usage),
          fetchedAt,
        });
        continue;
      }
      current.accountIds = [...new Set([...current.accountIds, accountId])];
      current.proxyIds = [...new Set([...current.proxyIds, normalizeStoredProxyId(remoteAccount.proxy_id)].filter(Boolean))];
      current.groupIds = [...new Set([...current.groupIds, ...groupIds])];
      current.enabled = mergeSub2ApiBoolean(current.enabled, enabled);
      current.priority = mergeSub2ApiPriority(current.priority, priority);
      current.planType ||= extractPlanTypeFromAccount(remoteAccount, { preferJwt: false }) || null;
      if (remoteStatus === "error") current.remoteStatus = "error";
      else current.remoteStatus ||= remoteStatus;
      current.usage = mergeSub2ApiUsage(current.usage, usage);
    }
    sub2ApiAccountStatusCache = { backend, fetchedAt, accounts };
    sub2ApiAccountStatusCache.usageIds = remoteAccounts.filter(account => account.platform === "openai" && account.type === "oauth" && sub2ApiAccountEmail(account) && !accountSyncBlocked(account))
      .map(account => normalizeSub2ApiAccountId(account.id)).filter(Boolean);
    for (const [email, entry] of accounts) {
      const previous = previousAccounts.get(email);
      if (previous && entry.accountIds.join(",") !== previous.accountIds.join(",") && entry.usage) entry.usage.totals = null;
    }
    void synchronizeCachedUsageTotals(config, sub2ApiAccountStatusCache).catch(() => {});
    return sub2ApiAccountStatusCache;
  })().finally(() => {
    sub2ApiAccountStatusPromise = null;
  });
  return sub2ApiAccountStatusPromise;
}

async function synchronizeCachedUsageTotals(config, state, options = {}) {
  const ids = state.usageIds || [];
  if (!config?.baseUrl || !ids.length || monitorBackendIdentity(config) !== state.backend) return;
  const records = await readUsageTotals(config, ids, options);
  if (sub2ApiAccountStatusCache !== state) return;
  const eligible = new Set(ids);
  for (const [email, entry] of state.accounts) {
    if (accountAutomationBlocked(email) || !entry.accountIds.every(id => eligible.has(id) && records.has(String(id)))) continue;
    entry.usage = { ...entry.usage, totals: combineUsageTotals(entry.accountIds, records) };
  }
}
function scheduleAccountDataSync() {
  accountDataSyncGeneration++;
  for (const timer of accountDataSyncTimers) clearTimeout(timer);
  accountDataSyncTimers = [];
  if (shuttingDown) return;
  const generation = accountDataSyncGeneration;
  const schedule = (totals) => {
    if (shuttingDown || generation !== accountDataSyncGeneration) return;
    const seconds = totals ? monitoringSettings.usageTotalsIntervalSeconds : monitoringSettings.accountStatusIntervalSeconds;
    const timer = setTimeout(() => {
      if (shuttingDown || generation !== accountDataSyncGeneration) return;
      const operation = (async () => {
        const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
        const state = await loadSub2ApiAccountStatus();
        if (totals) await synchronizeCachedUsageTotals(config, state, { forceRefresh: true });
      })().catch(() => {}).finally(() => {
        accountDataSyncOperations.delete(operation);
        schedule(totals);
      });
      accountDataSyncOperations.add(operation);
    }, seconds * 1000);
    timer.unref?.();
    accountDataSyncTimers[totals ? 1 : 0] = timer;
  };
  // Independent cadences: 25s status + 60s totals must not turn into 75s totals.
  schedule(false); schedule(true);
}
function applyMonitoringSettings(previous) {
  webSessionMonitor.setTickMs(monitoringSettings.webSessionScanIntervalSeconds * 1000);
  modelFingerprint.setTickMs(monitoringSettings.fingerprintScanIntervalSeconds * 1000);
  readUsageTotals.refreshSettings();
  requestProfileSync.drain();
  if (previous.poolMonitorIntervalSeconds !== monitoringSettings.poolMonitorIntervalSeconds) scheduleSub2ApiMonitor();
  if (previous.overloadIntervalSeconds !== monitoringSettings.overloadIntervalSeconds || previous.overloadConcurrency !== monitoringSettings.overloadConcurrency) {
    overloadMonitor.request.drain(); overloadMonitor.trigger();
  }
  overloadCooldown.request.drain();
  scheduleAccountDataSync();
}

function invalidateSub2ApiAccountStatusCache() {
  sub2ApiAccountStatusCache = { backend: null, fetchedAt: null, accounts: new Map() };
}

async function importSub2ApiPoolOnlyAccounts(remoteAccounts) {
  await syncCompletedOutputs();
  const knownEmails = new Set([...jobs.values()].map((job) => job.email.toLowerCase()));
  for (const account of remoteAccounts) {
    if (account?.platform !== "openai" || account?.type !== "oauth") continue;
    const email = sub2ApiAccountEmail(account);
    if (!email || knownEmails.has(email) || !normalizeSub2ApiAccountId(account.id)) continue;
    await withEmailJobLock(email, async () => {
      if (findJobByEmail(email)) return false;
      const id = crypto.randomUUID();
      const outputDir = path.join(OUTPUT_ROOT, id);
      const createdAt = new Date().toISOString();
      const planType = extractPlanTypeFromAccount(account, { preferJwt: false }) || null;
      const blockedReason = sub2ApiPermanentAccountFailure(account);
      await fs.mkdir(outputDir, { recursive: true });
      // OAuth tokens stay in the protected export file; status APIs expose only metadata.
      const proxy = !blockedReason && accountProxyMode === "sub2api"
        ? (await assignSub2ApiProxies([{ email, assignedProxyId: normalizeStoredProxyId(account.proxy_id) }])).get(email)
        : null;
      if (account.credentials?.access_token || account.credentials?.refresh_token) {
        const { id: remoteId, ...oauthAccount } = account;
        await fs.writeFile(path.join(outputDir, "sub2api-import-oauth.json"), `${JSON.stringify({
          type: "sub2api-data",
          accounts: [{ ...oauthAccount, credentials: { ...account.credentials, email } }],
        }, null, 2)}\n`, { mode: 0o600 });
      }
      await fs.writeFile(path.join(outputDir, JOB_META_FILENAME), `${JSON.stringify({
        version: 1,
        email,
        remark: typeof account.notes === "string" ? account.notes : "",
        pool_only: true,
        status: blockedReason ? "banned" : "completed",
        auto_repair_blocked: Boolean(blockedReason),
        auto_repair_blocked_reason: blockedReason,
        prompt: "已从 Sub2API 号池同步",
        plan_type: planType,
        login_mode: "manual",
        created_at: createdAt,
        completed_at: createdAt,
        last_operation_at: createdAt,
        last_operation_type: "sub2api_sync",
        assigned_proxy_id: blockedReason ? null : proxy?.id || normalizeStoredProxyId(account.proxy_id),
      }, null, 2)}\n`, { mode: 0o600 });
      if (proxy?.url) await saveStoredLoginCredentials(email, { proxyUrl: proxy.url });
      await syncCompletedOutputs(true);
      knownEmails.add(email);
      return true;
    });
  }
}

function publicSub2ApiAccountStatusState(state = sub2ApiAccountStatusCache) {
  const accounts = {};
  for (const [email, entry] of state.accounts || []) accounts[email] = publicSub2ApiAccountStatusEntry(entry);
  return {
    configured: Boolean(state.backend && state.fetchedAt),
    fetchedAt: state.fetchedAt || null,
    accounts,
  };
}

function publicSub2ApiAccountStatusEntry(entry) {
  const blocked = accountAutomationBlocked(entry.email);
  const job = findJobByEmail(entry.email);
  return {
    email: entry.email,
    remark: entry.remark ?? null,
    accountId: entry.accountIds?.[0] || null,
    accountIds: [...(entry.accountIds || [])],
    proxyIds: [...(entry.proxyIds || [])],
    boundIps: publicBoundIps(entry.proxyIds || []),
    boundProxies: publicBoundProxies(entry.proxyIds || []),
    inPool: true,
    enabled: entry.enabled ?? null,
    priority: entry.priority ?? null,
    planType: entry.planType || null,
    groupIds: [...(entry.groupIds || [])],
    remoteStatus: entry.remoteStatus || null,
    accountBlocked: blocked,
    accountBlockReason: blocked ? job?.autoRepairBlockedReason || null : null,
    boundProxyStatus: blocked && !job?.banProxyReleasePending ? "unbound" : entry.proxyIds?.length ? "bound" : "direct",
    usage: publicSub2ApiUsage(entry.usage),
    fetchedAt: entry.fetchedAt || null,
  };
}

function normalizeSub2ApiUsage(account, fallbackFetchedAt = null) {
  const extra = normalizeSub2ApiExtra(account?.extra);
  const primary = normalizeSub2ApiUsageWindow(extra, "5h");
  const secondary = normalizeSub2ApiUsageWindow(extra, "7d");
  const remoteUpdatedAt = normalizeSub2ApiUsageDate(extra.codex_usage_updated_at)
    || normalizeSub2ApiUsageDate(account?.usage_updated_at)
    || normalizeSub2ApiUsageDate(account?.usageUpdatedAt);
  const updatedAt = remoteUpdatedAt || fallbackFetchedAt;
  const creditsRaw = extra.codex_credits_snapshot?.credits;
  const resetCredits = normalizeResetCredits(extra.codex_reset_credit_snapshot, { cached: true });
  const credits = creditsRaw && typeof creditsRaw === "object"
    ? {
        hasCredits: typeof creditsRaw.has_credits === "boolean" ? creditsRaw.has_credits : null,
        unlimited: typeof creditsRaw.unlimited === "boolean" ? creditsRaw.unlimited : null,
        balance: creditsRaw.balance === null || creditsRaw.balance === undefined ? null : String(creditsRaw.balance),
        overageLimitReached: typeof creditsRaw.overage_limit_reached === "boolean" ? creditsRaw.overage_limit_reached : null,
      }
    : null;
  if (!primary && !secondary && !credits && !resetCredits) return null;
  const limitReached = [primary, secondary].some((window) => window?.usedPercent != null && window.usedPercent >= 100)
    ? true
    : [primary, secondary].some(Boolean) ? false : null;
  return {
    source: "sub2api",
    fetchedAt: updatedAt,
    snapshotTimestamp: remoteUpdatedAt,
    planType: extractPlanTypeFromAccount(account, { preferJwt: false }) || null,
    allowed: limitReached === null ? null : !limitReached,
    limitReached,
    primary,
    secondary,
    credits,
    resetCredits,
    resetCreditsObserved: Object.hasOwn(extra, "codex_reset_credit_snapshot"),
    resetCreditsFetchedAt: fallbackFetchedAt || updatedAt,
  };
}

function normalizeSub2ApiExtra(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length > 256_000) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function publicSub2ApiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    source: "sub2api",
    fetchedAt: usage.fetchedAt || null,
    planType: usage.planType || null,
    allowed: usage.allowed ?? null,
    limitReached: usage.limitReached ?? null,
    primary: publicSub2ApiUsageWindow(usage.primary),
    secondary: publicSub2ApiUsageWindow(usage.secondary),
    credits: usage.credits ? { ...usage.credits } : null,
    totals: usage.totals ? { ...usage.totals } : null,
    resetCredits: usage.resetCredits ? normalizeResetCredits({
      available_count: usage.resetCredits.availableCount,
      credits: usage.resetCredits.credits.map((credit) => ({ expires_at: credit.expiresAt })),
    }, { cached: usage.resetCredits.credits.length > 0 }) : null,
  };
}

function publicSub2ApiUsageWindow(window) {
  if (!window) return null;
  return { ...window };
}

function mergeSub2ApiUsage(current, next) {
  if (!current) return next || null;
  if (!next) return current;
  const currentTimestamp = Date.parse(current.snapshotTimestamp || current.fetchedAt || "") || 0;
  const nextTimestamp = Date.parse(next.snapshotTimestamp || next.fetchedAt || "") || 0;
  const currentHasRemoteTimestamp = Boolean(current.snapshotTimestamp);
  const nextHasRemoteTimestamp = Boolean(next.snapshotTimestamp);
  const preferNext = currentHasRemoteTimestamp !== nextHasRemoteTimestamp
    ? nextHasRemoteTimestamp
    : nextTimestamp >= currentTimestamp;
  const primary = preferNext ? (next.primary || current.primary) : (current.primary || next.primary);
  const secondary = preferNext ? (next.secondary || current.secondary) : (current.secondary || next.secondary);
  const credits = preferNext ? (next.credits || current.credits) : (current.credits || next.credits);
  const preferNextReset = next.resetCreditsObserved === true && (current.resetCreditsObserved !== true
    || (Date.parse(next.resetCreditsFetchedAt || next.fetchedAt || "") || 0) >= (Date.parse(current.resetCreditsFetchedAt || current.fetchedAt || "") || 0));
  const resetCredits = preferNextReset ? next.resetCredits : (current.resetCredits ?? next.resetCredits ?? null);
  return {
    ...current,
    ...next,
    fetchedAt: preferNext ? next.fetchedAt : current.fetchedAt,
    snapshotTimestamp: preferNext ? (next.snapshotTimestamp || current.snapshotTimestamp || null) : (current.snapshotTimestamp || next.snapshotTimestamp || null),
    planType: preferNext ? (next.planType || current.planType || null) : (current.planType || next.planType || null),
    allowed: preferNext ? (next.allowed ?? current.allowed ?? null) : (current.allowed ?? next.allowed ?? null),
    limitReached: preferNext ? (next.limitReached ?? current.limitReached ?? null) : (current.limitReached ?? next.limitReached ?? null),
    primary,
    secondary,
    credits,
    resetCredits,
    totals: next.totals ?? current.totals ?? null,
    resetCreditsObserved: preferNextReset ? next.resetCreditsObserved : current.resetCreditsObserved,
    resetCreditsFetchedAt: preferNextReset ? next.resetCreditsFetchedAt : current.resetCreditsFetchedAt,
  };
}

function normalizeSub2ApiUsageWindow(extra, window) {
  const prefix = window === "5h" ? "codex_5h" : "codex_7d";
  const legacyPrefix = resolveSub2ApiLegacyWindowPrefix(extra, window);
  const usedPercent = firstSub2ApiUsageValue(
    [extra[`${prefix}_used_percent`], extra[`${legacyPrefix}_used_percent`]],
    normalizeSub2ApiUsagePercent,
  );
  const resetAt = firstSub2ApiUsageValue(
    [extra[`${prefix}_reset_at`], extra[`${legacyPrefix}_reset_at`]],
    normalizeSub2ApiUsageDate,
  );
  const resetAfterSeconds = firstSub2ApiUsageValue(
    [extra[`${prefix}_reset_after_seconds`], extra[`${legacyPrefix}_reset_after_seconds`]],
    normalizeSub2ApiUsageSeconds,
  );
  const windowMinutes = firstSub2ApiUsageValue(
    [extra[`${prefix}_window_minutes`], extra[`${legacyPrefix}_window_minutes`]],
    normalizeSub2ApiUsageSeconds,
  );
  if (usedPercent === null && !resetAt && resetAfterSeconds === null && windowMinutes === null) return null;
  return {
    usedPercent: usagePercentAfterReset(usedPercent, resetAt),
    resetAfterSeconds: resetAfterSeconds && resetAfterSeconds > 0 ? resetAfterSeconds : null,
    resetAt,
    limitWindowSeconds: windowMinutes && windowMinutes > 0 ? windowMinutes * 60 : null,
  };
}

function firstSub2ApiUsageValue(values, normalize) {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function resolveSub2ApiLegacyWindowPrefix(extra, window) {
  const primaryMinutes = normalizeSub2ApiUsageSeconds(extra.codex_primary_window_minutes);
  const secondaryMinutes = normalizeSub2ApiUsageSeconds(extra.codex_secondary_window_minutes);
  if (primaryMinutes !== null && secondaryMinutes !== null) {
    if (primaryMinutes <= 360 && secondaryMinutes > 360) return window === "5h" ? "codex_primary" : "codex_secondary";
    if (secondaryMinutes <= 360 && primaryMinutes > 360) return window === "5h" ? "codex_secondary" : "codex_primary";
  }
  if (primaryMinutes !== null) return primaryMinutes <= 360
    ? (window === "5h" ? "codex_primary" : "codex_secondary")
    : (window === "5h" ? "codex_secondary" : "codex_primary");
  if (secondaryMinutes !== null) return secondaryMinutes <= 360
    ? (window === "5h" ? "codex_secondary" : "codex_primary")
    : (window === "5h" ? "codex_primary" : "codex_secondary");
  // Sub2API's legacy fallback treats primary as 7d and secondary as 5h.
  return window === "5h" ? "codex_secondary" : "codex_primary";
}

function normalizeSub2ApiUsagePercent(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : null;
}

function normalizeSub2ApiUsageSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 31_536_000 ? Math.round(number) : null;
}

function normalizeSub2ApiUsageDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric <= 0) return null;
  const timestamp = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function getSub2ApiAccountStatusForJob(job, state = sub2ApiAccountStatusCache) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  const expectedBackend = config?.baseUrl ? monitorBackendIdentity(config) : null;
  if (!state?.fetchedAt || state.backend !== expectedBackend) {
    return { inPool: null, enabled: null, priority: null, accountId: null, accountIds: [], groupIds: [], remoteStatus: null, planType: null, usage: null };
  }
  const entry = state.accounts.get(String(job.email || "").toLowerCase());
  if (!entry) return { inPool: false, enabled: null, priority: null, accountId: null, accountIds: [], groupIds: [], remoteStatus: null, planType: null, usage: null };
  return {
    inPool: true,
    enabled: entry.enabled ?? null,
    priority: entry.priority ?? null,
    accountId: entry.accountIds?.[0] || null,
    accountIds: [...(entry.accountIds || [])],
    proxyIds: [...(entry.proxyIds || [])],
    groupIds: [...(entry.groupIds || [])],
    remoteStatus: entry.remoteStatus || null,
    planType: entry.planType || null,
    usage: entry.usage || null,
  };
}

function getJobPlanType(job, state = sub2ApiAccountStatusCache) {
  return job.workspacePlanType || job.planType || getSub2ApiAccountStatusForJob(job, state).planType || null;
}

function normalizeSub2ApiAccountId(value) {
  const id = String(value ?? "").trim();
  return id
    && id.length <= 128
    && !/[/?#]/.test(id)
    && !["__proto__", "constructor", "prototype"].includes(id.toLowerCase())
    ? id
    : null;
}

function normalizeSub2ApiPlanTypeState(value) {
  const normalized = Object.create(null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;
  for (const [rawId, rawPlanType] of Object.entries(value)) {
    const accountId = normalizeSub2ApiAccountId(rawId);
    if (!accountId) continue;
    normalized[accountId] = normalizePlanType(rawPlanType) || null;
  }
  return normalized;
}

function sub2ApiAccountGroupIds(account) {
  const values = [
    ...(Array.isArray(account?.group_ids) ? account.group_ids : []),
    ...(Array.isArray(account?.groupIds) ? account.groupIds : []),
    ...(Array.isArray(account?.account_groups) ? account.account_groups.map((item) => item?.group_id ?? item?.groupId ?? item?.id) : []),
    ...(Array.isArray(account?.groups) ? account.groups.map((item) => item?.id ?? item?.group_id ?? item?.groupId) : []),
  ];
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function sub2ApiAccountSchedulable(account) {
  for (const value of [account?.schedulable, account?.is_schedulable, account?.enabled, account?.is_enabled]) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
    if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  }
  return null;
}

function sub2ApiAccountPriority(account) {
  for (const value of [account?.priority, account?.extra?.priority, account?.credentials?.priority, account?.settings?.priority]) {
    if (value === null || value === undefined || String(value).trim() === "") continue;
    const number = Number(value);
    if (Number.isSafeInteger(number) && number >= 0) return number;
    const text = String(value).trim();
    if (text.length <= 64 && !/[\r\n]/.test(text)) return text;
  }
  return null;
}

function mergeSub2ApiPriority(current, next) {
  return current === null || current === undefined ? (next ?? null) : current;
}

function mergeSub2ApiBoolean(current, next) {
  if (current === null || current === undefined) return next ?? null;
  if (next === null || next === undefined) return current;
  return current === true && next === true;
}

async function listSub2ApiAccounts(config, options = {}) {
  const accounts = [];
  const withMeta = options?.withMeta === true;
  let complete = true;
  const pageSize = 100;
  let page = 1;
  let pages = 1;
  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      platform: "openai",
    });
    const payload = await requestSub2Api(config, `/api/v1/admin/accounts?${query}`);
    const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.list)
            ? data.list
            : Array.isArray(data?.records)
              ? data.records
              : Array.isArray(data?.accounts)
                ? data.accounts
                : Array.isArray(payload?.accounts)
                  ? payload.accounts
                  : null;
    if (!items) complete = false;
    const pageItems = items || [];
    accounts.push(...pageItems.filter((account) => account && typeof account === "object"));
    const reportedPages = Number(data?.pages ?? data?.total_pages ?? data?.totalPages);
    const reportedTotal = Number(data?.total ?? data?.total_count ?? data?.count);
    pages = Number.isSafeInteger(reportedPages) && reportedPages > 0
      ? reportedPages
      : Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
        ? Math.max(page, Math.ceil(reportedTotal / pageSize))
        : pageItems.length >= pageSize ? page + 1 : page;
    page += 1;
  } while (page <= pages && page <= 1_000);
  if (page <= pages) complete = false;
  return withMeta ? { accounts, complete } : accounts;
}

async function listSub2ApiTargetGroups(config) {
  const results = await Promise.allSettled(SUB2API_TARGET_GROUP_PLATFORMS.map(async (platform) => {
    const payload = await requestSub2Api(config, `/api/v1/admin/groups/all?platform=${platform}`);
    const groups = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
    return groups
      .filter((group) => group && Number.isInteger(Number(group.id)))
      .map((group) => ({
        id: Number(group.id),
        name: String(group.name || `号池 ${group.id}`),
        platform: String(group.platform || platform).trim().toLowerCase() || platform,
        status: String(group.status || "active"),
      }));
  }));
  const successfulResults = results.filter((result) => result.status === "fulfilled");
  const successful = successfulResults.flatMap((result) => result.value);
  if (!successfulResults.length) {
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  const groups = new Map();
  for (const group of successful) {
    const key = String(group.id);
    if (!groups.has(key)) groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => (
    String(left.platform).localeCompare(String(right.platform))
      || left.id - right.id
      || String(left.name).localeCompare(String(right.name), "zh-CN")
  ));
}

function normalizeAccountProxyMode(value) {
  return ["sub2api", "plan"].includes(value) ? value : "global";
}

function validateAccountProxyMode(value) {
  if (!["global", "sub2api", "plan"].includes(value)) throw httpError(400, "代理分配模式无效");
  return value;
}

async function prepareAccountProxyModeChange(nextMode) {
  if (nextMode === accountProxyMode) return null;
  if ([...jobs.values()].some((job) => isActive(job.status) || job.poolRefreshAction)) {
    throw httpError(409, "请等待登录、冷却和号池同步任务完成后再切换代理模式");
  }
  if (nextMode === "global") return { nextMode, pending: [], assignments: new Map() };

  const config = sub2ApiSettingsConfig;
  if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
  if (nextMode === "plan") return { nextMode, pending: [], assignments: new Map() };
  const proxies = await listSub2ApiProxies(config);
  if (!proxies.some((proxy) => proxy.url && !isSub2ApiProxyExpired(proxy))) {
    throw httpError(409, "Sub2API 中没有可用且包含连接地址的代理");
  }
  const pending = listUniqueJobs();
  const assignments = pending.length ? await assignSub2ApiProxies(pending) : new Map();
  return { nextMode, pending, assignments };
}

async function applyAccountProxyModeChange(change) {
  if (!change) return;
  for (const job of jobs.values()) job.fixedProxy = change.nextMode === "sub2api" || (change.nextMode === "plan" && hasPlanProxyBinding(job));
  await Promise.all(change.pending.map((job) => withEmailJobLock(job.email, async () => {
    const proxy = change.assignments.get(job.id);
    if (!proxy) return;
    job.assignedProxyId = proxy.id;
    await updateJobProxy(job, proxy.url);
    await saveJobMetadata(job);
  })));
}

function normalizeCooldownMinutes(value) {
  const minutes = Number(value ?? 60);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_ACCOUNT_PROXY_COOLDOWN_MINUTES) {
    throw httpError(400, `冷却时长必须是 1 到 ${MAX_ACCOUNT_PROXY_COOLDOWN_MINUTES} 分钟的整数`);
  }
  return minutes;
}

function effectiveAccountProxyUrl(assignedUrl, globalUrl, requestedUrl = null) {
  if (accountProxyMode === "plan") return assignedUrl || null;
  return accountProxyMode === "sub2api" ? (assignedUrl || null) : (globalUrl || requestedUrl || assignedUrl || null);
}

function normalizeStoredProxyId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizePoolRefreshAction(value) {
  return ["cooldown", "switch-proxy", "relogin", "reauthorize"].includes(value) ? value : null;
}

function normalizeSub2ApiProxyList(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.proxies) ? data.proxies : [];
  const directList = list.some((proxy) => Object.hasOwn(proxy || {}, "id"));
  return list.flatMap((proxy) => {
    const id = normalizeStoredProxyId(proxy?.id);
    if (!id) return [];
    const protocol = String(proxy.protocol || "http").replace(/:\/\/$/, "").toLowerCase();
    const explicitUrl = String(proxy.proxy_url || proxy.url || "").trim();
    let url = null;
    try {
      if (explicitUrl) url = normalizeProxyUrl(explicitUrl);
      else if (proxy.host && Number(proxy.port) > 0 && ["http", "https", "socks5", "socks5h"].includes(protocol)) {
        const parsed = new URL(`${protocol}://${proxy.host}:${Number(proxy.port)}`);
        const username = String(proxy.username || proxy.user || proxy.auth?.username || "");
        const password = String(proxy.password || proxy.auth?.password || "");
        if (username) parsed.username = username;
        if (password) parsed.password = password;
        url = normalizeProxyUrl(parsed.toString());
      }
    } catch {}
    return [{
      ...proxy,
      id,
      name: String(proxy.name || `代理 ${id}`),
      protocol,
      host: String(proxy.host || ""),
      port: Number(proxy.port || 0),
      ipAddress: String(proxy.ip_address || proxy.ipAddress || proxy.exit_ip || proxy.ip || proxy.host || "").trim(),
      status: String(proxy.status || "active"),
      url,
      hasUrl: Boolean(url),
      directList,
    }];
  });
}

function publicSub2ApiProxy(proxy) {
  return {
    id: proxy.id,
    name: proxy.name,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    ipAddress: proxy.ipAddress,
    status: proxy.status,
  };
}

async function listSub2ApiProxies(config = sub2ApiSettingsConfig) {
  if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
  const proxies = normalizeSub2ApiProxyList(await requestSub2Api(config, "/api/v1/admin/proxies/all"));
  publicProxyCatalog = { backend: monitorBackendIdentity(config), proxies: new Map(proxies.map((proxy) => [proxy.id, publicSub2ApiProxy(proxy)])) };
  return proxies;
}

function publicBoundIps(proxyIds, job = null) {
  return [...new Set(publicBoundProxies(proxyIds, job).map((proxy) => proxy.ipAddress).filter(Boolean))];
}

function publicBoundProxies(proxyIds, job = null) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  const catalog = config && publicProxyCatalog.backend === monitorBackendIdentity(config) ? publicProxyCatalog.proxies : new Map();
  return [...new Set(proxyIds.map(normalizeStoredProxyId).filter(Boolean))].map((id) => {
    const proxy = catalog.get(id);
    const local = normalizeStoredProxyId(job?.assignedProxyId) === id ? job : null;
    return { id, name: proxy?.name || local?.boundProxyName || `代理 ${id}`, ipAddress: proxy?.ipAddress || local?.boundIp || null };
  });
}

// Queue preparation applies the current plan; provider settings reuse that frozen route.
async function codexOAuthSettingsForJob(job) {
  const selectedMode = codexAuthMode;
  if (accountProxyMode === "plan") {
    const route = hasPlanProxyBinding(job) ? planCodexProxyRoute(job, job.workspaceAccountId)
      : await preparePlanCodexProxy(job, getJobPlanType(job), job.workspaceAccountId);
    return { ...route, loginProxyUrl: route.proxyUrl };
  }
  if (selectedMode !== "sub2api") return { codexAuthMode: "local" };
  const config = sub2ApiSettingsConfig;
  if (!config?.baseUrl || !config?.adminApiKey) throw new Error("请先配置 Sub2API 后端地址和管理员 API Key");
  let proxyId = null;
  if (accountProxyMode === "sub2api") {
    proxyId = normalizeStoredProxyId(job.assignedProxyId);
    if (!proxyId) throw new Error("账号缺少已分配的 Sub2API 代理");
  } else if (job.proxyUrl) {
    const proxies = await listSub2ApiProxies(config);
    proxyId = proxies.find((proxy) => proxy.url === job.proxyUrl && !isSub2ApiProxyExpired(proxy))?.id || null;
    if (!proxyId) throw new Error("Sub2API 授权需要使用号池中已有的同一代理，请选择 Sub2API 账号代理模式或同步全局代理配置");
  }
  return { codexAuthMode: selectedMode, loginProxyUrl: job.proxyUrl,
    sub2ApiOAuth: { baseUrl: config.baseUrl, adminApiKey: config.adminApiKey, proxyId } };
}

function jobSub2ApiProxyConfig(job, planType = getJobPlanType(job)) {
  return resolveSub2ApiConfigForAccount(sub2ApiSettingsConfig, { credentials: { email: job.email, plan_type: planType } });
}

function jobProxySwitchMode(job) {
  if (accountProxyMode === "sub2api") return SUB2API_PROXY_BALANCED;
  if (accountProxyMode !== "plan") return null;
  const proxyId = jobSub2ApiProxyConfig(job)?.proxyId;
  if ([SUB2API_PROXY_BALANCED, SUB2API_PROXY_DIRECT].includes(proxyId)) return proxyId;
  return normalizeStoredProxyId(proxyId) ? "fixed" : null;
}

function jobCanSwitchProxy(job) {
  return Boolean(jobProxySwitchMode(job));
}

// Manual switching reapplies the current plan; automatic allocation stays sticky.
async function resolveManualProxySwitch(job) {
  const mode = jobProxySwitchMode(job);
  if (mode === SUB2API_PROXY_DIRECT) return null;
  if (mode === SUB2API_PROXY_BALANCED) {
    const proxy = (await assignSub2ApiProxies([job], { reassign: true })).get(job.id);
    if (!proxy) throw httpError(409, "没有可用的切换代理");
    return proxy;
  }
  if (mode === "fixed") {
    const proxyId = normalizeStoredProxyId(jobSub2ApiProxyConfig(job)?.proxyId);
    const proxy = (await listSub2ApiProxies()).find((item) => item.id === proxyId);
    if (!proxy?.url || isSub2ApiProxyExpired(proxy)) throw httpError(409, "当前方案指定的代理已失效，原绑定保持不变");
    return proxy;
  }
  throw httpError(409, "当前方案未指定切换目标，请选择直连、固定代理或均衡分配");
}

function hasPlanProxyBinding(job) {
  return Boolean(job && (job.authorizationProxySelected || normalizeStoredProxyId(job.assignedProxyId)));
}

function assertBoundProxyIp(job, proxy) {
  if (job.boundIp && proxy?.ipAddress && job.boundIp !== proxy.ipAddress) {
    throw httpError(409, "账号绑定节点的出口 IP 已变化，请修复代理或手动切换 IP");
  }
}

async function restorePlanProxyBinding(job) {
  const proxyId = normalizeStoredProxyId(job.assignedProxyId);
  let proxy = null;
  if (proxyId) {
    proxy = (await listSub2ApiProxies()).find((item) => item.id === proxyId);
    if (!proxy?.url || isSub2ApiProxyExpired(proxy)) throw httpError(409, "账号绑定代理已失效，请修复代理或手动切换 IP");
    assertBoundProxyIp(job, proxy);
  }
  await saveJobProxyBinding(job, proxy);
  job.proxyFallbackActive = false;
}

async function saveJobProxyBinding(job, proxy) {
  job.authorizationProxySelected = true;
  job.assignedProxyId = proxy?.id || null;
  job.boundIp = proxy?.ipAddress || null;
  job.boundProxyName = proxy?.name || null;
  job.proxyUrl = proxy?.url || null;
  job.fixedProxy = accountProxyMode === "plan" || Boolean(proxy);
  accountProxyReservations.delete(job.email.toLowerCase());
  await saveStoredLoginCredentials(job.email, job);
  await saveJobMetadata(job);
}

// Resolve a discovered plan, or reapply a known plan before any relogin request.
// The dynamic login proxy never becomes the pool binding.
async function preparePlanCodexProxy(job, rawPlanType, workspaceId, { reapply = false } = {}) {
  if (hasPlanProxyBinding(job) && !reapply) {
    await restorePlanProxyBinding(job);
    return planCodexProxyRoute(job, workspaceId);
  }
  const planType = normalizePlanType(rawPlanType);
  if (!planType) throw httpError(409, "网页登录后未识别到 PlanType，已停止授权，请重试");
  const config = sub2ApiSettingsConfig;
  if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
  const accountConfig = reapply ? jobSub2ApiProxyConfig(job, planType)
    : await resolveSub2ApiWriteConfig(jobSub2ApiProxyConfig(job, planType));
  let proxy = null;
  if (accountConfig.proxyId === SUB2API_PROXY_BALANCED) {
    if (hasPlanProxyBinding(job) && job.assignedProxyId) {
      await restorePlanProxyBinding(job);
      return planCodexProxyRoute(job, workspaceId);
    }
    proxy = (await assignSub2ApiProxies([job])).get(job.id);
  } else {
    let proxyId = normalizeStoredProxyId(accountConfig.proxyId);
    if (!accountConfig.proxyId) {
      if (hasPlanProxyBinding(job)) {
        await restorePlanProxyBinding(job);
        return planCodexProxyRoute(job, workspaceId);
      }
      const listing = await listSub2ApiAccounts(config, { withMeta: true });
      if (!listing.complete) throw httpError(409, "Sub2API 账号列表不完整，已停止授权代理选择");
      const remote = listing.accounts.find((account) => sub2ApiAccountEmail(account) === job.email.toLowerCase());
      proxyId = remote ? normalizeStoredProxyId(remote.proxy_id) : normalizeStoredProxyId(job.assignedProxyId);
    }
    if (proxyId) {
      proxy = (await listSub2ApiProxies(config)).find((item) => item.id === proxyId);
      if (!proxy?.url || isSub2ApiProxyExpired(proxy)) throw httpError(409, "授权代理已失效，请检查当前 PlanType 的 Sub2API 方案");
      if (normalizeStoredProxyId(job.assignedProxyId) === proxy.id) assertBoundProxyIp(job, proxy);
    }
  }
  job.planType = planType;
  job.proxyFallbackActive = false;
  await saveJobProxyBinding(job, proxy);
  touch(job);
  return planCodexProxyRoute(job, workspaceId);
}

function planCodexProxyRoute(job, workspaceId) {
  const config = sub2ApiSettingsConfig;
  return { proxyUrl: job.proxyUrl || null, helperLoginProxy: helperLoginProxyRoute(job, job.proxyUrl), codexAuthMode,
    workspaceId: typeof workspaceId === "string" ? workspaceId : null,
    sub2ApiOAuth: codexAuthMode === "sub2api" ? { baseUrl: config.baseUrl, adminApiKey: config.adminApiKey, proxyId: normalizeStoredProxyId(job.assignedProxyId) } : null };
}

async function refreshJobProxyBinding(job) {
  if (accountAutomationBlocked(job.email)) { job.assignedProxyId = null; job.proxyUrl = null; job.boundIp = null; job.boundProxyName = null; return; }
  if (accountProxyMode === "plan") {
    if (hasPlanProxyBinding(job)) await restorePlanProxyBinding(job);
    else job.fixedProxy = false;
    return;
  }
  job.fixedProxy = accountProxyMode === "sub2api";
  if (!job.fixedProxy) return;
  if (!job.assignedProxyId) {
    const assignment = (await assignSub2ApiProxies([job])).get(job.id);
    if (assignment) job.assignedProxyId = assignment.id;
  }
  const proxy = (await listSub2ApiProxies()).find((item) => item.id === job.assignedProxyId);
  if (!proxy?.url || isSub2ApiProxyExpired(proxy)) throw httpError(409, "账号绑定代理已失效，请在 Sub2API 修复代理或手动切换 IP");
  job.proxyUrl = proxy.url;
  job.boundIp = proxy.ipAddress;
  job.boundProxyName = proxy.name;
  job.proxyFallbackActive = false;
  await saveStoredLoginCredentials(job.email, job);
  await saveJobMetadata(job);
}

function proxyIpKey(proxy) {
  return String(proxy.ipAddress || proxy.host || proxy.id).trim().toLowerCase();
}

async function assignSub2ApiProxies(accounts, { reassign = false } = {}) {
  if (accounts.some(account => accountAutomationBlocked(account.email))) throw httpError(409, "账号已确认封禁，不再分配代理 IP");
  const run = accountProxyAssignmentPromise.catch(() => {}).then(async () => {
    const config = sub2ApiSettingsConfig;
    if (!config?.baseUrl || !config?.adminApiKey) throw httpError(409, "请先配置 Sub2API 后端和管理员 API Key");
    const allProxies = await listSub2ApiProxies(config);
    const allProxiesById = new Map(allProxies.map((proxy) => [proxy.id, proxy]));
    const proxies = allProxies.filter((proxy) => proxy.url && !isSub2ApiProxyExpired(proxy));
    const ipGroups = new Map();
    for (const proxy of proxies) {
      const ip = proxyIpKey(proxy);
      if (!ipGroups.has(ip)) ipGroups.set(ip, { ip, accountCount: 0, proxyCounts: new Map(), proxies: [] });
      ipGroups.get(ip).proxies.push(proxy);
    }
    if (!ipGroups.size) throw httpError(409, "Sub2API 中没有可用且包含连接地址的代理");
    const targets = new Set(accounts.map((account) => String(account.email || "").toLowerCase()));
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw httpError(409, "Sub2API 账号列表不完整，已停止代理分配");
    const proxyById = new Map(proxies.map((proxy) => [proxy.id, proxy]));
    const backend = monitorBackendIdentity(config);
    for (const [email, reservation] of accountProxyReservations) {
      if (reservation.expiresAt < Date.now() || reservation.backend !== backend) accountProxyReservations.delete(email);
    }
    const targetByEmail = new Map(accounts.map((account) => [String(account.email || "").toLowerCase(), account]));
    const remoteEmails = new Set();
    const countedEmails = new Set();
    const assignments = new Map();
    for (const remote of listing.accounts) {
      const email = String(sub2ApiAccountEmail(remote) || "").toLowerCase();
      if (email) remoteEmails.add(email);
      if (accountAutomationBlocked(email) || sub2ApiPermanentAccountFailure(remote)) continue;
      const local = findJobByEmail(email);
      const assignedProxyId = targets.has(email)
        ? (accountProxyMode === "sub2api"
          ? local?.assignedProxyId || remote.proxy_id || accountProxyReservations.get(email)?.proxyId
          : remote.proxy_id || accountProxyReservations.get(email)?.proxyId || local?.assignedProxyId)
        : accountProxyReservations.get(email)?.proxyId || local?.assignedProxyId || remote.proxy_id;
      const proxy = proxyById.get(normalizeStoredProxyId(assignedProxyId));
      if (targets.has(email)) {
        const target = targetByEmail.get(email);
        if (!reassign && target && !target.assignedProxyId && proxy && !assignments.has(target.id || email)) {
          assignments.set(target.id || email, proxy);
          const group = ipGroups.get(proxyIpKey(proxy));
          group.accountCount += 1;
          group.proxyCounts.set(proxy.id, (group.proxyCounts.get(proxy.id) || 0) + 1);
        }
        continue;
      }
      if (!proxy) continue;
      if (email && countedEmails.has(email)) continue;
      if (email) countedEmails.add(email);
      const group = ipGroups.get(proxyIpKey(proxy));
      group.accountCount += 1;
      group.proxyCounts.set(proxy.id, (group.proxyCounts.get(proxy.id) || 0) + 1);
    }
    for (const job of jobs.values()) {
      const email = String(job.email || "").toLowerCase();
      if (!email || accountAutomationBlocked(email) || targets.has(email) || remoteEmails.has(email)) continue;
      const proxy = proxyById.get(normalizeStoredProxyId(accountProxyReservations.get(email)?.proxyId || job.assignedProxyId));
      if (!proxy) continue;
      const group = ipGroups.get(proxyIpKey(proxy));
      group.accountCount += 1;
      group.proxyCounts.set(proxy.id, (group.proxyCounts.get(proxy.id) || 0) + 1);
    }
    for (const [email, reservation] of accountProxyReservations) {
      if (reservation.expiresAt < Date.now() || reservation.backend !== backend) {
        accountProxyReservations.delete(email);
        continue;
      }
      if (targets.has(email) || remoteEmails.has(email) || findJobByEmail(email)) continue;
      const proxy = proxyById.get(reservation.proxyId);
      if (!proxy) continue;
      const group = ipGroups.get(proxyIpKey(proxy));
      group.accountCount += 1;
      group.proxyCounts.set(proxy.id, (group.proxyCounts.get(proxy.id) || 0) + 1);
    }
    for (const account of accounts) {
      const key = String(account.email || "").toLowerCase();
      if (!reassign && assignments.has(account.id || key)) continue;
      if (!reassign && account.assignedProxyId) {
        const preserved = proxyById.get(account.assignedProxyId);
        if (preserved) {
          assignments.set(account.id || key, preserved);
          const group = ipGroups.get(proxyIpKey(preserved));
          group.accountCount += 1;
          group.proxyCounts.set(preserved.id, (group.proxyCounts.get(preserved.id) || 0) + 1);
          continue;
        }
        throw httpError(409, `${account.email} 绑定的代理已失效，请修复代理或手动切换 IP`);
      }
      const previousProxy = allProxiesById.get(account.assignedProxyId);
      const previousIp = previousProxy ? proxyIpKey(previousProxy) : null;
      const alternatives = [...ipGroups.values()].filter((group) => !reassign || !previousIp || group.ip !== previousIp);
      if (reassign && previousIp && !alternatives.length) throw httpError(409, `${account.email} 当前 Sub2API 代理没有不同的出口 IP`);
      const candidates = alternatives;
      candidates.sort((left, right) => left.accountCount - right.accountCount || left.ip.localeCompare(right.ip));
      const group = candidates[0];
      const proxy = [...group.proxies].sort((left, right) => (group.proxyCounts.get(left.id) || 0) - (group.proxyCounts.get(right.id) || 0) || left.id - right.id)[0];
      assignments.set(account.id || key, proxy);
      group.accountCount += 1;
      group.proxyCounts.set(proxy.id, (group.proxyCounts.get(proxy.id) || 0) + 1);
    }
    for (const account of accounts) {
      const email = String(account.email || "").toLowerCase();
      const proxy = assignments.get(account.id || email);
      if (proxy) accountProxyReservations.set(email, { proxyId: proxy.id, backend, expiresAt: Date.now() + 300_000 });
    }
    return assignments;
  });
  accountProxyAssignmentPromise = run;
  return run;
}

async function assignNextSub2ApiProxy() {
  return (await assignSub2ApiProxies([{ email: crypto.randomUUID() }])).values().next().value;
}

function isSub2ApiAccountInMonitoredGroups(account, groupIds) {
  if (!groupIds.length) return true;
  const accountGroupIds = sub2ApiAccountGroupIds(account)
    .map(Number)
    .filter(Number.isSafeInteger);
  return groupIds.some((id) => accountGroupIds.includes(Number(id)));
}

function sub2ApiMonitorGroupIds(activeConfig, profileState = null) {
  const profiles = [...(profileState?.profiles || sub2ApiProfiles).values()];
  if (!profiles.length) return [...(activeConfig?.groupIds || [])];
  // An empty group selection means "all OpenAI accounts". Keep that meaning
  // when any profile is configured that way; otherwise monitor the union so a
  // plan bound to a non-active profile is not skipped.
  if (profiles.some((profile) => !Array.isArray(profile.groupIds) || profile.groupIds.length === 0)) return [];
  return [...new Set(profiles.flatMap((profile) => profile.groupIds).map(Number).filter(Number.isSafeInteger))];
}

function snapshotSub2ApiProfileState() {
  return {
    profiles: new Map([...sub2ApiProfiles.entries()].map(([id, profile]) => [id, { ...profile }])),
    bindings: { ...sub2ApiPlanTypeBindings },
  };
}

function monitorBackendIdentity(config) {
  // Include the key fingerprint so a tenant/key rotation cannot reuse an
  // account-ID PlanType baseline from a different Sub2API installation.
  return crypto.createHash("sha256")
    .update(`${String(config?.baseUrl || "")}\0${String(config?.adminApiKey || "")}`)
    .digest("hex")
    .slice(0, 24);
}

function legacyMonitorBackendIdentity(config) {
  return crypto.createHash("sha256")
    .update(String(config?.baseUrl || ""))
    .digest("hex")
    .slice(0, 24);
}

function isAutoRepairCoolingDown(job) {
  if (!job.autoRepairLastAttemptAt || monitoringSettings.poolRepairRetrySeconds <= 0) return false;
  return Date.now() - new Date(job.autoRepairLastAttemptAt).getTime() < monitoringSettings.poolRepairRetrySeconds * 1000;
}

function getAutoRepairEligibility(job) {
  if (job.autoRepairBlocked) return { eligible: false, reason: "账号已确认封禁、删除或永久停用" };
  if (!job.lastAuthAutomated) return { eligible: false, reason: job.lastAuthAutomationReason || "上次授权不是全自动完成" };
  const requirements = job.lastAuthRequirements || {};
  if (requirements.password && !job.password) return { eligible: false, reason: "已保存的密码无法读取" };
  if (requirements.emailOtp && !job.mailApiUrl) return { eligible: false, reason: "缺少可自动收取邮箱验证码的 API" };
  if (requirements.mfa && !job.totpSecret) return { eligible: false, reason: "已保存的 2FA 密钥无法读取" };
  if (!job.password && !job.mailApiUrl) return { eligible: false, reason: "缺少可自动登录的密码或邮件收码 API" };
  if (job.hasTotpCredential && !job.totpSecret) return { eligible: false, reason: "2FA 密钥在当前系统上无法恢复" };
  return { eligible: true, reason: "上次完整登录全自动完成，所需资料仍可用" };
}

function finishSub2ApiAutoRepairSuccess(job) {
  const operationPromise = performSub2ApiAutoRepairSuccess(job);
  sub2ApiAutoRepairPromises.add(operationPromise);
  void operationPromise.then(
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
    () => sub2ApiAutoRepairPromises.delete(operationPromise),
  );
  return operationPromise;
}

async function performSub2ApiAutoRepairSuccess(job) {
  const operation = job.autoRepairOperation;
  if (!operation) return false;
  job.autoRepairPendingAccountIds = [...new Set(operation.accountIds)];
  job.autoRepairPendingBackend = operation.backend;
  try {
    const payload = await buildSub2ApiUploadPayload([job]);
    const localAccount = payload.accounts.find((account) => sub2ApiAccountEmail(account) === job.email.toLowerCase())
      || payload.accounts[0];
    if (!localAccount?.credentials) throw new Error("新授权文件中没有可更新的账号凭据");

    const pendingIds = new Set(job.autoRepairPendingAccountIds);
    for (const remoteAccount of operation.accounts) {
      const accountId = Number(remoteAccount.id);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) continue;
      // Prefer the newly issued OAuth plan; the remote error row may still carry
      // the old Team plan after a workspace downgrade.
      const remotePlanType = extractPlanTypeFromAccount(remoteAccount, { preferJwt: false });
      const localPlanType = extractPlanTypeFromAccount(localAccount, { preferJwt: false });
      const profileAccount = {
        ...localAccount,
        ...remoteAccount,
        id: remoteAccount.id,
        name: remoteAccount.name,
        credentials: {
          ...(localAccount.credentials && typeof localAccount.credentials === "object" ? localAccount.credentials : {}),
          ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
        },
        extra: {
          ...(localAccount.extra && typeof localAccount.extra === "object" ? localAccount.extra : {}),
          ...(remoteAccount.extra && typeof remoteAccount.extra === "object" ? remoteAccount.extra : {}),
        },
      };
      if (localPlanType || remotePlanType) profileAccount.plan_type = localPlanType || remotePlanType;
      const accountConfig = await resolveSub2ApiWriteConfig(resolveSub2ApiConfigForAccount(operation.config, profileAccount, operation.profileState));
      const credentials = {
        ...(remoteAccount.credentials && typeof remoteAccount.credentials === "object" ? remoteAccount.credentials : {}),
        ...localAccount.credentials,
      };
      if (accountConfig.modelWhitelist.length) {
        credentials.model_mapping = Object.fromEntries(accountConfig.modelWhitelist.map((model) => [model, model]));
      }
      const extra = buildSub2ApiAccountExtra(remoteAccount.extra, accountConfig, remoteAccount);
      const accountName = renderSub2ApiAccountName(accountConfig.accountNameTemplate, {
        ...localAccount,
        id: remoteAccount.id,
        name: remoteAccount.name,
      });
      const accountUpdate = {
        credentials,
        extra,
        ...(job.remarkSyncPending ? { notes: job.remark || "" } : {}),
        ...(accountName ? { name: accountName } : {}),
        ...(accountConfig.groupIds.length ? { group_ids: fingerprintGroupIds(accountConfig, profileAccount, accountConfig.groupIds, remoteAccount) } : {}),
        ...await sub2ApiProxyFieldsForAccount(accountConfig, job.email, remoteAccount),
        ...(accountConfig.concurrency !== null ? { concurrency: accountConfig.concurrency } : {}),
        ...(accountConfig.loadFactor !== null ? { load_factor: accountConfig.loadFactor } : {}),
        ...(accountConfig.priority !== null && !accountConfig.importDatePriority?.enabled ? { priority: accountConfig.priority } : {}),
      };
      await requestSub2Api(operation.config, `/api/v1/admin/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify(accountUpdate),
      });
      await recoverSub2ApiAuthorization(operation.config, accountId, job.email, { monitorRepair: true });
      pendingIds.delete(accountId);
      job.autoRepairPendingAccountIds = [...pendingIds];
    }

    job.autoRepairLastSuccessAt = new Date().toISOString();
    job.autoRepairLastError = null;
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = null;
    job.autoRepairOperation = null;
    clearAutoRepairBlock(job);
    appendJobLog(job, `[monitor] 已用新授权覆盖更新 Sub2API 中的 ${operation.accountIds.length} 条账号记录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return true;
  } catch (error) {
    job.autoRepairLastAttemptAt = new Date().toISOString();
    job.autoRepairLastError = String(error?.message || error).slice(0, 500);
    job.autoRepairOperation = null;
    appendJobLog(job, `[monitor] 新授权已生成，但更新 Sub2API 失败：${job.autoRepairLastError}。下次巡检会优先重传，不会重复登录。\n`);
    touch(job);
    await saveJobMetadata(job);
    return false;
  }
}

async function finishSub2ApiAutoRepairFailure(job) {
  if (!job.autoRepairOperation) return;
  const operation = job.autoRepairOperation;
  job.autoRepairOperation = null;
  job.autoRepairLastAttemptAt = new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason || job.lastError || "自动重新登录并授权未完成";
  appendJobLog(job, job.autoRepairBlocked
    ? "[monitor] 自动授权确认账号已永久不可用，已停止后续巡检。\n"
    : `[monitor] 本次自动授权未完成，${monitoringSettings.poolRepairRetrySeconds} 秒内不会重复启动。\n`);
  if (!job.autoRepairBlocked) {
    job.autoRepairPendingAccountIds = [];
    job.autoRepairPendingBackend = operation.backend;
  }
  touch(job);
  await saveJobMetadata(job);
}

async function exportSourceAccounts(res, ids) {
  const selected = resolveSelectedJobs(ids);
  const lines = [];
  for (const job of selected) {
    let password = job.password || "";
    let totpSecret = job.totpSecret || "";
    if ((!password && job.hasPasswordCredential) || (!totpSecret && job.hasTotpCredential)) {
      const storedCredentials = await loadStoredLoginCredentials(job.email);
      password ||= storedCredentials.password;
      totpSecret ||= storedCredentials.totpSecret;
    }
    if ((job.loginMode === "password" || job.hasPasswordCredential) && !password) {
      throw httpError(409, `${job.email} 的密码未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (job.hasTotpCredential && !totpSecret) {
      throw httpError(409, `${job.email} 的 2FA 密钥未能从系统安全凭据存储读取，请重新导入该账号资料`);
    }
    if (totpSecret && job.remark) {
      if (/[\r\n]/.test(job.remark)) throw httpError(409, `${job.email} 的备注包含换行，请使用 JSON 下载保留完整备注`);
      totpSecret += `(${job.remark})`;
    }
    if (password) {
      const parts = [job.email, password];
      if (job.mailRequestBody) parts.push(job.mailRequestBody);
      else if (job.mailApiUrl) parts.push(job.mailApiUrl);
      if (totpSecret) parts.push(totpSecret);
      lines.push(parts.join("----"));
      continue;
    }
    if (job.mailRequestBody) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailRequestBody}----${totpSecret}`
        : `${job.email}----${job.mailRequestBody}`);
      continue;
    }
    if (job.mailApiUrl) {
      lines.push(totpSecret
        ? `${job.email}----${job.mailApiUrl}----${totpSecret}`
        : `${job.email}----${job.mailApiUrl}`);
      continue;
    }
    if (job.loginMode === "manual") {
      throw httpError(409, `${job.email} 是旧版本任务，原始登录资料未保存，请重新导入该账号资料后再导出`);
    }
    lines.push(totpSecret ? `${job.email}--------${totpSecret}` : job.email);
  }
  const payload = Buffer.from(`\uFEFF${lines.join("\n")}\n`, "utf8");
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="chatgpt-account-source-${lines.length}-accounts-${downloadTimestamp()}.txt"`,
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function publicJob(job) {
  const autoRepair = getAutoRepairEligibility(job);
  const sub2ApiStatus = getSub2ApiAccountStatusForJob(job);
  const blocked = accountAutomationBlocked(job.email);
  return {
    id: job.id,
    email: job.email,
    remark: job.remark || "",
    remarkSyncPending: Boolean(job.remarkSyncPending),
    status: job.status,
    prompt: job.status === "queued"
      ? `排队中，前方还有 ${Math.max(0, getQueuePosition(job) - 1)} 条任务`
      : job.prompt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastOperationAt: job.lastOperationAt || job.createdAt,
    lastOperationType: job.lastOperationType || "initial_authorization",
    completedAt: job.completedAt,
    startedAt: job.startedAt,
    durationMs: getJobDurationMs(job),
    planType: job.workspacePlanType || getJobPlanType(job),
    sub2apiInPool: sub2ApiStatus.inPool,
    sub2apiEnabled: sub2ApiStatus.enabled,
    sub2apiPriority: sub2ApiStatus.priority,
    sub2apiAccountId: sub2ApiStatus.accountId,
    sub2apiAccountIds: sub2ApiStatus.accountIds,
    sub2apiGroupIds: sub2ApiStatus.groupIds,
    sub2apiRemoteStatus: sub2ApiStatus.remoteStatus,
    sub2apiPlanType: sub2ApiStatus.planType,
    sub2apiUsage: publicSub2ApiUsage(sub2ApiStatus.usage),
    overloadDetection: overloadMonitor.snapshot(job.email),
    overloadAutoCooldown: overloadCooldown.snapshot(job.email),
    modelFingerprint: modelFingerprint.snapshot(job.email, getJobPlanType(job) || "unknown"),
    lastError: job.lastError,
    canDownload: Boolean(job.resultSaved),
    poolOnly: Boolean(job.poolOnly),
    loginMode: job.loginMode || (job.mailApiUrl ? "email_otp" : "manual"),
    hasTotpKey: hasJobTotpKey(job),
    autoEmailOtp: Boolean(job.mailApiUrl),
    mailStatus: job.mailStatus,
    mailApiError: job.mailApiError,
    currentPhone: job.currentPhone,
    phoneError: job.phoneError,
    totpSetupSecret: job.status === "totp_setup_otp" ? job.totpSetupSecret : null,
    totpSetupUri: job.status === "totp_setup_otp" ? job.totpSetupUri : null,
    totpSetupError: job.totpSetupError || null,
    totpSetupReplaceExisting: Boolean(job.totpSetupReplaceExisting),
    totpRotationRemoteDisabled: Boolean(job.totpRotationRemoteDisabled),
    totpRotationStage: job.totpRotationStage || null,
    totpRotationIncomplete: Boolean(job.totpRotationIncomplete),
    passwordAddError: job.passwordAddError || null,
    passwordAddedAt: job.passwordAddedAt || null,
    smsProviderId: job.smsProviderId,
    smsProviderName: job.smsProviderName,
    smsServiceLabel: job.smsServiceLabel,
    smsStatus: job.smsStatus,
    smsError: job.smsError,
    securityCheckRequired: Boolean(job.securityCheckRequired),
    canRetry: ["failed", "mfa_failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canResume: canResumeAuthorization(job),
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canLoginWeb: canLoginWeb(job),
    webSessionCheckAttemptId: manualWebSessionChecks.get(job.id)?.attemptId || null,
    webSessionCheckPending: webSessionCheckPending(job),
    webSessionMaintenancePause: job.webSessionMaintenancePause || null,
    webSessionCheckStatus: manualWebSessionChecks.get(job.id)?.phase || null,
    webSessionCheckError: manualWebSessionChecks.get(job.id)?.error || null,
    webSessionAvailable: Boolean(job.webSessionAvailable),
    webSessionStatus: blocked ? "banned" : job.webSessionStatus || "absent",
    webSessionVerifiedAt: job.webSessionVerifiedAt || null,
    webCredentialSync: publicWebCredentialSync(job, getJobPlanType(job), { blocked }),
    webSessionReadError: job.webSessionReadError || null,
    webLoginAttemptId: job.webLoginAttemptId || null,
    webLoginPending: Boolean(job.webLoginPreviousState),
    webLoginCompletedAt: job.webLoginCompletedAt || null,
    webLoginError: job.webLoginError || null,
    webSessionRepairRetryAt: webSessionRepairRetryAt(job),
    canLogoutAllSessions: canLogoutAllSessions(job),
    canSetupTotp: canSetupTotp(job),
    canReplaceTotp: canReplaceTotp(job),
    canAddPassword: canAddPassword(job),
    restartRequired: job.restartRequired,
    proxyConfigured: Boolean(job.proxyUrl),
    assignedProxyId: normalizeStoredProxyId(job.assignedProxyId),
    boundIps: publicBoundIps(sub2ApiStatus.inPool === true ? sub2ApiStatus.proxyIds || [] : [job.assignedProxyId].filter(Boolean), job),
    boundProxies: publicBoundProxies(sub2ApiStatus.inPool === true ? sub2ApiStatus.proxyIds || [] : [job.assignedProxyId].filter(Boolean), job),
    boundProxyStatus: blocked && !job.banProxyReleasePending ? "unbound" : sub2ApiStatus.inPool === true ? (sub2ApiStatus.proxyIds?.length ? "bound" : "direct")
      : job.assignedProxyId ? "bound" : job.authorizationProxySelected ? "direct" : "unbound",
    canSwitchProxy: jobCanSwitchProxy(job),
    poolRefreshReady: Boolean(job.poolRefreshReady),
    poolRefreshAction: normalizePoolRefreshAction(job.poolRefreshAction),
    poolRefreshDueAt: job.poolRefreshDueAt || null,
    poolRefreshError: job.poolRefreshError || null,
    autoRepairEligible: autoRepair.eligible,
    autoRepairEligibilityReason: autoRepair.reason,
    autoRepairBlocked: Boolean(job.autoRepairBlocked),
    autoRepairBlockedReason: job.autoRepairBlockedReason || null,
    banProxyReleasePending: Boolean(job.banProxyReleasePending),
    banProxyReleaseError: job.banProxyReleaseError || null,
    banProxyReleasedAt: job.banProxyReleasedAt || null,
    autoRepairLastAttemptAt: job.autoRepairLastAttemptAt || null,
    autoRepairLastSuccessAt: job.autoRepairLastSuccessAt || null,
    autoRepairLastError: job.autoRepairLastError || null,
    autoTaskActions: Array.isArray(job.autoTaskActions) ? [...job.autoTaskActions] : [],
    autoTaskStatus: job.autoTaskStatus || "idle",
    autoTaskIndex: Number(job.autoTaskIndex || 0),
    autoTaskError: job.autoTaskError || null,
    autoTaskEligible: job.autoTaskEligible === true,
    attempt: job.attempt,
    queuePosition: job.status === "queued" ? getQueuePosition(job) : 0,
  };
}

async function getAccountUsage(job, forceRefresh = false) {
  // Normal reads use the low-cost snapshot synchronized with the Sub2API account list.
  // An explicit refresh delegates the upstream probe to Sub2API for this account only.
  if (!job?.email) throw new Error("ACCOUNT_USAGE_CREDENTIALS_UNAVAILABLE: 账号标识无效");
  const state = await loadSub2ApiAccountStatus({ forceRefresh });
  let status = getSub2ApiAccountStatusForJob(job, state);
  if (forceRefresh && !accountAutomationBlocked(job.email) && status.inPool === true && status.accountIds.length) {
    const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
    const [refreshed, totals] = await Promise.all([
      refreshSub2ApiAccountUsage(config, status.accountIds),
      readUsageTotals(config, status.accountIds, { forceRefresh: true }),
    ]);
    if (refreshed || totals.size) {
      const entry = state.accounts.get(String(job.email || "").toLowerCase());
      const merged = { ...mergeSub2ApiUsage(entry?.usage || status.usage || null, refreshed), totals: combineUsageTotals(status.accountIds, totals) };
      if (entry) {
        entry.usage = merged;
        entry.fetchedAt = new Date().toISOString();
        state.fetchedAt = entry.fetchedAt;
      }
      status = { ...status, usage: merged };
    }
  }
  const usage = publicSub2ApiUsage(status.usage);
  return usage || {
    source: "sub2api",
    fetchedAt: state.fetchedAt || null,
    planType: getJobPlanType(job, state),
    allowed: null,
    limitReached: null,
    primary: null,
    secondary: null,
    credits: null,
    resetCredits: null,
  };
}

async function refreshSub2ApiAccountUsage(config, accountIds) {
  if (!config?.baseUrl || !config?.adminApiKey) return null;
  const ids = [...new Set(accountIds.map((value) => normalizeSub2ApiAccountId(value)).filter(Boolean))].slice(0, 8);
  if (!ids.length) return null;
  const responses = await Promise.allSettled(ids.flatMap((accountId) => [
    requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/usage?source=active&force=true`).then((payload) => normalizeSub2ApiUsagePayload(payload)),
    // This is Sub2API's read/refresh endpoint, not the reset/consume action.
    requestSub2Api(config, `/api/v1/admin/openai/accounts/${encodeURIComponent(accountId)}/quota/refresh`, { method: "POST" }).then((payload) => normalizeSub2ApiUsagePayload(payload, { resetCreditsRefreshed: true })),
  ]));
  const usages = responses
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean);
  if (!usages.length) return null;
  return usages.reduce((current, next) => mergeSub2ApiUsage(current, next), null);
}

function normalizeSub2ApiUsagePayload(payload, { resetCreditsRefreshed = false } = {}) {
  const envelope = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const data = envelope?.usage && typeof envelope.usage === "object" ? envelope.usage : envelope;
  if (!data || typeof data !== "object") return null;
  const rateLimit = data.rate_limit && typeof data.rate_limit === "object" ? data.rate_limit : {};
  const primary = normalizeSub2ApiResponseWindow(
    data.five_hour ?? data.fiveHour ?? rateLimit.primary_window ?? rateLimit.primaryWindow,
    "5h",
  );
  const secondary = normalizeSub2ApiResponseWindow(
    data.seven_day ?? data.sevenDay ?? rateLimit.secondary_window ?? rateLimit.secondaryWindow,
    "7d",
  );
  const snapshotTimestamp = normalizeSub2ApiUsageDate(data.updated_at ?? data.updatedAt ?? data.fetched_at ?? data.fetchedAt);
  const fetchedAt = snapshotTimestamp || new Date().toISOString();
  const credits = normalizeSub2ApiCredits(data.credits);
  const resetCredits = normalizeResetCredits(data.rate_limit_reset_credits);
  if (!primary && !secondary && !credits && !resetCredits && !resetCreditsRefreshed) return null;
  const inferredLimitReached = [primary, secondary].some((window) => window?.usedPercent != null && window.usedPercent >= 100);
  const limitReached = typeof data.limit_reached === "boolean"
    ? data.limit_reached
    : typeof rateLimit.limit_reached === "boolean"
      ? rateLimit.limit_reached
      : inferredLimitReached;
  const explicitAllowed = typeof data.allowed === "boolean"
    ? data.allowed
    : typeof data.limit_reached === "boolean"
      ? !data.limit_reached
      : typeof rateLimit.allowed === "boolean"
        ? rateLimit.allowed
        : typeof rateLimit.limit_reached === "boolean"
          ? !rateLimit.limit_reached
          : null;
  return {
    source: "sub2api",
    fetchedAt,
    snapshotTimestamp,
    planType: null,
    allowed: explicitAllowed ?? (primary || secondary ? !limitReached : null),
    limitReached: primary || secondary ? limitReached : null,
    primary,
    secondary,
    credits,
    resetCredits,
    resetCreditsObserved: resetCreditsRefreshed || Object.hasOwn(data, "rate_limit_reset_credits"),
    resetCreditsFetchedAt: new Date().toISOString(),
  };
}

function normalizeSub2ApiResponseWindow(value, fallbackWindow) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = firstSub2ApiUsageValue(
    [value.utilization, value.used_percent, value.usedPercent],
    normalizeSub2ApiUsagePercent,
  );
  const resetAt = firstSub2ApiUsageValue(
    [value.resets_at, value.reset_at, value.resetAt],
    normalizeSub2ApiUsageDate,
  );
  const resetAfterSeconds = firstSub2ApiUsageValue(
    [value.remaining_seconds, value.reset_after_seconds, value.resetAfterSeconds],
    normalizeSub2ApiUsageSeconds,
  );
  if (usedPercent === null && !resetAt && resetAfterSeconds === null) return null;
  return {
    usedPercent: usagePercentAfterReset(usedPercent, resetAt),
    resetAfterSeconds: resetAfterSeconds && resetAfterSeconds > 0 ? resetAfterSeconds : null,
    resetAt,
    limitWindowSeconds: firstSub2ApiUsageValue(
      [value.limit_window_seconds, value.limitWindowSeconds],
      normalizeSub2ApiUsageSeconds,
    ) || (fallbackWindow === "5h" ? 18_000 : 604_800),
  };
}

function usagePercentAfterReset(usedPercent, resetAt) {
  if (usedPercent === null || !resetAt) return usedPercent;
  return Date.parse(resetAt) <= Date.now() ? 0 : usedPercent;
}

function normalizeSub2ApiCredits(value) {
  if (!value || typeof value !== "object") return null;
  return {
    hasCredits: typeof value.has_credits === "boolean" ? value.has_credits : typeof value.hasCredits === "boolean" ? value.hasCredits : null,
    unlimited: typeof value.unlimited === "boolean" ? value.unlimited : null,
    balance: value.balance === null || value.balance === undefined ? null : String(value.balance),
    overageLimitReached: typeof value.overage_limit_reached === "boolean" ? value.overage_limit_reached : null,
  };
}

async function publicCredentialDetails(job, persisted = null) {
  let sub2apiJson = "";
  try {
    const raw = await fs.readFile(job.outputPath, "utf8");
    sub2apiJson = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {}
  return {
    email: job.email,
    password: job.password || "",
    totpSecret: job.totpSecret || "",
    hasPassword: Boolean(job.password || job.hasPasswordCredential),
    hasTotpKey: hasJobTotpKey(job),
    passwordAvailable: Boolean(job.password),
    totpSecretAvailable: Boolean(job.totpSecret),
    sub2apiJson,
    hasSub2apiJson: Boolean(sub2apiJson),
    persisted,
  };
}

function normalizePlanType(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= 128 ? text : "";
}

function extractPlanTypeFromAccount(account, { preferJwt = true } = {}) {
  const fromJwt = extractPlanTypeFromJwt(account?.credentials?.id_token);
  const direct = normalizePlanType(
    account?.plan_type
      || account?.planType
      || account?.credentials?.plan_type
      || account?.credentials?.planType
      || account?.extra?.plan_type
      || account?.extra?.planType,
  );
  return preferJwt ? (fromJwt || direct) : (direct || fromJwt);
}

function extractPlanTypeFromJwt(jwt) {
  if (!jwt) return "";
  try {
    const [, payload] = String(jwt).split(".");
    if (!payload) return "";
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const authClaims = claims?.["https://api.openai.com/auth"];
    return normalizePlanType(
      authClaims?.plan_type
        || claims?.plan_type
        || authClaims?.chatgpt_plan_type
        || claims?.["https://api.openai.com/auth.chatgpt_plan_type"]
        || claims?.chatgpt_plan_type,
    );
  } catch {
    return "";
  }
}

async function readPlanTypeFromOutput(outputPath) {
  try {
    const data = JSON.parse(await fs.readFile(outputPath, "utf8"));
    return extractPlanTypeFromAccount(data?.accounts?.[0]) || null;
  } catch {
    return null;
  }
}

function publicSelectionJob(job) {
  const sub2ApiStatus = getSub2ApiAccountStatusForJob(job);
  return {
    id: job.id,
    email: job.email,
    status: job.status,
    planType: getJobPlanType(job),
    sub2apiInPool: sub2ApiStatus.inPool,
    sub2apiEnabled: sub2ApiStatus.enabled,
    sub2apiPriority: sub2ApiStatus.priority,
    sub2apiAccountId: sub2ApiStatus.accountId,
    sub2apiAccountIds: sub2ApiStatus.accountIds,
    canDownload: Boolean(job.resultSaved),
    sub2apiPlanType: sub2ApiStatus.planType,
    canRetry: ["failed", "mfa_failed", "canceled", "reauth_required", "resume_available"].includes(job.status),
    canResume: canResumeAuthorization(job),
    canRegenerate: job.status === "completed" && job.resultSaved,
    canForceRelogin: canForceRelogin(job),
    canLoginWeb: canLoginWeb(job),
    webSessionCheckAttemptId: manualWebSessionChecks.get(job.id)?.attemptId || null,
    webSessionCheckPending: webSessionCheckPending(job),
    webSessionMaintenancePause: job.webSessionMaintenancePause || null,
    webSessionCheckStatus: manualWebSessionChecks.get(job.id)?.phase || null,
    webSessionCheckError: manualWebSessionChecks.get(job.id)?.error || null,
    webSessionStatus: accountAutomationBlocked(job.email) ? "banned" : job.webSessionStatus || "absent",
    canLogoutAllSessions: canLogoutAllSessions(job),
    canSwitchProxy: jobCanSwitchProxy(job),
    canSetupTotp: canSetupTotp(job),
    canReplaceTotp: canReplaceTotp(job),
    canAddPassword: canAddPassword(job),
  };
}

function canResumeAuthorization(job) {
  return ["failed", "mfa_failed", "canceled", "reauth_required", "resume_available"].includes(job.status)
    && Boolean(job.loginCheckpointAvailable);
}

function canLogoutAllSessions(job) {
  return !accountAutomationBlocked(job.email) && Boolean(job.webSessionAvailable || (job.resultSaved && !job.webSessionStatus)) && canForceRelogin(job);
}

function canLoginWeb(job, { maintenance = false, checking = false } = {}) {
  // A failed, finished refresh is not a running operation. Keep manual controls
  // unchanged, but let maintenance re-check it under the existing retry cooldown.
  const failedRefresh = maintenance && !job.child && !job.poolRefreshReady && Boolean(job.poolRefreshError)
    && ["failed", "mfa_failed", "reauth_required", "resume_available"].includes(job.status);
  return (checking || !webSessionCheckPending(job)) && !accountAutomationBlocked(job.email) && canForceRelogin(job) && (!job.poolRefreshAction || failedRefresh) && !job.autoRepairOperation
    && !["queued", "running"].includes(job.autoTaskStatus);
}

function canForceRelogin(job) {
  return !job.webLoginPreviousState && ["completed", "failed", "mfa_failed", "banned", "canceled", "reauth_required", "resume_available"].includes(job.status);
}

function canSetupTotp(job) {
  if (hasJobTotpKey(job) || job.totpKnownEnabled) return false;
  if (job.status === "completed" && job.resultSaved) return true;
  return Boolean(job.loginCheckpointAvailable)
    && ["phone", "phone_otp", "resume_available", "failed", "mfa_failed", "canceled", "reauth_required"].includes(job.status);
}

function canAddPassword(job) {
  if (job.password || job.hasPasswordCredential) return false;
  if (job.status === "completed" && job.resultSaved) return true;
  return Boolean(job.loginCheckpointAvailable)
    && ["phone", "phone_otp", "resume_available", "failed", "mfa_failed", "canceled", "reauth_required"].includes(job.status);
}

function setStage(job, status, prompt) {
  if (isTerminalStatus(job.status)) return;
  job.status = status;
  job.prompt = prompt;
  job.lastError = null;
  touch(job);
}

function failJob(job, message) {
  if (isTerminalStatus(job.status)) return;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  const permanentAccountFailure = isPermanentAccountFailure(message);
  job.status = permanentAccountFailure ? "banned" : "failed";
  job.prompt = permanentAccountFailure ? "账号已封禁，号池监控已永久跳过" : "流程失败";
  job.lastError = message;
  if (job.webSessionMonitorRepair) {
    job.webSessionMonitorRepair = false;
    void webSessionMonitor.repairFinished(job.email, { success: false }).catch(() => {});
  }
  if (permanentAccountFailure) markAutoRepairBlocked(job, message);
  touch(job);
  void saveJobMetadata(job).catch(() => {});
}

function markMfaFailed(job, reason = "2FA 验证未完成") {
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.status = "mfa_failed";
  job.prompt = "2FA 未通过，流程已停止";
  job.lastError = reason;
  job.child = null;
  touch(job);
}

function beginAuthorizationAutomationAttempt(job, source) {
  job.authAutomationAttempt = {
    source,
    startedAt: new Date().toISOString(),
    requirements: { password: false, emailOtp: false, mfa: false },
    automatic: { password: false, emailOtp: false, mfa: false },
    manual: { password: false, emailOtp: false, mfa: false },
  };
}

function markAuthorizationRequirement(job, field) {
  if (job.runMode === "web_login") return;
  if (!job.authAutomationAttempt?.requirements || !Object.hasOwn(job.authAutomationAttempt.requirements, field)) return;
  job.authAutomationAttempt.requirements[field] = true;
}

function markAuthorizationAutomatic(job, field) {
  if (job.runMode === "web_login") return;
  if (!job.authAutomationAttempt?.automatic || !Object.hasOwn(job.authAutomationAttempt.automatic, field)) return;
  job.authAutomationAttempt.automatic[field] = true;
}

function markAuthorizationManual(job, field) {
  if (job.runMode === "web_login") return;
  if (!job.authAutomationAttempt?.manual || !Object.hasOwn(job.authAutomationAttempt.manual, field)) return;
  job.authAutomationAttempt.manual[field] = true;
}

function completeAuthorizationAutomationAttempt(job) {
  const attempt = job.authAutomationAttempt;
  if (!attempt) return;
  const reasons = [];
  for (const [field, label] of [["password", "密码"], ["emailOtp", "邮箱验证码"], ["mfa", "登录 2FA 验证码"]]) {
    if (attempt.manual[field]) reasons.push(`${label}由用户手动输入`);
    else if (attempt.requirements[field] && !attempt.automatic[field]) reasons.push(`${label}未记录为自动完成`);
  }
  const hasAutomaticLoginSource = attempt.requirements.password
    || attempt.requirements.emailOtp
    || Boolean(job.password || job.mailApiUrl);
  if (!hasAutomaticLoginSource) reasons.push("没有可用于下次自动登录的密码或邮件收码接口");

  job.lastAuthAutomated = reasons.length === 0;
  job.lastAuthAutomationReason = reasons.length ? reasons.join("；") : "上次完整登录未需要人工输入密码、邮箱码或登录 2FA";
  job.lastAuthAutomatedAt = new Date().toISOString();
  job.lastAuthRequirements = { ...attempt.requirements };
  job.authAutomationAttempt = null;
  appendJobLog(job, job.lastAuthAutomated
    ? "[automation] 本次完整登录已记录为可自动修复。\n"
    : `[automation] 本次完整登录不可自动修复：${job.lastAuthAutomationReason}。\n`);
}

function clearAutoRepairBlock(job) {
  job.autoRepairBlocked = false;
  job.autoRepairBlockedReason = null;
  job.autoRepairBlockedAt = null;
  job.banProxyReleasePending = false;
  job.banProxyReleaseError = null;
}

function markAutoRepairBlocked(job, reason, context = {}) {
  const alreadyBlocked = job.autoRepairBlocked;
  job.autoRepairBlocked = true;
  job.autoRepairBlockedReason = String(reason || "账号已被永久停用").slice(0, 500);
  job.autoRepairBlockedAt ||= new Date().toISOString();
  job.autoRepairLastError = job.autoRepairBlockedReason;
  job.autoRepairPendingAccountIds = [];
  job.autoRepairPendingBackend = null;
  job.autoRepairOperation = null;
  if (!alreadyBlocked) appendJobLog(job, "[monitor] 已确认账号被封禁、删除或永久停用，已停止该账号自动化。\n");
  const email = job.email.toLowerCase();
  modelFingerprint.invalidateAccount(email);
  if (automationBlockRunning.has(email)) return;
  automationBlockRunning.add(email);
  const operation = (automationBlockWrites.get(email) || Promise.resolve()).catch(() => {}).then(async () => {
    for (const related of jobs.values()) {
      if (related.email.toLowerCase() !== email) continue;
      related.autoRepairBlocked = true;
      related.autoRepairBlockedReason = job.autoRepairBlockedReason;
      related.autoRepairBlockedAt = job.autoRepairBlockedAt;
      if (!isTerminalStatus(related.status)) {
        related.child?.kill("SIGTERM");
        related.queuedMode = null;
        related.queueRunId = null;
      }
      related.status = "banned";
      related.banProxyReleasePending = true;
      related.banProxyReleaseError = null;
      related.assignedProxyId = null;
      related.authorizationProxySelected = false;
      related.proxyUrl = null;
      related.boundIp = null;
      related.boundProxyName = null;
      related.fixedProxy = false;
      related.prompt = "账号已确认封禁，已停止自动化；正在解除 IP 绑定";
      clearPoolRefreshTimer(related);
      related.poolRefreshAction = null; related.poolRefreshDueAt = null; related.poolRefreshReady = false;
      if (["pending", "running"].includes(related.autoTaskStatus)) {
        related.autoTaskStatus = "failed"; related.autoTaskError = "账号已确认永久停用，自动任务已停止";
      }
      await saveJobMetadata(related);
    }
    accountProxyReservations.delete(email);
    if (overloadMonitor.snapshot(email).enabled) await overloadMonitor.setEnabled(email, false);
    const cooldown = overloadCooldown.accounts.get(email);
    if (cooldown?.enabled || cooldown?.resumeAccountIds?.length) await overloadCooldown.blockAccount(email);
    const override = modelFingerprint.snapshot(email).override;
    if (override.enabled !== false) await modelFingerprint.saveOverride(email, { ...override, enabled: false });
    try {
      await releaseBlockedAccountProxies(email, context);
      for (const related of jobs.values()) {
        if (related.email.toLowerCase() !== email || !related.autoRepairBlocked) continue;
        related.banProxyReleasePending = false;
        related.banProxyReleasedAt = new Date().toISOString();
        related.prompt = "账号已确认封禁，已停止自动化并解除 IP 绑定";
        await saveJobMetadata(related);
      }
    } catch (error) {
      for (const related of jobs.values()) {
        if (related.email.toLowerCase() !== email || !related.autoRepairBlocked) continue;
        related.banProxyReleaseError = String(error?.message || error).slice(0, 300);
        related.prompt = "账号已确认封禁，IP 解绑待重试";
        await saveJobMetadata(related);
      }
    }
  }).finally(() => automationBlockRunning.delete(email));
  automationBlockWrites.set(email, operation);
  void operation.catch(error => console.warn(`[warn] 自动化关闭状态保存失败：${error.message}`));
}

async function releaseBlockedAccountProxies(email, { config = sub2ApiSettingsConfig || sub2ApiMonitorConfig, accounts = null } = {}) {
  // Clear only the proxy field; preserve saved password and 2FA credentials.
  const stored = await credentialStore.load(email);
  if (stored.proxyUrl) await credentialStore.save(email, { ...stored, proxyUrl: "" });
  if (!config?.baseUrl || !config?.adminApiKey) return;
  if (!accounts) {
    const listing = await listSub2ApiAccounts(config, { withMeta: true });
    if (!listing.complete) throw new Error("号池账号列表不完整，IP 解绑待重试");
    accounts = listing.accounts;
  }
  for (const account of accounts) {
    if (account.platform !== "openai" || account.type !== "oauth" || sub2ApiAccountEmail(account) !== email) continue;
    const id = normalizeSub2ApiAccountId(account.id);
    if (!id || !accountAutomationBlocked(email)) continue;
    if (monitorBackendIdentity(config) !== monitorBackendIdentity(sub2ApiSettingsConfig || sub2ApiMonitorConfig)) throw new Error("号池后端已变化，IP 解绑待重试");
    if (normalizeStoredProxyId(account.proxy_id)) {
      await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ proxy_id: 0 }) });
      account.proxy_id = 0;
    }
    if (account.schedulable !== false) {
      await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(id)}/schedulable`, { method: "POST", body: JSON.stringify({ schedulable: false }) });
      account.schedulable = false;
    }
  }
  if (sub2ApiAccountStatusCache.backend === monitorBackendIdentity(config)) {
    const cached = sub2ApiAccountStatusCache.accounts.get(email);
    if (cached) { cached.proxyIds = []; cached.enabled = false; }
  }
}

function accountSyncBlocked(account) {
  return accountAutomationBlocked(sub2ApiAccountEmail(account)) || Boolean(sub2ApiPermanentAccountFailure(account));
}

function sub2ApiPermanentAccountFailure(account) {
  if (account.platform !== "openai" || account.type !== "oauth") return null;
  const reason = typeof account.error_message === "string" ? account.error_message : JSON.stringify(account.error_message || account.error || "");
  if (String(account.status).toLowerCase() === "banned") return reason || "Sub2API 账号已标记封禁";
  return isPermanentAccountFailure(reason) ? reason : null;
}

async function reconcileSub2ApiAccountBans(config, accounts) {
  const emails = new Map();
  for (const account of accounts) {
    const email = sub2ApiAccountEmail(account), job = findJobByEmail(email);
    if (!job) continue;
    const reason = sub2ApiPermanentAccountFailure(account);
    if ((reason && (!job.autoRepairBlocked || !job.banProxyReleasedAt))
      || (accountAutomationBlocked(email) && (job.banProxyReleasePending || normalizeStoredProxyId(account.proxy_id) || account.schedulable !== false))) {
      emails.set(email, { job, reason: reason || job.autoRepairBlockedReason });
    }
  }
  for (const job of jobs.values()) {
    const email = job.email.toLowerCase();
    if (job.autoRepairBlocked && job.banProxyReleasePending && !emails.has(email)) emails.set(email, { job, reason: job.autoRepairBlockedReason });
  }
  for (const [email, { job, reason }] of emails) {
    markAutoRepairBlocked(job, reason, { config, accounts });
    await automationBlockWrites.get(email);
  }
}

function assertAccountWebActionsAllowed(job) {
  if (!accountAutomationBlocked(job.email)) return;
  const reason = job.autoRepairBlockedReason || [...jobs.values()].find(item => item.email.toLowerCase() === job.email.toLowerCase() && item.autoRepairBlockedReason)?.autoRepairBlockedReason;
  throw httpError(409, `账号已封禁，已停止读取设备、会话和工作空间${reason ? `：${String(reason).replace(/[\r\n]+/g, " ").slice(0, 320)}` : ""}`);
}

function webSessionRepairRetryAt(job) {
  if (!webSessionMonitorSettings.enabled || !webSessionMonitorSettings.autoRelogin || accountAutomationBlocked(job.email)
    || job.webSessionMaintenancePause || job.webLoginPreviousState || (!["expired", "absent"].includes(job.webSessionStatus) && !job.webLoginError)) return null;
  const entry = webSessionMonitor.accounts[job.email.toLowerCase()];
  if (!entry?.repairReason || entry.webRecoveryPending) return null;
  const at = Date.parse(entry.lastRepairAt) + webSessionMonitorSettings.retryMinutes * 60_000;
  return at > Date.now() ? new Date(at).toISOString() : null;
}

function accountAutomationBlocked(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return [...jobs.values()].some(job => !job.deleted && job.email.toLowerCase() === normalized && (job.status === "banned" || job.autoRepairBlocked));
}

function isPermanentAccountFailure(message) {
  const text = String(message || "");
  return /(?:account|user)_(?:deactivated|deleted|suspended|disabled|banned)|(?:your|this) account (?:has been|is) (?:deleted|deactivated|suspended|disabled|banned)|account has been (?:deleted|deactivated|suspended|disabled|banned)|do not have an account because it has been deleted/i.test(text);
}

function requireStage(job, expected) {
  if (job.status !== expected) {
    throw httpError(409, `The flow is currently at ${job.status}, not ${expected}`);
  }
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

function getJobDurationMs(job, now = Date.now()) {
  if (job.status === "queued") return null;
  const startedAt = Date.parse(job.startedAt || "");
  if (!Number.isFinite(startedAt)) return null;
  const completedAt = Date.parse(job.completedAt || "");
  const end = isTerminalStatus(job.status)
    ? (completedAt >= startedAt ? completedAt : Date.parse(job.updatedAt || ""))
    : now;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - startedAt);
}

function recordJobOperation(job, type, at = new Date().toISOString()) {
  job.lastOperationAt = at;
  job.lastOperationType = type;
}

function clearPoolRefreshTimer(job) {
  clearTimeout(poolRefreshTimers.get(job.id));
  poolRefreshTimers.delete(job.id);
}

function beginPoolRefresh(job, action, dueAt = null) {
  clearPoolRefreshTimer(job);
  job.poolRefreshAction = action;
  job.poolRefreshDueAt = dueAt;
  job.poolRefreshError = null;
  job.poolRefreshReady = false;
}

function schedulePoolRefresh(job, delayMs) {
  clearPoolRefreshTimer(job);
  if (shuttingDown || job.deleted || accountAutomationBlocked(job.email) || !job.poolRefreshAction) return;
  const timer = setTimeout(() => {
    poolRefreshTimers.delete(job.id);
    if (shuttingDown || job.deleted || jobs.get(job.id) !== job || !job.poolRefreshAction) return;
    const operation = withEmailJobLock(job.email, () => runPoolRefresh(job));
    poolRefreshOperations.add(operation);
    void operation.catch(async (error) => {
      if (shuttingDown || job.deleted) return;
      job.poolRefreshError = String(error?.message || error).slice(0, 500);
      appendJobLog(job, `[pool-refresh] 自动恢复失败：${job.poolRefreshError}\n`);
      touch(job);
      await saveJobMetadata(job).catch(() => {});
      schedulePoolRefresh(job, 60_000);
    }).finally(() => poolRefreshOperations.delete(operation));
  }, Math.min(2_147_483_647, Math.max(0, Number(delayMs) || 0)));
  timer.unref?.();
  poolRefreshTimers.set(job.id, timer);
}

async function runPoolRefresh(job) {
  if (shuttingDown || job.deleted || accountAutomationBlocked(job.email) || !job.poolRefreshAction) return;
  if (job.poolRefreshReady && job.status === "completed" && job.resultSaved) {
    await synchronizePoolRefresh(job);
    return;
  }
  if (job.poolRefreshAction === "cooldown" && job.poolRefreshDueAt) {
    const remaining = Date.parse(job.poolRefreshDueAt) - Date.now();
    if (remaining > 0) {
      schedulePoolRefresh(job, remaining);
      return;
    }
    if (!canForceRelogin(job)) {
      schedulePoolRefresh(job, 60_000);
      return;
    }
    await forceReloginJob(job, {}, { poolRefreshAction: "cooldown" });
    await saveJobMetadata(job);
  } else if (!job.poolRefreshReady && !job.poolRefreshError && canForceRelogin(job)) {
    await forceReloginJob(job, {}, { poolRefreshAction: job.poolRefreshAction });
    await saveJobMetadata(job);
  }
}

// Only call after fresh OAuth credentials have been accepted by the backend.
// Serialize with manual scheduling and automatic cooldown changes for this email.
async function recoverSub2ApiAuthorization(config, accountId, email, { monitorRepair = false, recoveryJob = null } = {}) {
  return overloadCooldown.lock(email.toLowerCase(), async () => {
    if (accountAutomationBlocked(email)) return;
    const response = await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`);
    const account = response?.data || response;
    if (sub2ApiAccountEmail(account) !== email.toLowerCase()) throw new Error("号池账号身份发生变化，已停止恢复启用状态");
    if (["disabled", "inactive", "banned"].includes(account.status)) return;
    const authError = account.status === "error"
      && /token|oauth|\b401\b|unauthoriz|invalid_grant|认证|授权|凭据/i.test(String(account.error_message || account.last_error || ""));
    const recoveryKey = `${monitorBackendIdentity(config)}:${accountId}`;
    const pending = recoveryJob?.poolRefreshRecovery?.[recoveryKey] === true;
    // A durable intent covers partial clear-error success across retries/restarts.
    if (!monitorRepair && !authError && !pending) return;
    const schedulable = !overloadCooldown.isPaused(email)
      && !overloadCooldown.isManuallyDisabled(email, accountId, config);
    if (recoveryJob) {
      recoveryJob.poolRefreshRecovery = { ...recoveryJob.poolRefreshRecovery, [recoveryKey]: true };
      await saveJobMetadata(recoveryJob);
    }
    await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/clear-error`, { method: "POST", body: "{}" });
    await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}/schedulable`, {
      method: "POST", body: JSON.stringify({ schedulable }),
    });
    if (recoveryJob) {
      delete recoveryJob.poolRefreshRecovery[recoveryKey];
      if (!Object.keys(recoveryJob.poolRefreshRecovery).length) recoveryJob.poolRefreshRecovery = null;
      await saveJobMetadata(recoveryJob);
    }
  });
}

async function synchronizePoolRefresh(job) {
  const action = normalizePoolRefreshAction(job.poolRefreshAction);
  if (!action || !job.poolRefreshReady || job.status !== "completed" || shuttingDown || job.deleted) return null;
  try {
    const config = sub2ApiSettingsConfig;
    if (!config?.baseUrl || !config?.adminApiKey) throw new Error("尚未配置 Sub2API 后端和管理员 API Key");
    await uploadJobsToSub2Api([job], config, snapshotSub2ApiProfileState(), { recoverAuthorization: true });
    job.poolRefreshAction = null;
    job.poolRefreshRecovery = null;
    job.poolRefreshDueAt = null;
    job.poolRefreshError = null;
    job.poolRefreshReady = false;
    clearPoolRefreshTimer(job);
    appendJobLog(job, `[pool-refresh] ${action === "cooldown" ? "冷却后重新授权" : action === "switch-proxy" ? "切换代理后重新授权" : "重新授权"}已完成，号池凭据已同步。\n`);
    touch(job);
    await saveJobMetadata(job);
    return true;
  } catch (error) {
    job.poolRefreshError = String(error?.message || error).slice(0, 500);
    appendJobLog(job, `[pool-refresh] 重新授权成功，但号池凭据同步失败：${job.poolRefreshError}\n`);
    touch(job);
    await saveJobMetadata(job);
    schedulePoolRefresh(job, 60_000);
    return false;
  }
}

function sanitizeLog(text) {
  return String(text)
    .replace(/([?&](?:code|token|state|csrf|nonce|otp|login_hint|code_challenge)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(access_token|refresh_token|id_token|password|totp_secret|2fa_key)\s*[=:]\s*[^\s,}]+/gi, "$1=<redacted>");
}

function isActive(status) {
  return !isTerminalStatus(status);
}

function occupiesActiveSlot(job) {
  return isActive(job.status) && job.status !== "queued";
}

function getQueuePosition(job) {
  if (job.status !== "queued") return 0;
  return [...jobs.values()]
    .filter((item) => item.status === "queued")
    .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)))
    .findIndex((item) => item.id === job.id) + 1;
}

function isTerminalStatus(status) {
  return ["completed", "failed", "mfa_failed", "banned", "canceled", "reauth_required", "resume_available"].includes(status);
}

function uniqueByJson(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function listUniqueJobs() {
  const seen = new Set();
  return [...jobs.values()].sort(sortNewestFirst).filter((job) => {
    const key = job.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findJobByEmail(email) {
  const key = String(email || "").toLowerCase();
  return listUniqueJobs().find((job) => job.email.toLowerCase() === key) || null;
}

async function withEmailJobLock(email, operation) {
  const key = String(email || "").trim().toLowerCase();
  const previous = emailJobLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  emailJobLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (emailJobLocks.get(key) === current) emailJobLocks.delete(key);
  }
}

function resolveSelectedJobs(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw httpError(400, "请至少选择一条任务");
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多操作 ${MAX_BATCH_JOBS} 条任务`);
  const selected = uniqueIds.map((id) => jobs.get(id));
  if (selected.some((job) => !job)) throw httpError(404, "部分任务不存在，请刷新页面后重试");
  return selected;
}

async function deleteSub2ApiAccountsByEmail(email) {
  const config = sub2ApiSettingsConfig || sub2ApiMonitorConfig;
  if (!config?.baseUrl || !config?.adminApiKey) {
    return { configured: false, deleted: 0, accountIds: [] };
  }

  const normalizedEmail = String(email || "").trim().toLowerCase();
  const state = await loadSub2ApiAccountStatus({ forceRefresh: true });
  const entry = state.accounts.get(normalizedEmail);
  const accountIds = [...new Set((entry?.accountIds || []).map(normalizeSub2ApiAccountId).filter(Boolean))];
  if (!accountIds.length) return { configured: true, deleted: 0, accountIds: [] };

  const deletedAccountIds = [];
  for (const accountId of accountIds) {
    try {
      await requestSub2Api(config, `/api/v1/admin/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    } catch (error) {
      if (error?.remoteStatus !== 404) throw error;
    }
    deletedAccountIds.push(accountId);
  }
  invalidateSub2ApiAccountStatusCache();
  return { configured: true, deleted: deletedAccountIds.length, accountIds: deletedAccountIds };
}

async function deleteJobsByEmail(email) {
  const sub2api = await deleteSub2ApiAccountsByEmail(email);
  await overloadMonitor.remove(email);
  await overloadCooldown.remove(email);
  await modelFingerprint.remove(email);
  const matching = [...jobs.values()].filter((job) => job.email.toLowerCase() === email);
  const directories = new Set();
  matching.forEach((job) => {
    job.deleted = true;
    clearPoolRefreshTimer(job);
    accountProxyReservations.delete(job.email.toLowerCase());
    stopMailPolling(job);
    releaseSmsNumber(job, "idle");
    job.runId = crypto.randomUUID();
    job.child?.kill("SIGTERM");
    job.child = null;
    directories.add(path.dirname(job.outputPath));
    jobs.delete(job.id);
  });
  await Promise.allSettled(matching.map((job) => job.metadataWritePromise).filter(Boolean));
  await Promise.all([
    ...[...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })),
    deleteStoredLoginCredentials(email),
  ]);
  scheduleQueuedJobs();
  return { email, sub2api };
}

function downloadTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function syncCompletedOutputs(force = false) {
  if (!force && Date.now() - lastOutputSyncAt < 2_000) return;
  if (outputSyncPromise) return outputSyncPromise;
  outputSyncPromise = (async () => {
    lastOutputSyncAt = Date.now();
    let entries = [];
    try {
      entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      if (jobs.has(entry.name)) return;
      const outputDir = path.join(OUTPUT_ROOT, entry.name);
      const outputPath = path.join(outputDir, "sub2api-import-oauth.json");
      const checkpointPath = path.join(outputDir, LOGIN_CHECKPOINT_FILENAME);
      const totpResultPath = path.join(outputDir, TOTP_SETUP_RESULT_FILENAME);
      const passwordAddResultPath = path.join(outputDir, PASSWORD_ADD_RESULT_FILENAME);
      let metadata = {};
      try {
        metadata = JSON.parse(await fs.readFile(path.join(outputDir, JOB_META_FILENAME), "utf8"));
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(outputPath, "utf8"), fs.stat(outputPath)]);
        const data = JSON.parse(raw);
        if (data.type !== "sub2api-data" || !Array.isArray(data.accounts) || !data.accounts.length) throw new Error("invalid output");
        const account = data.accounts[0];
        const email = metadata.email || account?.credentials?.email || account?.extra?.email || account?.name || `restored-${entry.name}`;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const completedAt = stat.mtime.toISOString();
        const updatedAt = metadata.updated_at || completedAt;
        const passwordRecovery = await recoverAddedPasswordCredential({
          email,
          resultPath: passwordAddResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = passwordRecovery.credentials;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredOperation = restoredOutputOperationState(metadata, completedAt, totpRecovery, passwordRecovery);
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredOperation.status,
          prompt: restoredOperation.prompt,
          createdAt: metadata.created_at || completedAt,
          updatedAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || completedAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: metadata.completed_at || completedAt,
          startedAt: metadata.started_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: restoredOperation.log,
          lastError: restoredOperation.lastError,
          child: null,
          parserTail: "",
          resultSaved: true,
          poolOnly: Boolean(metadata.pool_only),
          remark: typeof metadata.remark === "string" ? metadata.remark : "",
          ...restoredRemarkState(metadata),
          planType: extractPlanTypeFromAccount(account) || normalizePlanType(metadata.plan_type),
          workspacePlanType: normalizePlanType(metadata.workspace_plan_type),
          planAutomationPlanType: normalizePlanType(metadata.plan_automation_plan_type),
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          assignedProxyId: normalizeStoredProxyId(metadata.assigned_proxy_id),
          authorizationProxySelected: metadata.authorization_proxy_selected === true,
          boundIp: metadata.bound_ip || null,
          boundProxyName: metadata.bound_proxy_name || null,
          fixedProxy: accountProxyMode === "sub2api" || (accountProxyMode === "plan" && (metadata.authorization_proxy_selected === true || Boolean(metadata.assigned_proxy_id))),
          poolRefreshReady: metadata.pool_refresh_ready === true,
          poolRefreshAction: normalizePoolRefreshAction(metadata.pool_refresh_action),
          poolRefreshDueAt: metadata.pool_refresh_due_at || null,
          poolRefreshError: metadata.pool_refresh_error || null,
          poolRefreshRecovery: metadata.pool_refresh_recovery && typeof metadata.pool_refresh_recovery === "object" ? metadata.pool_refresh_recovery : null,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          ...restoredTaskAutoState(metadata),
          ...restoredWebSessionMaintenanceState(metadata),
          totpSetupError: restoredOperation.totpSetupError,
          passwordAddError: restoredOperation.passwordAddError,
          passwordAddedAt: metadata.password_added_at || passwordRecovery.addedAt || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: await fileExists(checkpointPath),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
        const restored = jobs.get(entry.name);
        restoreWebLoginState(restored, metadata);
        restored.webSessionAvailable = await fileExists(webSessionPathForJob(restored));
        if (restored.poolRefreshAction) {
          schedulePoolRefresh(restored, restored.poolRefreshAction === "cooldown" && restored.poolRefreshDueAt
            ? Math.max(0, Date.parse(restored.poolRefreshDueAt) - Date.now())
            : 0);
        }
        return;
      } catch {}

      try {
        const [raw, stat] = await Promise.all([fs.readFile(checkpointPath, "utf8"), fs.stat(checkpointPath)]);
        const checkpoint = JSON.parse(raw);
        if (checkpoint?.version !== 1 || typeof checkpoint.email !== "string" || !checkpoint.email) return;
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const email = metadata.email || checkpoint.email;
        let storedCredentials = await loadStoredLoginCredentials(email);
        const passwordRecovery = await recoverAddedPasswordCredential({
          email,
          resultPath: passwordAddResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = passwordRecovery.credentials;
        const totpRecovery = await recoverActivatedTotpCredential({
          email,
          resultPath: totpResultPath,
          credentials: storedCredentials,
        });
        storedCredentials = totpRecovery.credentials;
        const restoredAt = stat.mtime.toISOString();
        const savedStatus = String(metadata.status || "");
        const restoredStatus = passwordRecovery.recovered || totpRecovery.recovered
          ? "resume_available"
          : isTerminalStatus(savedStatus) ? savedStatus : "resume_available";
        jobs.set(entry.name, {
          id: entry.name,
          email,
          status: restoredStatus,
          prompt: totpRecovery.recovered
            ? "已恢复成功激活的 2FA 密钥，可以继续未完成的 Codex 授权"
            : passwordRecovery.recovered
              ? "已恢复成功添加的新密码，可以继续未完成的 Codex 授权"
            : metadata.prompt || (restoredStatus === "resume_available"
              ? "检测到邮箱登录检查点，可以继续手机号绑定"
              : "已恢复上次操作状态，登录检查点仍然保留"),
          createdAt: metadata.created_at || restoredAt,
          updatedAt: metadata.updated_at || restoredAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || restoredAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: null,
          startedAt: metadata.started_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: totpRecovery.recovered
            ? "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n"
            : passwordRecovery.recovered
              ? "[restore] 已从中断的添加密码流程恢复并安全保存新密码。\n"
            : `[restore] 已恢复 ${checkpoint.stage || "unknown"} 阶段的登录检查点。\n`,
          lastError: passwordRecovery.recovered || totpRecovery.recovered
            ? "ChatGPT 登录状态已保留，点击“继续授权”即可重新开始 Codex 授权"
            : metadata.last_error || (restoredStatus === "resume_available"
              ? "上次流程在生成授权文件前中断"
              : null),
          child: null,
          parserTail: "",
          resultSaved: false,
          poolOnly: Boolean(metadata.pool_only),
          remark: typeof metadata.remark === "string" ? metadata.remark : "",
          ...restoredRemarkState(metadata),
          planType: normalizePlanType(metadata.plan_type),
          workspacePlanType: normalizePlanType(metadata.workspace_plan_type),
          planAutomationPlanType: normalizePlanType(metadata.plan_automation_plan_type),
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          assignedProxyId: normalizeStoredProxyId(metadata.assigned_proxy_id),
          authorizationProxySelected: metadata.authorization_proxy_selected === true,
          boundIp: metadata.bound_ip || null,
          boundProxyName: metadata.bound_proxy_name || null,
          fixedProxy: accountProxyMode === "sub2api" || (accountProxyMode === "plan" && (metadata.authorization_proxy_selected === true || Boolean(metadata.assigned_proxy_id))),
          poolRefreshReady: metadata.pool_refresh_ready === true,
          poolRefreshAction: normalizePoolRefreshAction(metadata.pool_refresh_action),
          poolRefreshDueAt: metadata.pool_refresh_due_at || null,
          poolRefreshError: metadata.pool_refresh_error || null,
          poolRefreshRecovery: metadata.pool_refresh_recovery && typeof metadata.pool_refresh_recovery === "object" ? metadata.pool_refresh_recovery : null,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "ready" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: checkpoint.oauth?.phone || metadata.sms_number || metadata.luban_number || null,
          phoneError: null,
          restartRequired: false,
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          ...restoredTaskAutoState(metadata),
          ...restoredWebSessionMaintenanceState(metadata),
          totpSetupError: totpRecovery.error || null,
          passwordAddError: passwordRecovery.error || metadata.password_add_error || null,
          passwordAddedAt: metadata.password_added_at || passwordRecovery.addedAt || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: true,
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...restoredSmsState(metadata),
        });
      } catch {
        if (
          !metadata.email
          || !isEmail(metadata.email)
        ) return;
        const storedCredentials = await loadStoredLoginCredentials(metadata.email);
        const mailApiUrl = validateMailApiUrl(metadata.mail_api_url) ? metadata.mail_api_url : null;
        const restoredAt = metadata.updated_at || new Date().toISOString();
        const missingStoredCredentials = restoredMissingCredentials(metadata, storedCredentials);
        const storedCredentialsMissing = missingStoredCredentials.length > 0;
        const savedStatus = String(metadata.status || "");
        const restartable = ["queued", "starting"].includes(savedStatus);
        const interrupted = Boolean(savedStatus) && !isTerminalStatus(savedStatus) && !restartable;
        const restoredStatus = storedCredentialsMissing && restartable
          ? "reauth_required"
          : restartable
            ? "queued"
            : interrupted || !savedStatus
              ? "failed"
              : savedStatus;
        const restoredPrompt = storedCredentialsMissing && restartable
          ? "登录资料需要重新确认"
          : restartable
            ? "服务重启后已恢复，等待任务槽位"
            : interrupted || !savedStatus
              ? "上次流程因服务重启中断，可以重新授权"
              : metadata.prompt || "已恢复上次任务状态";
        const restoredError = storedCredentialsMissing && restartable
          ? `请重新导入或填写${missingStoredCredentials.join("、")}后重试，任务不会使用缺失的资料自动登录`
          : interrupted || !savedStatus
            ? metadata.last_error || `上次 ${savedStatus || "未知"} 阶段未完成`
            : metadata.last_error || null;
        jobs.set(entry.name, {
          id: entry.name,
          email: metadata.email,
          status: restoredStatus,
          prompt: restoredPrompt,
          createdAt: metadata.created_at || restoredAt,
          updatedAt: restoredAt,
          lastOperationAt: metadata.last_operation_at || metadata.created_at || restoredAt,
          lastOperationType: metadata.last_operation_type || "initial_authorization",
          completedAt: metadata.completed_at || null,
          startedAt: metadata.started_at || null,
          outputPath,
          checkpointPath,
          totpResultPath,
          passwordAddResultPath,
          logs: storedCredentialsMissing && restartable
            ? `[restore] 系统安全凭据存储中无法恢复${missingStoredCredentials.join("、")}，已停止自动启动。\n`
            : restartable
              ? "[restore] 已恢复排队任务，等待可用任务槽位。\n"
              : interrupted || !savedStatus
                ? "[restore] 上次任务在生成授权文件前中断，已恢复为可重试状态。\n"
                : "[restore] 已恢复上次任务状态。\n",
          lastError: restoredError,
          child: null,
          parserTail: "",
          resultSaved: false,
          planType: normalizePlanType(metadata.plan_type),
          poolOnly: Boolean(metadata.pool_only),
          remark: typeof metadata.remark === "string" ? metadata.remark : "",
          ...restoredRemarkState(metadata),
          workspacePlanType: normalizePlanType(metadata.workspace_plan_type),
          planAutomationPlanType: normalizePlanType(metadata.plan_automation_plan_type),
          loginMode: metadata.login_mode === "password" || storedCredentials.password ? "password" : (mailApiUrl ? "email_otp" : metadata.login_mode || "manual"),
          password: storedCredentials.password,
          totpSecret: storedCredentials.totpSecret,
          ...restoredCredentialFlags(metadata, storedCredentials),
          mailApiUrl,
          mailRequestBody: typeof metadata.mail_request_body === "string" ? metadata.mail_request_body : "",
          proxyUrl: storedCredentials.proxyUrl,
          assignedProxyId: normalizeStoredProxyId(metadata.assigned_proxy_id),
          authorizationProxySelected: metadata.authorization_proxy_selected === true,
          boundIp: metadata.bound_ip || null,
          boundProxyName: metadata.bound_proxy_name || null,
          fixedProxy: accountProxyMode === "sub2api" || (accountProxyMode === "plan" && (metadata.authorization_proxy_selected === true || Boolean(metadata.assigned_proxy_id))),
          poolRefreshReady: metadata.pool_refresh_ready === true,
          poolRefreshAction: normalizePoolRefreshAction(metadata.pool_refresh_action),
          poolRefreshDueAt: metadata.pool_refresh_due_at || null,
          poolRefreshError: metadata.pool_refresh_error || null,
          poolRefreshRecovery: metadata.pool_refresh_recovery && typeof metadata.pool_refresh_recovery === "object" ? metadata.pool_refresh_recovery : null,
          mailSeenCandidateKeys: new Set(),
          mailCandidateCounts: new Map(),
          mailStatus: mailApiUrl ? "baseline" : "manual",
          mailApiError: null,
          mailPollRunning: false,
          mailPollToken: null,
          currentPhone: metadata.sms_number || null,
          phoneError: null,
          restartRequired: restoredStatus === "reauth_required",
          attempt: Math.max(1, Number(metadata.attempt || 1)),
          runId: null,
          runMode: null,
          queuedMode: restoredStatus === "queued" && ["refresh", "web_login"].includes(metadata.queued_mode) ? metadata.queued_mode : "full",
          queuedAt: restoredStatus === "queued" ? metadata.queued_at || restoredAt : null,
          queuedStartPrompt: metadata.queued_mode === "refresh"
            ? "正在使用已有刷新令牌直接生成新授权"
            : "正在建立登录会话",
          fallbackInProgress: false,
          ...restoredTotpSetupState(metadata, storedCredentials),
          ...restoredProxyRiskState(metadata),
          ...restoredAutoRepairState(metadata),
          ...restoredTaskAutoState(metadata),
          ...restoredWebSessionMaintenanceState(metadata),
          passwordAddError: metadata.password_add_error || null,
          passwordAddedAt: metadata.password_added_at || null,
          pendingNewPassword: null,
          totpSetupResumesAuthorization: false,
          passwordAddResumesAuthorization: false,
          loginCheckpointAvailable: Boolean(metadata.login_checkpoint_available),
          securityCheckRequired: Boolean(metadata.security_check_required),
          ...newSmsState(),
        });
      }
      const restored = jobs.get(entry.name);
      if (restored) {
        restoreWebLoginState(restored, metadata);
        restored.webSessionAvailable = await fileExists(webSessionPathForJob(restored));
      }
    }));
  })().finally(() => {
    outputSyncPromise = null;
  });
  return outputSyncPromise;
}

async function recoverActivatedTotpCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null };
    return { credentials, recovered: false, error: `2FA 结果文件无法读取：${error.message}` };
  }
  if (result?.activation_succeeded !== true || !result?.secret) {
    return { credentials, recovered: false, error: null };
  }
  try {
    const secret = normalizeTotpSecret(result.secret);
    const nextCredentials = { ...credentials, totpSecret: secret };
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "2FA 已激活，但当前系统不支持持久凭据存储；结果文件已保留",
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `2FA 已激活，但密钥恢复失败：${error.message}；结果文件已保留`,
    };
  }
}

async function recoverAddedPasswordCredential({ email, resultPath, credentials }) {
  let result;
  try {
    result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { credentials, recovered: false, error: null, addedAt: null };
    return { credentials, recovered: false, error: `添加密码结果文件无法读取：${error.message}`, addedAt: null };
  }
  if (
    result?.version !== 1
    || String(result.email || "").toLowerCase() !== email.toLowerCase()
    || typeof result.password !== "string"
    || result.password.length < 12
  ) {
    return { credentials, recovered: false, error: "添加密码结果文件格式不正确", addedAt: null };
  }
  const nextCredentials = { ...credentials, password: result.password };
  try {
    const persisted = await saveStoredLoginCredentials(email, nextCredentials);
    if (!persisted) {
      return {
        credentials: nextCredentials,
        recovered: false,
        error: "密码已经添加，但当前系统不支持持久凭据存储；结果文件已保留",
        addedAt: result.added_at || null,
      };
    }
    await removePrivateFile(resultPath);
    return { credentials: nextCredentials, recovered: true, error: null, addedAt: result.added_at || null };
  } catch (error) {
    return {
      credentials,
      recovered: false,
      error: `密码已经添加，但新密码恢复失败：${error.message}；结果文件已保留`,
      addedAt: result.added_at || null,
    };
  }
}

function restoredOutputOperationState(metadata, completedAt, totpRecovery, passwordRecovery) {
  const savedStatus = String(metadata.status || "");
  const interrupted = savedStatus && !isTerminalStatus(savedStatus);
  const status = !savedStatus || savedStatus === "completed"
    ? "completed"
    : interrupted ? "failed" : savedStatus;
  if (passwordRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功添加的新密码，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: null,
      log: "[restore] 已从中断的添加密码流程恢复并安全保存新密码。\n",
    };
  }
  if (passwordRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，新密码需要重试恢复",
      lastError: null,
      totpSetupError: null,
      passwordAddError: passwordRecovery.error,
      log: `[restore] ${passwordRecovery.error}\n`,
    };
  }
  if (savedStatus.startsWith("password_add") || metadata.queued_mode === "password_add") {
    return {
      status: "completed",
      prompt: "服务重启中断了添加密码，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: "添加密码尚未完成，请重新点击添加密码",
      log: "[restore] 添加密码被服务重启中断，旧授权文件未受影响。\n",
    };
  }
  if (totpRecovery.recovered) {
    return {
      status: "completed",
      prompt: "已恢复上次成功激活的 2FA 密钥，原授权文件仍可下载",
      lastError: null,
      totpSetupError: null,
      passwordAddError: null,
      log: "[restore] 已从中断的 2FA 设置流程恢复并安全保存密钥。\n",
    };
  }
  if (totpRecovery.error) {
    return {
      status: "completed",
      prompt: "原授权文件仍可下载，2FA 密钥需要重试恢复",
      lastError: metadata.last_error || null,
      totpSetupError: totpRecovery.error,
      passwordAddError: null,
      log: `[restore] ${totpRecovery.error}\n`,
    };
  }
  if (interrupted) {
    return {
      status,
      prompt: "上次操作因服务重启中断，旧授权文件仍可下载",
      lastError: metadata.last_error || `上次 ${savedStatus} 阶段未完成`,
      totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
      passwordAddError: savedStatus.startsWith("password_add") ? "服务重启时添加密码未完成，请重新发起" : null,
      log: "[restore] 检测到旧授权文件，同时保留了上次中断的操作状态。\n",
    };
  }
  return {
    status,
    prompt: metadata.prompt || (status === "completed"
      ? "已从本地输出目录恢复，可以下载导入文件"
      : "旧授权文件仍可下载，已恢复最近一次操作状态"),
    lastError: metadata.last_error || null,
    totpSetupError: savedStatus.startsWith("totp_") ? "服务重启时 2FA 设置未完成" : null,
    passwordAddError: metadata.password_add_error || null,
    log: `[restore] 已恢复任务状态，旧授权文件时间 ${completedAt}。\n`,
  };
}

function isEmail(value) {
  const text = String(value || "");
  if (!text || text.length > 254 || /\s/.test(text)) return false;
  const at = text.lastIndexOf("@");
  if (at <= 0 || at !== text.indexOf("@")) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => (
    !label
    || label.length > 63
    || label.startsWith("-")
    || label.endsWith("-")
    || !/^[A-Z0-9-]+$/i.test(label)
  ))) return false;
  const topLevelDomain = labels.at(-1);
  if (!/^(?:[A-Z]{2,63}|XN--[A-Z0-9-]{2,59})$/i.test(topLevelDomain)) return false;
  return true;
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw httpError(400, "账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址");
  }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname) {
    throw httpError(400, "账号代理只支持 http、https、socks5 和 socks5h 协议");
  }
  return parsed.toString();
}

function normalizeLoginCredentials(value = {}) {
  const password = typeof value.password === "string" ? value.password : "";
  const mailRequestBody = typeof value.mailRequestBody === "string" ? value.mailRequestBody : "";
  const configuredPostUrl = mailRequestConfig.method === "POST" && validateMailApiUrl(mailRequestConfig.url)
    ? mailRequestConfig.url
    : null;
  const mailApiUrl = validateMailApiUrl(value.mailApiUrl)
    ? String(value.mailApiUrl).trim()
    : mailRequestBody && configuredPostUrl
      ? configuredPostUrl
      : null;
  const totpSecret = value.totpSecret ? normalizeTotpSecret(value.totpSecret) : "";
  const loginMode = password ? "password" : "email_otp";
  return { loginMode, mailApiUrl, mailRequestBody, password, totpSecret };
}

function restoredCredentialFlags(metadata = {}, credentials = {}) {
  const hasExplicitPasswordFlag = Object.hasOwn(metadata, "has_password");
  const hasExplicitTotpFlag = Object.hasOwn(metadata, "has_totp_key");
  return {
    hasPasswordCredential: Boolean(
      credentials.password
      || (hasExplicitPasswordFlag ? metadata.has_password : metadata.login_mode === "password" && metadata.has_stored_credentials),
    ),
    hasTotpCredential: Boolean(
      credentials.totpSecret
      || (hasExplicitTotpFlag ? metadata.has_totp_key : metadata.has_stored_credentials),
    ),
  };
}

function restoredTotpSetupState(metadata = {}, credentials = {}) {
  return {
    totpSetupSecret: null,
    totpSetupUri: null,
    totpSetupError: null,
    totpSetupReplaceExisting: Boolean(metadata.totp_setup_replace_existing),
    totpRotationRemoteDisabled: Boolean(metadata.totp_rotation_remote_disabled),
    totpRotationStage: typeof metadata.totp_rotation_stage === "string" ? metadata.totp_rotation_stage : null,
    totpRotationIncomplete: Boolean(metadata.totp_rotation_incomplete || metadata.totp_rotation_remote_disabled),
    totpKnownEnabled: Boolean(
      metadata.totp_known_enabled
      || (credentials.totpSecret && !metadata.totp_rotation_remote_disabled),
    ),
    totpSetupAttempt: 0,
    totpResultLoading: false,
  };
}

function restoredProxyRiskState(metadata = {}) {
  const count = Number(metadata.proxy_risk_retry_count || 0);
  const connectionFailures = Number(metadata.proxy_connection_failure_count || 0);
  return {
    proxyRiskRetryCount: Number.isInteger(count) && count >= 0 ? Math.min(count, MAX_PROXY_RISK_RETRIES) : 0,
    proxyConnectionFailureCount: Number.isInteger(connectionFailures) && connectionFailures >= 0
      ? Math.min(connectionFailures, MAX_PROXY_CONNECTION_FAILURES)
      : 0,
    proxyRiskRestarting: false,
    proxySessionAttemptIds: new Set(),
    proxyAttemptParserTail: "",
  };
}

function restoredAutoRepairState(metadata = {}) {
  const requirements = metadata.last_auth_requirements;
  const pendingIds = Array.isArray(metadata.auto_repair_pending_account_ids)
    ? metadata.auto_repair_pending_account_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
    : [];
  return {
    lastAuthAutomated: metadata.last_auth_automated === true,
    lastAuthAutomationReason: String(metadata.last_auth_automation_reason || "旧任务没有自动化参与记录"),
    lastAuthAutomatedAt: metadata.last_auth_automated_at || null,
    lastAuthRequirements: requirements && typeof requirements === "object"
      ? {
          password: Boolean(requirements.password),
          emailOtp: Boolean(requirements.emailOtp),
          mfa: Boolean(requirements.mfa),
        }
      : null,
    authAutomationAttempt: null,
    autoRepairBlocked: metadata.auto_repair_blocked === true,
    autoRepairBlockedReason: metadata.auto_repair_blocked_reason || null,
    banProxyReleasePending: metadata.ban_proxy_release_pending === true,
    banProxyReleaseError: metadata.ban_proxy_release_error || null,
    banProxyReleasedAt: metadata.ban_proxy_released_at || null,
    autoRepairBlockedAt: metadata.auto_repair_blocked_at || null,
    autoRepairLastAttemptAt: metadata.auto_repair_last_attempt_at || null,
    autoRepairLastSuccessAt: metadata.auto_repair_last_success_at || null,
    autoRepairLastError: metadata.auto_repair_last_error || null,
    autoRepairPendingAccountIds: [...new Set(pendingIds)],
    autoRepairPendingBackend: metadata.auto_repair_pending_backend || null,
    autoRepairOperation: null,
  };
}

function restoredWebSessionMaintenanceState(metadata = {}) {
  const value = metadata.web_session_maintenance_pause;
  return { webSessionMaintenancePause: value && ["logout", "canceled"].includes(value.reason)
    ? { reason: value.reason, at: typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) ? value.at : null } : null };
}

function restoredTaskAutoState(metadata = {}) {
  const actions = Array.isArray(metadata.auto_task_actions)
    ? metadata.auto_task_actions.filter((action) => TASK_AUTO_ACTIONS.has(action))
    : [];
  const status = ["idle", "pending", "running", "completed", "failed"].includes(metadata.auto_task_status)
    ? metadata.auto_task_status
    : "idle";
  return {
    autoTaskActions: actions,
    autoTaskStatus: status,
    autoTaskIndex: Math.max(0, Math.min(actions.length, Number(metadata.auto_task_index) || 0)),
    autoTaskError: metadata.auto_task_error || null,
    autoTaskEligible: metadata.auto_task_eligible === true,
  };
}

function restoredMissingCredentials(metadata = {}, credentials = {}) {
  const missing = [];
  const passwordRequired = Object.hasOwn(metadata, "has_password")
    ? metadata.has_password
    : metadata.login_mode === "password" && metadata.has_stored_credentials;
  const totpRequired = Object.hasOwn(metadata, "has_totp_key")
    ? metadata.has_totp_key
    : metadata.has_stored_credentials && !passwordRequired;
  if (passwordRequired && !credentials.password) missing.push("密码");
  if (totpRequired && !credentials.totpSecret) missing.push("2FA 密钥");
  if (metadata.proxy_configured && !credentials.proxyUrl) missing.push("代理 IP");
  return missing;
}

function normalizeTotpSecret(value, lineNumber = null) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]{16,128}$/.test(normalized)) {
    const prefix = lineNumber ? `第 ${lineNumber} 行` : "";
    throw httpError(400, `${prefix}2FA 密钥格式错误，只能包含 Base32（基础三十二进制）的 A-Z 和 2-7`);
  }
  return normalized;
}

function parseBatchEntries(value, requestConfig = {}) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw httpError(400, "请至少输入一行账号信息");
  if (lines.length > MAX_BATCH_JOBS) throw httpError(400, `一次最多添加 ${MAX_BATCH_JOBS} 条任务`);

  const entries = lines.map((line, index) => {
    // Only a parenthesized suffix attached to a 2FA field is a remark;
    // parentheses inside passwords and mail request bodies remain literal.
    const match = /----([A-Z2-7][A-Z2-7=\s]{15,127})(?:\((.*)\)|（(.*)）)$/i.exec(line);
    const accountLine = match ? line.slice(0, match.index) + `----${match[1].trim()}` : line;
    const entry = requestConfig.method === "POST" && !isEmail(accountLine)
      ? parsePostMailAccountLine(accountLine, index + 1, requestConfig)
      : parseSmartAccountLine(accountLine, index + 1);
    if (match) {
      if (!entry.totpSecret) throw httpError(400, `第 ${index + 1} 行备注必须放在 2FA 密钥后`);
      entry.remark = normalizeAccountRemark(match[2] ?? match[3]);
    }
    return entry;
  });

  const unique = new Map();
  entries.forEach((entry) => unique.set(entry.email.toLowerCase(), entry));
  return [...unique.values()];
}

function parsePostMailAccountLine(line, lineNumber, requestConfig) {
  if (!validateMailApiUrl(requestConfig.url)) {
    throw httpError(400, "POST 邮件接码模式需要先在控制台配置统一请求 URL");
  }
  const fields = line.split("----").map((value) => value.trim());
  if (fields.length < 2) {
    throw httpError(400, `第 ${lineNumber} 行格式错误，POST 邮件接码请使用 邮箱----编码请求体`);
  }
  const emailFields = fields.map((value, index) => ({ value, index })).filter((field) => isEmail(field.value));
  if (emailFields.length !== 1) throw httpError(400, `第 ${lineNumber} 行必须包含一个独立邮箱`);
  const emailField = emailFields[0];
  const remaining = fields
    .map((value, index) => ({ value, index }))
    .filter((field) => field.index !== emailField.index && field.value);
  if (!remaining.length) throw httpError(400, `第 ${lineNumber} 行缺少 POST 请求体`);

  let totpField = null;
  if (remaining.length >= 2) {
    const totpCandidates = remaining.filter((field) => isTotpSecretCandidate(field.value));
    if (totpCandidates.length === 1) totpField = totpCandidates[0];
  }
  const bodyAndPassword = remaining.filter((field) => field !== totpField);
  const recognizableBodies = bodyAndPassword.filter((field) => looksLikeEncodedMailRequestBody(field.value));
  const bodyField = recognizableBodies.length === 1 ? recognizableBodies[0] : bodyAndPassword.at(-1);
  const passwordFields = bodyAndPassword.filter((field) => field !== bodyField);
  if (passwordFields.length > 1) {
    throw httpError(400, `第 ${lineNumber} 行无法区分密码和 POST 请求体，请将编码请求体放在最后`);
  }
  const mailRequestBody = bodyField?.value || "";
  const password = passwordFields[0]?.value || "";
  if (Buffer.byteLength(mailRequestBody) > MAX_MAIL_REQUEST_BODY_BYTES) {
    throw httpError(400, `第 ${lineNumber} 行 POST 请求体不能超过 64 KB`);
  }
  return {
    email: emailField.value,
    loginMode: password ? "password" : "email_otp",
    mailApiUrl: requestConfig.url,
    mailRequestBody,
    password,
    totpSecret: totpField ? normalizeTotpSecret(totpField.value, lineNumber) : "",
  };
}

function looksLikeEncodedMailRequestBody(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^[{\[]/.test(text)) {
    try {
      JSON.parse(text);
      return true;
    } catch {}
  }
  if (/(?:^|&)[^=&\s]+=[^&]*(?:&|$)/.test(text) || /%[0-9A-F]{2}/i.test(text)) return true;
  const compact = text.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) && compact.length >= 12) {
    try {
      const decoded = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
      return /^[{\[]/.test(decoded) || /(?:^|&)[^=&\s]+=[^&]*(?:&|$)/.test(decoded);
    } catch {}
  }
  return false;
}

function parseSmartAccountLine(line, lineNumber) {
  if (isEmail(line)) {
    return {
      email: line,
      loginMode: "email_otp",
      mailApiUrl: null,
      password: "",
      totpSecret: "",
      preserveExistingCredentials: true,
    };
  }

  const parsed = accountDelimiterCandidates(line)
    .map((delimiter) => parseAccountLineWithDelimiter(line, delimiter, lineNumber))
    .filter(Boolean);
  const ambiguity = parsed.find((candidate) => candidate.ambiguity);
  if (ambiguity) throw httpError(400, `第 ${lineNumber} 行${ambiguity.ambiguity}`);

  const candidates = parsed
    .sort(compareAccountParseCandidates);
  if (!candidates.length) {
    const unsupportedHyphenRun = [...line.matchAll(/-+/g)].find((match) => (
      match[0].length === 5 || match[0].length > 8
    ));
    if (unsupportedHyphenRun) {
      throw httpError(400, `第 ${lineNumber} 行存在 ${unsupportedHyphenRun[0].length} 个连续短横线，无法确定是分隔符还是字段内容，请改用 | 或 Tab 分隔`);
    }
    throw httpError(400, `第 ${lineNumber} 行无法识别出独立邮箱和账号字段`);
  }
  const best = candidates[0];
  const conflicting = candidates.find((candidate) => (
    candidate.recognizedCount === best.recognizedCount
    && accountParseSignature(candidate) !== accountParseSignature(best)
  ));
  if (conflicting) {
    throw httpError(400, `第 ${lineNumber} 行存在多种可能的字段分隔方式，请改用 ---- 明确分隔`);
  }
  if (passwordContainsStructuredField(best.entry.password)) {
    throw httpError(400, `第 ${lineNumber} 行似乎混用了多种分隔符，密码中又识别到 URL 或 2FA 密钥，请统一改用 ---- 分隔`);
  }
  return best.entry;
}

function accountDelimiterCandidates(line) {
  const candidates = [
    { id: "hyphen-4", split: (value) => splitHyphenDelimitedLine(value, 4), priority: 110 },
    { id: "hyphen-3", split: (value) => splitHyphenDelimitedLine(value, 3), priority: 105 },
    { id: "hyphen-mixed", split: (value) => splitMixedHyphenDelimitedLine(value), priority: 100 },
    { id: "tab", pattern: /\t+/g, priority: 80 },
    { id: "pipe", pattern: /\|+/g, priority: 70 },
    { id: "double-colon", pattern: /:{2,}/g, priority: 65 },
    { id: "semicolon", pattern: /[;；]+/g, priority: 60 },
    { id: "comma", pattern: /[,，]+/g, priority: 55 },
    { id: "spaces", pattern: / {2,}/g, priority: 40 },
  ];
  const repeated = line.match(/([#~^*])\1+/g) || [];
  for (const delimiter of new Set(repeated)) {
    candidates.push({
      id: `repeated-${delimiter[0].codePointAt(0)}`,
      pattern: new RegExp(escapeRegExp(delimiter), "g"),
      priority: 35 + delimiter.length,
    });
  }
  return candidates;
}

function parseAccountLineWithDelimiter(line, delimiter, lineNumber) {
  const split = delimiter.split ? delimiter.split(line) : splitPreservingDelimiters(line, delimiter.pattern);
  if (split.separators.length === 0) return null;
  if (split.segments.length > 64) return null;
  const fields = split.segments.map((raw, index) => ({ raw, value: raw.trim(), index, type: "plain" }));
  if (fields.filter((field) => isEmail(field.value)).length > 1) {
    return { ambiguity: "中识别到多个完整邮箱，无法确定哪个是账号" };
  }
  const emailRange = findLongestEmailRange(split);
  if (!emailRange) return null;
  for (let index = emailRange.start; index <= emailRange.end; index += 1) fields[index].type = "email";

  const urls = fields.filter((field) => field.type === "plain" && validateMailApiUrl(field.value));
  if (urls.length > 1) return null;
  if (["comma", "semicolon"].includes(delimiter.id) && urls.some((field) => (
    adjacentPlainFieldCanExtendUrl(fields, split, field)
  ))) {
    return { ambiguity: "中的 URL 可能包含逗号或分号，请改用 ---- 分隔字段" };
  }
  for (const field of urls) field.type = "mail_api";

  const remaining = fields.filter((field) => field.type === "plain" && field.value);
  const totpCandidates = remaining.filter((field) => isTotpSecretCandidate(field.value));
  const emptyFieldPresent = fields.some((field) => !field.value);
  let totp = null;
  let totpValue = "";
  if (totpCandidates.length === 1) {
    const candidate = totpCandidates[0];
    const otherPlain = remaining.filter((field) => field !== candidate);
    const followsMailApi = urls.some((field) => field.index < candidate.index);
    if (otherPlain.length > 0 || followsMailApi || emptyFieldPresent) {
      totp = candidate;
      totp.type = "totp";
      totpValue = totp.value;
    }
  } else if (totpCandidates.length > 1) {
    const conventionalPasswordTotp = delimiter.id.startsWith("hyphen-")
      && split.separators.length === 2
      && fields.length === 3
      && emailRange.start === 0
      && emailRange.end === 0
      && urls.length === 0
      && totpCandidates.length === 2
      && totpCandidates[0].index === 1
      && totpCandidates[1].index === 2;
    if (!conventionalPasswordTotp) return null;
    // A 16-character password can also look like Base32; in email----password----2FA, the final field is 2FA.
    totp = totpCandidates[1];
    totp.type = "totp";
    totpValue = totp.value;
  }
  if (!totp && delimiter.id === "spaces") {
    const groupedTotp = findGroupedTotpCandidate(fields, split);
    if (groupedTotp) {
      const outsidePlain = remaining.filter((field) => (
        field.index < groupedTotp.start || field.index > groupedTotp.end
      ));
      if (outsidePlain.length > 0 || urls.length > 0 || emptyFieldPresent) {
        for (let index = groupedTotp.start; index <= groupedTotp.end; index += 1) fields[index].type = "totp";
        totp = fields[groupedTotp.start];
        totpValue = groupedTotp.value;
      }
    }
  }

  const passwordFields = fields.filter((field) => field.type === "plain" && field.value);
  if (passwordFields.length && !indexesAreContiguous(passwordFields.map((field) => field.index))) return null;
  const password = passwordFields.length
    ? reconstructSegmentRange(split, passwordFields[0].index, passwordFields.at(-1).index).trim()
    : "";
  if (!password && !urls.length && !totp) return null;

  const recognizedCount = 1 + urls.length + Number(Boolean(totp));
  const score = recognizedCount * 1_000
    + Number(Boolean(password)) * 100
    + delimiter.priority
    - Math.max(0, split.separators.length - 3);
  return {
    score,
    recognizedCount,
    delimiter: delimiter.id,
    entry: {
      email: emailRange.value,
      loginMode: password ? "password" : "email_otp",
      mailApiUrl: urls[0]?.value || null,
      password,
      totpSecret: totp ? normalizeTotpSecret(totpValue, lineNumber) : "",
    },
  };
}

function splitHyphenDelimitedLine(line, width) {
  return splitWithSelectedMatches(line, [...line.matchAll(/-+/g)].flatMap((match) => {
    if (match[0].length === width) return [{ index: match.index, value: match[0] }];
    if (match[0].length === width * 2) {
      return [
        { index: match.index, value: "-".repeat(width) },
        { index: match.index + width, value: "-".repeat(width) },
      ];
    }
    return [];
  }));
}

function splitMixedHyphenDelimitedLine(line) {
  return splitWithSelectedMatches(line, [...line.matchAll(/-+/g)].flatMap((match) => {
    const length = match[0].length;
    if (length === 3 || length === 4) return [{ index: match.index, value: match[0] }];
    if (length >= 6 && length <= 8) {
      const firstLength = length === 6 ? 3 : 4;
      return [
        { index: match.index, value: "-".repeat(firstLength) },
        { index: match.index + firstLength, value: "-".repeat(length - firstLength) },
      ];
    }
    return [];
  }));
}

function splitWithSelectedMatches(line, matches) {
  const segments = [];
  const separators = [];
  let cursor = 0;
  for (const match of matches) {
    segments.push(line.slice(cursor, match.index));
    separators.push(match.value);
    cursor = match.index + match.value.length;
  }
  segments.push(line.slice(cursor));
  return { segments, separators };
}

function splitPreservingDelimiters(line, pattern) {
  const segments = [];
  const separators = [];
  pattern.lastIndex = 0;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    segments.push(line.slice(cursor, match.index));
    separators.push(match[0]);
    cursor = match.index + match[0].length;
  }
  segments.push(line.slice(cursor));
  return { segments, separators };
}

function reconstructSegmentRange(split, start, end) {
  let result = split.segments[start];
  for (let index = start; index < end; index += 1) {
    result += split.separators[index] + split.segments[index + 1];
  }
  return result;
}

function findLongestEmailRange(split) {
  const candidates = [];
  for (let start = 0; start < split.segments.length; start += 1) {
    for (let end = start; end < split.segments.length; end += 1) {
      const value = reconstructSegmentRange(split, start, end).trim();
      const atCount = (value.match(/@/g) || []).length;
      if (atCount > 1) break;
      if (atCount === 1 && isEmail(value)) candidates.push({ start, end, value });
    }
  }
  if (!candidates.length) return null;
  const leadingCandidates = candidates.filter((candidate) => candidate.start === 0);
  const standaloneCandidates = candidates.filter((candidate) => candidate.start === candidate.end);
  // A complete segment is a stronger signal than a longer range. Otherwise a
  // dotted password can be appended to a valid email and still look like a
  // valid domain (for example, email----r7.UjRUWVVS).
  const preferred = standaloneCandidates.length ? standaloneCandidates : leadingCandidates;
  if (!preferred.length) return null;
  preferred.sort((left, right) => (
    right.value.length - left.value.length
    || (right.end - right.start) - (left.end - left.start)
    || left.start - right.start
  ));
  const best = preferred[0];
  const conflicting = preferred.find((candidate) => (
    candidate.value.length === best.value.length && candidate.value.toLowerCase() !== best.value.toLowerCase()
  ));
  return conflicting ? null : best;
}

function adjacentPlainFieldCanExtendUrl(fields, split, urlField) {
  for (const adjacentIndex of [urlField.index - 1, urlField.index + 1]) {
    const adjacent = fields[adjacentIndex];
    if (!adjacent || adjacent.type !== "plain" || !adjacent.value) continue;
    const start = Math.min(urlField.index, adjacentIndex);
    const end = Math.max(urlField.index, adjacentIndex);
    if (validateMailApiUrl(reconstructSegmentRange(split, start, end).trim())) return true;
  }
  return false;
}

function findGroupedTotpCandidate(fields, split) {
  const candidates = [];
  for (let start = 0; start < fields.length; start += 1) {
    if (fields[start].type !== "plain" || !/^[A-Z2-7=]{4,8}$/i.test(fields[start].value)) continue;
    for (let end = start + 1; end < fields.length; end += 1) {
      if (fields[end].type !== "plain" || !/^[A-Z2-7=]{4,8}$/i.test(fields[end].value)) break;
      const value = reconstructSegmentRange(split, start, end);
      if (isTotpSecretCandidate(value)) candidates.push({ start, end, value });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => (right.end - right.start) - (left.end - left.start));
  const best = candidates[0];
  return candidates.some((candidate) => (
    candidate !== best
    && candidate.end - candidate.start === best.end - best.start
    && (candidate.start !== best.start || candidate.end !== best.end)
  )) ? null : best;
}

function isTotpSecretCandidate(value) {
  const normalized = String(value || "").toUpperCase().replace(/[\s=]/g, "");
  return /^[A-Z2-7]{16,128}$/.test(normalized);
}

function passwordContainsStructuredField(password) {
  const text = String(password || "");
  if (!text) return false;
  const patterns = [/-{3,4}/g, /\|+/g, /:{2,}/g, /[;；]+/g, /[,，]+/g, / {2,}/g];
  return patterns.some((pattern) => {
    const split = splitPreservingDelimiters(text, pattern);
    return split.separators.length > 0 && split.segments.some((segment) => (
      validateMailApiUrl(segment.trim()) || isTotpSecretCandidate(segment.trim())
    ));
  });
}

function indexesAreContiguous(indexes) {
  return indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1);
}

function compareAccountParseCandidates(left, right) {
  return right.score - left.score || left.delimiter.localeCompare(right.delimiter);
}

function accountParseSignature(candidate) {
  const { email, mailApiUrl, mailRequestBody, password, totpSecret } = candidate.entry;
  return JSON.stringify({ email: email.toLowerCase(), mailApiUrl, mailRequestBody, password, totpSecret });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function updateJobCredentials(job, credentials, options = {}) {
  if (credentials.preserveExistingCredentials) await reloadMissingJobCredentials(job);
  const normalized = credentials.preserveExistingCredentials
    ? normalizeLoginCredentials({
        password: job.password,
        mailApiUrl: job.mailApiUrl,
        mailRequestBody: job.mailRequestBody,
        totpSecret: job.totpSecret,
      })
    : normalizeLoginCredentials(credentials);
  const nextProxyUrl = options.hasProxyUpdate ? normalizeProxyUrl(options.proxyUrl) : job.proxyUrl;
  const changed = job.loginMode !== normalized.loginMode
    || (job.poolOnly && Boolean(normalized.password || normalized.totpSecret || normalized.mailApiUrl))
    || job.mailApiUrl !== normalized.mailApiUrl
    || job.mailRequestBody !== normalized.mailRequestBody
    || job.password !== normalized.password
    || job.totpSecret !== normalized.totpSecret
    || job.proxyUrl !== nextProxyUrl;
  await saveStoredLoginCredentials(job.email, { ...normalized, proxyUrl: nextProxyUrl });
  if (!changed) return;
  stopMailPolling(job);
  job.loginMode = normalized.loginMode;
  job.mailApiUrl = normalized.mailApiUrl;
  job.mailRequestBody = normalized.mailRequestBody;
  job.password = normalized.password;
  job.totpSecret = normalized.totpSecret;
  job.hasPasswordCredential = Boolean(normalized.password);
  job.hasTotpCredential = Boolean(normalized.totpSecret);
  if (normalized.password || normalized.totpSecret || normalized.mailApiUrl) job.poolOnly = false;
  job.proxyUrl = nextProxyUrl;
  job.mailSeenCandidateKeys.clear();
  job.mailCandidateCounts.clear();
  job.mailStatus = job.mailApiUrl ? "baseline" : "manual";
  job.mailApiError = null;
  recordJobOperation(job, "account_update");
  appendJobLog(job, "[account] 登录方式与验证资料已按邮箱唯一键更新，敏感字段未写入日志。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

function canReplaceTotp(job) {
  if (isActive(job.status)) return false;
  if ((job.totpRotationIncomplete || job.totpRotationRemoteDisabled) && job.resultSaved) return true;
  if (!(job.status === "completed" && job.resultSaved)) return false;
  return Boolean(job.totpKnownEnabled || hasJobTotpKey(job));
}

async function queueConfiguredTaskActions(job) {
  if ((!job.autoTaskEligible && job.lastOperationType !== "initial_authorization") || !job.resultSaved || job.autoTaskStatus !== "idle") return;
  const actions = taskAutoActionsForPlanType(getJobPlanType(job));
  job.autoTaskEligible = false;
  if (!actions.length) return;
  job.autoTaskActions = actions;
  job.autoTaskStatus = "pending";
  job.autoTaskIndex = 0;
  job.autoTaskError = null;
  job.prompt = `授权完成，正在准备自动任务：${formatTaskAutoActions(actions)}`;
  appendJobLog(job, `[auto] ${formatTaskAutoActions(actions)} 已按 PlanType ${job.planType || "未知"} 排队执行。\n`);
  touch(job);
  await saveJobMetadata(job);
  void runConfiguredTaskActions(job);
}

function resumePendingTaskAutoActions() {
  for (const job of jobs.values()) {
    if (!job.resultSaved || (!job.autoTaskEligible && job.lastOperationType !== "initial_authorization")) continue;
    if (job.autoTaskStatus === "idle") {
      void queueConfiguredTaskActions(job);
      continue;
    }
    if (!Array.isArray(job.autoTaskActions) || !job.autoTaskActions.length) continue;
    if (!["pending", "running"].includes(job.autoTaskStatus)) continue;
    job.autoTaskStatus = "pending";
    void runConfiguredTaskActions(job);
  }
}

function formatTaskAutoActions(actions) {
  return actions.map((action) => TASK_AUTO_ACTION_LABELS[action] || action).join("、");
}

async function runConfiguredTaskActions(job) {
  if (job.autoTaskStatus !== "pending") return;
  try {
    job.autoTaskStatus = "running";
    touch(job);
    await saveJobMetadata(job);
    for (let index = job.autoTaskIndex || 0; index < job.autoTaskActions.length; index += 1) {
      if (accountAutomationBlocked(job.email)) throw new Error("账号已确认永久停用，自动任务已停止");
      const action = job.autoTaskActions[index];
      job.autoTaskIndex = index;
      touch(job);
      await saveJobMetadata(job);
      if (action === "upload") {
        await runConfiguredUploadAction(job);
      } else if (action === "rotate-logout-reauthorize-upload") {
        await runConfiguredRotateAndUploadAction(job);
      } else if (action === "enable-overload-detection") {
        await withEmailJobLock(job.email, () => {
          if (taskAutoActionsForPlanType(getJobPlanType(job)).includes(action)) return overloadMonitor.setEnabled(job.email, true);
        });
        overloadMonitor.trigger();
      } else if (action === "enable-overload-cooldown") {
        await withEmailJobLock(job.email, () => {
          if (taskAutoActionsForPlanType(getJobPlanType(job)).includes(action)) return overloadCooldown.setEnabled(job.email, true);
        });
      }
      job.autoTaskIndex = index + 1;
      touch(job);
      await saveJobMetadata(job);
    }
    job.autoTaskStatus = "completed";
    job.autoTaskError = null;
    if (job.status === "completed") job.prompt = "授权完成，自动任务已完成";
    appendJobLog(job, `[auto] 已完成：${formatTaskAutoActions(job.autoTaskActions)}。\n`);
  } catch (error) {
    job.autoTaskStatus = "failed";
    job.autoTaskError = String(error?.message || error).slice(0, 500);
    if (job.status === "completed") job.prompt = `授权完成，自动任务失败：${job.autoTaskError}`;
    appendJobLog(job, `[auto] 自动任务失败：${job.autoTaskError}。可在任务列表中手动重试对应命令。\n`);
  }
  touch(job);
  await saveJobMetadata(job);
}

async function runConfiguredUploadAction(job) {
  const config = sub2ApiSettingsConfig;
  if (!config?.baseUrl || !config?.adminApiKey) throw new Error("尚未配置 Sub2API 后端地址和管理员 API Key");
  await uploadJobsToSub2Api([job], config, snapshotSub2ApiProfileState());
}

async function runConfiguredRotateAndUploadAction(job) {
  const config = sub2ApiSettingsConfig;
  if (!config?.baseUrl || !config?.adminApiKey) throw new Error("尚未配置 Sub2API 后端地址和管理员 API Key");
  await withEmailJobLock(job.email, async () => {
    if (!canReplaceTotp(job)) throw new Error("当前账号不满足自动轮换 2FA 条件");
    await startTotpSetup(job, { replaceExisting: true });
  });
  await waitForConfiguredTaskJob(job, isTotpRotationComplete, "2FA 轮换");
  await withEmailJobLock(job.email, async () => {
    await revokeAllAccountSessions(job);
  });
  await withEmailJobLock(job.email, async () => {
    if (!canForceRelogin(job)) throw new Error("轮换 2FA 后账号当前不能重新授权");
    await forceReloginJob(job, {});
  });
  await waitForConfiguredTaskJob(job, isReauthorizationComplete, "重新授权");
  await uploadJobsToSub2Api([job], config, snapshotSub2ApiProfileState());
}

async function waitForConfiguredTaskJob(job, predicate, label) {
  const deadline = Date.now() + TASK_AUTO_PIPELINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (shuttingDown) throw new Error("服务正在关闭，已停止自动任务");
    if (predicate(job)) return;
    if (["failed", "mfa_failed", "banned", "canceled", "reauth_required", "resume_available"].includes(job.status)) {
      throw new Error(`${label}未完成：${job.lastError || job.prompt || "任务失败"}`);
    }
    await delay(TASK_AUTO_POLL_INTERVAL_MS);
  }
  throw new Error(`${label}超时`);
}

async function updateStoredCredentialFields(job, body = {}) {
  if (isActive(job.status)) throw httpError(409, "任务正在运行，请等待完成后再修改凭据");
  const hasPassword = Object.hasOwn(body, "password");
  const hasTotpSecret = Object.hasOwn(body, "totpSecret");
  if (!hasPassword && !hasTotpSecret) throw httpError(400, "至少需要提供 password 或 totpSecret");

  await reloadMissingJobCredentials(job);
  if (!hasPassword && job.hasPasswordCredential && !job.password) {
    throw httpError(409, "现有密码无法从系统凭据存储读取，请同时提交密码后再修改其他字段");
  }
  if (!hasTotpSecret && job.hasTotpCredential && !job.totpSecret) {
    throw httpError(409, "现有 2FA 密钥无法从系统凭据存储读取，请同时提交 2FA 密钥后再修改其他字段");
  }
  const password = hasPassword ? String(body.password ?? "") : job.password || "";
  const totpSecret = hasTotpSecret ? normalizeTotpSecret(body.totpSecret) : job.totpSecret || "";
  if (password.length > 128) throw httpError(400, "密码长度不能超过 128 个字符");
  if (hasTotpSecret && !/^[A-Z2-7]{16,128}$/.test(totpSecret)) {
    throw httpError(400, "2FA 密钥必须是 16 到 128 位 Base32 字符");
  }

  const persisted = await saveStoredLoginCredentials(job.email, {
    password: hasPassword ? password : job.password,
    totpSecret: hasTotpSecret ? totpSecret : job.totpSecret,
    proxyUrl: job.proxyUrl,
  });
  if (hasPassword) {
    job.password = password;
    job.hasPasswordCredential = Boolean(password);
    job.loginMode = password ? "password" : (job.mailApiUrl ? "email_otp" : "manual");
  }
  if (hasTotpSecret) {
    job.totpSecret = totpSecret;
    job.hasTotpCredential = Boolean(totpSecret);
    if (totpSecret) job.totpKnownEnabled = true;
  }
  if (password || totpSecret) job.poolOnly = false;
  recordJobOperation(job, "credential_update");
  appendJobLog(job, "[account] 登录凭据已更新，敏感字段未写入日志。\n");
  touch(job);
  await saveJobMetadata(job);
  return persisted;
}

async function updateJobProxy(job, proxyUrl) {
  if (job.proxyUrl === proxyUrl) return;
  job.proxyUrl = proxyUrl;
  await saveStoredLoginCredentials(job.email, job);
  recordJobOperation(job, "proxy_update");
  appendJobLog(job, "[proxy] 账号代理配置已更新。\n");
  if (isActive(job.status) && job.status !== "queued") {
    restartJobAfterConfigurationUpdate(job);
  } else {
    touch(job);
    await saveJobMetadata(job);
  }
}

function restartJobAfterConfigurationUpdate(job) {
  job.proxyFallbackAttempted = false;
  job.proxyFallbackActive = false;
  stopMailPolling(job);
  releaseSmsNumber(job, "idle");
  job.queueRunId = null;
  job.runId = crypto.randomUUID();
  job.child?.kill("SIGTERM");
  job.child = null;
  job.lastError = null;
  job.parserTail = "";
  job.currentPhone = null;
  job.phoneError = null;
  job.securityCheckRequired = false;
  job.restartRequired = false;
  job.attempt += 1;
  beginAuthorizationAutomationAttempt(job, "configuration_update");
  appendJobLog(job, "[account] 已停止使用旧配置的登录进程，并使用新配置重新排队。\n");
  enqueueJob(job, "full", "账号资料已更新，正在重新建立登录会话");
}

async function saveJobMetadata(job) {
  if (job.deleted) return;
  job.metadataWritePromise = (job.metadataWritePromise || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (job.deleted) return;
      const metadataPath = path.join(path.dirname(job.outputPath), JOB_META_FILENAME);
      const data = {
        version: 1,
        email: job.email,
        remark: job.remark || "",
        remark_sync_pending: Boolean(job.remarkSyncPending),
        remark_sync_backend: job.remarkSyncBackend || null,
        remark_remote_snapshot: job.remarkRemoteSnapshot || {},
        remark_revision: job.remarkRevision || null,
        status: job.status,
        prompt: job.prompt || null,
        last_error: job.lastError || null,
        result_saved: Boolean(job.resultSaved),
        pool_only: Boolean(job.poolOnly),
        plan_type: job.planType || null,
        workspace_plan_type: job.workspacePlanType || null,
        plan_automation_plan_type: job.planAutomationPlanType || null,
        completed_at: job.completedAt || null,
        started_at: job.startedAt || null,
        attempt: Number(job.attempt || 1),
        security_check_required: Boolean(job.securityCheckRequired),
        queued_mode: job.queuedMode || null,
        queued_at: job.queuedAt || null,
        created_at: job.createdAt,
        last_operation_at: job.lastOperationAt || job.createdAt,
        last_operation_type: job.lastOperationType || "initial_authorization",
        web_login_previous_state: job.webLoginPreviousState || null,
        web_login_completed_at: job.webLoginCompletedAt || null,
        web_login_error: job.webLoginError || null,
        web_login_attempt_id: job.webLoginAttemptId || null,
        web_session_monitor_repair: job.webSessionMonitorRepair === true,
        web_session_maintenance_pause: job.webSessionMaintenancePause || null,
        login_mode: job.loginMode || null,
        mail_api_url: job.mailApiUrl || null,
        mail_request_body: job.mailRequestBody || null,
        has_stored_credentials: Boolean(job.password || job.totpSecret),
        has_password: Boolean(job.password || job.hasPasswordCredential),
        has_totp_key: hasJobTotpKey(job),
        totp_known_enabled: Boolean(
          !job.totpRotationRemoteDisabled && (job.totpKnownEnabled || hasJobTotpKey(job)),
        ),
        totp_setup_replace_existing: Boolean(job.totpSetupReplaceExisting),
        totp_rotation_remote_disabled: Boolean(job.totpRotationRemoteDisabled),
        totp_rotation_stage: job.totpRotationStage || null,
        totp_rotation_incomplete: Boolean(job.totpRotationIncomplete),
        password_add_error: job.passwordAddError || null,
        password_added_at: job.passwordAddedAt || null,
        login_checkpoint_available: Boolean(job.loginCheckpointAvailable),
        proxy_risk_retry_count: Number(job.proxyRiskRetryCount || 0),
        proxy_connection_failure_count: Number(job.proxyConnectionFailureCount || 0),
        proxy_configured: Boolean(job.proxyUrl),
        assigned_proxy_id: normalizeStoredProxyId(job.assignedProxyId),
        authorization_proxy_selected: Boolean(job.authorizationProxySelected),
        bound_ip: job.boundIp || null,
        bound_proxy_name: job.boundProxyName || null,
        pool_refresh_ready: Boolean(job.poolRefreshReady),
        pool_refresh_action: normalizePoolRefreshAction(job.poolRefreshAction),
        pool_refresh_due_at: job.poolRefreshDueAt || null,
        pool_refresh_error: job.poolRefreshError || null,
        pool_refresh_recovery: job.poolRefreshRecovery || null,
        sms_provider_id: job.smsProviderId || null,
        sms_provider_name: job.smsProviderName || null,
        sms_service_label: job.smsServiceLabel || null,
        sms_order_id: job.smsOrderId || null,
        sms_number: job.smsNumber || null,
        sms_status: job.smsStatus || null,
        last_auth_automated: Boolean(job.lastAuthAutomated),
        last_auth_automation_reason: job.lastAuthAutomationReason || null,
        last_auth_automated_at: job.lastAuthAutomatedAt || null,
        last_auth_requirements: job.lastAuthRequirements || null,
        auto_repair_blocked: Boolean(job.autoRepairBlocked),
        auto_repair_blocked_reason: job.autoRepairBlockedReason || null,
        ban_proxy_release_pending: Boolean(job.banProxyReleasePending),
        ban_proxy_release_error: job.banProxyReleaseError || null,
        ban_proxy_released_at: job.banProxyReleasedAt || null,
        auto_repair_blocked_at: job.autoRepairBlockedAt || null,
        auto_repair_last_attempt_at: job.autoRepairLastAttemptAt || null,
        auto_repair_last_success_at: job.autoRepairLastSuccessAt || null,
        auto_repair_last_error: job.autoRepairLastError || null,
        auto_repair_pending_account_ids: job.autoRepairPendingAccountIds || [],
        auto_repair_pending_backend: job.autoRepairPendingBackend || null,
        auto_task_actions: Array.isArray(job.autoTaskActions) ? job.autoTaskActions : [],
        auto_task_status: job.autoTaskStatus || "idle",
        auto_task_index: Number(job.autoTaskIndex || 0),
        auto_task_error: job.autoTaskError || null,
        auto_task_eligible: job.autoTaskEligible === true,
        updated_at: new Date().toISOString(),
      };
      const tempPath = `${metadataPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      try {
        for (let attempt = 0; ; attempt += 1) {
          try { await fs.rename(tempPath, metadataPath); break; }
          catch (error) {
            // Windows scanners/readers can briefly hold the destination open.
            if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
            await delay(25 * 2 ** attempt);
          }
        }
      } finally { await fs.rm(tempPath, { force: true }); }
    });
  return job.metadataWritePromise;
}

async function saveStoredLoginCredentials(email, credentials = {}) {
  const password = typeof credentials.password === "string" ? credentials.password : "";
  const totpSecret = credentials.totpSecret ? normalizeTotpSecret(credentials.totpSecret) : "";
  const proxyUrl = credentials.proxyUrl ? normalizeProxyUrl(credentials.proxyUrl) : "";
  if (!password && !totpSecret && !proxyUrl) {
    await deleteStoredLoginCredentials(email);
    return true;
  }
  try {
    await credentialStore.save(email, { password, totpSecret, proxyUrl });
  } catch (error) {
    if (error?.status === 501) return false;
    throw error;
  }
  return true;
}

async function loadStoredLoginCredentials(email) {
  try {
    const data = await credentialStore.load(email);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: data.totpSecret ? normalizeTotpSecret(data.totpSecret) : "",
      proxyUrl: data.proxyUrl ? normalizeProxyUrl(data.proxyUrl) : null,
    };
  } catch {
    return { password: "", totpSecret: "", proxyUrl: null };
  }
}

async function deleteStoredLoginCredentials(email) {
  await credentialStore.delete(email);
}

async function loadMailboxBaseline(job) {
  try {
    const candidates = await fetchMailboxOtpCandidates(mailApiUrlForJob(job), {
      request: mailRequestForJob(job),
    });
    candidates.forEach((candidate) => job.mailSeenCandidateKeys.add(candidate.key));
    job.mailStatus = "ready";
    job.mailApiError = null;
    appendJobLog(job, `[mail] 已记录收码接口中的 ${candidates.length} 个旧邮件验证码标识，等待新邮件。\n`);
  } catch (error) {
    job.mailStatus = "error";
    job.mailApiError = safeMailError(error);
    appendJobLog(job, `[mail] 首次读取收码接口失败：${job.mailApiError}\n`);
  }
  touch(job);
}

async function beginMailPolling(job) {
  if (!mailApiUrlForJob(job) || job.mailPollRunning || job.status !== "email_otp") return;
  job.mailPollRunning = true;
  job.mailStatus = "polling";
  job.mailApiError = null;
  const pollToken = crypto.randomUUID();
  const startedAt = Date.now();
  job.mailPollToken = pollToken;
  touch(job);

  try {
    while (
      job.mailPollToken === pollToken &&
      job.status === "email_otp" &&
      job.child &&
      Date.now() - startedAt < MAIL_POLL_TIMEOUT_MS
    ) {
      try {
        const candidates = filterMailboxOtpCandidatesByRequestTime(
          await fetchMailboxOtpCandidates(mailApiUrlForJob(job), {
            request: mailRequestForJob(job),
          }),
          job.mailOtpRequestedAt,
        );
        if (job.mailPollToken !== pollToken || job.status !== "email_otp" || !job.child) return;
        const unseen = candidates.filter((candidate) => !job.mailSeenCandidateKeys.has(candidate.key));
        let fresh = unseen.find((candidate) => candidate.score >= 12);
        if (!fresh) {
          unseen.forEach((candidate) => {
            job.mailCandidateCounts.set(candidate.key, (job.mailCandidateCounts.get(candidate.key) || 0) + 1);
          });
          fresh = unseen.find((candidate) => (job.mailCandidateCounts.get(candidate.key) || 0) >= 2);
        }
        job.mailApiError = null;
        if (fresh) {
          job.mailSeenCandidateKeys.add(fresh.key);
          job.mailCandidateCounts.delete(fresh.key);
          job.mailStatus = "found";
          markAuthorizationRequirement(job, "emailOtp");
          markAuthorizationAutomatic(job, "emailOtp");
          job.parserTail = "";
          appendJobLog(job, "[mail] 已从收码接口自动取得新验证码并提交。\n");
          setStage(job, "working", "已自动获取邮箱验证码，正在验证");
          job.child.stdin.write(`${fresh.code}\n`);
          return;
        }
      } catch (error) {
        if (job.mailPollToken !== pollToken) return;
        job.mailStatus = "error";
        job.mailApiError = safeMailError(error);
        touch(job);
      }
      await delay(MAIL_POLL_INTERVAL_MS);
    }

    if (job.mailPollToken === pollToken && job.status === "email_otp") {
      job.mailStatus = "timeout";
      job.mailApiError = "自动收码等待超时，请手动输入或重新发送";
      job.prompt = "自动收码等待超时，请手动输入邮箱验证码";
      touch(job);
    }
  } finally {
    if (job.mailPollToken === pollToken) {
      job.mailPollRunning = false;
      job.mailPollToken = null;
      touch(job);
    }
  }
}

function stopMailPolling(job) {
  if (!job.mailApiUrl) return;
  job.mailPollToken = null;
  job.mailPollRunning = false;
  if (job.mailStatus === "polling") job.mailStatus = "stopped";
}

function appendJobLog(job, text) {
  job.logs = `${job.logs}${sanitizeLog(text)}`.slice(-MAX_LOG_CHARS);
}

function safeMailError(error) {
  const message = String(error?.message || "读取收码接口失败");
  return message.replace(/https?:\/\/\S+/gi, "<已隐藏接口地址>").slice(0, 180);
}

function normalizeMailRequestConfig(value) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const method = String(config.method || "GET").trim().toUpperCase();
  if (!["GET", "POST"].includes(method)) throw httpError(400, "邮件接码请求方式只支持 GET 或 POST");

  const sourceHeaders = config.headers == null ? {} : config.headers;
  if (!sourceHeaders || typeof sourceHeaders !== "object" || Array.isArray(sourceHeaders)) {
    throw httpError(400, "邮件接码请求头必须是 JSON 对象");
  }
  const entries = Object.entries(sourceHeaders);
  if (entries.length > MAX_MAIL_REQUEST_HEADERS) {
    throw httpError(400, `邮件接码请求头最多配置 ${MAX_MAIL_REQUEST_HEADERS} 项`);
  }
  const headers = {};
  for (const [rawName, rawValue] of entries) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw httpError(400, `无效的请求头名称：${rawName}`);
    if (FORBIDDEN_MAIL_REQUEST_HEADERS.has(name)) throw httpError(400, `请求头 ${rawName} 由请求库自动管理，不能手动配置`);
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw httpError(400, `请求头 ${rawName} 的值必须是文本或数字`);
    }
    const headerValue = String(rawValue);
    if (/\r|\n/.test(headerValue)) throw httpError(400, `请求头 ${rawName} 不能包含换行符`);
    if (Buffer.byteLength(headerValue) > 8 * 1024) throw httpError(400, `请求头 ${rawName} 的值过长`);
    headers[name] = headerValue;
  }

  const url = String(config.url || "").trim();
  if (method === "POST" && !validateMailApiUrl(url)) {
    throw httpError(400, "POST 邮件接码模式必须配置有效的 HTTP 或 HTTPS 请求 URL");
  }
  return { method, url: validateMailApiUrl(url) ? url : null, headers };
}

function mailRequestForJob(job) {
  return {
    method: mailRequestConfig.method,
    headers: mailRequestConfig.headers,
    body: mailRequestConfig.method === "POST" ? job.mailRequestBody || "" : "",
  };
}

function mailApiUrlForJob(job) {
  return mailRequestConfig.method === "POST" && validateMailApiUrl(mailRequestConfig.url)
    ? mailRequestConfig.url
    : job.mailApiUrl;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortNewestFirst(a, b) {
  return b.createdAt.localeCompare(a.createdAt);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, "Request body is too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sessionApiError(error, job) {
  if (job && isPermanentAccountFailure(error?.message)) markAutoRepairBlocked(job, error.message);
  if (job) {
    try { assertAccountWebActionsAllowed(job); }
    catch (blocked) { return blocked; }
  }
  if (error?.status) return error;
  const message = String(error?.message || "SESSION_PROVIDER_ERROR: 会话服务请求失败")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 320);
  const status = /SESSION_(?:CREDENTIALS_UNAVAILABLE|TOKEN_EXPIRED|WORKSPACE_UNAVAILABLE)/.test(message)
    ? 409
    : /SESSION_(?:TARGET_INVALID|CURRENT_DEVICE)/.test(message)
      ? 400
      : /SESSION_TARGET_NOT_FOUND/.test(message)
        ? 404
        : /SESSION_TOKEN_REFRESH_FAILED/.test(message)
          ? 502
          : /SESSION_PROVIDER_ERROR: HTTP 401/.test(message)
            ? 401
            : /SESSION_PROVIDER_ERROR: HTTP 403/.test(message)
              ? 403
              : 502;
  return httpError(status, message.replace(/^SESSION_[A-Z_]+:\s*/, ""));
}

function accountUsageApiError(error) {
  if (error?.status) return error;
  const message = String(error?.message || "ACCOUNT_USAGE_PROVIDER_ERROR: Sub2API 用量同步失败")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 320);
  const status = /ACCOUNT_USAGE_CREDENTIALS_UNAVAILABLE|SESSION_CREDENTIALS_UNAVAILABLE|SESSION_TOKEN_EXPIRED|SESSION_WORKSPACE_UNAVAILABLE/.test(message)
    ? 409
    : /SESSION_PROVIDER_ERROR: HTTP 401/.test(message)
      ? 401
      : /SESSION_PROVIDER_ERROR: HTTP 403/.test(message)
        ? 403
        : 502;
  return httpError(status, message.replace(/^(?:ACCOUNT_USAGE|SESSION)_[A-Z_]+:\s*/, ""));
}

process.on("SIGINT", () => void shutdown().catch(reportShutdownFailure));
process.on("SIGTERM", () => void shutdown().catch(reportShutdownFailure));

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    accountDataSyncGeneration++;
    for (const timer of accountDataSyncTimers) clearTimeout(timer);
    for (const timer of poolRefreshTimers.values()) clearTimeout(timer);
    poolRefreshTimers.clear();
    queueSchedulingPaused = true;
    if (sub2ApiMonitorTimer) {
      clearInterval(sub2ApiMonitorTimer);
      sub2ApiMonitorTimer = null;
    }
    for (const controller of sub2ApiRequestControllers) controller.abort();
    await Promise.allSettled([
      overloadMonitor.stop(),
      overloadCooldown.stop(),
      modelFingerprint.stop(),
      webSessionMonitor.stop(),
      ...manualWebSessionCheckOperations,
      proxyQualityService.close(),
      sub2ApiMonitorPromise,
      ...accountDataSyncOperations,
      taskSettingsWritePromise,
      ...sub2ApiRequestPromises,
      ...sub2ApiAutoRepairPromises,
      ...poolRefreshOperations,
      ...automationBlockWrites.values(),
    ].filter(Boolean));
    const activeJobs = [...jobs.values()].filter((job) => isActive(job.status));
    const childWaits = activeJobs
      .map((job) => job.child)
      .filter(Boolean)
      .map((child) => waitForChildExit(child, 3_000));
    await Promise.allSettled(activeJobs.map((job) => cancelJob(job)));
    await Promise.allSettled([
      ...childWaits,
      ...[...jobs.values()].map((job) => job.metadataWritePromise).filter(Boolean),
    ]);
    await vite?.close();
    await closeHttpServer(server);
  })();
  return shutdownPromise;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", finish);
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, timeoutMs);
  });
}

function closeHttpServer(httpServer) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      httpServer.closeAllConnections?.();
      resolve();
    }, 3_000);
    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function reportShutdownFailure(error) {
  console.error(`[shutdown] ${error.message}`);
  process.exitCode = 1;
}
