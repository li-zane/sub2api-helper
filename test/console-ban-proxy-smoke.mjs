import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createCredentialStore } from "../src/credential-store.mjs";
import { seedWebSession } from "./account-web-fixture.mjs";

const root=await fs.mkdtemp(path.join(os.tmpdir(),"ban-proxy-"));
const emails=["known-ban@example.test","pool-ban@example.test","revoked@example.test","workspace@example.test","pool-only-ban@example.test"];
const ids=emails.slice(0,4).map((_,i)=>`11111111-1111-4111-8111-${String(i+1).padStart(12,"0")}`);
const ban="Your account has been deactivated. account_deactivated";
const account=(id,email,error,proxy=8,type="oauth",platform="openai")=>({id,platform,type,status:"error",schedulable:false,proxy_id:proxy,error_message:error,credentials:{email,access_token:"fixture-token",refresh_token:"fixture-refresh",plan_type:"free"}});
const rows=[account(10,emails[0],"Token revoked (401)"),account(11,emails[1],ban),account(12,emails[0],"Token revoked (401)",9),account(13,emails[2],"Token revoked (401)",9),account(14,emails[3],"HTTP402 deactivated_workspace",9),account(15,emails[4],"account_suspended"),account(16,emails[0],ban,8,"apikey"),account(17,emails[0],ban,8,"oauth","anthropic")];
let rejectRelease=true,child,exited,base,headers,logs="",webReads=0;
const repairAt=new Date().toISOString(),retryAt=new Date(Date.parse(repairAt)+60*60_000).toISOString();
const writes=[];
const pool=http.createServer(async(req,res)=>{
 const chunks=[];for await(const b of req)chunks.push(b);
 const url=new URL(req.url,"http://fixture"),body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
 res.setHeader("content-type","application/json");
 const send=(status,data)=>{res.statusCode=status;res.end(JSON.stringify({data}));};
 if(url.pathname.startsWith("/api/auth/")||url.pathname.startsWith("/backend-api/")){webReads++;return send(200,{});}
 if(url.pathname==="/api/v1/admin/accounts")return send(200,{items:rows,total:rows.length,pages:1});
 if(url.pathname==="/api/v1/admin/proxies/all")return send(200,[8,9].map(id=>({id,name:`IP ${id}`,protocol:"http",host:`proxy-${id}.test`,port:8080,ip_address:`198.51.100.${id}`})));
 if(url.pathname==="/api/v1/admin/groups/all")return send(200,[]);
 const m=/^\/api\/v1\/admin\/accounts\/(\d+)(\/schedulable)?$/.exec(url.pathname);
 if(m){const row=rows.find(x=>x.id===Number(m[1]));if(!row)return send(404,{});
   if(req.method==="GET")return send(200,row);
   writes.push({id:row.id,method:req.method,body});
   if(row.id===10&&rejectRelease&&req.method==="PUT")return send(503,{message:"fixture proxy release unavailable"});
   Object.assign(row,body);return send(200,row);
 }
 return send(200,[]);
});
await new Promise(r=>pool.listen(0,"127.0.0.1",r));
const store=createCredentialStore({windowsRoot:path.join(root,"toSub2","credentials"),linuxRoot:path.join(root,"credentials"),macRoot:path.join(root,"credentials"),linuxKey:"ab".repeat(32)});
const wait=async fn=>{for(let n=0;n<200;n++){const value=await fn().catch(()=>null);if(value)return value;if(child?.exitCode!=null)throw Error(logs);await new Promise(r=>setTimeout(r,40));}throw Error("fixture timeout "+logs);};
async function api(route,body){const r=await fetch(base+route,{headers,...(body===undefined?{}:{method:"POST",body:JSON.stringify(body)})});return{status:r.status,data:await r.json()};}
async function start(){const socket=http.createServer();await new Promise(r=>socket.listen(0,"127.0.0.1",r));const port=socket.address().port;await new Promise(r=>socket.close(r));base=`http://127.0.0.1:${port}`;
 child=spawn(process.execPath,[process.env.BAN_PROXY_TEST_SERVER||"src/console-server.mjs","--host","127.0.0.1","--port",String(port)],{windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_ENV:"production",CHATGPT_BASE:`http://127.0.0.1:${pool.address().port}`,TOSUB2_SESSION_NATIVE_HTTP:"1",ONBOARDING_OUTPUT_ROOT:root,ONBOARDING_PROTOCOL_SCRIPT:path.join(root,"protocol.mjs"),LOCALAPPDATA:root,TOSUB2_LINUX_CREDENTIAL_ROOT:path.join(root,"credentials"),TOSUB2_MAC_CREDENTIAL_ROOT:path.join(root,"credentials"),TOSUB2_CREDENTIAL_KEY:"ab".repeat(32),SUB2API_MONITOR_ENABLED:"0"}});
 child.stdout.on("data",b=>logs+=b);child.stderr.on("data",b=>logs+=b);exited=new Promise(r=>child.once("exit",r));
 const boot=await wait(async()=>{const r=await fetch(base+"/api/bootstrap");return r.ok&&r.json();});headers={"x-console-token":boot.token,"content-type":"application/json"};
}
async function stop(){if(child?.exitCode===null){child.kill("SIGTERM");await exited;}}
async function jobs(){return(await api("/api/jobs")).data.jobs;}
try{
 for(let i=0;i<4;i++){const d=path.join(root,ids[i]);await fs.mkdir(d);await fs.writeFile(path.join(d,"job-meta.json"),JSON.stringify({version:1,email:emails[i],status:"completed",result_saved:true,auto_repair_blocked:i===0,auto_repair_blocked_reason:i===0?ban:null,plan_type:"free",assigned_proxy_id:i===0?8:9,authorization_proxy_selected:true,proxy_configured:i===0,has_password:i===0,has_totp_key:i===0}));await fs.writeFile(path.join(d,"sub2api-import-oauth.json"),JSON.stringify({type:"sub2api-data",accounts:[rows.find(r=>r.credentials.email===emails[i])]}));}
 await store.save(emails[0],{password:"saved-password",totpSecret:"JBSWY3DPEHPK3PXP",proxyUrl:"http://proxy-8.test:8080"});
 await seedWebSession(path.join(root,ids[0],"sub2api-import-oauth.json"));
 const beforeOAuth=await fs.readFile(path.join(root,ids[0],"sub2api-import-oauth.json"),"utf8");
 await fs.writeFile(path.join(root,"protocol.mjs"),`import fs from 'node:fs/promises';await fs.writeFile(${JSON.stringify(path.join(root,"unexpected-login"))},'ran');process.exitCode=1;`);
 const revokedMetaFile=path.join(root,ids[2],"job-meta.json"),revokedMeta=JSON.parse(await fs.readFile(revokedMetaFile,"utf8"));
 await fs.writeFile(revokedMetaFile,JSON.stringify({...revokedMeta,web_login_error:"fixture login failed"}));
 await fs.writeFile(path.join(root,"web-session-monitor.json"),JSON.stringify({version:1,accounts:{[emails[2]]:{status:"retry_wait",repairReason:"expired",lastRepairAt:repairAt,nextCheckAt:retryAt}}}));
 await fs.writeFile(path.join(root,"task-settings.json"),JSON.stringify({accountProxyMode:"plan",maxActiveJobs:1,webSessionMonitor:{enabled:true,autoRelogin:true,intervalMinutes:15,retryMinutes:60}}));
 await fs.writeFile(path.join(root,"sub2api-settings.json"),JSON.stringify({version:2,config:{baseUrl:`http://127.0.0.1:${pool.address().port}`,adminApiKey:"fixture"},profiles:[{id:"default",name:"Default",proxyId:"8"}],activeProfileId:"default"}));
 await start();
 let all=await jobs(),known=all.find(j=>j.email===emails[0]);
 assert.equal(known.webSessionStatus,"banned","confirmed ban must override Web expiry");
 assert.equal(known.status,"banned");assert.equal(known.canLoginWeb,false);assert.equal(known.assignedProxyId,null);
 assert.equal(known.banProxyReleasePending,true);assert.match(known.banProxyReleaseError,/503/);assert.equal(rows[0].proxy_id,8,"failed unbind retains real pool binding for retry");
 assert.equal((await api(`/api/jobs/${ids[0]}/web-login`,{})).status,409);
 for(const route of ["sessions","workspaces","sessions/logout","sessions/logout-all","workspaces/switch"]){
   const result=await api(`/api/jobs/${ids[0]}/${route}`,route.includes("/")?{}:undefined);
   assert.equal(result.status,409);assert.match(result.data.error,/账号已封禁/);assert.match(result.data.error,/account_deactivated/);
 }
 assert.equal(webReads,0,"blocked device/workspace actions never contact upstream");
 assert.equal(all.find(j=>j.email===emails[2]).webSessionRepairRetryAt,retryAt,"show the persisted automatic login cooldown");
 assert.equal(known.webSessionRepairRetryAt,null,"banned accounts have no retry schedule");
 assert.equal((await api(`/api/sub2api/accounts/${ids[0]}/schedulable`,{enabled:true})).status,409);
 await stop();rejectRelease=false;await start();
 await api("/api/sub2api/account-status?refresh=1");all=await jobs();known=all.find(j=>j.email===emails[0]);
 assert.equal(known.banProxyReleasePending,false);assert.equal(known.boundProxyStatus,"unbound");assert.equal(known.proxyConfigured,false);
 for(const id of [10,11,12,15]){assert.equal(rows.find(r=>r.id===id).proxy_id,0);assert.equal(rows.find(r=>r.id===id).schedulable,false);}
 for(const id of [13,14,16,17])assert.equal(rows.find(r=>r.id===id).proxy_id,id<15?9:8,"transient/workspace/other-platform/API-key records keep their bindings");
 for(const email of [emails[1],emails[4]]){const j=all.find(j=>j.email===email);assert.equal(j.status,"banned");assert.equal(j.webSessionStatus,"banned");assert.equal(j.canLoginWeb,false);}
 for(const email of [emails[2],emails[3]])assert.equal(all.find(j=>j.email===email).autoRepairBlocked,false);
 const credentials=await store.load(emails[0]);assert.equal(credentials.password,"saved-password");assert.equal(credentials.totpSecret,"JBSWY3DPEHPK3PXP");assert.equal(credentials.proxyUrl,"");
 assert.equal(await fs.readFile(path.join(root,ids[0],"sub2api-import-oauth.json"),"utf8"),beforeOAuth);
 assert.equal(await fs.stat(path.join(root,"unexpected-login")).then(()=>true,()=>false),false);
 const count=writes.length;await api("/api/sub2api/account-status?refresh=1");assert.equal(writes.length,count,"successful unbind is idempotent");
 await stop();await start();known=(await jobs()).find(j=>j.email===emails[0]);assert.equal(known.webSessionStatus,"banned");assert.equal(known.boundProxyStatus,"unbound");
 console.log("BAN_PROXY_PASS ban display; Web/device/workspace actions blocked before upstream; automatic retry time; local/pool unbind; durable retry/restart; duplicate OAuth rows; credentials preserved; transient/workspace/API-key isolation; no login or rebind");
}catch(error){console.error("BAN_PROXY_FAIL "+error.message);process.exitCode=1;}
finally{await stop();await new Promise(r=>pool.close(r));await fs.rm(root,{recursive:true,force:true});}
