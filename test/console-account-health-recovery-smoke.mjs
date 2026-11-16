import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { seedWebSession } from "./account-web-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-recovery-health-"));
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const accounts = [1, 2, 3, 4].map(n => ({ id: n, name: `health-${n}@example.test`, platform: "openai", type: "oauth",
  status: "active", schedulable: false, proxy_id: 0, credentials: { email: `health-${n}@example.test`, access_token: "fixture", refresh_token: "fixture", plan_type: "business" } }));
const unexpected = [];
const pool = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  const match = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && url.pathname === "/api/v1/admin/accounts") return res.end(JSON.stringify({ data: { items: accounts, total: 4, pages: 1 } }));
  if (req.method === "GET" && match) return res.end(JSON.stringify({ data: accounts.find(a => a.id === Number(match[1])) }));
  if (req.method === "GET" && url.pathname === "/api/v1/admin/proxies/all") return res.end("[]");
  // Existing background usage readers run independently of health filtering.
  if (req.method === "GET" && url.pathname === "/api/v1/admin/usage/stats") return res.end('{"data":{}}');
  if (req.method === "POST" && /^\/api\/v1\/admin\/openai\/accounts\/\d+\/quota\/refresh$/.test(url.pathname)) return res.end('{"data":{}}');
  unexpected.push(req.method + " " + url.pathname); res.writeHead(500); res.end("{}");
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
let child, base, headers, logs = "";
async function start() {
  const listener = http.createServer(), port = await listen(listener); await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root,
      LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
  for (const end = Date.now() + 15000; Date.now() < end;) {
    if (child.exitCode !== null) throw Error(logs);
    try {
      const response = await fetch(base + "/api/bootstrap");
      headers = { "x-console-token": (await response.json()).token, "content-type": "application/json" };
      if (headers["x-console-token"]) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(logs || "startup timeout");
}
async function stop() {
  if (child?.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done; }
}
async function get(suffix) {
  const response = await fetch(base + "/api/jobs" + suffix, { headers }); assert.equal(response.status, 200); return response.json();
}
try {
  const poolBase = `http://127.0.0.1:${await listen(pool)}`;
  const config = { baseUrl: poolBase, adminApiKey: "fixture" };
  const backend = crypto.createHash("sha256").update(poolBase + "\0fixture").digest("hex").slice(0, 24);
  const states = {};
  for (const account of accounts) {
    const folder = path.join(root, id(account.id)); await fs.mkdir(folder);
    const output = path.join(folder, "sub2api-import-oauth.json");
    await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [account] }));
    await fs.writeFile(path.join(folder, "job-meta.json"), JSON.stringify({ version: 1, email: account.name, status: account.id <= 2 ? "failed" : "completed",
      result_saved: true, plan_type: "business", created_at: "2026-11-16T00:00:00Z" }));
    const session = await seedWebSession(output); session.validation = { status: "valid", verifiedAt: new Date().toISOString() };
    await fs.writeFile(path.join(folder, "web-session.json"), JSON.stringify({ ...session, version: 1 }));
    if (account.id <= 3) states[account.name] = { id: `reset-${account.id}`, jobId: id(account.id), source: account.id === 1 ? "cooldown" : "manual",
      status: account.id <= 2 ? "failed" : "completed", poolPauseActive: account.id <= 2, backend, proxyId: 0,
      accountIds: [String(account.id)], resumeAccountIds: [String(account.id)], startedAt: "2026-11-16T01:00:00Z", error: account.id <= 2 ? "UNEXPECTED_LOGIN_PAGE: /workspace" : null };
  }
  const resetFile = path.join(root, "account-session-resets.json");
  await fs.writeFile(resetFile, JSON.stringify({ version: 1, accounts: states }));
  await fs.writeFile(path.join(root, "sub2api-settings.json"), JSON.stringify({ version: 2, config, profiles: [], activeProfileId: null }));
  await start();
  const all = await get(""); assert.deepEqual([all.stats.normal, all.stats.abnormal], [2, 2]);
  for (const account of all.jobs) { assert.equal(account.webSessionStatus, "valid"); assert.equal(account.sub2apiRemoteStatus, "active"); }
  const abnormal = await get("?summary=abnormal"); assert.equal(abnormal.pagination.total, 2);
  assert.deepEqual(abnormal.jobs.map(j => j.email).sort(), accounts.slice(0, 2).map(a => a.name).sort());
  assert.deepEqual(abnormal.stats, all.stats, "filter changed global health totals");
  assert.equal((await get("?summary=abnormal&search=health-4")).pagination.total, 0, "manual pause was counted as failed recovery");
  const query = await fetch(base + "/api/jobs/query", { method: "POST", headers,
    body: JSON.stringify({ emails: [accounts[0].name, accounts[3].name], summary: "abnormal" }) });
  assert.equal(query.status, 200); assert.deepEqual((await query.json()).jobs.map(j => j.email), [accounts[0].name]);
  await stop(); await start(); assert.equal((await get("")).stats.abnormal, 2, "restart lost failure classification");
  await stop();
  const saved = JSON.parse(await fs.readFile(resetFile, "utf8"));
  for (const state of Object.values(saved.accounts)) Object.assign(state, { status: "completed", poolPauseActive: false, error: null });
  await fs.writeFile(resetFile, JSON.stringify(saved));
  await start(); const recovered = await get(""); assert.deepEqual([recovered.stats.normal, recovered.stats.abnormal], [4, 0]);
  assert.equal((await get("?summary=abnormal")).pagination.total, 0, "resolved reset remained abnormal");
  assert.deepEqual(unexpected, [], "health filtering triggered pool writes or account actions");
  console.log("RECOVERY_HEALTH_HTTP_PASS valid_Web/active_pool do not mask unresolved manual/automatic relogin failures; global counts/filter/search/email agree; restart retained; completed/manual-paused normal; no_login_or_scheduling_writes=true");
} finally {
  await stop(); await new Promise(resolve => pool.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
