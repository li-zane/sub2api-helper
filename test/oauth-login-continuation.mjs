import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { ProtocolClient, CookieJar, runCodexOauth, resumeCodexOauth } = await import(pathToFileURL(path.resolve(process.env.OAUTH_TEST_PROTOCOL || "src/protocol-login.mjs")));
const baseline = process.argv.includes("--baseline"), email = "oauth-continuation@example.test";
let mode = "phone", state, callback, checkpoints, calls, base;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base), chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  calls.push({ path: url.pathname, body, method: req.method });
  const json = (d, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(d)); };
  const redirect = next => { res.writeHead(302, { location: next }); res.end(); };
  const outcome = () => mode === "phone" ? { continue_url: base + "/add-phone", page: { type: "add_phone" } }
    : mode === "choose-after-login" ? { continue_url: base + "/choose-an-account" }
    : mode === "workspace" ? { continue_url: base + "/consent", "oai-client-auth-session": { workspaces: [{ id: "fixture-workspace", structure: "personal", plan_type: "free" }] } }
    : { continue_url: callback };
  if (url.pathname === "/api/v1/admin/openai/generate-auth-url") return json({ data: { session_id: "fixture-provider-session", auth_url: base + "/oauth/authorize?" + new URLSearchParams({ state: "remote-state", client_id: "fixture", redirect_uri: "http://127.0.0.1:1455/auth/callback", response_type: "code", code_challenge: "challenge", code_challenge_method: "S256" }) } });
  if (url.pathname === "/oauth/authorize") {
    state = url.searchParams.get("state"); callback = url.searchParams.get("redirect_uri") + "?code=fixture-code&state=" + state;
    res.setHeader("set-cookie", "oauth-context=original; Path=/");
    if (mode === "existing") return res.end('<input name="session_id" value="us_fixture_existing">');
    return redirect(base + (mode === "direct-phone" ? "/add-phone" : mode === "direct-password" ? "/log-in/password" : "/log-in"));
  }
  if (url.pathname === "/choose-an-account") return res.end('<input name="session_id" value="us_after_login_session">');
  if (["/log-in", "/log-in/password", "/email-verification", "/add-phone"].includes(url.pathname)) return res.end("<html>fixture normal authentication page</html>");
  assert.match(req.headers.cookie || "", /oauth-context=original/, "original OAuth cookie context was lost");
  if (url.pathname === "/api/accounts/authorize/continue") {
    assert.deepEqual(body, { username: { kind: "email", value: email } });
    assert.equal(JSON.parse(req.headers["openai-sentinel-token"]).flow, "authorize_continue");
    if (mode === "expired") return json({ error: { code: "invalid_state", message: "Your sign-in session is no longer valid" } }, 400);
    return json({ continue_url: mode === "foreign" ? "http://example.invalid/log-in/password" : base + (mode === "email" ? "/email-verification" : mode === "loop" ? "/log-in" : "/log-in/password") });
  }
  if (url.pathname === "/api/accounts/password/verify") {
    assert.equal(body.password, "fixture-password");
    return json({ continue_url: base + "/mfa-challenge/fixture", page: { type: "mfa_challenge" }, "oai-client-auth-session": { mfa_challenge_factors: [{ id: "fixture", factor_type: "totp" }] } });
  }
  if (url.pathname === "/api/accounts/mfa/issue_challenge") return json({ success: true });
  if (url.pathname === "/api/accounts/mfa/verify") { assert.match(body.code, /^\d{6}$/); return json(outcome()); }
  if (url.pathname === "/api/accounts/email-otp/validate") { assert.equal(body.code, "123456"); return json(outcome()); }
  if (url.pathname === "/api/accounts/add-phone/send") { assert.equal(body.phone_number, "+12025550123"); return json({ continue_url: base + "/phone-verification" }); }
  if (url.pathname === "/api/accounts/phone-otp/validate") { assert.equal(body.code, "654321"); return json({ continue_url: callback }); }
  if (url.pathname === "/api/accounts/workspace/select" || url.pathname === "/api/accounts/session/select") return json({ continue_url: callback });
  json({ error: "unexpected fixture route" }, 404);
});
await new Promise(r => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${server.address().port}`;
const env = { NODE_ENV: process.env.NODE_ENV, TOSUB2_TEST_SENTINEL_TOKEN: process.env.TOSUB2_TEST_SENTINEL_TOKEN };
process.env.NODE_ENV = "test"; process.env.TOSUB2_TEST_SENTINEL_TOKEN = "fixture";
const client = () => new ProtocolClient({ jar: CookieJar.fromJSON([{ name: "web-saved", value: "keep", domain: "127.0.0.1", path: "/", hostOnly: true }]), browserIdentity: { deviceId: "fixture-device", sessionId: "fixture-session", browser: { userAgent: "fixture", acceptLanguage: "en", secChUa: '"Chromium"', secChUaMobile: "?0", secChUaPlatform: '"Windows"' } } });
const options = provider => ({ authBase: base, codexAuthMode: provider, sub2ApiOAuth: { baseUrl: base, adminApiKey: "fixture-key" }, expectedEmail: email,
  password: "fixture-password", totpSecret: "JBSWY3DPEHPK3PXP", codexClientId: "fixture", codexRedirectUri: "http://127.0.0.1:1455/auth/callback",
  rl: { question: async prompt => prompt.startsWith("Phone number") ? "+12025550123" : prompt.startsWith("Phone OTP") ? "654321" : "123456" },
  saveCheckpoint: async (stage, details) => { checkpoints.push({ stage, ...structuredClone(details) }); } });
try {
  calls = []; checkpoints = [];
  if (baseline) {
    await assert.rejects(runCodexOauth(client(), options("local")), /CODEX_AUTH_LOGIN_REQUIRED/);
    assert(!calls.some(c => c.path === "/api/accounts/authorize/continue"));
    console.log("OAUTH_LOGIN_BASELINE_REPRODUCED valid saved Web context -> Codex log-in -> false Web-expired failure; no SMS stage"); process.exitCode = 1;
  } else {
    for (const provider of ["local", "sub2api"]) for (mode of ["phone", "direct-phone", "choose-after-login", "workspace", "email", "direct-password", "existing", "expired", "foreign", "loop"]) {
      calls = []; checkpoints = [];
      if (["expired", "foreign", "loop"].includes(mode)) {
        await assert.rejects(runCodexOauth(client(), options(provider)), new RegExp({ expired: "CODEX_AUTH_RESTART_REQUIRED", foreign: "CODEX_AUTH_ORIGIN_INVALID", loop: "CODEX_AUTH_STEP_LIMIT" }[mode]));
        if (mode === "expired") assert.equal(checkpoints.at(-1).stage, "email_verified", "retry would reuse an invalid OAuth state");
      } else {
        const c = client(), result = await runCodexOauth(c, options(provider));
        assert.equal(new URL(result.callbackUrl).searchParams.get("state"), state);
        assert(c.jar.has("web-saved"));
        if (mode === "phone") assert(checkpoints.some(c => c.stage === "phone_required") && checkpoints.some(c => c.stage === "phone_otp"));
      }
      assert.equal(calls.filter(c => c.path === "/oauth/authorize").length, 1);
      assert(!calls.some(c => c.path === "/api/auth/signin/openai"), "Codex requirement caused an unnecessary Web relogin");
    }
    mode = "phone"; calls = []; checkpoints = [];
    const c = client(), first = options("sub2api"); first.password = ""; first.rl = { question: async () => { throw Error("fixture interruption"); } };
    await assert.rejects(runCodexOauth(c, first), /fixture interruption/);
    const checkpoint = checkpoints.at(-1), before = calls.filter(c => c.path === "/oauth/authorize").length;
    assert.equal(checkpoint.stage, "oauth_login");
    const result = await resumeCodexOauth(c, options("sub2api"), checkpoint);
    assert.equal(new URL(result.callbackUrl).searchParams.get("state"), state);
    assert.equal(calls.filter(c => c.path === "/oauth/authorize").length, before, "resume regenerated the original OAuth state");
    console.log("OAUTH_LOGIN_CONTINUATION_PASS local/sub2api; preserved state/PKCE/cookies; password/MFA/email; phone+SMS prompts; workspace/existing flows; bounded invalid/foreign/loop errors; checkpoint resume without Web relogin");
  }
} finally { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await new Promise(r => server.close(r)); }
