import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { OperationsBook } from "../src/operations-book.mjs";
import { createCredentialStore } from "../src/credential-store.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "post-auth-recovery-"));
const baseline = process.argv.includes("--baseline");
const late = ["enable-overload-detection", "enable-overload-cooldown", "check-model-fingerprint"];
const actions = ["rotate-logout-reauthorize-upload", ...late];
const fixtures = ["recovered", "mismatch", "paused", "not-authorized", "manual", "automatic"].map((name, i) => ({
  id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`, email: `${name}@example.test`,
  remote: { id: 41 + i, name: `${name}@example.test`, platform: "openai", type: "oauth", status: "active", schedulable: true, group_ids: [], proxy_id: null,
    credentials: { email: `${name}@example.test`, access_token: `fixture-access-${i}`, refresh_token: `fixture-refresh-${i}`, chatgpt_account_id: `workspace-${i}`, plan_type: "free" }, extra: {} },
}));
let child, headers, logs = "", samples = 0, puts = 0, creates = 0, base;
const trace = path.join(temp, "worker-trace"), wrapper = path.join(temp, "protocol.mjs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pool = http.createServer(async (req, res) => {
  let text = ""; for await (const chunk of req) text += chunk;
  const url = new URL(req.url, "http://fixture"), body = JSON.parse(text || "{}");
  res.setHeader("content-type", "application/json");
  const send = data => res.end(JSON.stringify({ code: 0, data }));
  if (url.pathname === "/api/v1/admin/accounts") return send({ items: fixtures.map(f => f.remote), pages: 1, total: fixtures.length });
  if (url.pathname === "/api/v1/admin/accounts/data") return send({ accounts: fixtures.filter(f => String(f.remote.id) === url.searchParams.get("ids")).map(f => f.remote), proxies: [] });
  if (url.pathname.endsWith("/groups/all") || url.pathname.endsWith("/proxies/all")) return send([]);
  if (url.pathname === "/api/v1/admin/accounts/batch") { creates++; return send({ created: 0, accounts: [] }); }
  const recovered = fixtures.find(f => url.pathname === `/api/v1/admin/accounts/${f.remote.id}/clear-error`);
  if (recovered) { recovered.remote.status="active";delete recovered.remote.error_message;return send({}); }
  const scheduled = fixtures.find(f => url.pathname === `/api/v1/admin/accounts/${f.remote.id}/schedulable`);
  if (scheduled) { scheduled.remote.schedulable=body.schedulable;return send({}); }
  const f = fixtures.find(f => url.pathname === `/api/v1/admin/accounts/${f.remote.id}`);
  if (f) {
    if (req.method === "PUT") { puts++; Object.assign(f.remote, body); }
    const { access_token, refresh_token, ...publicCredentials } = f.remote.credentials;
    return send({ ...f.remote, credentials: publicCredentials });
  }
  if (url.pathname.includes("upstream-errors") || url.pathname.includes("usage-logs")) return send({ items: [], pages: 1, total: 0 });
  return send({});
});
const inference = http.createServer(async (req, res) => {
  for await (const _ of req) {} samples++;
  res.setHeader("content-type", "text/event-stream");
  res.end([{ type: "response.output_text.delta", delta: "最终答案：21" }, { type: "response.completed", response: {} }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
});
async function listen(server) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
const poolUrl = `http://127.0.0.1:${await listen(pool)}`, inferenceUrl = `http://127.0.0.1:${await listen(inference)}/responses`;
const slot = http.createServer(), port = await listen(slot); await new Promise(resolve => slot.close(resolve)); base = `http://127.0.0.1:${port}`;
async function api(route, body) {
  const response = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  const data = await response.json(); assert(response.ok, `${route}: ${JSON.stringify(data)}`); return data;
}
const job = async index => (await api("/api/jobs")).jobs.find(j => j.id === fixtures[index].id);
async function wait(fn) {
  for (const end = Date.now() + 20_000; Date.now() < end;) {
    const value = await fn().catch(() => null); if (value) return value;
    if (child?.exitCode != null) throw Error(`helper exited: ${logs}`);
    await pause(40);
  }
  throw Error(`recovery timeout: ${logs}\n${JSON.stringify((await api('/api/jobs')).jobs.map(j => ({ id:j.id,status:j.status,autoTaskStatus:j.autoTaskStatus,error:j.autoTaskError,pool:j.poolRefreshError,fingerprint:j.modelFingerprint?.lastError })))}`);
}
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
      NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp, ONBOARDING_PROTOCOL_SCRIPT: wrapper,
      LOCALAPPDATA: temp, TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp,"credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp,"credentials"),
      SUB2API_MONITOR_ENABLED: "0", TOSUB2_FINGERPRINT_TEST_URL: inferenceUrl,
    },
  });
  child.stdout.on("data", data => logs += data); child.stderr.on("data", data => logs += data);
  const boot = await wait(async () => { const response = await fetch(base + "/api/bootstrap"); return response.ok && response.json(); });
  headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { const exit = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exit; } }

try {
  await fs.writeFile(path.join(temp,"task-settings.json"), JSON.stringify({ maxActiveJobs: 2, autoActions: { free: actions }, monitoring: { accountStatusIntervalSeconds: 3600 }, overloadAutoCooldown: { windowMinutes: 15, threshold: 4, cooldownMinutes: 360 } }));
  await fs.writeFile(path.join(temp,"sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: poolUrl, adminApiKey: "fixture-key", groupIds: [] }, profiles: [{ id: "default", name: "Default", groupIds: [] }], activeProfileId: "default" }));
  await fs.writeFile(path.join(temp,"model-fingerprint.json"), JSON.stringify({ version: 1, settings: { models: ["gpt-5.5"], planDefaults: { free: false }, testSequence: { first: "candy", fingerprint: 0, candy: 1 } }, accounts: {} }));
  for (const [i, f] of fixtures.entries()) {
    const dir = path.join(temp,f.id); await fs.mkdir(dir);
    if (i < 3 || i===5) await fs.writeFile(path.join(dir,"sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ ...f.remote, credentials: { ...f.remote.credentials, ...([1,5].includes(i) ? {refresh_token:"fixture-not-synced"} : {}) } }] }));
    await fs.writeFile(path.join(dir,"job-meta.json"), JSON.stringify({ version: 1, email: f.email, status: [3,4].includes(i) ? "failed" : "completed", result_saved: i<3 || i===5, plan_type: "free", last_operation_type: "reauthorize", last_operation_at: "2026-11-20T22:00:00Z",
      ...(i===5 ? {last_auth_automated:true,last_auth_requirements:{password:true}} : {}),
      auto_task_actions: actions, auto_task_status: "failed", auto_task_index: 0, auto_task_error: "重新授权未完成：fixture timeout", auto_task_fingerprint_run_id: `import-${i}` }));
  }
  const book=new OperationsBook(path.join(temp,"helper-operations.sqlite"));book.open();book.pause(fixtures[2].email,true);book.close();
  const store=createCredentialStore({windowsRoot:path.join(temp,"toSub2","credentials"),linuxRoot:path.join(temp,"credentials"),linuxKey:"ab".repeat(32)});
  await store.save(fixtures[5].email,{password:"fixture-password"});
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
await fs.appendFile(${JSON.stringify(trace)},'authorization\\n');
const file=process.argv[process.argv.indexOf('--sub2api-out')+1];
const email=process.argv[process.argv.indexOf('--email')+1];
const accounts=${JSON.stringify([fixtures[4].remote,fixtures[5].remote])};
await fs.writeFile(file,JSON.stringify({type:'sub2api-data',accounts:[accounts.find(a=>a.credentials.email===email)||accounts[0]]}));
console.log('[ok] Saved sub2api import: '+file);`);
  await start(); await api("/api/sub2api/account-status?refresh=1");
  if (baseline) {
    await pause(1000); const j=await job(0);
    assert.equal(j.autoTaskStatus,"failed"); assert.equal(j.overloadDetection.enabled,false); assert.equal(j.overloadAutoCooldown.enabled,false); assert.equal(samples,0);
    console.log("POST_AUTH_BASELINE automation=failed detection=false cooldown=false importChecks=0");
  } else {
    const first = await wait(async () => { const j=await job(0); return j.autoTaskStatus==="completed" && j.modelFingerprint.result?.source==="import" && j; });
    assert.deepEqual(first.autoTaskActions,late); assert.equal(first.overloadDetection.enabled,true); assert.equal(first.overloadAutoCooldown.enabled,true);
    assert.equal(first.modelFingerprint.result.method,"candy"); assert.equal(samples,1);
    for (const i of [1,2,3,5]) { const j=await job(i); assert.equal(j.autoTaskStatus,"failed"); assert.equal(j.overloadDetection.enabled,false); }
    assert.equal(await fs.readFile(trace,"utf8").catch(()=>""),"", "startup recovery must not log in or rotate credentials");
    assert.equal(puts,0); assert.equal(creates,0);
    await stop(); await start(); await api("/api/sub2api/account-status?refresh=1"); await pause(500);
    assert.equal(samples,1,"restart must not repeat the completed import check");
    await api(`/api/jobs/${fixtures[4].id}/authorize`,{});
    const manual=await wait(async()=>{ const j=await job(4);return j.autoTaskStatus==="completed" && j.modelFingerprint.result?.source==="import" && j; });
    assert.equal(manual.overloadDetection.enabled,true);assert.equal(manual.overloadAutoCooldown.enabled,true);assert.equal(samples,2);
    assert.equal(await fs.readFile(trace,"utf8"),"authorization\n","only the requested authorization runs");
    assert.equal(creates,0);assert(puts>=1,"manual authorization synchronizes the existing pool account");
    await api("/api/sub2api/monitor",{config:{baseUrl:poolUrl,adminApiKey:"fixture-key"},enabled:true});
    await wait(async()=>!(await api("/api/sub2api/monitor")).running);
    fixtures[5].remote.status="error";fixtures[5].remote.error_message="invalid_grant: fixture token expired";
    await api("/api/sub2api/monitor/check",{});
    await wait(async()=>{const j=await job(5);return j.status==="completed" && j.autoRepairLastSuccessAt && j;});
    if (process.argv.includes("--automatic-baseline")) {
      assert.equal((await job(5)).autoTaskStatus,"failed");assert.equal(samples,2);
      console.log("AUTOMATIC_POST_AUTH_BASELINE sync=true automation=failed importChecks=0");
    } else {
      const automatic=await wait(async()=>{const j=await job(5);return j.autoTaskStatus==="completed" && j.modelFingerprint.result?.source==="import" && j;});
      assert.equal(automatic.overloadDetection.enabled,true);assert.equal(automatic.overloadAutoCooldown.enabled,true);assert.equal(samples,3);
      assert.equal(await fs.readFile(trace,"utf8"),"authorization\nauthorization\n","each requested manual/automatic authorization runs only once");
      console.log("POST_AUTH_RECOVERY_PASS startup_manual_automatic=true detection=true cooldown=true importChecks=3 duplicateChecks=0 repeatedAuth=0 paused_and_mismatched=preserved");
    }
  }
} finally {
  await stop(); pool.closeAllConnections(); inference.closeAllConnections();
  await Promise.all([new Promise(resolve=>pool.close(resolve)),new Promise(resolve=>inference.close(resolve))]);
  await fs.rm(temp,{recursive:true,force:true});
}
