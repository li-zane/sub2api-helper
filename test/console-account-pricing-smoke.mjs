import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, ".."), temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-account-pricing-"));
const ids = [1,2].map(n => `11111111-1111-4111-8111-${String(n).padStart(12,"0")}`), email = "pricing@example.test";
let child, headers, base, output="";
const delay = ms => new Promise(r => setTimeout(r,ms));
async function wait(fn) { for(const end=Date.now()+15000;Date.now()<end;) { const x=await fn().catch(()=>null);if(x)return x;await delay(30); }throw Error(output||"pricing fixture timeout"); }
async function api(route,body,authenticated=true) { const r=await fetch(base+route,{headers:authenticated?headers:{"content-type":"application/json"},...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)})});return{status:r.status,data:await r.json()}; }
async function start() {
  const s=http.createServer();await new Promise(r=>s.listen(0,"127.0.0.1",r));const p=s.address().port;await new Promise(r=>s.close(r));base=`http://127.0.0.1:${p}`;
  child=spawn(process.execPath,[process.env.ACCOUNT_PRICING_TEST_SERVER||"src/console-server.mjs","--host","127.0.0.1","--port",String(p)],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"test",ONBOARDING_OUTPUT_ROOT:temp,LOCALAPPDATA:temp,TOSUB2_LINUX_CREDENTIAL_ROOT:path.join(temp,"creds"),TOSUB2_MAC_CREDENTIAL_ROOT:path.join(temp,"creds"),TOSUB2_CREDENTIAL_KEY:"ab".repeat(32),SUB2API_MONITOR_ENABLED:"0"}});
  child.stdout.on("data",d=>output+=d);child.stderr.on("data",d=>output+=d);
  const b=await wait(async()=>{try{return(await fetch(base+"/api/bootstrap")).json()}catch{}});headers={"content-type":"application/json","x-console-token":b.token};return b;
}
async function stop(){if(child?.exitCode===null){const done=new Promise(r=>child.once("exit",r));child.kill("SIGTERM");await done;}}
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
try {
  await fs.writeFile(path.join(temp,"task-settings.json"),JSON.stringify({version:2,maxActiveJobs:4,displayTimeZone:"UTC"}));
  for(const id of ids){const dir=path.join(temp,id);await fs.mkdir(dir);await fs.writeFile(path.join(dir,"job-meta.json"),JSON.stringify({version:1,email,status:"completed",result_saved:true,remark:"original remark",plan_type:"free"}));await fs.writeFile(path.join(dir,"sub2api-import-oauth.json"),JSON.stringify({type:"sub2api-data",accounts:[{credentials:{email,access_token:"fixture-access",refresh_token:"fixture-refresh"}}]}));}
  const original=await Promise.all(ids.map(id=>fs.readFile(path.join(temp,id,"sub2api-import-oauth.json")).then(hash)));
  const boot=await start();
  assert.equal(boot.taskSettings.poolPriceMultiplier,1,"legacy task settings must default pool price multiplier to 1");
  let jobs=(await api("/api/jobs")).data.jobs;
  assert(jobs.every(j=>j.accountCostCny===0),"legacy accounts must default account cost to zero");
  assert.equal((await api(`/api/jobs/${ids[0]}/cost`,{accountCostCny:12.34},false)).status,403);
  for(const value of [null,true,[],{},"",-1,1.001,1000000001])assert.equal((await api(`/api/jobs/${ids[0]}/cost`,{accountCostCny:value})).status,400);
  assert.equal((await api(`/api/jobs/${ids[0]}/cost`,{accountCostCny:12.34})).status,200);
  jobs=(await api("/api/jobs")).data.jobs;assert(jobs.every(j=>j.accountCostCny===12.34),"same-email rows must share one acquisition cost");
  assert(jobs.every(j=>j.remark==="original remark"));
  for(const value of [null,false,[],{},"",0,-1,0.0000001,1000001])assert.equal((await api("/api/task-settings",{poolPriceMultiplier:value,maxActiveJobs:7})).status,400);
  assert.equal((await api("/api/task-settings")).data.settings.maxActiveJobs,4,"invalid pricing patch must not partially change other settings");
  await Promise.all([api("/api/task-settings",{poolPriceMultiplier:7}),api("/api/task-settings",{displayTimeZone:"Asia/Shanghai"})]);
  assert.equal((await api("/api/task-settings")).data.settings.poolPriceMultiplier,7);
  await stop();await start();
  assert((await api("/api/jobs")).data.jobs.every(j=>j.accountCostCny===12.34));
  const settings=(await api("/api/task-settings")).data.settings;assert.equal(settings.poolPriceMultiplier,7);assert.equal(settings.displayTimeZone,"Asia/Shanghai");
  assert.equal((await api(`/api/jobs/${ids[0]}/cost`,{accountCostCny:0})).status,200);
  assert((await api("/api/jobs")).data.jobs.every(j=>j.accountCostCny===0));
  assert.deepEqual(await Promise.all(ids.map(id=>fs.readFile(path.join(temp,id,"sub2api-import-oauth.json")).then(hash))),original,"cost edits must not modify credentials");
  console.log("ACCOUNT_PRICING_HTTP_PASS legacy defaults; authenticated strict cost/rate validation; same-email persistence/restart; serialized settings patches; real zero; no credential or remark changes");
} finally {await stop();await fs.rm(temp,{recursive:true,force:true});}
