import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-login-timeout-")), trace = path.join(temp, "trace.jsonl");
const baseline = process.argv.includes("--baseline");
const seedId = "11111111-1111-4111-8111-111111111111", refreshId = "22222222-2222-4222-8222-222222222222";
const originals = new Map();
for (const [id, email] of [[seedId, "timeout-web@example.test"], [refreshId, "timeout-refresh@example.test"]]) {
  const dir = path.join(temp, id); await fs.mkdir(dir);
  const payload = JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, access_token: "original", refresh_token: "original-refresh" }, extra: {} }] });
  originals.set(id, payload); await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), payload);
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", result_saved: true, created_at: "2026-10-01T00:00:00Z", completed_at: "2026-10-01T00:01:00Z" }));
}
let port;
do { const s = http.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); port = s.address().port; await new Promise(r => s.close(r)); } while (port <= 10080);
const base = `http://127.0.0.1:${port}`; let server, headers, logs = "";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async fn => { const end = Date.now() + 15000; while (Date.now() < end) { const value = await Promise.resolve().then(fn).catch(() => null); if (value) return value; await sleep(40); } throw Error("wait timed out\n" + logs); };
const request = async (url, body) => { const r = await fetch(base + url, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; };
const job = async id => (await request("/api/jobs")).data.jobs.find(j => j.id === id);
const waitJob = (id, fn) => wait(async () => { const j = await job(id); return j && fn(j) ? j : null; });
const settings = body => request("/api/task-settings", body);
const create = async (email, extra = {}) => { const r = await request("/api/jobs", { email, ...extra }); assert.equal(r.status, 201, JSON.stringify(r)); return r.data.job.id; };
const start = async () => {
  server = spawn(process.execPath, [process.env.TIMEOUT_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp, ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "test/mock-login-timeout-protocol.mjs"),
      LOGIN_TIMEOUT_TRACE: trace, TOSUB2_LOGIN_TIMEOUT_MINUTE_MS: "1000", SUB2API_MONITOR_ENABLED: "0", LOCALAPPDATA: temp,
      TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  server.stdout.on("data", d => logs += d); server.stderr.on("data", d => logs += d);
  const b = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; });
  headers = { "content-type": "application/json", "x-console-token": b.token }; return b;
};
const stop = async () => { if (server?.exitCode === null) { const done = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await done; } };
let releaseMailbox;
const mailbox = http.createServer(async (req, res) => { await new Promise(r => releaseMailbox = r); res.setHeader("content-type", "application/json"); res.end("[]"); });
await new Promise(r => mailbox.listen(0, "127.0.0.1", r));
try {
  const b = await start();
  if (baseline) {
    await settings({ maxActiveJobs: 1, loginTimeoutMinutes: 1 });
    const id = await create("baseline-timeout@example.test"); await waitJob(id, j => j.status === "mfa_otp"); await sleep(1300);
    assert.equal((await job(id)).status, "mfa_otp");
    console.log("BASELINE_REPRODUCED loginTimeoutMinutes=" + b.taskSettings.loginTimeoutMinutes + "; configured timeout ignored; MFA remains active past deadline");
    process.exitCode = 1;
  } else {
    assert.equal(b.taskSettings.loginTimeoutMinutes, 3);
    for (const value of [0, 1441, 1.5, null, "3", true]) assert.equal((await settings({ loginTimeoutMinutes: value })).status, 400);
    assert.equal((await settings({ maxActiveJobs: 1 })).status, 200);
    assert.equal((await request(`/api/jobs/${seedId}/web-login`, {})).status, 200);
    await waitJob(seedId, j => j.status === "mfa_otp");
    const codex = await create("timeout-codex@example.test"); assert.equal((await job(codex)).status, "queued");
    const failedWeb = await waitJob(seedId, j => !j.webLoginPending && j.webLoginError?.includes("LOGIN_TIMEOUT"));
    assert.equal(failedWeb.status, "completed"); assert.equal(failedWeb.canDownload, true); assert(!failedWeb.webSessionMaintenancePause);
    assert.equal(await fs.readFile(path.join(temp, seedId, "sub2api-import-oauth.json"), "utf8"), originals.get(seedId));
    await waitJob(codex, j => j.status === "mfa_otp"); await sleep(300);
    assert.equal((await job(codex)).status, "mfa_otp", "queue time consumed login budget");
    const fast = await create("fast-after-timeout@example.test");
    const failedCodex = await waitJob(codex, j => j.status === "mfa_failed"); assert.match(failedCodex.lastError, /LOGIN_TIMEOUT.*3/);
    await waitJob(fast, j => j.status === "completed");
    assert.equal((await settings({ loginTimeoutMinutes: 1 })).status, 200);
    await request(`/api/jobs/${refreshId}/regenerate`, {});
    const failedRefresh = await waitJob(refreshId, j => j.lastError?.includes("LOGIN_TIMEOUT")); assert.equal(failedRefresh.canDownload, true);
    assert.equal(await fs.readFile(path.join(temp, refreshId, "sub2api-import-oauth.json"), "utf8"), originals.get(refreshId));
    const live = await create("timeout-live@example.test"); await waitJob(live, j => j.status === "mfa_otp"); await sleep(350);
    await settings({ loginTimeoutMinutes: 3 }); await sleep(900);
    assert.equal((await job(live)).status, "mfa_otp", "extension did not rearm running login");
    const at = Date.now(); await settings({ loginTimeoutMinutes: 1 }); await waitJob(live, j => j.lastError?.includes("LOGIN_TIMEOUT"));
    assert(Date.now() - at < 1000, "shorter setting restarted the budget instead of using elapsed time");
    const canceled = await create("timeout-cancel@example.test"); await waitJob(canceled, j => j.status === "mfa_otp"); await request(`/api/jobs/${canceled}/cancel`, {});
    const canceledError = (await job(canceled)).lastError; await sleep(1200); assert.equal((await job(canceled)).lastError, canceledError);
    assert.equal((await job(fast)).status, "completed", "old timer corrupted completed login");
    const preparing = await create("timeout-preparation@example.test", { mailApiUrl: `http://127.0.0.1:${mailbox.address().port}/mail` });
    await wait(() => releaseMailbox); const afterPrep = await create("fast-after-preparation@example.test");
    await waitJob(preparing, j => j.lastError?.includes("LOGIN_TIMEOUT")); await waitJob(afterPrep, j => j.status === "completed");
    releaseMailbox(); await sleep(200);
    const starts = (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse);
    assert(!starts.some(s => s.email === "timeout-preparation@example.test"), "late preparation revived timed-out login");
    await settings({ loginTimeoutMinutes: 7 }); await stop(); await start();
    assert.equal((await settings()).data.settings.loginTimeoutMinutes, 7);
    await stop(); const file = path.join(temp, "task-settings.json"), legacy = JSON.parse(await fs.readFile(file, "utf8")); delete legacy.loginTimeoutMinutes;
    await fs.writeFile(file, JSON.stringify(legacy)); await start(); assert.equal((await settings()).data.settings.loginTimeoutMinutes, 3);
    console.log("LOGIN_TIMEOUT_HTTP_PASS Web/Codex/refresh MFA deadline; queue exclusion/slot release; live interval grow/shrink; late preparation guard; cancel/success timer cleanup; OAuth byte preservation; settings validation/persistence/legacy defaults");
  }
} finally { releaseMailbox?.(); await stop(); await new Promise(r => mailbox.close(r)); await fs.rm(temp, { recursive: true, force: true }); }
