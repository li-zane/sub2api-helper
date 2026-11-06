import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-password-fallback-"));
const oldEnv = Object.fromEntries(["NODE_ENV", "TOSUB2_TEST_SENTINEL_TOKEN", "TOSUB2_EMAIL_OTP_API_AVAILABLE"].map(k => [k, process.env[k]]));
process.env.NODE_ENV = "test"; process.env.TOSUB2_TEST_SENTINEL_TOKEN = "fixture"; delete process.env.TOSUB2_EMAIL_OTP_API_AVAILABLE;
const { ProtocolClient, CookieJar, loginChatgptWeb } = await import(pathToFileURL(process.env.WEB_PASSWORD_FALLBACK_PROTOCOL || path.resolve("src/protocol-login.mjs")).href);
const identity = await getAccountBrowserIdentity("fallback@example.test", { root: root + "/identities" });
const originalLog = console.log; let output = ""; console.log = (...args) => { output += args.join(" ") + "\n"; };
let mode = "success", requests = [], prompts = [], foreignRequests = 0, base, foreignBase, emailIssuedAt;
const json = (res, data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
const html = (res, text) => { res.setHeader("content-type", "text/html"); res.end(text); };
const callback = () => ({ continue_url: base + "/web-callback" });
const mfa = () => ({ page: { type: "mfa_challenge" }, continue_url: base + "/mfa-challenge/factor", "oai-client-auth-session": { mfa_challenge_factors: [{ factor_type: "totp", id: "factor" }] } });
const foreign = http.createServer((req, res) => { foreignRequests++; html(res, '<input type="password">'); });
await new Promise(r => foreign.listen(0, "127.0.0.1", r)); foreignBase = `http://127.0.0.1:${foreign.address().port}`;
const server = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  const p = new URL(req.url, base).pathname; requests.push({ method: req.method, path: p, body, cookie: req.headers.cookie, device: req.headers["oai-device-id"], session: req.headers["oai-session-id"] });
  if (p === "/") { res.setHeader("set-cookie", ["__Host-next-auth.csrf-token=fixture; Path=/", "retained=original; Path=/"]); return html(res, "<html>Home</html>"); }
  if (p === "/api/auth/providers") return json(res, {});
  if (p === "/api/auth/csrf") return json(res, { csrfToken: "fixture" });
  if (p === "/api/auth/signin/openai") { res.setHeader("set-cookie", "auth-context=unchanged; Path=/"); return json(res, { url: base + "/oauth/authorize" }); }
  if (p === "/oauth/authorize") { res.writeHead(302, { location: mode === "direct" ? base + "/log-in/password" : base + "/email-verification" }); return res.end(); }
  if (p === "/email-verification") {
    if (emailIssuedAt) await delay(25);
    return html(res, mode === "initial-challenge" ? '<title>Just a moment...</title><form id="challenge-form"></form>' : '<title>Check inbox</title><input name="code"><script src="/cdn-cgi/challenge-platform/script.js"></script>');
  }
  if (p === "/log-in/password") {
    if (mode === "mandatory") { res.writeHead(302, { location: base + "/email-verification" }); return res.end(); }
    if (mode === "missing") return json(res, {}, 404);
    if (mode === "external") { res.writeHead(302, { location: foreignBase + "/log-in/password" }); return res.end(); }
    return html(res, mode === "unconfirmed" ? "<title>Unknown</title>" : mode === "password-challenge" ? '<title>Just a moment...</title><form id="challenge-form"></form>' : '<title>Enter password</title><input type="password" name="password"><script src="/cdn-cgi/challenge-platform/script.js"></script>');
  }
  if (p === "/api/accounts/password/verify") {
    assert.equal(JSON.parse(body).password, "Fixture-Password!");
    if (mode === "post-password-email" || mode === "post-password-email-mfa") { emailIssuedAt = Date.now(); return json(res, { continue_url: base + "/email-verification" }); }
    return json(res, ["totp", "post-mfa-email"].includes(mode) ? mfa() : callback());
  }
  if (p === "/api/accounts/mfa/issue_challenge") return json(res, {});
  if (p === "/api/accounts/mfa/verify") { assert.match(JSON.parse(body).code, /^\d{6}$/); if (mode === "post-mfa-email") emailIssuedAt = Date.now(); return json(res, mode === "post-mfa-email" ? { continue_url: base + "/email-verification" } : callback()); }
  if (p === "/api/accounts/email-otp/validate") {
    assert.equal(JSON.parse(body).code, "123456");
    return json(res, mode === "post-password-email-mfa" ? mfa() : mode === "repeat-email" ? { continue_url: base + "/email-verification" } : callback());
  }
  if (p === "/web-callback") return html(res, "<title>Signed in</title>");
  return json(res, {}, 404);
});
await new Promise(r => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${server.address().port}`;
const count = p => requests.filter(r => r.path === p).length;
let cases = 0;
async function run(scenario, extra = {}) {
  mode = scenario; requests = []; prompts = []; output = ""; emailIssuedAt = null;
  const client = new ProtocolClient({ browserIdentity: identity, jar: new CookieJar() });
  const web = await loginChatgptWeb(client, { chatgptBase: base, authBase: base, email: identity.email, password: "Fixture-Password!", totpSecret: "JBSWY3DPEHPK3PXP",
    rl: { question: async prompt => { prompts.push(prompt); assert.match(prompt, /Email OTP/); return "123456"; } }, ...extra });
  for (const r of requests) { assert.equal(r.device, identity.deviceId); assert.equal(r.session, identity.sessionId); if (r.path === "/log-in/password" || r.method === "POST" && r.path.includes("/api/accounts/")) assert.match(r.cookie, /auth-context=unchanged/); }
  assert.equal(client.jar.value("retained", base), "original");
  return web;
}
try {
  const original = "retained Web session and OAuth must not change"; await fs.writeFile(root + "/retained.json", original);
  if (process.argv.includes("--baseline")) {
    const web = await run("success", { emailOtpApiAvailable: false });
    assert.equal(web.loginMethod, "email_otp"); assert.equal(count("/log-in/password"), 0); assert.equal(prompts.length, 1);
    console.log = originalLog; console.log("BASELINE_WEB_PASSWORD_FALLBACK_REPRODUCED no_mail_API_and_password=true password_entry_attempts=0 email_OTP_prompts=1"); process.exitCode = 1;
  } else {
    let web = await run("success", { emailOtpApiAvailable: false }); assert.equal(web.loginMethod, "password"); assert.equal(count("/log-in/password"), 1); assert.equal(prompts.length, 0); assert.equal(count("/api/accounts/password/verify"), 1); cases++;
    assert(output.includes("[web-password-fallback]")); assert(!output.includes("Fixture-Password!"));
    web = await run("success", { emailOtpApiAvailable: true }); assert.equal(web.loginMethod, "email_otp"); assert.equal(count("/log-in/password"), 0); cases++;
    web = await run("success", { password: "", emailOtpApiAvailable: false }); assert.equal(web.loginMethod, "email_otp"); assert.equal(count("/log-in/password"), 0); cases++;
    process.env.TOSUB2_EMAIL_OTP_API_AVAILABLE = "1"; web = await run("success"); assert.equal(web.loginMethod, "email_otp"); cases++; delete process.env.TOSUB2_EMAIL_OTP_API_AVAILABLE;
    web = await run("direct"); assert.equal(web.loginMethod, "password"); assert.equal(count("/log-in/password"), 1); assert(!output.includes("[web-password-fallback]")); cases++;
    web = await run("mandatory"); assert.equal(web.loginMethod, "email_otp"); assert.equal(count("/log-in/password"), 1); assert.equal(prompts.length, 1); assert.equal(count("/api/accounts/password/verify"), 0); cases++;
    for (const scenario of ["missing", "unconfirmed", "initial-challenge", "password-challenge", "external"]) {
      await assert.rejects(run(scenario)); assert.equal(count("/api/accounts/password/verify"), 0); assert.equal(prompts.length, 0); assert(count("/log-in/password") <= 1); cases++;
    }
    assert.equal(foreignRequests, 0, "password fallback followed a different origin");
    web = await run("totp"); assert.equal(web.mfaVerified, true); assert.equal(count("/api/accounts/mfa/verify"), 1); cases++;
    for (const scenario of ["post-password-email", "post-password-email-mfa", "post-mfa-email"]) {
      web = await run(scenario); assert.equal(web.loginMethod, "password"); assert.equal(prompts.length, 1); assert.equal(count("/log-in/password"), 1); assert.equal(count("/api/accounts/password/verify"), 1);
      assert(Date.parse(/\[email-otp-requested-at\] (\S+)/.exec(output)[1]) <= emailIssuedAt, "mail polling watermark skipped the email issued before page navigation finished");
      if (scenario !== "post-password-email") assert.equal(web.mfaVerified, true); cases++;
    }
    await assert.rejects(run("repeat-email", { emailOtpApiAvailable: true }), /WEB_AUTH_VERIFICATION_INCOMPLETE/); assert.equal(count("/api/accounts/email-otp/validate"), 1); cases++;
    assert.equal(await fs.readFile(root + "/retained.json", "utf8"), original);
    console.log = originalLog; console.log(`WEB_PASSWORD_FALLBACK_PASS cases=${cases} conditional one-shot password entry; API/no-password skips; same cookies/device/state; confirmed form and origin; mandatory email/MFA retained; no challenge credential submission; errors bounded; retained file unchanged`);
  }
} finally {
  console.log = originalLog; for (const [k, v] of Object.entries(oldEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  server.closeAllConnections(); foreign.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => foreign.close(r))]);
  assert(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true });
}
