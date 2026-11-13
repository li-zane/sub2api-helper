import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { recentIntervals, OVERLOAD_MESSAGE } from "../src/overload-monitor.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-dual-threshold-http-"));
const email = "threshold-change@example.test", id = "11111111-1111-4111-8111-111111111111";
const now = Date.now(), grid = recentIntervals(now);
const rows = grid.flatMap((p, i) => Array.from({ length: [3, 2, 2, 2, 2, 1][i] }, (_, n) => ({
  id: i * 100 + n, account_id: 7, status_code: 503, message: OVERLOAD_MESSAGE,
  created_at: new Date(Math.min(Date.parse(p.start) + 1, now - 1)).toISOString(),
})));
const record = { id: 7, name: email, platform: "openai", type: "oauth", status: "active", schedulable: true, credentials: { email, plan_type: "plus" } };
const mutations = [], queries = [];
const remote = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"); res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/v1/admin/accounts") return res.end(JSON.stringify({ data: { items: [record], total: 1, pages: 1 } }));
  if (url.pathname.endsWith("/schedulable")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    record.schedulable = JSON.parse(Buffer.concat(chunks)).schedulable; mutations.push(record.schedulable);
    return res.end("{}");
  }
  if (url.pathname.includes("/ops/")) {
    queries.push(url.pathname);
    const start = Date.parse(url.searchParams.get("start_time")), end = Date.parse(url.searchParams.get("end_time"));
    const items = url.pathname.endsWith("/requests") ? [] : rows.filter(r => Date.parse(r.created_at) >= start && Date.parse(r.created_at) < end);
    return res.end(JSON.stringify({ data: { items, total: items.length } }));
  }
  return res.end('{"data":{"items":[],"total":0}}');
});
const listen = s => new Promise(r => s.listen(0, "127.0.0.1", r));
await listen(remote);
const config = { baseUrl: `http://127.0.0.1:${remote.address().port}`, adminApiKey: "fixture" };
const backend = crypto.createHash("sha256").update(config.baseUrl + "\0" + config.adminApiKey).digest("hex").slice(0, 24);
const slot = http.createServer(); await listen(slot); const port = slot.address().port; await new Promise(r => slot.close(r));
const base = `http://127.0.0.1:${port}`;
let child, headers, logs = "";
const wait = async (predicate, message) => {
  for (const deadline = Date.now() + 12000; Date.now() < deadline;) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 30));
  }
  throw Error(message + "\n" + logs);
};
const api = async (route, body) => {
  const res = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  assert.equal(res.status, 200, await res.clone().text()); return res.json();
};
const job = async () => (await api("/api/jobs")).jobs.find(j => j.id === id);
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp,
      LOCALAPPDATA: temp, TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"),
      TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), SUB2API_MONITOR_ENABLED: "0" },
  });
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
  await wait(async () => {
    try { const b = await fetch(base + "/api/bootstrap").then(r => r.json()); headers = { "x-console-token": b.token, "content-type": "application/json" }; return Boolean(b.token); }
    catch { return false; }
  }, "startup timeout");
}
async function stop() {
  if (child?.exitCode === null) { const ended = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await ended; }
}
try {
  await fs.mkdir(path.join(temp, id));
  await fs.writeFile(path.join(temp, id, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", pool_only: true, result_saved: false, created_at: new Date(now - 86400000).toISOString() }));
  await fs.writeFile(path.join(temp, "sub2api-settings.json"), JSON.stringify({ version: 2, config, profiles: [{ id: "default", name: "default", groupIds: [] }], activeProfileId: "default" }));
  await fs.writeFile(path.join(temp, "task-settings.json"), JSON.stringify({ version: 4, maxActiveJobs: 4, overloadAutoCooldown: { windowMinutes: 15, threshold: 5, cooldownMinutes: 30 }, monitoring: { overloadIntervalSeconds: 86400, accountStatusIntervalSeconds: 3600, usageTotalsIntervalSeconds: 3600 } }));
  await fs.writeFile(path.join(temp, "overload-cooldown.json"), JSON.stringify({ version: 1, accounts: { [email]: { enabled: true, backend, phase: "idle", resumeAccountIds: [] } } }));
  await start(); await api("/api/sub2api/account-status?refresh=1");
  await api("/api/task-settings", { monitoring: { overloadIntervalSeconds: 86399 } });
  await wait(async () => Boolean((await job()).overloadAutoCooldown.lastCheckedAt), "first count snapshot not published");
  assert.deepEqual(mutations, []); assert.equal(record.schedulable, true);
  assert.equal((await job()).overloadAutoCooldown.windowCount, 1);
  const reads = queries.length;
  await api("/api/task-settings", { overloadAutoCooldown: { threshold: 4 } });
  await wait(async () => (await job()).overloadAutoCooldown.phase === "cooling", "saving lower threshold did not pause on 90min total");
  const paused = (await job()).overloadAutoCooldown;
  assert.equal(paused.historyCount, 12); assert.equal(paused.historyThreshold, 12); assert.equal(paused.triggerReason, "history");
  assert.equal(paused.windowCount, 1); assert.equal(record.schedulable, false); assert.deepEqual(mutations, [false]);
  assert.equal(queries.length - reads, 1, "threshold save reuses one cooldown-only overload collection");
  await stop(); await start();
  const restored = (await job()).overloadAutoCooldown;
  assert.equal(restored.coolingUntil, paused.coolingUntil); assert.equal(restored.triggerReason, "history");
  assert.equal(restored.historyCount, 12); assert.deepEqual(mutations, [false]);
  console.log("DUAL_WINDOW_HTTP_PASS threshold 5→4 current=1 history=12/12; immediate pause; one shared collection; durable reason/deadline after restart");
} finally {
  await stop(); remote.closeAllConnections(); await new Promise(r => remote.close(r));
  await fs.rm(temp, { recursive: true, force: true });
}
