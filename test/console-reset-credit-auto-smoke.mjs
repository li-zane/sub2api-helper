import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, ".."), temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-auto-cards-"));
const email = "automatic-cards@example.test", banned = "banned-cards@example.test";
const records = [email, banned].map((email, i) => ({ id: 101 + i, name: email, platform: "openai", type: "oauth", status: i ? "banned" : "active", schedulable: !i,
  credentials: { email, access_token: "private-fixture-token", refresh_token: "private-fixture-refresh" }, extra: { codex_5h_used_percent: 28, codex_usage_updated_at: "2026-11-01T00:00:00Z" } }));
let child, headers, logs = "", count = 2, fail = false, offline = false, releaseGate;
let gate = new Promise(resolve => { releaseGate = resolve; });
const calls = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pool = http.createServer(async (req, res) => {
  for await (const _ of req) {} const route = new URL(req.url, "http://fixture");
  calls.push({ path: route.pathname, method: req.method });
  res.setHeader("content-type", "application/json"); const send = data => res.end(JSON.stringify({ code: 0, data }));
  if (offline) { res.statusCode = 503; return send({}); }
  if (route.pathname === "/api/v1/admin/accounts") return send({ items: records, pages: 1 });
  if (route.pathname.endsWith("/groups/all") || route.pathname.endsWith("/proxies/all")) return send([]);
  if (route.pathname.endsWith("/stats")) return send({ total_account_cost: 1, total_actual_cost: 2, total_tokens: 100 });
  if (route.pathname.endsWith("/quota/refresh")) {
    if (gate) await gate;
    if (fail) { res.statusCode = 503; return send({}); }
    return send({ fetched_at: Math.floor(Date.now() / 1000), rate_limit_reset_credits: { available_count: count } });
  }
  if (route.pathname.endsWith("/usage")) return send({ five_hour: { utilization: 37 } });
  const record = records.find(r => route.pathname === `/api/v1/admin/accounts/${r.id}`);
  if (record) return send(record);
  res.statusCode = 404; send({});
});
await new Promise(resolve => pool.listen(0, "127.0.0.1", resolve));
const slot = http.createServer(); await new Promise(resolve => slot.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${slot.address().port}`; await new Promise(resolve => slot.close(resolve));
async function api(route, body) { const response = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); assert.equal(response.status, 200); return response.json(); }
async function wait(fn) { for (const end = Date.now() + 15_000; Date.now() < end;) { const value = await fn(); if (value) return value; await pause(30); } throw Error("auto-card fixture timeout\n" + logs); }
const job = async value => (await api("/api/jobs")).jobs.find(j => j.email === value);
const cardCalls = () => calls.filter(c => c.path.endsWith("/101/quota/refresh")).length;
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", new URL(base).port], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp, LOCALAPPDATA: temp, TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", data => logs += data); child.stderr.on("data", data => logs += data);
  const boot = await wait(async () => { try { const response = await fetch(base + "/api/bootstrap"); return response.ok && response.json(); } catch { return false; } });
  headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exit; } }
try {
  await fs.writeFile(path.join(temp, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture-key" }, profiles: [{ id: "default", name: "Default" }], activeProfileId: "default" }));
  await start();
  await wait(async () => cardCalls() === 1);
  assert.equal((await job(email)).sub2apiUsage?.resetCredits ?? null, null, "slow provider queries must not block the account list");
  releaseGate(); gate = null;
  let current = await wait(async () => { const j = await job(email); return j?.sub2apiUsage?.resetCredits?.availableCount === 2 && j; });
  assert.equal((await api("/api/task-settings")).settings.monitoring.resetCreditsIntervalSeconds, 900);
  assert.equal(cardCalls(), 1, "initial unknown count is filled without a manual usage refresh");
  assert.equal(current.sub2apiUsage.primary.usedPercent, 28);
  for (let i = 0; i < 3; i++) await api("/api/sub2api/account-status?refresh=1");
  assert.equal(cardCalls(), 1, "fast status polling must not fan out upstream queries");
  assert(!calls.some(c => c.path.endsWith("/102/quota/refresh")), "banned accounts skip automatic reads");
  count = 0;
  await api("/api/task-settings", { monitoring: { resetCreditsIntervalSeconds: 1, resetCreditsConcurrency: 1 } });
  const before = cardCalls(); await wait(async () => cardCalls() > before);
  // No page/API request drives this tick; observe the fixture's own request log.
  current = await wait(async () => { const j = await job(email); return j.sub2apiUsage.resetCredits.availableCount === 0 && j; });
  assert.equal(current.sub2apiUsage.resetCreditsStale, false);
  fail = true; await wait(async () => (await job(email)).sub2apiUsage.resetCreditsStale);
  assert.equal((await job(email)).sub2apiUsage.resetCredits.availableCount, 0, "failed sync retains the last confirmed zero");
  fail = false; count = 3;
  current = await wait(async () => { const j = await job(email); return j.sub2apiUsage.resetCredits.availableCount === 3 && j; });
  assert.equal(current.sub2apiUsage.resetCreditsStale, false);
  await api("/api/task-settings", { monitoring: { resetCreditsIntervalSeconds: 900 } });
  const bannedJob = await job(banned);
  assert.equal((await api(`/api/jobs/${bannedJob.id}/usage?refresh=1`)).usage.resetCredits.availableCount, 3, "banned accounts still allow explicit usage refresh");
  assert(!calls.some(c => c.path.includes("reset-quota") || c.path.includes("consume")), "reads never redeem cards");
  await stop(); offline = true; await start();
  current = await job(email); assert.equal(current.sub2apiUsage.resetCredits.availableCount, 3, "card cache survives restart/offline");
  assert.equal(current.sub2apiUsage.resetCreditsStale, true);
  console.log("AUTO_RESET_CREDITS_HTTP_PASS initial fill; independent server timer; bounded polling; banned auto/manual; positive/zero/failure/recovery; durable cache; no redemption");
} finally { releaseGate(); await stop(); pool.closeAllConnections(); await new Promise(resolve => pool.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); }
