import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-unified-auth-"));
const id = "11111111-1111-4111-8111-000000000001", email = "unified@example.test";
const dir = path.join(temp, id), file = path.join(dir, "sub2api-import-oauth.json");
const trace = path.join(temp, "trace.jsonl"), scenario = path.join(temp, "scenario");
const wrapper = path.join(temp, "protocol.mjs");
let child, headers, output = "", base;
const active = new Set(["queued", "starting", "working", "refreshing", "finalizing"]);
const wait = async fn => {
  for (const end = Date.now() + 15000; Date.now() < end;) {
    const value = await fn().catch(() => null); if (value) return value;
    if (child?.exitCode != null) throw Error(output);
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw Error("unified auth fixture timeout\n" + output);
};
async function api(route, body) {
  const r = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json() };
}
const job = async () => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
const events = async () => (await fs.readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
async function run(mode, expected, { batch = false } = {}) {
  await fs.writeFile(scenario, mode);
  const before = (await events()).length;
  const response = await api(batch ? "/api/jobs/reauthorize-batch" : `/api/jobs/${id}/authorize`, batch ? { ids: [id] } : {});
  assert.equal(response.status, 200);
  assert.equal((await api(`/api/jobs/${id}/authorize`, {})).status, 409, "authorization cannot overlap an active worker");
  await wait(async () => (await events()).length >= before + expected.length && !active.has((await job()).status));
  assert.deepEqual((await events()).slice(before).map(e => e.mode), expected);
  return job();
}
try {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email, access_token: "fixture-access", refresh_token: "fixture-refresh" } }] }));
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: "canceled", result_saved: true, plan_type: "free" }));
  const webOnlyId = "11111111-1111-4111-8111-000000000002", bannedId = "11111111-1111-4111-8111-000000000003";
  for (const [otherId, status] of [[webOnlyId, "completed"], [bannedId, "banned"]]) {
    const otherDir = path.join(temp, otherId); await fs.mkdir(otherDir);
    await fs.writeFile(path.join(otherDir, "job-meta.json"), JSON.stringify({ version: 1, email: `${status}@example.test`, status, result_saved: false, plan_type: "free" }));
  }
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
const mode=process.argv.includes('--refresh-sub2api')?'refresh':'web-oauth';
const email=mode==='refresh'?${JSON.stringify(email)}:process.argv[process.argv.indexOf('--email')+1];
await fs.appendFile(${JSON.stringify(trace)},JSON.stringify({mode})+'\\n');
await new Promise(r=>setTimeout(r,250));
const scenario=await fs.readFile(${JSON.stringify(scenario)},'utf8');
if(mode==='refresh'&&scenario!=='success'){
 console.error('[error] '+(scenario==='invalid'?'REFRESH_TOKEN_INVALID: fixture invalid grant':'OAUTH_REFRESH_REQUEST: fixture HTTP 503'));
 process.exit(1);
}
const file=process.argv[process.argv.indexOf('--sub2api-out')+1];
await fs.writeFile(file,JSON.stringify({type:'sub2api-data',accounts:[{credentials:{email,access_token:'fixture-new',refresh_token:'fixture-new-refresh'}}]}));
console.log('[ok] Saved sub2api import: '+file);
`);
  const listener = http.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp, ONBOARDING_PROTOCOL_SCRIPT: wrapper, LOCALAPPDATA: temp,
      TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", d => output += d); child.stderr.on("data", d => output += d);
  const boot = await wait(async () => { try { return (await fetch(base + "/api/bootstrap")).json(); } catch {} });
  headers = { "x-console-token": boot.token, "content-type": "application/json" };
  assert.equal((await run("success", ["refresh"])).lastOperationType, "reauthorize", "canceled account with an OAuth export must still refresh first");
  const original = await fs.readFile(file, "utf8");
  await run("transient", ["refresh"]);
  assert.equal(await fs.readFile(file, "utf8"), original, "transient refresh must retain the original OAuth export and must not sign in");
  await run("invalid", ["refresh", "web-oauth"]);
  const logs = (await api(`/api/jobs/${id}/logs?view=protocol`)).data;
  const entry = logs.entries.find(e => e.type === "reauthorize");
  const detail = (await api(`/api/jobs/${id}/logs?view=protocol&entry=${entry.id}`)).data;
  assert(detail.content.includes("OAuth 刷新令牌已确认失效"), "fallback route missing from the operation log");
  const saved = JSON.parse(await fs.readFile(file, "utf8")); delete saved.accounts[0].credentials.refresh_token;
  await fs.writeFile(file, JSON.stringify(saved));
  await run("success", ["web-oauth"], { batch: true });
  assert.equal((await job()).lastOperationType, "reauthorize");
  const before = (await events()).length;
  assert.equal((await api(`/api/jobs/${webOnlyId}/authorize`, {})).status, 200, "Web-only imported account must be eligible without an old OAuth export");
  await wait(async () => (await api("/api/jobs")).data.jobs.find(j => j.id === webOnlyId)?.canDownload);
  assert.deepEqual((await events()).slice(before).map(e => e.mode), ["web-oauth"]);
  assert.equal((await api(`/api/jobs/${bannedId}/authorize`, {})).status, 409);
  assert.equal((await events()).length, before + 1, "banned account must not launch OAuth");
  console.log("UNIFIED_AUTH_HTTP_PASS canceled-export refresh; active/banned exclusion; transient preserves OAuth without login; invalid-grant Web/OAuth fallback; missing-token batch and Web-only import; truthful operation logs");
} finally {
  if (child?.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done; }
  await fs.rm(temp, { recursive: true, force: true });
}
