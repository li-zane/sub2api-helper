import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const source=path.resolve(process.env.MISSING_WEB_ROOT||'.');
const {WebSessionMonitor}=await import(pathToFileURL(path.join(source,'src/web-session-monitor.mjs')));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'missing-web-'));
let unit;
try {
 let saved=false,paused=false,slots=true,repairs=0,probes=0,reason='plan_changed',now=Date.now();
 const j={email:'unit@example.test'},settings={enabled:true,autoRelogin:true,intervalMinutes:15,retryMinutes:60};
 const options={filePath:path.join(root,'unit.json'),getSettings:()=>settings,listJobs:()=>[j],isBusy:()=>paused,hasSession:()=>saved,restoreMissingSession:()=>true,withSlot:(_j,fn)=>slots?fn():undefined,probe:async()=>{probes++;return{repairReason:reason}},repair:async()=>{repairs++},retryDelayMs:0,now:()=>now};
 unit=new WebSessionMonitor(options);await unit.run();assert.equal(repairs,1,'missing Web credentials must enter automatic recovery');assert.equal(probes,0,'absence should not make upstream requests');
 await unit.repairFinished(j.email,{webOnly:true});saved=true;await unit.run({force:true});assert.equal(repairs,2,'Web restoration must continue into changed workspace/OAuth despite cooldown');
 saved=false;await unit.run({force:true});assert.equal(repairs,2,'missing-session repair must retain cooldown');
 await unit.stop();unit=new WebSessionMonitor(options);await unit.load();await unit.run({force:true});assert.equal(repairs,2,'cooldown survives restart');
 now+=61*60000;paused=true;await unit.run({force:true});assert.equal(repairs,2);paused=false;slots=false;await unit.run({force:true});assert.equal(repairs,2);slots=true;
 await unit.stop();
 unit=new WebSessionMonitor({...options,filePath:path.join(root,'permissions.json'),hasSession:()=>true,probe:async()=>{throw Object.assign(new Error('permission'),{code:'EACCES'})}});await unit.run({force:true});assert.equal(repairs,2,'permissions are not absence');assert.equal(unit.snapshot().accounts[j.email].status,'check_failed');await unit.stop();
 console.log('MISSING_WEB_UNIT_PASS missing recovery; Web-first continuation; cooldown/restart; pause/shared-slot admission; EACCES isolation');
} catch(error){await fs.rm(root,{recursive:true,force:true});throw error;} finally {await unit?.stop();}

const output=path.join(root,'output'),names=['legacy','paused','canceled','pool','webonly','new'];
const ids=names.map((_,i)=>`11111111-1111-4111-8111-${String(i+1).padStart(12,'0')}`),email=n=>`${n}@example.test`;
const token=`web.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:'personal',chatgpt_plan_type:'free'}})).toString('base64url')}.signature`;
const trace=path.join(root,'trace.jsonl'),wrapper=path.join(root,'protocol.mjs');
let logoutStatus=200,upstreamCalls=0,child,exited,base,headers,logs='';
const upstream=http.createServer(async(req,res)=>{for await(const _ of req){};upstreamCalls++;res.setHeader('content-type','application/json');
 if(req.url==='/api/auth/session'){const name=/identity=([^;]+)/.exec(req.headers.cookie||'')?.[1];return res.end(JSON.stringify({user:{email:decodeURIComponent(name||'')} ,accessToken:token}));}
 if(req.url.includes('/accounts/check/'))return res.end(JSON.stringify({current_account_id:'personal',accounts:{personal:{account:{account_id:'personal',structure:'personal',plan_type:'free',can_access_with_session:true}}}}));
 if(req.url.includes('/accounts/sessions'))return res.end(JSON.stringify({devices:[{session_id:'browser',display_name:'Helper browser',is_current_device:true}]}));
 if(req.url.endsWith('/accounts/logout_all')){res.statusCode=logoutStatus;return res.end(JSON.stringify(logoutStatus===200?{}:{error:{message:'temporary logout failure'}}));}
 res.statusCode=404;res.end('{}');});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const webUrl=`http://127.0.0.1:${upstream.address().port}`;
const originals=new Map(),metaPath=id=>path.join(output,id,'job-meta.json'),webPath=id=>path.join(output,id,'web-session.json');
const wait=async fn=>{for(let n=0;n<400;n++){const value=await fn().catch(()=>null);if(value)return value;if(child?.exitCode!=null)throw Error(logs);await new Promise(r=>setTimeout(r,50));}throw Error('fixture timed out\n'+logs)};
async function api(route,body){const res=await fetch(base+route,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});return{status:res.status,data:await res.json()};}
const job=async id=>(await api('/api/jobs')).data.jobs.find(j=>j.id===id);
const traces=async()=>{try{return(await fs.readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch(e){if(e.code==='ENOENT')return[];throw e}};
async function start(){const l=http.createServer();await new Promise(r=>l.listen(0,'127.0.0.1',r));const port=l.address().port;await new Promise(r=>l.close(r));base=`http://127.0.0.1:${port}`;
 child=spawn(process.execPath,[path.join(source,'src/console-server.mjs'),'--host','127.0.0.1','--port',String(port)],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',ONBOARDING_OUTPUT_ROOT:output,LOCALAPPDATA:root,TOSUB2_LINUX_CREDENTIAL_ROOT:path.join(root,'creds'),TOSUB2_MAC_CREDENTIAL_ROOT:path.join(root,'creds'),TOSUB2_CREDENTIAL_KEY:'ab'.repeat(32),TOSUB2_SESSION_NATIVE_HTTP:'1',CHATGPT_BASE:webUrl,SUB2API_MONITOR_ENABLED:'0',ONBOARDING_PROTOCOL_SCRIPT:wrapper}});
 child.stdout.on('data',b=>{logs+=b});child.stderr.on('data',b=>{logs+=b});exited=new Promise(r=>child.once('exit',r));const boot=await wait(async()=>(await fetch(base+'/api/bootstrap')).json());headers={'x-console-token':boot.token,'content-type':'application/json'};}
async function stop(){if(child?.exitCode===null){child.kill('SIGTERM');await exited;}}
async function check(){await wait(async()=>!(await api('/api/web-session-monitor')).data.running);assert.equal((await api('/api/web-session-monitor/check',{})).status,200);}
const legacy=ids[0],pausedId=ids[1];
try {
 for(const [i,name]of names.entries()){const id=ids[i],dir=path.join(output,id);await fs.mkdir(dir,{recursive:true});const hasOAuth=i<4;
  if(hasOAuth){const value=JSON.stringify({type:'sub2api-data',accounts:[{platform:'openai',type:'oauth',credentials:{email:email(name),plan_type:'free',chatgpt_account_id:'personal',access_token:'original-Codex',refresh_token:'original-refresh'}}]});await fs.writeFile(path.join(dir,'sub2api-import-oauth.json'),value);originals.set(id,value);}
  await fs.writeFile(metaPath(id),JSON.stringify({version:1,email:email(name),status:name==='canceled'?'canceled':hasOAuth?'completed':'failed',result_saved:hasOAuth,pool_only:name==='pool',plan_type:'free',last_operation_type:'relogin',created_at:'2026-11-01T00:00:00Z',web_login_error:name==='legacy'?'Web 登录已取消':null,web_login_completed_at:name==='webonly'?'2026-11-01T01:00:00Z':null,web_session_maintenance_pause:name==='paused'?{reason:'logout',at:'2026-11-01T01:00:00Z'}:null}));}
 await fs.writeFile(path.join(output,'task-settings.json'),JSON.stringify({maxActiveJobs:1,accountProxyMode:'global'}));
 await fs.writeFile(path.join(output,'web-session-monitor.json'),JSON.stringify({version:1,accounts:{[email('legacy')]:{devices:[{displayName:'stale browser'}],workspaces:[{id:'stale'}],nextCheckAt:new Date(0).toISOString()}}}));
 await fs.writeFile(wrapper,`import fs from 'node:fs/promises';
import path from 'node:path';
import {getAccountBrowserIdentity} from ${JSON.stringify(pathToFileURL(path.resolve('src/account-browser-identity.mjs')).href)};
import {writeAccountWebSession} from ${JSON.stringify(pathToFileURL(path.resolve('src/account-web-session.mjs')).href)};
const email=process.argv[process.argv.indexOf('--email')+1];
if(!process.argv.includes('--web-only'))throw Error('missing recovery must not replace Codex authorization');
if(await fs.stat(path.join(${JSON.stringify(root)},email+'.hold')).then(()=>true,()=>false)){console.log('Email OTP (r=resend, q=quit):');process.stdin.resume();await new Promise(r=>process.stdin.once('data',r));}
await fs.appendFile(${JSON.stringify(trace)},JSON.stringify({email,monitor:process.env.TOSUB2_WEB_MONITOR_REPAIR==='1'})+String.fromCharCode(10));
if(await fs.stat(path.join(${JSON.stringify(root)},email+'.fail')).then(()=>true,()=>false)){console.error('[error] fixture Web login failure');process.exit(1);}
const identity=await getAccountBrowserIdentity(email,{root:process.env.TOSUB2_BROWSER_IDENTITY_ROOT});
await writeAccountWebSession(process.env.TOSUB2_WEB_SESSION_PATH,{email,identity,cookies:[{name:'identity',value:encodeURIComponent(email),domain:'127.0.0.1',path:'/',hostOnly:true}],web:{workspaceId:'personal'},accessToken:${JSON.stringify(token)},validation:{status:'valid',verifiedAt:new Date().toISOString()}});
console.log('[ok] Saved web session: '+process.env.TOSUB2_WEB_SESSION_PATH);process.disconnect();
`);
 await fs.writeFile(path.join(root,email('legacy')+'.fail'),'1');await start();
 await api('/api/task-settings',{webSessionMonitor:{enabled:true,autoRelogin:false,intervalMinutes:15,retryMinutes:60}});await check();
 let state=(await api('/api/web-session-monitor')).data;
 assert.equal(state.accounts[email('legacy')].status,'missing','legacy completed account without Web file must be detected');assert.deepEqual(state.accounts[email('legacy')].devices,[]);assert.equal((await traces()).length,0);assert.equal(upstreamCalls,0,'check-only absence must not contact upstream');
 for(const n of ['paused','canceled','pool','new'])assert.equal(state.accounts[email(n)],undefined,`${n} must not auto-create Web login`);
 await api('/api/task-settings',{webSessionMonitor:{enabled:true,autoRelogin:true,intervalMinutes:15,retryMinutes:60}});await check();
 await wait(async()=>{await check();const value=await job(legacy);return !value.webLoginPending&&value.webLoginError?.includes('fixture Web login failure')});
 await wait(async()=>!(await job(ids[4])).webLoginPending&&(await job(ids[4])).webLoginCompletedAt!=='2026-11-01T01:00:00Z');
 await check();assert.equal((await api('/api/web-session-monitor')).data.accounts[email('legacy')].status,'retry_wait');assert((await job(legacy)).webSessionRepairRetryAt);
 assert.equal((await traces()).filter(t=>t.email===email('legacy')).length,1);await stop();await start();await check();assert.equal((await traces()).filter(t=>t.email===email('legacy')).length,1,'failed missing recovery cooldown survives restart');
 assert.equal((await job(pausedId)).webSessionMaintenancePause.reason,'logout');
 await stop();await fs.rm(path.join(root,email('legacy')+'.fail'));let monitor=JSON.parse(await fs.readFile(path.join(output,'web-session-monitor.json'),'utf8'));monitor.accounts[email('legacy')].lastRepairAt=new Date(Date.now()-61*60000).toISOString();monitor.accounts[email('legacy')].nextCheckAt=new Date(0).toISOString();await fs.writeFile(path.join(output,'web-session-monitor.json'),JSON.stringify(monitor));
 await start();await wait(async()=>!(await job(legacy)).webLoginPending&&(await job(legacy)).webLoginCompletedAt);await check();assert.equal((await job(legacy)).webSessionStatus,'valid');assert.equal((await traces()).filter(t=>t.email===email('legacy')).length,2);
 assert.equal((await api(`/api/jobs/${pausedId}/web-session-check`,{})).status,200);await wait(async()=>!(await job(pausedId)).webSessionCheckPending&&(await job(pausedId)).webSessionStatus==='valid');assert.equal((await job(pausedId)).webSessionMaintenancePause,null,'manual check resumes maintenance');
 logoutStatus=503;assert.equal((await api(`/api/jobs/${pausedId}/sessions/logout-all`,{})).status,502);assert.equal((await job(pausedId)).webSessionMaintenancePause,null,'failed logout restores previous intent');await fs.access(webPath(pausedId));
 logoutStatus=200;assert.equal((await api(`/api/jobs/${pausedId}/sessions/logout-all`,{})).status,200);assert.equal((await job(pausedId)).webSessionMaintenancePause.reason,'logout');await assert.rejects(fs.access(webPath(pausedId)),{code:'ENOENT'});const count=(await traces()).length;await check();assert.equal((await traces()).length,count,'explicit logout must not be undone');
 await stop();await start();await check();assert.equal((await job(pausedId)).webSessionMaintenancePause.reason,'logout');assert.equal((await traces()).length,count);
 await fs.writeFile(path.join(root,email('paused')+'.hold'),'1');assert.equal((await api(`/api/jobs/${pausedId}/web-login`,{})).status,200);await wait(async()=>(await job(pausedId)).status==='email_otp');assert.equal((await job(pausedId)).webSessionMaintenancePause,null);
 await api(`/api/jobs/${pausedId}/cancel`,{});await wait(async()=>!(await job(pausedId)).webLoginPending);assert.equal((await job(pausedId)).webSessionMaintenancePause.reason,'canceled');await check();assert.equal((await traces()).length,count);
 await stop();await start();await check();assert.equal((await job(pausedId)).webSessionMaintenancePause.reason,'canceled','manual cancellation pause survives restart');await fs.rm(path.join(root,email('paused')+'.hold'));
 await api(`/api/jobs/${pausedId}/web-session-check`,{});await wait(async()=>!(await job(pausedId)).webSessionCheckPending&&(await job(pausedId)).webSessionStatus==='valid');assert.equal((await job(pausedId)).webSessionMaintenancePause,null);
 for(const [id,value]of originals)assert.equal(await fs.readFile(path.join(output,id,'sub2api-import-oauth.json'),'utf8'),value,'missing Web recovery must preserve Codex export');await assert.rejects(fs.access(path.join(output,ids[4],'sub2api-import-oauth.json')),{code:'ENOENT'});
 console.log('MISSING_WEB_HTTP_PASS legacy-canceled/absent and prior-Web-only recovery; check-only; stale-summary clear; persisted cooldown; explicit logout/cancel pause; failed logout atomicity; manual resume; canceled/pool/new isolation; OAuth unchanged');
} catch(error){console.error('FIXTURE_DEBUG',JSON.stringify({traces:await traces(),monitor:await api('/api/web-session-monitor').catch(()=>null),jobLogs:await api(`/api/jobs/${legacy}/logs`).catch(()=>null)}));error.message+='\n'+logs;throw error;} finally {await stop();await new Promise(r=>upstream.close(r));await fs.rm(root,{recursive:true,force:true});}
