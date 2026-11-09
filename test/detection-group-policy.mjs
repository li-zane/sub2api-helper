import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ModelFingerprintService} from '../src/model-fingerprint.mjs';
import {CANDY_PROMPT} from '../src/candy-test.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'helper-group-policy-')),results=[];
const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}};
let count=0;
async function fixture(models=['fixture']){
 const email='groups@example.test',account={id:9,type:'oauth',status:'active',credentials:{access_token:'fixture',_token_version:1},group_ids:['10','99']};
 let calls=0,writes=0,clock=Date.now(),phase='match',failWrites=false,backend='fixture',blocked=false;
 const options={filePath:path.join(dir,'groups-'+(++count)+'.json'),now:()=>++clock,
  getContext:()=>({backend,config:{baseUrl:'https://fixture',adminApiKey:'fixture'},profiles:[{id:'default',groupIds:['10','20']}],jobs:[{email,planType:'free'}]}),
  listTargets:async()=>[{email,id:9,profileId:'default'}],getAccount:async()=>structuredClone(account),isBlocked:()=>blocked,
  sample:async(_config,_account,model,prompt)=>{calls++;if(phase==='error')throw Object.assign(Error('fixture'),{fingerprintFailure:true,code:'AUTH',httpStatus:401});return prompt===CANDY_PROMPT?(phase==='unknown'?'未给出最终答案':`<final_answer>${phase==='mismatch'||phase==='mixed'&&model==='second'?29:21}</final_answer>`):Array.from({length:100},(_,i)=>i+1).join(',');},
  challenges:()=>[1,2,3].map(i=>({prompt:'fingerprint-'+i,expected_count:100})),
  detectorLoader:async()=>({analyze:()=>({decision:'scored',used_outputs:3,probability_status:'reference_calibrated',probability:.99,prediction:phase==='mismatch'?'other':'fixture',results:[{model:'fixture'},{model:'other'}]})}),
  updateGroups:async(_config,_id,ids)=>{if(failWrites)throw Error('fixture group failure');writes++;account.group_ids=ids;}};
 const service=new ModelFingerprintService(options);
 await service.saveSettings({models,groupPolicies:{default:{10:'default',20:'verified'}}});
 const run=async(method,status='match')=>{phase=status;await service.saveOverride(email,{testSequence:{first:method,fingerprint:method==='fingerprint'?1:0,candy:method==='candy'?1:0}});return service.run(email,'free',{manual:true});};
 return{service,options,email,account,run,calls:()=>calls,writes:()=>writes,setFail:v=>failWrites=v,setBackend:v=>backend=v,setBlocked:v=>blocked=v};
}
try{
 await test('candy-pass-admits-without-any-fingerprint-and-preserves-unrelated-groups',async()=>{
  const f=await fixture();try{const state=await f.run('candy');assert.equal(state.result.status,'match');assert.deepEqual([...f.account.group_ids].sort(),['10','20','99']);assert.equal(f.calls(),1);assert.deepEqual(f.service.filterGroups(f.email,'free','default',['10','20','99'],f.account),['10','20','99']);}finally{await f.service.stop();}
 });
 await test('candy-failure-removes-after-fingerprint-pass',async()=>{
  const f=await fixture();try{await f.run('fingerprint');assert(f.account.group_ids.includes('20'));await f.run('candy','mismatch');assert.deepEqual([...f.account.group_ids].sort(),['10','99']);assert(!f.service.filterGroups(f.email,'free','default',['20'],f.account).includes('20'));}finally{await f.service.stop();}
 });
 await test('candy-pass-recovers-after-fingerprint-failure',async()=>{
  const f=await fixture();try{await f.run('fingerprint','mismatch');assert(!f.account.group_ids.includes('20'));await f.run('candy');assert(f.account.group_ids.includes('20'));}finally{await f.service.stop();}
 });
 await test('fingerprint-failure-removes-after-candy-pass',async()=>{
  const f=await fixture();try{await f.run('candy');assert(f.account.group_ids.includes('20'));await f.run('fingerprint','mismatch');assert(!f.account.group_ids.includes('20'));}finally{await f.service.stop();}
 });
 for(const status of ['unknown','error'])await test(status+'-preserves-existing-membership-without-new-admission',async()=>{
  const f=await fixture();try{await f.run('fingerprint');const writes=f.writes();const state=await f.run('candy',status);assert.equal(state.result.status,status);assert.equal(f.writes(),writes);assert(f.account.group_ids.includes('20'));assert(f.service.filterGroups(f.email,'free','default',['20'],f.account).includes('20'));assert.deepEqual(f.service.filterGroups(f.email,'free','default',['20'],{...f.account,group_ids:[]}),[]);}finally{await f.service.stop();}
 });
 await test('current-round-still-requires-all-configured-models-to-pass',async()=>{
  const f=await fixture(['fixture','second']);try{const state=await f.run('candy','mixed');assert.equal(state.result.status,'mismatch');assert.equal(f.calls(),2);assert(!f.account.group_ids.includes('20'));}finally{await f.service.stop();}
 });
 await test('identity-backend-and-plan-isolation-apply-to-candy-evidence',async()=>{
  const f=await fixture();try{await f.run('candy');const filtered=account=>f.service.filterGroups(f.email,'free','default',['20'],account);assert(filtered(f.account).includes('20'));assert.deepEqual(filtered({...f.account,credentials:{...f.account.credentials,_token_version:2},group_ids:[]}),[]);f.setBackend('other');assert.deepEqual(filtered({...f.account,group_ids:[]}),[]);f.setBackend('fixture');assert.deepEqual(f.service.filterGroups(f.email,'team','default',['20'],{...f.account,group_ids:[]}),[]);}finally{await f.service.stop();}
 });
 await test('pending-candy-group-sync-retries-after-restart-without-resampling',async()=>{
  const f=await fixture();let restored;try{f.setFail(true);const state=await f.run('candy');assert(state.groupSyncError);assert.equal(f.service.history(f.email,'free').groupSyncPending,true);await f.service.stop();restored=new ModelFingerprintService(f.options);await restored.load();f.setFail(false);const calls=f.calls();restored.stopped=false;await restored.tick();restored.stopped=true;assert.equal(f.calls(),calls);assert(f.account.group_ids.includes('20'));assert.equal(restored.history(f.email,'free').groupSyncError,null);}finally{await restored?.stop();await f.service.stop();}
 });
 await test('legacy-latest-candy-result-migrates-and-reconciles-without-sampling',async()=>{
  const f=await fixture();let restored;try{
   await f.run('candy');await f.service.stop();f.account.group_ids=['10','99'];
   const saved=JSON.parse(await fs.readFile(f.options.filePath,'utf8'));delete saved.groupPolicyVersion;saved.accounts[f.email].fingerprintResult={...saved.accounts[f.email].result,method:'fingerprint',status:'mismatch'};saved.accounts[f.email].groupSyncPending=false;await fs.writeFile(f.options.filePath,JSON.stringify(saved));
   restored=new ModelFingerprintService(f.options);await restored.load();assert.equal(restored.history(f.email,'free').groupSyncPending,true);const calls=f.calls();restored.stopped=false;await restored.tick();restored.stopped=true;assert.equal(f.calls(),calls);assert(f.account.group_ids.includes('20'));const migrated=JSON.parse(await fs.readFile(f.options.filePath,'utf8'));assert.equal(migrated.groupPolicyVersion,2);assert(!Object.hasOwn(migrated.accounts[f.email],'fingerprintResult'));
  }finally{await restored?.stop();await f.service.stop();}
 });
}finally{await fs.rm(dir,{recursive:true,force:true});}
for(const r of results)console.log((r.passed?'PASS: ':'FAIL: ')+r.name+(r.error?' — '+r.error:''));
const passed=results.filter(r=>r.passed).length;console.log('GROUP_POLICY_REGRESSION '+passed+'/'+results.length);if(passed!==results.length)process.exitCode=1;
