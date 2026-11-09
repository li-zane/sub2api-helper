import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ModelFingerprintService,normalizeFingerprintSettings} from '../src/model-fingerprint.mjs';
import {OverloadCooldown} from '../src/overload-cooldown.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'helper-cooling-retry-')),results=[];
const test=async(name,fn)=>{try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message});}};
const failure=(code,extra={})=>Object.assign(Error('fixture'),{fingerprintFailure:true,code,retryable:true,...extra});
let serial=0;
async function fixture({replies=['<final_answer>21</final_answer>'],settings={},cooling=false,wait}={}){
 const email='cooling@example.test',calls=[],waits=[],account={id:1,type:'oauth',status:'active',schedulable:!cooling,fingerprintCooling:cooling,credentials:{access_token:'fixture'},group_ids:[]};
 let stateCooling=cooling;
 const options={filePath:path.join(dir,'case-'+(++serial)+'.json'),getContext:()=>({backend:'fixture',config:{baseUrl:'https://fixture',adminApiKey:'fixture'},jobs:[{email,planType:'free'}],profiles:[]}),
  isBlocked:(_email,{manual=false}={})=>stateCooling&&!manual,
  listTargets:async(_config,{manual=false}={})=>!stateCooling||manual?[{email,id:1}]:[],getAccount:async()=>account,
  sample:async(_config,_account,_model,prompt,_signal,{onMetadata})=>{calls.push(prompt);onMetadata({usage:{inputTokens:2,outputTokens:3,totalTokens:5}});const r=replies[Math.min(calls.length-1,replies.length-1)];if(r instanceof Error)throw r;return r;},
  updateGroups:async()=>{},retryDelay:async(ms,signal)=>{waits.push(ms);await wait?.(signal);}};
 const service=new ModelFingerprintService(options);await service.saveSettings({models:['fixture'],testSequence:{first:'candy',fingerprint:1,candy:1},...settings});
 return{service,options,email,calls,waits,account,setCooling:v=>stateCooling=v,run:()=>service.run(email,'free',{manual:true})};
}
try{
 await test('retry-settings-defaults-and-strict-ranges',()=>{
  const s=normalizeFingerprintSettings();assert.equal(s.failureRetries,1);assert.equal(s.failureRetryDelaySeconds,5);
  for(const v of [null,'1',true,'',-1,6,1.2])assert.throws(()=>normalizeFingerprintSettings({failureRetries:v}));
  for(const v of [null,'5',true,'',0,301,1.2])assert.throws(()=>normalizeFingerprintSettings({failureRetryDelaySeconds:v}));
 });
 await test('overload-retries-same-model-in-one-round-with-usage-and-history',async()=>{
  const f=await fixture({replies:[failure('OVERLOADED',{httpStatus:503}),'...<final_answer>21</final_answer>']});try{
   const state=await f.run();assert.equal(f.calls.length,2);assert.equal(f.calls[0],f.calls[1]);assert.deepEqual(f.waits,[5000]);assert.equal(state.result.status,'match');assert.equal(state.sequence.position,2);assert.equal(state.result.usage.totalTokens,10);
   const record=f.service.historyDetail(f.email,state.result.id).record;assert.equal(f.service.history(f.email,'free').records.length,1);assert.deepEqual(record.models[0].requests.map(r=>[r.sample,r.attempt,r.status]),[[1,1,'error'],[1,2,'success']]);assert.equal(record.models[0].requests[0].failure.code,'OVERLOADED');
  }finally{await f.service.stop();}
 });
 await test('network-retry-bound-delay-and-cycle-retained',async()=>{
  const f=await fixture({replies:[failure('NETWORK')],settings:{failureRetries:2,failureRetryDelaySeconds:7}});try{const state=await f.run();assert.equal(f.calls.length,3);assert.deepEqual(f.waits,[7000,7000]);assert.equal(state.result.status,'error');assert.equal(state.sequence.position,1);}finally{await f.service.stop();}
 });
 await test('zero-disables-retry-and-settings-survive-restart',async()=>{
  const f=await fixture({replies:[failure('OVERLOADED')],settings:{failureRetries:0,failureRetryDelaySeconds:11}});let restored;try{await f.run();assert.equal(f.calls.length,1);assert.equal(f.waits.length,0);await f.service.stop();restored=new ModelFingerprintService(f.options);await restored.load();assert.equal(restored.settings.failureRetries,0);assert.equal(restored.settings.failureRetryDelaySeconds,11);}finally{await restored?.stop();await f.service.stop();}
 });
 await test('completed-pass-failure-and-unclear-answers-never-resample',async()=>{
  for(const [text,status]of [['<final_answer>21</final_answer>','match'],['<final_answer>29</final_answer>','mismatch'],['未提取','unknown']]){const f=await fixture({replies:[text],settings:{failureRetries:5}});try{const state=await f.run();assert.equal(state.result.status,status);assert.equal(f.calls.length,1);assert.equal(state.sequence.position,2);}finally{await f.service.stop();}}
 });
 await test('auth-quota-banned-429-never-retry-even-if-marked-retryable',async()=>{
  for(const [code,httpStatus]of [['AUTH',401],['AUTH',403],['BANNED',403],['QUOTA',429]]){const f=await fixture({replies:[failure(code,{httpStatus})],settings:{failureRetries:5}});try{await f.run();assert.equal(f.calls.length,1);assert.equal(f.waits.length,0);}finally{await f.service.stop();}}
 });
 await test('cancelling-retry-wait-keeps-previous-history-and-stops-requests',async()=>{
  let entered,release;const ready=new Promise(r=>entered=r);const f=await fixture({settings:{testSequence:{first:'candy',fingerprint:0,candy:1}},wait:signal=>new Promise((resolve,reject)=>{entered();release=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  try{await f.run();const before=f.service.snapshot(f.email,'free').recentResults;f.options.sample=async()=>{};
   f.service.sample=async()=>{f.calls.push('failed');throw failure('NETWORK');};const pending=f.run();let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Retry wait not entered: '+JSON.stringify(f.service.snapshot(f.email,'free')))),3000);})]);}finally{clearTimeout(timer);}f.service.invalidateAccount(f.email);await pending;assert.equal(f.calls.length,2);assert.deepEqual(f.service.snapshot(f.email,'free').recentResults,before);
  }finally{release?.();await f.service.stop();}
 });
 await test('helper-cooling-allows-manual-only-and-keeps-pool-paused',async()=>{
  const f=await fixture({cooling:true});try{const state=await f.run();assert.equal(state.result.status,'match');assert.equal(f.account.schedulable,false);assert.equal(f.service.isManualCheck(f.email),false);await assert.rejects(async()=>f.service.run(f.email,'free'),/不符合检测条件/);assert.equal(f.calls.length,1);}finally{await f.service.stop();}
 });
 await test('non-helper-pause-is-rejected-before-model-request',async()=>{
  const f=await fixture();try{f.account.schedulable=false;f.account.fingerprintCooling=false;await assert.rejects(f.run());assert.equal(f.calls.length,0);}finally{await f.service.stop();}
 });
 await test('cooldown-pause-ownership-is-scoped-to-id-and-backend',async()=>{
  let backend='fixture';const cooldown=new OverloadCooldown({getConfig:()=>({}),backendIdentity:()=>backend});
  cooldown.accounts.set('cooling@example.test',{backend:'fixture',phase:'cooling',resumeAccountIds:['1'],manualScheduling:{fixture:{2:false}}});
  assert.equal(cooldown.ownsPause('cooling@example.test',1),true);assert.equal(cooldown.ownsPause('cooling@example.test',2),false);backend='other';assert.equal(cooldown.ownsPause('cooling@example.test',1),false);backend='fixture';cooldown.accounts.get('cooling@example.test').manualScheduling.fixture[1]=false;assert.equal(cooldown.ownsPause('cooling@example.test',1),false);
 });
}finally{await fs.rm(dir,{recursive:true,force:true});}
for(const r of results)console.log((r.pass?'PASS: ':'FAIL: ')+r.name+(r.error?' — '+r.error:''));const passed=results.filter(r=>r.pass).length;console.log('COOLING_CANDY_RETRY '+passed+'/'+results.length);if(passed!==results.length)process.exitCode=1;
