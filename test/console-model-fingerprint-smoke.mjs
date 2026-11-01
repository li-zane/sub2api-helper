import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-fingerprint-console-")), output = path.join(temp, "output");
let child, headers, logs = "", samples = 0;
const account = { id: 42, name: "fingerprint@example.test", email: "fingerprint@example.test", platform: "openai", type: "oauth", status: "active", schedulable: true, group_ids: [10, 20, 99], credentials: { email: "fingerprint@example.test", plan_type: "free", access_token: "private-fixture-token", chatgpt_account_id: "fixture-account" }, extra: {} };
const calls = [];
const pool = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  calls.push({ method: req.method, path: req.url, body: JSON.parse(raw || "{}") });
  res.setHeader("content-type", "application/json");
  const send = value => res.end(JSON.stringify({ code: 0, data: value }));
  if (req.url.startsWith("/api/v1/admin/accounts?")) return send({ items: [account], total: 1, pages: 1 });
  if (req.url === "/api/v1/admin/accounts/42") { if (req.method === "PUT") Object.assign(account, JSON.parse(raw)); const { access_token, ...redacted } = account.credentials; return send({ ...account, credentials: redacted }); }
  if (req.url === "/api/v1/admin/accounts/data?ids=42&include_proxies=true") return send({ accounts: [account], proxies: [] });
  if (req.url.includes("/groups/all")) return send([{ id: 10, name: "默认组", platform: "openai" }, { id: 20, name: "验证组", platform: "openai" }]);
  if (req.url.includes("/proxies/all")) return send([]);
  return send({});
});
const inference = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); samples++;
  assert.equal(req.headers.authorization, "Bearer private-fixture-token"); assert.equal(req.headers["chatgpt-account-id"], "fixture-account");
  assert(body.input[0].content[0].text.length > 70); assert.notEqual(body.input[0].content[0].text, "hi");
  const reply = Array.from({ length: 332 }, (_, i) => i % 355 + 1).join(", ");
  res.setHeader("content-type", "text/event-stream");
  res.end([{ type: "response.output_text.delta", delta: reply }, { type: "response.completed", response: {} }].map(event => "data: " + JSON.stringify(event) + "\n\n").join(""));
});
await Promise.all([listen(pool), listen(inference)]);
const port = await freePort(), base = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: temp, TOSUB2_TLS_PROFILE: "chrome142", TOSUB2_FINGERPRINT_TEST_URL: `http://127.0.0.1:${inference.address().port}/responses`, SUB2API_MONITOR_ENABLED: "0" } });
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
  assert((await get("/api/model-fingerprint/settings")).groups.some(g => g.id === "20"));
  const before = calls.length;
  const started = await post(`/api/jobs/${job.id}/model-fingerprint/check`, {}); assert.equal(started.status, 202, JSON.stringify(started.data));
  let checked;
  await waitFor(async () => { const data = await get('/api/jobs'); checked = { data: { job: data.jobs.find(j => j.id === job.id) } }; return checked.data.job.modelFingerprint.phase === 'idle' && checked.data.job.modelFingerprint.result; });
  assert.equal(samples, 6, "two requested models receive three individual SDK prompts each");
  assert.equal(checked.data.job.modelFingerprint.result.models.length, 2);
  assert.equal(checked.data.job.modelFingerprint.result.status, "unknown", "non-model numeric fixtures are not treated as genuine identity evidence");
  assert(!JSON.stringify(checked.data).includes("private-fixture-token"));
  assert(!calls.slice(before).some(c => c.method === "PUT"), "unknown evidence leaves existing groups unchanged");
  assert.equal((await post(`/api/jobs/${job.id}/model-fingerprint`, { enabled: false, models: ["gpt-5.5"], intervalMinutes: 20 })).status, 200);
  await stop(); await start();
  const restored = (await get("/api/jobs")).jobs.find(j => j.email === account.email);
  assert.equal(restored.modelFingerprint.intervalMinutes, 20); assert.equal(restored.modelFingerprint.override.enabled, false);
  const task = await post("/api/task-settings", { modelFingerprint: { models: ["gpt-5.4"], intervalMinutes: 60, minProbability: .85 } }); assert.equal(task.status, 200);
  assert.equal((await get("/api/model-fingerprint/settings")).settings.groupPolicies.default[20], "verified", "task defaults retain profile group policies");
  assert.equal((await get("/api/model-fingerprint/settings")).settings.models[0].model, "gpt-5.4");
  const puts = calls.filter(c => c.method === "PUT").length;
  const updated = await post("/api/sub2api/settings", { config, profiles: [{ id: "default", name: "Free", groupIds: [10, 20, 30] }], planTypeBindings: { free: "default" } }); assert.equal(updated.status, 200);
  const groupPut = calls.filter(c => c.method === "PUT").slice(puts).find(c => c.body.group_ids);
  assert.deepEqual(groupPut.body.group_ids.map(String), ["10", "20", "30"], "unknown evidence preserves existing conditional membership during profile updates");
  console.log("PASS: fingerprint HTTP authentication, defaults-off, plan/group discovery, real per-account prompt transport, multi-model three-sample checks, unknown preservation, restart/overrides, task defaults and profile admission gating");
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
