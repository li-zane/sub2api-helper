import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
const root = path.resolve(import.meta.dirname, ".."), temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-history-"));
let port; do { const s = http.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); port = s.address().port; await new Promise(r => s.close(r)); } while (port < 10081);
const base = `http://127.0.0.1:${port}`, first = "JBSWY3DPEHPK3PXP", second = "MZXW6YTBON2GK3TB";
let server, headers, serverLog = "";
const wait = async fn => { const end = Date.now() + 25000; while (Date.now() < end) { const value = await fn().catch(() => null); if (value) return value; await new Promise(r => setTimeout(r, 60)); } throw Error("fixture wait timeout\n" + serverLog); };
async function start() {
  server = spawn(process.execPath, [process.env.HISTORY_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp, ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "test/mock-credential-durability-protocol.mjs"),
      LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0", TOSUB2_LOGIN_TIMEOUT_MINUTE_MS: "250" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", d => serverLog += d); server.stderr.on("data", d => serverLog += d);
  const b = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; });
  headers = { "x-console-token": b.token, "content-type": "application/json" };
}
async function stop() { if (server?.exitCode === null) { const done = new Promise(r => server.once("exit", r)); server.kill("SIGTERM"); await done; } }
async function api(url, body, method = "POST") { const r = await fetch(base + url, { headers, ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
const job = async id => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
const waitJob = (id, pred) => wait(async () => { const j = await job(id); return j && pred(j) ? j : null; });
const create = async email => { const r = await api("/api/jobs", { email, password: "Fixture-Pass-123!", totpSecret: first }); assert.equal(r.status, 201); await waitJob(r.data.job.id, j => j.status === "completed"); return r.data.job.id; };
try {
  await start();
  const id = await create("durability@example.test");
  if (process.argv.includes("--baseline")) {
    const r = await api(`/api/jobs/${id}/credentials`, { totpSecret: "" }, "PUT");
    assert.equal(r.status, 400); console.log("BASELINE_REPRODUCED blank 2FA save returns HTTP 400; historical logs have no durable account.log"); process.exitCode = 1;
  } else {
    const live = await api(`/api/jobs/${id}/logs`); assert(live.data.truncated); assert(live.data.logs.length <= 80000);
    const full = await api(`/api/jobs/${id}/logs?full=1`); assert.match(full.data.logs, /DURABILITY_FIRST_EVENT/);
    assert.equal((await fetch(base + `/api/jobs/${id}/logs?full=1&credentials=1`)).status, 403);
    assert.equal((await api(`/api/jobs/${id}/replace-2fa`, {})).status, 200);
    await waitJob(id, j => j.status === "completed" && !j.totpRotationIncomplete && j.lastOperationType === "replace_2fa");
    const history = await api(`/api/jobs/${id}/logs?full=1&credentials=1`);
    assert(history.data.logs.includes(first)); assert(history.data.logs.includes(second)); assert(history.data.logs.includes("activation_pending"));
    assert.equal((await api(`/api/jobs/${id}/credentials`, { totpSecret: "   " }, "PUT")).status, 200);
    assert.equal((await job(id)).hasTotpKey, false);
    // Simulate a stale activated result surviving cleanup. Explicit deletion
    // must take precedence over crash recovery, even after another restart.
    await fs.writeFile(path.join(temp, id, "totp-setup-result.json"), JSON.stringify({ version: 1, email: "durability@example.test",
      operation: "replace_totp", activation_succeeded: true, secret: second }));
    await stop(); await start();
    assert.equal((await job(id)).hasTotpKey, false, "restart resurrected a deleted local seed");
    const retained = await api(`/api/jobs/${id}/logs?full=1&credentials=1`); assert(retained.data.logs.includes(first)); assert(retained.data.logs.includes(second)); assert(retained.data.logs.includes("DURABILITY_FIRST_EVENT"));
    for (const email of ["failed-web@example.test", "timeout-web@example.test"]) {
      const target = await create(email), dir = path.join(temp, target), sessionPath = path.join(dir, "web-session.json");
      const identity = await getAccountBrowserIdentity(email, { root: path.join(temp, "browser-identities") });
      await writeAccountWebSession(sessionPath, { email, identity, accessToken: "old-valid-token", cookies: [{ name: "session", value: "old-valid-cookie", domain: "chatgpt.com", path: "/", secure: true, hostOnly: true }], web: {}, validation: { status: "valid", verifiedAt: new Date().toISOString() } });
      const before = await fs.readFile(sessionPath, "utf8");
      assert.equal((await api(`/api/jobs/${target}/web-login`, {})).status, 200);
      await waitJob(target, j => !j.webLoginPending && j.webLoginError);
      assert.equal(await fs.readFile(sessionPath, "utf8"), before, "failed/timed-out Web login replaced the usable session");
      const log = await api(`/api/jobs/${target}/logs?full=1&credentials=1`); assert(log.data.logs.includes("old-valid-cookie")); assert(!log.data.logs.includes("new-candidate-cookie"), "unverified candidate retained as current history");
    }
    assert(!serverLog.includes(first) && !serverLog.includes(second), "credential leaked to service stdout");
    assert.equal((await api("/api/jobs/delete-batch", { ids: [id] })).status, 200);
    await assert.rejects(fs.access(path.join(temp, id)), { code: "ENOENT" });
    console.log("CREDENTIAL_DURABILITY_HTTP_PASS blank seed deletion/restart; old/new/pending 2FA history; >80KB/restart log retention; auth gate; failed/timed-out Web candidate isolation; history deleted only with account");
  }
} finally { await stop(); await fs.rm(temp, { recursive: true, force: true }); }
