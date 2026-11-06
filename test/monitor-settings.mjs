import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {MONITOR_FIELDS,DEFAULT_MONITORING,normalizeMonitoring} from '../web/src/monitor-settings.mjs';
import {limitPoolRequests} from '../src/pool-network.mjs';
import {createUsageTotalsReader} from '../src/sub2api-usage-totals.mjs';
import {OverloadMonitor} from '../src/overload-monitor.mjs';
import {OverloadCooldown} from '../src/overload-cooldown.mjs';
assert.deepEqual(normalizeMonitoring(),DEFAULT_MONITORING);
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
 cooldown=new OverloadCooldown({...common,filePath:path.join(temp,'cooldown.json'),getSettings:()=>({windowMinutes:15,threshold:5,cooldownMinutes:30}),getMonitoringSettings:()=>({intervalMs:2300,concurrency:2})});cooldown.stopped=false;await cooldown.refresh();assert.equal(scheduled,2300,'custom cooldown cadence');
 console.log('MONITOR_SETTINGS_PASS strict ranges/defaults; live limiter grow/shrink; dynamic usage TTL; independent overload/cooldown cadence');
}finally{await overload?.stop();await cooldown?.stop();await fs.rm(temp,{recursive:true,force:true});}
