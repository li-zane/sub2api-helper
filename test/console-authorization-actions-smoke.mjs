import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const source = path.resolve(process.env.AUTH_ACTIONS_ROOT || ".");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-actions-"));
const id = "11111111-1111-4111-8111-000000000001";
const dir = path.join(root, id), checkpoint = path.join(dir, "login-checkpoint.json");
const email = "checkpoint@example.test", trace = path.join(root, "trace.jsonl");
const wrapper = path.join(root, "protocol.mjs");
let child, exited, logs = "", base, headers;
const wait = async predicate => {
  for (let i = 0; i < 300; i++) {
    const value = await predicate();
    if (value) return value;
    if (child?.exitCode != null) throw Error(logs);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw Error("fixture timed out\n" + logs);
};
async function request(route, body) {
  const res = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json() };
}
const job = async () => (await request("/api/jobs")).data.jobs.find(job => job.id === id);
const traces = async () => (await fs.readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
async function start() {
  const socket = http.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(source, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, ONBOARDING_PROTOCOL_SCRIPT: wrapper,
      LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "creds"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "creds"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0",
    },
  });
  child.stdout.on("data", value => { logs += value; }); child.stderr.on("data", value => { logs += value; });
  exited = new Promise(resolve => child.once("exit", resolve));
  const boot = await wait(async () => { try { return await (await fetch(base + "/api/bootstrap")).json(); } catch { return null; } });
  headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { child.kill("SIGTERM"); await exited; } }
try {
  await fs.mkdir(dir, { recursive: true });
  const original = JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, plan_type: "free", access_token: "saved-access", refresh_token: "saved-refresh" } }] });
  await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), original);
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: "canceled", result_saved: true, plan_type: "free", login_checkpoint_available: false }));
  await fs.writeFile(checkpoint, JSON.stringify({ version: 1, email, stage: "phone_required", cookies: [], oauth: {} }));
  // The protocol fixture observes the actual filesystem passed by the server.
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
const checkpoint=process.argv[process.argv.indexOf('--resume-checkpoint')+1];
const resumed=await fs.access(checkpoint).then(()=>true,()=>false);
await fs.appendFile(${JSON.stringify(trace)},JSON.stringify({resumed})+String.fromCharCode(10));
console.log('[checkpoint] Saved verified email login state.');
console.log('Phone number, E.164 format (p=quit): ');
process.stdin.resume();
`);
  await start();
  assert.equal((await job()).canResume, true, "canceled task with a saved phone checkpoint must offer continue authorization");
  const selection = (await request("/api/jobs")).data.selection.find(job => job.id === id);
  assert.equal(selection.canResume, true, "selection and visible row must agree");
  assert.equal((await request(`/api/jobs/${id}/retry`, {})).status, 200);
  await wait(async () => (await job()).status === "phone");
  assert.equal((await traces()).at(-1).resumed, true, "continue preserves checkpoint");
  assert.equal((await request(`/api/jobs/${id}/download`)).status, 200, "old export remains readable while waiting for phone input");
  assert.equal((await request(`/api/jobs/${id}/credentials`)).status, 200);
  assert.equal((await request(`/api/jobs/${id}/relogin`, {})).status, 409, "restart cannot overlap an active authorization");
  await request(`/api/jobs/${id}/cancel`, {});
  assert.equal((await job()).canResume, true);
  await stop(); await start();
  assert.equal((await job()).canResume, true, "continuation survives service restart with an old OAuth export");
  assert.equal((await request(`/api/jobs/${id}/relogin`, {})).status, 200);
  await wait(async () => (await job()).status === "phone");
  assert.equal((await traces()).at(-1).resumed, false, "restart clears the old authorization checkpoint");
  await request(`/api/jobs/${id}/cancel`, {});
  assert.equal(await fs.readFile(path.join(dir, "sub2api-import-oauth.json"), "utf8"), original);
  await stop(); await start();
  assert.equal((await job()).canResume, false, "stale metadata does not invent a missing checkpoint");
  console.log("AUTHORIZATION_ACTIONS_PASS continue preserves checkpoint; restart clears checkpoint; restart persistence; read access during phone input; mutation exclusion; original OAuth preserved");
} finally { await stop(); await fs.rm(root, { recursive: true, force: true }); }
