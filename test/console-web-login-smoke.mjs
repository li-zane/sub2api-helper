import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-web-login-console-"));
const output = path.join(temp, "output");
const tracePath = path.join(temp, "trace.jsonl");
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const originals = new Map();
const upstream = http.createServer((req, res) => {
  assert.match(req.headers.authorization, /^Bearer web\./);
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/backend-api/accounts/check/")) return res.end(JSON.stringify({ accounts: [{ id: "fixture-workspace", plan_type: "free", name: "Personal", structure: "personal" }] }));
  if (req.url.startsWith("/backend-api/accounts/sessions")) return res.end(JSON.stringify({ devices: [{ session_id: "web", is_current_device: true, app_sessions: [{ client_name: "ChatGPT Web" }] }] }));
  assert.fail(`Unexpected upstream call ${req.url}`);
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
const portListener = http.createServer();
await new Promise(resolve => portListener.listen(0, "127.0.0.1", resolve));
const port = portListener.address().port;
await new Promise(resolve => portListener.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, exited, headers, logs = "";
const waitFor = async callback => {
  const end = Date.now() + 25000;
  while (Date.now() < end) { const result = await callback().catch(() => null); if (result) return result; await new Promise(resolve => setTimeout(resolve, 70)); }
  throw new Error(`wait timeout\n${logs}`);
};
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root,
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output,
      ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "test/mock-web-login-protocol.mjs"), WEB_LOGIN_TRACE: tracePath,
      LOCALAPPDATA: temp, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32),
      SUB2API_MONITOR_ENABLED: "0", TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: `http://127.0.0.1:${upstream.address().port}` },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  exited = new Promise(resolve => child.once("exit", resolve));
  const boot = await waitFor(async () => { const response = await fetch(`${base}/api/bootstrap`); return response.ok ? response.json() : null; });
  assert.equal(boot.features.webLogin, true);
  headers = { "content-type": "application/json", "x-console-token": boot.token };
}
async function stop() { if (child?.exitCode === null) { child.kill("SIGTERM"); await exited; } }
async function request(url, body) {
  const response = await fetch(`${base}${url}`, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const job = async id => (await request("/api/jobs")).data.jobs.find(item => item.id === id);
const waitJob = (id, predicate) => waitFor(async () => { const value = await job(id); return predicate(value) ? value : null; });
const release = async id => { const result = await request(`/api/jobs/${id}/input`, { action: "email_otp", value: "123456" }); assert.equal(result.status, 200, JSON.stringify(result)); };
const metaPath = id => path.join(output, id, "job-meta.json");
try {
  for (const [i, id] of ids.entries()) {
    const dir = path.join(output, id); await fs.mkdir(dir, { recursive: true });
    const email = ["web-a@example.test", "web-b@example.test", "web-fail@example.test", "web-only@example.test"][i];
    const contents = JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, access_token: `original-Codex-${i}`, refresh_token: `original-refresh-${i}` }, extra: {} }] });
    if (i !== 3) { await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), contents); originals.set(id, contents); }
    await fs.writeFile(metaPath(id), JSON.stringify({ version: 1, email, status: i === 3 ? "failed" : "completed", result_saved: i !== 3, created_at: new Date().toISOString(), completed_at: "2026-10-01T00:00:00.000Z", last_operation_type: "initial_authorization", last_auth_automated: true }));
  }
  await start();
  assert.equal((await request("/api/task-settings", { maxActiveJobs: 1 })).status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${ids[0]}/web-login`, { method: "POST" })).status, 403);
  const full = await request("/api/jobs", { email: "authorization@example.test" });
  assert.equal(full.status, 201); const fullId = full.data.job.id;
  await waitJob(fullId, j => j.status === "email_otp");
  const batch = await request("/api/jobs/web-login-batch", { ids: ids.slice(0, 2) });
  assert.equal(batch.data.started, 2);
  assert.equal((await job(ids[0])).status, "queued"); assert.equal((await job(ids[1])).status, "queued");
  assert.equal((await request(`/api/jobs/${ids[0]}/web-login`, {})).status, 409);
  assert.equal((await request("/api/jobs/web-login-batch", { ids: [ids[0]] })).data.skipped, 1);
  await release(fullId);
  const activeA = await waitFor(async () => { for (const id of ids.slice(0, 2)) if ((await job(id)).status === "email_otp") return id; });
  const activeB = ids.slice(0, 2).find(id => id !== activeA);
  assert.equal((await job(activeB)).status, "queued", "Web and authorization share the same single slot");
  const attempts = batch.data.jobs.map(j => ({ id: j.id, attemptId: j.webLoginAttemptId }));
  const progressBefore = await request("/api/jobs/web-login-progress", { attempts });
  assert.equal(progressBefore.status, 200);
  assert(progressBefore.data.progress.some(p => p.phase === "input"));
  assert(progressBefore.data.progress.some(p => p.phase === "queued"));
  await release(activeA); await waitJob(activeA, j => !j.webLoginPending && j.webLoginCompletedAt);
  await waitJob(activeB, j => j.status === "email_otp");
  const webA = await job(activeA);
  assert.equal(webA.status, "completed"); assert.equal(webA.completedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(webA.canDownload, true); assert.equal(webA.webSessionAvailable, true);
  assert.equal((await request(`/api/jobs/${activeA}/workspaces`)).status, 200);
  assert.equal((await request(`/api/jobs/${activeA}/sessions`)).data.sessions.devices[0].appSessions[0], "ChatGPT Web");
  const progressAfter = await request("/api/jobs/web-login-progress", { attempts });
  assert.equal(progressAfter.data.progress.find(p => p.id === activeA).phase, "success");
  const mixed = await request("/api/jobs/web-login-batch", { ids: [activeA, activeB] });
  assert.equal((await request("/api/jobs/web-login-progress", { attempts })).data.progress.find(p => p.id === activeA).phase, "failed", "later attempt does not replace prior batch success");
  assert.equal(mixed.data.skippedJobs[0].id, activeB);
  assert.equal(mixed.data.started, 1); assert.equal(mixed.data.skipped, 1);
  assert.equal((await request(`/api/jobs/${activeA}/cancel`, {})).status, 200);
  await waitJob(activeA, j => !j.webLoginPending && j.webLoginError?.includes("取消"));
  await request(`/api/jobs/${activeB}/cancel`, {});
  await waitJob(activeB, j => !j.webLoginPending && j.webLoginError?.includes("取消"));
  await request(`/api/jobs/${ids[2]}/web-login`, {}); await waitJob(ids[2], j => j.status === "email_otp");
  await release(ids[2]); const failed = await waitJob(ids[2], j => !j.webLoginPending && j.webLoginError);
  assert.equal(failed.status, "completed"); assert.equal(failed.canDownload, true);
  await request(`/api/jobs/${ids[3]}/web-login`, {}); await waitJob(ids[3], j => j.status === "email_otp");
  await release(ids[3]); const webOnly = await waitJob(ids[3], j => !j.webLoginPending && j.webLoginCompletedAt);
  assert.equal(webOnly.canDownload, false); assert.equal(webOnly.status, "failed", "Web login never fabricates Codex authorization success");
  assert.equal((await request(`/api/jobs/${ids[3]}/workspaces`)).status, 200);
  assert.equal((await request(`/api/jobs/${ids[3]}/workspaces/switch`, { workspaceId: "fixture-workspace" })).status, 200);
  await assert.rejects(fs.access(path.join(output, ids[3], "sub2api-import-oauth.json")), { code: "ENOENT" });
  assert.equal((await request("/api/task-settings", { maxActiveJobs: 2 })).status, 200);
  await request("/api/jobs/web-login-batch", { ids: ids.slice(0, 2) });
  await Promise.all(ids.slice(0, 2).map(id => waitJob(id, j => j.status === "email_otp")));
  assert.equal((await request("/api/jobs/reauthorize-batch", { ids: [fullId] })).status, 200);
  assert.equal((await job(fullId)).status, "queued");
  await Promise.all(ids.slice(0, 2).map(release));
  await Promise.all(ids.slice(0, 2).map(id => waitJob(id, j => !j.webLoginPending && j.status === "completed")));
  await waitJob(fullId, j => j.status === "email_otp"); await release(fullId); await waitJob(fullId, j => j.status === "completed");
  await stop();
  const metadata = JSON.parse(await fs.readFile(metaPath(ids[0]), "utf8"));
  metadata.status = "queued"; metadata.queued_mode = "web_login";
  metadata.web_login_previous_state = { status: "completed", completedAt: metadata.completed_at, prompt: "original authorization", lastError: null };
  await fs.writeFile(metaPath(ids[0]), JSON.stringify(metadata));
  await start(); await waitJob(ids[0], j => j.status === "email_otp"); await release(ids[0]);
  await waitJob(ids[0], j => !j.webLoginPending && j.webLoginCompletedAt);
  await stop(); metadata.status = "email_otp";
  await fs.writeFile(metaPath(ids[0]), JSON.stringify(metadata));
  await start();
  const interrupted = await job(ids[0]); assert.equal(interrupted.status, "completed"); assert.match(interrupted.webLoginError, /重启中断/);
  for (const [id, contents] of originals) assert.equal(await fs.readFile(path.join(output, id, "sub2api-import-oauth.json"), "utf8"), contents);
  const traces = (await fs.readFile(tracePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert(traces.filter(t => t.web).every(t => t.event !== "start" || (t.mode === "web" && t.authMode === "local" && !t.hasPoolKey)));
  const latestWeb = JSON.parse(await fs.readFile(path.join(output, ids[0], "web-session.json"), "utf8"));
  assert.equal(latestWeb.email, "web-a@example.test");
  console.log("PASS: single/batch Web-only login, authenticated endpoints, shared authorization queue and live concurrency limit, duplicate/busy isolation, cancellation/failure/restart recovery, Web-only workspace access and byte-for-byte Codex preservation");
} finally {
  await stop(); await new Promise(resolve => upstream.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
