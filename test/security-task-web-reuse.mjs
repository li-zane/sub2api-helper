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
const baseline = process.argv.includes("--baseline");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-security-web-reuse-"));
const email = "security-task@example.test";
const identityRoot = path.join(root, "identities");
const identity = await getAccountBrowserIdentity(email, { root: identityRoot });
const token = `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
const candidate = "MZXW6YTBON2GK3TB";
let scenario, requests, enabled, activated, freshLogins, passwordReauth;
const json = (res, value, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const server = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, base);
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/") {
      res.setHeader("set-cookie", "__Host-next-auth.csrf-token=fixture-csrf; Path=/");
      return res.end('<html><script>window.__INITIAL_STATE__={"accessToken":"fixture-access-token"}</script></html>');
    }
    if (url.pathname === "/api/auth/providers") return json(res, {});
    if (url.pathname === "/api/auth/csrf") return json(res, { csrfToken: "fixture-csrf" });
    if (url.pathname === "/api/auth/signin/openai") {
      if (url.searchParams.get("post_login_add_password") === "true") {
        passwordReauth++;
        assert.match(req.headers.cookie || "", /retained-session=original/);
        return json(res, { url: base + "/reset-password/new-password" });
      }
      freshLogins++;
      // Make the old bug deterministic: a fresh sign-in cannot continue without
      // email OTP, while the retained authenticated session works without it.
      return json(res, { error: { code: "fresh_login_requires_email_otp" } }, 401);
    }
    assert.match(req.headers.cookie || "", /retained-session=original/);
    assert.equal(req.headers["oai-device-id"], identity.deviceId);
    assert.equal(req.headers["oai-session-id"], identity.sessionId);
    if (url.pathname === "/api/auth/session") {
      if (scenario === "transient") return json(res, {}, 503);
      if (scenario === "html") return res.end("<html>challenge</html>");
      if (scenario === "expired" || (scenario === "post-change-expired" && activated)) return json(res, {}, 401);
      res.setHeader("set-cookie", "renewed-session=next; Path=/");
      return json(res, { user: { email: scenario === "wrong-account" ? "other@example.test" : email }, accessToken: token });
    }
    if (url.pathname === "/backend-api/accounts/mfa_info") {
      if (scenario === "recent-auth") return json(res, { error: { code: "recent_auth_required" } }, 401);
      return json(res, { mfa_enabled: enabled, mfa_enabled_v2: enabled,
        factors: { totp: enabled ? [{ id: activated ? "new-factor" : "old-factor", factor_type: "totp" }] : [], push_auth: null } });
    }
    if (url.pathname === "/backend-api/accounts/mfa/user/disable_in_house") {
      assert.equal(JSON.parse(body).factor_id, "old-factor"); enabled = false;
      res.writeHead(204); return res.end();
    }
    if (url.pathname === "/backend-api/accounts/mfa/enroll") {
      assert.equal(enabled, false);
      return json(res, { secret: candidate, session_id: "enroll-session", factor: { id: "new-factor", factor_type: "totp" } });
    }
    if (url.pathname === "/backend-api/accounts/mfa/user/activate_enrollment") {
      assert.match(JSON.parse(body).code, /^\d{6}$/);
      if (scenario === "activation-failed") return json(res, { error: { code: "upstream_unavailable" } }, 503);
      enabled = true; activated = true; return json(res, { success: true });
    }
    if (url.pathname === "/reset-password/new-password") return res.end("<html>New password</html>");
    if (url.pathname === "/api/accounts/password/add") {
      assert.equal(JSON.parse(body).password, "Fixture-New-Password-123!");
      return json(res, { continue_url: base + "/reset-password/success", page: { type: "reset_password_success" } });
    }
    return json(res, { error: "unexpected route" }, 404);
  } catch (error) { json(res, { fixtureError: error.message }, 500); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function run(name, kind = "replace", { checkpoint = false, session = true, incomplete = false } = {}) {
  scenario = name; requests = []; freshLogins = 0; passwordReauth = 0; activated = false;
  enabled = kind === "replace" && !incomplete;
  const dir = path.join(root, name); await fs.mkdir(dir);
  const file = path.join(dir, "web-session.json"), resultFile = path.join(dir, "result.json"), oauth = path.join(dir, "oauth.json");
  await fs.writeFile(oauth, "retained OAuth bytes");
  if (session) await writeAccountWebSession(file, { email, identity, accessToken: token, web: { workspaceId: "original-workspace" },
    cookies: [{ name: "retained-session", value: "original", domain: "127.0.0.1", path: "/", hostOnly: true }] });
  const original = session ? await fs.readFile(file, "utf8") : null;
  if (incomplete) await fs.writeFile(resultFile, JSON.stringify({ version: 1, operation: "replace_totp", email,
    stage: "disabling", remote_disabled: false, activation_succeeded: false }));
  const args = [protocol, "--email", email, kind === "add" ? "--add-password" : kind === "setup" ? "--setup-totp" : "--replace-totp",
    kind === "add" ? "--password-add-result" : "--totp-result", resultFile,
    "--sub2api-out", oauth, "--chatgpt-base", base, "--auth-base", base, "--native-http"];
  if (checkpoint) {
    const cp = path.join(dir, "checkpoint.json");
    await fs.writeFile(cp, JSON.stringify({ version: 1, stage: "phone_required", email,
      cookies: session ? [{ name: "stale-checkpoint", value: "old", domain: "127.0.0.1", path: "/", hostOnly: true }]
        : [{ name: "retained-session", value: "original", domain: "127.0.0.1", path: "/", hostOnly: true }],
      web: { deviceId: identity.deviceId } }));
    args.push("--resume-checkpoint", cp);
  }
  const child = spawn(process.execPath, args, { cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", CHATGPT_LOGIN_PASSWORD: "", CHATGPT_TOTP_SECRET: "",
      CHATGPT_NEW_PASSWORD: "Fixture-New-Password-123!", TOSUB2_TEST_SENTINEL_TOKEN: "fixture",
      TOSUB2_WEB_SESSION_PATH: file, TOSUB2_BROWSER_IDENTITY_ROOT: identityRoot, CHATGPT_PROXY_URL: "" } });
  let output = ""; child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => output += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); clearTimeout(timer);
  assert.equal(await fs.readFile(oauth, "utf8"), "retained OAuth bytes");
  assert(!output.includes(candidate), "candidate key leaked to process output");
  return { code, output, original, file, resultFile, dir };
}

try {
  if (baseline) {
    const result = await run("baseline");
    assert.equal(freshLogins, 1, result.output); assert.notEqual(result.code, 0, result.output);
    assert.equal(await fs.readFile(result.file, "utf8"), result.original);
    console.log("BASELINE_SECURITY_WEB_REUSE_REPRODUCED valid_saved_session_ignored=true fresh_login_requests=1 email_otp_required=true retained_session_unchanged=true");
    process.exitCode = 1;
  } else {
    for (const kind of ["setup", "replace", "add"]) {
      const result = await run(`valid-${kind}`, kind);
      assert.equal(result.code, 0, result.output); assert.match(result.output, /Reused saved Web session/);
      assert.equal(freshLogins, 0); assert.equal(passwordReauth, kind === "add" ? 1 : 0);
      const saved = JSON.parse(await fs.readFile(result.file, "utf8"));
      assert(saved.cookies.some(cookie => cookie.name === "renewed-session"));
      assert.equal(saved.identity.deviceId, identity.deviceId); assert.equal(saved.web.workspaceId, "original-workspace");
      const events = await readCredentialHistory(result.dir);
      assert(events.some(event => event.type === (kind === "add" ? "password" : "2fa") && event.after?.activation_succeeded === true));
    }
    for (const name of ["resume-disabled", "prefer-canonical", "checkpoint-only"]) {
      const result = await run(name, "replace", { incomplete: name === "resume-disabled", checkpoint: name !== "resume-disabled", session: name !== "checkpoint-only" });
      assert.equal(result.code, 0, result.output); assert.equal(freshLogins, 0);
      if (name === "resume-disabled") assert(!requests.some(route => route.includes("disable_in_house")));
      if (name === "prefer-canonical") assert.match(result.output, /Reused saved Web session/);
    }
    for (const name of ["transient", "html", "wrong-account", "recent-auth", "activation-failed"]) {
      const result = await run(name);
      assert.notEqual(result.code, 0, result.output); assert.equal(freshLogins, 0);
      assert.equal(await fs.readFile(result.file, "utf8"), result.original, `${name} replaced retained Web session`);
      if (name !== "activation-failed") assert(!requests.some(route => /disable_in_house|mfa\/enroll/.test(route)));
      else assert.equal(JSON.parse(await fs.readFile(result.resultFile, "utf8")).secret, candidate);
    }
    const expired = await run("expired");
    assert.notEqual(expired.code, 0); assert.equal(freshLogins, 1);
    assert.equal(await fs.readFile(expired.file, "utf8"), expired.original);
    const noSession = await run("no-session", "replace", { session: false });
    assert.notEqual(noSession.code, 0); assert.equal(freshLogins, 1);
    const postChange = await run("post-change-expired");
    assert.equal(postChange.code, 0, postChange.output); assert.equal(freshLogins, 0);
    assert.equal(await fs.readFile(postChange.file, "utf8"), postChange.original);
    assert.equal(JSON.parse(await fs.readFile(postChange.resultFile, "utf8")).activation_succeeded, true);
    console.log("SECURITY_TASK_WEB_REUSE_PASS 14/14: setup/replace TOTP and add-password reuse retained cookies/device; disabled rotation resumes; valid Web precedes stale checkpoint; checkpoint fallback retained; only confirmed expiry/missing session signs in; transient/identity/recent-auth errors never restart login; failed mutations preserve Web/OAuth and candidate history; unverified post-change session never replaces retained session");
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(root);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("helper-security-web-reuse-"));
  await fs.rm(resolved, { recursive: true, force: true });
}
