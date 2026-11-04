import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { CookieJar, ProtocolClient, loginChatgptWeb } from "../src/protocol-login.mjs";
import { readAccountWebSession, saveProtocolWebSession, writeAccountWebSession } from "../src/account-web-session.mjs";
import { listAccountSessions, listAccountWorkspaces, probeAccountWebSession, revokeAllAccountSessions } from "../src/account-sessions.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-web-session-"));
process.env.TOSUB2_BROWSER_IDENTITY_ROOT = path.join(root, "identities");
process.env.TOSUB2_SESSION_NATIVE_HTTP = "1";
const email = "account+a@example.test";
const identity = await getAccountBrowserIdentity(email);
const identities = await Promise.all(Array.from({ length: 8 }, () => getAccountBrowserIdentity(` ${email.toUpperCase()} `)));
assert(identities.every(value => JSON.stringify(value) === JSON.stringify(identity)), "concurrent logins reuse one identity");
assert.notEqual((await getAccountBrowserIdentity("account+b@example.test")).deviceId, identity.deviceId);
const restart = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { getAccountBrowserIdentity } from './src/account-browser-identity.mjs';
  console.log(JSON.stringify(await getAccountBrowserIdentity(${JSON.stringify(email)})));
`], { env: { ...process.env, TOSUB2_BROWSER_TLS_PROFILE: "chrome146" }, encoding: "utf8", windowsHide: true });
assert.equal(restart.status, 0, restart.stderr);
assert.deepEqual(JSON.parse(restart.stdout), identity, "process restarts retain the device and browser");

const jwt = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
let force401 = false;
let expired = false;
let wrongEmail = false;
let authReads = 0;
let authStatus = 200;
let teamUnavailable = false;
let sessionsUnauthorized = false;
let malformedAuth = false;
const management = [];
const signins = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/") {
    res.setHeader("set-cookie", ["__Host-next-auth.csrf-token=csrf; Path=/", "__Secure-next-auth.session-token=web-cookie; Path=/", "oai-did=upstream-random; Path=/"]);
    return res.end("{}");
  }
  if (url.pathname === "/api/auth/providers") return res.end("{}");
  if (url.pathname === "/api/auth/csrf") return res.end(JSON.stringify({ csrfToken: "csrf" }));
  if (url.pathname === "/api/auth/signin/openai") {
    for await (const _ of req) {};
    signins.push({ device: url.searchParams.get("ext-oai-did"), headers: req.headers });
    return res.end(JSON.stringify({ url: `${base}/` }));
  }
  if (url.pathname === "/api/auth/session") {
    authReads++;
    assert.match(req.headers.cookie, /__Secure-next-auth.session-token=web-cookie/);
    if (malformedAuth) return res.end("<!DOCTYPE html><title>temporary gateway page</title>");
    if (authStatus !== 200) { res.statusCode = authStatus; return res.end(JSON.stringify({ message: "temporary upstream failure" })); }
    return res.end(JSON.stringify(expired ? {} : { accessToken: jwt, user: { email: wrongEmail ? "other@example.test" : email } }));
  }
  management.push({ url: url.pathname, headers: req.headers });
  assert.equal(req.headers.authorization, `Bearer ${jwt}`, "management uses the web token, never the Codex token");
  assert.equal(req.headers["oai-device-id"], identity.deviceId);
  assert.equal(req.headers["user-agent"], identity.browser.userAgent);
  assert.equal(req.headers["sec-ch-ua"], identity.browser.secChUa);
  assert.match(req.headers.cookie, new RegExp(`oai-did=${identity.deviceId}`));
  if (force401) { force401 = false; res.statusCode = 401; return res.end("{}"); }
  if (sessionsUnauthorized && url.pathname.endsWith("/accounts/sessions")) { res.statusCode = 401; return res.end("{}"); }
  if (url.pathname.endsWith("/accounts/sessions")) return res.end(JSON.stringify({ devices: [
    { session_id: "current", is_current_device: true, app_sessions: [{ client_name: "ChatGPT Web" }] },
  ] }));
  if (url.pathname.endsWith("/accounts/check/v4-2023-04-27")) return res.end(JSON.stringify({ default_account: "a", accounts: {
    a: { account: { account_id: "a", name: "Personal", plan_type: "plus", structure: "personal" } },
    b: { account: { account_id: "b", name: "Team", plan_type: "business", is_deactivated: teamUnavailable } },
  } }));
  if (url.pathname.endsWith("/accounts/logout_all")) return res.end("{}");
  res.statusCode = 404; res.end("{}");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.CHATGPT_BASE = base;
const outputPath = path.join(root, "sub2api-import-oauth.json");
const webPath = path.join(root, "web-session.json");
const oauth = JSON.stringify({ accounts: [{ credentials: { access_token: "CODEX-MUST-NOT-BE-USED", refresh_token: "CODEX-MUST-NOT-BE-REFRESHED" } }] });
await fs.writeFile(outputPath, oauth);
const job = { email, outputPath };
try {
  await assert.rejects(listAccountSessions(job), /尚未保存 Web 登录态/);
  assert.equal(job.webSessionStatus, "absent");
  assert.equal(management.length, 0, "legacy accounts do not fall back to Codex");
  for (let i = 0; i < 2; i++) {
    const client = new ProtocolClient({ jar: new CookieJar() });
    const web = await loginChatgptWeb(client, { chatgptBase: base, authBase: base, email });
    assert.equal(web.deviceId, identity.deviceId);
    await saveProtocolWebSession(webPath, client, { ...web, workspaceId: "a" });
  }
  assert(signins.every(s => s.device === identity.deviceId && s.headers["user-agent"] === identity.browser.userAgent));
  const devices = await listAccountSessions(job);
  assert.deepEqual(devices.devices[0].appSessions, ["ChatGPT Web"]);
  assert.equal(job.webSessionStatus, "valid");
  assert.equal(authReads, 1);
  const workspaces = await listAccountWorkspaces(job);
  assert.equal(workspaces.workspaces.length, 2);
  assert.equal(workspaces.currentWorkspaceId, "a");
  assert.equal(authReads, 1, "valid web token is reused");
  force401 = true;
  await listAccountSessions(job);
  assert.equal(authReads, 2, "401 refreshes through the web cookie session");
  const readsBeforeProbe = authReads;
  assert.equal((await probeAccountWebSession(job)).repairReason, null);
  assert.equal(authReads, readsBeforeProbe + 1, "scheduled probe validates cookies even when the saved access token is still valid");
  const before401 = await readAccountWebSession(job);
  malformedAuth = true;
  await assert.rejects(probeAccountWebSession(job), /SESSION_PROVIDER_ERROR: HTTP 200/);
  assert.notEqual((await readAccountWebSession(job)).validation.status, "expired", "malformed 200 must be retryable, not false session expiry");
  malformedAuth = false;
  for (const endpoint of ["workspace", "sessions"]) {
    const authBefore = authReads, managementBefore = management.length;
    if (endpoint === "workspace") force401 = true; else sessionsUnauthorized = true;
    await assert.rejects(probeAccountWebSession(job), /SESSION_TOKEN_EXPIRED/);
    assert.equal(authReads, authBefore + 1, "a probe's backend 401 must not refresh cookies and retry again");
    assert.equal(management.length, managementBefore + (endpoint === "workspace" ? 1 : 2));
    sessionsUnauthorized = false;
    await writeAccountWebSession(webPath, before401);
  }
  authStatus = 503;
  await assert.rejects(probeAccountWebSession(job), /SESSION_PROVIDER_ERROR: HTTP 503/);
  assert.notEqual((await readAccountWebSession(job)).validation.status, "expired", "upstream failure is not session expiry");
  authStatus = 403;
  await assert.rejects(probeAccountWebSession(job), /SESSION_PROVIDER_ERROR: HTTP 403/);
  authStatus = 200;
  const activeSession = await readAccountWebSession(job);
  teamUnavailable = true;
  await writeAccountWebSession(webPath, { ...activeSession, web: { ...activeSession.web, workspaceId: "b" } });
  const changed = await probeAccountWebSession(job);
  assert.equal(changed.repairReason, "workspace_unavailable");
  assert.equal(changed.planType, null, "an inaccessible space does not by itself mean Free");
  assert(!management.at(-1).headers["chatgpt-account-id"], "listing is independent of the dead selected space");
  teamUnavailable = false;
  await writeAccountWebSession(webPath, activeSession);
  await assert.rejects(listAccountSessions({ ...job, email: "other@example.test" }), /浏览器身份文件无效/);
  const snapshot = await readAccountWebSession(job);
  wrongEmail = true;
  await writeAccountWebSession(webPath, { ...snapshot, accessToken: null });
  await assert.rejects(listAccountSessions(job), /其他账号/);
  wrongEmail = false; expired = true;
  await assert.rejects(listAccountSessions(job), /Web 登录态已失效/);
  assert.equal(job.webSessionStatus, "expired");
  assert.equal((await readAccountWebSession(job)).validation.status, "expired", "invalid state survives reload");
  expired = false;
  await revokeAllAccountSessions(job);
  assert.equal(job.webSessionStatus, "absent");
  assert.equal(job.webSessionAvailable, false);
  await assert.rejects(fs.access(webPath), { code: "ENOENT" });
  assert.deepEqual(await getAccountBrowserIdentity(email), identity, "logout retains the account's browser identity");
  assert.equal(await fs.readFile(outputPath, "utf8"), oauth, "web requests never change Codex credentials");
  console.log("PASS: Web login identity survives relogin/restart, separates accounts, refreshes with cookies, rejects legacy/expired/mismatched sessions, and leaves Codex credentials unchanged");
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
