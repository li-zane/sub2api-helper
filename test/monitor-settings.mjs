import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {MONITOR_FIELDS,DEFAULT_MONITORING,normalizeMonitoring,normalizeSavedMonitoring,TASK_SETTINGS_VERSION} from '../web/src/monitor-settings.mjs';
import {limitPoolRequests} from '../src/pool-network.mjs';
import {createUsageTotalsReader} from '../src/sub2api-usage-totals.mjs';
import {OverloadMonitor} from '../src/overload-monitor.mjs';
import {OverloadCooldown} from '../src/overload-cooldown.mjs';
assert.deepEqual(normalizeMonitoring(),DEFAULT_MONITORING);
assert.equal(TASK_SETTINGS_VERSION,4);
assert(!MONITOR_FIELDS.some(f=>['poolMonitorIntervalSeconds','overloadCooldownIntervalSeconds'].includes(f.key)));
const migrated=normalizeSavedMonitoring({version:3,monitoring:{poolMonitorIntervalSeconds:120,overloadCooldownIntervalSeconds:2,overloadIntervalSeconds:900,accountStatusIntervalSeconds:25}});
assert.equal(migrated.overloadIntervalSeconds,900,'version 3 custom 900s must remain unchanged');
assert.equal(migrated.accountStatusIntervalSeconds,25);
assert(!Object.hasOwn(migrated,'poolMonitorIntervalSeconds'));assert(!Object.hasOwn(migrated,'overloadCooldownIntervalSeconds'));
assert.equal(normalizeSavedMonitoring({version:2,monitoring:{overloadIntervalSeconds:900}}).overloadIntervalSeconds,60,'retain version 2 default migration');
for(const f of MONITOR_FIELDS){assert.equal(normalizeMonitoring({[f.key]:f.min})[f.key],f.min);assert.equal(normalizeMonitoring({[f.key]:f.max})[f.key],f.max);for(const v of [f.min-1,f.max+1,1.1,null,true,'1',NaN])assert.throws(()=>normalizeMonitoring({[f.key]:v}));}
let cap=1,active=0,peak=0,started=[],releases=[];
const limited=limitPoolRequests(async id=>{active++;peak=Math.max(peak,active);started.push(id);await new Promise(r=>releases[id]=r);active--;},()=>cap);
const all=[0,1,2,3].map(i=>limited(i));await new Promise(r=>setTimeout(r,0));assert.deepEqual(started,[0]);cap=3;limited.drain();await new Promise(r=>setTimeout(r,0));assert.deepEqual(started,[0,1,2]);cap=1;releases[0]();releases[1]();await new Promise(r=>setTimeout(r,0));assert.deepEqual(started,[0,1,2]);releases[2]();await new Promise(r=>setTimeout(r,0));assert.deepEqual(started,[0,1,2,3]);releases[3]();await Promise.all(all);assert.equal(peak,3);
let now=Date.now(),ttlMs=60000,calls=0;const read=createUsageTotalsReader({now:()=>now,getSettings:()=>({ttlMs,concurrency:1}),request:async()=>{calls++;return {total_tokens:calls};}});const cfg={baseUrl:'http://fixture',adminApiKey:'fixture'};await read(cfg,[1]);now+=2000;await read(cfg,[1]);assert.equal(calls,1);ttlMs=1000;await read(cfg,[1]);assert.equal(calls,2);
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-settings-'));let overload,cooldown;
try{
 let scheduled;
 const common={filePath:path.join(temp,'overload.json'),getConfig:()=>cfg,backendIdentity:()=> 'fixture',listAccounts:async()=>new Map(),request:async()=>{},now:()=>6000,setTimer:(_f,ms)=>{scheduled=ms;return {unref(){}};},clearTimer:()=>{}};
 overload=new OverloadMonitor({...common,getMonitoringSettings:()=>({intervalMs:7000,concurrency:2})});overload.stopped=false;await overload.refresh();assert.equal(scheduled,1000,'custom overload cadence');
 cooldown=new OverloadCooldown({...common,filePath:path.join(temp,'cooldown.json'),getSettings:()=>({windowMinutes:15,threshold:5,cooldownMinutes:30}),getMonitoringSettings:()=>({intervalMs:2300,concurrency:2})});cooldown.stopped=false;scheduled=null;await cooldown.refresh();assert.equal(scheduled,null,'no redundant cooldown polling when no account is cooling');
 cooldown.accounts.set('a@example.test',{enabled:true,phase:'cooling',backend:'fixture',resumeAccountIds:['7'],coolingUntil:new Date(6500).toISOString()});await cooldown.refresh();assert.equal(scheduled,500,'nearest account deadline wakes independently of statistics cadence');
 console.log('MONITOR_SETTINGS_PASS retired polling fields removed/migrated; strict ranges/defaults; live limiter grow/shrink; dynamic usage TTL; shared statistics cadence and independent cooldown deadlines');
}finally{await overload?.stop();await cooldown?.stop();await fs.rm(temp,{recursive:true,force:true});}
