import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createConsoleClient } from "../web/src/console-api.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-token-recovery-"));
const id = "11111111-1111-4111-8111-111111111111", email = "token-recovery@example.test";
const listener = http.createServer();
await new Promise(r => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`;
let child, headers, logs = "";
const calls = [];
const client = createConsoleClient({ baseUrl: base, fetch: async (input, options) => {
  const request = input instanceof Request ? input : new Request(input, options);
  const response = await fetch(request);
  calls.push({ path: new URL(request.url).pathname, method: request.method, status: response.status });
  return response;
} });
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root,
      LOCALAPPDATA: root, TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"),
      TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"), SUB2API_MONITOR_ENABLED: "0" },
  });
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
    if (child.exitCode !== null) throw Error(logs);
    try { const data = await fetch(base + "/api/bootstrap").then(r => r.json()); if (data.token) return data.token; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  throw Error("fixture startup timeout\n" + logs);
}
async function stop() {
  if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; }
}
try {
  await fs.mkdir(path.join(root, id));
  await fs.writeFile(path.join(root, id, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", plan_type: "free" }));
  await start();
  const first = await client.bootstrap(); headers = { "x-console-token": first.token, "content-type": "application/json" };
  assert.equal((await client.fetch(base + "/api/jobs", { headers })).status, 200);
  await stop(); const secondToken = await start(); assert.notEqual(secondToken, first.token);
  const rejected = await fetch(base + "/api/jobs", { headers });
  assert.equal(rejected.status, 403); assert.equal((await rejected.json()).code, "INVALID_CONSOLE_TOKEN");
  const responses = await Promise.all([
    client.fetch(base + "/api/jobs", { headers }), client.fetch(base + "/api/task-settings", { headers }),
    client.fetch(base + "/api/jobs/query", { method: "POST", headers, body: JSON.stringify({ emails: [email] }) }),
  ]);
  assert(responses.every(r => r.status === 200));
  const query = await responses[2].json(); assert.deepEqual(query.jobs.map(j => j.id), [id]);
  assert.equal(calls.filter(c => c.path === "/api/bootstrap").length, 2);
  assert.equal(calls.filter(c => c.path === "/api/jobs/query" && c.status === 200).length, 1);
  await stop(); await start();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.fetch(base + "/api/jobs", { headers, signal: controller.signal }), { name: "AbortError" });
  const final = await client.fetch(base + "/api/jobs", { headers }).then(r => r.json());
  assert.deepEqual(final.jobs.map(j => j.id), [id]);
  assert.equal(calls.filter(c => c.path === "/api/bootstrap").length, 3);
  console.log("CONSOLE_TOKEN_HTTP_PASS real_restarts=2 old_token_rejected=true concurrent_recovery=true read_and_post=true canceled_request=true account_preserved=true");
} finally {
  await stop();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith("helper-token-recovery-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
