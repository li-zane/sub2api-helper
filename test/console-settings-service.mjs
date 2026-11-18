import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConsoleSettings } from "../src/console-settings.mjs";
import { normalizeFingerprintSettings } from "../src/model-fingerprint.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "console-settings-service-"));
const file = path.join(root, "task-settings.json");
const events = [];
let fingerprint = normalizeFingerprintSettings({});
let rejectFingerprint = false, rejectRename = false;
let testSettings;
function create(options = {}) {
  return createConsoleSettings({
    file,
    envLimit: 7,
    normalizePlanType: value => String(value).trim(),
    normalizeProxyUrl: value => value ? new URL(value).toString() : null,
    getFingerprint: () => fingerprint,
    saveFingerprint: async next => {
      events.push(["fingerprint", next.intervalMinutes]);
      if (rejectFingerprint) throw new Error("fixture fingerprint write failed");
      fingerprint = next;
    },
    hasSub2ApiConfig: () => false,
    prepareProxyChange: async mode => {
      events.push(["prepare", mode, testSettings.current.accountProxyMode]);
      return mode;
    },
    applyProxyChange: async mode => {
      if (mode !== null) events.push(["apply", mode, testSettings.current.accountProxyMode]);
    },
    *taskRuntimeSteps(previous, next, changes) {
      yield ["publish", current => {
        assert.equal(current, next);
        assert.equal(testSettings.current, next);
        events.push(["publish", previous.accountProxyMode, next.accountProxyMode, changes]);
      }];
    },
    files: { ...fs, async rename(source, target) {
      if (rejectRename) throw new Error("fixture task write failed");
      return fs.rename(source, target);
    } },
    ...options,
  });
}
try {
  testSettings = create();
  await testSettings.load();
  assert.equal(testSettings.current.maxActiveJobs, 7);
  assert.equal(Object.hasOwn(testSettings.publicSettings(false), "proxyUrl"), false);
  await assert.rejects(testSettings.save({ codexAuthMode: "sub2api" }), { status: 409 });
  await assert.rejects(testSettings.save({ monitoring: { overloadConcurrency: 0 } }), { status: 400 });

  await Promise.all([
    testSettings.save({ maxActiveJobs: 8, monitoring: { overloadConcurrency: 12 }, accountProxyMode: "plan" }),
    testSettings.save({ proxyUrl: "http://127.0.0.1:18090", allowDirectFallback: true, monitoring: { usageTotalsConcurrency: 3 }, accountProxyMode: "global" }),
  ]);
  const committed = testSettings.current;
  assert.deepEqual(events.map(event => event.slice(0, 3)), [
    ["prepare", "plan", "global"], ["publish", "global", "plan"], ["apply", "plan", "plan"],
    ["prepare", "global", "plan"], ["publish", "plan", "global"], ["apply", "global", "global"],
  ]);
  assert.equal(committed.maxActiveJobs, 8);
  assert.equal(committed.monitoringSettings.overloadConcurrency, 12);
  assert.equal(committed.monitoringSettings.usageTotalsConcurrency, 3);
  assert.equal(testSettings.publicProxySettings().proxyUrl, "http://127.0.0.1:18090/");
  assert.equal(testSettings.publicProxySettings().allowDirectFallback, true);
  assert.equal(Object.hasOwn(testSettings.publicSettings(false), "proxyUrl"), false);

  const before = await fs.readFile(file);
  rejectRename = true;
  await assert.rejects(testSettings.save({ maxActiveJobs: 9 }), /fixture task write failed/);
  assert.equal(testSettings.current, committed);
  assert.deepEqual(await fs.readFile(file), before);
  rejectRename = false;
  rejectFingerprint = true;
  await assert.rejects(testSettings.save({ maxActiveJobs: 10, modelFingerprint: { intervalMinutes: 9 } }), /fixture fingerprint write failed/);
  assert.equal(testSettings.current, committed);
  assert.deepEqual(await fs.readFile(file), before, "linked save rollback must preserve exact bytes");
  const empty = path.join(root, "no-previous-file.json");
  const fresh = create({ file: empty });
  await assert.rejects(fresh.save({ maxActiveJobs: 10, modelFingerprint: { intervalMinutes: 9 } }), /fixture fingerprint write failed/);
  await assert.rejects(fs.access(empty), { code: "ENOENT" });
  rejectFingerprint = false;
  const pending = testSettings.save({ maxActiveJobs: 11, modelFingerprint: { intervalMinutes: 9 } });
  assert.equal(testSettings.close(), pending);
  await assert.rejects(testSettings.save({ maxActiveJobs: 12 }), { status: 503 });
  await pending;
  assert.equal(testSettings.publicSettings().modelFingerprint.intervalMinutes, 9);
  assert.deepEqual(await fs.readdir(root), ["task-settings.json"]);

  const legacy = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...legacy, version: 2, monitoring: { ...legacy.monitoring, overloadIntervalSeconds: 900 } }));
  const restarted = create();
  await restarted.load();
  assert.equal(restarted.current.maxActiveJobs, 11);
  assert.equal(restarted.current.monitoringSettings.overloadIntervalSeconds, 60);
  assert.equal(restarted.current.monitoringSettings.usageTotalsConcurrency, 3);
  assert.equal(restarted.publicProxySettings().allowDirectFallback, true);
  console.log("CONSOLE_SETTINGS_SERVICE_PASS serialized patches; proxy ordering; private projection; write and linked-save rollback; retry; shutdown drain; legacy reload");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
