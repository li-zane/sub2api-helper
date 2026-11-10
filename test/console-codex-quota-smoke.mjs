import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
const repo = path.resolve(import.meta.dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-quota-http-"));
const oldTime = new Date(Date.now() - 60000).toISOString();
const records = [
  { id: 1, email: "exhausted@example.test", extra: { codex_5h_used_percent: 100 } },
  { id: 2, email: "overage@example.test", extra: { codex_5h_used_percent: 5, codex_credits_snapshot: { credits: { balance: "50", overage_limit_reached: true } } } },
  { id: 3, email: "disabled@example.test", schedulable: false },
  { id: 4, email: "duplicate@example.test", extra: { codex_5h_used_percent: 100 } },
  { id: 5, email: "manual@example.test", extra: { codex_5h_used_percent: 20 } },
  { id: 6, email: "zero@example.test", extra: { codex_5h_used_percent: 0, codex_credits_snapshot: { credits: { balance: "0", unlimited: true } } } },
  { id: 7, email: "duplicate@example.test", extra: { codex_5h_used_percent: 10 } },
  { id: 8, email: "rate@example.test", rate_limit_reset_at: new Date(Date.now() + 3600000).toISOString(), extra: { codex_5h_used_percent: 10 } },
].map(r => ({ platform: "openai", type: "oauth", status: "active", schedulable: true, proxy_id: 0, group_ids: [], ...r, name: r.email, credentials: { email: r.email, plan_type: "free", access_token: "fixture", refresh_token: "fixture" }, extra: { codex_usage_updated_at: oldTime, ...r.extra } }));
const calls = []; let manualLimited = false, child, headers, log = "";
const pool = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const u = new URL(req.url, "http://fixture"); calls.push({ path: u.pathname, query: u.search, method: req.method });
  res.setHeader("content-type", "application/json"); const send = data => res.end(JSON.stringify({ code: 0, data }));
  if (u.pathname === "/api/v1/admin/accounts") return send({ items: records, total: records.length, pages: 1 });
  if (u.pathname.endsWith("/proxies/all") || u.pathname.endsWith("/groups/all")) return send([]);
  if (u.pathname.includes("/ops/")) return send({ items: [], total: 0, pages: 1 });
  if (u.pathname.endsWith("/usage")) return send({ allowed: !manualLimited, limit_reached: manualLimited, updated_at: new Date().toISOString() });
  if (u.pathname.endsWith("/quota/refresh")) return send({ rate_limit_reset_credits: { available_count: 0 } });
  if (u.pathname === "/api/v1/admin/usage/stats") return send({ total_account_cost: 2, total_actual_cost: 1, total_tokens: 100 });
  const record = records.find(r => u.pathname === `/api/v1/admin/accounts/${r.id}`); if (record) return send(record);
  res.statusCode = 404; send({});
});
await new Promise(r => pool.listen(0, "127.0.0.1", r));
const listener = http.createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r)); const port = listener.address().port; await new Promise(r => listener.close(r)); const base = `http://127.0.0.1:${port}`;
const ids = new Map(), wait = async fn => { for (const end = Date.now() + 20000; Date.now() < end;) { const value = await fn().catch(() => null); if (value) return value; if (child?.exitCode != null) throw Error(log); await new Promise(r => setTimeout(r, 50)); } throw Error("quota fixture timeout\n" + log); };
async function start() {
  child = spawn(process.execPath, [process.env.CODEX_QUOTA_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: root + "/credentials", TOSUB2_MAC_CREDENTIAL_ROOT: root + "/credentials", TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0", TOSUB2_FINGERPRINT_TEST_URL: `http://127.0.0.1:${pool.address().port}/sample` } });
  child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
  const boot = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; }); headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { const end = new Promise(r => child.once("exit", r)); child.kill(); await end; } }
async function api(url, body) { const r = await fetch(base + url, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
const find = async email => (await api("/api/jobs")).data.jobs.find(j => j.email === email);
try {
  const emails = [...new Set(records.map(r => r.email)), "orphan@example.test"];
  const monitors = {}, cooldown = {}, fingerprints = {};
  for (const [i, email] of emails.entries()) {
    const id = `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`, dir = root + "/" + id; ids.set(email, id); await fs.mkdir(dir);
    await fs.writeFile(dir + "/job-meta.json", JSON.stringify({ version: 1, email, status: "completed", result_saved: true, plan_type: "free", created_at: oldTime, completed_at: oldTime }));
    await fs.writeFile(dir + "/sub2api-import-oauth.json", JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, plan_type: "free", access_token: "fixture", refresh_token: "fixture" } }] }));
    const enabled = !["manual@example.test", "zero@example.test"].includes(email);
    monitors[email] = { enabled }; cooldown[email] = { enabled }; fingerprints[email] = { override: { enabled: email === "exhausted@example.test" ? null : enabled }, result: null };
  }
  await fs.writeFile(root + "/sub2api-settings.json", JSON.stringify({ version: 2, config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture", groupIds: [] }, profiles: [{ id: "default", name: "Default" }], activeProfileId: "default" }));
  await fs.writeFile(root + "/overload-monitor.json", JSON.stringify({ version: 1, accounts: monitors }));
  await fs.writeFile(root + "/overload-cooldown.json", JSON.stringify({ version: 1, accounts: cooldown }));
  await fs.writeFile(root + "/model-fingerprint.json", JSON.stringify({ version: 1, settings: { planDefaults: { free: true } }, accounts: fingerprints }));
  await start(); await api("/api/sub2api/account-status?refresh=1"); const quota = await find("exhausted@example.test");
  if (process.argv.includes("--baseline")) {
    assert.equal(quota.sub2apiUsage.limitReached, true); assert.equal(quota.codexStatusEligible, true); assert.equal(quota.overloadDetection.enabled, true);
    console.log("BASELINE_CODEX_QUOTA_REPRODUCED usage_limit_reached=true codex_eligible=true overload_switch=true"); process.exitCode = 1;
  } else {
    for (const email of ["exhausted@example.test", "overage@example.test", "duplicate@example.test", "disabled@example.test", "orphan@example.test", "rate@example.test"]) {
      const job = await find(email); assert.equal(job.codexStatusEligible, false, email); assert.equal(job.overloadDetection.enabled, false); assert.equal(job.overloadAutoCooldown.enabled, false); assert.equal(job.modelFingerprint.enabled, false);
      for (const action of ["overload-detection", "overload-auto-cooldown", "model-fingerprint", "model-fingerprint/check"]) assert.equal((await api(`/api/jobs/${job.id}/${action}`, { enabled: true })).status, 409, email + "/" + action);
    }
    for (const file of ["overload-monitor.json", "overload-cooldown.json"]) { const data = JSON.parse(await fs.readFile(root + "/" + file, "utf8")); assert.equal(data.accounts["exhausted@example.test"].enabled, true, "QUOTA_PAUSE must preserve configured switches"); }
    assert.equal(JSON.parse(await fs.readFile(root + "/model-fingerprint.json", "utf8")).accounts["exhausted@example.test"].override.enabled, null, "quota pause overwrote inherited plan policy");
    await stop(); await start(); await api("/api/sub2api/account-status?refresh=1"); assert.equal((await find("exhausted@example.test")).codexStatusEligible, false, "restart bypassed quota pause");
    assert.equal((await find("zero@example.test")).codexStatusEligible, true, "zero monetary balance was treated as exhausted");
    assert.equal((await find("duplicate@example.test")).sub2apiUsage.quotaRestricted, true, "duplicate-email quota gate was not published to the usage label");
    assert(!calls.some(c => c.path.includes("/ops/") && ["1", "2", "3", "4", "7", "8"].includes(new URLSearchParams(c.query).get("account_id"))), "restricted/disabled account was probed");
    assert(!calls.some(c => /sample|relogin|oauth|schedulable/.test(c.path) || c.method === "PUT"), "quota gating mutated account/IP/auth state or sampled a model");
    const manual = await find("manual@example.test");
    assert.equal((await api(`/api/jobs/${manual.id}/overload-detection`, { enabled: true })).status, 200);
    manualLimited = true; const refreshed = await api(`/api/jobs/${manual.id}/usage?refresh=1`); assert.equal(refreshed.status, 200); assert.equal(refreshed.data.usage.allowed, false); assert.equal(refreshed.data.usage.limitReached, true); assert.equal(refreshed.data.job.codexStatusEligible, false);
    assert.equal((await api(`/api/jobs/${manual.id}/model-fingerprint/check`, {})).status, 409);
    assert(calls.some(c => c.path.endsWith("/5/usage")), "manual usage refresh was blocked");
    const overage = await find("overage@example.test");
    for (const action of ["overload-detection", "overload-auto-cooldown", "model-fingerprint"]) assert.equal((await api(`/api/jobs/${overage.id}/${action}`, { enabled: false })).status, 200, "manual disable during quota pause failed");
    records[0].extra = { codex_5h_used_percent: 0, codex_usage_updated_at: new Date().toISOString() };
    records[0].status = "error"; records[0].error_message = 'HTTP 402: {"error":{"code":"deactivated_workspace","message":"workspace disabled"}}'; await api("/api/sub2api/account-status?refresh=1");
    assert.equal((await find("exhausted@example.test")).codexStatusEligible, false, "quota reset resumed an account with workspace error");
    records[0].status = "active"; records[0].error_message = null; await api("/api/sub2api/account-status?refresh=1");
    const reset = await find("exhausted@example.test"); assert.equal(reset.codexStatusEligible, true); assert.equal(reset.overloadDetection.enabled, true); assert.equal(reset.overloadAutoCooldown.enabled, true); assert.equal(reset.modelFingerprint.enabled, true); assert.equal(reset.modelFingerprint.override.enabled, null);
    records[1].extra = { codex_5h_used_percent: 0, codex_credits_snapshot: { credits: { overage_limit_reached: false } }, codex_usage_updated_at: new Date().toISOString() };
    records[7].rate_limit_reset_at = new Date(Date.now() - 1000).toISOString(); await api("/api/sub2api/account-status?refresh=1");
    const manualOff = await find("overage@example.test"); assert.equal(manualOff.codexStatusEligible, true); assert.equal(manualOff.overloadDetection.enabled, false); assert.equal(manualOff.overloadAutoCooldown.enabled, false); assert.equal(manualOff.modelFingerprint.enabled, false);
    assert.equal((await find("rate@example.test")).overloadDetection.enabled, true);assert.equal((await find("rate@example.test")).modelFingerprint.enabled, true);
    assert.equal((await find("duplicate@example.test")).codexStatusEligible, false, "one healthy duplicate cleared another row's limit");
    manualLimited = false; const manualReset = await api(`/api/jobs/${manual.id}/usage?refresh=1`);assert.equal(manualReset.data.job.overloadDetection.enabled, true, "manual usage recovery failed to resume previous switch");assert.equal(manualReset.data.job.modelFingerprint.enabled, false, "manual-off fingerprint unexpectedly enabled");
    await stop(); await start(); await api("/api/sub2api/account-status?refresh=1"); const restored = await find("exhausted@example.test"); assert.equal(restored.overloadDetection.enabled, true); assert.equal(restored.overloadAutoCooldown.enabled, true); assert.equal(restored.modelFingerprint.enabled, true); assert.equal(restored.modelFingerprint.override.enabled, null);
    assert.equal((await find("overage@example.test")).overloadDetection.enabled, false);
    console.log("CODEX_QUOTA_HTTP_PASS temporary_pause=true configured_switches_preserved=true inherited_plan_preserved=true auto_resume=true restart=true rate_limit_resume=true manual_off_preserved=true duplicate_restricted=true manual_usage_resume=true no_pool_IP_OAuth_mutations=true");
  }
} finally { await stop(); pool.closeAllConnections(); await new Promise(r => pool.close(r)); assert(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
