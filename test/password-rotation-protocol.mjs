import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
import { readCredentialHistory } from "../src/account-history.mjs";
import { CookieJar, ProtocolClient, addChatgptPassword, replaceChatgptPassword } from "../src/protocol-login.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "password-rotation-"));
const email = "password-rotation@example.test", oldPassword = "Old-Fixture-Pass-123!", password = "New-Fixture-Pass-234!";
const totpSecret = "JBSWY3DPEHPK3PXP";
const identityRoot = path.join(root, "identities"), identity = await getAccountBrowserIdentity(email, { root: identityRoot });
const token = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
let mode, resultPath, routes = [], mutationChecks = 0, cookieChecks = 0;
const json = (res, data, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(data)); };
const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString(), url = new URL(req.url, base); routes.push(url.pathname);
  if (url.pathname === "/api/auth/session") {
    cookieChecks++;
    if (mode === "cli-retain-web" && routes.includes("/api/accounts/password/reset")) return json(res, {}, 401);
    return json(res, { user: { email }, accessToken: token, expires: "2030-01-01T00:00:00Z" });
  }
  if (url.pathname === "/api/auth/csrf") return json(res, { csrfToken: "fixture-csrf" });
  if (url.pathname === "/api/auth/signin/openai") {
    if (mode.startsWith("add-")) {
      assert.equal(url.searchParams.get("post_login_add_password"), "true");
      assert.equal(url.searchParams.has("post_login_password_reset"), false);
      return json(res, { url: base + "/add-authorize" });
    }
    assert.equal(url.searchParams.get("post_login_password_reset"), "true");
    assert.equal(url.searchParams.has("post_login_add_password"), false);
    assert.equal(url.searchParams.get("max_age"), "0");
    assert.equal(url.searchParams.get("login_hint"), email);
    if (mode === "recent-auth") return json(res, { error: { code: "recent_auth_required", message: "recent_auth_required" } }, 401);
    return json(res, { url: base + "/rotate-authorize" });
  }
  if (url.pathname === "/add-authorize") return redirect(res, base + "/reset-password/new-password");
  if (url.pathname === "/rotate-authorize") return redirect(res, base + (mode === "direct" ? "/reset-password/new-password" : "/log-in/password"));
  if (["/log-in/password", "/email-verification", "/reset-password/new-password"].includes(url.pathname)) return res.end("<html><title>Account verification</title></html>");
  if (url.pathname === "/api/accounts/password/verify") {
    assert.equal(JSON.parse(body).password, oldPassword);
    if (["mfa", "cli-mfa"].includes(mode)) return json(res, { continue_url: base + "/mfa-challenge/fixture-factor", page: { type: "mfa_challenge" },
      "oai-client-auth-session": { mfa_challenge_factors: [{ factor_type: "totp", id: "fixture-factor" }] } });
    return json(res, { continue_url: base + (mode === "email" ? "/email-verification" : "/reset-password/new-password") });
  }
  if (url.pathname === "/api/accounts/mfa/issue_challenge") return json(res, { success: true });
  if (url.pathname === "/api/accounts/mfa/verify") {
    const p = JSON.parse(body); assert.equal(p.type, "totp"); assert.equal(p.id, "fixture-factor"); assert.match(p.code, /^\d{6}$/);
    return json(res, { continue_url: base + "/reset-password/new-password" });
  }
  if (url.pathname === "/api/accounts/email-otp/validate") { assert.equal(JSON.parse(body).code, "123456"); return json(res, { continue_url: base + "/reset-password/new-password" }); }
  if (url.pathname === "/api/accounts/password/add") {
    assert.equal(JSON.parse(body).password, password);
    const events = await readCredentialHistory(path.dirname(resultPath));
    assert(events.some(e => e.stage === "submission_pending" && e.before.password === oldPassword
      && e.after.password === password && e.after.operation === "add_password"), "addition happened before durable original/candidate history");
    assert.equal(JSON.parse(await fs.readFile(resultPath, "utf8")).activation_succeeded, false);
    if (mode === "add-business-false") return json(res, { success: false, continue_url: base + "/web-callback", page: { type: "external_url" } });
    if (mode === "add-http200-login") return json(res, { continue_url: base + "/log-in/password", page: { type: "password_verify" } });
    if (mode === "add-foreign-completion") return json(res, { continue_url: "https://example.invalid/", page: { type: "external_url" } });
    if (mode === "add-lost-response") return req.socket.destroy();
    if (mode === "add-success-route") return json(res, { continue_url: base + "/reset-password/success", page: { type: "reset_password_success" } });
    return json(res, { continue_url: base + "/web-callback", page: { type: "external_url" } });
  }
  if (url.pathname === "/api/accounts/password/reset") {
    assert.equal(JSON.parse(body).password, password);
    assert.equal(JSON.parse(req.headers["openai-sentinel-token"]).flow, "password_reset");
    const events = await readCredentialHistory(path.dirname(resultPath));
    assert(events.some(e => e.stage === "submission_pending" && e.before.password === oldPassword && e.after.password === password), "remote mutation happened before durable candidate history");
    assert.equal(JSON.parse(await fs.readFile(resultPath, "utf8")).stage, "submission_pending");
    mutationChecks++;
    if (mode === "business-false") return json(res, { success: false });
    if (mode === "http200-login") return json(res, { continue_url: base + "/log-in/password", page: { type: "password_verify" } });
    if (mode === "foreign-completion") return json(res, { continue_url: "https://example.invalid/", page: { type: "external_url" } });
    if (mode === "lost-response") return req.socket.destroy();
    if (mode === "echo-error") return json(res, { error: { message: password + " / " + oldPassword } }, 400);
    return json(res, { continue_url: base + "/reset-password/success", page: { type: "reset_password_success" } });
  }
  return json(res, { error: "unexpected route" }, 404);
});
let base;
do { await new Promise(r => server.listen(0, "127.0.0.1", r)); if (server.address().port > 10080) break; await new Promise(r => server.close(r)); } while (true);
base = `http://127.0.0.1:${server.address().port}`;
const oldEnv = Object.fromEntries(["NODE_ENV", "TOSUB2_TEST_SENTINEL_TOKEN"].map(k => [k, process.env[k]]));
process.env.NODE_ENV = "test"; process.env.TOSUB2_TEST_SENTINEL_TOKEN = "fixture";
try {
  for (mode of ["add-success-callback", "add-success-route", "add-business-false", "add-http200-login", "add-foreign-completion", "add-lost-response"]) {
    routes = []; const dir = path.join(root, mode); await fs.mkdir(dir); resultPath = path.join(dir, "password-result.json");
    const client = new ProtocolClient({ jar: new CookieJar(), browserIdentity: identity });
    const action = addChatgptPassword(client, { chatgptBase: base, authBase: base, email, rl: { question: async () => "123456" },
      deviceId: identity.deviceId, password, previousPassword: oldPassword, resultPath });
    if (mode.startsWith("add-success-")) {
      const result = await action; assert.equal(result.operation, "add_password"); assert.equal(result.stage, "confirmed");
      assert.equal(result.activation_succeeded, true); assert.equal(result.confirmation_succeeded, true);
    } else {
      await assert.rejects(action, e => e.message.startsWith("ADD_PASSWORD_SUBMISSION_UNCONFIRMED:")
        && !e.message.includes(password) && !e.message.includes(oldPassword)
        && !/PROXY_RISK_CONTROL|PROXY_CONNECTION_RETRY/.test(e.message));
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      assert.equal(result.operation, "add_password"); assert.equal(result.stage, "submission_unconfirmed");
      assert.equal(result.activation_succeeded, false); assert.equal(result.confirmation_succeeded, false);
      assert.equal(result.password, password); assert.equal(result.previous_password, oldPassword);
      assert.equal(result.added_at, undefined);
      const events = await readCredentialHistory(dir);
      assert(events.some(e => e.stage === "submission_pending")); assert(events.some(e => e.stage === "submission_unconfirmed"));
    }
  }
  console.log("PASSWORD_ADD_CONFIRMATION_PASS explicit callback/success-route; HTTP200-login/business-false/foreign/lost-response rejected; fsync candidate retained");
  for (mode of ["direct", "password", "mfa", "email", "recent-auth", "business-false", "http200-login", "foreign-completion", "lost-response", "echo-error"]) {
    routes = []; const dir = path.join(root, mode); await fs.mkdir(dir); resultPath = path.join(dir, "password-result.json");
    const client = new ProtocolClient({ jar: new CookieJar(), browserIdentity: identity });
    const action = replaceChatgptPassword(client, { chatgptBase: base, authBase: base, email, rl: { question: async () => "123456" }, deviceId: identity.deviceId, password, previousPassword: oldPassword, totpSecret, resultPath });
    if (["direct", "password", "mfa", "email"].includes(mode)) {
      const result = await action; assert.equal(result.stage, "confirmed"); assert.equal(result.activation_succeeded, true);
      assert.equal(result.password, password); assert.equal(result.previous_password, oldPassword);
    } else {
      await assert.rejects(action, e => !e.message.includes(password) && !e.message.includes(oldPassword)
        && (mode === "recent-auth" || e.message.startsWith("PASSWORD_REPLACE_SUBMISSION_UNCONFIRMED:"))
        && !/PROXY_RISK_CONTROL|PROXY_CONNECTION_RETRY/.test(e.message));
      const result = JSON.parse(await fs.readFile(resultPath, "utf8")); assert.equal(result.activation_succeeded, false); assert.equal(result.password, password);
      assert.equal(result.stage, mode === "recent-auth" ? "verification_failed" : "submission_unconfirmed");
      if (mode === "recent-auth") assert(!routes.includes("/api/accounts/password/reset"));
    }
  }
  for (mode of ["cli-mfa", "cli-retain-web"]) {
    routes = []; const dir = path.join(root, mode); await fs.mkdir(dir); resultPath = path.join(dir, "password-result.json");
    const web = path.join(dir, "web-session.json"), oauth = path.join(dir, "oauth.json");
    await fs.writeFile(oauth, "original OAuth bytes");
    await writeAccountWebSession(web, { email, identity, accessToken: token, expiresAt: "2030-01-01T00:00:00Z", web: {},
      cookies: [{ name: "fixture-session", value: "original-session", domain: "127.0.0.1", path: "/", hostOnly: true }] });
    const original = await fs.readFile(web, "utf8");
    const child = spawn(process.execPath, ["src/protocol-login.mjs", "--replace-password", "--email", email, "--password-add-result", resultPath,
      "--sub2api-out", oauth, "--chatgpt-base", base, "--auth-base", base, "--native-http", "--verbose"], {
      cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true, env: { ...process.env, CHATGPT_LOGIN_PASSWORD: oldPassword, CHATGPT_NEW_PASSWORD: password,
        CHATGPT_TOTP_SECRET: totpSecret, TOSUB2_WEB_SESSION_PATH: web, TOSUB2_BROWSER_IDENTITY_ROOT: identityRoot, CHATGPT_PROXY_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", d => output += d); child.stderr.on("data", d => output += d);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000); const code = await new Promise(r => child.once("close", r)); clearTimeout(timer);
    assert.equal(code, 0, output); assert.match(output, /Reused saved Web session/); assert.match(output, /Account password changed and saved securely/);
    assert(!output.includes(password) && !output.includes(oldPassword), "password leaked to CLI output");
    assert.equal(await fs.readFile(oauth, "utf8"), "original OAuth bytes");
    if (mode === "cli-retain-web") assert.equal(await fs.readFile(web, "utf8"), original, "unverified post-change jar overwrote retained Web credentials");
  }
  assert(mutationChecks >= 10); assert(cookieChecks >= 4);
  console.log("PASSWORD_ROTATION_PROTOCOL_PASS official reset entry; direct/password/MFA/email verification; before-submit fsync history; strict completion; uncertain-response candidate; secret-redacted errors; saved-Web reuse; failed post-change session preservation; OAuth unchanged");
} finally {
  for (const [k, v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true });
}
