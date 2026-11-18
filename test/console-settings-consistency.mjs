import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConsoleApp } from "../src/console-app.mjs";
import { ModelFingerprintService } from "../src/model-fingerprint.mjs";
import { WebSessionMonitor } from "../src/web-session-monitor.mjs";

process.env.SUB2API_MONITOR_ENABLED = "0";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "console-settings-consistency-"));
const outputRoot = path.join(root, "runtime"), webRoot = path.join(root, "web");
const taskFile = path.join(outputRoot, "task-settings.json");
const fingerprintFile = path.join(outputRoot, "model-fingerprint.json");
const taskUrl = "/api/task-settings", fpUrl = "/api/model-fingerprint/settings", retryUrl = taskUrl + "/retry-runtime";
await fs.mkdir(path.join(webRoot, "dist"), { recursive: true });
await fs.writeFile(path.join(webRoot, "dist", "index.html"), "<!doctype html><title>Settings fixture</title>");
const app = createConsoleApp({ production: true, port: 0, outputRoot, webRoot });
const originalRename = fs.rename;
const originalWebTrigger = WebSessionMonitor.prototype.trigger;
const originalWebTick = WebSessionMonitor.prototype.setTickMs;
const originalApplyFingerprint = ModelFingerprintService.prototype.applySavedSettings;
let block = null, rejectWrite = null, publishFailure = false, fingerprintRuntimeFailure = false, publishAttempts = 0;
const fingerprintAttempts = [], writes = [];
const webTickAttempts = [];

function blockNextWrite(target) {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  block = { target, entered, resume };
  return { entered: entered.promise, resume: resume.resolve };
}
fs.rename = async function (source, target) {
  if (target === taskFile || target === fingerprintFile) writes.push(target);
  if (target === block?.target) {
    const active = block;
    block = null;
    active.entered.resolve();
    await active.resume.promise;
  }
  if (target === rejectWrite) {
    rejectWrite = null;
    throw new Error("fixture rename failed");
  }
  return originalRename(source, target);
};
WebSessionMonitor.prototype.trigger = function (...args) {
  if (args[0] === true) {
    publishAttempts++;
    if (publishFailure) throw new Error("fixture task publication failed");
  }
  return originalWebTrigger.apply(this, args);
};
WebSessionMonitor.prototype.setTickMs = function (ms) {
  webTickAttempts.push(ms);
  return originalWebTick.call(this, ms);
};
ModelFingerprintService.prototype.applySavedSettings = function (...args) {
  fingerprintAttempts.push(this.settings.minProbability);
  if (fingerprintRuntimeFailure) throw new Error("fixture detection application failed");
  return originalApplyFingerprint.apply(this, args);
};

async function interleave(blockedFile, startFirst, startSecond, whileBlocked = () => {}) {
  const barrier = blockNextWrite(blockedFile);
  const first = startFirst();
  let second;
  try {
    await Promise.race([
      barrier.entered,
      first.then(result => assert.fail("first request finished before its file write: " + JSON.stringify(result))),
      delay(5_000, undefined, { ref: false }).then(() => assert.fail("fixture write barrier was not reached")),
    ]);
    second = startSecond();
    await whileBlocked();
    // The old code lets the second request finish while the first rename waits.
    // Always release the barrier so the final assertion reports the lost value.
    await Promise.race([second, delay(150)]);
  } finally {
    barrier.resume();
  }
  return Promise.all([first, second]);
}

try {
  const { urls: [base] } = await app.start();
  const { token } = await fetch(base + "/api/bootstrap").then(r => r.json());
  const headers = { "content-type": "application/json", "x-console-token": token };
  const call = async (url, body) => {
    const response = await fetch(base + url, {
      headers, signal: AbortSignal.timeout(10_000),
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, ...data };
  };
  const assertFingerprint = async (minutes, probability) => {
    const disk = JSON.parse(await fs.readFile(fingerprintFile, "utf8")).settings;
    const task = (await call(taskUrl)).settings.modelFingerprint;
    const direct = (await call(fpUrl)).settings;
    for (const value of [disk, task, direct]) {
      assert.equal(value.intervalMinutes, minutes);
      assert.equal(value.minProbability, probability);
    }
  };

  const baseline = (await call(fpUrl)).settings;
  let responses = await interleave(taskFile,
    () => call(taskUrl, { modelFingerprint: { intervalMinutes: 9 } }),
    () => call(fpUrl, { settings: { ...baseline, intervalMinutes: 9, minProbability: 0.95 } }));
  assert(responses.every(response => response.status === 200));
  await assertFingerprint(9, 0.95);

  responses = await interleave(fingerprintFile,
    () => call(fpUrl, { patch: { minProbability: 0.91, matchedConcurrency: { value: 6 } } }),
    () => call(taskUrl, { modelFingerprint: { intervalMinutes: 13 } }),
    () => assertFingerprint(9, 0.95));
  assert(responses.every(response => response.status === 200));
  await assertFingerprint(13, 0.91);
  assert.deepEqual((await call(fpUrl)).settings.matchedConcurrency, { enabled: false, value: 6 });

  const before = await Promise.all([fs.readFile(taskFile), fs.readFile(fingerprintFile)]);
  rejectWrite = fingerprintFile;
  const rejected = await call(taskUrl, { maxActiveJobs: 12, modelFingerprint: { minProbability: 0.92 } });
  assert.equal(rejected.status, 500);
  assert.equal(rejected.runtimeApply, undefined);
  assert.deepEqual(await Promise.all([fs.readFile(taskFile), fs.readFile(fingerprintFile)]), before);
  assert.equal((await call(fpUrl, { patch: { maxConcurrentAccounts: 17 } })).status, 400);

  publishFailure = true;
  fingerprintRuntimeFailure = true;
  const webTicksBeforeFailure = webTickAttempts.length;
  const stored = await call(taskUrl, {
    webSessionMonitor: { intervalMinutes: 31 },
    monitoring: { webSessionScanIntervalSeconds: 32 },
    modelFingerprint: { minProbability: 0.92 },
  });
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.runtimeApply.scopes, ["tasks", "fingerprint"]);
  assert.match(stored.runtimeApply.message, /设置已保存/);
  assert.equal(stored.settings.webSessionMonitor.intervalMinutes, 31);
  assert.equal(JSON.parse(await fs.readFile(taskFile, "utf8")).webSessionMonitor.intervalMinutes, 31);
  await assertFingerprint(13, 0.92);

  const latest = await call(fpUrl, { patch: { minProbability: 0.94 } });
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.runtimeApply.scopes, ["tasks", "fingerprint"]);
  assert.deepEqual((await call(taskUrl)).runtimeApply, latest.runtimeApply);
  const writesBeforeRetry = writes.length, publishAttemptsBeforeRetry = publishAttempts;
  const pending = await call(retryUrl, {});
  assert.deepEqual(pending.runtimeApply.scopes, ["tasks", "fingerprint"]);
  publishFailure = false;
  fingerprintRuntimeFailure = false;
  const retried = await call(retryUrl, { modelFingerprint: { minProbability: 0.5 }, webSessionMonitor: { intervalMinutes: 33 } });
  assert.equal(retried.status, 200);
  assert.equal(retried.runtimeApply, undefined);
  assert.equal(retried.settings.webSessionMonitor.intervalMinutes, 31);
  assert.equal(writes.length, writesBeforeRetry, "runtime retry wrote configuration files");
  assert.equal(publishAttempts, publishAttemptsBeforeRetry + 2);
  assert.deepEqual(fingerprintAttempts.slice(-2), [0.94, 0.94]);
  assert.deepEqual(webTickAttempts.slice(webTicksBeforeFailure), [32_000], "retry repeated an already applied timer update");
  await assertFingerprint(13, 0.94);
  console.log("CONSOLE_SETTINGS_CONSISTENCY_PASS both HTTP write orders retain changes; linked write rollback; saved runtime failure; runtime retry uses latest config");
} finally {
  await app.stop();
  fs.rename = originalRename;
  WebSessionMonitor.prototype.trigger = originalWebTrigger;
  WebSessionMonitor.prototype.setTickMs = originalWebTick;
  ModelFingerprintService.prototype.applySavedSettings = originalApplyFingerprint;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
}
