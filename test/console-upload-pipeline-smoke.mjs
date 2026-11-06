import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, ".."), temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-upload-pipeline-"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, headers, output = "", base, held = null, first = true, creates = 0, rows = [], nextId = 1, logouts = 0;
const json = (res, data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
const official = http.createServer(async (req, res) => {
  for await (const _ of req) {}
  if (req.method === "POST" && req.url === "/backend-api/accounts/logout_all") { logouts++; return json(res, { ok: true }); }
  return json(res, { error: "unexpected official fixture request" }, 404);
});
const pool = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"), chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (req.method === "GET" && url.pathname === "/api/v1/admin/accounts") return json(res, { data: { items: rows, pages: 1, total: rows.length } });
  if (req.method === "GET" && url.pathname === "/api/v1/admin/groups/all") return json(res, { data: [{ id: 1, name: "fixture", platform: "openai", status: "active" }] });
  if (req.method === "GET" && url.pathname === "/api/v1/admin/proxies/all") return json(res, { data: [] });
  if (req.method === "POST" && url.pathname === "/api/v1/admin/accounts/batch") {
    creates++;
    const commit = () => {
      const added = body.accounts.map(account => ({ ...account, id: nextId++, created_at: new Date().toISOString() }));
      rows.push(...added); return json(res, { data: { created: added.length, accounts: added } });
    };
    if (first) { first = false; held = commit; return; }
    return commit();
  }
  const id = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
  if (id) {
    const account = rows.find(row => row.id === Number(id[1]));
    if (!account) return json(res, { message: "not found" }, 404);
    if (req.method === "PUT") Object.assign(account, body);
    return json(res, { data: account });
  }
  return json(res, { message: "unexpected pool fixture request" }, 404);
});
async function listen(server) {
  while (true) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const p = server.address().port; if (p > 10080) return p; await new Promise(resolve => server.close(resolve)); }
}
const officialUrl = `http://127.0.0.1:${await listen(official)}`, poolUrl = `http://127.0.0.1:${await listen(pool)}`;
const listener = http.createServer(), port = await listen(listener); await new Promise(resolve => listener.close(resolve)); base = `http://127.0.0.1:${port}`;
await fs.writeFile(path.join(temp, "task-settings.json"), JSON.stringify({ maxActiveJobs: 2, autoActions: { free: ["rotate-logout-reauthorize-upload"] } }));
await fs.writeFile(path.join(temp, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: poolUrl, adminApiKey: "fixture-admin-key", groupIds: [1] },
  profiles: [{ id: "default", name: "fixture", groupIds: [1] }], activeProfileId: "default" }));
const wait = async fn => { const end = Date.now() + 30000; while (Date.now() < end) { const result = await fn().catch(() => null); if (result) return result; if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error("helper exited\n" + output); await pause(40); } throw Error("pipeline fixture timeout\n" + output); };
async function api(route, body) { const r = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; }
try {
  child = spawn(process.execPath, [process.env.UPLOAD_PIPELINE_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp, ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "test/mock-upload-pipeline-protocol.mjs"),
      LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0", TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: officialUrl, AUTH_BASE: officialUrl },
    stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
  const b = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; });
  headers = { "x-console-token": b.token, "content-type": "application/json" };
  const started = await api("/api/jobs", { email: "pipeline@example.test", password: "Fixture-Pass-123!", totpSecret: "JBSWY3DPEHPK3PXP" });
  assert.equal(started.status, 201); const id = started.data.job.id;
  const job = async () => (await api("/api/jobs")).data.jobs.find(job => job.id === id);
  await wait(async () => held !== null);
  assert.equal(logouts, 1, "rotation pipeline did not use logout/re-authorization path");
  if (process.argv.includes("--baseline")) {
    await wait(async () => creates >= 2); held(); held = null;
    await wait(async () => (await job())?.autoTaskStatus === "completed");
    assert.equal(rows.length, 2);
    console.log("UPLOAD_PIPELINE_BASELINE_REPRODUCED rotate-and-upload outer task raced login-completion pool refresh; two create requests/two rows");
    process.exitCode = 1;
  } else {
    await pause(1800);
    assert.equal(creates, 1, "rotation pipeline started a redundant second upload while the completion upload was pending");
    assert.equal((await job()).autoTaskStatus, "running", "pipeline reported completion before pool synchronization");
    held(); held = null;
    await wait(async () => (await job())?.autoTaskStatus === "completed");
    const final = await job(); assert.equal(final.poolRefreshAction, null); assert.equal(final.poolRefreshError, null);
    assert.equal(creates, 1); assert.equal(rows.length, 1);
    console.log("UPLOAD_PIPELINE_HTTP_PASS automatic 2FA rotation/logout/re-authorization waited for the in-flight pool synchronization; exactly one upload/create and one row");
  }
} finally {
  if (held) { held(); held = null; }
  if (child?.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done; }
  official.closeAllConnections?.(); pool.closeAllConnections?.(); await Promise.all([new Promise(resolve => official.close(resolve)), new Promise(resolve => pool.close(resolve))]);
  await fs.rm(temp, { recursive: true, force: true });
}
