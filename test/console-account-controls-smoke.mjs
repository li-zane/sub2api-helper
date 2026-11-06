import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

const project = path.resolve(import.meta.dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-account-controls-"));
const baseline = process.argv.includes("--baseline"), trace = path.join(root, "trace.jsonl"), calls = [], securityCalls = [];
const records = [
  { id: 101, email: "healthy-controls@example.test" },
  { id: 102, email: "limited-controls@example.test", rate_limited_at: new Date().toISOString(), rate_limit_reset_at: new Date(Date.now()+86400000).toISOString() },
  { id: 103, email: "banned-controls@example.test", status: "error", schedulable: false, error_message: "account_deactivated" },
  { id: 104, email: "banned-no-export@example.test", status: "error", schedulable: false, error_message: "account_deactivated", noToken: true },
].map(a => ({ status: "active", schedulable: true, platform: "openai", type: "oauth", proxy_id: 0, group_ids: [], extra: { codex_5h_used_percent: 10 }, ...a,
  name: a.email, credentials: { email: a.email, plan_type: "free", ...(!a.noToken ? { access_token: "fixture", refresh_token: "fixture-refresh" } : {}) } }));
const pool = http.createServer(async (req,res) => {
  let raw=""; for await (const c of req) raw+=c;
  const u=new URL(req.url,"http://fixture"); calls.push({ path:u.pathname, query:u.searchParams.toString(), method:req.method, body:JSON.parse(raw||"{}") });
  res.setHeader("content-type","application/json"); const send=data=>res.end(JSON.stringify({code:0,data}));
  if(u.pathname==="/api/v1/admin/accounts")return send({items:records,total:records.length,pages:1});
  if(u.pathname.endsWith("/groups/all")||u.pathname.endsWith("/proxies/all"))return send([]);
  if(u.pathname==="/api/v1/admin/usage/stats")return send({total_account_cost:12,total_actual_cost:3,total_tokens:2048});
  if(u.pathname.endsWith("/usage"))return send({five_hour:{utilization:37}});
  if(u.pathname.endsWith("/quota/refresh"))return send({rate_limit_reset_credits:{available_count:2}});
  if(u.pathname.includes("/ops/"))return send({items:[],total:0});
  const toggle=/^\/api\/v1\/admin\/accounts\/(\d+)\/schedulable$/.exec(u.pathname);
  if(toggle){records.find(a=>a.id===Number(toggle[1])).schedulable=JSON.parse(raw).schedulable;return send({});}
  const record=records.find(a=>u.pathname===`/api/v1/admin/accounts/${a.id}`);
  if(record){if(req.method==="PUT")Object.assign(record,JSON.parse(raw));return send(record)}
  res.statusCode=404;send({});
});
let slowSecurity = false, releaseSecurity;
const upstream = http.createServer(async(req,res)=>{
  securityCalls.push(req.url);res.setHeader("content-type","application/json");
  if(slowSecurity&&req.url.endsWith("/mfa_info"))await new Promise(r=>{releaseSecurity=r});
  if(req.url.endsWith("/mfa_info"))return res.end('{"mfa_enabled_v2":false}');
  if(req.url.endsWith("/change_password/eligibility"))return res.end('{"eligible":true}');
  res.statusCode=404;res.end('{}');
});
const listen=async s=>{for(;;){await new Promise(r=>s.listen(0,"127.0.0.1",r));if(s.address().port>10080)return s.address().port;await new Promise(r=>s.close(r))}};
await Promise.all([listen(pool),listen(upstream)]);const socket=http.createServer(),port=await listen(socket);await new Promise(r=>socket.close(r));
const base=`http://127.0.0.1:${port}`;let child,headers,logs="";
const wait=async fn=>{for(const end=Date.now()+20000;Date.now()<end;){const value=await fn().catch(()=>null);if(value)return value;if(child?.exitCode!=null)throw Error(logs);await new Promise(r=>setTimeout(r,30))}throw Error("account controls fixture timed out\n"+logs)};
const api=async(route,body)=>{const r=await fetch(base+route,{headers,...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)})});return{status:r.status,data:await r.json()}};
const all=async()=>(await api("/api/jobs")).data.jobs;
const find=async email=>(await all()).find(j=>j.email===email);
const waitJob=(email,p)=>wait(async()=>{const j=await find(email);return j&&p(j)&&j});
async function start(){
  child=spawn(process.execPath,[process.env.ACCOUNT_CONTROLS_TEST_SERVER||"src/console-server.mjs","--host","127.0.0.1","--port",String(port)],{cwd:project,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"test",ONBOARDING_OUTPUT_ROOT:root,LOCALAPPDATA:root,TOSUB2_LINUX_CREDENTIAL_ROOT:path.join(root,"credentials"),TOSUB2_MAC_CREDENTIAL_ROOT:path.join(root,"credentials"),TOSUB2_CREDENTIAL_KEY:"ab".repeat(32),SUB2API_MONITOR_ENABLED:"0",TOSUB2_SESSION_NATIVE_HTTP:"1",CHATGPT_BASE:`http://127.0.0.1:${upstream.address().port}`,ONBOARDING_PROTOCOL_SCRIPT:path.join(project,"test/mock-account-controls-protocol.mjs"),ACCOUNT_CONTROLS_TRACE:trace}});
  child.stdout.on("data",v=>logs+=v);child.stderr.on("data",v=>logs+=v);
  const boot=await wait(async()=>{const r=await fetch(base+"/api/bootstrap");return r.ok&&r.json()});headers={"x-console-token":boot.token,"content-type":"application/json"};return boot;
}
async function stop(){if(child?.exitCode===null){const done=new Promise(r=>child.once("exit",r));child.kill("SIGTERM");await done}}
try{
  await fs.writeFile(path.join(root,"sub2api-settings.json"),JSON.stringify({version:2,config:{baseUrl:`http://127.0.0.1:${pool.address().port}`,adminApiKey:"fixture-key"},profiles:[{id:"default",name:"Default"}],activeProfileId:"default"}));
  await fs.writeFile(path.join(root,"overload-monitor.json"),JSON.stringify({version:1,accounts:{"limited-controls@example.test":{enabled:true}}}));
  await fs.writeFile(path.join(root,"model-fingerprint.json"),JSON.stringify({version:1,settings:{planDefaults:{free:true}},accounts:{}}));
  const boot=await start();assert.equal(boot.taskSettings.webSessionMonitor.enabled,false);
  await api("/api/sub2api/account-status?refresh=1");
  const limited=await find(records[1].email),banned=await find(records[2].email),noExport=await find(records[3].email);
  if(baseline){
    assert.equal(limited.overloadDetection.enabled,true);
    assert.equal(banned.canForceRelogin,true);assert.equal(banned.canLoginWeb,false);
    const count=calls.length;assert.equal((await api(`/api/jobs/${banned.id}/usage?refresh=1`)).status,200);
    assert.equal(calls.slice(count).filter(c=>c.path.includes('/usage')||c.path.endsWith('/quota/refresh')).length,0);
    console.log('BASELINE_ACCOUNT_CONTROLS_REPRODUCED active429_monitor_on=true banned_oauth_enabled=true banned_web_disabled=true manual_banned_usage_skipped=true');process.exitCode=1;
  }else{
    assert.equal(limited.sub2apiRateLimited,true);assert.equal(limited.codexStatusEligible,false);assert.equal(limited.overloadDetection.enabled,false);assert.equal(limited.modelFingerprint.override.enabled,false);
    for(const route of ["overload-detection","overload-auto-cooldown","model-fingerprint","model-fingerprint/check"])assert.equal((await api(`/api/jobs/${limited.id}/${route}`,{enabled:true})).status,409);
    assert(!calls.some(c=>c.path.includes('/ops/')&&new URLSearchParams(c.query).get('account_id')==='102'),'429 account was probed for overload');
    assert.equal(records[1].schedulable,true,'429 must not disable pool or remove IP');
    assert.equal(banned.canLoginWeb,true);assert.equal(banned.canForceRelogin,false);assert.equal(banned.canRegenerate,false);assert.equal(banned.canRetry,false);
    for(const route of ["relogin","retry","regenerate"])assert.equal((await api(`/api/jobs/${banned.id}/${route}`,{})).status,409);
    assert.equal((await api('/api/jobs/relogin-batch',{ids:[banned.id]})).status,409);
    const count=calls.length;
    for(const j of [banned,noExport]){
      const r=await api(`/api/jobs/${j.id}/usage?refresh=1`);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.usage.totals.tokens,2048);assert.equal(r.data.usage.primary.usedPercent,37);assert.equal(r.data.usage.resetCredits.availableCount,2);
    }
    assert(calls.slice(count).some(c=>c.path.endsWith('/quota/refresh')));assert(!calls.slice(count).some(c=>c.method==='PUT'||c.path.endsWith('/schedulable')),'manual usage changed account configuration');
    assert.equal((await find(banned.email)).autoRepairBlocked,true);
    const created=await api('/api/jobs/batch',{text:'first-import-controls@example.test'});assert.equal(created.status,201,JSON.stringify(created));
    const first=await waitJob('first-import-controls@example.test',j=>j.status==='phone'&&j.securityState.passwordEnabled===true&&j.securityState.totpEnabled===false);
    assert.equal(first.canDownload,false,'password inspection incorrectly waited for completed OAuth');
    assert.equal(securityCalls.filter(p=>p.endsWith('/change_password/eligibility')).length,1,'split stdout/polls repeated first check');
    await api(`/api/jobs/${first.id}/cancel`,{});
    const originalOAuth=await fs.readFile(path.join(root,banned.id,'sub2api-import-oauth.json'),'utf8');
    slowSecurity=true;
    const web=await api('/api/jobs/web-session-check-batch',{ids:[banned.id]});assert.equal(web.status,200);assert.equal(web.data.started,1);assert(web.data.jobs[0].webSessionCheckAttemptId,'banned batch lost progress tracking');
    await wait(async()=>typeof releaseSecurity==='function');
    assert.equal((await find(banned.email)).webLoginPending,true);
    records[2].schedulable=true;records[2].proxy_id=99;await api('/api/sub2api/account-status?refresh=1');
    assert.equal((await find(banned.email)).webLoginPending,true,'ban reconciliation canceled explicit Web attempt');
    slowSecurity=false;releaseSecurity();
    await waitJob(banned.email,j=>!j.webLoginPending&&j.webLoginCompletedAt&&j.status==='banned');
    const progress=await api('/api/jobs/web-session-check-progress',{attempts:[{id:banned.id,attemptId:web.data.jobs[0].webSessionCheckAttemptId}]});assert.equal(progress.data.progress[0].phase,'success');
    assert.equal((await find(banned.email)).autoRepairBlocked,true,'Web-only success silently unbanned or enabled the pool');
    assert.equal(records[2].schedulable,false);assert.equal(records[2].proxy_id,0);assert.equal(await fs.readFile(path.join(root,banned.id,'sub2api-import-oauth.json'),'utf8'),originalOAuth);
    const traces=(await fs.readFile(trace,'utf8')).trim().split('\n').map(JSON.parse),recovery=traces.find(t=>t.email===banned.email);assert(recovery.web);assert.equal(recovery.phased,'0');assert.equal(recovery.hasPoolKey,false);
    records[1].rate_limit_reset_at='2020-01-01T00:00:00Z';await api('/api/sub2api/account-status?refresh=1');const expired=await find(limited.email);assert.equal(expired.sub2apiRateLimited,false);assert.equal(expired.overloadDetection.enabled,false,'rate limit expiry silently re-enabled saved switch');
    await stop();await start();const restored=await find(limited.email);assert.equal(restored.overloadDetection.enabled,false);assert.equal(restored.modelFingerprint.override.enabled,false);
    console.log('ACCOUNT_CONTROLS_HTTP_PASS first-import password+2FA before OAuth with monitor off; active429 raw switches stopped/persisted and API gated; banned OAuth blocked but manual Web-only/batch progress survives ban reconciliation; no OAuth/IP/pool-enable side effects; manual banned quota+reset/totals refresh including no-export account; old credentials preserved');
  }
}finally{releaseSecurity?.();await stop();for(const s of[pool,upstream])s.closeAllConnections();await Promise.all([new Promise(r=>pool.close(r)),new Promise(r=>upstream.close(r))]);await fs.rm(root,{recursive:true,force:true})}
