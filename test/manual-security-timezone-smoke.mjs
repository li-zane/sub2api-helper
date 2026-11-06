import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
const repo = path.resolve(import.meta.dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-manual-security-"));
let mode = "enabled", calls = [], child, headers, log = "";
const provider = http.createServer((req, res) => {
  calls.push(req.method + " " + req.url); res.setHeader("content-type", "application/json");
  assert.equal(req.method, "GET", "manual checks must not mutate remote authentication");
  if (mode === "error") { res.statusCode = 503; return res.end('{}'); }
  if (req.url.endsWith("mfa_info")) return res.end(JSON.stringify({ mfa_enabled_v2: mode !== "disabled" }));
  if (req.url.includes("change_password")) return res.end(JSON.stringify({ eligible: mode === "enabled" }));
  if (req.url.includes("add_password")) return res.end(JSON.stringify({ eligible: mode === "disabled" }));
  res.end('{}');
});
await new Promise(r => provider.listen(0, "127.0.0.1", r));
const socket = http.createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r));
const port = socket.address().port; await new Promise(r => socket.close(r)); const base = `http://127.0.0.1:${port}`;
const wait = async fn => { for (const end = Date.now() + 20000; Date.now() < end;) { const value = await fn().catch(() => null); if (value) return value; await new Promise(r => setTimeout(r, 50)); } throw Error("timeout\n" + log); };
async function start() {
  child = spawn(process.execPath, [process.env.MANUAL_SECURITY_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: repo, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", TOSUB2_TEST_LEGACY_IMPORT: "", ONBOARDING_OUTPUT_ROOT: root, ONBOARDING_PROTOCOL_SCRIPT: repo + "/test/mock-webfirst-protocol.mjs", WEBFIRST_TRACE: root + "/trace.jsonl",
      LOCALAPPDATA: root, TOSUB2_MAC_CREDENTIAL_ROOT: root + "/credentials", TOSUB2_LINUX_CREDENTIAL_ROOT: root + "/credentials", TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0", TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: `http://127.0.0.1:${provider.address().port}` }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
  const boot = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; });
  headers = { "x-console-token": boot.token, "content-type": "application/json" }; return boot;
}
async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill(); await done; } }
async function api(url, body) { const r = await fetch(base + url, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
const get = async id => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
try {
  const boot = await start(); const created = await api("/api/jobs", { email: "manual-status@example.test", password: "Original-fixture!" });
  assert.equal(created.status, 201); const id = created.data.job.id;
  await wait(async () => { const j = await get(id); return j.status === "completed" && j.securityState?.passwordEnabled === true && j.securityState?.totpEnabled === true; });
  calls = []; await api(`/api/jobs/${id}/security-state?field=password`);
  if (process.argv.includes("--baseline")) {
    assert.equal(boot.taskSettings.displayTimeZone, undefined); assert(calls.some(p => p.includes("mfa_info")));
    assert(!/^\[\d{4}-\d\d-\d\dT.*Z\] /m.test((await api(`/api/jobs/${id}/logs`)).data.logs));
    console.log("BASELINE_MANUAL_SECURITY_TIMEZONE_REPRODUCED per_field_probe=false timezone_setting=false log_timestamps=false"); process.exitCode = 1;
  } else {
    assert.equal(boot.taskSettings.displayTimeZone, "Asia/Shanghai");
    assert(calls.some(p => p.includes("change_password"))); assert(!calls.some(p => p.includes("mfa_info")));
    const before = (await get(id)).securityState;
    mode = "disabled"; calls = []; let result = await api(`/api/jobs/${id}/security-state?field=totp`);
    assert.equal(result.status, 200); assert.equal(result.data.securityState.totpEnabled, false); assert.equal(result.data.securityState.passwordEnabled, true);
    assert.equal(result.data.securityState.passwordCheckedAt, before.passwordCheckedAt); assert.equal(calls.length, 1); assert(calls[0].includes("mfa_info"));
    calls = []; result = await api(`/api/jobs/${id}/security-state?field=password`); assert.equal(result.status, 200); assert.equal(result.data.securityState.passwordEnabled, false);
    assert.equal(calls.length, 2); assert(!calls.some(p => p.includes("mfa_info")));
    const preserved = (await get(id)).securityState;
    for (mode of ["ambiguous", "error"]) {
      result = await api(`/api/jobs/${id}/security-state?field=password`); assert(result.status >= 400); assert.deepEqual((await get(id)).securityState, preserved);
    }
    calls = []; assert.equal((await api(`/api/jobs/${id}/security-state?field=invalid`)).status, 400); assert.equal(calls.length, 0);
    assert.equal((await fetch(base + `/api/jobs/${id}/security-state?field=password`)).status, 403); assert.equal(calls.length, 0);
    assert(/^\[\d{4}-\d\d-\d\dT.*Z\] \[security\]/m.test((await api(`/api/jobs/${id}/logs`)).data.logs));
    assert.equal((await api("/api/task-settings", { displayTimeZone: "America/New_York" })).status, 200);
    for (const displayTimeZone of ["invalid/zone", "", null, 8, []]) assert.equal((await api("/api/task-settings", { displayTimeZone, maxActiveJobs: 7 })).status, 400);
    assert.equal((await api("/api/task-settings")).data.settings.displayTimeZone, "America/New_York");
    assert.equal((await api("/api/task-settings", { maxActiveJobs: 3 })).status, 200);
    assert.equal((await api("/api/task-settings")).data.settings.displayTimeZone, "America/New_York");
    await stop(); await start(); assert.equal((await api("/api/task-settings")).data.settings.displayTimeZone, "America/New_York");
    assert.deepEqual((await get(id)).securityState, preserved);
    const c = (await api(`/api/jobs/${id}/credentials`)).data.credentials; assert.equal(c.password, "Original-fixture!"); assert.equal((await get(id)).canDownload, false);
    mode = "enabled"; const banned = await api("/api/jobs", { email: "banned-account@example.test", password: "fixture" });
    await wait(async () => (await get(banned.data.job.id)).status === "banned"); calls = [];
    assert.equal((await api(`/api/jobs/${banned.data.job.id}/security-state?field=totp`)).status, 409); assert.equal(calls.length, 0);
    console.log("MANUAL_SECURITY_TIMEZONE_HTTP_PASS per-field read-only probes; remote tri-state and timestamps persisted; errors retain prior evidence; auth/ban/invalid guards; UTC log timestamps; IANA timezone default/validation/partial-update/restart; no password/OAuth changes");
  }
} finally { await stop(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); assert(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }); }
