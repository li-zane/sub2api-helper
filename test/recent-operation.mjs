import assert from "node:assert/strict";
import { recentOperation } from "../web/src/recent-operation.mjs";
import { setDisplayTimeZone } from "../web/src/display-time.mjs";

const labels = { completed: "已完成", canceled: "授权已取消", phone: "待手机号", working: "处理中", failed: "失败" };
const base = { createdAt: "2026-11-01T01:00:00Z", lastOperationAt: "2026-11-05T01:00:00Z", lastOperationType: "reauthorize", status: "phone", prompt: "请输入需要绑定的手机号" };
assert.equal(recentOperation(base, labels).result, "待手机号");
assert.equal(recentOperation(base, labels).tone, "pending");
assert.equal(recentOperation({ ...base, status: "working" }, labels).tone, "running");
assert.equal(recentOperation({ ...base, status: "completed" }, labels).tone, "success");
const raw = { error: { code: "account_deactivated", message: "provider response with full details", trace: "fixture-trace" } };
const failed = recentOperation({ ...base, status: "failed", lastError: JSON.stringify(raw) }, labels);
assert.equal(failed.result, "失败"); assert.equal(failed.tone, "error");
assert(failed.text.includes('"code": "account_deactivated"')); assert(failed.text.includes('"trace": "fixture-trace"'));

const web = { ...base, lastOperationType: "web_login", status: "canceled", webLoginCompletedAt: "2026-11-05T01:00:30Z", webLoginError: null };
assert.equal(recentOperation(web, labels).result, "已完成", "new Web success must not inherit canceled Codex status");
assert(!recentOperation(web, labels).text.includes("请输入需要绑定的手机号"));
assert.equal(recentOperation({ ...web, status: "completed", webLoginError: "HTTP 503: fixture" }, labels).result, "失败");
assert.equal(recentOperation({ ...web, webLoginCompletedAt: "2026-11-02T01:00:00Z" }, labels).result, "待确认", "old Web success is not this operation's result");
assert.equal(recentOperation({ ...web, webLoginPending: true, status: "phone" }, labels).result, "待手机号");
for (const type of ["credential_update", "proxy_update", "account_update", "workspace_switch"]) {
  const update = recentOperation({ ...base, lastOperationType: type, status: "failed", lastError: "unrelated prior failure" }, labels);
  assert.equal(update.result, "已更新"); assert(!update.text.includes("unrelated prior failure"));
}
assert.equal(recentOperation({ ...base, lastOperationType: "replace_2fa", status: "completed", totpSetupError: "fixture 2FA failure" }, labels).result, "失败");
assert.equal(recentOperation({ ...base, lastOperationType: "add_password", status: "completed", passwordAddError: raw }, labels).result, "失败");
const diagnostics = recentOperation({ ...base, webSessionMaintenancePause: { reason: "logout" }, webSessionRepairRetryAt: "2026-11-05T02:00:00Z", webSessionCheckError: "HTTP 503" }, labels);
assert.equal(recentOperation({ ...base, lastOperationType: "session_reset", status: "queued", sessionReset: { status: "cooling" } }, labels).result, "冷却中");
assert(diagnostics.text.includes("已主动登出")); assert(diagnostics.text.includes("Web 自动重登冷却中")); assert(diagnostics.text.includes("HTTP 503"));
const cooldown = { id: "cooldown-fixture", startedAt: "2026-11-16T03:13:00Z", until: "2026-11-16T09:13:00Z",
  cooldownMinutes: 360, status: "cooling", windowMinutes: 15, windowCount: 4, threshold: 4,
  historyCount: 7, historyMinutes: 90, historyThreshold: 12, triggerReason: "current", finishedAt: null };
const coolingJob = { ...base, status: "completed", lastError: "old unrelated login failure", overloadAutoCooldown: { operation: cooldown } };
let op = recentOperation(coolingJob, labels);
assert.equal(op.label, "过载冷却", "automatic overload cooling must appear as the recent operation");
assert.equal(op.result, "冷却中"); assert.equal(op.at, cooldown.startedAt); assert.equal(op.tone, "pending");
assert.equal(op.cooldown.duration, "360 分钟"); assert.equal(op.cooldown.timeLabel, "至"); assert.equal(op.cooldown.time, cooldown.until);
assert(op.text.includes("11:13:00") && op.text.includes("17:13:00") && op.text.includes("4 / 4"));
assert(!op.text.includes("old unrelated login failure"));
const loggingOut = recentOperation({ ...coolingJob, overloadAutoCooldown: { operation: { ...cooldown, status: "logging_out", until: null } } }, labels);
assert.equal(loggingOut.result, "登出设备中"); assert.equal(loggingOut.tone, "running"); assert.equal(loggingOut.cooldown.time, null);
const confirmedStart = "2026-11-16T03:13:30Z";
assert(recentOperation({ ...coolingJob, overloadAutoCooldown: { operation: { ...cooldown, coolingStartedAt: confirmedStart } } }, labels)
  .text.includes("冷却开始\n2026/11/16 11:13:30"), "recent operation did not show the confirmed post-logout start");
setDisplayTimeZone("UTC");
assert(recentOperation(coolingJob, labels).text.includes("03:13:00"), "cooldown detail ignored display time zone");
setDisplayTimeZone("Asia/Shanghai");
const completed = { ...cooldown, status: "completed", finishedAt: "2026-11-16T09:14:00Z", resumedAt: "2026-11-16T09:14:00Z", completionReason: "automatic" };
op = recentOperation({ ...coolingJob, overloadAutoCooldown: { operation: completed } }, labels);
assert.equal(op.result, "已恢复"); assert.equal(op.at, completed.resumedAt); assert.equal(op.tone, "success");
assert.equal(op.cooldown.timeLabel, "恢复于"); assert(op.text.includes("17:14:00"));
assert.equal(recentOperation({ ...coolingJob, lastOperationType: "credential_update", lastOperationAt: "2026-11-16T04:00:00Z" }, labels).type, "credential_update", "cooldown masked a newer unrelated operation");
const refreshing = { ...cooldown, status: "refreshing", resetRequestId: "reset-fixture", error: "CODEX_AUTH_FAILED" };
op = recentOperation({ ...coolingJob, lastOperationType: "automatic_relogin", lastOperationAt: "2026-11-16T09:13:01Z",
  sessionReset: { source: "cooldown", id: "reset-fixture" }, overloadAutoCooldown: { operation: refreshing } }, labels);
assert.equal(op.label, "过载冷却"); assert.equal(op.result, "恢复待重试"); assert.equal(op.tone, "error"); assert(op.text.includes("CODEX_AUTH_FAILED"));
assert.equal(recentOperation({ ...coolingJob, overloadAutoCooldown: { operation: { ...cooldown, status: "resuming" } } }, labels).result, "恢复中");
assert.equal(recentOperation({ ...coolingJob, overloadAutoCooldown: { operation: { ...completed, status: "manual_paused" } } }, labels).result, "保持暂停");
assert.equal(recentOperation({ ...coolingJob, overloadAutoCooldown: { operation: { ...completed, status: "blocked" } } }, labels).result, "封禁停用");
console.log("RECENT_OPERATION_PASS scoped Web/auth/security/update results; original response codes and JSON; stale-feedback isolation; diagnostics preserved");
console.log("COOLDOWN_OPERATION_UI_PASS cooling/duration/deadline; completed/resume time; original thresholds; display timezone; unrelated newer operation; linked reauthorization; failure and manual/ban outcomes");
