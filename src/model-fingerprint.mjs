import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { generateChallenges, loadDetector, parseNumbers } from "lmfpd-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { fingerprintFailure, fingerprintRecovery } from "./model-fingerprint-request.mjs";
import { CANDY_PROMPT, CANDY_PROMPT_SHA256, gradeCandy, DEFAULT_TEST_SEQUENCE, normalizeTestSequence, sequenceStep, aggregateRequestUsage } from "./candy-test.mjs";
import { DEFAULT_REGEX_PRECHECK, normalizeRegexPrecheck } from "../shared/regex-precheck.mjs";
import { evaluateRegexPrecheck } from "./regex-precheck.mjs";

const invalid = message => Object.assign(new Error(message), { status: 400 });
export const DEFAULT_FINGERPRINT_SETTINGS = Object.freeze({ models: [], intervalMinutes: 360, maxConcurrentAccounts: 3, minProbability: 0.8, failureRetries: 1, failureRetryDelaySeconds: 5, precheck: DEFAULT_REGEX_PRECHECK, testSequence: DEFAULT_TEST_SEQUENCE, enabledPlanTypes: [], matchedConcurrency: { enabled: false, value: 10 }, matchedPriority: { enabled: false, value: 1 }, groupPolicies: {} });
const isPoolInteger = value => Number.isInteger(value) && value >= 0 && value <= 10000;
const poolNumberPolicies = {
  concurrency: { setting: "matchedConcurrency", label: "并发", update: "updateConcurrency", valid: isPoolInteger },
  priority: { setting: "matchedPriority", label: "优先级", update: "updatePriority", valid: isPoolInteger },
};
const poolNumberFields = Object.keys(poolNumberPolicies);
const HISTORY_WINDOW_MS = 60 * 60_000;
const summaryModels = models => models?.map(({ requests, ...model }) => model);
const roundModels = result => [...(result.precheck?.models || []), ...(result.models || [])];
const roundSummary = record => record ? { ...record, models: summaryModels(record.models),
  ...(record.precheck ? { precheck: { ...record.precheck, ...(record.precheck.models ? { models: summaryModels(record.precheck.models) } : {}) } } : {}) } : null;
export function normalizeFingerprintModels(value) {
  if (!Array.isArray(value) || value.length > 8) throw invalid("检测模型必须是最多 8 项的列表");
  const seen = new Set();
  return value.map(item => {
    const model = String(typeof item === "string" ? item : item?.model || "").trim();
    const expected = String(typeof item === "string" ? item : item?.expected || model).trim();
    if (!model || !expected || model.length > 160 || expected.length > 160 || /[\r\n\x00]/.test(model + expected) || seen.has(model)) throw invalid("检测模型或预期指纹名称无效、重复");
    seen.add(model); return { model, expected };
  });
}
function interval(value) {
  if (typeof value === "boolean" || value === "" || !Number.isInteger(Number(value)) || Number(value) < 5 || Number(value) > 43200) throw invalid("指纹检测间隔必须为 5–43200 分钟的整数");
  return Number(value);
}
export function normalizeFingerprintSettings(raw = {}) {
  const models = normalizeFingerprintModels(raw.models ?? []);
  const minProbability = Number(raw.minProbability ?? 0.8);
  const maxConcurrentAccounts = Number(raw.maxConcurrentAccounts ?? 3);
  // Read the previous candy-only names once; persisted/public settings use the
  // shared names, preserving the user's configured count and delay on upgrade.
  const failureRetries = raw.failureRetries === undefined ? (raw.candyRetries === undefined ? 1 : raw.candyRetries) : raw.failureRetries;
  const failureRetryDelaySeconds = raw.failureRetryDelaySeconds === undefined ? (raw.candyRetryDelaySeconds === undefined ? 5 : raw.candyRetryDelaySeconds) : raw.failureRetryDelaySeconds;
  if (!Number.isInteger(failureRetries) || failureRetries < 0 || failureRetries > 5) throw invalid("检测失败重试次数必须为 0–5 的整数");
  if (!Number.isInteger(failureRetryDelaySeconds) || failureRetryDelaySeconds < 1 || failureRetryDelaySeconds > 300) throw invalid("检测失败重试间隔必须为 1–300 秒的整数");
  if (typeof raw.maxConcurrentAccounts === "boolean" || !Number.isInteger(maxConcurrentAccounts) || maxConcurrentAccounts < 1 || maxConcurrentAccounts > 16) throw invalid("同时检测账号数量必须为 1–16 的整数");
  if (typeof raw.minProbability === "boolean" || !Number.isFinite(minProbability) || minProbability < 0.5 || minProbability > 1) throw invalid("指纹归因阈值必须为 0.5–1");
  // Upgrade the former boolean map once. An explicit empty list disables every
  // PlanType, even if a stale client also sends the old map.
  const plans = Object.hasOwn(raw, "enabledPlanTypes") ? raw.enabledPlanTypes : Object.entries(raw.planDefaults || {}).filter(([, enabled]) => enabled === true).map(([plan]) => plan);
  if (!Array.isArray(plans) || plans.length > 100 || plans.some(plan => typeof plan !== "string" || !plan.trim() || plan.length > 160 || /[\r\n\x00]/.test(plan))) throw invalid("PlanType 必须为有效名称列表");
  const enabledPlanTypes = [...new Set(plans.map(plan => plan.trim().toLowerCase()))].sort();
  const matchedConcurrency = raw.matchedConcurrency === undefined ? { enabled: false, value: 10 } : raw.matchedConcurrency;
  if (!matchedConcurrency || typeof matchedConcurrency.enabled !== "boolean" || !Number.isInteger(matchedConcurrency.value) || matchedConcurrency.value < 0 || matchedConcurrency.value > 10000) throw invalid("不降智账号并发必须为 0–10000 的整数，开关必须为布尔值");
  const matchedPriority = raw.matchedPriority === undefined ? { enabled: false, value: 1 } : raw.matchedPriority;
  if (!matchedPriority || typeof matchedPriority.enabled !== "boolean" || !Number.isInteger(matchedPriority.value) || matchedPriority.value < 0 || matchedPriority.value > 10000) throw invalid("不降智账号优先级必须为 0–10000 的整数，开关必须为布尔值");
  const groupPolicies = Object.create(null);
  if (raw.groupPolicies != null && (typeof raw.groupPolicies !== "object" || Array.isArray(raw.groupPolicies))) throw invalid("降智分组规则无效");
  for (const [profile, rules] of Object.entries(raw.groupPolicies || {})) {
    if (!profile || profile.length > 128 || !rules || typeof rules !== "object" || Array.isArray(rules)) throw invalid("降智分组规则无效");
    groupPolicies[profile] = Object.create(null);
    for (const [id, mode] of Object.entries(rules)) {
      if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || !["default", "verified"].includes(mode)) throw invalid("降智分组规则无效");
      groupPolicies[profile][id] = mode;
    }
  }
  return { models, intervalMinutes: interval(raw.intervalMinutes ?? 360), maxConcurrentAccounts, minProbability, failureRetries, failureRetryDelaySeconds, precheck: normalizeRegexPrecheck(raw.precheck), testSequence: normalizeTestSequence(raw.testSequence), enabledPlanTypes, matchedConcurrency: { enabled: matchedConcurrency.enabled, value: matchedConcurrency.value }, matchedPriority: { enabled: matchedPriority.enabled, value: matchedPriority.value }, groupPolicies };
}
export function normalizeFingerprintOverride(raw = {}) {
  if (raw.enabled != null && typeof raw.enabled !== "boolean") throw invalid("账号检测开关必须为布尔值或继承");
  return { enabled: raw.enabled ?? null, models: raw.models == null ? null : normalizeFingerprintModels(raw.models), intervalMinutes: raw.intervalMinutes == null ? null : interval(raw.intervalMinutes), testSequence: raw.testSequence == null ? null : normalizeTestSequence(raw.testSequence) };
}
const label = value => String(value || "").trim().toLowerCase();
export const fingerprintAccountIdentity = account => crypto.createHash("sha256").update(JSON.stringify({ id: String(account.id), type: account.type, parent: account.parent_account_id, proxy: account.proxy_id ?? 0, proxyUrl: account.fingerprintProxyUrl, credentials: account.credentials || {} })).digest("hex");
const fingerprintRoutingIdentity = account => crypto.createHash("sha256").update(JSON.stringify({ id: String(account.id), type: account.type, parent: account.parent_account_id, proxy: account.proxy_id ?? 0, version: account.credentials?._token_version, account: account.credentials?.chatgpt_account_id, user: account.credentials?.chatgpt_user_id, mapping: account.credentials?.model_mapping })).digest("hex");
function referenceLabels(id, name) {
  const names = String(name || "").split("/").map(label).filter(Boolean);
  const prefix = /^([a-z]+-)\d/.exec(names[0] || "")?.[1];
  return [...new Set([label(id), label(name), ...names.map(n => prefix && /^\d/.test(n) ? prefix + n : n)].filter(Boolean))];
}
export function fingerprintEvaluation(analysis, expected, threshold) {
  const unknown = reason => ({ status: "unknown", reason });
  if (Number.isInteger(analysis?.used_outputs) && analysis.used_outputs !== 3) return unknown(`仅获得 ${analysis.used_outputs}/3 份有效检测样本，请查看各样本的实际数字数与期望数量`);
  if (analysis?.decision !== "scored") return unknown("响应不具备可评分的数字指纹");
  if (analysis.used_outputs !== 3) return unknown("未获得三份有效检测样本");
  if (analysis.probability_status !== "reference_calibrated" || !Number.isFinite(analysis.probability)) return unknown("参考库未提供可校准的归因概率");
  const reference = analysis.results?.find(r => referenceLabels(r.model, r.display_name).includes(label(expected)));
  if (!reference) return unknown("预期模型未包含在本轮参考库中，请核对模型或参考类名称");
  if (analysis.probability < threshold) return unknown("归因概率低于设置的阈值");
  const match = referenceLabels(analysis.prediction, analysis.prediction_name).includes(label(expected));
  const combined = String(reference.display_name || "").includes("/");
  return { status: match ? "match" : "mismatch", reason: match ? combined ? "匹配合并参考类；该参考库不区分其中的单个模型" : "归因与预期模型一致" : "高概率归因为另一个参考类", expectedReference: { id: reference.model, name: reference.display_name, combined } };
}
export const fingerprintVerdict = (analysis, expected, threshold) => fingerprintEvaluation(analysis, expected, threshold).status;
export function aggregateFingerprint(results) {
  if (results.length && results.every(item => item.status === "error")) return "error";
  if (!results.length || results.some(item => item.status === "unknown" || item.status === "error")) return "unknown";
  return results.some(item => item.status === "mismatch") ? "mismatch" : "match";
}

// The reference data is public; only data files are downloaded. Replies are scored locally.
export class ModelFingerprintService {
  constructor({ onVerdict = () => {}, dispatchPaused = () => false, filePath, getContext, listTargets, getAccount, sample, updateConcurrency, updatePriority, updateGroups, getPoolNumberDefaults, getPoolNumberPolicy, getPoolNumberJobs, getPoolAccount = getAccount, isBlocked = () => false, onChange = () => {}, onAccountFailure = async () => {}, now = Date.now, detectorLoader, challenges = generateChallenges, retryDelay = (ms, signal) => delay(ms, undefined, { signal }) }) {
    this.dispatchPaused = dispatchPaused;
    this.onVerdict = onVerdict;
    Object.assign(this, { filePath, getContext, listTargets, getAccount, sample, updateConcurrency, updatePriority, updateGroups, getPoolNumberDefaults, getPoolNumberPolicy, getPoolNumberJobs, getPoolAccount, isBlocked, onChange, onAccountFailure, now, challenges, retryDelay });
    this.manualChecks = new Set();
    this.settings = normalizeFingerprintSettings(); this.accounts = new Map(); this.active = new Map(); this.queued = new Map(); this.inFlight = new Map(); this.runningTasks = new Set(); this.writePromise = Promise.resolve(); this.mutationPromise = Promise.resolve(); this.revision = 0; this.stopped = true; this.closing = false;
    this.detectorLoader = detectorLoader || (() => loadDetector({ source: "https://lm.ikale.io/data/", cache: path.join(path.dirname(filePath), "model-fingerprint-data.bin") }));
  }
  async detector(signal) {
    if (!this.detectorPromise) this.detectorPromise = Promise.resolve().then(() => this.detectorLoader()).catch(() => { this.detectorPromise = null; throw new Error("指纹参考库加载失败，请稍后重试"); });
    let timer, abort;
    try {
      signal?.throwIfAborted();
      return await Promise.race([this.detectorPromise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("指纹参考库加载超时")), 60000);
        abort = () => reject(signal.reason || new Error("检测已取消"));
        signal?.addEventListener("abort", abort, { once: true });
      })]);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
  }
  mutate(operation) {
    const task = this.mutationPromise.catch(() => {}).then(operation);
    this.mutationPromise = task; return task;
  }
  cancelQueued(email) { const task = this.queued.get(email); if (task) { this.queued.delete(email); this.inFlight.delete(email); task.resolve(this.snapshot(email, task.planType)); } }
  invalidateAccount(email) { email = label(email); this.active.get(email)?.abort(); this.cancelQueued(email); }
  isManualCheck(email) { email = label(email); return this.manualChecks.has(email) || this.queued.get(email)?.options.manual === true; }
  invalidate() { this.revision++; for (const controller of this.active.values()) controller.abort(); for (const email of this.queued.keys()) this.cancelQueued(email); }
  async referenceInfo() {
    const detector = await this.detector();
    // The SDK exposes labels on analysis results, not as an enumeration method.
    // These local synthetic inputs enumerate candidates only; they are never saved as account evidence.
    const analysis = detector.analyze(Array.from({ length: 3 }, (_, j) => ({ text: Array.from({ length: 300 }, (_, i) => (i * 37 + j * 13) % 355 + 1).join(", "), expected_count: 300 })), { strict: true });
    return { builtAt: detector.builtAt, models: analysis.results.map(r => ({ id: r.model, name: r.display_name, aliases: referenceLabels(r.model, r.display_name) })).sort((a, b) => a.id.localeCompare(b.id)) };
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1) throw new Error("版本无效");
      this.settings = normalizeFingerprintSettings(data.settings);
      for (const [email, entry] of Object.entries(data.accounts || {})) {
        const saved = entry;
        this.accounts.set(email, { ...saved, override: normalizeFingerprintOverride(entry.override), recentResults: this.latestRounds(entry), result: roundSummary(entry.result), phase: "idle", groupSyncPending: Boolean(entry.groupSyncPending || data.groupPolicyVersion !== 2 && Object.keys(this.settings.groupPolicies).length && ["match", "mismatch"].includes(entry.result?.status)), concurrencySyncPending: Boolean(entry.concurrencySyncPending || Object.keys(entry.concurrencyOverrides || {}).length || this.settings.matchedConcurrency.enabled && entry.result?.status === "match") });
        this.accounts.get(email).prioritySyncPending = Boolean(entry.prioritySyncPending || Object.keys(entry.priorityOverrides || {}).length || this.settings.matchedPriority.enabled && entry.result?.status === "match");
      }
      // Persist pruning immediately, including legacy histories that previously kept 200 rounds.
      if (this.getPoolNumberPolicy) this.markPoolNumbersPending();
      await this.persist();
    } catch (error) { if (error.code !== "ENOENT") throw new Error(`模型指纹配置读取失败：${error.message}`); }
  }
  persist(settings = this.settings) {
    for (const entry of this.accounts.values()) { entry.recentResults = this.latestRounds(entry); entry.result = roundSummary(entry.result); delete entry.history; delete entry.fingerprintResult; }
    const text = JSON.stringify({ version: 1, groupPolicyVersion: 2, settings, accounts: Object.fromEntries(this.accounts) }, null, 2);
    const operation = this.writePromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, text + "\n", { mode: 0o600 }); await fs.rename(temp, this.filePath); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }); this.writePromise = operation; return operation;
  }
  effective(email, planType = "") {
    const override = this.accounts.get(label(email))?.override || {};
    return { enabled: this.settings.enabledPlanTypes.includes(label(planType)) && override.enabled !== false, models: override.models ?? this.settings.models, intervalMinutes: override.intervalMinutes ?? this.settings.intervalMinutes, minProbability: this.settings.minProbability, precheck: this.settings.precheck, testSequence: override.testSequence ?? this.settings.testSequence };
  }
  sequence(email, planType) {
    const { testSequence } = this.effective(email, planType);
    const signature = JSON.stringify([this.signature(email, planType, false), testSequence]);
    const saved = this.accounts.get(label(email))?.sequenceCursor;
    return { ...sequenceStep(testSequence, saved?.signature === signature ? saved.index : 0), signature };
  }
  groupResult(email, planType) {
    // The final stage decides this round. Preliminary failures never override
    // a completed fallback, and earlier rounds never override this result.
    const result = this.accounts.get(label(email))?.result;
    return result?.signature === this.signature(email, planType) ? result : null;
  }
  signature(email, planType, includePrecheck = true) {
    const { models, minProbability, precheck } = this.effective(email, planType);
    return JSON.stringify({ models, minProbability, planType: label(planType), backend: this.getContext().backend, routing: this.getContext().routing,
      ...(includePrecheck && precheck.enabled ? { precheck: crypto.createHash("sha256").update(JSON.stringify(precheck)).digest("hex") } : {}) });
  }
  snapshot(email, planType = "") {
    email = label(email);
    const entry = this.accounts.get(label(email));
    const current = entry?.result?.signature === this.signature(email, planType);
    const effective = this.effective(email, planType), queued = this.queued.has(email);
    const config = { ...effective, precheck: { enabled: effective.precheck.enabled, model: effective.precheck.model } };
    const { signature: _signature, index: _index, ...sequence } = this.sequence(email, planType);
    return { ...config, sequence, runningMethod: this.active.has(email) ? entry?.activeMethod : null, override: entry?.override || { enabled: null, models: null, intervalMinutes: null, testSequence: null }, phase: this.active.has(email) ? "running" : queued ? "queued" : "idle", queuePosition: queued ? [...this.queued.keys()].indexOf(email) + 1 : null, recentResults: this.latestRounds(entry).map(({ checkedAt, status, method }) => ({ checkedAt, status, method: method || 'fingerprint' })), historyCountLastHour: this.recentHistory(entry).length, lastAttemptAt: entry?.lastAttemptAt || null, result: current ? roundSummary(entry?.result) : null, previousResult: !current ? roundSummary(entry?.result) : null, nextCheckAt: entry?.nextCheckAt || null, lastError: entry?.lastError || null, groupSyncPending: Boolean(entry?.groupSyncPending), groupSyncError: entry?.groupSyncError || null, concurrencySyncPending: Boolean(entry?.concurrencySyncPending), concurrencySyncError: entry?.concurrencySyncError || null, prioritySyncPending: Boolean(entry?.prioritySyncPending), prioritySyncError: entry?.prioritySyncError || null };
  }
  latestRounds(entry) {
    const records = new Map();
    const richness = r => (r.transcriptVersion ? 1000 : 0) + (r.models?.length || 0);
    for (const record of [...(entry?.recentResults || []), ...(entry?.history || []), ...(entry?.result ? [this.historyRecord(entry.result)] : [])]) {
      if (!Number.isFinite(Date.parse(record.checkedAt)) || Date.parse(record.checkedAt) > this.now()) continue;
      const key = record.id || record.checkedAt, previous = records.get(key);
      if (!previous || richness(record) > richness(previous)) records.set(key, record);
    }
    return [...records.values()].sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt)).slice(0, 6);
  }
  recentHistory(entry) {
    return this.latestRounds(entry).filter(r => Date.parse(r.checkedAt) >= this.now() - HISTORY_WINDOW_MS);
  }
  historyRecord(result) { return { id: result.id, method: result.method || 'fingerprint', ...(result.precheck ? { precheck: result.precheck } : {}), sequencePosition: result.sequencePosition, usage: result.usage, transcriptVersion: result.transcriptVersion, requestCount: result.requestCount, checkedAt: result.checkedAt, status: result.status, models: result.models, error: result.error || null, failure: result.failure || null, durationMs: result.durationMs ?? null, source: result.source || "legacy", legacy: !result.models?.every(m => ['candy', 'regex'].includes(m.method) || m.probabilityStatus || m.status === "error") }; }
  recordResult(entry, result) {
    if (["match", "mismatch"].includes(result.status)) {
      for (const field of Object.keys(poolNumberPolicies)) for (const guard of Object.values(entry[`${field}ManualEdits`] || {})) {
        if (guard.backend === (result.backend ?? this.getContext().backend) && guard.verdict !== result.status) guard.invalidated = true;
      }
      entry.poolNumberVerdict = result.status;
    }
    const record = this.historyRecord({ ...result, id: crypto.randomUUID(), transcriptVersion: 1, requestCount: roundModels(result).reduce((n, m) => n + (m.requests?.length || 0), 0) });
    entry.recentResults = this.latestRounds({ recentResults: [record, ...this.latestRounds(entry)] });
    entry.result = roundSummary({ ...result, id: record.id, transcriptVersion: 1, requestCount: record.requestCount });
    delete entry.history;
  }
  history(email, planType) {
    const state = this.snapshot(email, planType);
    const records = this.latestRounds(this.accounts.get(label(email))).map(roundSummary);
    return { since: records.at(-1)?.checkedAt || new Date(this.now()).toISOString(), until: new Date(this.now()).toISOString(), records, phase: state.phase, runningMethod:state.runningMethod, queuePosition: state.queuePosition, enabled: state.enabled, nextCheckAt: state.nextCheckAt, models: state.models, testSequence:state.testSequence, sequence:state.sequence, lastError: state.lastError, groupSyncPending: state.groupSyncPending, groupSyncError: state.groupSyncError, concurrencySyncError: state.concurrencySyncError, concurrencySyncPending: state.concurrencySyncPending, prioritySyncError: state.prioritySyncError, prioritySyncPending: state.prioritySyncPending };
  }
  historyDetail(email, roundId) {
    const record = this.latestRounds(this.accounts.get(label(email))).find(r => (r.id || r.checkedAt) === roundId);
    if (!record) throw Object.assign(new Error("该轮记录已轮换或不存在，请刷新最近 6 轮记录"), { status: 404 });
    return { record };
  }
  saveSettings(raw, { applyRuntime = true } = {}) {
    const next = normalizeFingerprintSettings({
      matchedConcurrency: this.settings.matchedConcurrency,
      matchedPriority: this.settings.matchedPriority,
      groupPolicies: this.settings.groupPolicies,
      precheck: this.settings.precheck,
      ...raw,
    });
    const samplingSettings = settings => [settings.models, settings.minProbability, settings.intervalMinutes, settings.enabledPlanTypes, settings.testSequence, settings.precheck];
    const changedSampling = JSON.stringify(samplingSettings(next)) !== JSON.stringify(samplingSettings(this.settings));
    if (changedSampling) this.invalidate();
    return this.mutate(async () => {
      if (changedSampling) this.invalidate();
      // Keep active entry identities when only policy/queue limits change.
      for (const entry of this.accounts.values()) { if (changedSampling) entry.nextCheckAt = null; entry.concurrencySyncPending = true; entry.prioritySyncPending = true; entry.groupSyncPending = true; }
      await this.persist(next);
      this.settings = next;
      if (applyRuntime) {
        await this.applySavedSettings();
        return this.publicSettings();
      }
    });
  }
  async applySavedSettings() {
    await this.onChange();
    this.drain();
    this.trigger();
  }
  saveOverride(email, raw, { notify = true } = {}) {
    email = label(email); const override = normalizeFingerprintOverride(raw); this.invalidateAccount(email);
    return this.mutate(async () => {
      this.invalidateAccount(email);
      const previous = this.accounts.get(email);
      this.accounts.set(email, { ...previous, override, nextCheckAt: null, lastError: null, concurrencySyncPending: true, prioritySyncPending: true });
      try { await this.persist(); } catch (error) { if (previous) this.accounts.set(email, previous); else this.accounts.delete(email); throw error; }
      if (notify) this.onChange(); this.trigger();
    });
  }
  publicSettings() { return { settings: this.settings, profiles: this.getContext().profiles, runtime: { activeAccounts: this.active.size, queuedAccounts: this.queued.size, maxConcurrentAccounts: this.settings.maxConcurrentAccounts } }; }
  // Apply only the conditional groups in the supplied profile; other groups retain existing behavior.
  filterGroups(email, planType, profileId, groups, currentAccount = null) {
    const rules = this.settings.groupPolicies[profileId] || {};
    const evidence = this.groupResult(email, planType);
    const result = currentAccount && evidence?.routingIdentities?.[currentAccount.id] === fingerprintRoutingIdentity(currentAccount) ? evidence : null;
    const existing = new Set((currentAccount?.group_ids || []).map(String));
    return groups.filter(id => rules[String(id)] !== "verified" || result?.status === "match" || result?.status !== "mismatch" && existing.has(String(id)));
  }
  assertRunnable(email, planType, { manual = false, importRunId } = {}) {
    if (this.isBlocked(email, { manual })) throw Object.assign(new Error("账号已停用或不符合检测条件"), { status: 409 });
    const config = this.effective(email, planType), context = this.getContext();
    if (!config.models.length) throw invalid("请先设置至少一个检测模型");
    if (this.closing) throw Object.assign(new Error("检测服务正在关闭"), { status: 503 });
    if (!context.config?.baseUrl || !context.config?.adminApiKey) throw Object.assign(new Error("请先配置 Sub2API"), { status: 409 });
    return manual || config.enabled || Boolean(importRunId && this.accounts.get(label(email))?.override?.enabled !== false);
  }
  run(email, planType, options = {}) {
    email = label(email);
    if (options.importRunId && this.accounts.get(email)?.lastImportRunId === options.importRunId) {
      return Promise.resolve(this.snapshot(email, planType));
    }
    if (this.inFlight.has(email)) return this.inFlight.get(email);
    if (!this.assertRunnable(email, planType, options)) return Promise.resolve(this.snapshot(email, planType));
    let resolve, reject;
    const operation = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.inFlight.set(email, operation); this.queued.set(email, { email, planType, options, resolve, reject }); this.runningTasks.add(operation);
    void operation.then(() => this.runningTasks.delete(operation), () => this.runningTasks.delete(operation));
    this.drain(); this.onChange();
    return operation;
  }
  drain() {
    if (this.closing) return;
    while (this.active.size < this.settings.maxConcurrentAccounts && this.queued.size) {
      const [email, task] = this.queued.entries().next().value;
      this.queued.delete(email);
      const { manual, importRunId } = task.options;
      const enabled = importRunId ? this.accounts.get(email)?.override?.enabled !== false : this.effective(email, task.planType).enabled;
      if (this.isBlocked(email, task.options) || !manual && (this.stopped || !enabled)) { this.inFlight.delete(email); task.resolve(this.snapshot(email, task.planType)); continue; }
      const operation = this.perform(email, task.planType, task.options);
      const settled = () => { this.inFlight.delete(email); this.drain(); this.onChange(); };
      void operation.then(value => { task.resolve(value); settled(); }, error => { task.reject(error); settled(); });
    }
  }
  async collectModel(context, account, model, method, detector, signal) {
    const outputs = [], sampleFailures = [], requests = [];
    const common = () => ({accountId:String(account.id), ...model, method, sampleFailures, requestCount:requests.length, requests});
    try {
      const challenges = method === 'regex' ? [{ prompt: context.precheck.prompt }]
        : method === 'candy' ? [{prompt:CANDY_PROMPT, expected_answer:21}] : this.challenges(3);
      const maxAttempts = 1 + this.settings.failureRetries;
      for (const [index, challenge] of challenges.entries()) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            signal.throwIfAborted();
            if (this.isBlocked(context.email, { manual: context.manual })) throw new Error("账号已暂停或状态异常，本轮跳过");
            await this.retryDelay(this.settings.failureRetryDelaySeconds * 1000, signal);
            signal.throwIfAborted();
            if (this.isBlocked(context.email, { manual: context.manual })) throw new Error("账号已暂停或状态异常，本轮跳过");
          }
          const minimumCount = method === 'fingerprint' ? Math.max(80,Math.ceil(challenge.expected_count * .55)) : null;
          const request = {sample:index+1, attempt, method, prompt:challenge.prompt, response:null, startedAt:new Date(this.now()).toISOString(), expectedCount:challenge.expected_count ?? null, minimumCount, ...(method === 'candy' ? {expectedAnswer:21, promptSha256:CANDY_PROMPT_SHA256} : {}),
            ...(method === 'regex' ? { pattern: context.precheck.pattern, flags: context.precheck.flags, degradedWhen: context.precheck.degradedWhen } : {}) };
          const started = this.now(); requests.push(request);
          try {
            const text = await this.sample(context.config,account,model.model,challenge.prompt,signal,{onMetadata:metadata=>Object.assign(request,metadata)});
            signal.throwIfAborted();
            Object.assign(request,{response:text,status:'success',durationMs:this.now()-started});
            if (method === 'fingerprint') request.count = parseNumbers(text).length;
            else if (method === 'candy') request.extractedFinalAnswer = gradeCandy(text).extractedFinalAnswer;
            let grade;
            if (method === 'regex') {
              grade = await evaluateRegexPrecheck(text, context.precheck, signal);
              Object.assign(request, { regexMatched: grade.regexMatched, assessmentStatus: grade.status, durationMs: this.now() - started });
            }
            request.accepted = method === 'regex' || (method === 'fingerprint' ? request.count >= minimumCount : request.extractedFinalAnswer !== null);
            if (!request.accepted) {
              const detail = fingerprintFailure({fingerprintFailure:true,code:method === 'fingerprint' ? 'SHORT_OUTPUT' : 'CANDY_UNCLEAR',retryable:method === 'fingerprint'});
              Object.assign(request,{status:'invalid',failure:detail});
              sampleFailures.push({sample:index+1,attempt,...detail});
              if (method === 'fingerprint' && attempt < maxAttempts) continue;
            }
            outputs.push({text,expected_count:challenge.expected_count, ...(grade ? { grade } : {})}); break;
          } catch (error) {
            signal.throwIfAborted();
            const detail = fingerprintFailure(error);
            Object.assign(request,{status:'error',response:typeof error.fingerprintReply === 'string' ? error.fingerprintReply : request.response,failure:detail,accepted:false,durationMs:this.now()-started});
            if (method === 'fingerprint') request.count = request.response === null ? 0 : parseNumbers(request.response).length;
            sampleFailures.push({sample:index+1,attempt,...detail});
            if (!detail.retryable || attempt === maxAttempts || ["AUTH", "BANNED", "QUOTA"].includes(detail.code) || [401, 403, 429].includes(detail.httpStatus)) throw error;
          }
        }
      }
      const validOutputs = method === 'fingerprint' ? outputs.filter(o=>parseNumbers(o.text).length >= Math.max(80,Math.ceil(o.expected_count * .55))).length : 0;
      if (method === 'regex') {
        return { ...common(), ...outputs[0].grade, responseComplete: true, usedOutputs: 1, samplingComplete: true,
          decision: 'scored', assessment: 'configured-regex', pattern: context.precheck.pattern, flags: context.precheck.flags, degradedWhen: context.precheck.degradedWhen };
      }
      if (method === 'fingerprint' && validOutputs < 3) {
        const usedOutputs = validOutputs;
        return {...common(), status:'unknown', reason:`仅获得 ${usedOutputs}/3 份有效检测样本，请查看各样本的实际数字数与期望数量`, usedOutputs, decision:'unscorable', probabilityStatus:'unavailable', samplingComplete:false, samples:outputs.map(o=>({expected:o.expected_count,count:parseNumbers(o.text).length}))};
      }
      if (method === 'candy') {
        const grade = gradeCandy(outputs[0].text);
        return {...common(),...grade, responseComplete:true, usedOutputs:grade.extractedFinalAnswer === null ? 0 : 1, samplingComplete:grade.extractedFinalAnswer !== null, decision:grade.extractedFinalAnswer === null ? 'unscorable' : 'scored'};
      }
      const analysis = detector.analyze(outputs,{strict:true});
      for (const request of requests.filter(r=>r.status === 'success')) {
        const diagnostic = analysis.diagnostics?.[request.sample - 1];
        if (diagnostic) Object.assign(request,{accepted:diagnostic.accepted,minimumCount:diagnostic.minimum_numbers ?? request.minimumCount});
      }
      return {...common(), ...fingerprintEvaluation(analysis,model.expected,context.minProbability), prediction:analysis.prediction || null, predictionName:analysis.prediction_name || null, probability:analysis.probability ?? null, probabilityStatus:analysis.probability_status, decision:analysis.decision, usedOutputs:analysis.used_outputs, samplingComplete:analysis.used_outputs === 3 && requests.filter(r=>r.accepted).length === 3, samples:outputs.map(o=>({expected:o.expected_count,count:parseNumbers(o.text).length})), candidates:(analysis.results || []).slice(0,5).map(r=>({model:r.model,name:r.display_name,probability:r.probability})),referenceBuiltAt:detector.builtAt};
    } catch (error) {
      signal.throwIfAborted();
      const detail = fingerprintFailure(error);
      return {...common(),status:'error',error:detail.message,failure:detail,samplingComplete:false,completedSamples:outputs.length,samples:method === 'fingerprint' ? outputs.map(o=>({expected:o.expected_count,count:parseNumbers(o.text).length})) : []};
    }
  }
  async perform(email, planType, { manual = false, importRunId } = {}) {
    email = label(email);
    if (this.isBlocked(email, { manual })) return this.snapshot(email, planType);
    if (this.active.has(email)) return this.snapshot(email, planType);
    const config = this.effective(email, planType);
    if (!config.models.length) throw invalid("请先设置至少一个检测模型");
    const enabled = importRunId ? this.accounts.get(email)?.override?.enabled !== false : config.enabled;
    if (!manual && !enabled) return this.snapshot(email, planType);
    const source = importRunId ? "import" : manual ? "manual" : "scheduled";
    const context = this.getContext(), backend = context.backend, signature = this.signature(email, planType), revision = this.revision, startedAt = this.now(), step = this.sequence(email,planType);
    let method = config.precheck.enabled ? 'regex' : step.method, precheck = null;
    if (!context.config?.baseUrl || !context.config?.adminApiKey) throw Object.assign(new Error("请先配置 Sub2API"), { status: 409 });
    const controller = new AbortController(); this.active.set(email, controller);
    if (manual) this.manualChecks.add(email);
    const previous = this.accounts.get(email) || { override: normalizeFingerprintOverride() };
    const entry = { ...previous, activeMethod:method, lastAttemptAt: new Date(this.now()).toISOString(), nextCheckAt: new Date(this.now() + config.intervalMinutes * 60000).toISOString(), lastError: null };
    this.accounts.set(email, entry);
    let recoveryFailure = null;
    const results = [];
    try {
      await this.mutate(async () => { controller.signal.throwIfAborted(); await this.persist(); });
      const targets = (await this.listTargets(context.config, { manual })).filter(item => label(item.email) === email);
      if (!targets.length) throw new Error("账号尚未加入 Sub2API 号池");
      const identities = {}, routingIdentities = {};
      const accounts = [];
      for (const target of targets) {
        const account = await this.getAccount(context.config, target.id);
        identities[target.id] = fingerprintAccountIdentity(account);
        routingIdentities[target.id] = fingerprintRoutingIdentity(account);
        if (account.status && account.status !== "active" || account.schedulable === false && !(manual && account.fingerprintCooling === true)) throw new Error("账号已暂停或状态异常，本轮跳过");
        accounts.push(account);
      }
      const collect = async (account, model, detector) => {
        controller.signal.throwIfAborted();
        const result = await this.collectModel({...context,email,manual,minProbability:config.minProbability,precheck:config.precheck},account,model,method,detector,controller.signal);
        results.push(result);
        const detail = result.failure;
        if (detail && (detail.code === 'QUOTA' || detail.httpStatus === 429 || account.type === 'oauth' && fingerprintRecovery(detail))) recoveryFailure = detail;
        return result;
      };
      if (config.precheck.enabled) {
        for (const account of accounts) {
          controller.signal.throwIfAborted();
          if (this.isBlocked(email, { manual })) return this.snapshot(email, planType);
          const result = await collect(account, { model: config.precheck.model }, null);
          if (result.status === 'error') break;
        }
        const status = aggregateFingerprint(results);
        precheck = { status, fallbackMethod: step.method, fallbackExecuted: false, skipFallbackOnPass: config.precheck.skipFallbackOnPass, sequenceAdvanced: false };
        if (status === 'mismatch' || status === 'match' && !config.precheck.skipFallbackOnPass) {
          precheck.models = results.splice(0);
          precheck.fallbackExecuted = true;
          method = step.method; entry.activeMethod = method; this.onChange();
        }
      }
      if (!config.precheck.enabled || precheck.fallbackExecuted) {
        // The reference bank is loaded only when this round actually needs it.
        const detector = method === 'fingerprint' ? await this.detector(controller.signal) : null;
        sampling: for (const account of accounts) {
          for (const model of config.models) {
            controller.signal.throwIfAborted();
            if (this.isBlocked(email, { manual })) return this.snapshot(email, planType);
            await collect(account, model, detector);
            if (recoveryFailure) break sampling;
          }
        }
      }
      controller.signal.throwIfAborted();
      if (revision !== this.revision || backend !== this.getContext().backend) return this.snapshot(email, planType);
      await this.mutate(async () => {
        controller.signal.throwIfAborted();
        if (revision !== this.revision || backend !== this.getContext().backend || this.accounts.get(email) !== entry) return;
        for (const target of targets) {
          if (!Object.hasOwn(identities, target.id)) continue;
          if (identities[target.id] !== fingerprintAccountIdentity(await this.getAccount(context.config, target.id))) throw new Error("检测期间账号配置已变更");
          controller.signal.throwIfAborted();
        }
        // Every completed check consumes one scheduled turn, including a
        // precheck pass that skips fallback. Failed requests keep their slot.
        const sequenceAdvanced = results.length > 0 && results.every(r => r.samplingComplete || method === 'candy' && r.responseComplete);
        if (precheck) precheck.sequenceAdvanced = sequenceAdvanced;
        this.recordResult(entry, { signature, backend, method, ...(precheck ? { precheck } : {}), sequencePosition:method === 'regex' && !sequenceAdvanced ? null : step.position, usage:aggregateRequestUsage(roundModels({precheck,models:results})), identities, routingIdentities, checkedAt: new Date(this.now()).toISOString(), durationMs: this.now() - startedAt, source, status: aggregateFingerprint(results), models: results });
        this.onVerdict(email, entry.result.checkedAt, entry.result.status, entry.result);
        if (importRunId) entry.lastImportRunId = importRunId;
        if (sequenceAdvanced) entry.sequenceCursor = {signature:step.signature,index:(step.index+1)%step.total};
        entry.concurrencySyncPending = true;
        entry.prioritySyncPending = true;
        entry.groupSyncPending = ["match", "mismatch"].includes(entry.result.status);
        entry.groupSyncError = null;
        await this.persist();
      });
      await this.reconcile(email, planType, targets, revision);
    } catch (error) {
      if (!controller.signal.aborted && revision === this.revision) {
        await this.mutate(async () => {
          if (controller.signal.aborted || revision !== this.revision || this.accounts.get(email) !== entry) return;
          const detail = fingerprintFailure(error);
          entry.lastError = detail.message;
          this.recordResult(entry, { signature, backend, method, ...(precheck ? { precheck } : {}), sequencePosition:method === 'regex' ? null : step.position, usage:aggregateRequestUsage(roundModels({precheck,models:results})), checkedAt: new Date(this.now()).toISOString(), durationMs: this.now() - startedAt, source, status: "error", models: results, error: entry.lastError, failure: detail });
          this.onVerdict(email, entry.result.checkedAt, entry.result.status, entry.result);
        if (importRunId) entry.lastImportRunId = importRunId;
          await this.persist();
        });
      }
      if (manual && !controller.signal.aborted) throw Object.assign(new Error(entry.lastError || "指纹检测未完成"), { status: [400, 409].includes(error.status) ? error.status : 502 });
    } finally {
      this.active.delete(email); this.manualChecks.delete(email); this.onChange();
      // Dispatch after releasing sampling/mutation state; recovery may cancel checks.
      if (recoveryFailure && !controller.signal.aborted && revision === this.revision && !this.isBlocked(email)) {
        try { await this.onAccountFailure(email, recoveryFailure); }
        catch {
          entry.lastError = "授权修复未能入队，等待下次检测重试";
          await this.mutate(() => this.persist());
        }
      }
    }
    return this.snapshot(email, planType);
  }
  reconcile(email, planType, targets, revision = this.revision) {
    return this.mutate(() => this.reconcileLocked(email, planType, targets, revision));
  }
  async reconcileLocked(email, planType, targets, revision) {
    await this.observePlanLocked(email, planType);
    await this.reconcileGroupsLocked(email, planType, targets, revision);
    await this.reconcileConcurrencyLocked(email, planType, targets, revision);
    await this.reconcilePoolNumberLocked(email, planType, targets, revision, "priority");
  }
  async reconcileGroupsLocked(email, planType, targets, revision) {
    if (this.isBlocked(email)) return;
    const entry = this.accounts.get(email), result = this.groupResult(email, planType), context = this.getContext();
    if (!["match", "mismatch"].includes(result?.status) || !entry?.groupSyncPending || !this.updateGroups) return;
    try {
      for (const target of targets) {
        const account = await this.getAccount(context.config, target.id);
        if (this.isBlocked(email) || revision !== this.revision || context.backend !== this.getContext().backend || result.signature !== this.signature(email, planType)) return;
        if (result.identities?.[target.id] !== fingerprintAccountIdentity(account)) { entry.groupSyncPending = false; entry.groupSyncError = "账号凭据或代理已变更，请重新检测"; await this.persist(); return; }
        const profileId = target.profileId, profile = context.profiles.find(p => p.id === profileId);
        if (!profile) continue;
        const rules = this.settings.groupPolicies[profileId] || {};
        const current = (account.group_ids || []).map(String), next = new Set(current);
        for (const id of profile.groupIds.map(String)) {
          if (rules[id] === "verified" && result.status !== "match") next.delete(id); else next.add(id);
        }
        const ids = [...next];
        if (JSON.stringify([...current].sort()) !== JSON.stringify([...ids].sort())) await this.updateGroups(context.config, target.id, ids);
      }
      entry.groupSyncPending = false; entry.groupSyncError = null;
    } catch { entry.groupSyncError = "检测结果已保存，条件分组同步失败；稍后自动重试"; }
    await this.persist();
    this.onChange();
  }
  poolNumberState(email, planType, backend = this.getContext().backend) {
    const entry = this.accounts.get(label(email));
    const knownPlan = value => value && label(value) !== "unknown" ? label(value) : null;
    const plan = knownPlan(planType) || knownPlan(this.getContext().jobs?.find(job => label(job.email) === label(email))?.planType)
      || entry?.poolNumberPlanType || "unknown";
    const verdict = entry?.poolNumberVerdict || this.latestRounds(entry).find(round => ["match", "mismatch"].includes(round.status))?.status || null;
    return { planType: plan, verdict, backend };
  }
  manualPoolEditActive(guard, state) {
    return Boolean(guard && guard.backend === state.backend && !guard.invalidated
      && guard.planType === state.planType && guard.verdict === state.verdict);
  }
  observePlan(email, planType) {
    return this.mutate(() => this.observePlanLocked(email, planType));
  }
  async observePlanLocked(email, planType, backend = this.getContext().backend) {
    const entry = this.accounts.get(label(email));
    if (!entry || !planType || label(planType) === "unknown") return;
    const previous = structuredClone(entry);
    let changed = entry.poolNumberPlanType !== label(planType);
    for (const field of Object.keys(poolNumberPolicies)) for (const guard of Object.values(entry[`${field}ManualEdits`] || {})) {
      if (guard.backend === backend && guard.planType !== label(planType) && !guard.invalidated) {
        guard.invalidated = true; entry[`${field}SyncPending`] = true; changed = true;
      }
    }
    entry.poolNumberPlanType = label(planType);
    if (changed) {
      try { await this.persist(); }
      catch (error) { this.accounts.set(label(email), previous); throw error; }
    }
  }
  reconcileConcurrencyLocked(email, planType, targets, revision) {
    return this.reconcilePoolNumberLocked(email, planType, targets, revision, "concurrency");
  }
  markPoolNumbersPending(email) {
    const emailKey = email && label(email);
    for (const job of this.getPoolNumberJobs?.() || this.getContext().jobs || []) {
      if (!emailKey || label(job.email) === emailKey) this.markIndependentPoolNumbersPending(job);
    }
    const entries = emailKey ? [this.accounts.get(emailKey)] : this.accounts.values();
    for (const entry of entries) {
      if (!entry) continue;
      for (const field of poolNumberFields) {
        if (Object.keys(entry[`${field}Overrides`] || {}).length || entry.result) {
          entry[`${field}SyncPending`] = true;
        }
      }
    }
  }
  markIndependentPoolNumbersPending(job) {
    const email = label(job.email);
    let entry = this.accounts.get(email);
    for (const field of poolNumberFields) {
      const policy = this.getPoolNumberPolicy?.(email, job.planType, field);
      if (!policy?.independent || !policy.enabled) continue;
      if (!entry) {
        entry = { override: normalizeFingerprintOverride() };
        this.accounts.set(email, entry);
      }
      entry[`${field}SyncPending`] = true;
    }
    return entry;
  }
  refreshPoolNumbers(email) {
    return this.mutate(async () => {
      this.markPoolNumbersPending(email);
    }).then(() => {
      if (this.ticking) void this.ticking.then(() => this.trigger());
      else this.trigger();
    });
  }
  async reconcilePoolNumberLocked(email, planType, targets, revision, field) {
    if (this.isBlocked(email)) return;
    const entry = this.accounts.get(email), result = this.groupResult(email, planType), context = this.getContext();
    const descriptor = poolNumberPolicies[field], update = this[descriptor.update];
    const pendingKey = `${field}SyncPending`, errorKey = `${field}SyncError`;
    if (!entry?.[pendingKey] || !update) return;
    const legacyPolicy = this.settings[descriptor.setting];
    const configured = this.getPoolNumberPolicy?.(email, planType, field, result?.status);
    // A skipped case leaves the observed value and its existing ownership intact.
    if (configured?.skip) {
      entry[pendingKey] = false;
      entry[errorKey] = null;
      await this.persist();
      this.onChange();
      return;
    }
    const enabled = configured ? configured.enabled : Boolean(legacyPolicy?.enabled && this.effective(email, planType).enabled);
    const value = configured ? configured.value : result?.status === "match" ? legacyPolicy?.value : null;
    const definitive = result?.status === "match" || result?.status === "mismatch";
    const actionable = configured?.independent || definitive;
    const restore = !enabled || (configured ? actionable && value === null : result?.status === "mismatch" || !result);
    if (configured?.independent && enabled && !targets.length) return;
    const overrides = entry[`${field}Overrides`] ||= {};
    const externalEdits = entry[`${field}ExternalEdits`] ||= {};
    const manualEdits = entry[`${field}ManualEdits`] ||= {};
    const state = this.poolNumberState(email, planType);
    try {
      for (const target of targets) {
        let owned = overrides[target.id];
        let manual = manualEdits[target.id];
        if (this.manualPoolEditActive(manual, state)) continue;
        if (manual && manual.backend === context.backend) {
          // Releasing a manual exception re-enters the current plan policy.
          // Resolve current defaults so edits to the profile while protected
          // become the baseline after the exception ends.
          if (owned) {
            const defaults = await this.getPoolNumberDefaults?.(email, target.id, state.planType);
            if (descriptor.valid(defaults?.[field])) owned.baseValue = defaults[field];
          }
          delete manualEdits[target.id]; delete externalEdits[target.id];
        }
        if (owned && owned.backend !== context.backend) continue;
        if (!owned && !manual && !Object.hasOwn(externalEdits, target.id) && (!enabled || !descriptor.valid(value) || !actionable)) continue;
        const leavingIndependentRule = Boolean(owned?.independent && !configured?.independent);
        const restoreTarget = restore || (leavingIndependentRule && !actionable);
        const readAccount = configured?.independent || leavingIndependentRule && restoreTarget ? this.getPoolAccount : this.getAccount;
        const account = await readAccount(context.config, target.id);
        if (this.isBlocked(email) || revision !== this.revision || context.backend !== this.getContext().backend) return;
        if (!account) continue;
        const current = account[field];
        if (!descriptor.valid(current)) throw new Error(`账号${descriptor.label}值不可用`);
        // A write may have succeeded before a crash. Its intent was persisted
        // first; the next read safely confirms it or retries from the old value.
        if (owned && current !== owned.appliedValue && !(owned.pending && current === owned.previousValue)) {
          manualEdits[target.id] = { ...state, value: current };
          entry.poolNumberVerdict ??= state.verdict;
          owned.appliedValue = current; owned.pending = false;
          delete externalEdits[target.id];
          continue;
        }
        if (!manual && Object.hasOwn(externalEdits, target.id)) {
          manualEdits[target.id] = { ...state, value: current };
          entry.poolNumberVerdict ??= state.verdict;
          delete externalEdits[target.id];
          continue;
        }
        if (restoreTarget) {
          if (owned) {
            const defaults = configured && await this.getPoolNumberDefaults?.(email, target.id, state.planType);
            const baseValue = descriptor.valid(defaults?.[field]) ? defaults[field] : owned.baseValue;
            if (current !== baseValue) await update(context.config, target.id, baseValue);
            delete overrides[target.id];
            await this.persist();
          }
          continue;
        }
        if (!actionable || !descriptor.valid(value)) continue;
        if (!configured?.independent && result.identities?.[target.id] !== fingerprintAccountIdentity(account)) continue;
        if (current === value && (!owned || !owned.pending && Boolean(owned.independent) === Boolean(configured?.independent))) continue;
        const intent = { planType: state.planType, baseValue: owned?.baseValue ?? current, appliedValue: value, previousValue: current, backend: context.backend, independent: Boolean(configured?.independent), pending: true };
        overrides[target.id] = intent;
        await this.persist();
        if (current !== value) await update(context.config, target.id, value);
        intent.pending = false;
        await this.persist();
      }
      entry[pendingKey] = false; entry[errorKey] = null;
    } catch { entry[errorKey] = `检测结果已保存，${descriptor.label}同步失败；稍后自动重试`; }
    await this.persist();
    this.onChange();
  }
  // A manual value survives polling, repeated equal verdicts, profile changes,
  // OAuth refreshes and restarts. Only a plan or definitive verdict transition
  // releases that field's exception; transport failures are not transitions.
  manualConcurrency(email, operation, options) {
    return this.manualPoolNumber(email, "concurrency", operation, options);
  }
  manualPriority(email, operation, options) {
    return this.manualPoolNumber(email, "priority", operation, options);
  }
  manualPoolNumber(email, field, operation, options = {}) {
    return this.mutate(async () => {
      email = label(email);
      const context = this.getContext();
      const state = this.poolNumberState(email, options.planType, options.backend || context.backend);
      let entry = this.accounts.get(email), recording = Promise.resolve();
      return operation(id => {
        const task = recording.catch(() => {}).then(async () => {
          const account = await this.getPoolAccount(options.config || context.config, id);
          const value = options.value ?? account[field];
          if (!Number.isInteger(value) || value < 0 || value > 10000) throw invalid("账号数值必须为 0–10000 的整数");
          const previous = entry ? structuredClone(entry) : null;
          if (!entry) { entry = { override: normalizeFingerprintOverride() }; this.accounts.set(email, entry); }
          try {
            const overrides = entry[`${field}Overrides`] ||= {}, owned = overrides[id];
            const defaults = await this.getPoolNumberDefaults?.(email, id, state.planType);
            const baseValue = owned?.backend === state.backend ? owned.baseValue : Number.isInteger(defaults?.[field]) ? defaults[field] : account[field];
            overrides[id] = { planType: state.planType, baseValue, appliedValue: value, previousValue: account[field], backend: state.backend, pending: true };
            (entry[`${field}ManualEdits`] ||= {})[id] = { ...state, value };
            delete (entry[`${field}ExternalEdits`] ||= {})[id];
            entry.poolNumberPlanType = state.planType;
            entry.poolNumberVerdict ??= state.verdict;
            await this.persist();
          } catch (error) {
            if (previous) { entry = previous; this.accounts.set(email, entry); }
            else { entry = null; this.accounts.delete(email); }
            throw error;
          }
        });
        recording = task;
        return task;
      });
    });
  }
  poolAccountUpdate(email, id, backend, body, write, { updateBase = false, planType } = {}) {
    const fields = Object.keys(poolNumberPolicies).filter(field => Object.hasOwn(body, field));
    const existing = this.accounts.get(label(email));
    const hasManualEdits = Object.keys(poolNumberPolicies).some(field => Object.values(existing?.[`${field}ManualEdits`] || {}).some(guard => guard.backend === backend));
    if (!hasManualEdits && !fields.some(field => this.settings[poolNumberPolicies[field].setting]?.enabled || existing?.[`${field}Overrides`]?.[id]
      || Object.hasOwn(existing?.[`${field}ExternalEdits`] || {}, id))) return write(body);
    return this.mutate(async () => {
      const entry = this.accounts.get(label(email)), next = { ...body };
      const state = this.poolNumberState(email, planType, backend);
      await this.observePlanLocked(email, state.planType, backend);
      let account;
      for (const field of fields) {
        const manualEdits = entry?.[`${field}ManualEdits`] || {};
        let manual = manualEdits[id];
        if (!manual && Object.hasOwn(entry?.[`${field}ExternalEdits`] || {}, id)) {
          account ||= await this.getPoolAccount(this.getContext().config, id);
          manual = (entry[`${field}ManualEdits`] ||= {})[id] = { ...state, value: account[field] };
          entry.poolNumberVerdict ??= state.verdict;
          delete entry[`${field}ExternalEdits`][id];
          await this.persist();
        }
        if (this.manualPoolEditActive(manual, state)) { delete next[field]; continue; }
        if (manual && manual.backend === backend) {
          delete manualEdits[id]; delete (entry[`${field}Overrides`] || {})[id];
          delete (entry[`${field}ExternalEdits`] || {})[id];
          await this.persist();
        }
        const owned = entry?.[`${field}Overrides`]?.[id];
        if (!owned || owned.backend !== backend) continue;
        if (owned.planType && owned.planType !== state.planType) {
          delete entry[`${field}Overrides`][id]; await this.persist(); continue;
        }
        account ||= await this.getAccount(this.getContext().config, id);
        if (account[field] !== owned.appliedValue && !(owned.pending && account[field] === owned.previousValue)) {
          (entry[`${field}ManualEdits`] ||= {})[id] = { ...state, value: account[field] };
          entry.poolNumberVerdict ??= state.verdict;
          owned.appliedValue = account[field]; owned.pending = false;
          await this.persist(); delete next[field]; continue;
        }
        if (updateBase && poolNumberPolicies[field].valid(body[field]) && owned.baseValue !== body[field]) {
          owned.baseValue = body[field]; await this.persist();
        }
        next[field] = owned.appliedValue;
      }
      return Object.keys(next).length ? write(next) : undefined;
    });
  }
  setTickMs(ms) {
    this.tickMs = ms;
    if (this.timer) { clearInterval(this.timer); this.timer = setInterval(() => this.trigger(), ms); this.timer.unref?.(); }
  }
  start() { this.closing = false; this.stopped = false; if (this.getPoolNumberPolicy) this.markPoolNumbersPending(); this.timer = setInterval(() => this.trigger(), this.tickMs || 60000); this.timer.unref?.(); this.trigger(); }
  trigger() { if (!this.stopped && !this.ticking) this.ticking = this.tick().catch(() => {}).finally(() => { this.ticking = null; }); }
  async tick() {
    if (this.dispatchPaused()) return;
    const context = this.getContext(), scheduled = [];
    let targetsByEmail;
    for (const job of context.jobs) {
      if (this.stopped || this.dispatchPaused()) break;
      if (this.isBlocked(job.email)) continue;
      if (this.inFlight.has(label(job.email))) continue;
      const state = this.snapshot(job.email, job.planType);
      let entry = this.accounts.get(label(job.email));
      if (entry?.poolNumberPlanType !== label(job.planType)) entry = this.markIndependentPoolNumbersPending(job);
      if (entry?.groupSyncPending || poolNumberFields.some(field => entry?.[`${field}SyncPending`])) {
        if (!targetsByEmail) {
          targetsByEmail = new Map();
          for (const target of await this.listTargets(context.config)) {
            const email = label(target.email);
            if (!targetsByEmail.has(email)) targetsByEmail.set(email, []);
            targetsByEmail.get(email).push(target);
          }
        }
        const email = label(job.email);
        await this.reconcile(email, job.planType, targetsByEmail.get(email) || []);
      }
      if (job.importCheckPending || !state.enabled || !state.models.length) continue;
      if (!state.nextCheckAt || Date.parse(state.nextCheckAt) <= this.now()) { const task = this.run(job.email, job.planType); void task.catch(() => {}); scheduled.push(task); }
    }
    await Promise.allSettled(scheduled);
  }
  remove(email) { this.invalidateAccount(email); return this.mutate(async () => { this.accounts.delete(label(email)); await this.persist(); }); }
  async stop() { this.closing = true; this.stopped = true; clearInterval(this.timer); this.invalidate(); await Promise.allSettled([...this.runningTasks, this.ticking, this.mutationPromise].filter(Boolean)); await this.writePromise; }
}
