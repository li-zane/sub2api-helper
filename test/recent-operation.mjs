import assert from "node:assert/strict";
import { recentOperation } from "../web/src/recent-operation.mjs";

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
console.log("RECENT_OPERATION_PASS scoped Web/auth/security/update results; original response codes and JSON; stale-feedback isolation; diagnostics preserved");
