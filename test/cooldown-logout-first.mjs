import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {OverloadCooldown} from '../src/overload-cooldown.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'cooldown-logout-first-'));
const email='cooldown@example.test',config={baseUrl:'https://fixture.invalid',adminApiKey:'fixture'};
const events=[],rows=[{id:'7',enabled:true}],rules={windowMinutes:15,threshold:4,cooldownMinutes:360,reauthorizeAfterCooldown:true};
let now=Date.parse('2026-11-16T14:05:00Z'),lastDelay;
const options={filePath:path.join(root,'state.json'),getConfig:()=>config,backendIdentity:c=>c.baseUrl,getSettings:()=>rules,
 now:()=>now,setTimer:(_fn,delay)=>{lastDelay=delay;return{unref(){}};},clearTimer:()=>{},
 listAccounts:async()=>new Map([[email,structuredClone(rows)]]),
 request:async(_config,_path,options)=>{rows[0].enabled=JSON.parse(options.body).schedulable;events.push(rows[0].enabled?'resume':'pause');},
 afterPause:(_email,context)=>{assert.equal(rows[0].enabled,false);events.push({phase:'logout-request',...context});return{status:'pending'};},
 beforeResume:()=>({status:'completed'})};
let service=new OverloadCooldown(options);
try{
 service.stopped=false;await service.setEnabled(email,true);await service.refresh();
 await service.observeCounts(email,{config,accountIds:['7'],windowMinutes:15,sampledAt:now,point:{start:'2026-11-16T14:00:00Z',end:'2026-11-16T14:15:00Z',count:4}});
 await service.refresh();
 assert.equal(events[0],'pause');const requested=events.find(e=>e.phase==='logout-request');
 assert(requested);assert.equal(requested.cooldownMinutes,360);assert.equal(requested.logoutBeforeCooldown,true);
 assert.equal(service.snapshot(email).coolingUntil,null,'countdown began before confirmed logout');
 assert.equal(service.snapshot(email).phase,'logging_out');assert.equal(lastDelay,60_000);
 const operation=service.snapshot(email).operation;
 assert.equal(operation.status,'logging_out');assert.equal(operation.until,null,'recent operation guessed a deadline before logout');
 assert(!events.includes('resume'));
 await service.stop();service=new OverloadCooldown(options);await service.load();service.stopped=false;await service.refresh();
 assert.equal(service.accounts.get(email).resetRequestId,requested.id,'restart changed the durable logout request');
 assert.equal(service.snapshot(email).coolingUntil,null);assert(!events.includes('resume'));
 now+=30_000;
 const logoutCompletedAt=new Date(now).toISOString(),resumeAt=new Date(now+360*60_000).toISOString();
 service.afterPause=()=>({status:'pending',resumeAt,logoutCompletedAt});
 await service.refresh();
 assert.equal(service.snapshot(email).operation.id,operation.id);
 assert.equal(service.snapshot(email).operation.until,resumeAt);
 assert.equal(service.snapshot(email).operation.coolingStartedAt,logoutCompletedAt);
 assert.equal(service.snapshot(email).operation.startedAt,operation.startedAt);
 assert.equal(service.snapshot(email).operation.status,'cooling');
 console.log('COOLDOWN_LOGOUT_FIRST_PASS pause precedes logout request; timer awaits confirmed logout; operation deadline starts after logout; duration/request survive restart; no early resume');
}finally{await service.stop();await fs.rm(root,{recursive:true,force:true});}
