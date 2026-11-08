import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ModelFingerprintService } from '../src/model-fingerprint.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-short-reply-'));
let calls = 0;
const full = Array.from({length:100}, (_,i) => i+1).join(', ');
const email = 'short@example.test';
const account = {id:1, email, type:'oauth', status:'active'};
const service = new ModelFingerprintService({
  filePath:path.join(dir,'state.json'),
  getContext:()=>({backend:'fixture',config:{baseUrl:'https://fixture',adminApiKey:'fixture'},profiles:[]}),
  listTargets:async()=>[account],getAccount:async()=>account,updateGroups:async()=>{},
  challenges:()=>Array.from({length:3},(_,i)=>({prompt:'unchanged-'+i,expected_count:100})),
  sample:async()=>++calls===1?'247, 19, 318, 74, 161, 292, 43, em?':full,
  detectorLoader:async()=>({analyze:outputs=>({used_outputs:outputs.filter(o=>o.text.split(',').length>=80).length,decision:'scored',probability_status:'reference_calibrated',probability:.99,prediction:'fixture',results:[{model:'fixture',probability:.99}]})}),
});
try {
  await service.saveSettings({models:['fixture']});
  const state = await service.run(email,'free',{manual:true});
  assert.equal(calls,4,'short completed replies must be retried instead of being silently scored');
  assert.equal(state.result.status,'match');
  const raw = service.historyDetail(email,service.history(email,'free').records[0].id).record;
  assert.equal(raw.models[0].requests[0].response,'247, 19, 318, 74, 161, 292, 43, em?');
  assert.equal(raw.models[0].requests[0].accepted,false);
  assert.equal(raw.models[0].requests[0].prompt,raw.models[0].requests[1].prompt);
  console.log('SHORT_REPLY_PASS attempts=4 original_reply=preserved prompt=unchanged scored_samples=3');
} finally { await service.stop(); await fs.rm(dir,{recursive:true,force:true}); }
