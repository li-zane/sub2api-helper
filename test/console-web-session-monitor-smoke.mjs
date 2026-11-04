import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { CookieJar } from "../src/protocol-login.mjs";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-web-monitor-http-"));
const output = path.join(root, "output");
const id = "11111111-1111-4111-8111-000000000001";
const email = "monitored@example.test";
const failedRefresh = process.argv.includes("--failed-refresh");
const scenario = process.argv.includes("--web-only") ? "web-only" : process.argv.includes("--binding-drift") ? "binding" : process.argv.includes("--workspace-lost") || failedRefresh ? "workspace" : "expired";
const webOnly = scenario === "web-only";
const sharedSlots = process.argv.includes("--shared-slots");
const foregroundId = "22222222-2222-4222-8222-000000000002";
const initialPlan = scenario === "binding" ? "free" : "business";
const dir = path.join(output, id);
const webFile = path.join(dir, "web-session.json");
const resultFile = path.join(dir, "sub2api-import-oauth.json");
const traceFile = path.join(root, "trace.json");
let authStatus = 200;
let holdAuth = false, unblockAuth;
const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
const remoteAccount = { id: 10, platform: "openai", type: "oauth", status: "active", proxy_id: 1, credentials: { email, plan_type: initialPlan, access_token: "old-Codex", refresh_token: "old-refresh" }, extra: {} };
const updates = [];
const pool = http.createServer(async (req, res) => {
  const chunks = []; for await (const b of req) chunks.push(b);
  const p = new URL(req.url, "http://fixture").pathname;
  res.setHeader("content-type", "application/json");
  if (p === "/api/v1/admin/proxies/all") return res.end(JSON.stringify({ data: [{ id: 1, name: "Old paid IP", protocol: "http", host: "old-proxy.test", port: 8080, ip_address: "198.51.100.1" }] }));
  if (p === "/api/v1/admin/proxies/1") return res.end(JSON.stringify({ data: { id: 1, protocol: "http", host: "old-proxy.test", port: 8080, ip_address: "198.51.100.1" } }));
  if (p === "/api/v1/admin/groups/all") return res.end(JSON.stringify({ data: [] }));
  if (p === "/api/v1/admin/accounts") return res.end(JSON.stringify({ data: { items: [remoteAccount], total: 1, pages: 1 } }));
  if (p === "/api/v1/admin/accounts/10" && req.method === "PUT") {
    const update = JSON.parse(Buffer.concat(chunks).toString()); updates.push(update); Object.assign(remoteAccount, update);
    return res.end(JSON.stringify({ data: remoteAccount }));
  }
  if (p === "/api/v1/admin/accounts/10") return res.end(JSON.stringify({ data: remoteAccount }));
  res.statusCode = 404; res.end("{}");
});
const requests = [];
const upstream = http.createServer((req, res) => {
  const p = new URL(req.url, "http://fixture").pathname;
  requests.push({ path: p, cookie: req.headers.cookie, device: req.headers["oai-device-id"], account: req.headers["chatgpt-account-id"] });
  res.setHeader("content-type", "application/json");
  if (p === "/api/auth/session") {
    const respond = () => {
      res.statusCode = authStatus;
      res.end(JSON.stringify(authStatus !== 200 ? { message: "temporary failure" } : req.headers.cookie?.includes("renewed") ? { user: { email }, accessToken: token } : {}));
    };
    if (holdAuth) { unblockAuth = respond; return; }
    return respond();
  }
  if (p.endsWith("/accounts/check/v4-2023-04-27")) return res.end(JSON.stringify({ current_account_id: "personal", accounts: {
    old: { account: { account_id: "old", plan_type: "business", is_deactivated: true } },
    personal: { account: { account_id: "personal", structure: "personal", plan_type: "free", can_access_with_session: true } },
    ...(failedRefresh ? { personalAlias: { account: { account_id: "personal", structure: "personal", plan_type: "free", can_access_with_session: true } } } : {}),
  } }));
  if (p.endsWith("/accounts/sessions")) return res.end(JSON.stringify({ devices: [{ session_id: "same-browser", display_name: "Persistent browser", is_current_device: true, last_signed_in_ip_address: "203.0.113.4" }] }));
  res.statusCode = 404; res.end("{}");
});
await new Promise(r => pool.listen(0, "127.0.0.1", r));
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
const poolUrl = `http://127.0.0.1:${pool.address().port}`;
const webUrl = `http://127.0.0.1:${upstream.address().port}`;
const wrapper = path.join(root, "protocol.mjs");
let child, exited, headers, base, logs = "";
const wait = async fn => {
  for (let n = 0; n < 200; n++) { const value = await fn().catch(() => null); if (value) return value; if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(logs); await new Promise(r => setTimeout(r, 50)); }
  throw new Error("fixture timed out\n" + logs);
};
async function start() {
  const l = http.createServer(); await new Promise(r => l.listen(0, "127.0.0.1", r)); const port = l.address().port; await new Promise(r => l.close(r));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [process.env.WEB_MONITOR_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "creds"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "creds"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: webUrl, SUB2API_MONITOR_ENABLED: "0", ONBOARDING_PROTOCOL_SCRIPT: wrapper },
  });
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; }); exited = new Promise(r => child.once("exit", r));
  const boot = await wait(async () => (await fetch(base + "/api/bootstrap")).json());
  headers = { "content-type": "application/json", "x-console-token": boot.token };
}
async function stop() { if (child?.exitCode === null) { child.kill("SIGTERM"); await exited; } }
async function api(route, body) {
  const res = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
try {
  await fs.mkdir(dir, { recursive: true });
  const identity = await getAccountBrowserIdentity(email, { root: path.join(output, "browser-identities") });
  const jar = new CookieJar(); jar.setFromResponse(webUrl, new Headers({ "set-cookie": `session=${scenario === "expired" || webOnly ? "old" : "renewed"}; Path=/` }));
  await writeAccountWebSession(webFile, { email, identity, cookies: jar.toJSON(), web: { workspaceId: scenario === "binding" ? "personal" : "old" }, accessToken: null });
  if (!webOnly) await fs.writeFile(resultFile, JSON.stringify({ type: "sub2api-data", accounts: [remoteAccount] }));
  await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: webOnly || failedRefresh ? "failed" : "completed", result_saved: !webOnly, plan_type: initialPlan, assigned_proxy_id: 1, authorization_proxy_selected: true, bound_ip: "198.51.100.1", created_at: "2026-11-01T00:00:00Z",
    ...(failedRefresh ? { pool_refresh_action: "relogin", pool_refresh_ready: false, pool_refresh_error: "WEB_PLAN_UNAVAILABLE: fixture failure" } : {}),
  }));
  if (failedRefresh) await fs.writeFile(path.join(output, "web-session-monitor.json"), JSON.stringify({ version: 1, accounts: { [email]: { status: "repairing", lastRepairAt: new Date(Date.now() - 61 * 60_000).toISOString(), nextCheckAt: new Date(0).toISOString() } } }));
  if (sharedSlots) {
    const fgDir = path.join(output, foregroundId); await fs.mkdir(fgDir);
    await fs.writeFile(path.join(fgDir, "job-meta.json"), JSON.stringify({ version: 1, email: "foreground@example.test", status: "completed", result_saved: true, plan_type: "business", assigned_proxy_id: 1, authorization_proxy_selected: true }));
    await fs.writeFile(path.join(fgDir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ ...remoteAccount, credentials: { ...remoteAccount.credentials, email: "foreground@example.test" } }] }));
  }
  await fs.writeFile(path.join(output, "task-settings.json"), JSON.stringify({ maxActiveJobs: 1, accountProxyMode: "plan", codexAuthMode: "local", accountProxyCooldownMinutes: 60 }));
  await fs.writeFile(path.join(output, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: poolUrl, adminApiKey: "fixture" }, profiles: [{ id: "default", name: "Paid", proxyId: "1" }, { id: "free", name: "Free", proxyId: "direct" }], planTypeBindings: { business: "default", free: "free" }, activeProfileId: "default" }));
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
if (process.env.TOSUB2_WEB_MONITOR_REPAIR !== '1') {
  console.log('Email OTP (r=resend, q=quit):'); process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve)); process.exit(0);
}
const f = process.env.TOSUB2_WEB_SESSION_PATH;
const session = JSON.parse(await fs.readFile(f, 'utf8'));
const webOnly = process.argv.includes('--web-only');
if (process.env.TOSUB2_WEB_MONITOR_REPAIR !== '1') throw Error('missing monitor context');
if (!webOnly && process.env.TOSUB2_PHASED_PROXY !== '1') throw Error('monitor must re-discover plan before OAuth');
const route = webOnly ? { proxyUrl: 'unchanged' } : await new Promise((resolve, reject) => { process.once('message', m => m.error ? reject(Error(m.error)) : resolve(m.route)); process.send({ type: 'codex-proxy-request', id: 'fixture', planType: 'free', workspaceId: 'personal' }); });
if (!webOnly && route.proxyUrl !== null) throw Error('Free must clear historical paid IP');
await fs.writeFile(${JSON.stringify(traceFile)}, JSON.stringify({ routeDirect: !route.proxyUrl, deviceId: session.identity.deviceId }));
session.cookies = session.cookies.map(c => c.name === 'session' ? { ...c, value: 'renewed' } : c); session.web = { workspaceId: 'personal' }; session.accessToken = ${JSON.stringify(token)}; session.validation = { status: 'valid', verifiedAt: new Date().toISOString() };
await fs.writeFile(f, JSON.stringify(session));
if (!webOnly) await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ type: 'sub2api-data', accounts: [{ platform: 'openai', type: 'oauth', credentials: { email: ${JSON.stringify(email)}, plan_type: 'free', chatgpt_account_id: 'personal', access_token: 'new-Codex', refresh_token: 'new-refresh' }, extra: { plan_type: 'free' } }] }));
console.log('[ok] Saved web session: ' + f); if (!webOnly) console.log('[ok] Saved sub2api import: ' + ${JSON.stringify(resultFile)});
process.disconnect();
`);
  await start();
  assert.equal((await fetch(base + "/api/web-session-monitor")).status, 403);
  let state = await api("/api/web-session-monitor");
  assert.equal(state.status, 200, "WebSession monitor endpoint must exist");
  assert.equal(state.body.settings.enabled, false);
  assert.equal((await api("/api/task-settings", { webSessionMonitor: { enabled: true, intervalMinutes: 0 } })).status, 400);
  assert.equal((await api("/api/web-session-monitor/check", {})).status, 409);
  if (sharedSlots) {
    await api(`/api/jobs/${foregroundId}/web-login`, {});
    const fgId = foregroundId;
    await wait(async () => (await api("/api/jobs")).body.jobs.find(j => j.id === fgId)?.status === "email_otp");
    authStatus = 503;
    await api("/api/task-settings", { webSessionMonitor: { enabled: true, autoRelogin: true, intervalMinutes: 15, retryMinutes: 60 } });
    await api("/api/web-session-monitor/check", {});
    assert.equal(requests.length, 0, "a full foreground task pool must defer WebSession probes");
    assert.equal((await api("/api/web-session-monitor")).body.accounts[email], undefined, "a deferred probe must stay due");
    await api(`/api/jobs/${fgId}/cancel`, {});
    await wait(async () => (await api("/api/jobs")).body.stats.active === 0);
    holdAuth = true;
    const checking = api("/api/web-session-monitor/check", {});
    await wait(async () => typeof unblockAuth === "function");
    const stats = (await api("/api/jobs")).body.stats;
    assert.equal(stats.active, 1); assert.equal(stats.webSessionChecks, 1, "probe reserves and reports a shared active slot");
    await api(`/api/jobs/${foregroundId}/web-login`, {});
    const nextId = foregroundId;
    assert.equal((await api("/api/jobs")).body.jobs.find(j => j.id === nextId).status, "queued", "login must not exceed the shared limit while a probe holds the slot");
    holdAuth = false; unblockAuth();
    await checking;
    assert.equal(requests.filter(r => r.path === "/api/auth/session").length, 3, "one check plus at most two retries");
    await wait(async () => (await api("/api/jobs")).body.jobs.find(j => j.id === nextId).status === "email_otp");
    assert.equal((await api("/api/jobs")).body.stats.webSessionChecks, 0);
    await api(`/api/jobs/${nextId}/cancel`, {});
    await api("/api/task-settings", { webSessionMonitor: { enabled: false } });
    console.log("WEB_SHARED_SLOTS_HTTP_PASS foreground-full defers probe; probe holds/reports one shared slot across retries; queued login waits and resumes on release; max-three-attempts");
  } else {
  // 503 while refreshing a Web token must NOT initiate a login or alter binding.
  authStatus = 503;
  await api("/api/task-settings", { webSessionMonitor: { enabled: true, autoRelogin: true, intervalMinutes: 15, retryMinutes: 60 } });
  await api("/api/web-session-monitor/check", {});
  assert.equal((await api("/api/web-session-monitor")).body.accounts[email].status, "check_failed");
  assert.equal(await fs.stat(traceFile).then(() => true, () => false), false);
  assert.equal(remoteAccount.proxy_id, 1);
  authStatus = 200;
  const started = await api("/api/web-session-monitor/check", {});
  assert.equal(started.body.accounts[email].repairReason, { expired: "expired", "web-only": "expired", workspace: "workspace_unavailable", binding: "binding_changed" }[scenario]);
  if (webOnly) await wait(async () => (await api(`/api/jobs/${id}/logs`)).body.logs?.includes("[web-login] Web 登录态已保存，未执行 Codex 授权或更新号池。"));
  else await wait(async () => remoteAccount.proxy_id === 0 && remoteAccount.credentials.plan_type === "free");
  await wait(async () => {
    await api("/api/web-session-monitor/check", {});
    return (await api("/api/web-session-monitor")).body.accounts[email].status === "valid";
  });
  state = await api("/api/web-session-monitor");
  assert.equal(state.body.accounts[email].status, "valid");
  assert.equal(state.body.accounts[email].currentWorkspaceId, "personal");
  assert.equal(state.body.accounts[email].devices[0].displayName, "Persistent browser");
  assert.equal(state.body.accounts[email].devices[0].lastSignedInIp, "203.0.113.4");
  assert.equal(JSON.parse(await fs.readFile(traceFile, "utf8")).deviceId, identity.deviceId);
  assert.equal(JSON.parse(await fs.readFile(webFile, "utf8")).identity.deviceId, identity.deviceId);
  if (webOnly) {
    assert.equal(await fs.stat(resultFile).then(() => true, () => false), false, "Web-only repair must not enroll in Codex");
    assert.equal(updates.length, 0); assert.equal(remoteAccount.proxy_id, 1);
  } else assert(updates.some(u => u.proxy_id === 0 && u.credentials?.plan_type === "free"));
  assert(requests.some(r => r.path.endsWith("/accounts/check/v4-2023-04-27") && !r.account), "workspace discovery is not scoped to the invalid old space");
  const snapshot = await fs.readFile(path.join(output, "web-session-monitor.json"), "utf8");
  for (const secret of [token, "new-Codex", "new-refresh", "session=renewed"]) assert(!snapshot.includes(secret));
  await stop(); await start();
  state = await api("/api/web-session-monitor"); assert.equal(state.body.settings.enabled, true);
  assert.equal(state.body.accounts[email].devices[0].displayName, "Persistent browser");
  const repairedAt = state.body.accounts[email].lastRepairAt;
  await api("/api/web-session-monitor/check", {});
  assert.equal((await api("/api/web-session-monitor")).body.accounts[email].lastRepairAt, repairedAt);
  await api("/api/task-settings", { webSessionMonitor: { enabled: false } });
  assert.equal((await api("/api/web-session-monitor/check", {})).status, 409);
  console.log(`WEB_SESSION_MONITOR_HTTP_PASS scenario=${scenario}; auth/settings; 503 not expired; ${webOnly ? "Web-only renewal without Codex enrollment or pool mutation" : "confirmed change -> shared login -> fresh Free plan -> direct binding -> pool sync"}; persistent device/workspaces; restart/cooldown; no secret snapshots`);
  }
} finally { await stop(); await Promise.all([new Promise(r => upstream.close(r)), new Promise(r => pool.close(r))]); await fs.rm(root, { recursive: true, force: true }); }
