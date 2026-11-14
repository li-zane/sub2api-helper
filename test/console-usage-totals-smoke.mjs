import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-usage-totals-"));
const output = path.join(temp, "output"); await fs.mkdir(output);
const records = [101, 102].map(id => ({ id, name: "total@example.test", platform: "openai", type: "oauth", status: "active", schedulable: true,
  credentials: { email: "total@example.test", access_token: "fixture-token", refresh_token: "fixture-refresh" }, extra: { codex_5h_used_percent: 25 }, group_ids: [] }));
const calls = []; let holdStats = true, release = () => {}, child;
const held = new Promise(resolve => { release = resolve; });
const pool = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test"); calls.push(url);
  res.setHeader("content-type", "application/json");
  const send = data => res.end(JSON.stringify({ code: 0, data }));
  if (url.pathname === "/api/v1/admin/accounts") return send({ items: records, total: records.length, pages: 1 });
  if (url.pathname.endsWith("/groups/all") || url.pathname.endsWith("/proxies/all")) return send([]);
  if (url.pathname === "/api/v1/admin/usage/stats") {
    if (holdStats) await held;
    return send({ total_account_cost: 10, total_actual_cost: 2, total_cost: 100, total_tokens: 1234 });
  }
  if (url.pathname.endsWith("/usage")) return send({ five_hour: { utilization: 37 } });
  if (url.pathname.endsWith("/quota/refresh")) return send({ rate_limit_reset_credits: { available_count: 0 } });
  const record = records.find(record => url.pathname === `/api/v1/admin/accounts/${record.id}`);
  if (record) return send(record);
  res.statusCode = 404; send({});
});
await new Promise(resolve => pool.listen(0, "127.0.0.1", resolve));
const slot = http.createServer(); await new Promise(resolve => slot.listen(0, "127.0.0.1", resolve));
const port = slot.address().port; await new Promise(resolve => slot.close(resolve));
const base = `http://127.0.0.1:${port}`; let headers, logs = "";
const waitFor = async fn => { for (const deadline = Date.now() + 15_000; Date.now() < deadline;) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error("Timed out: " + logs); };
async function get(route) { const response = await fetch(base + route, { headers }); assert.equal(response.status, 200); return response.json(); }
try {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: temp,
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), SUB2API_MONITOR_ENABLED: "0" },
  });
  child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
  let boot;
  await waitFor(async () => { try { boot = await get("/api/bootstrap"); return true; } catch { return false; } });
  headers = { "x-console-token": boot.token, "content-type": "application/json" };
  const saved = await fetch(base + "/api/sub2api/settings", { method: "POST", headers, body: JSON.stringify({ config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture-key", groupIds: [] } }) });
  assert.equal(saved.status, 200);
  await get("/api/sub2api/account-status?refresh=1");
  const page = await get("/api/jobs");
  assert.equal(page.jobs.length, 1, "multiple remote IDs belong to one local account");
  assert.equal(page.jobs[0].sub2apiUsage.primary.usedPercent, 25, "slow accounting queries must not block cached quota/list reads");
  holdStats = false; release();
  let job;
  await waitFor(async () => { job = (await get("/api/jobs")).jobs[0]; return job.sub2apiUsage?.totals?.tokens === 2468; });
  assert.equal(job.sub2apiUsage.totals.accountCost, 20); assert.equal(job.sub2apiUsage.totals.userCost, 4);
  const count = calls.filter(url => url.pathname === "/api/v1/admin/usage/stats").length;
  await get("/api/sub2api/account-status?refresh=1");
  assert.equal(calls.filter(url => url.pathname === "/api/v1/admin/usage/stats").length, count, "ordinary list refresh should reuse total cache");
  const refreshed = (await get(`/api/jobs/${job.id}/usage?refresh=1`)).usage;
  assert.equal(refreshed.totals.tokens, 2468); assert.equal(refreshed.primary.usedPercent, 37);
  assert.equal(calls.filter(url => url.pathname === "/api/v1/admin/usage/stats" && url.searchParams.get("nocache") === "true").length, 2);
  assert(calls.filter(url => url.pathname === "/api/v1/admin/usage/stats").every(url => url.searchParams.get("start_date") === "1970-01-01"));
  const cardReads = calls.filter(url => url.pathname.endsWith("/quota/refresh")).length;
  const applied=await fetch(base+"/api/task-settings",{method:"POST",headers,body:JSON.stringify({monitoring:{accountStatusIntervalSeconds:1,usageTotalsIntervalSeconds:1,usageTotalsConcurrency:1}})});
  assert.equal(applied.status,200);
  const snapshots=calls.filter(url=>url.pathname==="/api/v1/admin/accounts").length;
  const stats=calls.filter(url=>url.pathname==="/api/v1/admin/usage/stats").length;
  // Wait on fixture counters only: no browser/API polling is driving the sync.
  await waitFor(async()=>calls.filter(url=>url.pathname==="/api/v1/admin/accounts").length>snapshots && calls.filter(url=>url.pathname==="/api/v1/admin/usage/stats").length>stats);
  assert.equal(calls.filter(url=>url.pathname.endsWith("/quota/refresh")).length,cardReads,"fast database polling must respect the independent reset-card cache interval");
  console.log("CONSOLE_USAGE_TOTALS_PASS asynchronous list safety; all-history per-account aggregation; A/U semantics; cache reuse; manual quota+totals refresh");
} finally {
  release();
  if (child && child.exitCode === null) { const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exit; }
  pool.closeAllConnections(); await new Promise(resolve => pool.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
