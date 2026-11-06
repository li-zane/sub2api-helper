import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

const project = path.resolve(import.meta.dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-security-controls-"));
const trace = path.join(root, "trace.jsonl"), oldPassword = "Original-Fixture-Password-123!", seed = "JBSWY3DPEHPK3PXP";
let server, headers, base, serverLog = "";
const upstream = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/backend-api/accounts/mfa_info") return res.end(JSON.stringify({ mfa_enabled: false, mfa_enabled_v2: false, factors: { totp: [] } }));
  res.statusCode = 404; res.end("{}");
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
let port; do { const socket = http.createServer(); await new Promise(r => socket.listen(0, "127.0.0.1", r)); port = socket.address().port; await new Promise(r => socket.close(r)); } while (port < 10081);
base = `http://127.0.0.1:${port}`;
const wait = async action => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await action().catch(() => null); if (value) return value; await new Promise(r => setTimeout(r, 50)); }
  throw Error("security-controls fixture timed out\n" + serverLog);
};
async function start() {
  server = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: project, windowsHide: true, env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root,
      ONBOARDING_PROTOCOL_SCRIPT: path.join(project, "test/mock-security-controls-protocol.mjs"), SECURITY_CONTROLS_TRACE: trace,
      LOCALAPPDATA: path.join(root, "localappdata"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0", TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: `http://127.0.0.1:${upstream.address().port}`,
      TOSUB2_LOGIN_TIMEOUT_MINUTE_MS: "1000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", d => serverLog += d); server.stderr.on("data", d => serverLog += d);
  const bootstrap = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; });
  headers = { "x-console-token": bootstrap.token, "content-type": "application/json" }; return bootstrap;
}
async function stop() { if (server?.exitCode === null) { const done = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await done; } }
async function api(url, body, method = "POST") {
  const r = await fetch(base + url, { headers, ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json() };
}
const job = async id => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
const waitJob = (id, predicate) => wait(async () => { const j = await job(id); return j && predicate(j) ? j : null; });
const credentials = async id => (await api(`/api/jobs/${id}/credentials`)).data.credentials;
const originals = new Map(), allIds = new Map();
async function create(prefix) {
  const email = `${prefix}-security@example.test`, r = await api("/api/jobs", { email, password: oldPassword, totpSecret: seed });
  assert.equal(r.status, 201); const id = r.data.job.id; allIds.set(prefix, id);
  await waitJob(id, j => j.status === "completed"); originals.set(id, await fs.readFile(path.join(root, id, "sub2api-import-oauth.json"), "utf8")); return id;
}
async function rotate(id) {
  const before = (await api(`/api/jobs/${id}/logs`)).data.logs;
  const r = await api(`/api/jobs/${id}/replace-password`, {}); assert.equal(r.status, 200, JSON.stringify(r));
  return waitJob(id, j => j.status === "completed" && j.lastOperationType === "replace_password" && (j.passwordAddedAt || j.passwordAddError)
    && j.lastOperationAt !== undefined).then(async j => {
      await wait(async () => (await api(`/api/jobs/${id}/logs`)).data.logs.length > before.length);
      return j;
    });
}
try {
  const b = await start(); assert.equal(b.taskSettings.loginTimeoutMinutes, 3);
  const success = await create("success");
  assert.equal((await job(success)).canReplacePassword, true);
  assert.equal((await fetch(base + `/api/jobs/${success}/replace-password`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
  const unknown = await create("unknown");
  assert.equal((await job(unknown)).securityState.passwordEnabled, null, "local stored password was mistaken for remote enabled evidence");
  assert.equal((await job(unknown)).securityState.totpEnabled, null, "local stored seed was mistaken for remote enabled evidence");
  const confirmed = await rotate(success), c = await credentials(success);
  assert.notEqual(c.password, oldPassword); assert.equal(c.passwordAvailable, true); assert.equal(confirmed.securityState.passwordEnabled, true);
  const rotations = () => fs.readFile(trace, "utf8").then(s => s.trim().split("\n").map(JSON.parse).filter(e => e.type === "rotation"));
  const first = (await rotations()).find(e => e.email === "success-security@example.test");
  assert.equal(first.password, c.password); assert.equal(first.previous, oldPassword); assert.equal(first.argsHaveAddPassword, false);
  assert.equal(first.password.length, 12); assert.match(first.password, /[a-z]/); assert.match(first.password, /[A-Z]/); assert.match(first.password, /[0-9]/); assert.match(first.password, /[^A-Za-z0-9]/);
  for (const prefix of ["prepared", "uncertain", "uncertainlegacy"]) {
    const id = await create(prefix); await rotate(id);
    assert.equal((await credentials(id)).password, oldPassword, prefix + " candidate replaced stored password");
    const result = JSON.parse(await fs.readFile(path.join(root, id, "password-add-result.json"), "utf8")); assert.equal(result.activation_succeeded, false);
    const retained = (await api(`/api/jobs/${id}/logs?full=1&credentials=1`)).data.logs;
    assert(retained.includes(oldPassword) && retained.includes(result.password), "failed candidate and original password were not retained in history");
  }
  await stop(); await start();
  for (const prefix of ["prepared", "uncertain", "uncertainlegacy"]) assert.equal((await credentials(allIds.get(prefix))).password, oldPassword, "restart saved an unconfirmed password candidate");
  const late = await create("postconfirm"), afterLate = await rotate(late), lateCreds = await credentials(late);
  const lateTrace = (await rotations()).find(e => e.email === "postconfirm-security@example.test");
  assert.equal(lateCreds.password, lateTrace.password, "confirmed mutation was lost because of later process exit 1"); assert(afterLate.passwordAddError, "post-confirmation failure diagnostic vanished");
  const timeout = await create("timeout");
  assert.equal((await api("/api/task-settings", { maxActiveJobs: 1 })).status, 200);
  const startAt = Date.now(); assert.equal((await api(`/api/jobs/${timeout}/replace-password`, {})).status, 200);
  await waitJob(timeout, j => j.status === "mfa_otp");
  assert.equal((await api(`/api/jobs/${timeout}/replace-password`, {})).status, 409);
  assert.equal((await api(`/api/jobs/${timeout}/credentials`, { password: "" }, "PUT")).status, 409);
  const queued = await api("/api/jobs", { email: "queued-security@example.test", password: oldPassword }); assert.equal(queued.status, 201);
  assert.equal((await job(queued.data.job.id)).status, "queued", "password rotation did not share task concurrency");
  const failed = await waitJob(timeout, j => j.status === "completed" && /LOGIN_TIMEOUT/.test(j.passwordAddError || ""));
  assert.equal(failed.canDownload, true); assert(Date.now() - startAt < 6500, "default 3-minute scaled deadline did not stop rotation");
  assert.equal((await credentials(timeout)).password, oldPassword);
  await waitJob(queued.data.job.id, j => j.status === "completed");
  const remote = await api(`/api/jobs/${success}/security-state`); assert.equal(remote.status, 200);
  assert.equal(remote.data.securityState.totpEnabled, false); assert.equal(remote.data.securityState.passwordEnabled, true, "MFA response without password field erased confirmed password evidence");
  const clear = await api(`/api/jobs/${success}/credentials`, { password: "", totpSecret: "" }, "PUT"); assert.equal(clear.status, 200);
  const cleared = await credentials(success); assert.equal(cleared.password, ""); assert.equal(cleared.totpSecret, "");
  assert.equal((await job(success)).securityState.passwordEnabled, true, "local deletion disabled remote password lamp"); assert.equal((await job(success)).securityState.totpEnabled, false);
  const history = await api(`/api/jobs/${success}/logs?full=1&credentials=1`);
  assert(history.data.logs.includes(oldPassword)); assert(history.data.logs.includes(c.password)); assert(history.data.logs.includes(seed));
  const meta = JSON.parse(await fs.readFile(path.join(root, success, "job-meta.json"), "utf8")); assert.equal(meta.password_manual_override, true);
  await fs.writeFile(path.join(root, success, "password-add-result.json"), JSON.stringify({ version: 1, operation: "replace_password", email: "success-security@example.test", password: c.password,
    stage: "confirmed", activation_succeeded: true, added_at: new Date().toISOString() }));
  await stop(); await start();
  assert.equal((await credentials(success)).password, "", "stale successful result resurrected locally deleted password");
  assert.equal((await job(success)).securityState.passwordEnabled, true); assert.equal((await job(success)).securityState.totpEnabled, false);
  assert.equal((await credentials(late)).password, lateTrace.password, "confirmed password was lost across a subsequent restart");
  assert((await job(late)).passwordAddError, "post-confirmation diagnostic was lost across restart");
  for (const [id, original] of originals) assert.equal(await fs.readFile(path.join(root, id, "sub2api-import-oauth.json"), "utf8"), original);
  const candidates = (await rotations()).map(e => e.password); assert.equal(new Set(candidates).size, candidates.length, "new password reused across attempts");
  for (const value of [oldPassword, seed, ...candidates]) assert(!serverLog.includes(value), "credential leaked to service stdout");
  console.log("SECURITY_CONTROLS_HTTP_PASS auth/busy; shared slots/default-3min timeout; generated strong password; confirmed/late-failure save; unconfirmed/restart rejection; local-clear history; remote-state preservation; stale-result override; OAuth unchanged; no stdout credentials");
} finally { await stop(); await new Promise(r => upstream.close(r)); await fs.rm(root, { recursive: true, force: true }); }
