import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {createCredentialStore} from "../src/credential-store.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-fingerprint-console-")), output = path.join(temp, "output");
const bannedScenario=process.argv.includes("--banned");
let child, headers, logs = "", samples = 0;
const account = { id: 42, name: "fingerprint@example.test", email: "fingerprint@example.test", platform: "openai", type: "oauth", status: "active", schedulable: true, group_ids: [10, 20, 99], credentials: { email: "fingerprint@example.test", plan_type: "free", access_token: "private-fixture-token", chatgpt_account_id: "fixture-account" }, extra: {} };
const calls = [];
const pool = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  calls.push({ method: req.method, path: req.url, body: JSON.parse(raw || "{}") });
  res.setHeader("content-type", "application/json");
  const send = value => res.end(JSON.stringify({ code: 0, data: value }));
  if (req.url.startsWith("/api/v1/admin/accounts?")) return send({ items: [account], total: 1, pages: 1 });
  if (req.url === "/api/v1/admin/accounts/42") { if (req.method === "PUT") Object.assign(account, JSON.parse(raw)); const { access_token, ...redacted } = account.credentials; return send({ ...account, credentials: redacted }); }
  if (req.url === "/api/v1/admin/accounts/data?ids=42&include_proxies=true") return send({ accounts: [account], proxies: [] });
  if (req.url.includes("/groups/all")) return send([{ id: 10, name: "默认组", platform: "openai" }, { id: 20, name: "验证组", platform: "openai" }]);
  if (req.url.includes("/proxies/all")) return send([]);
  return send({});
});
const inference = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); samples++;
  assert.equal(req.headers.authorization, "Bearer private-fixture-token"); assert.equal(req.headers["chatgpt-account-id"], "fixture-account");
  assert(body.input[0].content[0].text.length > 70); assert.notEqual(body.input[0].content[0].text, "hi");
  res.writeHead(bannedScenario?403:401,{"content-type":"application/json"});res.end(JSON.stringify({error:{code:bannedScenario?"account_deactivated":"token_expired"}}));return;
  const reply = Array.from({ length: 332 }, (_, i) => i % 355 + 1).join(", ");
  res.setHeader("content-type", "text/event-stream");
  res.end([{ type: "response.output_text.delta", delta: reply }, { type: "response.completed", response: {} }].map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
});
await Promise.all([listen(pool), listen(inference)]);
const port = await freePort(), base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "test/fingerprint-auth-reference-loader.mjs")).href, "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: temp, TOSUB2_TLS_PROFILE: "chrome142", TOSUB2_FINGERPRINT_TEST_URL: `http://127.0.0.1:${inference.address().port}/responses`, ONBOARDING_PROTOCOL_SCRIPT:path.join(temp,"protocol.mjs"), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", c => logs += c); child.stderr.on("data", c => logs += c);
  await waitFor(async () => { try { const r = await fetch(base + "/api/bootstrap"); const b = await r.json(); headers = { "x-console-token": b.token, "content-type": "application/json" }; return b.features.modelFingerprint; } catch { return false; } });
}
async function stop() { if (child && child.exitCode === null) { const exited = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await exited; } }
const config = { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture-key", groupIds: [10, 20] };
const settings = { models: ["gpt-5.5", "gpt-5.4"], intervalMinutes: 5, minProbability: .8, planDefaults: { free: false }, groupPolicies: { default: { 10: "default", 20: "verified" } } };
try {
  const id="11111111-1111-4111-8111-111111111111",dir=path.join(output,id);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,"job-meta.json"),JSON.stringify({version:1,email:account.email,status:"completed",result_saved:true,plan_type:"free",last_auth_automated:true,last_auth_requirements:{password:true}}));
  await fs.writeFile(path.join(dir,"sub2api-import-oauth.json"),JSON.stringify({type:"sub2api-data",accounts:[account]}));
  const store=createCredentialStore({windowsRoot:path.join(temp,"toSub2","credentials")});await store.save(account.email,{password:"fixture-password"});
  const marker=path.join(temp,"login-count.txt");
  await fs.writeFile(path.join(temp,"protocol.mjs"),`import fs from 'node:fs/promises';await fs.appendFile(${JSON.stringify(marker)},'login\\n');console.log('[1/5] Start ChatGPT web login');console.log('Email OTP (r=resend, q=quit):');process.stdin.resume();`);
  await start();
  assert.equal((await post("/api/sub2api/settings", {config,profiles:[{id:"default",name:"Free",groupIds:[10,20]}],planTypeBindings:{free:"default"}})).status,200);
  await get("/api/sub2api/account-status?refresh=1");
  assert.equal((await post("/api/model-fingerprint/settings",{settings})).status,200);
  assert.equal((await post(`/api/jobs/${id}/model-fingerprint/check`,{})).status,202);
  await waitFor(async()=>{const job=(await get('/api/jobs')).jobs.find(j=>j.id===id);return job.status===(bannedScenario?'banned':'email_otp');});
  assert.equal(samples,1,'terminal error stops other models and challenges');
  const j=(await get('/api/jobs')).jobs.find(j=>j.id===id);
  if(bannedScenario){
    assert.equal(j.autoRepairBlocked,true);assert.equal(j.modelFingerprint.enabled,false);assert.equal(j.assignedProxyId,null);
    assert.equal(await fs.stat(marker).then(()=>true,()=>false),false,'ban must never start login');
    console.log('FINGERPRINT_BAN_HTTP_PASS explicit upstream ban -> block all automation; no OAuth repair');
  }else{
    assert.equal((await fs.readFile(marker,'utf8')).trim(),'login');
    assert.equal(j.lastOperationType,'automatic_relogin');
    assert.equal(account.status,'active','repair does not depend on pool status=error');
    assert(j.autoRepairLastAttemptAt,'persisted repair cooldown');
    console.log('FINGERPRINT_RECOVERY_HTTP_PASS active pool account + 401 -> one shared Web/OAuth login; persistent cooldown; no duplicate model samples');
  }
} catch (error) {
  const job = await get('/api/jobs').then(result => result.jobs.find(job => job.email === account.email), () => null);
  error.message += "\n" + JSON.stringify({ samples, calls: calls.map(({ method, path }) => ({ method, path })), job: job && {
    id: job.id, status: job.status, step: job.step, error: job.error, lastOperationType: job.lastOperationType,
    autoRepairBlocked: job.autoRepairBlocked, autoRepairLastAttemptAt: job.autoRepairLastAttemptAt,
    modelFingerprint: job.modelFingerprint && {
      enabled: job.modelFingerprint.enabled, phase: job.modelFingerprint.phase,
      lastError: job.modelFingerprint.lastError, resultStatus: job.modelFingerprint.result?.status,
      failureCode: job.modelFingerprint.result?.failure?.code,
    },
  } }) + "\n" + logs;
  for (const value of ["private-fixture-token", "fixture-password", "fixture-key"]) error.message = error.message.replaceAll(value, "[fixture-secret-redacted]");
  throw error;
}
finally { await stop(); await Promise.all([pool, inference].map(server => { server.closeAllConnections(); return new Promise(r => server.close(r)); })); await fs.rm(temp, { recursive: true, force: true }); }
async function listen(server) { do { await new Promise(r => server.listen(0, "127.0.0.1", r)); if(server.address().port>10080) return; await new Promise(r=>server.close(r)); } while(true); }
async function freePort() { const s = http.createServer(); await listen(s); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function get(url) { const r = await fetch(base + url, { headers }); assert.equal(r.status, 200); return r.json(); }
async function post(url, body) { const r = await fetch(base + url, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; }
async function waitFor(fn) { const until = Date.now() + 30000; while (Date.now() < until) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); } throw new Error("fixture timeout"); }
