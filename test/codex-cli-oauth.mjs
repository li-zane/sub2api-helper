import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { cliProfile, cliContainerArgs, withCliLock } from "../src/codex-cli-runtime.mjs";
import { cliAuthToSub2api, runCliOAuth, syncCliUserAgent, validateCliAuthUrl, validateCliCallback } from "../src/codex-cli-oauth.mjs";
import { normalizeCodexAuthMode } from "../src/sub2api-oauth.mjs";
import { runCodexOauth, resumeCodexOauth, buildSub2apiOauthExport } from "../src/protocol-login.mjs";
import { createConsoleSettings } from "../src/console-settings.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-oauth-test-"));
const email = "cli@example.com";
const ua = "codex_cli_rs/0.165.0 (Alpine Linux 3.24.1; x86_64) unknown (codex_cli_rs; 0.165.0)";
const jwt = data => `header.${Buffer.from(JSON.stringify(data)).toString("base64url")}.fixture`;
function authFor(email = "cli@example.com", account = "workspace") {
  return { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { account_id: account,
    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "fixture-private-refresh",
    id_token: jwt({ email, sid: "session-not-workspace", sub: "user", "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" } }) }, last_refresh: "2026-11-20T00:00:00Z" };
}
const authUrl = "https://auth.openai.com/oauth/authorize?" + new URLSearchParams({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann", state: "fixture-state", response_type: "code", redirect_uri: "http://localhost:1455/auth/callback", code_challenge: "fixture-challenge", code_challenge_method: "S256" });
const callback = "http://localhost:1455/auth/callback?code=private-code&state=fixture-state";
let settings = { openai_codex_user_agent: "previous-UA", registration_enabled: true, smtp_port: 587, site_name: "Preserve me", openai_codex_client_version: "", openai_codex_version_auto_sync_enabled: true, nested: { value: 7 } };
let mode = "ok", puts = 0;
const requests = [];
const server = http.createServer(async (req, res) => {
  const parts = []; for await (const chunk of req) parts.push(chunk);
  const body = Buffer.concat(parts).toString();
  assert.equal(req.headers["x-api-key"], "fixture-private-admin-key");
  assert.equal(req.url, "/api/v1/admin/settings");
  requests.push({ method: req.method, body });
  res.setHeader("content-type", "application/json");
  if (mode === "reject") { res.writeHead(403); res.end(JSON.stringify({ message: "fixture-private-admin-key" })); return; }
  if (mode === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/leak" }); res.end("{}"); return; }
  if (req.method === "PUT") {
    puts++;
    const next = JSON.parse(body);
    assert.equal(next.registration_enabled, true);
    assert.equal(next.smtp_port, 587);
    assert.deepEqual(next.nested, { value: 7 });
    if (mode !== "ignore") settings = next;
  }
  res.end(JSON.stringify({ code: 0, data: mode === "unsupported" ? {} : settings }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const gateway = { baseUrl: `http://127.0.0.1:${server.address().port}`, adminApiKey: "fixture-private-admin-key" };
const events = [];
const exported = path.join(root, "export.json");
let auth = authFor(), rejectCallback = false;
const openSession = async () => ({ userAgent: ua,
  async request(method, params) {
    events.push([method, params]);
    assert.equal(method, "account/login/start");
    return { type: "chatgpt", authUrl, loginId: "login-id" };
  },
  async deliverCallback(url) { events.push(["callback", url]); if (rejectCallback) throw new Error("fixture callback failed"); },
  async waitForLogin(id) { assert.equal(id, "login-id"); events.push(["completed"]); },
  async readAuth() { events.push(["auth"]); return auth; },
  async discardAuth() { events.push(["discarded"]); },
  async close() { events.push(["closed", await fs.readFile(exported, "utf8").catch(() => "")]); },
});
const options = { root, expectedEmail: email, profileEmail: email, gateway, workspaceId: "workspace", openSession,
  exportPath: exported, accountName: "Chosen name", concurrency: 3, authorize: async () => ({ callbackUrl: callback }) };
try {
  assert.equal(normalizeCodexAuthMode("cli"), "cli");
  assert.throws(() => normalizeCodexAuthMode("shell"));
  const profiles = await Promise.all([cliProfile(root, " CLI@example.com "), cliProfile(root, email), cliProfile(root, "another@example.com")]);
  assert.equal(profiles[0].key, profiles[1].key, "same account shares a lock key");
  assert.notEqual(profiles[0].key, profiles[2].key);
  assert.equal(new Set(profiles.map(p => p.runId)).size, 3);
  assert.equal(new Set(profiles.map(p => p.container)).size, 3);
  assert.notEqual((await cliProfile(root, email)).hostname, profiles[0].hostname, "reauthorization is also fresh");
  assert.deepEqual(await fs.readdir(root), [], "environment descriptors leave no saved account config");
  const args = cliContainerArgs(profiles[0], { proxyUrl: "http://u:private-proxy@proxy.invalid:8080", workspaceId: "workspace" });
  assert(!args.some(arg => arg.includes("private-proxy") || arg === "--publish" || arg.includes("type=bind") || arg.includes("type=volume")));
  assert(args.some(arg => arg.startsWith("/home/node/.codex:rw,") && arg.includes("uid=1000,gid=1000,mode=0700")));
  assert(args.includes('--read-only') && args.includes('app-server'));
  const order = [];
  await Promise.all([withCliLock(root, "same", async () => { order.push(1); await new Promise(r => setTimeout(r, 120)); order.push(2); }), withCliLock(root, "same", async () => order.push(3))]);
  assert.equal(order.indexOf(2), order.indexOf(1) + 1, "critical sections cannot overlap");

  const converted = cliAuthToSub2api(auth, { expectedEmail: email, workspaceId: "workspace" });
  assert.equal(converted.account.credentials.chatgpt_account_id, "workspace");
  assert.equal(converted.account.credentials.refresh_token, auth.tokens.refresh_token);
  assert.equal(converted.account.credentials.plan_type, "plus");
  assert.equal(converted.account.extra.chatgpt_user_id, "user");
  assert.throws(() => cliAuthToSub2api(auth, { expectedEmail: "wrong@example.com" }), /邮箱/);
  assert.throws(() => cliAuthToSub2api(auth, { expectedEmail: email, workspaceId: "wrong" }), /工作区/);
  for (const value of [{ ...auth, auth_mode: "api" }, { ...auth, OPENAI_API_KEY: "secret" }, { ...auth, tokens: { ...auth.tokens, refresh_token: "" } }]) {
    assert.throws(() => cliAuthToSub2api(value, { expectedEmail: email }), /凭据/);
  }
  assert.throws(() => cliAuthToSub2api({ ...auth, tokens: { ...auth.tokens, access_token: jwt({ exp: 1 }) } }, { expectedEmail: email }), /过期/);
  const session = validateCliAuthUrl(authUrl);
  assert.equal(validateCliCallback(callback, session), callback);
  for (const url of [authUrl.replace("auth.openai.com", "example.com"), authUrl + "&state=duplicate", authUrl.replace("1455", "8080")]) assert.throws(() => validateCliAuthUrl(url));
  for (const url of [callback.replace("fixture-state", "wrong"), callback + "&code=twice", callback.replace("localhost", "example.com"), callback + "&error=denied"]) assert.throws(() => validateCliCallback(url, session));

  const checkpoints = [];
  const flowOptions = { codexAuthMode: "cli", authBase: "https://auth.openai.com", expectedEmail: email, currentWorkspaceId: "workspace",
    cliOptions: { ...options }, saveCheckpoint: async stage => checkpoints.push(stage) };
  const oauth = await runCodexOauth({ follow: async url => { assert.equal(url, authUrl); return { finalUrl: callback }; } }, flowOptions);
  assert.deepEqual(checkpoints, ["email_verified"]);
  const bundle = await buildSub2apiOauthExport({ oauth, accountName: "Chosen name", concurrency: 3, transport: { fetch() { throw new Error("helper must not exchange CLI code"); } } });
  assert.equal(bundle.data.accounts[0].name, "Chosen name");
  assert.equal(bundle.account.concurrency, 3);
  assert.equal(bundle.account.extra.codex_cli_user_agent, ua);
  assert.deepEqual(events.map(e => e[0]), ["account/login/start", "callback", "completed", "auth", "closed"]);
  assert.deepEqual(JSON.parse(events.at(-1)[1]), bundle.data, "export is durably saved before environment cleanup");
  assert.equal(bundle.account.extra.codex_cli_environment, "one_shot");
  assert.equal(puts, 0, "OAuth never writes gateway settings");
  assert.equal(settings.site_name, "Preserve me");
  assert.deepEqual(requests, [], "OAuth never reads gateway settings either");
  await syncCliUserAgent(gateway, ua, { root });
  assert.equal(puts, 1);
  assert.deepEqual(requests.map(r => r.method), ["GET", "PUT", "GET"]);
  assert(!requests.some(r => /fixture-private-refresh|private-code/.test(r.body)));
  await Promise.all([syncCliUserAgent(gateway, ua, { root }), syncCliUserAgent(gateway, ua, { root })]);
  assert.equal(puts, 1, "identical UA must not rewrite settings");
  const audit = await fs.readFile(path.join(root, "gateway-ua-last-sync.json"), "utf8");
  assert(!audit.includes(gateway.adminApiKey));
  assert.equal(JSON.parse(audit).previousUserAgent, "previous-UA");

  const before = await fs.readFile(exported, "utf8");

  const putCount = puts;
  auth = authFor("wrong@example.com");
  await assert.rejects(runCliOAuth(options), /邮箱/);
  assert.equal(events.at(-2)[0], "discarded", "wrong-account credentials must leave the isolated home");
  assert.equal(events.at(-1)[0], "closed");
  assert.equal(puts, putCount, "wrong account never changes gateway");
  auth = authFor(); rejectCallback = true;
  const at = events.length;
  await assert.rejects(runCliOAuth(options), /callback failed/);
  assert(!events.slice(at).some(e => e[0] === "auth"));
  assert.equal(events.at(-1)[0], "closed");
  rejectCallback = false;
  for (const failure of ["reject", "redirect", "unsupported", "ignore"]) {
    mode = failure; settings.openai_codex_user_agent = "previous-UA";
    await assert.rejects(syncCliUserAgent(gateway, ua, { root }), error => /CODEX_CLI/.test(error.message) && !error.message.includes("fixture-private-admin-key"));
    assert.equal(await fs.readFile(exported, "utf8"), before);
  }
  mode = "reject";
  const requestCount = requests.length;
  await runCliOAuth({ ...options, fetchImpl: () => { throw new Error("OAuth must not contact gateway"); } });
  assert.equal(requests.length, requestCount, "gateway downtime cannot block CLI OAuth export");
  const latestExport = await fs.readFile(exported, "utf8");
  mode = "ok";
  const directory = path.join(root, "not-a-file");
  await fs.mkdir(directory);
  await assert.rejects(runCliOAuth({ ...options, exportPath: directory }));
  assert.equal(events.at(-1)[0], "closed", "a failed export write still cleans the temporary environment");
  assert.equal(await fs.readFile(exported, "utf8"), latestExport);
  await assert.rejects(runCliOAuth({ ...options, openSession: async () => ({ ...await openSession(),
    async close() { throw new Error("fixture cleanup failed"); } }) }), /cleanup failed/);
  assert.equal(JSON.parse(await fs.readFile(exported)).accounts[0].credentials.refresh_token, auth.tokens.refresh_token,
    "cleanup failure leaves the committed export available");
  await resumeCodexOauth({ follow: async () => ({ finalUrl: callback }) }, flowOptions,
    { stage: "callback_ready", oauth: { provider: "cli", callbackUrl: callback.replace("fixture-state", "expired") } });

  let configured = false;
  const settingsFile = path.join(root, "task-settings.json");
  const makeSettings = () => createConsoleSettings({ file: settingsFile, hasSub2ApiConfig: () => configured, taskRuntimeSteps: function* () {} });
  const preferences = makeSettings(); await preferences.load();
  await assert.rejects(preferences.save({ codexAuthMode: "cli" }), { status: 409 });
  configured = true;
  await preferences.save({ codexAuthMode: "cli" });
  const restored = makeSettings(); await restored.load();
  assert.equal(restored.current.codexAuthMode, "cli");
  await preferences.close(); await restored.close();
  console.log("CODEX_CLI_OAUTH_PASS one-shot environments, account locks, callback/state, account/workspace, export-before-cleanup, zero gateway requests during OAuth, manual UA merge/readback, failure preservation, settings reload");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
