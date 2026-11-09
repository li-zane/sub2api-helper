import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CANDY_QUESTION,CANDY_PROMPT,CANDY_PROMPT_SHA256,gradeCandy,normalizeTestSequence,sequenceStep} from '../src/candy-test.mjs';
import {ModelFingerprintService,normalizeFingerprintSettings,normalizeFingerprintOverride} from '../src/model-fingerprint.mjs';
assert.equal(crypto.createHash('sha256').update(CANDY_PROMPT).digest('hex'),CANDY_PROMPT_SHA256);
assert.equal(crypto.createHash('sha256').update(CANDY_QUESTION).digest('hex'),'2ab018535731ad59fe5c3f6e4c9dbd12c40519b2b79a8a94021d1737e46ed4a2','the original question/table stays unchanged');
for (const text of ['21','21颗。','{"answer":21}','最少需要取出21颗糖果。','最终答案：21']) assert.equal(gradeCandy(text).status,'match',text);
for (const text of ['22','讨论21，最终答案：22','{"answer":20}']) assert.equal(gradeCandy(text).status,'mismatch',text);
assert.equal(gradeCandy('最终答案：21，最终答案：22').extractedFinalAnswer,22,'the last explicit conclusion wins');
for (const text of ['可能是21或22','最终答案：21或22','尚未回答']) assert.equal(gradeCandy(text).status,'unknown',text);
for (const raw of [null,{},[],{first:'x',fingerprint:1,candy:1},{first:'candy',fingerprint:0,candy:0},{first:'candy',fingerprint:true,candy:2},{first:'candy',fingerprint:1.5,candy:2},{first:'candy',fingerprint:-1,candy:2},{first:'candy',fingerprint:1,candy:101},{first:'candy',fingerprint:'',candy:2}]) assert.throws(()=>normalizeTestSequence(raw));
assert.deepEqual(normalizeFingerprintSettings().testSequence,{first:'fingerprint',fingerprint:1,candy:0});
assert.equal(normalizeFingerprintOverride().testSequence,null);
assert.deepEqual([0,1,2,3,4].map(i=>sequenceStep({first:'fingerprint',fingerprint:1,candy:3},i).method),['fingerprint','candy','candy','candy','fingerprint']);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'helper-candy-cycle-'));
let calls=[], loads=0, answer='21', fail=false, clock=Date.now(), notifications=[];
const full=Array.from({length:100},(_,i)=>i+1).join(', ');
const account={id:9,type:'oauth',status:'active',credentials:{access_token:'fixture-secret'},group_ids:[]};
const options={filePath:path.join(dir,'state.json'),now:()=>++clock,getContext:()=>({backend:'fixture',config:{baseUrl:'https://fixture',adminApiKey:'fixture'},profiles:[{id:'default',groupIds:['1']}]}),listTargets:async()=>[{id:9,email:'a@test',profileId:'default'},{id:9,email:'b@test',profileId:'default'}],getAccount:async()=>structuredClone(account),updateGroups:async(_c,_id,ids)=>account.group_ids=ids,
  challenges:()=>[1,2,3].map(n=>({prompt:'fingerprint-'+n,expected_count:100})),
  sample:async(_c,_a,_m,p,_signal,{onMetadata})=>{calls.push(p);onMetadata({usage:{inputTokens:2,outputTokens:3,totalTokens:5}});if(fail)throw Object.assign(Error('secret'),{fingerprintFailure:true,code:'AUTH',httpStatus:401});return p===CANDY_PROMPT?answer:full;},
  onAccountFailure:async(email,detail)=>notifications.push([email,detail.code]),
  detectorLoader:async()=>{loads++;return {analyze:()=>({decision:'scored',used_outputs:3,probability_status:'reference_calibrated',probability:.99,prediction:'fixture',results:[{model:'fixture',probability:.99}]})};},
};
let service=new ModelFingerprintService(options);
try{
  await service.saveSettings({models:['fixture'],testSequence:{first:'fingerprint',fingerprint:1,candy:2},groupPolicies:{default:{1:'verified'}}});
  for(const method of ['fingerprint','candy','candy','fingerprint']){
    const before=calls.length;
    const state=await service.run('a@test','free',{manual:true});
    assert.equal(state.result.method,method);assert.equal(calls.length-before,method==='fingerprint'?3:1);assert.equal(state.result.status,'match');
    assert.equal(state.result.usage.totalTokens,method==='fingerprint'?15:5);
    if(method==='candy')assert.equal(state.result.models[0].extractedFinalAnswer,21);
  }
  assert.equal(loads,1);assert.equal(service.snapshot('b@test','free').sequence.method,'fingerprint');
  assert(service.filterGroups('a@test','free','default',['1'],account).includes('1'),'either method can supply a passing latest round');
  assert(!service.filterGroups('b@test','free','default',['1'],{...account,group_ids:[]}).includes('1'),'another account cannot borrow fingerprint evidence for new group admission');
  let next=service.snapshot('a@test','free').sequence;
  await service.stop(); service=new ModelFingerprintService(options); await service.load();
  assert.deepEqual(service.snapshot('a@test','free').sequence,next,'restart keeps the cycle cursor');
  fail=true;const before=calls.length;let state=await service.run('a@test','free',{manual:true});
  assert.equal(calls.length,before+1);assert.equal(state.result.status,'error');assert.deepEqual(state.sequence,next);assert.deepEqual(notifications,[['a@test','AUTH']]);
  fail=false;answer='最终答案：22';state=await service.run('a@test','free',{manual:true});
  assert.equal(state.result.status,'mismatch');assert.notEqual(state.sequence.position,next.position,'wrong answers are scored once and advance the cycle');
  await service.saveSettings({...service.settings,testSequence:{first:'candy',fingerprint:2,candy:1}});
  assert.equal(service.snapshot('a@test','free').sequence.method,'candy');
  for(const method of ['candy','fingerprint','fingerprint','candy'])assert.equal((await service.run('a@test','free',{manual:true})).result.method,method);
  await service.saveOverride('a@test',{testSequence:{first:'candy',fingerprint:0,candy:1}});
  assert.equal(service.snapshot('b@test','free').testSequence.fingerprint,2);
  const raw=service.historyDetail('a@test',service.history('a@test','free').records[0].id).record;
  assert.equal(raw.method,'candy');assert.equal(raw.models[0].requests[0].prompt,CANDY_PROMPT);
  assert.equal(service.history('a@test','free').records.length,6);assert(!JSON.stringify(service.snapshot('a@test','free')).includes(CANDY_PROMPT));
  const short=new ModelFingerprintService({...options,filePath:path.join(dir,'short.json'),sample:async(_c,_a,_m,p,_s,{onMetadata})=>{onMetadata({});return p==='fingerprint-2'?'1, 2, 3':full;}});
  try { await short.saveSettings({models:['fixture'],testSequence:{first:'fingerprint',fingerprint:1,candy:0}});const shortState=await short.run('a@test','free',{manual:true});assert.equal(shortState.result.status,'unknown');assert.equal(shortState.result.models[0].usedOutputs,2);assert.equal(shortState.result.models[0].samplingComplete,false); } finally { await short.stop(); }
  const candyOnly=new ModelFingerprintService({...options,filePath:path.join(dir,'only.json'),detectorLoader:()=>{throw Error('must not load reference for candy');}});
  try{await candyOnly.saveSettings({models:['fixture'],testSequence:{first:'candy',fingerprint:0,candy:1},groupPolicies:{default:{1:'verified'}}});assert.equal((await candyOnly.run('a@test','free',{manual:true})).result.status,'mismatch');assert.deepEqual(candyOnly.filterGroups('a@test','free','default',['1'],account),[]);}finally{await candyOnly.stop();}
  console.log('CANDY_CYCLE_PASS prompt_hash=true grading=pass/fail/unknown order=both restart=true independent_accounts=true auth_recovery=true history=6 usage=true');
}finally{await service.stop();await fs.rm(dir,{recursive:true,force:true});}
