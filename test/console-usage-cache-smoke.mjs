import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, ".."), temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-usage-cache-"));
let child, headers, base, logs = "", offline = false, partial = false, zero = false, remoteId = 101;
const email = "cache@example.test", pause = ms => new Promise(r => setTimeout(r, ms));
const pool = http.createServer(async (req, res) => {
  for await (const _ of req) {}
  const url = new URL(req.url, "http://fixture"); res.setHeader("content-type", "application/json");
  const send = data => res.end(JSON.stringify({ code: 0, data }));
  if (offline || partial && url.pathname.endsWith("/stats")) { res.statusCode = 503; return send({ message: "fixture offline" }); }
  if (url.pathname === "/api/v1/admin/accounts") return send({ items: [{ id: remoteId, name: email, platform: "openai", type: "oauth", status: "active", schedulable: true,
    credentials: { email, access_token: "private-fixture-token", refresh_token: "private-fixture-refresh" },
    extra: partial ? {} : { codex_usage_updated_at: "2026-11-01T00:00:00Z", codex_5h_used_percent: zero ? 0 : 10, codex_7d_used_percent: zero ? 0 : 17,
      codex_credits_snapshot: { credits: { balance: zero ? "0" : "105" } }, codex_reset_credit_snapshot: { available_count: zero ? 0 : 2 } } }], pages: 1 });
  if (url.pathname.endsWith("/groups/all") || url.pathname.endsWith("/proxies/all")) return send([]);
  if (url.pathname.endsWith("/stats")) return send({ total_account_cost: zero ? 0 : 105, total_actual_cost: zero ? 0 : 117, total_tokens: zero ? 0 : 272000000 });
  if (url.pathname.endsWith("/usage")) return send({ five_hour: { utilization: zero ? 0 : 10 }, seven_day: { utilization: zero ? 0 : 17 }, credits: { balance: zero ? "0" : "105" } });
  if (url.pathname.endsWith("/quota/refresh")) return send({ rate_limit_reset_credits: { available_count: zero ? 0 : 2 } });
  res.statusCode = 404; send({});
});
async function freePort() { const s = http.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function api(route) { const r = await fetch(base + route, { headers }); return { status: r.status, data: await r.json() }; }
const job = async () => (await api("/api/jobs")).data.jobs.find(j => j.email === email);
async function wait(fn) { for (const end = Date.now() + 15000; Date.now() < end;) { if (await fn()) return; await pause(40); } throw Error("cache fixture timeout\n" + logs); }
async function start() {
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [process.env.USAGE_CACHE_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp, LOCALAPPDATA: temp, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "creds"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "creds"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", d => logs += d); child.stderr.on("data", d => logs += d);
  let b; await wait(async () => { try { b = await (await fetch(base + "/api/bootstrap")).json(); return true; } catch {} });
  headers = { "x-console-token": b.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; } }
try {
  const port = await freePort(); await new Promise(r => pool.listen(port, "127.0.0.1", r));
  await fs.writeFile(path.join(temp, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: `http://127.0.0.1:${port}`, adminApiKey: "private-fixture-key", groupIds: [] }, profiles: [{ id: "default", name: "fixture", groupIds: [] }], activeProfileId: "default" }));
  await start(); assert.equal((await api("/api/sub2api/account-status?refresh=1")).status, 200);
  await wait(async () => (await job())?.sub2apiUsage?.totals?.tokens === 272000000);
  const id = (await job()).id;
  assert.equal((await api(`/api/jobs/${id}/usage?refresh=1`)).status, 200);
  await stop(); offline = true; await start();
  const restored = await job();
  assert.equal(restored.sub2apiUsage?.totals?.tokens, 272000000, "cached A/U/T must survive restart even when the pool is offline");
  assert.equal(restored.sub2apiUsage.secondary.usedPercent, 17); assert.equal(restored.sub2apiUsage.resetCredits.availableCount, 2);
  assert.equal(restored.sub2apiInPool, null, "usage display cache must not restore pool membership or enable automation");
  assert.equal(restored.sub2apiUsage.stale, true);
  assert.equal((await api(`/api/jobs/${id}/usage?refresh=1`)).status, 502);
  assert.equal((await job()).sub2apiUsage.totals.accountCost, 105);
  offline = false; partial = true;
  assert.equal((await api("/api/sub2api/account-status?refresh=1")).status, 200);
  assert.equal((await job()).sub2apiUsage.secondary.usedPercent, 17);
  assert.equal((await job()).sub2apiUsage.totals.tokens, 272000000, "partial or failed sync must not erase prior totals");
  partial = false; zero = true;
  assert.equal((await api(`/api/jobs/${id}/usage?refresh=1`)).status, 200);
  const updated = (await job()).sub2apiUsage;
  assert.equal(updated.primary.usedPercent, 0); assert.equal(updated.totals.tokens, 0); assert.equal(updated.resetCredits.availableCount, 0);
  assert.equal(updated.credits.balance, "0", "real zero must replace the old cached amount");
  await stop(); offline = true; await start();
  assert.equal((await job()).sub2apiUsage.totals.tokens, 0, "successful updates must replace durable cache");
  const disk = await fs.readFile(path.join(temp, "usage-snapshots.json"), "utf8");
  for (const secret of ["private-fixture-token", "private-fixture-refresh", "private-fixture-key"]) assert(!disk.includes(secret), "display cache contains credentials");
  offline = false; partial = true; remoteId = 202;
  assert.equal((await api("/api/sub2api/account-status?refresh=1")).status, 200);
  assert.equal((await job()).sub2apiUsage?.primary ?? null, null, "recreated remote IDs must not inherit old quota");
  assert.equal((await job()).sub2apiUsage?.totals?.tokens ?? null, null, "recreated remote IDs must not inherit old totals");
  console.log("USAGE_CACHE_HTTP_PASS restart+offline preserves quota/A/U/T/cards; no cached membership; failed/partial sync retains values; real zeros update and persist; remote-ID isolation; no credential material");
} finally { await stop(); pool.closeAllConnections(); await new Promise(r => pool.close(r)); await fs.rm(temp, { recursive: true, force: true }); }
