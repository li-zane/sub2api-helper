import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { seedWebSession } from "./account-web-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "account-automation-block-"));
const emails = ["banned@example.test", "web-ban@example.test", "transient@example.test", "space@example.test"];
const ids = emails.map((_, i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`);
const ban = "You do not have an account because it has been deleted or deactivated.";
const poolWrites = [];
const pool = http.createServer(async (req, res) => {
  for await (const _ of req) {}
  if (req.method !== "GET") poolWrites.push(req.url);
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/api/v1/admin/accounts")) return res.end(JSON.stringify({ data: { items: [], total: 0 } }));
  if (req.url.includes("ops/")) return res.end(JSON.stringify({ data: { items: [], total: 0 } }));
  res.end(JSON.stringify({ data: [] }));
});
await new Promise(r => pool.listen(0, "127.0.0.1", r));
let child, exited, base, headers, logs = "";
const wait = async fn => {
  for (let n = 0; n < 160; n++) {
    const value = await fn().catch(() => null); if (value) return value;
    if (child?.exitCode != null) throw new Error(logs);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("fixture timeout " + logs);
};
async function start() {
  const socket = http.createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port; await new Promise(r => socket.close(r)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [process.env.AUTOMATION_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production", ONBOARDING_OUTPUT_ROOT: root,
      ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "protocol.mjs"), LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" },
  });
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; }); exited = new Promise(r => child.once("exit", r));
  const boot = await wait(async () => (await fetch(base + "/api/bootstrap")).json()); headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { child.kill("SIGTERM"); await exited; } }
async function api(route, body) {
  const r = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json() };
}
const job = async i => (await api("/api/jobs")).data.jobs.find(j => j.id === ids[i]);
const off = j => !j.overloadDetection.enabled && !j.overloadAutoCooldown.enabled && !j.modelFingerprint.enabled && j.modelFingerprint.override.enabled === false;
try {
  for (const [i, email] of emails.entries()) {
    const dir = path.join(root, ids[i]); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: i === 0 ? "banned" : "completed", auto_repair_blocked: i === 0, result_saved: true, plan_type: "free", web_login_error: i === 2 ? "HTTP 403: temporary permission failure" : i === 3 ? "Workspace deleted or deactivated" : null }));
    await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, access_token: "fixture", refresh_token: "fixture" } }] }));
  }
  await fs.writeFile(path.join(root, "protocol.mjs"), `console.error(${JSON.stringify("[error] " + ban)}); process.exitCode=1;`);
  await fs.writeFile(path.join(root, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture" }, profiles: [{ id: "default", name: "Default" }], activeProfileId: "default" }));
  await fs.writeFile(path.join(root, "overload-monitor.json"), JSON.stringify({ version: 1, accounts: Object.fromEntries(emails.map(email => [email, { enabled: true }])) }));
  await fs.writeFile(path.join(root, "overload-cooldown.json"), JSON.stringify({ version: 1, accounts: Object.fromEntries(emails.map((email, i) => [email, { enabled: true, resumeAccountIds: i === 0 ? ["99"] : [], phase: "cooling", coolingUntil: "2020-01-01T00:00:00Z" }])) }));
  await fs.writeFile(path.join(root, "model-fingerprint.json"), JSON.stringify({ version: 1, settings: { planDefaults: { free: true } }, accounts: {} }));
  await seedWebSession(path.join(root, ids[0], "sub2api-import-oauth.json"));
  await fs.writeFile(path.join(root, "task-settings.json"), JSON.stringify({ maxActiveJobs: 1, webSessionMonitor: { enabled: true, intervalMinutes: 15, autoRelogin: true, retryMinutes: 60 } }));
  await fs.writeFile(path.join(root, "web-session-monitor.json"), JSON.stringify({ version: 1, accounts: { [emails[0]]: { status: "valid", lastCheckedAt: "2020-01-01T00:00:00Z" } } }));
  await start();
  const banned = await job(0);
  assert.equal(banned.overloadDetection.enabled, false, "banned account overload remained enabled");
  assert(off(banned), "all banned account switches must be explicitly disabled");
  assert.equal((await job(2)).autoRepairBlocked, false, "403 must not imply a permanent ban");
  assert.equal((await job(3)).autoRepairBlocked, false, "workspace deactivation must not imply an account ban");
  assert.equal((await job(2)).overloadDetection.enabled, false, "unpooled account is effectively disabled");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "overload-monitor.json"), "utf8")).accounts[emails[2]].enabled, true, "unrelated stored preference preserved");
  for (const suffix of ["overload-detection", "overload-auto-cooldown", "model-fingerprint"]) assert.equal((await api(`/api/jobs/${ids[0]}/${suffix}`, { enabled: true })).status, 409);
  assert.equal((await api(`/api/jobs/${ids[0]}/model-fingerprint/check`, {})).status, 409);
  const checked = await api("/api/web-session-monitor/check", {});
  assert.equal(checked.data.accounts[emails[0]].lastCheckedAt, "2020-01-01T00:00:00Z", "WebSession checks skip a banned account even with saved cookies");
  assert.equal(poolWrites.length, 0, "a banned cooldown must never re-enable the remote pool account");
  const cd = JSON.parse(await fs.readFile(path.join(root, "overload-cooldown.json")));
  assert.deepEqual(cd.accounts[emails[0]].resumeAccountIds, []);
  await api(`/api/jobs/${ids[1]}/web-login`, {});
  await wait(async () => { const j = await job(1); return j.webLoginError && j.autoRepairBlocked && off(j); });
  assert.equal((await job(1)).canDownload, true, "Web-only failure keeps existing authorization artifacts");
  await stop(); await start();
  assert(off(await job(0)) && off(await job(1)), "disabled switches survive restart");
  assert.equal((await api(`/api/jobs/${ids[1]}/relogin`, {})).status, 409, "banned OAuth must not clear the ban");
  assert.equal((await job(1)).canLoginWeb, true, "manual Web remains the available inspection entry point");
  await stop(); await start();
  assert.equal((await job(1)).autoRepairBlocked, true);
  assert(off(await job(1)), "a blocked OAuth click silently re-enabled automation");
  console.log("ACCOUNT_AUTOMATION_BLOCK_PASS startup migration; Web-only ban; switches off; re-enable rejected; WebSession skipped; cooldown never resumes; transient/workspace preserved; restart");
} catch (error) { console.error("ACCOUNT_AUTOMATION_BLOCK_FAIL: " + error.message); process.exitCode = 1; }
finally { await stop(); await new Promise(r => pool.close(r)); await fs.rm(root, { recursive: true, force: true }); }
