import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createCredentialStore } from "../src/credential-store.mjs";
import { seedWebSession } from "./account-web-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-email-http-"));
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const original = "email-original@example.test", renamed = "email-renamed@example.test";
const secret = "JBSWY3DPEHPK3PXP", password = "fixture-password";
const folder = path.join(root, id(1)), output = path.join(folder, "sub2api-import-oauth.json"), sessionFile = path.join(folder, "web-session.json");
const credentialRoot = path.join(root, "credentials"), trace = path.join(root, "trace.jsonl");
const store = createCredentialStore({ windowsRoot: path.join(root, "toSub2", "credentials"), macRoot: credentialRoot,
  linuxRoot: credentialRoot, linuxKey: "ab".repeat(32) });
let child, base, headers, logs = "";
const remote = [{ id: 1, name: original, platform: "openai", type: "oauth", status: "active", schedulable: true, priority: 50, concurrency: 10,
  credentials: { email: original, access_token: "fixture", refresh_token: "fixture", plan_type: "team" } },
{ id: 99, name: "remote-only@example.test", platform: "openai", type: "oauth", status: "active", schedulable: true,
  credentials: { email: "remote-only@example.test" } }];
const writes = [];
const pool = http.createServer((req, res) => {
  const u = new URL(req.url, "http://fixture"); res.setHeader("content-type", "application/json");
  if (req.method === "GET" && u.pathname === "/api/v1/admin/accounts") return res.end(JSON.stringify({ data: { items: remote, total: remote.length, pages: 1 } }));
  if (req.method === "GET" && u.pathname === "/api/v1/admin/proxies/all") return res.end("[]");
  if (req.method !== "GET") writes.push(req.method + " " + u.pathname);
  res.end('{"data":{}}');
});
const upstream = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.endsWith("mfa_info")) return res.end('{"mfa_enabled_v2":true}');
  if (req.url.endsWith("change_password/eligibility")) return res.end('{"eligible":true}');
  if (req.url.includes("/accounts/check/")) return res.end('{"accounts":[{"id":"personal","plan_type":"team","name":"Workspace"}]}');
  res.end("{}");
});
const listen = server => new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port)));
async function start() {
  const listener = http.createServer(), port = await listen(listener); await new Promise(r => listener.close(r));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root,
      LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: credentialRoot, TOSUB2_MAC_CREDENTIAL_ROOT: credentialRoot, TOSUB2_CREDENTIAL_KEY: "ab".repeat(32),
      SUB2API_MONITOR_ENABLED: "0", ONBOARDING_PROTOCOL_SCRIPT: path.resolve("test/mock-web-login-protocol.mjs"), WEB_LOGIN_TRACE: trace,
      CHATGPT_BASE: `http://127.0.0.1:${upstream.address().port}`, TOSUB2_SESSION_NATIVE_HTTP: "1" } });
  child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
  for (const end = Date.now() + 20000; Date.now() < end;) {
    if (child.exitCode !== null) throw Error(logs);
    try { const r = await fetch(base + "/api/bootstrap"); const token = (await r.json()).token;
      if (token) { headers = { "content-type": "application/json", "x-console-token": token }; return; } } catch {}
    await new Promise(r => setTimeout(r, 40));
  }
  throw Error(logs || "startup timeout");
}
async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; } }
async function api(route, body, method = body === undefined ? "GET" : "POST", auth = true) {
  const res = await fetch(base + route, { signal: AbortSignal.timeout(15000), method, headers: auth ? headers : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json() };
}
const edit = (email, expectedEmail = original) => api(`/api/jobs/${id(1)}/email`, { email, expectedEmail }, "PUT");
const getJob = async () => (await api("/api/jobs")).data.jobs.find(j => j.id === id(1));
async function waitJob(predicate) {
  for (const end = Date.now() + 20000; Date.now() < end;) { const j = await getJob(); if (predicate(j)) return j; await new Promise(r => setTimeout(r, 60)); }
  throw Error("job wait timeout: " + logs);
}
try {
  await listen(pool); await listen(upstream); await fs.mkdir(folder);
  await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [remote[0]] }));
  await fs.writeFile(path.join(folder, "job-meta.json"), JSON.stringify({ version: 1, email: original, status: "completed", plan_type: "team",
    result_saved: true, has_password: true, has_totp_key: true, assigned_proxy_id: "7", account_cost_cny: 12.3 }));
  const session = await seedWebSession(output); session.validation = { status: "valid", verifiedAt: new Date().toISOString() };
  await fs.writeFile(sessionFile, JSON.stringify({ ...session, version: 1 }));
  await fs.mkdir(path.join(root, id(2)));
  await fs.writeFile(path.join(root, id(2), "job-meta.json"), JSON.stringify({ version: 1, email: "occupied@example.test", status: "completed" }));
  await store.save(original, { password, totpSecret: secret });
  await fs.writeFile(path.join(root, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture" }, profiles: [] }));
  const oauthBytes = await fs.readFile(output, "utf8"), webBytes = await fs.readFile(sessionFile, "utf8");
  await start();
  if (process.env.LOGIN_EMAIL_BASELINE === "1") {
    assert.equal((await edit(renamed)).status, 404); assert.equal((await getJob()).email, original);
    console.log("LOGIN_EMAIL_BASELINE_PASS endpoint=404; login_email=unchanged; history=absent");
  } else {
    assert.equal((await api(`/api/jobs/${id(1)}/email`, { email: renamed, expectedEmail: original }, "PUT", false)).status, 403);
    assert.equal((await edit("invalid")).status, 400);
    assert.equal((await api(`/api/jobs/${id(1)}/email`, { email: renamed }, "PUT")).status, 400);
    assert.equal((await edit("occupied@example.test")).status, 409);
    assert.equal((await edit("remote-only@example.test")).status, 409);
    const before = await getJob(), paid = (await api("/api/subscription-history")).data.records.find(r => r.email === original);
    const result = await edit(" Email-Renamed@Example.test ");
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.job.email, renamed);
    assert.equal(result.data.credentials.password, password); assert.equal(result.data.credentials.totpSecret, secret);
    const after = await getJob(); assert.equal(after.webSessionStatus, "valid"); assert.equal(after.sub2apiInPool, true);
    const poolStatus = (await api("/api/sub2api/account-status?refresh=1")).data;
    assert.equal(poolStatus.accounts[renamed]?.email, renamed); assert.equal(poolStatus.accounts[original], undefined);
    assert.equal(after.boundProxyId, before.boundProxyId); assert.equal(after.accountCostCny, before.accountCostCny);
    assert.equal(await fs.readFile(output, "utf8"), oauthBytes); assert.equal(await fs.readFile(sessionFile, "utf8"), webBytes);
    assert.equal((await store.load(original)).password, password);
    const copy = await api("/api/jobs/copy-credentials", { ids: [id(1)] }); assert.equal(copy.data.text, `${renamed}----${password}----${secret}`);
    assert.equal((await api(`/api/jobs?search=${renamed}`)).data.jobs[0].id, id(1));
    assert.equal((await api("/api/jobs/query", { emails: [renamed] })).data.jobs[0].id, id(1));
    const history = await api(`/api/jobs/${id(1)}/logs?view=credentials`);
    const changes = history.data.entries.filter(e => e.type === "email"); assert.equal(changes.length, 1);
    const detail = (await api(`/api/jobs/${id(1)}/logs?view=credentials&entry=${changes[0].id}`)).data.content;
    assert(detail.includes(original) && detail.includes(renamed)); assert(Number.isFinite(Date.parse(changes[0].at)));
    assert.equal((await edit("stale@example.test")).status, 409);
    assert.equal((await edit(renamed, renamed)).status, 200);
    assert.equal((await api(`/api/jobs/${id(1)}/logs?view=credentials`)).data.entries.filter(e => e.type === "email").length, 1);
    const paidAfter = (await api("/api/subscription-history")).data.records.find(r => r.id === paid.id);
    assert.equal(paidAfter.email, renamed); assert.equal(paidAfter.lastChange?.revision, paid.lastChange?.revision);
    await stop(); await start(); assert.equal((await getJob()).email, renamed);
    assert.equal((await getJob()).webSessionStatus, "valid"); assert.equal((await getJob()).sub2apiInPool, true);
    assert.equal((await api(`/api/jobs/${id(1)}/credentials`)).data.credentials.password, password);
    const imported = await api("/api/jobs", { email: renamed, password, totpSecret: secret });
    assert.equal(imported.data.job.id, id(1), "reimport created duplicate account");
    const failing = "web-fail-renamed@example.test";
    assert.equal((await edit(failing, renamed)).status, 200);
    assert.equal((await api(`/api/jobs/${id(1)}/web-login`, {})).status, 200);
    await waitJob(j => j.status === "email_otp");
    assert.equal((await edit("blocked@example.test", failing)).status, 409, "email changed during login");
    assert.equal((await api(`/api/jobs/${id(1)}/input`, { action: "email_otp", value: "123456" })).status, 200);
    await waitJob(j => Boolean(j.webLoginError));
    assert.equal(await fs.readFile(sessionFile, "utf8"), webBytes, "failed new-email login discarded original Web session");
    assert((await fs.readFile(trace, "utf8")).includes(failing), "protocol did not use edited login email");
    assert.equal(await fs.readFile(output, "utf8"), oauthBytes);
    assert.equal((await edit(renamed, failing)).status, 200);
    assert.equal((await api(`/api/jobs/${id(1)}/web-login`, {})).status, 200);
    await waitJob(j => j.status === "email_otp");
    await api(`/api/jobs/${id(1)}/input`, { action: "email_otp", value: "123456" });
    await waitJob(j => j.webLoginCompletedAt && !j.webLoginError && j.status === "completed");
    assert.equal(JSON.parse(await fs.readFile(sessionFile, "utf8")).email, renamed);
    assert.equal(await fs.readFile(output, "utf8"), oauthBytes);
    await stop(); await start(); assert.equal((await getJob()).webSessionStatus, "valid");
    assert.equal((await getJob()).email, renamed); assert.equal((await getJob()).sub2apiInPool, true);
    const mutations = writes.filter(p => /^PUT|^DELETE/.test(p)); assert.deepEqual(mutations, [], "local email edit wrote to upstream pool");
    assert(!logs.includes(secret) && !logs.includes(password), "private credential leaked to console logs");
    console.log("LOGIN_EMAIL_HTTP_PASS edit/history/time; auth/validation/conflicts; local+pool aliases; search/filter/copy; restart/reimport; task guard; new login email; failed login retains session; successful new session survives restart; pool unchanged");
  }
} finally { await stop(); await new Promise(r => pool.close(r)); await new Promise(r => upstream.close(r)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
