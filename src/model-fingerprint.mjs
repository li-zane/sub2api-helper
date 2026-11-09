import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { generateChallenges, loadDetector, parseNumbers } from "lmfpd-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { fingerprintFailure, fingerprintRecovery } from "./model-fingerprint-request.mjs";
import { CANDY_PROMPT, CANDY_PROMPT_SHA256, gradeCandy, DEFAULT_TEST_SEQUENCE, normalizeTestSequence, sequenceStep, aggregateRequestUsage } from "./candy-test.mjs";

const invalid = message => Object.assign(new Error(message), { status: 400 });
export const DEFAULT_FINGERPRINT_SETTINGS = Object.freeze({ models: [], intervalMinutes: 360, maxConcurrentAccounts: 3, minProbability: 0.8, testSequence: DEFAULT_TEST_SEQUENCE, planDefaults: {}, groupPolicies: {} });
const HISTORY_WINDOW_MS = 60 * 60_000;
const roundSummary = record => record ? { ...record, models: record.models?.map(({ requests, ...model }) => model) } : null;
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
  if (typeof raw.maxConcurrentAccounts === "boolean" || !Number.isInteger(maxConcurrentAccounts) || maxConcurrentAccounts < 1 || maxConcurrentAccounts > 16) throw invalid("同时检测账号数量必须为 1–16 的整数");
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
  return { models, intervalMinutes: interval(raw.intervalMinutes ?? 360), maxConcurrentAccounts, minProbability, testSequence: normalizeTestSequence(raw.testSequence), planDefaults, groupPolicies };
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
  constructor({ filePath, getContext, listTargets, getAccount, sample, updateGroups, isBlocked = () => false, onChange = () => {}, onAccountFailure = async () => {}, now = Date.now, detectorLoader, challenges = generateChallenges }) {
    Object.assign(this, { filePath, getContext, listTargets, getAccount, sample, updateGroups, isBlocked, onChange, onAccountFailure, now, challenges });
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
      for (const [email, entry] of Object.entries(data.accounts || {})) this.accounts.set(email, { ...entry, override: normalizeFingerprintOverride(entry.override), recentResults: this.latestRounds(entry), result: roundSummary(entry.result), phase: "idle" });
      // Persist pruning immediately, including legacy histories that previously kept 200 rounds.
      await this.persist();
    } catch (error) { if (error.code !== "ENOENT") throw new Error(`模型指纹配置读取失败：${error.message}`); }
  }
  persist() {
    for (const entry of this.accounts.values()) { entry.recentResults = this.latestRounds(entry); entry.result = roundSummary(entry.result); delete entry.history; }
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
    return { enabled: override.enabled ?? this.settings.planDefaults[label(planType)] ?? false, models: override.models ?? this.settings.models, intervalMinutes: override.intervalMinutes ?? this.settings.intervalMinutes, minProbability: this.settings.minProbability, testSequence: override.testSequence ?? this.settings.testSequence };
  }
  sequence(email, planType) {
    const { testSequence } = this.effective(email, planType);
    const signature = JSON.stringify([this.signature(email, planType), testSequence]);
    const saved = this.accounts.get(label(email))?.sequenceCursor;
    return { ...sequenceStep(testSequence, saved?.signature === signature ? saved.index : 0), signature };
  }
  attribution(email, planType) {
    const entry = this.accounts.get(label(email));
    const result = entry?.fingerprintResult || (entry?.result?.method !== 'candy' ? entry?.result : null);
    return result?.signature === this.signature(email, planType) ? result : null;
  }
  signature(email, planType) { const { models, minProbability } = this.effective(email, planType); return JSON.stringify({ models, minProbability, planType: label(planType), backend: this.getContext().backend, routing: this.getContext().routing }); }
  snapshot(email, planType = "") {
    email = label(email);
    const entry = this.accounts.get(label(email));
    const current = entry?.result?.signature === this.signature(email, planType);
    const config = this.effective(email, planType), queued = this.queued.has(email);
    const { signature: _signature, index: _index, ...sequence } = this.sequence(email, planType);
    return { ...config, sequence, runningMethod: this.active.has(email) ? entry?.activeMethod : null, override: entry?.override || { enabled: null, models: null, intervalMinutes: null, testSequence: null }, phase: this.active.has(email) ? "running" : queued ? "queued" : "idle", queuePosition: queued ? [...this.queued.keys()].indexOf(email) + 1 : null, recentResults: this.latestRounds(entry).map(({ checkedAt, status, method }) => ({ checkedAt, status, method: method || 'fingerprint' })), historyCountLastHour: this.recentHistory(entry).length, lastAttemptAt: entry?.lastAttemptAt || null, result: current ? roundSummary(entry?.result) : null, previousResult: !current ? roundSummary(entry?.result) : null, nextCheckAt: entry?.nextCheckAt || null, lastError: entry?.lastError || null, groupSyncError: entry?.groupSyncError || null };
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
  historyRecord(result) { return { id: result.id, method: result.method || 'fingerprint', sequencePosition: result.sequencePosition, usage: result.usage, transcriptVersion: result.transcriptVersion, requestCount: result.requestCount, checkedAt: result.checkedAt, status: result.status, models: result.models, error: result.error || null, failure: result.failure || null, durationMs: result.durationMs ?? null, source: result.source || "legacy", legacy: !result.models?.every(m => m.method === 'candy' || m.probabilityStatus || m.status === "error") }; }
  recordResult(entry, result) {
    const record = this.historyRecord({ ...result, id: crypto.randomUUID(), transcriptVersion: 1, requestCount: (result.models || []).reduce((n, m) => n + (m.requests?.length || 0), 0) });
    entry.recentResults = this.latestRounds({ recentResults: [record, ...this.latestRounds(entry)] });
    entry.result = roundSummary({ ...result, id: record.id, transcriptVersion: 1, requestCount: record.requestCount });
    if (result.method !== 'candy') entry.fingerprintResult = entry.result;
    delete entry.history;
  }
  history(email, planType) {
    const state = this.snapshot(email, planType);
    const records = this.latestRounds(this.accounts.get(label(email))).map(roundSummary);
    return { since: records.at(-1)?.checkedAt || new Date(this.now()).toISOString(), until: new Date(this.now()).toISOString(), records, phase: state.phase, runningMethod:state.runningMethod, queuePosition: state.queuePosition, enabled: state.enabled, nextCheckAt: state.nextCheckAt, models: state.models, testSequence:state.testSequence, sequence:state.sequence, lastError: state.lastError, groupSyncError: state.groupSyncError, groupSyncPending: Boolean(this.accounts.get(label(email))?.groupSyncPending) };
  }
  historyDetail(email, roundId) {
    const record = this.latestRounds(this.accounts.get(label(email))).find(r => (r.id || r.checkedAt) === roundId);
    if (!record) throw Object.assign(new Error("该轮记录已轮换或不存在，请刷新最近 6 轮记录"), { status: 404 });
    return { record };
  }
  saveSettings(raw) {
    const next = normalizeFingerprintSettings(raw);
    const onlyConcurrency = JSON.stringify({ ...next, maxConcurrentAccounts: 0 }) === JSON.stringify({ ...this.settings, maxConcurrentAccounts: 0 });
    if (!onlyConcurrency) this.invalidate();
    return this.mutate(async () => {
      if (!onlyConcurrency) this.invalidate();
      const previous = this.settings, previousAccounts = this.accounts;
      const changedSampling = JSON.stringify([previous.models, previous.minProbability, previous.intervalMinutes, previous.planDefaults, previous.testSequence]) !== JSON.stringify([next.models, next.minProbability, next.intervalMinutes, next.planDefaults, next.testSequence]);
      this.settings = next;
      if (!onlyConcurrency) this.accounts = new Map([...this.accounts].map(([email, entry]) => [email, { ...entry, nextCheckAt: changedSampling ? null : entry.nextCheckAt, groupSyncPending: true }]));
      try { await this.persist(); } catch (error) { this.settings = previous; this.accounts = previousAccounts; throw error; }
      this.onChange(); this.drain(); this.trigger(); return this.publicSettings();
    });
  }
  saveOverride(email, raw, { notify = true } = {}) {
    email = label(email); const override = normalizeFingerprintOverride(raw); this.invalidateAccount(email);
    return this.mutate(async () => {
      this.invalidateAccount(email);
      const previous = this.accounts.get(email);
      this.accounts.set(email, { ...previous, override, nextCheckAt: null, lastError: null });
      try { await this.persist(); } catch (error) { if (previous) this.accounts.set(email, previous); else this.accounts.delete(email); throw error; }
      if (notify) this.onChange(); this.trigger();
    });
  }
  publicSettings() { return { settings: this.settings, profiles: this.getContext().profiles, runtime: { activeAccounts: this.active.size, queuedAccounts: this.queued.size, maxConcurrentAccounts: this.settings.maxConcurrentAccounts } }; }
  // Apply only the conditional groups in the supplied profile; other groups retain existing behavior.
  filterGroups(email, planType, profileId, groups, currentAccount = null) {
    const rules = this.settings.groupPolicies[profileId] || {};
    const attribution = this.attribution(email, planType);
    const result = currentAccount && attribution?.routingIdentities?.[currentAccount.id] === fingerprintRoutingIdentity(currentAccount) ? attribution : null;
    const existing = new Set((currentAccount?.group_ids || []).map(String));
    return groups.filter(id => rules[String(id)] !== "verified" || result?.status === "match" || result?.status !== "mismatch" && existing.has(String(id)));
  }
  assertRunnable(email, planType, { manual = false } = {}) {
    if (this.isBlocked(email)) throw Object.assign(new Error("账号已确认封禁、删除或永久停用，已停止自动化"), { status: 409 });
    const config = this.effective(email, planType), context = this.getContext();
    if (!config.models.length) throw invalid("请先设置至少一个检测模型");
    if (this.closing) throw Object.assign(new Error("检测服务正在关闭"), { status: 503 });
    if (!context.config?.baseUrl || !context.config?.adminApiKey) throw Object.assign(new Error("请先配置 Sub2API"), { status: 409 });
    return manual || config.enabled;
  }
  run(email, planType, options = {}) {
    email = label(email);
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
      if (this.isBlocked(email) || !task.options.manual && (this.stopped || !this.effective(email, task.planType).enabled)) { this.inFlight.delete(email); task.resolve(this.snapshot(email, task.planType)); continue; }
      const operation = this.perform(email, task.planType, task.options);
      const settled = () => { this.inFlight.delete(email); this.drain(); this.onChange(); };
      void operation.then(value => { task.resolve(value); settled(); }, error => { task.reject(error); settled(); });
    }
  }
  async collectModel(context, account, model, method, detector, signal) {
    const outputs = [], sampleFailures = [], requests = [];
    const common = () => ({accountId:String(account.id), ...model, method, sampleFailures, requestCount:requests.length, requests});
    try {
      const challenges = method === 'candy' ? [{prompt:CANDY_PROMPT, expected_answer:21}] : this.challenges(3);
      const maxAttempts = method === 'candy' ? 1 : 3;
      for (const [index, challenge] of challenges.entries()) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const minimumCount = method === 'fingerprint' ? Math.max(80,Math.ceil(challenge.expected_count * .55)) : null;
          const request = {sample:index+1, attempt, method, prompt:challenge.prompt, response:null, startedAt:new Date(this.now()).toISOString(), expectedCount:challenge.expected_count ?? null, minimumCount, ...(method === 'candy' ? {expectedAnswer:21, promptSha256:CANDY_PROMPT_SHA256} : {})};
          const started = this.now(); requests.push(request);
          try {
            const text = await this.sample(context.config,account,model.model,challenge.prompt,signal,{onMetadata:metadata=>Object.assign(request,metadata)});
            signal.throwIfAborted();
            Object.assign(request,{response:text,status:'success',durationMs:this.now()-started});
            if (method === 'fingerprint') request.count = parseNumbers(text).length;
            else request.extractedFinalAnswer = gradeCandy(text).extractedFinalAnswer;
            request.accepted = method === 'fingerprint' ? request.count >= minimumCount : request.extractedFinalAnswer !== null;
            if (!request.accepted) {
              const detail = fingerprintFailure({fingerprintFailure:true,code:method === 'fingerprint' ? 'SHORT_OUTPUT' : 'CANDY_UNCLEAR',retryable:method === 'fingerprint'});
              Object.assign(request,{status:'invalid',failure:detail});
              sampleFailures.push({sample:index+1,attempt,...detail});
              if (attempt < maxAttempts) { await delay(1000,undefined,{signal}); continue; }
            }
            outputs.push({text,expected_count:challenge.expected_count}); break;
          } catch (error) {
            signal.throwIfAborted();
            const detail = fingerprintFailure(error);
            Object.assign(request,{status:'error',response:typeof error.fingerprintReply === 'string' ? error.fingerprintReply : null,failure:detail,accepted:false,durationMs:this.now()-started});
            if (method === 'fingerprint') request.count = request.response === null ? 0 : parseNumbers(request.response).length;
            sampleFailures.push({sample:index+1,attempt,...detail});
            if (!detail.retryable || attempt === maxAttempts) throw error;
            await delay(1000,undefined,{signal});
          }
        }
      }
      const validOutputs = method === 'fingerprint' ? outputs.filter(o=>parseNumbers(o.text).length >= Math.max(80,Math.ceil(o.expected_count * .55))).length : 0;
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
  async perform(email, planType, { manual = false } = {}) {
    email = label(email);
    if (this.isBlocked(email)) return this.snapshot(email, planType);
    if (this.active.has(email)) return this.snapshot(email, planType);
    const config = this.effective(email, planType);
    if (!config.models.length) throw invalid("请先设置至少一个检测模型");
    if (!manual && !config.enabled) return this.snapshot(email, planType);
    const context = this.getContext(), backend = context.backend, signature = this.signature(email, planType), revision = this.revision, startedAt = this.now(), step = this.sequence(email,planType), method = step.method;
    if (!context.config?.baseUrl || !context.config?.adminApiKey) throw Object.assign(new Error("请先配置 Sub2API"), { status: 409 });
    const controller = new AbortController(); this.active.set(email, controller);
    const previous = this.accounts.get(email) || { override: normalizeFingerprintOverride() };
    const entry = { ...previous, activeMethod:method, lastAttemptAt: new Date(this.now()).toISOString(), nextCheckAt: new Date(this.now() + config.intervalMinutes * 60000).toISOString(), lastError: null };
    this.accounts.set(email, entry);
    let recoveryFailure = null;
    const results = [];
    try {
      await this.mutate(async () => { controller.signal.throwIfAborted(); await this.persist(); });
      const targets = (await this.listTargets(context.config)).filter(item => label(item.email) === email);
      if (!targets.length) throw new Error("账号尚未加入 Sub2API 号池");
      const detector = method === 'fingerprint' ? await this.detector(controller.signal) : null;
      const identities = {}, routingIdentities = {};
      sampling: for (const target of targets) {
        const account = await this.getAccount(context.config, target.id);
        identities[target.id] = fingerprintAccountIdentity(account);
        routingIdentities[target.id] = fingerprintRoutingIdentity(account);
        if (account.status && account.status !== "active" || account.schedulable === false) throw new Error("账号已暂停或状态异常，本轮跳过");
        for (const model of config.models) {
          controller.signal.throwIfAborted();
          if (this.isBlocked(email)) return this.snapshot(email, planType);
          const result = await this.collectModel({...context,minProbability:config.minProbability},account,model,method,detector,controller.signal);
          results.push(result);
          const detail = result.failure;
          if (detail && (detail.code === 'QUOTA' || detail.httpStatus === 429 || account.type === 'oauth' && fingerprintRecovery(detail))) { recoveryFailure = detail; break sampling; }
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
        this.recordResult(entry, { signature, backend, method, sequencePosition:step.position, usage:aggregateRequestUsage(results), identities, routingIdentities, checkedAt: new Date(this.now()).toISOString(), durationMs: this.now() - startedAt, source: manual ? "manual" : "scheduled", status: aggregateFingerprint(results), models: results });
        // A completed candy answer consumes its one scheduled turn even when
        // unscorable. Transport/auth failures keep the slot for the next check.
        if (results.length && results.every(r=>r.samplingComplete || method === 'candy' && r.responseComplete)) entry.sequenceCursor = {signature:step.signature,index:(step.index+1)%step.total};
        if (method === 'fingerprint') entry.groupSyncPending = true;
        await this.persist();
      });
      await this.reconcile(email, planType, targets, revision);
    } catch (error) {
      if (!controller.signal.aborted && revision === this.revision) {
        await this.mutate(async () => {
          if (controller.signal.aborted || revision !== this.revision || this.accounts.get(email) !== entry) return;
          const detail = fingerprintFailure(error);
          entry.lastError = detail.message;
          this.recordResult(entry, { signature, backend, method, sequencePosition:step.position, usage:aggregateRequestUsage(results), checkedAt: new Date(this.now()).toISOString(), durationMs: this.now() - startedAt, source: manual ? "manual" : "scheduled", status: "error", models: results, error: entry.lastError, failure: detail });
          await this.persist();
        });
      }
      if (manual && !controller.signal.aborted) throw Object.assign(new Error(entry.lastError || "指纹检测未完成"), { status: [400, 409].includes(error.status) ? error.status : 502 });
    } finally {
      this.active.delete(email); this.onChange();
      // Dispatch after releasing sampling/mutation state; recovery may cancel checks.
      if (recoveryFailure && !controller.signal.aborted && revision === this.revision && !this.isBlocked(email)) {
        try { await this.onAccountFailure(email, recoveryFailure); }
        catch { entry.lastError = "授权修复未能入队，等待下次检测重试"; await this.persist(); }
      }
    }
    return this.snapshot(email, planType);
  }
  reconcile(email, planType, targets, revision = this.revision) {
    return this.mutate(() => this.reconcileLocked(email, planType, targets, revision));
  }
  async reconcileLocked(email, planType, targets, revision) {
    if (this.isBlocked(email)) return;
    const entry = this.accounts.get(email), result = this.attribution(email, planType), context = this.getContext();
    if (!["match", "mismatch"].includes(result?.status) || !entry.groupSyncPending) return;
    try {
      for (const target of targets) {
        const account = await this.getAccount(context.config, target.id);
        if (this.isBlocked(email) || revision !== this.revision || result.signature !== this.signature(email, planType)) return;
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
  }
  setTickMs(ms) {
    this.tickMs = ms;
    if (this.timer) { clearInterval(this.timer); this.timer = setInterval(() => this.trigger(), ms); this.timer.unref?.(); }
  }
  start() { this.closing = false; this.stopped = false; this.timer = setInterval(() => this.trigger(), this.tickMs || 60000); this.timer.unref?.(); this.trigger(); }
  trigger() { if (!this.stopped && !this.ticking) this.ticking = this.tick().catch(() => {}).finally(() => { this.ticking = null; }); }
  async tick() {
    const context = this.getContext(), scheduled = [];
    for (const job of context.jobs) {
      if (this.stopped) break;
      if (this.isBlocked(job.email)) continue;
      if (this.inFlight.has(label(job.email))) continue;
      const state = this.snapshot(job.email, job.planType), entry = this.accounts.get(label(job.email));
      if (entry?.groupSyncPending && ["match", "mismatch"].includes(this.attribution(job.email,job.planType)?.status)) {
        const targets = (await this.listTargets(context.config)).filter(t => label(t.email) === label(job.email));
        await this.reconcile(label(job.email), job.planType, targets);
      }
      if (!state.enabled || !state.models.length) continue;
      if (!state.nextCheckAt || Date.parse(state.nextCheckAt) <= this.now()) { const task = this.run(job.email, job.planType); void task.catch(() => {}); scheduled.push(task); }
    }
    await Promise.allSettled(scheduled);
  }
  remove(email) { this.invalidateAccount(email); return this.mutate(async () => { this.accounts.delete(label(email)); await this.persist(); }); }
  async stop() { this.closing = true; this.stopped = true; clearInterval(this.timer); this.invalidate(); await Promise.allSettled([...this.runningTasks, this.ticking, this.mutationPromise].filter(Boolean)); await this.writePromise; }
}
