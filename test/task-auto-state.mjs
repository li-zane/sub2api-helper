import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { accountMutationBlockReason } from "../web/src/account-action-state.mjs";
import { ROTATE_UPLOAD_ACTION, normalizeTaskUploadActions, toggleTaskAutoAction, isRedundantTaskUpload, isRedundantTaskAuthorization } from "../web/src/task-auto-actions.mjs";
import {
  hasJobTotpKey,
  isReauthorizationComplete,
  isTotpRotationComplete,
} from "../src/task-auto-state.mjs";

const internalCompletedRotation = {
  status: "completed",
  lastOperationType: "replace_2fa",
  totpSecret: "NB2W45DFOIZAQWER",
  hasTotpCredential: true,
  totpRotationIncomplete: false,
};
assert.equal(hasJobTotpKey(internalCompletedRotation), true);
assert.equal(isTotpRotationComplete(internalCompletedRotation), true);

const publicCompletedRotation = {
  status: "completed",
  lastOperationType: "replace_2fa",
  hasTotpKey: true,
  totpRotationIncomplete: false,
};
assert.equal(hasJobTotpKey(publicCompletedRotation), false);
assert.equal(isTotpRotationComplete(publicCompletedRotation), false);

assert.equal(isTotpRotationComplete({
  ...internalCompletedRotation,
  totpRotationIncomplete: true,
}), false);
assert.equal(isReauthorizationComplete({
  status: "completed",
  lastOperationType: "relogin",
  resultSaved: true,
}), true);
assert.equal(isReauthorizationComplete({
  status: "completed",
  lastOperationType: "relogin",
  resultSaved: false,
}), false);

console.log("task auto-state predicate smoke passed: internal job fields and subsequent stages");

const rotate = ROTATE_UPLOAD_ACTION, detection = "enable-overload-detection", cooldown = "enable-overload-cooldown";
for (const phase of ["pending", "running"]) assert(accountMutationBlockReason({ status: "completed", autoTaskStatus: phase }).includes("自动化任务"));
for (const actions of [["upload", rotate], [rotate, "upload"], [detection, "upload", rotate, cooldown]]) {
  const original = [...actions];
  assert.deepEqual(normalizeTaskUploadActions(actions), actions.filter(action => action !== "upload"));
  assert.deepEqual(actions, original, "normalization mutates input");
}
assert.deepEqual(normalizeTaskUploadActions(["authorize-codex", rotate, "upload"]), [rotate]);
assert.deepEqual(normalizeTaskUploadActions(["upload", detection]), ["upload", detection]);
assert.deepEqual(toggleTaskAutoAction(["upload", detection], rotate, true), [detection, rotate]);
assert.deepEqual(toggleTaskAutoAction([rotate, cooldown], "upload", true), [cooldown, "upload", "authorize-codex"]);
assert.deepEqual(toggleTaskAutoAction([rotate, detection], rotate, false), [detection]);
assert.deepEqual(toggleTaskAutoAction(["upload"], detection, true), ["upload", detection]);
assert.deepEqual(toggleTaskAutoAction([rotate, "upload"], cooldown, true), [rotate, cooldown]);

// Exercise the real runner with side effects replaced by local counters. Old
// pending queues must keep their saved cursor, including upload after rotation.
const source = await fs.readFile(new URL("../src/console-server.mjs", import.meta.url), "utf8");
const runnerSource = source.slice(source.indexOf("async function runConfiguredTaskActions(job) {"), source.indexOf("async function runConfiguredUploadAction(job) {"));
for (const [actions, index, expected] of [
  [["upload", rotate, detection, cooldown], 0, [rotate, detection, cooldown]],
  [[rotate, "upload"], 0, [rotate]],
  [["upload", rotate], 1, [rotate]],
  [[rotate, "upload"], 1, []],
  [["upload"], 0, ["upload"]],
  [[rotate], 0, [rotate]],
  [["authorize-codex", rotate, "upload", detection], 0, [rotate, detection]],
  [["authorize-codex", rotate], 1, [rotate]],
  [[rotate, "authorize-codex"], 1, []],
]) {
  const calls = [], logs = [];
  const run = vm.runInNewContext(runnerSource + "\nrunConfiguredTaskActions;", {
    isRedundantTaskUpload, isRedundantTaskAuthorization, accountAutomationBlocked: () => false, assertCodexMonitoringAllowed: async () => {},
    touch() {}, saveJobMetadata: async () => {},
    runConfiguredUploadAction: async () => calls.push("upload"),
    runConfiguredRotateAndUploadAction: async () => calls.push(rotate),
    withEmailJobLock: async (email, fn) => fn(),
    getJobPlanType: () => "team", taskAutoActionsForPlanType: () => [detection, cooldown],
    overloadMonitor: { setEnabled: async () => calls.push(detection), trigger() {} },
    overloadCooldown: { setEnabled: async () => calls.push(cooldown) },
    appendJobLog: (job, text) => logs.push(text), formatTaskAutoActions: list => list.join(","),
  });
  const job = { email: "fixture@example.test", status: "completed", autoTaskStatus: "pending", autoTaskActions: actions, autoTaskIndex: index };
  await run(job);
  assert.deepEqual(calls, expected, `incorrect execution for ${actions} at ${index}`);
  assert.equal(job.autoTaskStatus, "completed");
  assert.equal(job.autoTaskIndex, actions.length);
  assert.deepEqual(job.autoTaskActions, actions, "legacy cursor invalidated by queue rewriting");
  if (actions.slice(index).includes("upload") && actions.includes(rotate)) assert(logs.some(text => text.includes("跳过重复")));
}
console.log("TASK_UPLOAD_EXCLUSIVITY_PASS both toggle directions; normalize legacy configuration; skip duplicate uploads without changing resume indexes; preserve monitor tasks");
