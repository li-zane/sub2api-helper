import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."), temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-webfirst-"));
const trace = path.join(temp, "trace.jsonl"); let child, headers, serverLog = "";
const upstream = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.endsWith("mfa_info")) return res.end('{"mfa_enabled":false,"mfa_enabled_v2":false,"factors":{"totp":[]}}');
  if (req.url.includes("eligibility")) return res.end('{"eligible":true}');
  res.end('{}');
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const listener = http.createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r)); const port = listener.address().port; await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`;
const wait = async fn => { for (const end = Date.now() + 20000; Date.now() < end;) { const value = await fn().catch(() => null); if (value) return value; await new Promise(r => setTimeout(r, 60)); } throw Error("wait timeout\n" + serverLog); };
async function start() {
  child = spawn(process.execPath, [process.env.WEBFIRST_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true,
    env: { ...process.env, NODE_ENV: process.argv.includes("--production") ? "production" : "test", TOSUB2_TEST_LEGACY_IMPORT: process.argv.includes("--production") ? "1" : "", WEBFIRST_BASELINE: process.argv.includes("--baseline") ? "1" : "", ONBOARDING_OUTPUT_ROOT: temp, ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "test/mock-webfirst-protocol.mjs"), WEBFIRST_TRACE: trace,
      LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32),
      SUB2API_MONITOR_ENABLED: "0", TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: `http://127.0.0.1:${upstream.address().port}` }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => serverLog += d); child.stderr.on("data", d => serverLog += d);
  const boot = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; }); headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { const end = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await end; } }
async function api(url, body, method = "POST") { const r = await fetch(base + url, { headers, ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
const job = async id => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
const waitJob = (id, predicate) => wait(async () => { const j = await job(id); return j && predicate(j) ? j : null; });
const create = async email => (await api("/api/jobs", { email, password: "Fixture-Password!" })).data.job.id;
const calls = async email => (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse).filter(e => e.email === email);
try {
  await start();
  if (process.argv.includes("--baseline")) {
    const id = await create("baseline@example.test");
    await waitJob(id, j => j.status === "completed" && j.canDownload);
    assert.equal((await api(`/api/jobs/${id}/replace-password`, {})).status, 200);
    await waitJob(id, j => j.status === "completed" && j.lastOperationType === "replace_password");
    assert.equal((await api(`/api/jobs/${id}/credentials`)).data.credentials.password.length, 18);
    assert.equal((await api(`/api/jobs/${id}/logs?view=protocol`)).data.entries, undefined);
    console.log("BASELINE_WEBFIRST_RECORDS_REPRODUCED default_OAuth=true generated_password_length=18 structured_log_entries=false");
    process.exitCode = 1;
  } else {
  const id = await create("web-only@example.test");
  const webOnly = await waitJob(id, j => j.status === "completed" && j.webSessionAvailable && !j.webLoginPending);
  assert.equal(webOnly.canDownload, false); assert.equal(webOnly.planType, "free"); assert.deepEqual((await calls(webOnly.email)).map(c => c.mode), ["web"]);
  assert.equal(webOnly.canReplacePassword, true);
  assert.equal((await api(`/api/jobs/${id}/replace-password`, {})).status, 200);
  await waitJob(id, j => j.status === "completed" && j.lastOperationType === "replace_password");
  const credentials = (await api(`/api/jobs/${id}/credentials`)).data.credentials;
  assert.equal(credentials.password.length, 12); assert.equal((await job(id)).canDownload, false);
  const list = (await api(`/api/jobs/${id}/logs?view=protocol`)).data;
  assert(list.entries.some(e => e.type === "initial_web_login")); assert(list.entries.some(e => e.type === "replace_password")); assert.equal(list.content, "");
  const selected = list.entries.find(e => e.type === "replace_password");
  const detail = (await api(`/api/jobs/${id}/logs?view=protocol&entry=${selected.id}`)).data;
  assert(detail.content.includes("Account password changed")); assert(!detail.content.includes("Saved web session"));
  assert.equal((await fetch(base + `/api/jobs/${id}/logs?view=credentials`)).status, 403);
  const history = (await api(`/api/jobs/${id}/logs?view=credentials`)).data;
  assert(history.entries.filter(e => e.type === "password").length >= 3); assert.equal(history.entries.filter(e => e.type === "web_session").length, 1);
  await stop(); await start();
  const restored = await job(id); assert.equal(restored.webSessionAvailable, true); assert.equal(restored.canDownload, false); assert.equal(restored.status, "completed");
  assert.equal((await api("/api/task-settings", { autoActions: { team: ["authorize-codex"] } })).status, 200);
  const teamId = await create("team-rule@example.test");
  await waitJob(teamId, j => j.status === "completed" && j.canDownload && j.autoTaskStatus === "completed");
  assert.deepEqual((await calls("team-rule@example.test")).map(c => c.mode), ["web", "oauth"]);
  const freeId = await create("free-rule@example.test"); await waitJob(freeId, j => j.status === "completed" && j.webSessionAvailable && !j.webLoginPending);
  assert.deepEqual((await calls("free-rule@example.test")).map(c => c.mode), ["web"]);
  const bannedId = await create("banned-account@example.test"); const banned = await waitJob(bannedId, j => j.status === "banned");
  assert.equal(banned.canReplacePassword, false); assert.equal(banned.canReplaceTotp, false);
  assert.equal((await api(`/api/jobs/${bannedId}/replace-password`, {})).status, 409); assert.equal((await api(`/api/jobs/${bannedId}/replace-2fa`, {})).status, 409);
  assert(!serverLog.includes(credentials.password));
  console.log("WEBFIRST_RECORDS_HTTP_PASS default Web-only import; plan-specific opt-in OAuth, no automatic upload; Web-only password rotation exactly12; grouped/lazy/authenticated logs; password history and current Web; restart preservation; banned rotation APIs blocked");
  }
} finally { await stop(); await new Promise(r => upstream.close(r)); await fs.rm(temp, { recursive: true, force: true }); }
