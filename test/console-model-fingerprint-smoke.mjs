import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANDY_PROMPT } from '../src/candy-test.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-fingerprint-console-")), output = path.join(temp, "output");
let child, headers, logs = "", samples = 0;
const precheckPrompt = "This is a standalone verification request. Ignore all other conversations: reply with exactly READY and nothing else.";
let precheckReply = "READY";
let candyReply = "最终答案：21";
let candyFailure = false;
const account = { id: 42, name: "fingerprint@example.test", email: "fingerprint@example.test", platform: "openai", type: "oauth", status: "active", schedulable: true, group_ids: [10, 20, 99], credentials: { email: "fingerprint@example.test", plan_type: "free", access_token: "private-fixture-token", chatgpt_account_id: "fixture-account" }, extra: {} };
const calls = [], transcriptInputs = [], transcriptReplies = [];
const pool = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  calls.push({ method: req.method, path: req.url, body: JSON.parse(raw || "{}") });
  res.setHeader("content-type", "application/json");
  const send = value => res.end(JSON.stringify({ code: 0, data: value }));
  if (req.url.startsWith("/api/v1/admin/accounts?")) return send({ items: [account], total: 1, pages: 1 });
  if (req.url === "/api/v1/admin/accounts/42/schedulable") { account.schedulable = JSON.parse(raw).schedulable; return send(account); }
  if (req.url === "/api/v1/admin/accounts/42") { if (req.method === "PUT") Object.assign(account, JSON.parse(raw)); const { access_token, ...redacted } = account.credentials; return send({ ...account, credentials: redacted }); }
  if (req.url === "/api/v1/admin/accounts/data?ids=42&include_proxies=true") return send({ accounts: [account], proxies: [] });
  if (req.url.includes("/groups/all")) return send([{ id: 10, name: "默认组", platform: "openai" }, { id: 20, name: "验证组", platform: "openai" }]);
  if (req.url.includes("/proxies/all")) return send([]);
  return send({});
});
const inference = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); samples++; transcriptInputs.push(body.input[0].content[0].text);
  assert.equal(req.headers.authorization, "Bearer private-fixture-token"); assert.equal(req.headers["chatgpt-account-id"], "fixture-account");
  assert(body.input[0].content[0].text.length > 70); assert.notEqual(body.input[0].content[0].text, "hi");
  assert.equal(body.input.length, 1); assert.equal(body.input[0].role, 'user'); assert.equal(body.store, false);
  assert.equal(body.previous_response_id, undefined); assert.equal(body.conversation, undefined);
  if (body.input[0].content[0].text === CANDY_PROMPT && candyFailure) {
    res.writeHead(503, {"content-type":"application/json"});
    return res.end(JSON.stringify({error:{message:"Temporary inference failure"}}));
  }
  const reply = body.input[0].content[0].text === precheckPrompt ? precheckReply : body.input[0].content[0].text === CANDY_PROMPT ? candyReply : Array.from({ length: 332 }, (_, i) => i % 355 + 1).join(", ");
  transcriptReplies.push(reply);
  res.setHeader("content-type", "text/event-stream");
  res.end([{ type: "response.output_text.delta", delta: reply }, { type: "response.completed", response: {} }].map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
});
await Promise.all([listen(pool), listen(inference)]);
const port = await freePort(), base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "test/fingerprint-console-reference-loader.mjs")).href, "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: temp, TOSUB2_TLS_PROFILE: "chrome142", TOSUB2_FINGERPRINT_TEST_URL: `http://127.0.0.1:${inference.address().port}/responses`, SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", c => logs += c); child.stderr.on("data", c => logs += c);
  await waitFor(async () => { try { const r = await fetch(base + "/api/bootstrap"); const b = await r.json(); headers = { "x-console-token": b.token, "content-type": "application/json" }; return b.features.modelFingerprint; } catch { return false; } });
}
async function stop() { if (child && child.exitCode === null) { const exited = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await exited; } }
const config = { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture-key", groupIds: [10, 20] };
const settings = { models: ["gpt-5.5", "gpt-5.4"], intervalMinutes: 5, minProbability: .8, planDefaults: { free: false }, groupPolicies: { default: { 10: "default", 20: "verified" } } };
try {
  await start();
  assert.equal((await fetch(base + "/api/model-fingerprint/settings")).status, 403);
  assert.equal((await post("/api/sub2api/settings", { config, profiles: [{ id: "default", name: "Free", groupIds: [10, 20] }], planTypeBindings: { free: "default" } })).status, 200);
  await get("/api/sub2api/account-status?refresh=1");
  const job = (await get("/api/jobs")).jobs.find(j => j.email === account.email); assert(job);
  assert.equal(job.modelFingerprint.enabled, false); assert.equal(samples, 0, "new deployments send no model requests by default");
  assert.equal((await post("/api/model-fingerprint/settings", { settings: { ...settings, intervalMinutes: 1 } })).status, 400);
  assert.equal((await post("/api/model-fingerprint/settings", { settings })).status, 200);
  assert((await get("/api/model-fingerprint/settings")).groups.some(g => g.name === "验证组"), "group catalog is available for settings");
  const before = calls.length;
  const started = await post(`/api/jobs/${job.id}/model-fingerprint/check`, {}); assert.equal(started.status, 202, JSON.stringify(started.data));
  let checked;
  await waitFor(async () => { const data = await get('/api/jobs'); checked = { data: { job: data.jobs.find(j => j.id === job.id) } }; return checked.data.job.modelFingerprint.phase === 'idle' && checked.data.job.modelFingerprint.result; });
  assert.equal(samples, 6, "two requested models receive three individual SDK prompts each: " + JSON.stringify({ error: checked.data.job.modelFingerprint.lastError, result: checked.data.job.modelFingerprint.result?.failure, models: checked.data.job.modelFingerprint.result?.models?.map(m => ({ error: m.error, failure: m.failure })) }));
  assert.equal(checked.data.job.modelFingerprint.result.models.length, 2);
  assert.equal(checked.data.job.modelFingerprint.result.status, "unknown", "non-model numeric fixtures are not treated as genuine identity evidence");
  assert(!JSON.stringify(checked.data).includes("private-fixture-token"));
  assert(!calls.slice(before).some(c => c.method === "PUT"), "unknown evidence leaves existing groups unchanged");
  const history = await get(`/api/jobs/${job.id}/model-fingerprint/history`); assert.equal(history.records.length, 1); assert.equal(history.records[0].models.length, 2); assert.equal(typeof history.records[0].models[0].probabilityStatus, "string"); assert(!JSON.stringify(history).includes("private-fixture-token"));
  assert.equal((await fetch(base + `/api/jobs/${job.id}/model-fingerprint/history`)).status, 403);
  const round = history.records[0]; assert.equal(round.requestCount, 6); assert(round.id);
  assert(!JSON.stringify(history).includes(transcriptInputs[0])); assert(!JSON.stringify(checked.data).includes(transcriptInputs[0]));
  assert(!Object.hasOwn(round.models[0], "requests")); assert(!Object.hasOwn(checked.data.job.modelFingerprint.result.models[0], "requests"));
  const detailPath = `/api/jobs/${job.id}/model-fingerprint/history?round=${encodeURIComponent(round.id)}`;
  assert.equal((await fetch(base + detailPath)).status, 403);
  const detail = await get(detailPath); assert.equal(detail.record.models.length, 2);
  const requests = detail.record.models.flatMap(m => m.requests); assert.equal(requests.length, 6);
  assert.deepEqual(requests.map(r => r.prompt), transcriptInputs); assert.deepEqual(requests.map(r => r.response), transcriptReplies);
  assert(!JSON.stringify(detail).includes("private-fixture-token"));
  assert.equal((await fetch(base + `/api/jobs/${job.id}/model-fingerprint/history?round=missing`, { headers })).status, 404);
  assert.equal((await fetch(base + `/api/jobs/${job.id}/model-fingerprint/history?round=`, { headers })).status, 404);
  const withConcurrency = { ...settings, maxConcurrentAccounts: 2 };
  assert.equal((await post("/api/model-fingerprint/settings", { settings: { ...withConcurrency, maxConcurrentAccounts: 0 } })).status, 400);
  assert.equal((await post("/api/model-fingerprint/settings", { settings: withConcurrency })).status, 200);
  assert.equal((await post(`/api/jobs/${job.id}/model-fingerprint`, { enabled: false, models: ["gpt-5.5"], intervalMinutes: 20 })).status, 200);
  await stop(); await start();
  const restored = (await get("/api/jobs")).jobs.find(j => j.email === account.email);
  assert.equal(restored.modelFingerprint.intervalMinutes, 20); assert.equal(restored.modelFingerprint.override.enabled, false);
  assert.equal((await get(detailPath)).record.models[0].requests[0].prompt, transcriptInputs[0]);
  assert.equal((await get(`/api/jobs/${job.id}/model-fingerprint/history`)).records.length, 1); assert.equal((await get("/api/model-fingerprint/settings")).settings.maxConcurrentAccounts, 2);
  const task = await post("/api/task-settings", { modelFingerprint: { models: ["gpt-5.4"], intervalMinutes: 60, minProbability: .85 } }); assert.equal(task.status, 200);
  assert.equal((await get("/api/model-fingerprint/settings")).settings.groupPolicies.default[20], "verified", "task default updates preserve group rules");
  assert.equal((await get("/api/model-fingerprint/settings")).settings.models[0].model, "gpt-5.4");
  const puts = calls.filter(c => c.method === "PUT").length;
  const updated = await post("/api/sub2api/settings", { config, profiles: [{ id: "default", name: "Free", groupIds: [10, 20, 30] }], planTypeBindings: { free: "default" } }); assert.equal(updated.status, 200);
  const groupPut = calls.filter(c => c.method === "PUT").slice(puts).find(c => c.body.group_ids);
  assert.deepEqual(groupPut.body.group_ids.map(String), ["10", "20", "30"], "unknown evidence preserves existing conditional membership during profile updates");
  console.log("PASS: fingerprint lazy transcript HTTP auth/404, full prompts/replies, lightweight polling and restart; fingerprint HTTP authentication, defaults-off, PlanType allowlist migration, real per-account prompt transport, multi-model three-sample checks, unknown preservation, restart/overrides, task defaults and ordinary profile group sync");
  if (process.argv.includes('--candy-cycle')) {
    const sequence = {first:'fingerprint',fingerprint:1,candy:2};
    assert.equal((await post('/api/task-settings',{modelFingerprint:{testSequence:sequence}})).status,200);
    assert.deepEqual((await get('/api/model-fingerprint/settings')).settings.testSequence,sequence);
    await post(`/api/jobs/${job.id}/model-fingerprint`,{enabled:false,models:['gpt-5.5']});
    let latest;
    for (const method of ['fingerprint','candy','candy','fingerprint']) {
      const before = samples;
      const previous = (await get('/api/jobs')).jobs.find(j=>j.id===job.id).modelFingerprint.result?.id;
      assert.equal((await post(`/api/jobs/${job.id}/model-fingerprint/check`,{})).status,202);
      await waitFor(async()=>{latest=(await get('/api/jobs')).jobs.find(j=>j.id===job.id).modelFingerprint;return latest.phase==='idle'&&latest.result?.id!==previous;});
      assert.equal(latest.result.method,method);assert.equal(samples-before,method==='fingerprint'?3:1);
      const history = await get(`/api/jobs/${job.id}/model-fingerprint/history`);
      assert.equal(history.records[0].method,method);
      if(method==='candy') {assert.equal(latest.result.status,'match');assert.equal(latest.result.models[0].extractedFinalAnswer,21);const detail=await get(`/api/jobs/${job.id}/model-fingerprint/history?round=${latest.result.id}`);assert.equal(detail.record.models[0].requests[0].prompt,CANDY_PROMPT);}
    }
    const progress=latest.sequence;await stop();await start();
    assert.deepEqual((await get('/api/jobs')).jobs.find(j=>j.id===job.id).modelFingerprint.sequence,progress);
    assert.equal((await post('/api/task-settings',{modelFingerprint:{testSequence:{first:'candy',fingerprint:0,candy:0}}})).status,400);
    assert.equal((await post(`/api/jobs/${job.id}/model-fingerprint`,{enabled:false,testSequence:{first:'candy',fingerprint:2,candy:1}})).status,200);
    assert.equal((await get('/api/jobs')).jobs.find(j=>j.id===job.id).modelFingerprint.sequence.method,'candy');
    console.log('CONSOLE_CANDY_CYCLE_PASS authenticated_api=true task_settings=true inheritance=true methods=F/C/C/F restart=true validation=true transcripts=true');
  }
  const fingerprintRoute = `/api/jobs/${job.id}/model-fingerprint`;
  const batchImport = async () => {
    const response = await post("/api/jobs/batch", { text: account.email });
    assert([200, 201].includes(response.status), JSON.stringify(response.data));
    await waitFor(async () => (await get("/api/jobs")).jobs.find(row => row.id === job.id)?.autoTaskStatus === "completed");
  };
  const beforeImport = samples;
  await batchImport();
  assert.equal(samples, beforeImport, "default-off import must not sample");
  const auto = await post("/api/task-settings", { autoActions: { free: ["check-model-fingerprint"] } });
  assert.equal(auto.status, 200, `IMPORT_FINGERPRINT_SETTING actual=${auto.status}`);
  await batchImport();
  assert.equal(samples, beforeImport, "explicit account opt-out must be honored");
  assert.equal((await post(fingerprintRoute, { enabled: null, models: ["gpt-5.5"], testSequence: { first: "fingerprint", fingerprint: 1, candy: 0 } })).status, 200);
  account.schedulable = false;
  await batchImport();
  assert.equal(samples, beforeImport, "paused pool account must not sample");
  account.schedulable = true;
  await batchImport();
  assert.equal(samples, beforeImport + 3, "one import executes exactly one three-sample round");
  const afterImport = (await get("/api/jobs")).jobs.find(row => row.id === job.id);
  assert.equal(afterImport.modelFingerprint.enabled, false, "one-time import rule leaves the periodic schedule off");
  assert.equal((await get(fingerprintRoute + "/history")).records[0].source, "import");
  assert.equal(Date.parse(afterImport.modelFingerprint.nextCheckAt) - Date.parse(afterImport.modelFingerprint.lastAttemptAt), 60 * 60_000);
  await stop();
  // Simulate stopping after result persistence but before the task index was saved.
  const metadataPath = path.join(output, job.id, "job-meta.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, auto_task_status: "running", auto_task_index: 0 }));
  await start();
  await waitFor(async () => (await get("/api/jobs")).jobs.find(row => row.id === job.id)?.autoTaskStatus === "completed");
  assert.equal(samples, beforeImport + 3, "restart reuses the completed import round");
  console.log("IMPORT_FINGERPRINT_PASS default-off account-opt-out pool-pause one-round independent-schedule restart-dedup");
  if (process.argv.includes('--regex-precheck')) {
    const precheck = {enabled:true,model:'gpt-5.5',prompt:precheckPrompt,pattern:'^READY$',flags:'i',degradedWhen:'no_match',skipFallbackOnPass:true};
    assert.equal((await post('/api/model-fingerprint/settings', {patch:{precheck}})).status,200);
    assert.equal((await post(fingerprintRoute, {enabled:false,models:['gpt-5.5'],testSequence:{first:'candy',candy:1,fingerprint:1}})).status,200);
    const saved = (await get('/api/model-fingerprint/settings')).settings;
    assert.equal((await post('/api/model-fingerprint/settings',{patch:{precheck:{pattern:'['}}})).status,400);
    assert.deepEqual((await get('/api/model-fingerprint/settings')).settings,saved,'invalid regex writes are atomic');
    const check = async () => {
      const before = (await get(fingerprintRoute+'/history')).records[0]?.id;
      assert.equal((await post(fingerprintRoute+'/check',{})).status,202);
      let state;
      await waitFor(async()=>{state=(await get('/api/jobs')).jobs.find(j=>j.id===job.id).modelFingerprint;return state.phase==='idle' && state.result?.id!==before;});
      return state;
    };
    let before = samples, state = await check();
    assert.equal(samples-before,1); assert.equal(state.result.method,'regex'); assert.equal(state.result.status,'match'); assert.equal(state.sequence.method,'fingerprint');
    assert.equal(state.result.sequencePosition,1); assert.equal(state.result.precheck.sequenceAdvanced,true);
    precheckReply='OTHER'; before=samples; state=await check();
    assert.equal(samples-before,4); assert.equal(state.result.method,'fingerprint'); assert.equal(state.result.status,'mismatch');
    assert.equal(state.result.precheck.fallbackStatus,'unknown'); assert.equal(state.result.precheck.degradedByFallback,true);
    assert.equal(state.result.precheck.status,'mismatch'); assert.equal(state.result.requestCount,4); assert.equal(state.sequence.method,'candy');
    const detail = (await get(fingerprintRoute+'/history?round='+state.result.id)).record;
    assert.equal(detail.precheck.models[0].requests[0].prompt,precheckPrompt);
    assert.equal(detail.precheck.models[0].requests[0].response,'OTHER'); assert.equal(detail.models[0].requests.length,3);
    assert(!JSON.stringify(await get(fingerprintRoute+'/history')).includes(precheckPrompt));
    precheckReply='READY'; before=samples; state=await check(); assert.equal(samples-before,1); assert.equal(state.sequence.method,'fingerprint');
    await stop(); await start(); assert.deepEqual((await get('/api/model-fingerprint/settings')).settings.precheck,precheck);
    precheckReply='OTHER'; before=samples; state=await check(); assert.equal(samples-before,4); assert.equal(state.result.method,'fingerprint');
    before=samples; state=await check(); assert.equal(samples-before,2); assert.equal(state.result.method,'candy'); assert.equal(state.result.status,'match');
    assert.equal(state.result.precheck.status,'mismatch'); assert.equal(state.sequence.method,'fingerprint');
    await Promise.all([
      post('/api/model-fingerprint/settings',{patch:{precheck:{flags:'im'}}}),
      post('/api/model-fingerprint/settings',{patch:{precheck:{skipFallbackOnPass:false}}}),
    ]);
    const merged=(await get('/api/model-fingerprint/settings')).settings.precheck;
    assert.equal(merged.flags,'im'); assert.equal(merged.skipFallbackOnPass,false); assert.equal(merged.prompt,precheckPrompt);
    console.log('REGEX_PRECHECK_HTTP_PASS validation; nested concurrent patches; fresh conversation; shortcuts advance once; candy/fingerprint fallback; final verdict; detailed transcripts; restart');
  }
  if (process.argv.includes("--degradation-cooldown")) {
    const cooldown = { enabled: true, longTerm: true, rotating: false, cooldownMinutes: 2 };
    assert.equal((await get('/api/model-fingerprint/settings')).settings.degradationCooldown.enabled, false);
    assert.equal((await post('/api/model-fingerprint/settings', {patch:{degradationCooldown:{cooldownMinutes:0}}})).status,400);
    assert.equal((await post('/api/model-fingerprint/settings', {patch:{precheck:{enabled:false},degradationCooldown:cooldown}})).status,200);
    await post(fingerprintRoute,{enabled:false,models:['gpt-5.5'],testSequence:{first:'candy',candy:1,fingerprint:0}});
    const currentJob = async () => (await get('/api/jobs')).jobs.find(j=>j.id===job.id);
    const detect = async () => {
      const before = (await currentJob()).modelFingerprint.result?.id;
      assert.equal((await post(fingerprintRoute+'/check',{})).status,202);
      await waitFor(async()=>{const j=await currentJob();return j.modelFingerprint.phase==='idle' && j.modelFingerprint.result?.id!==before;});
      return currentJob();
    };
    const tagResult = await post(`/api/jobs/${job.id}/tags`,{validity:'长效'});
    assert.equal(tagResult.status,200,JSON.stringify(tagResult.data));
    await post('/api/model-fingerprint/settings',{patch:{precheck:{enabled:true,model:'gpt-5.5',prompt:precheckPrompt,pattern:'^READY$',flags:'',degradedWhen:'no_match',skipFallbackOnPass:true}}});
    precheckReply='OTHER'; candyReply='最终答案：21';
    const fallbackPass=await detect();
    assert.equal(fallbackPass.modelFingerprint.result.precheck.status,'mismatch');
    assert.equal(account.schedulable,true,'passing final verdict does not pause');
    await post('/api/model-fingerprint/settings',{patch:{failureRetries:0}});
    for (const fallbackStatus of ['unknown','error']) {
      candyReply='尚未确定最终答案'; candyFailure=fallbackStatus==='error';
      const combined=await detect(), result=combined.modelFingerprint.result;
      assert.equal(result.status,'mismatch'); assert.equal(result.precheck.fallbackStatus,fallbackStatus);
      assert.equal(result.precheck.degradedByFallback,true); assert.equal(result.models[0].status,fallbackStatus);
      await waitFor(async()=>!account.schedulable && (await currentJob()).degradationCooldown.phase==='cooling');
      const detail=(await get(fingerprintRoute+'/history?round='+result.id)).record;
      assert.equal(detail.precheck.models[0].requests[0].response,'OTHER');
      assert.equal(detail.models[0].requests.length,1);
      if (fallbackStatus==='error') assert.equal(detail.models[0].failure.httpStatus,503);
      else assert.equal(detail.models[0].requests[0].response,candyReply);
      assert.equal((await post(`/api/sub2api/accounts/${job.id}/schedulable`,{enabled:true})).status,200);
      await waitFor(async()=>account.schedulable && !(await currentJob()).degradationCooldown.paused);
    }
    candyFailure=false;
    await post('/api/model-fingerprint/settings',{patch:{precheck:{enabled:false}}});
    assert.equal((await post(`/api/jobs/${job.id}/tags`,{validity:'轮转'})).status,200);
    candyReply='最终答案：22'; await detect();
    assert.equal(account.schedulable,true,'rotating switch off');
    assert.equal((await post(`/api/jobs/${job.id}/tags`,{validity:'长效'})).status,200);
    const identity = structuredClone({credentials:account.credentials,proxy:account.proxy_id});
    const mismatch = await detect();
    assert.equal(mismatch.modelFingerprint.result?.status,'mismatch',JSON.stringify(mismatch.modelFingerprint.result));
    assert.equal(mismatch.accountTags.validity,'长效');
    await waitFor(async()=>!(account.schedulable) && (await currentJob()).degradationCooldown.phase==='cooling').catch(async error=>{
      const j=await currentJob(); error.message += JSON.stringify({cooldown:j.degradationCooldown,result:j.modelFingerprint.result?.status,settings:(await get('/api/model-fingerprint/settings')).settings.degradationCooldown}); throw error;
    });
    const first = (await currentJob()).degradationCooldown;
    assert.equal(first.cooldownMinutes,2); assert.equal(first.validity,'长效');
    assert.equal((await currentJob()).canCheckModelFingerprint,true,'explicit diagnostic still available during rest');
    candyReply='最终答案：21'; await detect();
    assert.equal(account.schedulable,false,'passing manual check must not end rest early');
    candyReply='最终答案：22'; await detect();
    assert.equal((await currentJob()).degradationCooldown.coolingUntil,first.coolingUntil,'manual mismatch must not extend existing deadline');
    const sampleCount=samples;
    await stop(); await start();
    assert.equal((await currentJob()).degradationCooldown.coolingUntil,first.coolingUntil,'restart keeps deadline');
    assert.equal(samples,sampleCount,'restart does not probe resting account');
    assert.deepEqual({credentials:account.credentials,proxy:account.proxy_id},identity,'rest preserves credentials and IP');
    await stop();
    const file=path.join(output,'degradation-cooldown.json');
    let saved=JSON.parse(await fs.readFile(file,'utf8'));
    saved.accounts[account.email].coolingUntil=new Date(Date.now()-1000).toISOString();
    await fs.writeFile(file,JSON.stringify(saved));
    await start();
    await waitFor(async()=>account.schedulable && !(await currentJob()).degradationCooldown.paused);
    assert.equal(samples,sampleCount,'expiry resumes directly without recheck');
    await Promise.all([
      post('/api/model-fingerprint/settings',{patch:{degradationCooldown:{longTerm:false}}}),
      post('/api/model-fingerprint/settings',{patch:{degradationCooldown:{rotating:true}}}),
    ]);
    const merged=(await get('/api/model-fingerprint/settings')).settings.degradationCooldown;
    assert.deepEqual(merged,{...cooldown,longTerm:false,rotating:true});
    await detect(); assert.equal(account.schedulable,true,'long-term switch off');
    await post(`/api/jobs/${job.id}/tags`,{validity:'轮转'});
    await detect(); await waitFor(async()=>!account.schedulable && (await currentJob()).degradationCooldown.paused);
    assert.equal((await currentJob()).degradationCooldown.validity,'轮转');
    assert.equal((await post(`/api/sub2api/accounts/${job.id}/schedulable`,{enabled:false})).status,200);
    assert.equal((await currentJob()).degradationCooldown.paused,false,'manual stop releases cooldown ownership');
    await stop(); await start();
    assert.equal(account.schedulable,false,'restart must preserve manual stop');
    console.log('DEGRADATION_COOLDOWN_HTTP_PASS final candy verdict; uncertain/failed fallback treated as degraded; raw evidence; type switches; settings validation/concurrent patches; durable pause; no relogin or IP change; deadline restart/direct resume; manual stop');
  }
  if (process.argv.includes("--serve")) {
    await post("/api/sub2api/settings", { config, profiles: [{ id: "default", name: "Free", groupIds: [10, 20] }], planTypeBindings: { free: "default" } });
    if (process.env.MODEL_FINGERPRINT_FIXTURE_FILE) await fs.writeFile(process.env.MODEL_FINGERPRINT_FIXTURE_FILE, JSON.stringify({ url: base, output, temp }));
    console.log("UI_FIXTURE=" + base); await new Promise(r => { process.once("SIGINT", r); process.once("SIGTERM", r); });
  }
} catch (error) { error.message += "\n" + logs; throw error; }
finally { await stop(); await Promise.all([pool, inference].map(server => { server.closeAllConnections(); return new Promise(r => server.close(r)); })); await fs.rm(temp, { recursive: true, force: true }); }
function listen(server) { return new Promise(r => server.listen(0, "127.0.0.1", r)); }
async function freePort() { const s = http.createServer(); await listen(s); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function get(url) { const r = await fetch(base + url, { headers }); assert.equal(r.status, 200); return r.json(); }
async function post(url, body) { const r = await fetch(base + url, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; }
async function waitFor(fn) { const until = Date.now() + 30000; while (Date.now() < until) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); } throw new Error("fixture timeout"); }
