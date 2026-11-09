import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CANDY_PROMPT, gradeCandy } from '../src/candy-test.mjs';
import { ModelFingerprintService } from '../src/model-fingerprint.mjs';

const results=[];
const test=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}};
await test('prompt-requests-a-final-marker-without-leaking-answer',()=>{
  assert(CANDY_PROMPT.includes('<final_answer>整数</final_answer>'));
  assert(!CANDY_PROMPT.includes('<final_answer>21</final_answer>'));
});
await test('reverse-marker-uses-final-correction-not-earlier-reasoning',()=>{
  assert.equal(gradeCandy('推理里提到21，初步结论22。\n<final_answer>21</final_answer>').status,'match');
  assert.equal(gradeCandy('<final_answer>21</final_answer>\n更正：\n<final_answer>29</final_answer>').extractedFinalAnswer,29);
  assert.equal(gradeCandy('<final_answer>29</final_answer>\n更正：\n<final_answer>21</final_answer>').extractedFinalAnswer,21);
});
await test('explicit-wrong-answer-is-scored-once-not-evidence-insufficient',()=>{
  const grade=gradeCandy('计算中出现21、28，最终答案如下。\n<final_answer>29</final_answer>');
  assert.equal(grade.status,'mismatch');assert.equal(grade.extractedFinalAnswer,29);
});
await test('malformed-or-ambiguous-final-marker-does-not-borrow-earlier-number',()=>{
  for(const text of ['答案21。\n<final_answer>21或22</final_answer>','<final_answer>21</final_answer>\n<final_answer>','答案21。\n<final_answer>21.5</final_answer>','<final_answer>9007199254740993</final_answer>'])assert.equal(gradeCandy(text).status,'unknown',text);
});
await test('existing-x3-latex-answer-is-extracted-from-the-end',()=>{
  const text='总共41个，最大不满足28个。\n\\[\n\\boxed{29\\text{ 个}}\n\\]';
  assert.equal(gradeCandy(text).extractedFinalAnswer,29);
  assert.equal(gradeCandy('先认为最终答案：22，重新计算后最终答案：21').extractedFinalAnswer,21);
  assert.equal(gradeCandy('最少需要取出：\n\\[\\boxed{21}\\]').status,'match');
});

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'helper-candy-one-pass-'));
let counter=0;
async function fixture({reply='未给出最终答案',error=null,models=['fixture'],sequence={first:'candy',fingerprint:1,candy:1}}={}){
  let calls=0,clock=Date.now();const account={id:1,type:'oauth',status:'active',credentials:{access_token:'fixture'},group_ids:[]};
  const options={filePath:path.join(dir,'state-'+(++counter)+'.json'),now:()=>++clock,
    getContext:()=>({backend:'fixture',config:{baseUrl:'https://fixture',adminApiKey:'fixture'},profiles:[]}),
    listTargets:async()=>[{id:1,email:'candy@example.test'}],getAccount:async()=>account,updateGroups:async()=>{},
    challenges:()=>[1,2,3].map(i=>({prompt:'fingerprint-'+i,expected_count:100})),
    sample:async(_config,_account,_model,prompt,_signal,{onMetadata})=>{calls++;onMetadata({finishStatus:'completed',usage:{inputTokens:10,outputTokens:20,totalTokens:30}});if(error)throw error;return prompt===CANDY_PROMPT?reply:Array.from({length:100},(_,i)=>i+1).join(',');},
    detectorLoader:async()=>({analyze:()=>({used_outputs:3,decision:'scored',probability_status:'reference_calibrated',probability:.99,prediction:'fixture',results:[{model:'fixture'}]})})};
  const service=new ModelFingerprintService(options);await service.saveSettings({models,testSequence:sequence,failureRetries:0});
  return{service,options,calls:()=>calls};
}
try{
  await test('unclear-complete-candy-has-one-request-and-next-cycle-is-fingerprint',async()=>{
    const f=await fixture();try{
      const state=await f.service.run('candy@example.test','free',{manual:true});
      assert.equal(f.calls(),1,'candy must not retry an unclear completed answer');
      assert.equal(state.result.status,'unknown');assert.equal(state.sequence.method,'fingerprint');assert.equal(state.sequence.position,2);
      const record=f.service.historyDetail('candy@example.test',state.result.id).record;
      assert.equal(record.requestCount,1);assert.equal(record.models[0].requests.length,1);assert.equal(record.models[0].requests[0].response,'未给出最终答案');
      assert.equal(record.usage.totalTokens,30);
      await f.service.stop();const restored=new ModelFingerprintService(f.options);try{await restored.load();assert.equal(restored.snapshot('candy@example.test','free').sequence.method,'fingerprint');}finally{await restored.stop();}
    }finally{await f.service.stop();}
  });
  await test('disabled-retry-transport-failure-is-one-candy-request-and-keeps-cycle',async()=>{
    const error=Object.assign(Error('fixture network'),{fingerprintFailure:true,code:'NETWORK',retryable:true});const f=await fixture({error});
    try{const state=await f.service.run('candy@example.test','free',{manual:true});assert.equal(f.calls(),1);assert.equal(state.result.status,'error');assert.equal(state.sequence.position,1);}finally{await f.service.stop();}
  });
  await test('single-sample-per-model-keeps-three-fingerprint-samples-and-configured-counts',async()=>{
    const f=await fixture({models:['fixture','second-model'],reply:'<final_answer>21</final_answer>',sequence:{first:'fingerprint',fingerprint:1,candy:3}});
    try{for(const method of ['fingerprint','candy','candy','candy','fingerprint']){
      const before=f.calls(),state=await f.service.run('candy@example.test','free',{manual:true});
      assert.equal(state.result.method,method);assert.equal(f.calls()-before,method==='candy'?2:6,'one request per candy model, three per fingerprint model');
      assert(state.result.models.every(m=>m.requests===undefined),'public snapshot must omit transcripts');
    }}finally{await f.service.stop();}
  });
  await test('explicit-wrong-candy-consumes-cycle-step',async()=>{
    const f=await fixture({reply:'<final_answer>29</final_answer>'});try{const state=await f.service.run('candy@example.test','free',{manual:true});assert.equal(f.calls(),1);assert.equal(state.result.status,'mismatch');assert.equal(state.result.models[0].extractedFinalAnswer,29);assert.equal(state.sequence.method,'fingerprint');}finally{await f.service.stop();}
  });
  await test('disabled-retry-incomplete-candy-retains-partial-reply-without-scoring',async()=>{
    const error=Object.assign(Error('interrupted'),{fingerprintFailure:true,code:'INCOMPLETE',retryable:true,fingerprintReply:'<final_answer>21</final_answer>'});
    const f=await fixture({error});try{const state=await f.service.run('candy@example.test','free',{manual:true});assert.equal(f.calls(),1);assert.equal(state.result.status,'error');assert.equal(state.sequence.position,1);const record=f.service.historyDetail('candy@example.test',state.result.id).record;assert.equal(record.models[0].requests[0].response,error.fingerprintReply);assert.equal(record.models[0].requests[0].accepted,false);}finally{await f.service.stop();}
  });
}finally{await fs.rm(dir,{recursive:true,force:true});}
for(const result of results)console.log((result.passed?'PASS: ':'FAIL: ')+result.name+(result.error?' — '+result.error:''));
const passed=results.filter(r=>r.passed).length;console.log('CANDY_REGRESSION '+passed+'/'+results.length);if(passed!==results.length)process.exitCode=1;
