import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { generateChallenges, loadDetector, parseNumbers } from "lmfpd-sdk";

const invalid = message => Object.assign(new Error(message), { status: 400 });
export const DEFAULT_FINGERPRINT_SETTINGS = Object.freeze({ models: [], intervalMinutes: 360, minProbability: 0.8, planDefaults: {}, groupPolicies: {} });
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
  if (typeof raw.minProbability === "boolean" || !Number.isFinite(minProbability) || minProbability < 0.5 || minProbability > 1) throw invalid("指纹归因阈值必须为 0.5–1");
  const planDefaults = Object.create(null), groupPolicies = Object.create(null);
  for (const [key, value] of Object.entries(raw.planDefaults || {})) {
    if (!key.trim() || key.length > 160 || typeof value !== "boolean") throw invalid("PlanType 指纹检测规则无效");
    planDefaults[key.toLowerCase()] = value;
  }
  for (const [profile, rules] of Object.entries(raw.groupPolicies || {})) {
    if (!profile || profile.length > 128 || !rules || typeof rules !== "object" || Array.isArray(rules)) throw invalid("指纹分组规则无效");
    groupPolicies[profile] = Object.create(null);
    for (const [id, mode] of Object.entries(rules)) {
      if (!/^\d+$/.test(id) || !["default", "verified"].includes(mode)) throw invalid("指纹分组规则无效");
      groupPolicies[profile][id] = mode;
    }
  }
  return { models, intervalMinutes: interval(raw.intervalMinutes ?? 360), minProbability, planDefaults, groupPolicies };
}
export function normalizeFingerprintOverride(raw = {}) {
  if (raw.enabled != null && typeof raw.enabled !== "boolean") throw invalid("账号检测开关必须为布尔值或继承");
  return { enabled: raw.enabled ?? null, models: raw.models == null ? null : normalizeFingerprintModels(raw.models), intervalMinutes: raw.intervalMinutes == null ? null : interval(raw.intervalMinutes) };
}
const label = value => String(value || "").trim().toLowerCase();
export const fingerprintAccountIdentity = account => crypto.createHash("sha256").update(JSON.stringify({ id: String(account.id), type: account.type, parent: account.parent_account_id, proxy: account.proxy_id ?? 0, proxyUrl: account.fingerprintProxyUrl, credentials: account.credentials || {} })).digest("hex");
const fingerprintRoutingIdentity = account => crypto.createHash("sha256").update(JSON.stringify({ id: String(account.id), type: account.type, parent: account.parent_account_id, proxy: account.proxy_id ?? 0, version: account.credentials?._token_version, account: account.credentials?.chatgpt_account_id, user: account.credentials?.chatgpt_user_id, mapping: account.credentials?.model_mapping })).digest("hex");
export function fingerprintVerdict(analysis, expected, threshold) {
  if (analysis?.decision !== "scored" || analysis.used_outputs !== 3 || analysis.probability_status !== "reference_calibrated" || !Number.isFinite(analysis.probability) || analysis.probability < threshold || !analysis.prediction || !analysis.results?.some(r => label(r.model) === label(expected) || label(r.display_name) === label(expected))) return "unknown";
  return label(analysis.prediction) === label(expected) || label(analysis.prediction_name) === label(expected) ? "match" : "mismatch";
}
export function aggregateFingerprint(results) {
  if (!results.length || results.some(item => item.status === "unknown" || item.status === "error")) return "unknown";
  return results.some(item => item.status === "mismatch") ? "mismatch" : "match";
}

// The reference data is public; only data files are downloaded. Replies are scored locally.
export class ModelFingerprintService {
  constructor({ filePath, getContext, listTargets, getAccount, sample, updateGroups, onChange = () => {}, now = Date.now, detectorLoader, challenges = generateChallenges }) {
    Object.assign(this, { filePath, getContext, listTargets, getAccount, sample, updateGroups, onChange, now, challenges });
    this.settings = normalizeFingerprintSettings(); this.accounts = new Map(); this.active = new Map(); this.runningTasks = new Set(); this.writePromise = Promise.resolve(); this.mutationPromise = Promise.resolve(); this.revision = 0; this.stopped = true;
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
  invalidate() { this.revision++; for (const controller of this.active.values()) controller.abort(); }
  async referenceInfo() {
    const detector = await this.detector();
    // The SDK exposes labels on analysis results, not as an enumeration method.
    // These local synthetic inputs enumerate candidates only; they are never saved as account evidence.
    const analysis = detector.analyze(Array.from({ length: 3 }, (_, j) => ({ text: Array.from({ length: 300 }, (_, i) => (i * 37 + j * 13) % 355 + 1).join(", "), expected_count: 300 })), { strict: true });
    return { builtAt: detector.builtAt, models: analysis.results.map(r => ({ id: r.model, name: r.display_name })).sort((a, b) => a.id.localeCompare(b.id)) };
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1) throw new Error("版本无效");
      this.settings = normalizeFingerprintSettings(data.settings);
      for (const [email, entry] of Object.entries(data.accounts || {})) this.accounts.set(email, { ...entry, override: normalizeFingerprintOverride(entry.override), phase: "idle" });
    } catch (error) { if (error.code !== "ENOENT") throw new Error(`模型指纹配置读取失败：${error.message}`); }
  }
  persist() {
    const text = JSON.stringify({ version: 1, settings: this.settings, accounts: Object.fromEntries(this.accounts) }, null, 2);
    const operation = this.writePromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temp, text + "\n", { mode: 0o600 }); await fs.rename(temp, this.filePath); }
      finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    }); this.writePromise = operation; return operation;
  }
  effective(email, planType = "") {
    const override = this.accounts.get(label(email))?.override || {};
    return { enabled: override.enabled ?? this.settings.planDefaults[label(planType)] ?? false, models: override.models ?? this.settings.models, intervalMinutes: override.intervalMinutes ?? this.settings.intervalMinutes, minProbability: this.settings.minProbability };
  }
  signature(email, planType) { const { models, minProbability } = this.effective(email, planType); return JSON.stringify({ models, minProbability, planType: label(planType), backend: this.getContext().backend, routing: this.getContext().routing }); }
  snapshot(email, planType = "") {
    const entry = this.accounts.get(label(email));
    const current = entry?.result?.signature === this.signature(email, planType);
    return { ...this.effective(email, planType), override: entry?.override || { enabled: null, models: null, intervalMinutes: null }, phase: this.active.has(label(email)) ? "running" : "idle", result: current ? entry?.result || null : null, previousResult: !current ? entry?.result || null : null, nextCheckAt: entry?.nextCheckAt || null, lastError: entry?.lastError || null, groupSyncError: entry?.groupSyncError || null };
  }
  saveSettings(raw) {
    const next = normalizeFingerprintSettings(raw); this.invalidate();
    return this.mutate(async () => {
      this.invalidate();
      const previous = this.settings, previousAccounts = this.accounts;
      const changedSampling = JSON.stringify([previous.models, previous.minProbability, previous.intervalMinutes, previous.planDefaults]) !== JSON.stringify([next.models, next.minProbability, next.intervalMinutes, next.planDefaults]);
      this.settings = next;
      this.accounts = new Map([...this.accounts].map(([email, entry]) => [email, { ...entry, nextCheckAt: changedSampling ? null : entry.nextCheckAt, groupSyncPending: true }]));
      try { await this.persist(); } catch (error) { this.settings = previous; this.accounts = previousAccounts; throw error; }
      this.onChange(); this.trigger(); return this.publicSettings();
    });
  }
  saveOverride(email, raw) {
    email = label(email); const override = normalizeFingerprintOverride(raw); this.invalidate();
    return this.mutate(async () => {
      this.invalidate();
      const previous = this.accounts.get(email);
      this.accounts.set(email, { ...previous, override, nextCheckAt: null, lastError: null });
      try { await this.persist(); } catch (error) { if (previous) this.accounts.set(email, previous); else this.accounts.delete(email); throw error; }
      this.onChange(); this.trigger();
    });
  }
  publicSettings() { return { settings: this.settings, profiles: this.getContext().profiles }; }
  // Apply only the conditional groups in the supplied profile; other groups retain existing behavior.
  filterGroups(email, planType, profileId, groups, currentAccount = null) {
    const rules = this.settings.groupPolicies[profileId] || {};
    const state = this.snapshot(email, planType);
    const result = currentAccount && state.result?.routingIdentities?.[currentAccount.id] === fingerprintRoutingIdentity(currentAccount) ? state.result : null;
    const existing = new Set((currentAccount?.group_ids || []).map(String));
    return groups.filter(id => rules[String(id)] !== "verified" || result?.status === "match" || result?.status !== "mismatch" && existing.has(String(id)));
  }
  assertRunnable(email, planType, { manual = false } = {}) {
    const config = this.effective(email, planType), context = this.getContext();
    if (!config.models.length) throw invalid("请先设置至少一个检测模型");
    if (this.active.size) throw Object.assign(new Error("已有账号正在进行指纹检测，请稍后重试"), { status: 409 });
    if (!context.config?.baseUrl || !context.config?.adminApiKey) throw Object.assign(new Error("请先配置 Sub2API"), { status: 409 });
    return manual || config.enabled;
  }
  run(email, planType, options) {
    this.assertRunnable(email, planType, options);
    const operation = this.perform(email, planType, options); this.runningTasks.add(operation);
    void operation.then(() => this.runningTasks.delete(operation), () => this.runningTasks.delete(operation));
    return operation;
  }
  async perform(email, planType, { manual = false } = {}) {
    email = label(email);
    if (this.active.has(email)) return this.snapshot(email, planType);
    const config = this.effective(email, planType);
    if (!config.models.length) throw invalid("请先设置至少一个检测模型");
    if (!manual && !config.enabled) return this.snapshot(email, planType);
    if (this.active.size) throw Object.assign(new Error("已有账号正在进行指纹检测，请稍后重试"), { status: 409 });
    const context = this.getContext(), backend = context.backend, signature = this.signature(email, planType), revision = this.revision;
    if (!context.config?.baseUrl || !context.config?.adminApiKey) throw Object.assign(new Error("请先配置 Sub2API"), { status: 409 });
    const controller = new AbortController(); this.active.set(email, controller);
    const previous = this.accounts.get(email) || { override: normalizeFingerprintOverride() };
    const entry = { ...previous, lastAttemptAt: new Date(this.now()).toISOString(), nextCheckAt: new Date(this.now() + config.intervalMinutes * 60000).toISOString(), lastError: null };
    this.accounts.set(email, entry);
    try {
      await this.mutate(async () => { controller.signal.throwIfAborted(); await this.persist(); });
      const targets = (await this.listTargets(context.config)).filter(item => label(item.email) === email);
      if (!targets.length) throw new Error("账号尚未加入 Sub2API 号池");
      const detector = await this.detector(controller.signal);
      const results = [], identities = {}, routingIdentities = {};
      for (const target of targets) {
        const account = await this.getAccount(context.config, target.id);
        identities[target.id] = fingerprintAccountIdentity(account);
        routingIdentities[target.id] = fingerprintRoutingIdentity(account);
        if (account.status && account.status !== "active" || account.schedulable === false) throw new Error("账号已暂停或状态异常，本轮跳过");
        for (const model of config.models) {
          controller.signal.throwIfAborted();
          const outputs = [];
          try {
            for (const challenge of this.challenges(3)) {
              const text = await this.sample(context.config, account, model.model, challenge.prompt, controller.signal);
              outputs.push({ text, expected_count: challenge.expected_count });
            }
            const analysis = detector.analyze(outputs, { strict: true });
            results.push({ accountId: String(target.id), model: model.model, expected: model.expected, status: fingerprintVerdict(analysis, model.expected, config.minProbability), prediction: analysis.prediction || null, predictionName: analysis.prediction_name || null, probability: analysis.probability ?? null, decision: analysis.decision, usedOutputs: analysis.used_outputs, samples: outputs.map(o => ({ expected: o.expected_count, count: parseNumbers(o.text).length })), candidates: analysis.results.slice(0, 5).map(r => ({ model: r.model, name: r.display_name, probability: r.probability })), referenceBuiltAt: detector.builtAt });
          } catch (error) {
            controller.signal.throwIfAborted();
            results.push({ accountId: String(target.id), ...model, status: "error", error: "模型请求失败或响应不完整，请检查账号、模型和代理" });
          }
        }
      }
      controller.signal.throwIfAborted();
      if (revision !== this.revision || backend !== this.getContext().backend) return this.snapshot(email, planType);
      await this.mutate(async () => {
        controller.signal.throwIfAborted();
        if (revision !== this.revision || backend !== this.getContext().backend || this.accounts.get(email) !== entry) return;
        for (const target of targets) {
          if (identities[target.id] !== fingerprintAccountIdentity(await this.getAccount(context.config, target.id))) throw new Error("检测期间账号配置已变更");
          controller.signal.throwIfAborted();
        }
        entry.result = { signature, backend, identities, routingIdentities, checkedAt: new Date(this.now()).toISOString(), status: aggregateFingerprint(results), models: results };
        entry.groupSyncPending = true; await this.persist();
      });
      await this.reconcile(email, planType, targets, revision);
    } catch (error) {
      if (!controller.signal.aborted && revision === this.revision) {
        await this.mutate(async () => {
          if (controller.signal.aborted || revision !== this.revision || this.accounts.get(email) !== entry) return;
          entry.lastError = [400, 409].includes(error.status) ? error.message : "检测未完成：请检查参考库、账号、模型和网络";
          entry.result = { signature, backend, checkedAt: new Date(this.now()).toISOString(), status: "unknown", models: [] };
          await this.persist();
        });
      }
      if (manual && !controller.signal.aborted) throw Object.assign(new Error(entry.lastError || "指纹检测未完成"), { status: [400, 409].includes(error.status) ? error.status : 502 });
    } finally { this.active.delete(email); this.onChange(); }
    return this.snapshot(email, planType);
  }
  reconcile(email, planType, targets, revision = this.revision) {
    return this.mutate(() => this.reconcileLocked(email, planType, targets, revision));
  }
  async reconcileLocked(email, planType, targets, revision) {
    const entry = this.accounts.get(email), state = this.snapshot(email, planType), context = this.getContext();
    if (!state.result || state.result.status === "unknown" || !entry.groupSyncPending) return;
    try {
      for (const target of targets) {
        const account = await this.getAccount(context.config, target.id);
        if (revision !== this.revision || state.result.signature !== this.signature(email, planType)) return;
        if (state.result.identities?.[target.id] !== fingerprintAccountIdentity(account)) { entry.groupSyncPending = false; entry.groupSyncError = "账号凭据或代理已变更，请重新检测"; await this.persist(); return; }
        const profileId = target.profileId, profile = context.profiles.find(p => p.id === profileId);
        if (!profile) continue;
        const rules = this.settings.groupPolicies[profileId] || {};
        const current = (account.group_ids || []).map(String), next = new Set(current);
        for (const id of profile.groupIds.map(String)) {
          if (rules[id] === "verified" && state.result.status !== "match") next.delete(id); else next.add(id);
        }
        const ids = [...next];
        if (JSON.stringify([...current].sort()) !== JSON.stringify([...ids].sort())) await this.updateGroups(context.config, target.id, ids);
      }
      entry.groupSyncPending = false; entry.groupSyncError = null;
    } catch { entry.groupSyncError = "检测结果已保存，条件分组同步失败；稍后自动重试"; }
    await this.persist();
  }
  start() { this.stopped = false; this.timer = setInterval(() => this.trigger(), 60000); this.timer.unref?.(); this.trigger(); }
  trigger() { if (!this.stopped && !this.ticking) this.ticking = this.tick().catch(() => {}).finally(() => { this.ticking = null; }); }
  async tick() {
    const context = this.getContext();
    for (const job of context.jobs) {
      if (this.stopped || this.active.size) break;
      const state = this.snapshot(job.email, job.planType), entry = this.accounts.get(label(job.email));
      if (entry?.groupSyncPending && state.result && state.result.status !== "unknown") {
        const targets = (await this.listTargets(context.config)).filter(t => label(t.email) === label(job.email));
        await this.reconcile(label(job.email), job.planType, targets);
      }
      if (!state.enabled || !state.models.length) continue;
      if (!state.nextCheckAt || Date.parse(state.nextCheckAt) <= this.now()) await this.run(job.email, job.planType);
    }
  }
  remove(email) { this.invalidate(); return this.mutate(async () => { this.accounts.delete(label(email)); await this.persist(); }); }
  async stop() { this.stopped = true; clearInterval(this.timer); this.invalidate(); await Promise.allSettled([...this.runningTasks, this.ticking, this.mutationPromise].filter(Boolean)); await this.writePromise; }
}
