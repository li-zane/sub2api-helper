import assert from "node:assert/strict";
import { logoutAccountSessions, proxySwitchSelectionState } from "../web/src/account-session-actions.mjs";

const balancedReady = { id: "balanced", canSwitchProxy: true, canLogoutAllSessions: true, canForceRelogin: true };
const directReady = { id: "direct", assignedProxyId: 7, canSwitchProxy: true, canLogoutAllSessions: true, canForceRelogin: true };
const noTarget = { ...directReady, id: "keep-current", canSwitchProxy: false };
const running = { ...balancedReady, id: "running", canLogoutAllSessions: false, canForceRelogin: false };
const switchOptions = { mode: "plan", proxySettingsDirty: false, sub2apiReady: true };
const mixed = proxySwitchSelectionState([balancedReady, directReady, running], switchOptions);
assert.equal(mixed.canSwitch, true, "mixed selection enables the action for eligible accounts only");
assert.deepEqual(mixed.eligible.map((job) => job.id), ["balanced", "direct"]);
assert.equal(mixed.skippedCount, 1);
assert.match(mixed.reason, /2.*1/);
assert.equal(proxySwitchSelectionState([directReady], switchOptions).canSwitch, true, "direct plan can replace a historical proxy binding");
assert.match(proxySwitchSelectionState([directReady], switchOptions).reason, /当前方案/);
assert.equal(proxySwitchSelectionState([noTarget], switchOptions).canSwitch, false);
assert.match(proxySwitchSelectionState([noTarget], switchOptions).reason, /未指定切换目标/);
assert.match(proxySwitchSelectionState([running], switchOptions).reason, /运行|授权/);
assert.match(proxySwitchSelectionState([balancedReady], { ...switchOptions, mode: "global" }).reason, /任务设置/);
assert.match(proxySwitchSelectionState([balancedReady], { ...switchOptions, proxySettingsDirty: true }).reason, /保存/);
assert.match(proxySwitchSelectionState([balancedReady], { ...switchOptions, sub2apiReady: false }).reason, /Sub2API/);
assert.equal(proxySwitchSelectionState([], switchOptions).canSwitch, false);
assert.equal(proxySwitchSelectionState([balancedReady], { ...switchOptions, selectedCount: 2 }).canSwitch, false, "incomplete selection must finish synchronizing first");
assert.equal(proxySwitchSelectionState([{ ...balancedReady, canSwitchProxy: undefined }], switchOptions).canSwitch, false, "missing eligibility must not grant a switch");

const jobs = Array.from({ length: 8 }, (_, index) => ({ id: `selected-${index}`, email: `selected-${index}@example.test` }));
const requests = [];
const progress = [];
let active = 0;
let peak = 0;
const results = await logoutAccountSessions(jobs, async (url, options) => {
  requests.push({ url, options });
  peak = Math.max(peak, ++active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (url.includes("selected-1/")) throw new Error("mock account failure");
  } finally {
    active--;
  }
}, (done, total) => progress.push([done, total]));
assert.equal(peak, 3);
assert.equal(requests.length, jobs.length);
assert.ok(requests.every(({ url, options }) => jobs.some((job) => url === `/api/jobs/${job.id}/sessions/logout-all`) && options.method === "POST"));
assert.deepEqual(results.map(({ job }) => job.id), jobs.map((job) => job.id));
assert.equal(results.filter(({ ok }) => ok).length, 7);
assert.equal(results[1].error, "mock account failure");
assert.deepEqual(progress, jobs.map((_, index) => [index + 1, jobs.length]));
assert.deepEqual(await logoutAccountSessions([], () => assert.fail("empty selection made request")), []);
await logoutAccountSessions([{ id: "id/with space" }], async (url) => {
  assert.equal(url, "/api/jobs/id%2Fwith%20space/sessions/logout-all");
});
console.log("account session bulk actions passed: selected-only, concurrency=3, partial failure, progress, empty selection, URL encoding");
