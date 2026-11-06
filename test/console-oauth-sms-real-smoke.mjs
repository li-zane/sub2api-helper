import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createCredentialStore } from "../src/credential-store.mjs";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
const project = path.resolve(import.meta.dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-real-oauth-sms-"));
const id = "11111111-1111-4111-8111-111111111111", email = "real-oauth-sms@example.test", dir = path.join(root, id);
const jwt = payload => `fixture.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const accessToken = jwt({ email, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "personal", chatgpt_plan_type: "free", user_id: "user" } });
let callback, upstreamBase, helper, headers, logs = "", smsCount = 0;
const calls = [], upstream = http.createServer(async (req, res) => {
  const u = new URL(req.url, upstreamBase), chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(), body = raw ? (req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : {};
  calls.push(u.pathname);
  const json = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
  if (u.pathname === "/sms") {
    assert.equal(u.searchParams.get("api_key"), "fixture-sms-key");
    const a = u.searchParams.get("action"); if (a === "getNumber" || a === "getNumberV2") { smsCount++; return res.end(`ACCESS_NUMBER:real-fixture-order-${smsCount}:1202555${String(smsCount).padStart(4, "0")}`); }
    return res.end(a === "getStatus" ? "STATUS_OK:654321" : "ACCESS_READY");
  }
  if (u.pathname === "/api/auth/session") return json({ user: { email }, accessToken, expires: "2030-01-01T00:00:00Z" });
  if (u.pathname === "/backend-api/accounts/check/v4-2023-04-27") return json({ accounts: { personal: { account: { account_id: "personal", name: "Personal", structure: "personal", plan_type: "free" } } }, default_account: "personal" });
  if (u.pathname === "/oauth/authorize") {
    callback = u.searchParams.get("redirect_uri") + "?code=fixture-code&state=" + u.searchParams.get("state");
    res.writeHead(302, { location: upstreamBase + "/log-in", "set-cookie": "codex-context=original; Path=/" }); return res.end();
  }
  if (["/log-in", "/log-in/password", "/add-phone"].includes(u.pathname)) return res.end("<html>normal authentication</html>");
  if (u.pathname === "/api/accounts/authorize/continue") {
    assert.equal(body.username.value, email); assert.match(req.headers.cookie, /codex-context=original/);
    return json({ page: { type: "login_password" }, continue_url: upstreamBase + "/log-in/password" });
  }
  if (u.pathname === "/api/accounts/password/verify") {
    assert.equal(body.password, "Fixture-Password-123!");
    return json({ page: { type: "mfa_challenge" }, continue_url: upstreamBase + "/mfa-challenge/factor", "oai-client-auth-session": { mfa_challenge_factors: [{ id: "factor", factor_type: "totp" }] } });
  }
  if (u.pathname === "/api/accounts/mfa/issue_challenge") return json({ success: true });
  if (u.pathname === "/api/accounts/mfa/verify") { assert.match(body.code, /^\d{6}$/); return json({ page: { type: "add_phone" }, continue_url: upstreamBase + "/add-phone" }); }
  if (u.pathname === "/api/accounts/add-phone/send") { assert.match(body.phone_number, /^\+1202555000[12]$/);
    if (body.phone_number.endsWith("1")) return json({ error: { message: "We've detected suspicious behavior from phone numbers similar to yours." } }, 400);
    return json({ continue_url: upstreamBase + "/phone-verification" }); }
  if (u.pathname === "/api/accounts/phone-otp/validate") { assert.equal(body.code, "654321"); return json({ continue_url: callback }); }
  if (u.pathname === "/oauth/token") return json({ access_token: accessToken, refresh_token: "fixture-refresh", id_token: jwt({ email, sub: "user", sid: "personal", "https://api.openai.com/auth": { chatgpt_plan_type: "free" } }) });
  json({ error: "unexpected route" }, 404);
});
async function listen(s) { do { await new Promise(r => s.listen(0, "127.0.0.1", r)); if (s.address().port > 10080) return s.address().port; await new Promise(r => s.close(r)); } while (true); }
upstreamBase = `http://127.0.0.1:${await listen(upstream)}`;
const socket = http.createServer(), port = await listen(socket); await new Promise(r => socket.close(r)); const base = `http://127.0.0.1:${port}`;
const wait = async fn => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const v = await fn().catch(() => null); if (v) return v; await new Promise(r => setTimeout(r, 40)); } throw Error("real OAuth/SMS fixture timed out\n" + logs); };
try {
  await fs.mkdir(dir); await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: "failed", result_saved: false, created_at: "2026-11-01T00:00:00Z", last_error: "fixture previous OAuth failure" }));
  const identity = await getAccountBrowserIdentity(email, { root: path.join(root, "browser-identities") });
  await writeAccountWebSession(path.join(dir, "web-session.json"), { email, identity, accessToken, web: { workspaceId: "personal" }, cookies: [{ name: "__Secure-next-auth.session-token", value: "fixture-web", domain: "127.0.0.1", path: "/", hostOnly: true }] });
  await createCredentialStore({ windowsRoot: path.join(root, "toSub2", "credentials"), linuxRoot: path.join(root, "credentials"), linuxKey: "ab".repeat(32) }).save(email, { password: "Fixture-Password-123!", totpSecret: "JBSWY3DPEHPK3PXP" });
  helper = spawn(process.execPath, [process.env.OAUTH_SMS_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: project, windowsHide: true, env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root,
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"),
      CHATGPT_BASE: upstreamBase, AUTH_BASE: upstreamBase, TOSUB2_TEST_SENTINEL_TOKEN: "fixture", SMSBOWER_API_BASE: upstreamBase + "/sms", SMS_POLL_INTERVAL_MS: "20", SMS_POLL_TIMEOUT_MS: "3000", SUB2API_MONITOR_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  helper.stdout.on("data", d => logs += d); helper.stderr.on("data", d => logs += d);
  const b = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; }); headers = { "x-console-token": b.token, "content-type": "application/json" };
  const post = async (route, body) => { const r = await fetch(base + route, { method: "POST", headers, body: JSON.stringify(body) }); const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d)); return d; };
  await post("/api/sms-provider-settings", { settings: { selectedProviderId: "smsbower", autoAcquire: true, configs: { smsbower: { apiKey: "fixture-sms-key", service: "dr", country: "1001", maxPrice: "0.42" } } } });
  await post(`/api/jobs/${id}/retry`, {});
  const completed = await wait(async () => { const d = await fetch(base + "/api/jobs", { headers }).then(r => r.json()); const j = d.jobs.find(j => j.id === id); if (j.status === "failed") throw Error(j.lastError); return j.status === "completed" && j; });
  assert.equal(completed.smsStatus, "completed"); assert.equal(smsCount, 2);
  assert.equal(completed.securityState.passwordEnabled, true, "successful password login evidence was not recorded");
  assert.equal(completed.securityState.totpEnabled, true, "successful MFA evidence was not recorded");
  const monitor = JSON.parse(await fs.readFile(path.join(root, "web-session-monitor.json"), "utf8"));
  assert.equal(monitor.accounts[email].status, "pending_check", "post-OAuth inspection was not made due");
  assert.equal(calls.filter(p => p === "/oauth/authorize").length, 1); assert(!calls.includes("/api/auth/signin/openai"));
  for (const route of ["/api/accounts/authorize/continue", "/api/accounts/password/verify", "/api/accounts/mfa/verify", "/api/accounts/add-phone/send", "/api/accounts/phone-otp/validate", "/oauth/token"]) assert(calls.includes(route), route);
  const exportData = JSON.parse(await fs.readFile(path.join(dir, "sub2api-import-oauth.json"), "utf8")); assert.equal(exportData.accounts[0].credentials.email, email);
  const protocolLog = (await fetch(base + `/api/jobs/${id}/logs`, { headers }).then(r => r.json())).logs;
  assert(protocolLog.includes("[codex-auth-login]") && protocolLog.includes("自动取号"));
  for (const secret of ["Fixture-Password-123!", "JBSWY3DPEHPK3PXP", "fixture-sms-key"]) assert(!protocolLog.includes(secret) && !logs.includes(secret));
  console.log("REAL_OAUTH_SMS_HTTP_PASS verified saved Web -> same OAuth state -> password+TOTP -> add_phone -> automatic SMSBower purchase/poll/submit -> validated callback/token export; first phone HTTP400 risk rejection -> release and automatic second purchase; password/MFA confirmed; post-OAuth inspection due; no Web relogin or credential logs");
} catch (error) {
  if (headers) {
    const data = await fetch(base + "/api/jobs", { headers }).then(r => r.json()).catch(() => null);
    const j = data?.jobs?.find(j => j.id === id);
    const protocolLog = await fetch(base + `/api/jobs/${id}/logs`, { headers }).then(r => r.json()).catch(() => null);
    error.message += "\n" + JSON.stringify({ calls, smsCount, status: j?.status, prompt: j?.prompt, lastError: j?.lastError, protocolLog });
  }
  throw error;
} finally {
  if (helper?.exitCode === null) { const done = new Promise(r => helper.once("exit", r)); helper.kill("SIGTERM"); await done; }
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); await fs.rm(root, { recursive: true, force: true });
}
