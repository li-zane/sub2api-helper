import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ModelFingerprintService,normalizeFingerprintSettings} from '../src/model-fingerprint.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'helper-shared-retry-')),results=[];
const test=async(name,fn)=>{try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message});}};
const error=(code='OVERLOADED',extra={})=>Object.assign(Error('fixture'),{fingerprintFailure:true,code,retryable:true,...extra});
const full=Array.from({length:100},(_,i)=>i+1).join(',');let serial=0;
async function fixture(method,settings={},reply){
 const calls=[],waits=[],email='retry@example.test',account={id:1,type:'oauth',status:'active',schedulable:true,credentials:{access_token:'fixture'},group_ids:[]};
 const options={filePath:path.join(dir,'case-'+(++serial)+'.json'),getContext:()=>({backend:'fixture',config:{baseUrl:'https://fixture',adminApiKey:'fixture'},profiles:[]}),listTargets:async()=>[{email,id:1}],getAccount:async()=>account,updateGroups:async()=>{},
  sample:async(_config,_account,_model,prompt,_signal,{onMetadata})=>{calls.push(prompt);onMetadata({usage:{inputTokens:2,outputTokens:3,totalTokens:5}});return reply?reply(prompt,calls):method==='candy'?'<final_answer>21</final_answer>':full;},
  retryDelay:async(ms)=>waits.push(ms),challenges:()=>[1,2,3].map(i=>({prompt:'sample-'+i,expected_count:100})),
  detectorLoader:async()=>({analyze:()=>({decision:'scored',used_outputs:3,probability_status:'reference_calibrated',probability:.99,prediction:'fixture',results:[{model:'fixture'}]})})};
 const service=new ModelFingerprintService(options);await service.saveSettings({models:['fixture'],testSequence:{first:method,fingerprint:method==='fingerprint'?1:0,candy:method==='candy'?1:0},...settings});return{service,options,calls,waits,email,run:()=>service.run(email,'free',{manual:true})};
}
try{
 await test('shared-defaults-and-legacy-candy-settings-migrate',()=>{
  const s=normalizeFingerprintSettings();assert.equal(s.failureRetries,1);assert.equal(s.failureRetryDelaySeconds,5);
  const old=normalizeFingerprintSettings({candyRetries:0,candyRetryDelaySeconds:9});assert.equal(old.failureRetries,0);assert.equal(old.failureRetryDelaySeconds,9);assert(!Object.hasOwn(old,'candyRetries'));
  const current=normalizeFingerprintSettings({failureRetries:3,failureRetryDelaySeconds:7,candyRetries:0,candyRetryDelaySeconds:9});assert.equal(current.failureRetries,3);assert.equal(current.failureRetryDelaySeconds,7);
 });
 await test('shared-settings-strict-ranges',()=>{
  for(const value of [null,true,'2','',-1,6,1.5])assert.throws(()=>normalizeFingerprintSettings({failureRetries:value}));
  for(const value of [null,true,'5','',0,301,1.5])assert.throws(()=>normalizeFingerprintSettings({failureRetryDelaySeconds:value}));
 });
 for(const method of ['fingerprint','candy']){
  await test(method+'-zero-disables-transient-retry',async()=>{
   const f=await fixture(method,{failureRetries:0},()=>{throw error();});try{const s=await f.run();assert.equal(s.result.status,'error');assert.equal(f.calls.length,1);assert.equal(f.waits.length,0);}finally{await f.service.stop();}
  });
  await test(method+'-configured-retry-bound-and-delay',async()=>{
   const f=await fixture(method,{failureRetries:2,failureRetryDelaySeconds:7},()=>{throw error();});try{const s=await f.run();assert.equal(s.result.status,'error');assert.equal(f.calls.length,3);assert.deepEqual(f.waits,[7000,7000]);const raw=f.service.historyDetail(f.email,s.result.id).record;assert.deepEqual(raw.models[0].requests.map(r=>r.attempt),[1,2,3]);assert.equal(raw.usage.totalTokens,15);}finally{await f.service.stop();}
  });
  await test(method+'-terminal-errors-never-retry',async()=>{
   for(const [code,httpStatus]of [['AUTH',401],['AUTH',403],['QUOTA',429],['BANNED',403]]){const f=await fixture(method,{failureRetries:5},()=>{throw error(code,{httpStatus});});try{await f.run();assert.equal(f.calls.length,1);assert.equal(f.waits.length,0);}finally{await f.service.stop();}}
  });
 }
 await test('fingerprint-only-retries-failed-second-sample',async()=>{
  let failed=false;const f=await fixture('fingerprint',{failureRetries:2,failureRetryDelaySeconds:11},prompt=>{if(prompt==='sample-2'&&!failed){failed=true;throw error('NETWORK');}return full;});try{
   const s=await f.run();assert.equal(s.result.status,'match');assert.deepEqual(f.calls,['sample-1','sample-2','sample-2','sample-3']);assert.deepEqual(f.waits,[11000]);assert.equal(s.result.models[0].usedOutputs,3);assert.equal(f.service.history(f.email,'free').records.length,1);
  }finally{await f.service.stop();}
 });
 await test('fingerprint-short-samples-respect-shared-disable-setting',async()=>{
  const f=await fixture('fingerprint',{failureRetries:0},prompt=>prompt==='sample-1'?'1,2,3':full);try{const s=await f.run();assert.deepEqual(f.calls,['sample-1','sample-2','sample-3']);assert.equal(s.result.status,'unknown');assert.equal(s.result.models[0].usedOutputs,2);}finally{await f.service.stop();}
 });
 await test('fingerprint-short-sample-retries-with-shared-interval',async()=>{
  const f=await fixture('fingerprint',{failureRetries:1,failureRetryDelaySeconds:13},(_prompt,calls)=>calls.length===1?'1,2,3':full);try{const s=await f.run();assert.equal(s.result.status,'match');assert.deepEqual(f.calls,['sample-1','sample-1','sample-2','sample-3']);assert.deepEqual(f.waits,[13000]);}finally{await f.service.stop();}
 });
 await test('scored-fingerprint-mismatch-and-candy-failure-do-not-resample',async()=>{
  for(const method of ['fingerprint','candy']){const f=await fixture(method,{failureRetries:5},()=>method==='candy'?'<final_answer>29</final_answer>':full);try{
   f.service.detectorLoader=async()=>({analyze:()=>({decision:'scored',used_outputs:3,probability_status:'reference_calibrated',probability:.99,prediction:'other',results:[{model:'fixture'},{model:'other'}]})});
   const s=await f.run();assert.equal(s.result.status,'mismatch');assert.equal(f.calls.length,method==='fingerprint'?3:1);assert.equal(f.waits.length,0);
  }finally{await f.service.stop();}}
 });
 await test('shared-settings-survive-restart-with-legacy-fields-pruned',async()=>{
  const f=await fixture('fingerprint',{candyRetries:2,candyRetryDelaySeconds:9});let restored;try{await f.service.stop();restored=new ModelFingerprintService(f.options);await restored.load();assert.equal(restored.settings.failureRetries,2);assert.equal(restored.settings.failureRetryDelaySeconds,9);const disk=JSON.parse(await fs.readFile(f.options.filePath,'utf8'));assert(!Object.hasOwn(disk.settings,'candyRetries'));assert.equal(disk.settings.failureRetries,2);}finally{await restored?.stop();await f.service.stop();}
 });
}finally{await fs.rm(dir,{recursive:true,force:true});}
for(const r of results)console.log((r.pass?'PASS: ':'FAIL: ')+r.name+(r.error?' — '+r.error:''));const passed=results.filter(r=>r.pass).length;console.log('SHARED_DETECTION_RETRY '+passed+'/'+results.length);if(passed!==results.length)process.exitCode=1;
