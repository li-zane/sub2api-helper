import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { CookieJar } from "../src/protocol-login.mjs";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-plan-session-"));
const output = path.join(root, "output");
const names = ["valid", "expired", "trouble", "banned", "unavailable"];
const ids = names.map((_, i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`);
const emailFor = name => `${name}@example.test`;
const requests = [], updates = [];
let plan = "free", child, exited, base, headers, logs = "";
const tokenFor = (name, cookie) => `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600, "https://api.openai.com/auth": { chatgpt_account_id: name === "unavailable" && cookie.includes("session=unavailable") ? "dead" : "personal", chatgpt_plan_type: plan } })).toString("base64url")}.signature`;
const upstream = http.createServer((req, res) => {
  const route = new URL(req.url, "http://fixture").pathname;
  const cookie = req.headers.cookie || "";
  const name = names.find(n => cookie.includes(`identity=${n}`)) || "unknown";
  requests.push({ name, route });
  res.setHeader("content-type", "application/json");
  if (route === "/api/auth/session") {
    if (name === "trouble") { res.statusCode = 503; return res.end(JSON.stringify({ error: "temporary" })); }
    if (name === "expired" && cookie.includes("session=expired")) { res.statusCode = 401; return res.end("{}"); }
    return res.end(JSON.stringify({ user: { email: emailFor(name) }, accessToken: tokenFor(name, cookie) }));
  }
  if (route.endsWith("/accounts/check/v4-2023-04-27")) return res.end(JSON.stringify({ current_account_id: "personal", accounts: { dead: { account: { account_id: "dead", plan_type: "business", is_deactivated: true } }, personal: { account: { account_id: "personal", structure: "personal", plan_type: plan, can_access_with_session: true } } } }));
  if (route.endsWith("/accounts/sessions")) return res.end(JSON.stringify({ devices: [{ session_id: "device", display_name: "Saved browser" }] }));
  res.statusCode = 404; res.end("{}");
});
const pool = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (req.method !== "GET") updates.push(req.url);
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/api/v1/admin/accounts")) return res.end(JSON.stringify({ data: { items: [], total: 0, pages: 1 } }));
  res.end(JSON.stringify({ data: [] }));
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
await new Promise(r => pool.listen(0, "127.0.0.1", r));
const webUrl = `http://127.0.0.1:${upstream.address().port}`;
const poolUrl = `http://127.0.0.1:${pool.address().port}`;
const trace = path.join(root, "login-trace");
const wrapper = path.join(root, "protocol.mjs");
const resultFile = id => path.join(output, id, "sub2api-import-oauth.json");
const originals = new Map();
const wait = async fn => {
  for (let n = 0; n < 400; n++) {
    const result = await fn().catch(() => null); if (result) return result;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(logs);
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error("fixture timed out\n" + logs);
};
async function api(route, body) {
  const res = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json() };
}
const job = async id => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
async function start() {
  const listener = http.createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port; await new Promise(r => listener.close(r)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [process.env.WEB_MONITOR_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root,"creds"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root,"creds"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: webUrl, SUB2API_MONITOR_ENABLED: "0", ONBOARDING_PROTOCOL_SCRIPT: wrapper },
  });
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; }); exited = new Promise(r => child.once("exit", r));
  const boot = await wait(async () => (await fetch(base + "/api/bootstrap")).json()); headers = { "content-type": "application/json", "x-console-token": boot.token };
}
async function stop() { if (child?.exitCode === null) { child.kill("SIGTERM"); await exited; } }
try {
  for (const [i, name] of names.entries()) {
    const id = ids[i], email = emailFor(name), dir = path.join(output, id); await fs.mkdir(dir, { recursive: true });
    const identity = await getAccountBrowserIdentity(email, { root: path.join(output, "browser-identities") });
    const jar = new CookieJar();
    jar.setFromResponse(webUrl, new Headers({ "set-cookie": `identity=${name}; Path=/` }));
    jar.setFromResponse(webUrl, new Headers({ "set-cookie": `session=${["expired", "unavailable"].includes(name) ? name : "valid"}; Path=/` }));
    await writeAccountWebSession(path.join(dir, "web-session.json"), { email, identity, cookies: jar.toJSON(), web: { workspaceId: name === "unavailable" ? "dead" : "personal" } });
    const contents = JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email, plan_type: "business", chatgpt_account_id: "personal", access_token: "original-Codex", refresh_token: "original-refresh" } }] });
    await fs.writeFile(resultFile(id), contents); originals.set(id, contents);
    await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: name === "banned" ? "banned" : "completed", result_saved: true, last_operation_type: "relogin", plan_type: "business", created_at: "2026-11-01T00:00:00Z" }));
  }
  await fs.writeFile(path.join(output, "task-settings.json"), JSON.stringify({ maxActiveJobs: 1, accountProxyMode: "global", autoActions: { business: ["enable-overload-detection", "enable-overload-cooldown"], free: ["upload"] } }));
  await fs.writeFile(path.join(output, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: poolUrl, adminApiKey: "fixture" }, profiles: [{ id: "default", name: "Default" }], activeProfileId: "default" }));
  await fs.writeFile(path.join(output, "model-fingerprint.json"), JSON.stringify({ version: 1, settings: { planDefaults: { business: true }, models: [] }, accounts: {} }));
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
if (!process.argv.includes('--web-only')) { console.log('Email OTP (r=resend, q=quit):'); process.stdin.resume(); await new Promise(r => process.stdin.once('data', r)); }
else {
const f=process.env.TOSUB2_WEB_SESSION_PATH;const s=JSON.parse(await fs.readFile(f,'utf8'));
await fs.appendFile(${JSON.stringify(trace)}, s.email+'\\n');
s.web={workspaceId:'personal'};s.cookies=s.cookies.map(c=>c.name==='session'?{...c,value:'valid'}:c);s.accessToken=${JSON.stringify(tokenFor("valid", "session=valid"))};s.validation={status:'valid',verifiedAt:new Date().toISOString()};
await fs.writeFile(f,JSON.stringify(s));console.log('[ok] Saved web session: '+f);
}
`);
  await start();
  for (const action of ["overload-detection", "overload-auto-cooldown"]) assert.equal((await api(`/api/jobs/${ids[0]}/${action}`, { enabled: true })).status, 200);
  assert.equal((await job(ids[0])).modelFingerprint.enabled, true);
  if (process.argv.includes("--plan-only")) {
    await api("/api/task-settings", { webSessionMonitor: { enabled: true, autoRelogin: false } });
    await api("/api/web-session-monitor/check", {});
    const current = await job(ids[0]);
    assert.equal(current.overloadDetection.enabled, false, "Free must close paid-plan overload detection");
    assert.equal(current.overloadAutoCooldown.enabled, false);
    assert.equal(current.planType, "free"); assert.equal(current.modelFingerprint.enabled, false);
    console.log("PLAN_AUTOMATION_PASS live Free closes overload/cooldown and inherited fingerprint without login or one-shot actions");
  } else {
    assert.equal((await fetch(base + `/api/jobs/${ids[0]}/web-session-check`, { method: "POST" })).status, 403);
    const blocker = await api("/api/jobs", { email: "foreground@example.test" });
    await wait(async () => (await job(blocker.data.job.id))?.status === "email_otp");
    const batch = await api("/api/jobs/web-session-check-batch", { ids });
    assert.equal(batch.status, 200, "manual Web-session batch endpoint must exist");
    assert.equal(batch.data.started, 4); assert.equal(batch.data.skipped, 1);
    assert.equal(requests.length, 0, "full shared pool must queue manual checks");
    assert.equal((await api(`/api/jobs/${ids[0]}/web-session-check`, {})).status, 409);
    const attempts = batch.data.jobs.map(j => ({ id: j.id, attemptId: j.webSessionCheckAttemptId }));
    assert((await api("/api/jobs/web-session-check-progress", { attempts })).data.progress.every(p => p.phase === "queued"));
    await api(`/api/jobs/${blocker.data.job.id}/cancel`, {});
    const finished = await wait(async () => {
      const result = await api("/api/jobs/web-session-check-progress", { attempts });
      return result.data.progress.every(p => ["success", "failed"].includes(p.phase)) && result.data;
    });
    assert.equal(finished.progress.find(p => p.id === ids[0]).phase, "success");
    assert.equal(finished.progress.find(p => p.id === ids[0]).renewed, false);
    assert.equal(finished.progress.find(p => p.id === ids[1]).phase, "success");
    assert.equal(finished.progress.find(p => p.id === ids[1]).renewed, true);
    assert.equal(finished.progress.find(p => p.id === ids[2]).phase, "failed");
    assert.match((await job(ids[2])).webSessionCheckError, /503/, "single row must expose asynchronous check failures");
    assert.equal(finished.progress.find(p => p.id === ids[4]).phase, "success");
    assert.equal(finished.progress.find(p => p.id === ids[4]).renewed, true, "confirmed workspace loss must renew even if discovery returns 200");
    assert.equal(requests.filter(r => r.name === "trouble" && r.route === "/api/auth/session").length, 3, "non-401 must retry exactly twice even when scheduled monitor disabled");
    assert.equal(requests.filter(r => r.name === "expired" && r.route === "/api/auth/session").length, 2, "401 must proceed straight to renewal then one successful recheck");
    assert.equal(await fs.readFile(trace,"utf8"), "expired@example.test\nunavailable@example.test\n", "only confirmed expiry may log in");
    let current = await job(ids[0]);
    assert.equal(current.planType, "free"); assert.equal(current.overloadDetection.enabled, false); assert.equal(current.overloadAutoCooldown.enabled, false); assert.equal(current.modelFingerprint.enabled, false);
    plan = "business";
    const one = await api(`/api/jobs/${ids[0]}/web-session-check`, {});
    const oneAttempt = [{ id: ids[0], attemptId: one.data.job.webSessionCheckAttemptId }];
    await wait(async () => (await api("/api/jobs/web-session-check-progress", { attempts: oneAttempt })).data.progress[0].phase === "success");
    current = await job(ids[0]); assert.equal(current.planType, "business"); assert.equal(current.overloadDetection.enabled,true); assert.equal(current.overloadAutoCooldown.enabled,true); assert.equal(current.modelFingerprint.enabled,true);
    await api(`/api/jobs/${ids[0]}/overload-detection`, { enabled: false });
    const again = await api(`/api/jobs/${ids[0]}/web-session-check`, {});
    await wait(async () => (await api("/api/jobs/web-session-check-progress", { attempts: [{ id: ids[0], attemptId: again.data.job.webSessionCheckAttemptId }] })).data.progress[0].phase === "success");
    assert.equal((await job(ids[0])).overloadDetection.enabled,false,"same-plan checks respect manual disable");
    plan = "free";
    await api("/api/task-settings", { webSessionMonitor: { enabled: true, autoRelogin: false } });
    await api("/api/web-session-monitor/check", {});
    current = await job(ids[0]); assert.equal(current.planType,"free"); assert.equal(current.overloadAutoCooldown.enabled,false);
    await api("/api/web-session-monitor/check", {});
    assert.equal((await api("/api/web-session-monitor")).data.accounts[emailFor("valid")].repairReason, "plan_changed", "live plan must not hide pending OAuth plan repair");
    await stop(); await start();
    await api("/api/web-session-monitor/check", {});
    assert.equal((await job(ids[0])).planType, "free");
    assert.equal((await api("/api/web-session-monitor")).data.accounts[emailFor("valid")].repairReason, "plan_changed");
    assert.equal((await api("/api/jobs/web-session-check-progress", { attempts })).data.progress[0].phase, "failed", "restart must expose interrupted batches");
    assert.equal(await fs.readFile(trace,"utf8"), "expired@example.test\nunavailable@example.test\n");
    console.log("WEB_SESSION_CHECK_PASS shared queue; valid no login; 401/workspace-loss renew once/recheck; 503 three attempts; ban/busy skips; PlanType switches; manual-off preserved; scheduled reconciliation; pending OAuth drift/restart");
  }
  assert.equal(updates.length,0,"checks must not repeat uploads/rotations or mutate pool credentials");
  for (const [id, contents] of originals) assert.equal(await fs.readFile(resultFile(id),"utf8"),contents,"checks preserve Codex files");
} finally { await stop(); await Promise.all([new Promise(r => upstream.close(r)),new Promise(r => pool.close(r))]); await fs.rm(root,{ recursive:true,force:true }); }
