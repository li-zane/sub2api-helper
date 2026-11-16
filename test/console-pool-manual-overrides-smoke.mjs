import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-manual-pool-http-"));
const account = { id: 1, name: "manual-pool@example.test", platform: "openai", type: "oauth", status: "active", schedulable: true,
  concurrency: 4, priority: 3, created_at: "2026-11-01T00:00:00Z", group_ids: [], extra: { plan_type: "free" },
  credentials: { email: "manual-pool@example.test", plan_type: "free" } };
const writes = [];
const pool = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const send = data => res.end(JSON.stringify({ data }));
  if (req.url.startsWith("/api/v1/admin/accounts?")) return send({ items: [account], total: 1, pages: 1 });
  if (req.url === "/api/v1/admin/accounts/1") {
    if (req.method === "PUT") { let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); writes.push(body); Object.assign(account, body); }
    return send(account);
  }
  send([]);
});
const listen = server => new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port)));
let child, headers, base, logs = "";
async function start() {
  const listener = http.createServer(), port = await listen(listener); await new Promise(r => listener.close(r)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root,
      LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
  for (const end = Date.now() + 20000; Date.now() < end;) {
    if (child.exitCode !== null) throw Error(logs);
    try { const data = await (await fetch(base + "/api/bootstrap")).json(); if (data.token) { headers = { "x-console-token": data.token, "content-type": "application/json" }; return; } } catch {}
    await new Promise(r => setTimeout(r, 40));
  }
  throw Error(logs);
}
async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; } }
async function api(route, body) {
  const res = await fetch(base + route, { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
}
const values = () => [account.priority, account.concurrency];
try {
  const poolUrl = `http://127.0.0.1:${await listen(pool)}`;
  const config = { baseUrl: poolUrl, adminApiKey: "fixture", profiles: [
    { id: "default", name: "Default" },
    { id: "free", name: "Free", concurrency: 4, importDatePriority: { enabled: true, min: 3, max: 3 } },
    { id: "team", name: "Team", priority: 20, concurrency: 8 },
  ], activeProfileId: "default", planTypeBindings: { free: "free", team: "team" } };
  await start(); await api("/api/sub2api/settings", { config });
  const job = (await api("/api/jobs")).jobs.find(j => j.email === account.name); assert(job);
  await api(`/api/sub2api/accounts/${job.id}/priority`, { priority: 7 });
  await api(`/api/sub2api/accounts/${job.id}/concurrency`, { concurrency: 11 });
  for (let n = 0; n < 3; n++) await api("/api/sub2api/account-status?refresh=1");
  assert.deepEqual(values(), [7, 11], "date/status polling overwrote manual values");
  config.profiles[1].importDatePriority = { enabled: true, min: 4, max: 4 }; config.profiles[1].concurrency = 6;
  await api("/api/sub2api/settings", { config }); assert.deepEqual(values(), [7, 11], "same-plan settings save overwrote manual values");
  await stop(); await start(); await api("/api/sub2api/account-status?refresh=1"); assert.deepEqual(values(), [7, 11]);
  await api("/api/sub2api/monitor", { config, enabled: true });
  await api("/api/sub2api/monitor/check", {}); assert.deepEqual(values(), [7, 11]);
  account.credentials.plan_type = "team"; account.extra.plan_type = "team";
  await api("/api/sub2api/monitor/check", {}); assert.deepEqual(values(), [20, 8], "new PlanType did not apply its defaults");
  const state = (await api("/api/jobs")).jobs.find(j => j.id === job.id);
  assert.equal(state.sub2apiPriority, 20); assert.equal(state.sub2apiConcurrency, 8);
  assert.equal(state.boundProxyId, job.boundProxyId);
  assert(!writes.some(body => body.schedulable !== undefined), "numeric policy change changed scheduling");
  assert(!logs.includes("Start ChatGPT web login"), "numeric policy change triggered login");
  console.log("POOL_MANUAL_HTTP_PASS both fields manually edited before any fingerprint; same-plan date/profile/poll/restart preserve; actual PlanType change applies new defaults; UI status synchronized; no login/pause/proxy mutation");
} finally { await stop(); await new Promise(r => pool.close(r)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
