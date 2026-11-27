import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OverloadCooldown, normalizeOverloadCooldown } from "../src/overload-cooldown.mjs";
import { ModelFingerprintService } from "../src/model-fingerprint.mjs";
import { fingerprintFilterValue } from "../web/src/codex-status-filter.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "overload-resume-"));
const email = "resume@example.test";
const config = { baseUrl: "https://fixture", adminApiKey: "fixture" };
let now = Date.parse("2026-11-27T00:01:00Z"), backend = "fixture", validity = "长效", fail = false;
let rule = { windowMinutes: 15, threshold: 3, cooldownMinutes: 60, longTerm: false, rotating: true };
const row = { id: "7", email, type: "oauth", status: "active", enabled: true, schedulable: true, group_ids: ["10", "20"], concurrency: 9, priority: 7 };
const events = [];
const cooldown = new OverloadCooldown({ filePath: path.join(root, "cooldown.json"), now: () => now,
  getConfig: () => config, backendIdentity: () => backend, getSettings: () => rule, getValidity: () => validity,
  setTimer: () => ({ unref() {} }), clearTimer: () => {},
  listAccounts: async () => new Map([[email, [{ id: "7", enabled: row.enabled }]]]),
  onResume: async (_email, event) => events.push(event),
  request: async (_config, endpoint, options) => {
    assert(endpoint.endsWith("/schedulable")); if (fail) throw Error("fixture write failed");
    row.enabled = JSON.parse(options.body).schedulable;
  },
});
const sample = () => { const start = Math.floor(now / 900000) * 900000; return {
  config, accountIds: ["7"], point: { start: new Date(start).toISOString(), end: new Date(start + 900000).toISOString(), count: 5 },
  sampledAt: now, windowMinutes: 15,
}; };
let calls = 0, answer = "<final_answer>21</final_answer>", held, release;
const opts = { filePath: path.join(root, "fingerprint.json"), now: () => now,
  getContext: () => ({ config, backend, profiles: [{ id: "default", groupIds: ["10", "20"] }], jobs: [{ email, planType: "plus" }] }),
  listTargets: async () => [{ id: "7", email, profileId: "default" }], getAccount: async () => ({ ...row }),
  sample: async (_config, _row, _model, _prompt, signal) => {
    calls++;
    if (held) await new Promise(resolve => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); });
    signal.throwIfAborted(); if (answer === "error") throw Error("fixture network failure"); return answer;
  },
  getPoolNumberPolicy: (_email, _plan, field, verdict) => ({ enabled: true, value: verdict === "mismatch" ? 1 : field === "concurrency" ? 9 : 7 }),
  updateGroups: async (_config, _id, ids) => { row.group_ids = ids; },
  updateConcurrency: async (_config, _id, value) => { row.concurrency = value; },
  updatePriority: async (_config, _id, value) => { row.priority = value; },
};
let fp = new ModelFingerprintService(opts);
try {
  assert.throws(() => normalizeOverloadCooldown({ longTerm: 1 }));
  assert.throws(() => normalizeOverloadCooldown({ rotating: "false" }));
  assert.equal(normalizeOverloadCooldown(rule).longTerm, false);
  cooldown.stopped = false;
  await cooldown.setEnabled(email, true);
  await cooldown.observeCounts(email, sample()); assert.equal(row.enabled, true); assert.deepEqual(cooldown.countTargets(), []);
  validity = "轮转"; await cooldown.observeCounts(email, sample()); assert(cooldown.isPaused(email)); assert.equal(row.enabled, false);
  rule.rotating = false; now += 60 * 60000; await cooldown.refresh();
  assert.equal(row.enabled, true, "type off must not strand an existing cooldown"); assert.equal(events.at(-1).manual, false);
  now += 16 * 60000; validity = "长效"; rule.longTerm = true;
  await cooldown.observeCounts(email, sample()); assert(cooldown.isPaused(email));
  const op = cooldown.snapshot(email).operation;
  await assert.rejects(cooldown.manualOverride(email, ["7"], async () => { throw Error("manual write failed"); }, { enabled: true }));
  assert(cooldown.isPaused(email)); assert.equal(cooldown.snapshot(email).operation.id, op.id);
  await cooldown.manualOverride(email, ["7"], async () => { row.enabled = true; }, { enabled: true });
  const resumed = cooldown.snapshot(email);
  assert.equal(resumed.operation, null); assert.equal(resumed.windowCount, null); assert.equal(resumed.historyCount, null);
  assert.equal(resumed.triggerReason, null); assert.equal(resumed.lastCheckedAt, null); assert.equal(resumed.phase, "idle");
  now += 1; await cooldown.observeCounts(email, sample()); assert(!cooldown.isPaused(email), "old bucket restarted cooldown");
  assert.equal(resumed.enabled, true);
  await cooldown.stop();

  await fp.saveSettings({ models: ["fixture"], enabledPlanTypes: [], failureRetries: 0,
    testSequence: { first: "candy", candy: 1, fingerprint: 0 }, groupPolicies: { default: { 10: "default", 20: "verified" } } });
  await fp.run(email, "plus", { manual: true });
  assert.equal(fp.snapshot(email, "plus").result.status, "match");
  const priorHistory = fp.history(email, "plus").records.length;
  now += 1000;
  await fp.markOverloadResume(email, { id: "automatic-1", backend, manual: false });
  const initialMarker = fp.snapshot(email, "plus").assumedDegraded;
  assert(initialMarker); assert.equal(initialMarker.recheckPending, false);
  assert.equal(fp.snapshot(email, "plus").result.status, "match", "real prior evidence was overwritten");
  assert.equal(fp.history(email, "plus").records.length, priorHistory, "assumption created a fake test round");
  assert.equal(fingerprintFilterValue(fp.snapshot(email, "plus")), "mismatch");
  assert.deepEqual(fp.filterGroups(email, "plus", "default", ["10", "20"]), ["10"]);
  fp.stopped = false; await fp.tick();
  assert.deepEqual(row.group_ids, ["10"]); assert.equal(row.concurrency, 1); assert.equal(row.priority, 1);
  assert.equal(calls, 1, "automatic restore should respect disabled automatic tests");
  await fp.markOverloadResume(email, { id: "automatic-1", backend, manual: true });
  assert(fp.snapshot(email, "plus").assumedDegraded.recheckPending, "manual retry must upgrade pending automatic resume");
  await fp.stop(); fp = new ModelFingerprintService(opts); await fp.load(); fp.stopped = false;
  answer = "error"; await fp.tick();
  assert.equal(calls, 2); assert.equal(fp.snapshot(email, "plus").result.source, "overload_resume");
  assert(fp.snapshot(email, "plus").assumedDegraded); assert.equal(fp.snapshot(email, "plus").assumedDegraded.recheckPending, false);
  await fp.tick(); assert.equal(calls, 2, "failed one-shot repeated indefinitely");
  await fp.markOverloadResume(email, { id: "automatic-1", backend, manual: true }); await fp.tick(); assert.equal(calls, 2, "same resume replayed detection");
  answer = "<final_answer>21</final_answer>"; now += 1000;
  await fp.markOverloadResume(email, { id: "manual-2", backend, manual: true }); await fp.tick();
  assert.equal(calls, 3); assert.equal(fp.snapshot(email, "plus").assumedDegraded, null); assert.equal(fp.groupResult(email, "plus").status, "match");
  assert.deepEqual(row.group_ids, ["10", "20"]); assert.equal(row.concurrency, 9);
  held = true; const pending = fp.run(email, "plus", { manual: true });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  await fp.markOverloadResume(email, { id: "concurrent-3", backend, manual: false });
  release(); await pending; held = false;
  assert.equal(fp.groupResult(email, "plus").status, "mismatch", "old in-flight result erased resume marker");
  const persist = fp.persist.bind(fp); fp.persist = async () => { throw Error("disk failure"); };
  await assert.rejects(fp.markOverloadResume(email, { id: "failed-4", backend, manual: true }));
  assert.equal(fp.assumedDegraded(email).id, "concurrent-3"); fp.persist = persist;
  backend = "another"; assert.equal(fp.snapshot(email, "plus").assumedDegraded, null);
  await assert.rejects(fp.markOverloadResume(email, { id: "wrong-backend", backend: "fixture", manual: true }));
  console.log("OVERLOAD_RESUME_PASS type switches; existing deadlines; manual failure ownership; cleared records; old-bin guard; durable assumed degradation; real history preserved; groups/concurrency/priority; one-shot after restart; error retention; idempotence; concurrent stale check; failed persistence; backend isolation");
} finally { await cooldown.stop(); await fp.stop(); await fs.rm(root, { recursive: true, force: true }); }
