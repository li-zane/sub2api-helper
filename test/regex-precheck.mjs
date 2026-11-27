import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelFingerprintService, normalizeFingerprintSettings } from "../src/model-fingerprint.mjs";
import { DEFAULT_REGEX_PRECHECK, normalizeRegexPrecheck } from "../shared/regex-precheck.mjs";
import { evaluateRegexPrecheck } from "../src/regex-precheck.mjs";
import { CANDY_PROMPT } from "../src/candy-test.mjs";
import { createFingerprintSampler } from "../src/model-fingerprint-request.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "regex-precheck-"));
const results = [];
async function test(name, run) { await run(); results.push(name); console.log("PASS: " + name); }
const rule = { enabled: true, model: "quick-model", prompt: "Reply with the verification word only.", pattern: "^READY$", flags: "i", degradedWhen: "no_match", skipFallbackOnPass: true };
const full = Array.from({length:100}, (_, i) => i + 1).join(",");
const account = { id: 1, email: "a@test", type: "oauth", status: "active", schedulable: true, group_ids: ["10"], credentials: { access_token: "fixture-secret" } };
let service, calls, detectorCalls, answer, fallbackAnswer, verdicts, recovery, groups, fail, held, release, twoTargets;
function create() {
  calls = []; detectorCalls = 0; answer = "ready"; fallbackAnswer = "最终答案：21";
  verdicts = []; recovery = []; groups = []; fail = null; held = false; release = null; twoTargets = false;
  return new ModelFingerprintService({ filePath: path.join(root, "state.json"),
    getContext: () => ({ backend: "pool", routing: "current", config: { baseUrl: "https://pool.test", adminApiKey: "fixture-secret" }, profiles: [{id:"default",groupIds:["10"]}], jobs: [] }),
    listTargets: async () => [account, ...(twoTargets ? [{ ...account, id: 2 }] : [])].map(a => ({ ...a, profileId: "default" })),
    getAccount: async (_c, id) => ({ ...account, id }),
    sample: async (_c, a, model, prompt, signal, options) => {
      calls.push({ id: a.id, model, prompt, options });
      options.onMetadata({ usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, finishStatus: "completed" });
      if (held) await new Promise(resolve => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); });
      signal.throwIfAborted();
      if (model === rule.model) { if (fail) throw fail; return twoTargets && a.id === 2 ? "NOT READY" : answer; }
      return prompt === CANDY_PROMPT ? fallbackAnswer : full;
    },
    challenges: () => Array.from({length:3}, () => ({ prompt: "numeric fixture", expected_count: 100 })),
    detectorLoader: async () => { detectorCalls++; return { builtAt: "fixture", analyze: () => ({ prediction: "fallback-model", prediction_name: "fallback-model", probability: .99, probability_status: "reference_calibrated", decision: "scored", used_outputs: 3, results: [{ model: "fallback-model", display_name: "fallback-model" }] }) }; },
    updateGroups: async (_c, id, ids) => groups.push({ id, ids }),
    onVerdict: (_email, _at, status) => verdicts.push(status),
    onAccountFailure: async (_email, detail) => recovery.push(detail.code),
    retryDelay: async () => {},
  });
}
const settings = { models: ["fallback-model"], precheck: rule, testSequence: {first:"candy", candy:1, fingerprint:1}, failureRetries: 0, groupPolicies: {default: {10:"verified"}} };
const run = () => service.run(account.email, "free", {manual:true});
try {
  await test("default-off-and-settings-validation", () => {
    assert.deepEqual(normalizeFingerprintSettings().precheck, DEFAULT_REGEX_PRECHECK);
    for (const patch of [{pattern:"["},{flags:"g"},{flags:"ii"},{enabled:1},{degradedWhen:"maybe"},{model:""},{prompt:" "},{pattern:""},{prompt:"a".repeat(16001)}]) {
      assert.throws(() => normalizeRegexPrecheck({...rule,...patch}), error => error.status === 400);
    }
  });
  await test("both-polarities-flags-and-regex-execution-limits", async () => {
    const signal = new AbortController().signal;
    assert.equal((await evaluateRegexPrecheck("ready",rule,signal)).status,"match");
    assert.equal((await evaluateRegexPrecheck("not ready",rule,signal)).status,"mismatch");
    assert.equal((await evaluateRegexPrecheck("ready",{...rule,degradedWhen:"match"},signal)).status,"mismatch");
    assert.equal((await evaluateRegexPrecheck("other",{...rule,degradedWhen:"match"},signal)).status,"match");
    assert.equal((await evaluateRegexPrecheck("before\nREADY\nafter",{...rule,flags:"im"},signal)).status,"match");
    let responsive = false; setTimeout(() => { responsive = true; }, 20);
    await assert.rejects(evaluateRegexPrecheck("a".repeat(30000)+"!",{...rule,pattern:"^(a+)+$"},signal), e => e.code === "REGEX_TIMEOUT");
    assert(responsive,"regex must not block the server event loop");
    await assert.rejects(evaluateRegexPrecheck("a".repeat(262145),rule,signal),e=>e.code==="REGEX_INPUT_LIMIT");
    await assert.rejects(evaluateRegexPrecheck("   ",rule,signal),e=>e.code==="EMPTY");
    const controller = new AbortController(); const pending = evaluateRegexPrecheck("a".repeat(30000)+"!",{...rule,pattern:"^(a+)+$"},controller.signal); controller.abort();
    await assert.rejects(pending,e=>e.name==="AbortError");
  });
  service = create(); await service.saveSettings(settings);
  await test("passing-precheck-skips-fallback-and-advances-one-sequence-slot", async () => {
    const state = await run(); assert.equal(state.result.method,"regex"); assert.equal(state.result.status,"match");
    assert.equal(calls.length,1); assert.equal(detectorCalls,0); assert.equal(state.sequence.method,"fingerprint");
    assert.equal(state.result.sequencePosition,1); assert.equal(state.result.precheck.fallbackMethod,"candy");
    assert.equal(state.result.precheck.sequenceAdvanced,true); assert.equal(state.result.precheck.fallbackExecuted,false);
    assert.equal(state.result.requestCount,1); assert.equal(state.result.usage.totalTokens,12); assert.deepEqual(verdicts,["match"]);
    assert.equal(calls[0].model,rule.model); assert.equal(calls[0].prompt,rule.prompt); assert(!calls[0].options.messages);
    assert(!JSON.stringify(state).includes(rule.prompt));
    const history=service.history(account.email,"free"); assert(!JSON.stringify(history).includes(rule.prompt));
    const detail=service.historyDetail(account.email,state.result.id).record;
    assert.equal(detail.models[0].requests[0].prompt,rule.prompt); assert.equal(detail.models[0].requests[0].response,"ready");
  });
  await test("suspected-failure-uses-next-fingerprint-slot-and-final-result-wins", async () => {
    answer="NOT READY"; const count=calls.length;
    const state=await run(); assert.equal(calls.length-count,4); assert.equal(state.result.method,"fingerprint");
    assert.equal(state.result.precheck.status,"mismatch"); assert.equal(state.result.status,"match");
    assert.equal(state.result.requestCount,4); assert.equal(state.result.usage.totalTokens,48);
    assert.equal(state.sequence.method,"candy"); assert(!JSON.stringify(state).includes(rule.prompt));
    assert.equal(state.result.sequencePosition,2); assert.equal(state.result.precheck.sequenceAdvanced,true);
    const detail=service.historyDetail(account.email,state.result.id).record;
    assert.equal(detail.precheck.models[0].requests[0].response,"NOT READY");
    assert.equal(detail.models[0].requests[0].prompt,"numeric fixture");
    assert.equal(verdicts.at(-1),"match"); assert(!verdicts.includes("mismatch"));
  });
  await test("pass-advances-and-restart-retains-advanced-fallback-slot", async () => {
    answer="ready"; await run(); assert.equal(service.sequence(account.email,"free").method,"fingerprint");
    await service.stop(); service=create(); await service.load();
    assert.equal(service.sequence(account.email,"free").method,"fingerprint");
    assert.equal(service.settings.precheck.pattern,rule.pattern);
    assert(service.history(account.email,"free").records.some(r=>r.precheck?.fallbackExecuted));
    answer="BAD"; const state=await run(); assert.equal(state.result.method,"fingerprint"); assert.equal(state.result.requestCount,4);
    assert.equal(detectorCalls,1); assert.equal(state.sequence.method,"candy");
  });
  await test("fallback-failure-is-final-and-records-both-stages", async () => {
    answer="BAD"; fallbackAnswer="最终答案：20";
    const state=await run(); assert.equal(state.result.status,"mismatch"); assert.equal(state.result.precheck.status,"mismatch");
    assert.equal(verdicts.at(-1),"mismatch"); assert(groups.some(g=>g.ids.length===0));
  });
  await test("optional-always-fallback-and-rule-edits-invalidate-only-evidence", async () => {
    const before=service.sequence(account.email,"free").position;
    await service.saveSettings({...settings,precheck:{...rule,skipFallbackOnPass:false}});
    assert.equal(service.snapshot(account.email,"free").result,null);
    assert.equal(service.sequence(account.email,"free").position,before);
    answer="ready"; const state=await run(); assert.equal(state.result.method,"fingerprint");
    assert.equal(state.result.precheck.status,"match"); assert.equal(state.result.precheck.fallbackExecuted,true);
  });
  await test("auth-quota-and-incomplete-responses-do-not-score-or-consume-fallback", async () => {
    await service.saveSettings(settings);
    for (const [code,httpStatus] of [["AUTH",401],["QUOTA",429],["INCOMPLETE",200]]) {
      const before=service.sequence(account.email,"free").position,count=calls.length;
      fail=Object.assign(Error("fixture-secret"),{fingerprintFailure:true,code,httpStatus,fingerprintReply:"READY",retryable:false});
      const state=await run(); assert.equal(state.result.status,"error"); assert.equal(state.result.method,"regex");
      assert.equal(calls.length-count,1); assert.equal(state.sequence.position,before); assert.equal(state.result.precheck.fallbackExecuted,false);
      assert.equal(state.result.precheck.sequenceAdvanced,false);
      assert(!JSON.stringify(state).includes("fixture-secret"));
    }
    assert.deepEqual(recovery,["AUTH","QUOTA"]); fail=null;
  });
  await test("multiple-remote-rows-require-all-prechecks-and-fallbacks", async () => {
    twoTargets=true; answer="READY"; fallbackAnswer="最终答案：21";
    const state=await run(); assert.equal(state.result.method,"candy");
    assert.equal(state.result.precheck.models.length,2); assert.equal(state.result.models.length,2);
    assert.equal(state.result.requestCount,4); assert.equal(state.result.status,"match"); twoTargets=false;
  });
  await test("disabled-precheck-keeps-existing-fingerprint-path", async () => {
    await service.saveSettings({...settings,precheck:{...rule,enabled:false}}); const count=calls.length;
    const state=await run(); assert.equal(state.result.method,"fingerprint"); assert.equal(calls.length-count,3); assert(!state.result.precheck);
  });
  await test("regex-timeout-keeps-complete-answer-without-retry-or-fallback", async () => {
    await service.saveSettings({...settings,failureRetries:2,precheck:{...rule,pattern:"^(a+)+$"}});
    answer="a".repeat(30000)+"!"; const count=calls.length, position=service.sequence(account.email,"free").position;
    const state=await run(); assert.equal(calls.length-count,1); assert.equal(state.result.status,"error");
    assert.equal(state.result.models[0].failure.code,"REGEX_TIMEOUT"); assert.equal(state.sequence.position,position);
    assert.equal(service.historyDetail(account.email,state.result.id).record.models[0].requests[0].response,answer);
  });
  await test("failed-reference-load-retains-precheck-transcript-without-advancing", async () => {
    await service.saveSettings({...settings,testSequence:{first:"fingerprint",fingerprint:1,candy:0}});
    answer="BAD"; service.detectorPromise=null; service.detectorLoader=async()=>{throw Error("参考库失败");};
    await assert.rejects(run(),e=>e.status===502);
    const state=service.snapshot(account.email,"free"),detail=service.historyDetail(account.email,state.result.id).record;
    assert.equal(state.result.status,"error"); assert.equal(state.result.requestCount,1); assert.equal(state.sequence.position,1);
    assert.equal(detail.precheck.models[0].requests[0].response,"BAD"); assert.equal(detail.models.length,0);
  });
  await test("changing-rule-cancels-active-sample-without-new-verdict", async () => {
    await service.saveSettings(settings); held=true; const count=verdicts.length;
    const work=run(); while(!release) await new Promise(r=>setTimeout(r,5));
    await service.saveSettings({...settings,precheck:{...rule,pattern:"^OTHER$"}}); await work;
    assert.equal(verdicts.length,count); assert.equal(service.active.size,0); held=false;
  });
  await test("scheduled-and-import-runs-use-precheck-with-import-deduplication", async () => {
    await service.saveSettings({...settings,enabledPlanTypes:["free"]}); answer="READY";
    service.stopped=false;
    const scheduled=await service.run(account.email,"free");
    assert.equal(scheduled.result.method,"regex"); assert.equal(scheduled.result.source,"scheduled");
    const imported=await service.run(account.email,"free",{importRunId:"precheck-import"});
    assert.equal(imported.result.method,"regex"); assert.equal(imported.result.source,"import");
    const count=calls.length;
    const position=service.sequence(account.email,"free").position;
    await service.run(account.email,"free",{importRunId:"precheck-import"}); assert.equal(calls.length,count);
    assert.equal(service.sequence(account.email,"free").position,position,"deduplicated import must not advance twice");
    service.stopped=true;
  });
  await test("consecutive-shortcuts-count-configured-repetitions-and-wrap", async () => {
    await service.saveSettings({...settings,testSequence:{first:"candy",candy:2,fingerprint:1}});
    answer="READY"; const count=calls.length;
    for (const [position,next,method] of [[1,2,"candy"],[2,3,"candy"],[3,1,"fingerprint"],[1,2,"candy"]]) {
      const state=await run();
      assert.equal(state.result.method,"regex"); assert.equal(state.result.sequencePosition,position);
      assert.equal(state.result.precheck.fallbackMethod,method); assert.equal(state.sequence.position,next);
    }
    assert.equal(calls.length-count,4,"skipped slots must not issue any fallback request");
  });
  await test("new-conversation-request-has-only-this-prompt-and-no-continuation", async () => {
    const bodies=[];
    const sample=createFingerprintSampler({transportFactory:()=>({configure:async()=>{},close:async()=>{},request:async(_m,_u,o)=>{
      bodies.push(JSON.parse(o.body)); return {ok:true,text:async()=>JSON.stringify({status:"completed",output:[{content:[{type:"output_text",text:"READY"}]}]})};
    }})});
    for(const prompt of ["Previous unrelated request",rule.prompt]) await sample({},account,rule.model,prompt,new AbortController().signal);
    assert.deepEqual(bodies[1].input,[{role:"user",content:[{type:"input_text",text:rule.prompt}]}]);
    assert.equal(bodies[1].store,false); assert.equal(bodies[1].instructions,"");
    for(const key of ["previous_response_id","conversation","conversation_id","messages"]) assert(!Object.hasOwn(bodies[1],key));
  });
  console.log(`REGEX_PRECHECK_PASS ${results.length}/${results.length}`);
} finally { await service?.stop(); await fs.rm(root,{recursive:true,force:true}); }
