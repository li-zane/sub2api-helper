import './legacy-import-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'helper-settings-patch-'));
const events=path.join(temp,'events.jsonl'),settingsFile=path.join(temp,'task-settings.json');
const listener=http.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
const port=listener.address().port;await new Promise(r=>listener.close(r));
const base='http://127.0.0.1:'+port,results=[];
let child,headers,logs='';
const probe=`import fs from 'node:fs';
import {WebSessionMonitor} from ${JSON.stringify(pathToFileURL(root+'/src/web-session-monitor.mjs').href)};
import {OverloadCooldown} from ${JSON.stringify(pathToFileURL(root+'/src/overload-cooldown.mjs').href)};
for(const [name,Type] of [['web',WebSessionMonitor],['cooldown',OverloadCooldown]]){
 const original=Type.prototype.trigger;
 Type.prototype.trigger=function(...args){fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({name,args})+'\\n');return original.apply(this,args);};
}`;
async function start(){
 child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(probe),'src/console-server.mjs','--host','127.0.0.1','--port',String(port)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'test',ONBOARDING_OUTPUT_ROOT:temp,LOCALAPPDATA:temp,SUB2API_MONITOR_ENABLED:'0'}});
 child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
 for(const end=Date.now()+20000;Date.now()<end;){try{const r=await fetch(base+'/api/bootstrap');if(r.ok){headers={'content-type':'application/json','x-console-token':(await r.json()).token};return;}}catch{}if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,50));}throw Error('startup timeout '+logs);
}
async function stop(){if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await ended;}}
const api=async body=>{const r=await fetch(base+'/api/task-settings',{headers,...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};
const settings=async()=>(await api()).data.settings;
const trace=async()=>{try{return(await fs.readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
const check=async(name,fn)=>{try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message});}};
try{
 await start();
 await check('authentication-and-object-validation',async()=>{
  assert.equal((await fetch(base+'/api/task-settings')).status,403);
  assert.equal((await fetch(base+'/api/task-settings',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  for(const value of [null,[],true,'settings'])assert.equal((await api(value)).status,400,JSON.stringify(value));
 });
 await check('nested-patches-preserve-existing-values',async()=>{
  assert.equal((await api({webSessionMonitor:{enabled:false,autoRelogin:false,intervalMinutes:37,retryMinutes:73},overloadAutoCooldown:{windowMinutes:21,threshold:17,cooldownMinutes:42}})).status,200);
  assert.equal((await api({webSessionMonitor:{enabled:true},overloadAutoCooldown:{threshold:5}})).status,200);
  const current=await settings();assert.deepEqual(current.webSessionMonitor,{enabled:true,autoRelogin:false,intervalMinutes:37,retryMinutes:73});assert.deepEqual(current.overloadAutoCooldown,{windowMinutes:21,threshold:5,cooldownMinutes:42});
 });
 await check('concurrent-nested-patches-merge-at-write-time',async()=>{
  const responses=await Promise.all([api({webSessionMonitor:{intervalMinutes:25},overloadAutoCooldown:{windowMinutes:33}}),api({webSessionMonitor:{retryMinutes:80},overloadAutoCooldown:{threshold:8}})]);assert(responses.every(r=>r.status===200));
  const current=await settings();assert.equal(current.webSessionMonitor.intervalMinutes,25);assert.equal(current.webSessionMonitor.retryMinutes,80);assert.equal(current.overloadAutoCooldown.windowMinutes,33);assert.equal(current.overloadAutoCooldown.threshold,8);
 });
 await check('invalid-nested-patches-are-atomic',async()=>{
  const before=await settings(),bytes=await fs.readFile(settingsFile,'utf8');
  for(const patch of [{webSessionMonitor:null},{webSessionMonitor:[]},{webSessionMonitor:{intervalMinutes:0}},{overloadAutoCooldown:null},{overloadAutoCooldown:[]},{overloadAutoCooldown:{threshold:0}},{monitoring:{overloadConcurrency:0}}])assert.equal((await api({...patch,maxActiveJobs:7})).status,400);
  assert.deepEqual(await settings(),before);assert.equal(await fs.readFile(settingsFile,'utf8'),bytes);
 });
 await check('ordinary-and-unchanged-saves-do-not-trigger-maintenance',async()=>{
  const before=(await trace()).length,current=await settings();
  assert.equal((await api({poolPriceMultiplier:7,displayTimeZone:'UTC'})).status,200);
  assert.equal((await api({webSessionMonitor:current.webSessionMonitor,overloadAutoCooldown:current.overloadAutoCooldown,monitoring:current.monitoring})).status,200);
  assert.deepEqual((await trace()).slice(before),[]);
 });
 await check('actual-rule-changes-wake-only-corresponding-monitor',async()=>{
  let before=(await trace()).length;assert.equal((await api({webSessionMonitor:{intervalMinutes:26}})).status,200);
  assert.deepEqual((await trace()).slice(before),[{name:'web',args:[true]}]);
  before=(await trace()).length;assert.equal((await api({overloadAutoCooldown:{threshold:9}})).status,200);
  assert.deepEqual((await trace()).slice(before),[{name:'cooldown',args:[]}]);
  before=(await trace()).length;assert.equal((await api({monitoring:{overloadIntervalSeconds:90}})).status,200);
  assert.deepEqual((await trace()).slice(before),[{name:'cooldown',args:[]}]);
 });
 await check('persisted-settings-survive-restart',async()=>{
  const before=await settings();await stop();await start();assert.deepEqual(await settings(),before);
 });
}finally{await stop();await fs.rm(temp,{recursive:true,force:true});}
for(const result of results)console.log((result.pass?'PASS: ':'FAIL: ')+result.name+(result.error?' — '+result.error:''));
const passed=results.filter(r=>r.pass).length;console.log('TASK_SETTINGS_API '+passed+'/'+results.length);if(passed!==results.length)process.exitCode=1;
