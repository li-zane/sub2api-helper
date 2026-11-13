import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { readJsonResponse, workspaceFailureTooltip } from "../web/src/response-errors.js";

const root = path.resolve(process.env.WORKSPACE_REPAIR_ROOT || ".");
const load = file => import(pathToFileURL(path.join(root, file)));
let monitor, temporary;
try {
  const { normalizeAccountWorkspaces } = await load("src/account-sessions.mjs");
  const { identifyWebPlan, pickWorkspaceId, selectChatgptLoginWorkspaceIfNeeded } = await load("src/protocol-login.mjs");
  const team = { account_id: "team", structure: "workspace", plan_type: "business" };
  const personal = { account_id: "personal", structure: "personal", plan_type: "free" };
  let payload = { accounts: { team: { account: team }, personal: { account: personal }, alias: { account: personal } } };
  assert.equal(normalizeAccountWorkspaces(payload).workspaces.length, 2, "duplicate workspace IDs must collapse");
  const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "personal", plan_type: "free" } })).toString("base64url")}.signature`;
  const client = { async getJson(_method, url) { return { data: url.endsWith("/api/auth/session") ? { accessToken: token } : payload }; } };
  const options = { chatgptBase: "http://fixture", web: { workspaceId: "personal" }, preferTeam: true, allowPersonalFallback: true };
  assert.deepEqual(await identifyWebPlan(client, options), { workspaceId: "team", planType: "business" });
  // Explicit non-login selection still stays on the chosen personal workspace.
  assert.equal((await identifyWebPlan(client, { ...options, preferTeam: false })).workspaceId, "personal");
  payload.accounts.team.account = { ...team, is_deactivated: true, error: { code: "workspace_deactivated", message: "组织已停用" } };
  assert.deepEqual(await identifyWebPlan(client, { ...options, web: { workspaceId: "team" } }), { workspaceId: "personal", planType: "free" });
  const disabled = normalizeAccountWorkspaces(payload).workspaces.find(w => w.id === "team");
  assert.equal(disabled.availabilityCode, "workspace_deactivated");
  assert.match(workspaceFailureTooltip(disabled, "空间已停用"), /错误代码：workspace_deactivated/);
  assert.match(workspaceFailureTooltip(disabled), /组织已停用/);
  assert.match(workspaceFailureTooltip({}), /未提供错误代码/);
  const wrappedError = normalizeAccountWorkspaces({ accounts: [{ ...team, status_code: 200, error: { code: "workspace_deactivated" } }] }).workspaces[0];
  assert.equal(wrappedError.availabilityCode, "workspace_deactivated", "outer success status must not mask the actual error code");
  payload.accounts.otherTeam = { account: { ...team, account_id: "other-team" } };
  assert.equal((await identifyWebPlan(client, options)).workspaceId, "other-team", "try another available team before personal");
  payload.accounts.teamAlias = { account: { ...team, account_id: "other-team", can_access_with_session: false } };
  assert.equal((await identifyWebPlan(client, options)).workspaceId, "personal", "a duplicate must not erase denied access");
  payload.accounts.secondPersonal = { account: { ...personal, account_id: "different-personal" } };
  await assert.rejects(identifyWebPlan(client, { ...options, web: { workspaceId: "team" } }), /WEB_PLAN_UNAVAILABLE/, "distinct personal accounts remain ambiguous");
  assert.equal(pickWorkspaceId({ "oai-client-auth-session": { workspaces: [
    { id: "dead", kind: "organization", is_deactivated: true },
    { id: "personal", kind: "personal" }, { id: "live", kind: "organization" },
  ] } }), "live");
  assert.equal(pickWorkspaceId({ "oai-client-auth-session": { workspaces: [
    { id: "dead", kind: "organization", error_code: "workspace_deactivated" }, { id: "personal", kind: "personal" },
  ] } }), "personal");
  const loginPayload = { page: { type: "workspace" }, "oai-client-auth-session": { workspaces: [
    { id: "personal", kind: "personal" }, { id: "team", kind: "organization" },
  ] } };
  let attempted = [];
  const selector = { async getJson(_method, _url, opts) {
    attempted.push(opts.json.workspace_id);
    if (opts.json.workspace_id === "team") throw new Error('POST failed with HTTP 402: {"code":"workspace_deactivated"}');
    return { data: { page: { type: "external_url" } } };
  } };
  const selectionResult = await selectChatgptLoginWorkspaceIfNeeded(selector, { authBase: "http://fixture", payload: loginPayload });
  assert.equal(selectionResult.workspaceId, "personal"); assert.deepEqual(attempted, ["team", "personal"]);
  payload = { accounts: [team, personal] };
  const discoveryAfterFallback = { ...client, unavailableLoginWorkspaceIds: selector.unavailableLoginWorkspaceIds };
  assert.equal((await identifyWebPlan(discoveryAfterFallback, options)).workspaceId, "personal", "do not immediately reselect a team explicitly rejected in the same login");
  for (const message of ['HTTP 503: workspace_deactivated', 'HTTP 401: workspace_deactivated', 'HTTP 403: security check', 'network timeout']) {
    attempted = [];
    const broken = { async getJson(_method, _url, opts) { attempted.push(opts.json.workspace_id); throw new Error(message); } };
    await assert.rejects(selectChatgptLoginWorkspaceIfNeeded(broken, { authBase: "http://fixture", payload: loginPayload }));
    assert.deepEqual(attempted, ["team"], "transient/auth errors must not fall back");
  }

  const main = await fs.readFile(path.join(root, "web/src/main.jsx"), "utf8");
  const read = main.slice(main.indexOf("async function readResponse("), main.indexOf("function shortId("));
  const readResponse = vm.runInNewContext(read + "\nreadResponse;", { readJsonResponse, Error });
  await assert.rejects(readResponse(new Response("<!DOCTYPE html><title>bad gateway</title>", { status: 502 })), e => /HTTP 502/.test(e.message) && !/Unexpected token|DOCTYPE/.test(e.message));
  await assert.rejects(readResponse(new Response(JSON.stringify({ error: "HTTP 402: Payment Required" }), { status: 502 })), /HTTP 402: Payment Required/);
  await assert.rejects(readResponse(new Response("", { status: 503 })), /HTTP 503/);
  await assert.rejects(readResponse(new Response("<html>challenge</html>", { status: 200 })), /HTTP 200/);
  assert.deepEqual(await readResponse(new Response('{"ok":true}')), { ok: true });
  assert.match(main, /title=\{failureTooltip\}/, "disabled workspace card must expose its diagnostic on hover");
  const protocol = await fs.readFile(path.join(root, "src/protocol-login.mjs"), "utf8");
  assert.match(protocol, /if \(args\.webOnly\) \{\s*await selectCodexProxy\(\)/, "ordinary Web login uses team preference too");
  const selection = protocol.slice(protocol.indexOf("async function selectCodexProxy()"), protocol.indexOf("let resumedOAuth"));
  assert.match(selection, /identifyWebPlan[\s\S]*?preferTeam: true/, "shared selector prefers available team");
  assert(!/if \(process\.env\.TOSUB2_PHASED_PROXY !== "1"[^\n]*return;\s*const identity/.test(selection), "non-phased logins must select the workspace too");

  const server = await fs.readFile(path.join(root, "src/console-server.mjs"), "utf8");
  const admission = server.slice(server.indexOf("function canLoginWeb("), server.indexOf("function canSetupTotp("));
  const canLoginWeb = vm.runInNewContext(admission + "\ncanLoginWeb;", { accountAutomationBlocked: () => false,
    activeSessionReset: job => job.sessionResetPending === true,
    webSessionCheckPending: job => job.webSessionCheckPending === true });
  const job = { email: "fixture@example.test", status: "failed", poolRefreshAction: "relogin", poolRefreshError: "WEB_PLAN_UNAVAILABLE", poolRefreshReady: false };
  assert.equal(canLoginWeb(job), false, "manual Web login remains guarded");
  assert.equal(canLoginWeb(job, { maintenance: true }), true, "failed refresh must not block maintenance forever");
  assert.equal(canLoginWeb({ ...job, webSessionCheckPending: true }, { maintenance: true }), false, "queued manual check must exclude scheduled maintenance");
  assert.equal(canLoginWeb({ ...job, sessionResetPending: true }), false, "manual Web login must not compete with session reset");
  assert.equal(canLoginWeb({ ...job, sessionResetPending: true }, { maintenance: true }), false, "scheduled Web maintenance must not compete with session reset");
  for (const patch of [{ child: {} }, { status: "running" }, { poolRefreshReady: true }, { poolRefreshError: null }, { autoTaskStatus: "running" }, { autoRepairOperation: {} }]) assert.equal(canLoginWeb({ ...job, ...patch }, { maintenance: true }), false);
  assert.match(server, /isBusy: job =>[^\n]*canLoginWeb\(job, \{ maintenance: true \}\)/);
  const { WebSessionMonitor } = await load("src/web-session-monitor.mjs");
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-repair-"));
  let now = Date.now(), repairs = 0;
  monitor = new WebSessionMonitor({ filePath: path.join(temporary, "monitor.json"), now: () => now, getSettings: () => ({ enabled: true, intervalMinutes: 15, retryMinutes: 60, autoRelogin: true }), listJobs: () => [job], hasSession: () => true, isBusy: j => !canLoginWeb(j, { maintenance: true }), probe: async () => ({ repairReason: "workspace_unavailable" }), repair: async () => { repairs++; }, retryDelayMs: 0 });
  await monitor.run(); assert.equal(repairs, 1);
  await monitor.repairFinished(job.email, { success: false });
  assert.equal(monitor.snapshot().accounts[job.email].status, "needs_attention");
  await monitor.run({ force: true }); assert.equal(repairs, 1, "failed repair still observes retry cooldown");
  assert.equal(monitor.snapshot().accounts[job.email].status, "retry_wait");
  now += 61 * 60_000; await monitor.run(); assert.equal(repairs, 2);
  await monitor.repairFinished(job.email); assert.equal(monitor.snapshot().accounts[job.email].status, "pending_check");
  console.log("WORKSPACE_REPAIR_PASS dedupe; team-first; inactive-personal-fallback; hover-code; HTML-errors; stale-refresh-recovery; cooldown");
} catch (error) {
  console.error("WORKSPACE_REPAIR_FAIL: " + error.message.split("\n")[0]); process.exitCode = 1;
} finally { await monitor?.stop(); if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
