import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OVERLOAD_MESSAGE } from "../src/overload-monitor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-cooldown-http-"));
const output = path.join(temp, "output");
const statePath = path.join(output, "overload-cooldown.json");
const email = "cooling@example.test";
const records = [
  { id: 7, platform: "openai", type: "oauth", name: "冷却测试账号", status: "active", schedulable: true, proxy_id: 0, credentials: { email, plan_type: "plus" } },
  { id: 8, platform: "openai", type: "oauth", name: "原本停用账号", status: "active", schedulable: false, proxy_id: 0, credentials: { email: "manual@example.test", plan_type: "free" } },
];
let logRows = makeRows();
const changes = [];
const remote = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const url = new URL(req.url, "http://fixture");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/v1/admin/accounts") return res.end(JSON.stringify({ data: { items: records, total: records.length, pages: 1 } }));
  if (url.pathname === "/api/v1/admin/proxies/all" || url.pathname === "/api/v1/admin/groups/all") return res.end("[]");
  if (url.pathname.includes("/ops/requests")) return res.end('{"data":{"items":[],"total":0}}');
  if (url.pathname.includes("/ops/upstream-errors")) {
    const rows = logRows.filter(row => String(row.account_id) === url.searchParams.get("account_id"));
    return res.end(JSON.stringify({ data: { items: rows, total: rows.length } }));
  }
  const match = /\/accounts\/(\d+)\/schedulable$/.exec(url.pathname);
  if (match) {
    assert.equal(req.method, "POST");
    records.find(record => record.id === Number(match[1])).schedulable = body.schedulable;
    changes.push({ id: Number(match[1]), enabled: body.schedulable });
    return res.end("{}");
  }
  res.statusCode = 404; res.end("{}");
});
await listen(remote);
const config = { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: "fixture-key" };
const slot = http.createServer(); await listen(slot); const port = slot.address().port; await new Promise(resolve => slot.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child;
let logs = "";
let headers;
let jobId;
try {
  await start();
  assert.equal((await get("/api/bootstrap")).features.overloadAutoCooldown, true);
  assert.equal((await post("/api/sub2api/settings", { config })).status, 200);
  await get("/api/sub2api/account-status?refresh=1");
  jobId = (await get("/api/jobs")).jobs.find(job => job.email === email).id;
  assert.equal((await job()).overloadAutoCooldown.enabled, false);
  const rule = { windowMinutes: 15, threshold: 3, cooldownMinutes: 30 };
  assert.equal((await post("/api/task-settings", { overloadAutoCooldown: rule })).status, 200);
  assert.equal((await post("/api/task-settings", { overloadAutoCooldown: { threshold: 0 } })).status, 400);
  assert.deepEqual((await get("/api/task-settings")).settings.overloadAutoCooldown, rule);
  assert.equal((await post(`/api/jobs/${jobId}/overload-auto-cooldown`, { enabled: "yes" })).status, 400);
  assert.equal((await fetch(`${base}/api/jobs/${jobId}/overload-auto-cooldown`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"enabled":true}' })).status, 403);
  const before = await job();
  assert.equal((await post(`/api/jobs/${jobId}/overload-auto-cooldown`, { enabled: true })).status, 200);
  await waitFor(async () => (await job()).overloadAutoCooldown.phase === "cooling");
  assert.equal(records[0].schedulable, false);
  assert.deepEqual(changes, [{ id: 7, enabled: false }]);
  const cooling = await job();
  assert.equal(cooling.overloadAutoCooldown.windowCount, 3);
  assert.equal(cooling.assignedProxyId, before.assignedProxyId);
  assert.equal(cooling.status, before.status, "pool pause does not restart account login");
  await stop(); await start();
  assert.equal((await job()).overloadAutoCooldown.enabled, false, "pool is cooling: effective control stays off while durable resume remains armed");
  assert.deepEqual((await get("/api/task-settings")).settings.overloadAutoCooldown, rule);
  assert.equal((await job()).overloadAutoCooldown.coolingUntil, cooling.overloadAutoCooldown.coolingUntil);
  await stop();
  const disk = JSON.parse(await fs.readFile(statePath, "utf8"));
  disk.accounts[email].coolingUntil = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(statePath, JSON.stringify(disk));
  await start();
  await waitFor(async () => (await job()).overloadAutoCooldown.phase === "idle");
  assert.equal(records[0].schedulable, true, "expired cooldown restores after service restart");
  assert.equal(records[1].schedulable, false, "manual disabled account stays disabled");
  assert.equal((await post(`/api/jobs/${jobId}/overload-auto-cooldown`, { enabled: false })).status, 200);
  assert.equal((await job()).overloadAutoCooldown.enabled, false);
  console.log("PASS: auto-cooldown HTTP auth/validation, saved task rule, per-account switch, threshold pool pause, unchanged login/binding, persisted restart deadline, overdue resume and originally-disabled preservation");
  if (process.argv.includes("--serve")) {
    logRows = makeRows();
    const disk = JSON.parse(await fs.readFile(statePath, "utf8"));
    delete disk.accounts[email].lastResumedAt;
    await stop(); await fs.writeFile(statePath, JSON.stringify(disk)); await start();
    await post(`/api/jobs/${jobId}/overload-auto-cooldown`, { enabled: true });
    await post(`/api/jobs/${jobId}/overload-detection`, { enabled: true });
    await waitFor(async () => (await job()).overloadAutoCooldown.phase === "cooling");
    if (process.env.OVERLOAD_COOLDOWN_FIXTURE_FILE) await fs.writeFile(process.env.OVERLOAD_COOLDOWN_FIXTURE_FILE, JSON.stringify({ url: base, output, temp, jobId }));
    console.log(`UI_FIXTURE=${base}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} catch (error) { error.message += `\n${logs}`; throw error; }
finally { await stop(); remote.closeAllConnections(); await new Promise(resolve => remote.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); }

function makeRows() { return [1, 2, 3].map(id => ({ id, account_id: 7, status_code: 503, message: OVERLOAD_MESSAGE, created_at: new Date(Date.now() - 10_000 - id).toISOString() })); }
async function job() { return (await get("/api/jobs")).jobs.find(job => job.id === jobId); }
async function get(route) { return (await fetch(`${base}${route}`, { headers })).json(); }
async function post(route, body) { const r = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
function listen(server) { return new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); }
async function start() {
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { logs = `${logs}${chunk}`.slice(-10000); });
  child.stderr.on("data", chunk => { logs = `${logs}${chunk}`.slice(-10000); });
  await waitFor(async () => { const r = await fetch(`${base}/api/bootstrap`).catch(() => null); if (!r?.ok) return false; headers = { "x-console-token": (await r.json()).token, "content-type": "application/json" }; return true; });
}
async function stop() { if (child && child.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done; } }
async function waitFor(predicate) { const until = Date.now() + 20000; while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error("Timed out waiting for auto-cooldown fixture"); }
