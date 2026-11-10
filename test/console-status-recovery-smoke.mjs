import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createCredentialStore } from "../src/credential-store.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-status-recovery-")), trace = path.join(root, "attempts.jsonl");
let child, headers, logs = "", filteredLists = 0, fullLists = 0, incomplete = false, status = "active";
const email = "immediate@example.test", id = "11111111-1111-4111-8111-111111111111";
const remote = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture"); res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/v1/admin/accounts") {
    if (url.searchParams.has("status")) filteredLists++; else fullLists++;
    if (incomplete) return res.end(JSON.stringify({ data: { message: "incomplete fixture", pages: 1 } }));
    return res.end(JSON.stringify({ data: { items: [{ id: 7, name: email, platform: "openai", type: "oauth", schedulable: true, status,
      error_message: status === "error" ? "refresh token expired" : null, credentials: { email, plan_type: "free" }, group_ids: [] }], total: 1, pages: 1 } }));
  }
  if (url.pathname.endsWith("/all")) return res.end("[]");
  res.end(JSON.stringify({ data: { items: [], total: 0 } }));
});
async function listen(server) { do { await new Promise(r => server.listen(0, "127.0.0.1", r)); if (server.address().port > 10080) return server.address().port; await new Promise(r => server.close(r)); } while (true); }
const remotePort = await listen(remote), slot = http.createServer(), port = await listen(slot); await new Promise(r => slot.close(r));
const base = `http://127.0.0.1:${port}`, config = { baseUrl: `http://127.0.0.1:${remotePort}`, adminApiKey: "fixture" };
const wait = async fn => { for (const end = Date.now() + 15000; Date.now() < end;) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw Error("timed out\n" + logs); };
const get = async url => { const r = await fetch(base + url, { headers }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const post = async (url, body) => { const r = await fetch(base + url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const attempts = async () => (await fs.readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
const job = async () => (await get("/api/jobs")).jobs.find(j => j.id === id);
try {
  await fs.mkdir(path.join(root, id));
  await fs.writeFile(path.join(root, id, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", result_saved: true, created_at: "2026-11-01T00:00:00Z", last_auth_automated: true, last_auth_requirements: { password: true } }));
  await fs.writeFile(path.join(root, id, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, plan_type: "free", access_token: "fixture", refresh_token: "fixture" } }] }));
  await createCredentialStore({ windowsRoot: path.join(root, "toSub2/credentials"), linuxRoot: path.join(root, "credentials"), linuxKey: "ab".repeat(32) }).save(email, { password: "Fixture-123!" });
  await fs.writeFile(path.join(root, "task-settings.json"), JSON.stringify({ version: 3, maxActiveJobs: 4, monitoring: { accountStatusIntervalSeconds: 1, poolRepairRetrySeconds: 300, poolMonitorIntervalSeconds: 86400, overloadCooldownIntervalSeconds: 2 } }));
  const mock = path.join(root, "mock.mjs");
  await fs.writeFile(mock, `import fs from 'node:fs/promises';await fs.appendFile(${JSON.stringify(trace)},Date.now()+'\\n');console.error('[error] fixture authorization temporarily unavailable');process.exitCode=1;`);
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), ONBOARDING_PROTOCOL_SCRIPT: mock, SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", d => { logs += d; }); child.stderr.on("data", d => { logs += d; });
  await wait(async () => { try { const b = await fetch(base + "/api/bootstrap").then(r => r.json()); headers = { "x-console-token": b.token }; return Boolean(b.token); } catch { return false; } });
  await post("/api/sub2api/monitor", { config, enabled: true });
  await get("/api/sub2api/account-status?refresh=1"); await wait(async () => !(await get("/api/sub2api/monitor")).running);
  assert.equal((await attempts()).length, 0);
  const beforeLists = fullLists, started = Date.now(); status = "error";
  // A normal scheduled status refresh alone must authorize; never call monitor/check.
  await wait(async () => (await attempts()).length === 1);
  assert(Date.now() - started < 5000, "recovery waited for retired 86400s monitor interval");
  await wait(async () => ["failed", "completed"].includes((await job()).status));
  await post("/api/task-settings", { monitoring: { accountStatusIntervalSeconds: 3600 } });
  const listsBeforeParallel = fullLists;
  await Promise.all(Array.from({ length: 5 }, () => get("/api/sub2api/account-status?refresh=1")));
  await wait(async () => !(await get("/api/sub2api/monitor")).running);
  assert.equal((await attempts()).length, 1, "pending/failed retry interval must suppress duplicate login");
  assert.equal(filteredLists, 0, "recovery must use complete status snapshot without another error-only query");
  assert.equal(fullLists - listsBeforeParallel, 1, "five refresh callers and recovery share one account-list read");
  assert(fullLists > beforeLists);
  const monitor = await get("/api/sub2api/monitor"), settings = (await get("/api/task-settings")).settings;
  assert.equal(monitor.triggerMode, "account_status_refresh"); assert.equal(monitor.intervalSeconds, 3600); assert.equal(monitor.nextCheckAt, null);
  assert(!Object.hasOwn(settings.monitoring, "poolMonitorIntervalSeconds")); assert(!Object.hasOwn(settings.monitoring, "overloadCooldownIntervalSeconds"));
  status = "active"; await get("/api/sub2api/account-status?refresh=1");
  assert.equal((await attempts()).length, 1);
  await post("/api/task-settings", { monitoring: { poolRepairRetrySeconds: 0 } });
  status = "error"; incomplete = true;
  const bad = await fetch(base + "/api/sub2api/account-status?refresh=1", { headers }); assert.equal(bad.status, 500);
  await new Promise(r => setTimeout(r, 100)); assert.equal((await attempts()).length, 1, "incomplete snapshot cannot dispatch authorization");
  incomplete = false;
  await post("/api/sub2api/monitor", { config, enabled: false });
  status = "error"; await post("/api/task-settings", { monitoring: { poolRepairRetrySeconds: 0 } });
  await get("/api/sub2api/account-status?refresh=1"); await new Promise(r => setTimeout(r, 200));
  assert.equal((await attempts()).length, 1, "disabled recovery must remain opt-in");
  console.log("STATUS_RECOVERY_HTTP_PASS scheduled snapshot immediately queues OAuth; one listing across five callers+recovery, no error poll; in-flight/failed dedupe; incomplete snapshot guard; retired settings migration; recovered/disabled idle");
} finally {
  if (child?.exitCode === null) { const ended = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await ended; }
  remote.closeAllConnections(); await new Promise(r => remote.close(r)); await fs.rm(root, { recursive: true, force: true });
}
