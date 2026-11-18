import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DEFAULT_DISPLAY_TIME_ZONE, normalizeDisplayTimeZone } from "../web/src/display-time.mjs";
import { DEFAULT_LOGIN_TIMEOUT_MINUTES, DEFAULT_SMS_TIMEOUT_MINUTES, normalizeLoginTimeoutMinutes, normalizeSmsTimeoutMinutes } from "../web/src/login-settings.mjs";
import { DEFAULT_MONITORING, normalizeMonitoring, normalizeSavedMonitoring, TASK_SETTINGS_VERSION } from "../web/src/monitor-settings.mjs";
import { normalizeTaskUploadActions } from "../web/src/task-auto-actions.mjs";
import { DEFAULT_POOL_PRICE_MULTIPLIER, normalizePoolPriceMultiplier } from "../shared/account-pricing.mjs";
import { DEFAULT_OVERLOAD_COOLDOWN, normalizeOverloadCooldown } from "./overload-cooldown.mjs";
import { DEFAULT_WEB_SESSION_MONITOR, normalizeWebSessionMonitor } from "./web-session-monitor.mjs";
import { normalizeFingerprintSettings } from "./model-fingerprint.mjs";
import { normalizeCodexAuthMode } from "./sub2api-oauth.mjs";

const DEFAULT_MAX_ACTIVE_JOBS = 4;
const MAX_ACTIVE_JOBS_LIMIT = 20;
export const TASK_AUTO_ACTION_LABELS = Object.freeze({
  "authorize-codex": "Codex 授权",
  upload: "上传到 Sub2API",
  "rotate-logout-reauthorize-upload": "一键轮换并上传",
  "enable-overload-detection": "自动开启过载检测",
  "enable-overload-cooldown": "自动开启过载冷却",
});
export const TASK_AUTO_ACTIONS = new Set(Object.keys(TASK_AUTO_ACTION_LABELS));
const PROXY_MODES = ["global", "sub2api", "plan"];
const FINGERPRINT_FIELDS = ["models", "intervalMinutes", "minProbability", "maxConcurrentAccounts", "testSequence"];
const FINGERPRINT_NESTED_FIELDS = ["matchedConcurrency", "matchedPriority", "testSequence"];

const object = value => value && typeof value === "object" && !Array.isArray(value);
const changed = (before, after) => JSON.stringify(before) !== JSON.stringify(after);
function errorWithStatus(status, message) {
  return Object.assign(new Error(message), { status });
}
function boundedLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACTIVE_JOBS_LIMIT) {
    throw errorWithStatus(400, `同时运行任务数必须是 1 到 ${MAX_ACTIVE_JOBS_LIMIT} 的整数`);
  }
  return value;
}
function normalizeCooldownMinutes(value) {
  const minutes = Number(value ?? 60), max = 43_200;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > max) {
    throw errorWithStatus(400, `冷却时长必须是 1 到 ${max} 分钟的整数`);
  }
  return minutes;
}
function normalizeAutoActions(value, normalizePlanType) {
  if (value === undefined) return Object.create(null);
  if (!object(value)) throw errorWithStatus(400, "PlanType 自动任务配置必须是对象");
  const normalized = Object.create(null);
  for (const [rawPlanType, rawActions] of Object.entries(value).slice(0, 100)) {
    const planType = normalizePlanType(rawPlanType);
    if (!planType || ["__proto__", "constructor", "prototype"].includes(planType.toLowerCase())) continue;
    if (!Array.isArray(rawActions)) throw errorWithStatus(400, `PlanType ${planType} 的自动任务必须是数组`);
    const actions = [...new Set(rawActions.map(action => String(action || "").trim()).filter(Boolean))];
    if (actions.some(action => !TASK_AUTO_ACTIONS.has(action))) {
      throw errorWithStatus(400, `PlanType ${planType} 的自动任务包含不支持的命令`);
    }
    if (actions.includes("upload") && !actions.includes("authorize-codex")) actions.unshift("authorize-codex");
    if (actions.length) normalized[planType] = normalizeTaskUploadActions([
      ...actions.filter(action => action === "authorize-codex"),
      ...actions.filter(action => !["authorize-codex", "enable-overload-detection", "enable-overload-cooldown"].includes(action)),
      ...["enable-overload-detection", "enable-overload-cooldown"].filter(action => actions.includes(action)),
    ]);
  }
  return normalized;
}

function toDisk(state) {
  const { taskAutoActions, globalProxyUrl, overloadAutoCooldownSettings, webSessionMonitorSettings, monitoringSettings, ...scalars } = state;
  return {
    version: TASK_SETTINGS_VERSION, ...scalars,
    autoActions: Object.fromEntries(Object.entries(taskAutoActions).map(([key, actions]) => [key, [...actions]])),
    proxyUrl: globalProxyUrl || "", overloadAutoCooldown: { ...overloadAutoCooldownSettings },
    webSessionMonitor: { ...webSessionMonitorSettings }, monitoring: { ...monitoringSettings },
  };
}

function fingerprintPatch(previous, patch) {
  if (!object(patch)) throw errorWithStatus(400, "降智检测默认规则必须为对象");
  const next = { ...previous, ...patch };
  for (const key of FINGERPRINT_NESTED_FIELDS) {
    if (object(patch[key])) next[key] = { ...previous[key], ...patch[key] };
  }
  return normalizeFingerprintSettings(next);
}

export function createConsoleSettings({
  file, monitoringDefaults = DEFAULT_MONITORING, envLimit,
  normalizeProxyUrl, normalizePlanType, getFingerprint, saveFingerprint, applyFingerprintSettings = () => {}, hasSub2ApiConfig,
  prepareProxyChange, applyProxyChange, taskRuntimeSteps,
  files = fs,
}) {
  const limit = Number(envLimit);
  const defaults = {
    displayTimeZone: DEFAULT_DISPLAY_TIME_ZONE, poolPriceMultiplier: DEFAULT_POOL_PRICE_MULTIPLIER,
    maxActiveJobs: Number.isInteger(limit) && limit >= 1 && limit <= MAX_ACTIVE_JOBS_LIMIT ? limit : DEFAULT_MAX_ACTIVE_JOBS,
    loginTimeoutMinutes: DEFAULT_LOGIN_TIMEOUT_MINUTES, smsTimeoutMinutes: DEFAULT_SMS_TIMEOUT_MINUTES,
    globalProxyUrl: null, allowDirectFallback: false, accountProxyMode: "global", codexAuthMode: "local",
    accountProxyCooldownMinutes: 60, monitoringSettings: { ...monitoringDefaults },
    taskAutoActions: Object.create(null), overloadAutoCooldownSettings: { ...DEFAULT_OVERLOAD_COOLDOWN },
    webSessionMonitorSettings: { ...DEFAULT_WEB_SESSION_MONITOR },
  };
  let current = defaults, writes = Promise.resolve(), closed = false;
  const pendingTaskSteps = new Map();
  let pendingProxy = null, pendingFingerprint = false;
  let failedScopes = [];

  function publicSettings(includeProxy = true) {
    const { version, proxyUrl, ...settings } = toDisk(current);
    return {
      ...settings, ...(includeProxy ? { proxyUrl } : {}), modelFingerprint: getFingerprint(),
      min: 1, max: MAX_ACTIVE_JOBS_LIMIT, default: DEFAULT_MAX_ACTIVE_JOBS,
      autoActionOptions: Object.entries(TASK_AUTO_ACTION_LABELS).map(([value, label]) => ({ value, label })),
    };
  }
  function publicProxySettings() {
    return { proxyUrl: current.globalProxyUrl || "", allowDirectFallback: current.allowDirectFallback, mode: current.accountProxyMode };
  }
  async function load() {
    try {
      const saved = JSON.parse(await files.readFile(file, "utf8"));
      current = {
        displayTimeZone: normalizeDisplayTimeZone(saved.displayTimeZone),
        poolPriceMultiplier: normalizePoolPriceMultiplier(saved.poolPriceMultiplier),
        maxActiveJobs: boundedLimit(saved.maxActiveJobs),
        loginTimeoutMinutes: normalizeLoginTimeoutMinutes(saved.loginTimeoutMinutes),
        smsTimeoutMinutes: normalizeSmsTimeoutMinutes(saved.smsTimeoutMinutes),
        taskAutoActions: normalizeAutoActions(saved.autoActions, normalizePlanType),
        globalProxyUrl: saved.proxyUrl ? normalizeProxyUrl(saved.proxyUrl) : null,
        allowDirectFallback: saved.allowDirectFallback === true,
        accountProxyMode: PROXY_MODES.includes(saved.accountProxyMode) ? saved.accountProxyMode : "global",
        codexAuthMode: normalizeCodexAuthMode(saved.codexAuthMode),
        accountProxyCooldownMinutes: normalizeCooldownMinutes(saved.accountProxyCooldownMinutes),
        overloadAutoCooldownSettings: normalizeOverloadCooldown(saved.overloadAutoCooldown),
        webSessionMonitorSettings: normalizeWebSessionMonitor(saved.webSessionMonitor),
        monitoringSettings: normalizeSavedMonitoring(saved, monitoringDefaults),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`任务设置读取失败：${error.message}`);
    }
  }
  async function replaceFile(bytes) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await files.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await files.rename(temporary, file);
    } finally { await files.rm(temporary, { force: true }).catch(() => {}); }
  }
  function enqueue(operation) {
    if (closed) return Promise.reject(errorWithStatus(503, "服务正在关闭"));
    writes = writes.catch(() => {}).then(operation);
    return writes;
  }
  function runtimeApplyStatus() {
    return failedScopes.length
      ? { runtimeApply: { status: "pending", scopes: failedScopes, message: "设置已保存，运行时应用失败。请重试应用。" } }
      : {};
  }
  async function applyRuntime() {
    // Tracking each step independently lets a failure leave only that step
    // pending. All steps run under the settings queue, including retries.
    if (pendingFingerprint) {
      try { await applyFingerprintSettings(); pendingFingerprint = false; } catch {}
    }
    for (const [name, apply] of pendingTaskSteps) {
      try { await apply(current); pendingTaskSteps.delete(name); } catch {}
    }
    if (pendingProxy) {
      try { await applyProxyChange(pendingProxy); pendingProxy = null; } catch {}
    }
    failedScopes = [pendingTaskSteps.size && "tasks", pendingProxy && "proxy", pendingFingerprint && "fingerprint"].filter(Boolean);
  }
  function saveFingerprintSettings(raw, { partial = false } = {}) {
    return enqueue(async () => {
      if (!object(raw)) throw errorWithStatus(400, "降智检测默认规则必须为对象");
      if (!partial || Object.keys(raw).length) {
        await saveFingerprint(partial ? fingerprintPatch(getFingerprint(), raw) : raw);
        pendingFingerprint = true;
      }
      await applyRuntime();
    });
  }
  function save(patch) {
    return enqueue(async () => {
      const previous = current, next = { ...previous };
      const has = key => Object.hasOwn(patch, key);
      const normalize = (key, fn, target = key) => {
        if (!has(key)) return;
        try { next[target] = fn(patch[key]); }
        catch (error) { throw errorWithStatus(400, error.message); }
      };
      const merge = (key, target, fn, message) => normalize(key, value => {
        if (!object(value)) throw new Error(message);
        return fn({ ...previous[target], ...value });
      }, target);
      if (has("accountProxyMode") && !PROXY_MODES.includes(patch.accountProxyMode)) {
        throw errorWithStatus(400, "代理分配模式无效");
      }
      const proxyChange = has("accountProxyMode") ? await prepareProxyChange(patch.accountProxyMode) : null;
      normalize("poolPriceMultiplier", normalizePoolPriceMultiplier);
      normalize("displayTimeZone", normalizeDisplayTimeZone);
      normalize("smsTimeoutMinutes", normalizeSmsTimeoutMinutes);
      normalize("loginTimeoutMinutes", normalizeLoginTimeoutMinutes);
      normalize("monitoring", value => normalizeMonitoring(value, previous.monitoringSettings), "monitoringSettings");
      merge("webSessionMonitor", "webSessionMonitorSettings", normalizeWebSessionMonitor, "WebSession 巡检设置必须为对象");
      let fingerprint = null;
      if (has("modelFingerprint")) {
        if (!object(patch.modelFingerprint)) throw errorWithStatus(400, "降智检测默认规则必须为对象");
        const fields = Object.fromEntries(FINGERPRINT_FIELDS.filter(key => Object.hasOwn(patch.modelFingerprint, key)).map(key => [key, patch.modelFingerprint[key]]));
        try { fingerprint = fingerprintPatch(getFingerprint(), fields); }
        catch (error) { throw errorWithStatus(400, error.message); }
      }
      normalize("codexAuthMode", normalizeCodexAuthMode);
      if (has("codexAuthMode") && next.codexAuthMode === "sub2api" && !hasSub2ApiConfig()) {
        throw errorWithStatus(409, "请先保存 Sub2API 后端地址和管理员 API Key，再选择 Sub2API 授权");
      }
      normalize("maxActiveJobs", boundedLimit);
      normalize("autoActions", value => normalizeAutoActions(value, normalizePlanType), "taskAutoActions");
      normalize("proxyUrl", normalizeProxyUrl, "globalProxyUrl");
      normalize("allowDirectFallback", value => value === true);
      if (has("accountProxyMode")) next.accountProxyMode = patch.accountProxyMode;
      normalize("accountProxyCooldownMinutes", normalizeCooldownMinutes);
      merge("overloadAutoCooldown", "overloadAutoCooldownSettings", normalizeOverloadCooldown, "自动冷却规则格式无效");
      const steps = [...taskRuntimeSteps(previous, next, {
        timeouts: has("loginTimeoutMinutes") || has("smsTimeoutMinutes"),
        webMonitor: changed(previous.webSessionMonitorSettings, next.webSessionMonitorSettings),
        cooldownRule: changed(previous.overloadAutoCooldownSettings, next.overloadAutoCooldownSettings),
      })];

      const previousBytes = fingerprint ? await files.readFile(file).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      }) : null;
      await replaceFile(`${JSON.stringify(toDisk(next), null, 2)}\n`);
      if (fingerprint) {
        try { await saveFingerprint(fingerprint); }
        catch (error) {
          if (previousBytes !== null) await replaceFile(previousBytes);
          else await files.rm(file, { force: true });
          throw error;
        }
        pendingFingerprint = true;
      }

      current = next;
      for (const [name, apply] of steps) pendingTaskSteps.set(name, apply);
      if (proxyChange) pendingProxy = proxyChange;
      await applyRuntime();
    });
  }
  function close() {
    closed = true;
    return writes;
  }
  return {
    get current() { return current; },
    load, save, saveFingerprintSettings, publicSettings, publicProxySettings, runtimeApplyStatus,
    retryRuntime: () => enqueue(applyRuntime), close,
  };
}

export function createConsoleSettingsRoutes({ settings, readJson, sendJson, httpError }) {
  return async function handleSettingsRoute(req, res, { pathname }) {
    if (pathname === "/api/task-settings/retry-runtime") {
      if (req.method !== "POST") throw httpError(405, "Method not allowed");
      await settings.retryRuntime();
      sendJson(res, 200, { settings: settings.publicSettings(), ...settings.runtimeApplyStatus() });
      return true;
    }
    if (pathname === "/api/task-settings" && ["GET", "POST"].includes(req.method)) {
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!object(body)) throw httpError(400, "任务设置必须为对象");
        await settings.save(body);
      }
      sendJson(res, 200, { settings: settings.publicSettings(), ...settings.runtimeApplyStatus() });
      return true;
    }
    if (pathname !== "/api/account-proxy-settings") return false;
    if (req.method === "POST") {
      const body = await readJson(req);
      if (typeof body.proxyUrl !== "string" || typeof body.allowDirectFallback !== "boolean") {
        throw httpError(400, "代理地址必须是字符串，回退开关必须是布尔值");
      }
      await settings.save({ proxyUrl: body.proxyUrl, allowDirectFallback: body.allowDirectFallback,
        ...(Object.hasOwn(body, "mode") ? { accountProxyMode: body.mode } : {}) });
    } else if (req.method !== "GET") throw httpError(405, "Method not allowed");
    sendJson(res, 200, { settings: settings.publicProxySettings(), ...settings.runtimeApplyStatus() });
    return true;
  };
}
