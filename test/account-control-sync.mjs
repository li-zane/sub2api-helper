import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

try {
  const source = await fs.readFile(process.env.ACCOUNT_CONTROL_SYNC_MAIN || "web/src/main.jsx", "utf8");
  const start = source.indexOf("function sub2ApiStatusJobFields(status) {");
  const end = source.indexOf("\nfunction mergeJobs(", start);
  assert(start >= 0 && end > start, "status merge functions missing");
  const context = { usageRestricted: () => false, shareSnapshot: (_, next) => next };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const status = { inPool: true, accountBlocked: true, accountBlockReason: "account_deactivated", usage: { totals: { tokens: 2048 } } };
  const state = { fetchedAt: "2026-11-07T00:00:00Z", accounts: { "blocked@example.test": status } };
  const ready = { id: "fixture", email: "blocked@example.test", status: "completed", canLoginWeb: true,
    canForceRelogin: true, canRegenerate: true, canRetry: true, canResume: true, canDownload: true,
    webSessionAvailable: true, webLoginPending: false, remark: "local", updatedAt: "2026-11-07T01:00:00Z" };
  const merged = context.mergeSub2ApiStatusIntoJob(ready, state);
  assert.equal(merged.canLoginWeb, true, "pool ban must preserve backend-approved manual Web login");
  for (const flag of ["canForceRelogin", "canRegenerate", "canRetry", "canResume"]) {
    assert.equal(merged[flag], false, `pool ban must clear stale ${flag}`);
  }
  const fields = context.sub2ApiStatusJobFields(status);
  assert(!Object.hasOwn(fields, "canLoginWeb"), "pool status must not invent login readiness");
  for (const busy of [
    { status: "working", canLoginWeb: false },
    { webLoginPending: true, canLoginWeb: false },
    { webSessionCheckPending: true, canLoginWeb: false },
    { autoTaskStatus: "queued", canLoginWeb: false },
    { canLoginWeb: undefined },
  ]) {
    assert.equal(context.mergeSub2ApiStatusIntoJob({ ...ready, ...busy }, state).canLoginWeb, busy.canLoginWeb, "busy/unknown readiness must stay unchanged");
  }
  assert.equal(merged.webSessionAvailable, true);
  assert.equal(merged.canDownload, true, "manual data access must not be disabled");
  assert.equal(merged.sub2apiUsage.totals.tokens, 2048);
  assert.equal(ready.canForceRelogin, true, "source job mutated");
  const healthy = context.mergeSub2ApiStatusIntoJob(ready, { ...state, accounts: { "blocked@example.test": { inPool: true } } });
  assert.equal(healthy.canLoginWeb, true);assert.equal(healthy.canForceRelogin, true);
  const absent = context.mergeSub2ApiStatusIntoJob(ready, { ...state, accounts: {} });
  assert.equal(absent.canLoginWeb, true);assert.equal(absent.canForceRelogin, true);
  assert.equal(context.mergeSub2ApiStatusIntoJob(ready, {}), ready);
  console.log("ACCOUNT_CONTROL_SYNC_PASS manual_web_preserved=true oauth_flags_cleared=4 busy_readiness_preserved=5 manual_usage_preserved=true healthy_unchanged=true");
} catch (error) {
  console.error("ACCOUNT_CONTROL_SYNC_FAIL: " + error.message.split("\n")[0]);
  process.exitCode = 1;
}
