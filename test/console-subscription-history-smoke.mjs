import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-subscription-http-"));
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
let child, token, base, logs = "";
async function api(route, { body, method = body === undefined ? "GET" : "POST", authenticated = true } = {}) {
  const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(authenticated ? { "x-console-token": token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
async function start() {
  const listener = http.createServer(); let port;
  do { await new Promise(r => listener.listen(0, "127.0.0.1", r)); port = listener.address().port; await new Promise(r => listener.close(r)); } while (port <= 10080);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp,
      LOCALAPPDATA: temp, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
  for (const end = Date.now() + 15000; Date.now() < end;) {
    if (child.exitCode !== null) throw Error(logs);
    try { const r = await fetch(base + "/api/bootstrap"); token = (await r.json()).token; if (token) return; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  throw Error(logs || "fixture startup timeout");
}
async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; } }
try {
  for (const [n, plan] of [[1, "team"], [2, "free"], [3, "free"], [4, null]]) {
    const dir = path.join(temp, id(n)); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email: `history-${n}@example.test`, status: "completed", plan_type: plan,
      workspace_plan_type: plan, remark: n === 1 ? "原备注" : "", account_cost_cny: n === 1 ? 12.34 : 0 }));
    await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: {
      email: `history-${n}@example.test`, access_token: "fixture-access", refresh_token: "fixture-refresh", plan_type: plan } }] }));
    if (n === 3) {
      const history = path.join(dir, "credential-history"); await fs.mkdir(history);
      await fs.writeFile(path.join(history, "123-aaaa.json"), JSON.stringify({ type: "workspaces", at: "2026-11-01T00:00:00Z",
        before: { workspaces: [{ id: "old", planType: "business" }] }, after: { workspaces: [{ id: "personal", planType: "free" }] } }));
    }
  }
  await start();
  const first = await api("/api/subscription-history");
  assert.equal(first.status, 200, "history endpoint must exist");
  assert.equal((await api("/api/subscription-history", { authenticated: false })).status, 403);
  assert.equal(first.data.total, 2); assert.equal(first.data.records.length, 2);
  let account = first.data.records.find(r => r.email === "history-1@example.test");
  assert.equal(account.accountCostCny, 12.34); assert.equal(account.remark, "原备注"); assert.equal(account.profitCents, null);
  assert.equal(first.data.records.find(r => r.email === "history-3@example.test").lastPaidPlanType, "business");
  assert(!JSON.stringify(first.data).includes("fixture-access"), "list leaked OAuth credentials");
  assert.equal((await api("/api/jobs")).data.stats.historicalSubscriptions, 2);
  assert.equal((await api(`/api/subscription-history/${account.id}/credentials`, { authenticated: false })).status, 403);
  let copied = await api(`/api/subscription-history/${account.id}/credentials`);
  assert.equal(copied.status, 200); assert.equal(copied.headers.get("cache-control"), "no-store");
  assert(copied.data.text.includes("fixture-access"), "OAuth-only account must still be copyable");
  assert.equal((await api(`/api/jobs/${id(1)}/cost`, { body: { accountCostCny: 9.99 } })).status, 200);
  assert.equal((await api(`/api/jobs/${id(1)}/remark`, { body: { remark: "最新备注" } })).status, 200);
  const secret = "ABCDEFGHIJKLMNOP";
  assert.equal((await api(`/api/jobs/${id(1)}/credentials`, { method: "PUT", body: { password: "fixture-new-password", totpSecret: secret } })).status, 200);
  account = (await api("/api/subscription-history")).data.records.find(r => r.id === account.id);
  assert.equal(account.accountCostCny, 9.99); assert.equal(account.remark, "最新备注");
  copied = await api(`/api/subscription-history/${account.id}/credentials`);
  assert.equal(copied.data.text, `history-1@example.test----fixture-new-password----${secret}`);
  assert(!JSON.stringify((await api("/api/subscription-history")).data).includes("fixture-new-password"));
  const lateHistory = path.join(temp, id(4), "credential-history"); await fs.mkdir(lateHistory);
  await fs.writeFile(path.join(lateHistory, "456-bbbb.json"), JSON.stringify({ type: "workspaces", at: "2026-11-15T00:00:00Z",
    after: { workspaces: [{ planType: "plus" }] } }));
  assert.equal((await api("/api/subscription-history")).data.total, 3, "new workspace subscription evidence required a restart");
  await stop();
  const meta = path.join(temp, id(1), "job-meta.json"), saved = JSON.parse(await fs.readFile(meta, "utf8"));
  saved.plan_type = "free"; saved.workspace_plan_type = "free"; await fs.writeFile(meta, JSON.stringify(saved));
  await start();
  account = (await api("/api/subscription-history")).data.records.find(r => r.id === account.id);
  assert.equal(account.planType, "free"); assert.equal(account.lastPaidPlanType, "team");
  assert.equal((await api("/api/jobs/delete-batch", { body: { ids: [id(1)] } })).status, 200);
  account = (await api("/api/subscription-history")).data.records.find(r => r.id === account.id);
  assert.equal(account.present, false); assert.equal(account.remark, "最新备注");
  assert.equal((await api(`/api/subscription-history/${account.id}/credentials`)).data.text, `history-1@example.test----fixture-new-password----${secret}`);
  await stop(); await start();
  assert.equal((await api("/api/subscription-history")).data.total, 3);
  assert.equal((await api(`/api/subscription-history/${"a".repeat(32)}/credentials`)).status, 404);
  console.log("SUBSCRIPTION_HISTORY_HTTP_PASS auth; paid-only/backfill; live cost/remark/credential updates; no secret list; downgrade/delete/restart retention; no-store copy");
} finally { await stop(); await fs.rm(temp, { recursive: true, force: true }); }
