import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";
import { readCredentialHistory } from "../src/account-history.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const protocol = process.env.SECURITY_TASK_PROTOCOL || path.join(projectRoot, "src/protocol-login.mjs");
const selected = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-security-reauth-"));
const email = "rotation-reauth@example.test";
const oldPassword = "Old-Fixture-Pass-123!", password = "New-Fixture-Pass-234!";
const oldKey = "JBSWY3DPEHPK3PXP", newKey = "MZXW6YTBON2GK3TB";
const identityRoot = path.join(root, "identities");
const identity = await getAccountBrowserIdentity(email, { root: identityRoot });
const token = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
};
const redirect = (res, location) => { res.writeHead(302, { location }); res.end(); };
const cases = [
  { name: "totp-disable", success: true },
  { name: "totp-info", success: true },
  { name: "totp-enroll", success: true },
  { name: "totp-activate", success: true },
  { name: "totp-checkpoint", success: true },
  { name: "totp-checkpoint-rejected", success: false },
  { name: "totp-repeated", success: false },
  { name: "totp-generic-401", success: false, noReauth: true },
  { name: "totp-503", success: false, noReauth: true },
  { name: "totp-wrong-account", success: false },
  { name: "password-entry", password: true, success: true },
  { name: "password-reset", password: true, success: true },
  { name: "password-repeated", password: true, success: false },
  { name: "password-generic-401", password: true, success: false, noReauth: true },
  { name: "password-lost-response", password: true, success: false, noReauth: true },
];
let state, base;
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(), url = new URL(req.url, base);
    const current = state, cookie = req.headers.cookie || "";
    current.routes.push(url.pathname);
    assert.match(cookie, /retained-session=original/, "reauthentication discarded the original cookie jar");
    assert.equal(req.headers["oai-device-id"], identity.deviceId);
    assert.equal(req.headers["oai-session-id"], identity.sessionId);
    const recent = cookie.includes("fresh-session=verified");
    const rejectReauth = () => json(res, { detail: "User must re-authenticate to enroll/disable a factor" }, 401);
    if (url.pathname === "/") {
      res.setHeader("set-cookie", "__Host-next-auth.csrf-token=fixture-csrf; Path=/");
      return res.end('<html><script>window.__INITIAL_STATE__={"accessToken":"fixture-access-token"}</script></html>');
    }
    if (url.pathname === "/api/auth/providers") return json(res, {});
    if (url.pathname === "/api/auth/csrf") return json(res, { csrfToken: "fixture-csrf" });
    if (url.pathname === "/api/auth/session") {
      const account = current.name === "totp-wrong-account" && recent ? "other@example.test" : email;
      return json(res, { user: { email: account }, accessToken: token });
    }
    if (url.pathname === "/api/auth/signin/openai") {
      assert.equal(url.searchParams.get("login_hint"), email);
      if (url.searchParams.get("post_login_password_reset") === "true") {
        current.passwordEntries++;
        assert.equal(url.searchParams.get("max_age"), "0");
        if (current.name === "password-entry" && !recent) return json(res, { error: { code: "recent_auth_required" } }, 401);
        return json(res, { url: base + "/reset-password/new-password" });
      }
      current.reauth++;
      assert.equal(url.searchParams.get("prompt"), "login");
      assert.equal(url.searchParams.get("max_age"), "0", "reauthentication must request a fresh verification");
      assert.equal(url.searchParams.has("post_login_add_password"), false);
      if (current.name === "totp-checkpoint-rejected") return json(res, { error: { code: "invalid_state" } }, 401);
      return json(res, { url: base + "/log-in/password" });
    }
    if (url.pathname === "/log-in/password") return res.end('<html><input type="password"></html>');
    if (url.pathname === "/api/accounts/password/verify") {
      current.passwordChecks++;
      assert.equal(JSON.parse(body).password, oldPassword);
      if (!current.enabled) return json(res, { continue_url: base + "/api/auth/callback/openai" });
      return json(res, { continue_url: base + "/mfa-challenge/old-factor", page: { type: "mfa_challenge" },
        "oai-client-auth-session": { mfa_challenge_factors: [{ factor_type: "totp", id: "old-factor" }] } });
    }
    if (url.pathname === "/api/accounts/mfa/issue_challenge") return json(res, { success: true });
    if (url.pathname === "/api/accounts/mfa/verify") {
      const data = JSON.parse(body); assert.equal(data.id, "old-factor"); assert.match(data.code, /^\d{6}$/);
      current.mfaChecks++; return json(res, { continue_url: base + "/api/auth/callback/openai" });
    }
    if (url.pathname === "/api/auth/callback/openai") {
      assert.equal(current.passwordChecks, 1);
      assert.equal(current.mfaChecks, current.enabled ? 1 : 0);
      res.setHeader("set-cookie", "fresh-session=verified; Path=/"); return redirect(res, base + "/");
    }
    if (url.pathname === "/backend-api/accounts/mfa_info") {
      if (current.name === "totp-info" && !recent) return json(res, { error: { code: "recent_auth_required" } }, 403);
      return json(res, { mfa_enabled: current.enabled, mfa_enabled_v2: current.enabled,
        factors: { totp: current.enabled ? [{ id: current.activated ? "new-factor" : "old-factor", factor_type: "totp" }] : [] } });
    }
    if (url.pathname === "/backend-api/accounts/mfa/user/disable_in_house") {
      current.disableAttempts++;
      if (current.name === "totp-generic-401") return json(res, { detail: "invalid_session" }, 401);
      if (current.name === "totp-503") return json(res, { detail: "temporarily_unavailable" }, 503);
      if (!recent && !["totp-enroll", "totp-activate"].includes(current.name) || current.name === "totp-repeated") return rejectReauth();
      assert.equal(JSON.parse(body).factor_id, "old-factor");
      current.enabled = false; current.disables++; res.writeHead(204); return res.end();
    }
    if (url.pathname === "/backend-api/accounts/mfa/enroll") {
      assert.equal(current.enabled, false);
      if (current.name === "totp-enroll" && !recent) return rejectReauth();
      current.enrolls++; return json(res, { secret: newKey, session_id: "enrollment-session" });
    }
    if (url.pathname === "/backend-api/accounts/mfa/user/activate_enrollment") {
      assert.match(JSON.parse(body).code, /^\d{6}$/);
      if (current.name === "totp-activate" && !recent) return rejectReauth();
      current.enabled = true; current.activated = true; current.mutations++;
      return json(res, { success: true });
    }
    if (url.pathname === "/reset-password/new-password") return res.end("<html>New password</html>");
    if (url.pathname === "/api/accounts/password/reset") {
      current.resetAttempts++;
      const candidate = JSON.parse(await fs.readFile(current.resultPath, "utf8"));
      assert.equal(candidate.stage, "submission_pending"); assert.equal(candidate.password, password);
      assert.equal(candidate.previous_password, oldPassword);
      assert.equal(JSON.parse(body).password, password);
      if (current.name === "password-generic-401") return json(res, { detail: "invalid_session" }, 401);
      if (current.name === "password-repeated" || current.name === "password-reset" && !recent) return rejectReauth();
      current.mutations++;
      if (current.name === "password-lost-response") return req.socket.destroy();
      return json(res, { continue_url: base + "/reset-password/success", page: { type: "reset_password_success" } });
    }
    return json(res, { error: "unexpected route" }, 404);
  } catch (error) {
    state.fixtureError = error;
    json(res, { fixtureError: error.message }, 500);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;

async function run(spec) {
  const directory = path.join(root, spec.name); await fs.mkdir(directory);
  const web = path.join(directory, "web-session.json"), oauth = path.join(directory, "oauth.json");
  const resultPath = path.join(directory, "result.json");
  const cookies = [{ name: "retained-session", value: "original", domain: "127.0.0.1", path: "/", hostOnly: true }];
  await fs.writeFile(oauth, "original OAuth bytes");
  await writeAccountWebSession(web, { email, identity, accessToken: token, web: { workspaceId: "original-workspace" }, cookies });
  const original = await fs.readFile(web, "utf8");
  state = { ...spec, resultPath, enabled: true, activated: false, reauth: 0, passwordChecks: 0, mfaChecks: 0,
    disableAttempts: 0, disables: 0, enrolls: 0, resetAttempts: 0, mutations: 0, passwordEntries: 0, routes: [] };
  const args = [protocol, "--email", email, spec.password ? "--replace-password" : "--replace-totp",
    spec.password ? "--password-add-result" : "--totp-result", resultPath, "--sub2api-out", oauth,
    "--chatgpt-base", base, "--auth-base", base, "--native-http", "--verbose"];
  if (spec.name.startsWith("totp-checkpoint")) {
    await fs.unlink(web);
    const checkpoint = path.join(directory, "checkpoint.json");
    await fs.writeFile(checkpoint, JSON.stringify({ version: 1, email, stage: "email_verified", cookies, web: { deviceId: identity.deviceId } }));
    args.push("--resume-checkpoint", checkpoint);
  }
  const child = spawn(process.execPath, args, { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", TOSUB2_TEST_SENTINEL_TOKEN: "fixture", CHATGPT_LOGIN_PASSWORD: oldPassword,
      CHATGPT_NEW_PASSWORD: password, CHATGPT_TOTP_SECRET: oldKey, TOSUB2_EMAIL_OTP_API_AVAILABLE: "0",
      TOSUB2_WEB_SESSION_PATH: web, TOSUB2_BROWSER_IDENTITY_ROOT: identityRoot, CHATGPT_PROXY_URL: "" } });
  let output = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  console.log(`SECURITY_REAUTH_CASE ${spec.name} exit=${code} reauth=${state.reauth} successful_mutations=${state.mutations}`);
  if (state.fixtureError) throw state.fixtureError;
  assert(![oldPassword, password, oldKey, newKey].some(secret => output.includes(secret)), "credential leaked to process output");
  assert.equal(await fs.readFile(oauth, "utf8"), "original OAuth bytes");
  assert.equal(code === 0, spec.success, output);
  assert.equal(state.reauth, spec.noReauth ? 0 : 1, output);
  const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
  if (spec.success) {
    assert.equal(state.mutations, 1); assert.equal(result.activation_succeeded, true);
    assert.equal(result.confirmation_succeeded, true);
    assert.equal(state.passwordChecks, 1); assert.equal(state.mfaChecks, ["totp-enroll", "totp-activate"].includes(spec.name) ? 0 : 1);
    if (spec.password) assert.equal(result.password, password);
    else {
      assert.equal(result.secret, newKey); assert.equal(state.disables, 1);
      assert.equal(state.disableAttempts, ["totp-enroll", "totp-activate", "totp-info"].includes(spec.name) ? 1 : 2);
    }
    const saved = JSON.parse(await fs.readFile(web, "utf8"));
    assert.deepEqual(saved.identity, identity);
    assert(saved.cookies.some(cookie => cookie.name === "fresh-session" && cookie.value === "verified"));
    const events = await readCredentialHistory(directory);
    assert(events.some(event => event.after?.activation_succeeded === true));
  } else {
    assert.equal(state.mutations, spec.name === "password-lost-response" ? 1 : 0);
    assert.equal(result.activation_succeeded, false);
    if (spec.name === "totp-checkpoint-rejected") await assert.rejects(fs.readFile(web, "utf8"), { code: "ENOENT" });
    else assert.equal(await fs.readFile(web, "utf8"), original, "failed operation overwrote retained Web credentials");
    if (spec.password) {
      assert.equal(result.password, password); assert.equal(result.previous_password, oldPassword);
      const ambiguous = ["password-generic-401", "password-lost-response"].includes(spec.name);
      assert.equal(result.stage, ambiguous ? "submission_unconfirmed" : "verification_failed");
      assert.equal(state.resetAttempts, spec.name === "password-repeated" ? 2 : 1);
      if (ambiguous) assert.match(output, /PASSWORD_REPLACE_SUBMISSION_UNCONFIRMED/);
    } else {
      assert.equal(state.enabled, true); assert.equal(state.disables, 0);
      assert.equal(state.disableAttempts, spec.name === "totp-repeated" ? 2 : 1);
      assert.equal(result.secret, undefined);
    }
  }
}

try {
  const targets = selected ? cases.filter(spec => spec.name === selected) : cases;
  assert(targets.length, "unknown test case");
  for (const spec of targets) await run(spec);
  console.log(`SECURITY_REAUTH_PASS ${targets.length}/${targets.length}: TOTP/password fresh verification; one retry; same browser; partial TOTP recovery; rejected/ambiguous mutations preserve credentials`);
} finally {
  await new Promise(resolve => server.close(resolve));
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(root, { recursive: true, force: true });
}
