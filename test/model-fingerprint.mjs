import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelFingerprintService, normalizeFingerprintSettings, normalizeFingerprintOverride, fingerprintVerdict, aggregateFingerprint } from "../src/model-fingerprint.mjs";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-fingerprint-"));
const makeAnalysis = (prediction = "gpt-5.5", probability = 0.95, decision = "scored") => ({ prediction, prediction_name: prediction, probability, decision, used_outputs: 3, probability_status: "reference_calibrated", evidence: { insufficient: true }, results: ["gpt-5.5", "gpt-5.4"].map(model => ({ model, display_name: model, probability: model === prediction ? probability : 1 - probability })) });
assert.equal(fingerprintVerdict(makeAnalysis(), "gpt-5.5", .8), "match", "SDK identity caveat is not mistaken for missing calibration");
assert.equal(fingerprintVerdict(makeAnalysis("gpt-5.4"), "gpt-5.5", .8), "mismatch");
assert.equal(fingerprintVerdict(makeAnalysis("gpt-5.4", .6), "gpt-5.5", .8), "unknown");
assert.equal(fingerprintVerdict(makeAnalysis(), "absent-from-bank", .8), "unknown");
assert.equal(fingerprintVerdict({ ...makeAnalysis(), used_outputs: 2 }, "gpt-5.5", .8), "unknown");
const combined = { ...makeAnalysis(), prediction: "gpt-6-astra", prediction_name: "gpt-6-astra/6.1-sol", results: [{ model: "gpt-6-astra", display_name: "gpt-6-astra/6.1-sol", probability: .99 }, { model: "gpt-5.6-luna", display_name: "gpt-5.6-luna", probability: .01 }] };
assert.equal(fingerprintVerdict(combined, "gpt-6.1-sol", .8), "match", "slash-combined reference class recognizes the model alias");
assert.equal(fingerprintVerdict({ ...combined, prediction: "gpt-5.6-luna", prediction_name: "gpt-5.6-luna" }, "gpt-6.1-sol", .8), "mismatch", "known combined alias with another high-probability attribution is mismatch, not unknown");
for (const maxConcurrentAccounts of [0, 17, true, 1.5]) assert.throws(() => normalizeFingerprintSettings({ maxConcurrentAccounts }));
assert.equal(aggregateFingerprint([{ status: "match" }, { status: "error" }]), "unknown");
assert.equal(aggregateFingerprint([{ status: "error" }]), "error");
assert.equal(aggregateFingerprint([{ status: "match" }, { status: "mismatch" }]), "mismatch");
for (const intervalMinutes of [0, 4, 43201, true, ""]) assert.throws(() => normalizeFingerprintSettings({ intervalMinutes }));
assert.throws(() => normalizeFingerprintSettings({ models: ["a", "a"] }));
assert.throws(() => normalizeFingerprintOverride({ enabled: "yes" }));
let time = Date.now(), backend = "fixture", phase = "match", calls = 0, writes = 0, failPut = false;
let release;
const account = { id: 1, type: "oauth", status: "active", schedulable: true, group_ids: ["10", "99"] };
const settings = { models: ["gpt-5.5"], intervalMinutes: 5, minProbability: .8, planDefaults: { free: true }, groupPolicies: { default: { 10: "default", 20: "verified" } } };
const options = {
  filePath: path.join(directory, "state.json"), now: () => time,
  getContext: () => ({ config: { baseUrl: "https://fixture", adminApiKey: "private" }, backend, profiles: [{ id: "default", groupIds: ["10", "20"] }], jobs: [{ email: "a@example.test", planType: "free" }] }),
  listTargets: async () => [{ id: 1, email: "a@example.test", profileId: "default" }], getAccount: async () => structuredClone(account),
  sample: async (_config, _account, _model, _prompt, signal) => { calls++; if (phase === "held") await new Promise(resolve => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); }); signal.throwIfAborted(); if (phase === "error") throw new Error("private-token"); return Array.from({length:100},(_,i)=>i+1).join(", "); },
  detectorLoader: async () => ({ builtAt: "fixture-build", analyze: () => makeAnalysis(phase === "mismatch" ? "gpt-5.4" : "gpt-5.5", phase === "unknown" ? .5 : .95) }),
  challenges: () => Array.from({ length: 3 }, () => ({ prompt: "fixture challenge", expected_count: 100 })),
  updateGroups: async (_config, _id, ids) => { if (failPut) throw new Error("upstream private-token"); account.group_ids = ids; writes++; },
};
const service = new ModelFingerprintService(options);
try {
  await service.load(); assert.equal(service.snapshot("a@example.test", "free").enabled, false);
  await service.saveSettings(settings);
  assert.deepEqual(service.settings.enabledPlanTypes, ["free"], "legacy true PlanTypes migrate to the allowlist");
  assert.equal(service.settings.groupPolicies.default[20], "verified", "group admission rules survive PlanType migration");
  assert.deepEqual(service.filterGroups("a@example.test", "free", "default", ["10", "20", "99"]), ["10", "99"]);
  let state = await service.run("a@example.test", "free", { manual: true });
  assert.equal(state.result.status, "match"); assert.equal(calls, 3);
  phase = "mismatch"; state = await service.run("a@example.test", "free", { manual: true });
  assert.equal(state.result.status, "mismatch");
  phase = "unknown"; state = await service.run("a@example.test", "free", { manual: true });
  assert.equal(state.result.status, "unknown");
  phase = "error"; state = await service.run("a@example.test", "free", { manual: true });
  assert.equal(state.result.status, "error"); assert.equal(state.result.models[0].failure.code, "UNKNOWN"); assert(!JSON.stringify(state).includes("private-token"));
  assert.equal(writes, 2, "explicit pass admits; explicit failure removes; unknown/error preserve groups");
  await service.saveOverride("a@example.test", { enabled: false, models: ["gpt-5.4"], intervalMinutes: 10 });
  assert.equal(service.snapshot("a@example.test", "free").enabled, false); assert.equal(service.snapshot("a@example.test", "free").models[0].model, "gpt-5.4");
  const restored = new ModelFingerprintService(options); await restored.load(); assert.equal(restored.snapshot("a@example.test", "free").intervalMinutes, 10); assert.equal(restored.snapshot("a@example.test", "free").enabled, false); await restored.stop();
  await service.saveOverride("a@example.test", {}); assert.equal(service.snapshot("a@example.test", "free").enabled, true);
  backend = "other"; assert.equal(service.snapshot("a@example.test", "free").result, null, "backend switch invalidates evidence"); backend = "fixture";
  phase = "held"; const pending = service.run("a@example.test", "free", { manual: true });
  while (!release) await new Promise(r => setTimeout(r, 5));
  const beforeCancel = writes; await service.saveOverride("a@example.test", { enabled: false }); release(); await pending; assert.equal(writes, beforeCancel, "cancelled work never changes groups");
  phase = "match"; failPut = true; await service.run("a@example.test", "free", { manual: true });
  const disabledCalls = calls; failPut = false; service.stopped = false; await service.tick(); service.stopped = true;
  assert.equal(calls, disabledCalls, "disabled account retries pending manual group sync without new inference");
  const order = [];
  await Promise.all([service.saveOverride("a@example.test", { enabled: true, intervalMinutes: 15 }).then(() => order.push(1)), service.saveOverride("a@example.test", { enabled: false, intervalMinutes: 20 }).then(() => order.push(2))]);
  assert.deepEqual(order, [1, 2]); assert.equal(service.snapshot("a@example.test", "free").intervalMinutes, 20);
  const slow = new ModelFingerprintService({ ...options, filePath: path.join(directory, "slow.json"), detectorLoader: () => new Promise(() => {}) });
  await slow.saveSettings(settings); const slowRun = slow.run("a@example.test", "free", { manual: true });
  await new Promise(r => setTimeout(r, 20)); await slow.stop(); await slowRun;
  // Recent rounds survive both restarts and gaps longer than the old one-hour window.
  phase = "match"; await service.saveOverride("a@example.test", {});
  time += 1000; await service.run("a@example.test", "free", { manual: true });
  time += 1000; phase = "mismatch"; await service.run("a@example.test", "free", { manual: true });
  const recent = service.history("a@example.test", "free"); assert(recent.records.length >= 2); assert.equal(recent.records[0].status, "mismatch"); assert.equal(recent.records[0].models[0].probabilityStatus, "reference_calibrated");
  const historyRestored = new ModelFingerprintService(options); await historyRestored.load(); assert.equal(historyRestored.history("a@example.test", "free").records.length, recent.records.length); await historyRestored.stop();
  time += 3600001; assert.equal(service.history("a@example.test", "free").records.length, recent.records.length);
  const sixRounds = { override: normalizeFingerprintOverride({}) };
  service.accounts.set("six@example.test", sixRounds);
  for (let i = 0; i < 9; i++) {
    time += 7_200_000;
    service.recordResult(sixRounds, { checkedAt: new Date(time).toISOString(), status: ["match", "mismatch", "error"][i % 3], models: [] });
  }
  await service.persist();
  assert.deepEqual(service.snapshot("six@example.test").recentResults.map(r => r.status), ["error", "mismatch", "match", "error", "mismatch", "match"]);
  const sixRestored = new ModelFingerprintService(options); await sixRestored.load();
  assert.equal(sixRestored.history("six@example.test").records.length, 6);
  assert.deepEqual(sixRestored.snapshot("six@example.test").recentResults, service.snapshot("six@example.test").recentResults);
  await sixRestored.stop();
  // Three accounts queued behind a limit of two; raising it drains without abort.
  let concurrent = 0, peak = 0, started = [], releases = new Map();
  const jobs = [1, 2, 3].map(id => ({ email: `parallel${id}@example.test`, planType: "free" }));
  const parallel = new ModelFingerprintService({ ...options, filePath: path.join(directory, "parallel.json"), getContext: () => ({ ...options.getContext(), jobs }), listTargets: async () => jobs.map((j, i) => ({ id: i + 1, email: j.email, profileId: "default" })), getAccount: async (_config, id) => ({ id, status: "active", group_ids: [] }), sample: async (_config, account, _model, _prompt, signal) => {
    if (!started.includes(account.id)) { started.push(account.id); concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => { releases.set(account.id, resolve); signal.addEventListener("abort", resolve, { once: true }); }); concurrent--; }
    signal.throwIfAborted(); return Array.from({length:100},(_,i)=>i+1).join(", ");
  }, updateGroups: async () => {}, detectorLoader: async () => ({ builtAt: "fixture", analyze: () => makeAnalysis() }) });
  await parallel.saveSettings({ ...settings, maxConcurrentAccounts: 2 }); parallel.stopped = false;
  const runs = jobs.map(j => parallel.run(j.email, j.planType, { manual: true }));
  const wait = async condition => { for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error("concurrency fixture timed out"); };
  await wait(() => started.length === 2); assert.equal(parallel.snapshot(jobs[2].email, "free").phase, "queued"); assert.equal(peak, 2); assert.strictEqual(parallel.run(jobs[0].email, "free", { manual: true }), runs[0], "same account deduplicates");
  await parallel.saveSettings({ ...settings, maxConcurrentAccounts: 3 }); await wait(() => started.length === 3); assert.equal(peak, 3);
  for (const resolve of releases.values()) resolve(); await Promise.all(runs); assert(jobs.every(j => parallel.snapshot(j.email, "free").result?.status === "match"));
  await parallel.stop();
  let retryCalls = 0, retryWrites = 0;
  const retryService = new ModelFingerprintService({ ...options, filePath: path.join(directory, "retry.json"),
    getAccount: async () => ({ id: 1, type: "oauth", status: "active", group_ids: ["10","20"] }),
    sample: async () => { retryCalls++; if (retryCalls === 2) throw Object.assign(new Error("private-token"), { fingerprintFailure: true, code: "UPSTREAM", httpStatus: 503, retryable: true }); return Array.from({length:100},(_,i)=>i+1).join(", "); },
    updateGroups: async () => { retryWrites++; }, detectorLoader: async () => ({ builtAt: "fixture", analyze: () => makeAnalysis() }) });
  await retryService.saveSettings(settings);
  const retried = await retryService.run("a@example.test", "free", { manual: true });
  assert.equal(retryCalls,4,"only the failed second sample is retried, not the successful first sample");
  assert.equal(retried.result.status,"match"); assert.equal(retried.result.models[0].sampleFailures[0].sample,2); assert.equal(retried.result.models[0].sampleFailures[0].httpStatus,503);
  retryService.sample = async () => { retryCalls++; throw Object.assign(new Error("secret upstream"),{fingerprintFailure:true,code:"QUOTA",httpStatus:429,retryable:false}); };
  const beforeQuota = retryCalls;
  const quota = await retryService.run("a@example.test", "free", { manual: true });
  assert.equal(retryCalls,beforeQuota+1,"quota failures are never retried"); assert.equal(quota.result.status,"error"); assert.equal(retryWrites,0,"failed sampling never changes conditional groups");
  let quotaNotifications = 0;
  retryService.onAccountFailure = async (_email, detail) => { assert.equal(detail.httpStatus, 429); quotaNotifications++; };
  await retryService.saveSettings({ ...settings, models: ["gpt-5.5", "gpt-5.4"] });
  const beforeMultiQuota = retryCalls;
  await retryService.run("a@example.test", "free", { manual: true });
  assert.equal(retryCalls, beforeMultiQuota + 1, "429 must stop remaining models and samples");
  assert.equal(quotaNotifications, 1, "429 must notify the console to stop related monitoring, never OAuth repair");
  await retryService.saveSettings({ ...settings, failureRetries: 2, failureRetryDelaySeconds: 1 });
  retryService.sample = async () => { retryCalls++; throw Object.assign(new Error("secret upstream"),{fingerprintFailure:true,code:"UPSTREAM",httpStatus:503,retryable:true}); };
  const beforeBound = retryCalls;
  await retryService.run("a@example.test", "free", { manual: true }); assert.equal(retryCalls,beforeBound+3,"transient retries stop after the third attempt");
  retryService.getAccount = async () => ({id:1,status:"paused"}); time+=1000;
  await assert.rejects(retryService.run("a@example.test", "free", {manual:true}),/暂停/);
  const skipped = retryService.history("a@example.test","free").records[0]; assert.equal(skipped.failure.code,"ACCOUNT_PAUSED"); assert(skipped.error.includes("暂停"),"outer-stage failure details persist in history");
  await retryService.stop();
  console.log("PASS: combined reference aliases, bounded account concurrency, deduplicated queue, live concurrency increase and six-round history across restarts and multi-hour gaps");
  console.log("PASS: model fingerprint calibrated matching/unknown states, three-sample strictness, inherited/independent settings, persistence, backend isolation, retired group policies and cancellation");
} finally { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); }
