import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-plan-proxy-"));
const output = path.join(temp, "output");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const tracePath = path.join(temp, "trace.jsonl");
const wrapper = path.join(temp, "protocol.mjs");
const planOverrides = path.join(temp, "plan-overrides.json");
const dynamic = "http://user-sid-12345678-t-20:fixture@dynamic.invalid:8080";
const accounts = [{ id: 1, platform: "openai", type: "oauth", status: "active", proxy_id: 1, credentials: { email: "existing@example.test", plan_type: "plus" } }];
const proxies = [
  { id: 1, name: "A", protocol: "http", host: "a.invalid", port: 8080, ip_address: "198.51.100.10", status: "active" },
  { id: 2, name: "A2", protocol: "http", host: "a2.invalid", port: 8080, ip_address: "198.51.100.10", status: "active" },
  { id: 3, name: "B", protocol: "http", host: "b.invalid", port: 8080, ip_address: "198.51.100.20", status: "active" },
];
const requests = [];
let proxiesAvailable = true;
const remote = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const url = new URL(req.url, "http://fixture");
  requests.push({ path: url.pathname, body });
  if (url.pathname === "/api/v1/admin/proxies/all") return send(res, proxiesAvailable ? proxies : []);
  if (url.pathname.startsWith("/api/v1/admin/proxies/")) return send(res, { data: proxies.find((item) => item.id === Number(url.pathname.split("/").at(-1))) });
  if (url.pathname === "/api/v1/admin/groups/all") return send(res, []);
  if (url.pathname === "/api/v1/admin/accounts" && req.method === "GET") return send(res, { data: { items: accounts, total: accounts.length, pages: 1 } });
  if (url.pathname === "/api/v1/admin/accounts/batch") {
    for (const account of body.accounts) accounts.push({ ...account, id: 100 + accounts.length });
    return send(res, { success: body.accounts.length, failed: 0 });
  }
  if (/\/api\/v1\/admin\/accounts\/\d+$/.test(url.pathname)) {
    const account = accounts.find((item) => item.id === Number(url.pathname.split("/").at(-1)));
    if (account) Object.assign(account, body);
    return send(res, { success: true });
  }
  return send(res, {});
});
let rejectSessionLogout = true;
const sessionUpstream = http.createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  res.setHeader("content-type", "application/json");
  if (req.url === "/oauth/token") {
    const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    res.end(JSON.stringify({ access_token: `header.${claims}.signature`, refresh_token: "fixture-refresh" }));
  } else if (req.url === "/backend-api/accounts/logout_all" && !rejectSessionLogout) {
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: { message: "fixture logout rejected" } }));
  }
});
let child;
let headers;
let logs = "";
let poolBase;
let sessionBase;
const profiles = [
  { id: "default", name: "Balanced", proxyId: "balanced" },
  { id: "free", name: "Direct", proxyId: "direct" },
  { id: "pro", name: "Pinned", proxyId: "3" },
  { id: "keep", name: "Keep", proxyId: "" },
];
try {
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(wrapper, `import fs from "node:fs/promises";
import { seedWebSession } from ${JSON.stringify(new URL("./account-web-fixture.mjs", import.meta.url).href)};
const email = process.argv[process.argv.indexOf("--email") + 1];
const output = process.argv[process.argv.indexOf("--sub2api-out") + 1];
await fs.appendFile(${JSON.stringify(tracePath)}, JSON.stringify({ phase: "login", email, proxy: process.env.CHATGPT_PROXY_URL, helperLoginProxy: JSON.parse(process.env.TOSUB2_WEB_LOGIN_PROXY || "null"), fixed: process.env.CHATGPT_PROXY_FIXED }) + "\\n");
console.log("[1/5] Start ChatGPT web login");
console.log("Email OTP (r=resend, q=quit):");
process.stdin.resume();
await new Promise(resolve => process.stdin.once("data", resolve));
const overrides = JSON.parse(await fs.readFile(${JSON.stringify(planOverrides)}, "utf8").catch(() => "{}"));
const planType = overrides[email] || (email.startsWith("free") ? "free" : email.startsWith("pro") ? "pro" : email.startsWith("keep") ? "keep" : "plus");
const route = process.env.TOSUB2_PHASED_PROXY === "1" ? await new Promise((resolve, reject) => {
  process.once("message", message => message.error ? reject(new Error(message.error)) : resolve(message.route));
  process.send({ type: "codex-proxy-request", id: "fixture", planType, workspaceId: "workspace-personal" });
}) : { proxyUrl: process.env.CHATGPT_PROXY_URL || null, sub2ApiOAuth: { proxyId: Number(process.env.TOSUB2_OAUTH_PROXY_ID) || null } };
await fs.appendFile(${JSON.stringify(tracePath)}, JSON.stringify({ phase: "codex", email, route }) + "\\n");
if (process.argv.includes("--web-only")) {
 await seedWebSession(output);
 console.log("[ok] Saved web session: " + process.env.TOSUB2_WEB_SESSION_PATH);
} else {
await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, plan_type: planType, access_token: "fixture", refresh_token: "fixture" }, extra: { email, plan_type: planType } }] }));
await seedWebSession(output);
console.log("[ok] Saved sub2api import: " + output);
}
process.disconnect(); process.stdin.destroy();
`);

  const originals = new Map();
  const known = ["free-known", "pro-known", "plus-known", "keep-known", "free-unbound"];
  for (const [i, name] of known.entries()) {
    const id = `${String(i+1).repeat(8)}-1111-4111-8111-111111111111`, email = name + "@example.test";
    const planType = name.split("-")[0], assigned = name.endsWith("unbound") || planType === "plus" ? null : 1;
    const dir = path.join(output,id);await fs.mkdir(dir);
    const original = JSON.stringify({ type:"sub2api-data", accounts:[{ credentials:{email,plan_type:planType,access_token:"original",refresh_token:"original"},extra:{} }] });
    await fs.writeFile(path.join(dir,"sub2api-import-oauth.json"), original); originals.set(id,original);
    await fs.writeFile(path.join(dir,"job-meta.json"),JSON.stringify({version:1,email,status:"completed",plan_type:planType,authorization_proxy_selected:Boolean(assigned),assigned_proxy_id:assigned,bound_ip:assigned?"198.51.100.10":null}));
    accounts.push({id:100+i,platform:"openai",type:"oauth",status:"active",proxy_id:assigned||0,credentials:{email,plan_type:planType}});
  }
  await new Promise(resolve=>remote.listen(0,"127.0.0.1",resolve));poolBase=`http://127.0.0.1:${remote.address().port}`;
  await new Promise(resolve=>sessionUpstream.listen(0,"127.0.0.1",resolve));sessionBase=`http://127.0.0.1:${sessionUpstream.address().port}`;
  await start();await settings();
  assert.equal((await post("/api/task-settings",{accountProxyMode:"plan",codexAuthMode:"sub2api",maxActiveJobs:8})).status,200);
  // No global dynamic proxy: imported known plans must not require it.
  const selected=(await jobs()).filter(j=>known.some(n=>j.email===n+"@example.test"));assert.equal(selected.length,known.length);
  const first=await post("/api/jobs/web-login-batch",{ids:selected.map(j=>j.id)});assert.equal(first.body.started,known.length);
  await waitFor(async()=> (await jobs()).filter(j=>selected.some(x=>x.id===j.id)&&j.status==="email_otp").length===known.length);
  for(const j of selected){
    const current=await job(j.id), log=(await trace()).findLast(t=>t.email===j.email&&t.phase==="login");
    assert.equal(log.fixed,"1");
    assert.equal(log.helperLoginProxy.kind, log.proxy ? "proxy" : "direct");
    if (current.assignedProxyId) assert.equal(log.helperLoginProxy.name, proxies.find(p => p.id === current.assignedProxyId).name, "spawn receives actual selected proxy name");
    if(j.planType==="free"){assert.equal(log.proxy,"");assert.equal(current.assignedProxyId,null);}
    if(j.planType==="pro"){assert.equal(new URL(log.proxy).hostname,"b.invalid");assert.equal(current.assignedProxyId,3);}
    if(j.planType==="plus")assert([1,2,3].includes(current.assignedProxyId));
    if(j.planType==="keep")assert.equal(current.assignedProxyId,1);
  }
  await Promise.all(selected.map(j=>post(`/api/jobs/${j.id}/input`,{action:"email_otp",value:"123456"})));
  await waitFor(async()=> (await jobs()).filter(j=>selected.some(x=>x.id===j.id)&&!j.webLoginPending).length===known.length);
  for(const [id,value]of originals)assert.equal(await fs.readFile(path.join(output,id,"sub2api-import-oauth.json"),"utf8"),value,"Web-only login leaves Codex export untouched");
  // Current profile changes are applied at the next Codex relogin, before its Web phase.
  profiles[1].proxyId="3";profiles[2].proxyId="direct";await settings();
  for(const j of selected){
    assert.equal((await post(`/api/jobs/${j.id}/relogin`,{})).status,200);
    await waitFor(async()=> (await job(j.id)).status==="email_otp");
    const current=await job(j.id),log=(await trace()).findLast(t=>t.email===j.email&&t.phase==="login");
    if(j.planType==="free"){assert.equal(current.assignedProxyId,3);assert.equal(new URL(log.proxy).hostname,"b.invalid");}
    if(j.planType==="pro"){assert.equal(current.assignedProxyId,null);assert.equal(log.proxy,"");}
    assert.equal(log.fixed,"1");
    await post(`/api/jobs/${j.id}/input`,{action:"email_otp",value:"123456"});
    await waitFor(async()=> (await job(j.id)).status==="completed"&&!(await job(j.id)).poolRefreshAction);
  }
  const free=selected.find(j=>j.planType==="free");const before=(await trace()).length;
  proxies.find(p=>p.id===3).status="expired";
  await post(`/api/jobs/${free.id}/web-login`,{});
  await waitFor(async()=> !(await job(free.id)).webLoginPending);
  assert.match((await job(free.id)).webLoginError,/代理已失效/);assert.equal((await trace()).length,before,"invalid configured fixed route stops before any login request");
  profiles[1].proxyId="direct";await settings();
  await post(`/api/jobs/${free.id}/web-login`,{});await waitFor(async()=> (await job(free.id)).status==="email_otp");
  assert.equal((await job(free.id)).assignedProxyId,null,"current direct plan clears an expired historical proxy");
  await post(`/api/jobs/${free.id}/input`,{action:"email_otp",value:"123456"});await waitFor(async()=> !(await job(free.id)).webLoginPending);
  // A Web-only login must rebind on a newly discovered plan, not the cached free plan.
  proxies.find(p=>p.id===3).status="active";profiles[2].proxyId="3";await settings();
  const exportBefore=await fs.readFile(path.join(output,free.id,"sub2api-import-oauth.json"),"utf8");
  await fs.writeFile(planOverrides,JSON.stringify({[free.email]:"pro"}));
  await post(`/api/jobs/${free.id}/web-login`,{});await waitFor(async()=> (await job(free.id)).status==="email_otp");
  assert.equal((await job(free.id)).assignedProxyId,null,"login begins on previous verified direct route");
  await post(`/api/jobs/${free.id}/input`,{action:"email_otp",value:"123456"});await waitFor(async()=> !(await job(free.id)).webLoginPending);
  assert.equal((await job(free.id)).assignedProxyId,3,"live pro plan immediately binds proxy B");
  assert.equal((await job(free.id)).planType,"pro");
  assert.equal(accounts.find(a=>a.credentials.email===free.email).proxy_id,3,"Web login updates pool binding without rewriting OAuth");
  assert.equal(await fs.readFile(path.join(output,free.id,"sub2api-import-oauth.json"),"utf8"),exportBefore);
  await stop();await start();assert.equal((await job(free.id)).assignedProxyId,3);

  console.log("KNOWN PLAN RELOGIN PASS: imported Web/Codex use current direct/fixed/balanced/keep route before login; no dynamic proxy required; Web preserves exports; invalid target stops; direct clears stale binding; restart persists");
} catch(error){error.message += `\n${logs}`;throw error;}
finally{await stop();remote.closeAllConnections();await new Promise(r=>remote.close(r));sessionUpstream.closeAllConnections();await new Promise(r=>sessionUpstream.close(r));await fs.rm(temp,{recursive:true,force:true});}
async function settings() { const response = await post("/api/sub2api/settings", { config: { baseUrl: poolBase, adminApiKey: "fixture-key", groupIds: [], proxyId: "balanced" }, profiles, activeProfileId: "default", planTypeBindings: { plus: "default", free: "free", pro: "pro", keep: "keep" } }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response; }
async function start() {
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: output, ONBOARDING_PROTOCOL_SCRIPT: wrapper, LOCALAPPDATA: path.join(temp, "local"), TOSUB2_TLS_PROFILE: "chrome142", NODE_ENV: "test", TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: sessionBase, AUTH_BASE: sessionBase }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-12000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-12000); });
  await waitFor(async () => { const response = await fetch(`${base}/api/bootstrap`).catch(() => null); if (!response?.ok) return false; headers = { "content-type": "application/json", "x-console-token": (await response.json()).token }; return true; });
}
async function stop() { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; }
async function post(route, body) { const response = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
async function jobs() { return (await (await fetch(`${base}/api/jobs`, { headers })).json()).jobs; }
async function job(id) { return (await jobs()).find((item) => item.id === id); }
async function trace() { return (await fs.readFile(tracePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
async function waitFor(predicate) { const deadline = Date.now() + 25000; while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 80)); } throw new Error("Timed out waiting for phased proxy behavior"); }
function send(res, body) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function freePort() { return new Promise((resolve) => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
