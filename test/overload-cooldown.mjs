import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OverloadCooldown, normalizeOverloadCooldown } from "../src/overload-cooldown.mjs";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-cooldown-")), email = "auto@example.test";
let now = Date.parse("2026-11-01T04:19:00Z"), config = { baseUrl: "https://pool-a.fixture", adminApiKey: "fixture" };
let settings = { windowMinutes: 15, threshold: 3, cooldownMinutes: 30 };
const records = [{ id: "7", enabled: true }, { id: "8", enabled: false }, { id: "9", enabled: true }];
let failPause = false, failResume = false, listIncomplete = false, lastDelay, onNeedCounts = 0;
const mutations = [], filePath = path.join(temp, "cooldown.json");
const options = { filePath, getConfig: () => config, backendIdentity: c => c?.baseUrl, getSettings: () => settings,
  now: () => now, setTimer: (_callback, delay) => { lastDelay = delay; return { unref() {} }; }, clearTimer: () => {}, onNeedCounts: () => { onNeedCounts++; },
  listAccounts: async () => { if (listIncomplete) throw Error("incomplete list"); return new Map([[email, records.map(record => ({ ...record }))]]); },
  request: async (_config, endpoint, requestOptions) => {
    assert(!endpoint.includes("/ops/"), "cooldown must never query overload logs");
    const id = /accounts\/(\d+)\/schedulable/.exec(endpoint)[1], enabled = JSON.parse(requestOptions.body).schedulable;
    assert(JSON.parse(await fs.readFile(filePath, "utf8")).accounts[email].resumeAccountIds.includes(id), "durable ownership precedes remote changes");
    if (!enabled && failPause && id === "9" || enabled && failResume) throw Error(enabled ? "resume unavailable" : "pause unavailable");
    mutations.push({ id, enabled }); records.find(record => record.id === id).enabled = enabled; return {};
  } };
let service = new OverloadCooldown(options);
const sample = (count, extras = {}) => {
  const span = settings.windowMinutes * 60_000, start = Math.floor(now / span) * span;
  return { config, accountIds: records.filter(r => r.enabled).map(r => r.id), point: { start: new Date(start).toISOString(), end: new Date(start + span).toISOString(), count }, sampledAt: now, windowMinutes: settings.windowMinutes, ...extras };
};
const refresh = async () => { await service.refresh(); if (service.running) await service.running; };
const nextBucket = () => { now = (Math.floor(now / (settings.windowMinutes * 60_000)) + 1) * settings.windowMinutes * 60_000 + 60_000; };
try {
  assert.deepEqual(normalizeOverloadCooldown(), { windowMinutes: 15, threshold: 10, cooldownMinutes: 60 });
  for (const rule of [{ windowMinutes: 0 }, { threshold: true }, { threshold: "" }, { cooldownMinutes: 43201 }, []]) assert.throws(() => normalizeOverloadCooldown(rule));
  service.stopped = false; await service.observeCounts(email, sample(3)); assert.equal(mutations.length, 0);
  await service.setEnabled(email, true); assert.equal(onNeedCounts, 1); assert(service.countTargets().includes(email));
  failPause = true; await service.observeCounts(email, sample(3)); await refresh();
  assert.equal(records[0].enabled, false); assert.equal(records[2].enabled, true);
  assert.equal(service.snapshot(email).phase, "pausing"); assert.match(service.snapshot(email).lastError, /pause unavailable/);
  assert.equal(service.snapshot(email).windowCount, 3); assert.equal(lastDelay, 60_000, "failed pause retries at shared cadence");
  const deadline = service.snapshot(email).coolingUntil; assert.equal(deadline, new Date(now + 30 * 60_000).toISOString());
  await service.stop(); service = new OverloadCooldown(options); await service.load(); service.stopped = false;
  failPause = false; await refresh(); assert.equal(service.snapshot(email).phase, "cooling"); assert.equal(records[2].enabled, false);
  assert.equal(lastDelay, 30 * 60_000, "successful pause schedules its deadline, without minute polling");
  records[0].enabled = true; await refresh(); assert.equal(records[0].enabled, false, "reassert ownership after unrelated repair");
  now = Date.parse(deadline) - 250; await refresh(); assert.equal(lastDelay, 250);
  now += 250; failResume = true; await refresh(); assert.equal(service.snapshot(email).phase, "resuming"); assert(service.isPaused(email));
  failResume = false; await refresh(); assert.equal(service.snapshot(email).phase, "idle");
  assert.equal(records[0].enabled, true); assert.equal(records[2].enabled, true); assert.equal(records[1].enabled, false);
  const before = mutations.length; now += 1000; await service.observeCounts(email, sample(99)); assert.equal(mutations.length, before, "old bucket cannot cool a just-resumed account again");
  nextBucket(); await service.observeCounts(email, sample(3)); await refresh(); assert(service.isPaused(email));
  const countBeforeBackend = mutations.length;
  config = { ...config, baseUrl: "https://pool-b.fixture" }; now += 31 * 60_000; await refresh();
  assert.equal(mutations.length, countBeforeBackend); assert.match(service.snapshot(email).lastError, /后端已变化/);
  await service.manualOverride(email, ["7", "9"], async () => {}); assert(service.accounts.get(email).resumeAccountIds.length);
  config = { ...config, baseUrl: "https://pool-a.fixture" }; await refresh(); assert(!service.isPaused(email));
  nextBucket(); await service.observeCounts(email, sample(3)); await refresh();
  await service.manualOverride(email, ["7", "9"], async () => { records[0].enabled = false; records[2].enabled = false; }, { enabled: false });
  now += 31 * 60_000; await refresh(); assert(!service.isPaused(email)); assert.equal(records[0].enabled, false);
  await service.manualOverride(email, ["7", "9"], async () => { records[0].enabled = true; records[2].enabled = true; }, { enabled: true });
  nextBucket(); await service.observeCounts(email, sample(3)); await refresh(); assert(service.isPaused(email));
  await service.setEnabled(email, false); await refresh(); assert.equal(service.snapshot(email).phase, "idle"); assert.equal(records[0].enabled, true);
  await service.setEnabled(email, true); nextBucket(); await service.observeCounts(email, sample(3)); await refresh();
  listIncomplete = true; now += 31 * 60_000; const unchanged = mutations.length; await refresh();
  assert.equal(mutations.length, unchanged); assert.match(service.snapshot(email).lastError, /incomplete/);
  await service.stop();
  const persist = service.persist.bind(service); let failWrite = true;
  service.persist = () => { if (failWrite) { failWrite = false; return Promise.reject(Error("disk unavailable")); } return persist(); };
  const writes = await Promise.allSettled([service.setEnabled("failed@example.test", true), service.setEnabled("saved@example.test", true)]);
  assert.equal(writes[0].status, "rejected"); assert.equal(writes[1].status, "fulfilled");
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).accounts["failed@example.test"], undefined);
  const limited = new OverloadCooldown({ ...options, filePath: path.join(temp, "limited.json"), isCountBlocked: () => true });
  limited.stopped = false; limited.accounts.set(email, { enabled: true, resumeAccountIds: [] });
  assert.deepEqual(limited.countTargets(), []); await limited.observeCounts(email, sample(100)); assert(!limited.isPaused(email)); await limited.stop();
  assert(mutations.every(change => change.id !== "8"), "originally disabled rows are never owned");
  console.log("COOLDOWN_PASS shared fixed-bin samples; no log queries; durable partial pause/retry; restart/deadline restore; manual precedence; switch-off restore; backend isolation; missing-list preservation and atomic concurrent writes");
} finally { await service.stop(); await fs.rm(temp, { recursive: true, force: true }); }
