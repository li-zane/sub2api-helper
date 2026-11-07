import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
const repo = path.resolve(import.meta.dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-auth-progress-"));
const commands = [], events = root + "/events.json", ack = root + "/ack.json", ready = root + "/ready", trace = root + "/trace.jsonl";
await fs.writeFile(events, "[]");
const mock = root + "/protocol.mjs";
await fs.writeFile(mock, `import fs from 'node:fs/promises';
if(!process.argv.includes('--replace-password')) await import(${JSON.stringify(new URL("./mock-webfirst-protocol.mjs", import.meta.url).href)});
else {let cursor=0,reading=false;await fs.writeFile(${JSON.stringify(ready)},'ready');process.stdin.resume();
process.stdin.on('data',()=>console.log('[fixture] input received'));
setInterval(async()=>{if(reading)return;reading=true;try{const chunks=JSON.parse(await fs.readFile(${JSON.stringify(events)},'utf8'));while(cursor<chunks.length){process.stdout.write(chunks[cursor++]);await fs.writeFile(${JSON.stringify(ack)},JSON.stringify({cursor}));}}finally{reading=false;}},25);}
`);
const upstream = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(req.url.includes("mfa_info") ? '{"mfa_enabled":true,"mfa_enabled_v2":true,"factors":{"totp":[{"id":"fixture"}]}}' : req.url.includes("eligibility") ? '{"eligible":true}' : '{}');
});
await new Promise(r => upstream.listen(0, "127.0.0.1", r));
let port; do { const l = http.createServer(); await new Promise(r => l.listen(0, "127.0.0.1", r)); port = l.address().port; await new Promise(r => l.close(r)); } while (port <= 10080);
const base = `http://127.0.0.1:${port}`; let child, headers, logs = "", id;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async fn => { for (const end = Date.now() + 20000; Date.now() < end;) { const value = await fn().catch(() => null); if (value) return value; if (child?.exitCode != null) throw Error(logs); await sleep(40); } throw Error("auth progress timeout\n" + logs); };
const api = async (p, body) => { const r = await fetch(base + p, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; };
const job = async () => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
async function emit(text) {
  commands.push(text); const temporary = events + ".tmp"; await fs.writeFile(temporary, JSON.stringify(commands)); await fs.rename(temporary, events);
  await wait(async () => JSON.parse(await fs.readFile(ack, "utf8")).cursor === commands.length); await sleep(80);
}
const challenge = "[auth-expired] fixture\n[codex-auth-login] fixture\n[ok] Password accepted\n[mfa] TOTP 2FA challenge reached.\n[mfa] Generated a 6-digit code from the configured 2FA key.\n[ok] 2FA verification accepted\n";
const emailPrompt = "[password-replace] Email verification reached before password replacement.\nEmail OTP (r=resend, q=quit): ";
try {
  child = spawn(process.execPath, [process.env.AUTH_PROGRESS_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: repo, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, ONBOARDING_PROTOCOL_SCRIPT: mock, WEBFIRST_TRACE: trace,
      LOCALAPPDATA: root, TOSUB2_MAC_CREDENTIAL_ROOT: root + "/credentials", TOSUB2_LINUX_CREDENTIAL_ROOT: root + "/credentials", TOSUB2_CREDENTIAL_KEY: "ab".repeat(32),
      SUB2API_MONITOR_ENABLED: "0", TOSUB2_SESSION_NATIVE_HTTP: "1", CHATGPT_BASE: `http://127.0.0.1:${upstream.address().port}`, TOSUB2_LOGIN_TIMEOUT_MINUTE_MS: "1000" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => logs += d); child.stderr.on("data", d => logs += d);
  const boot = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; }); headers = { "x-console-token": boot.token, "content-type": "application/json" };
  assert.equal((await api("/api/task-settings", { loginTimeoutMinutes: 10 })).status, 200);
  const oldPassword = "Fixture-Password-123!", created = await api("/api/jobs", { email: "progress@example.test", password: oldPassword, totpSecret: "JBSWY3DPEHPK3PXP" });
  assert.equal(created.status, 201); id = created.data.job.id; await wait(async () => (await job()).status === "completed");
  const webPath = root + "/" + id + "/web-session.json", web = await fs.readFile(webPath);
  const oauthPath = root + "/" + id + "/sub2api-import-oauth.json", oauth = JSON.stringify({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: { email: "progress@example.test", access_token: "original-fixture", refresh_token: "original-refresh", plan_type: "free" } }] });
  await fs.writeFile(oauthPath, oauth);
  assert.equal((await api(`/api/jobs/${id}/replace-password`, {})).status, 200); await wait(() => fs.stat(ready));
  await emit(challenge + emailPrompt);
  if (process.argv.includes("--baseline")) {
    const j = await job(); assert.equal(j.status, "working"); assert.equal(j.prompt, "正在自动完成 2FA 验证");
    console.log("BASELINE_AUTH_STAGE_REPRODUCED latest=email_otp displayed=working prompt=stale_2fa"); process.exitCode = 1;
  } else {
    let j = await job(); assert.equal(j.status, "email_otp"); assert.match(j.prompt, /未配置自动收码接口/); assert.equal(j.autoEmailOtp, false);
    await emit("\n[fixture] heartbeat\n"); assert.equal((await job()).status, "email_otp", "tail replayed old MFA stage");
    await emit("Password (q=quit): "); assert.equal((await job()).status, "password");
    await emit("[ok] Password accepted\n[mfa] TOTP 2FA challenge reached.\n2FA OTP (6 digits, q=quit): "); assert.equal((await job()).status, "mfa_otp");
    await emit("[ok] 2FA verification accepted\n"); assert.match((await job()).prompt, /2FA 验证通过/);
    await emit("Email OTP (r=res"); assert.equal((await job()).status, "working");
    await emit("end, q=quit): "); assert.equal((await job()).status, "email_otp");
    assert.equal((await api(`/api/jobs/${id}/input`, { action: "email_otp", value: "123456" })).status, 200, "correct email input was rejected as a stale MFA stage");
    await emit("\nEmail OTP (r=resend, q=quit): "); assert.equal((await job()).status, "email_otp");
    assert.equal((await api(`/api/jobs/${id}/cancel`, {})).status, 200);
    assert.equal((await api(`/api/jobs/${id}/credentials`)).data.credentials.password, oldPassword);
    assert.deepEqual(await fs.readFile(webPath), web); assert.equal(await fs.readFile(oauthPath, "utf8"), oauth);
    commands.length = 0; await fs.writeFile(events, "[]"); await fs.rm(ready, { force: true }); await fs.rm(ack, { force: true });
    assert.equal((await api("/api/task-settings", { loginTimeoutMinutes: 1 })).status, 200);
    assert.equal((await api(`/api/jobs/${id}/replace-password`, {})).status, 200); await wait(() => fs.stat(ready)); await emit(challenge + emailPrompt);
    await wait(async () => (await job()).passwordAddError?.includes("LOGIN_TIMEOUT"));
    j = await job(); assert.notEqual(j.loginAutomationPause?.reason, "mfa_failed", "completed MFA was treated as failed on email timeout");
    assert.equal((await api(`/api/jobs/${id}/credentials`)).data.credentials.password, oldPassword);
    assert.deepEqual(await fs.readFile(webPath), web); assert.equal(await fs.readFile(oauthPath, "utf8"), oauth);
    commands.length = 0; await fs.writeFile(events, "[]"); await fs.rm(ready, { force: true }); await fs.rm(ack, { force: true });
    assert.equal((await api(`/api/jobs/${id}/replace-password`, {})).status, 200); await wait(() => fs.stat(ready));
    await emit("[ok] 2FA verification accepted\n[mfa] TOTP 2FA challenge reached.\n");
    await emit("[fixture] waiting for the new MFA challenge\n");
    await wait(async () => (await job()).loginAutomationPause?.reason === "mfa_failed");
    assert.equal((await api(`/api/jobs/${id}/credentials`)).data.credentials.password, oldPassword);
    assert.deepEqual(await fs.readFile(webPath), web); assert.equal(await fs.readFile(oauthPath, "utf8"), oauth);
    console.log("AUTH_PROGRESS_HTTP_PASS password rotation MFA->email; coalesced/split chunks; no stale replay; new password/MFA prompts; MFA acceptance; manual email input accepted; unchanged timeout; email timeout is not MFA failure; genuine new MFA timeout still pauses; original password/Web/OAuth preserved");
  }
} finally {
  if (id && child?.exitCode === null) await api(`/api/jobs/${id}/cancel`, {}).catch(() => {});
  if (child?.exitCode === null) { const end = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await end; }
  await new Promise(r => upstream.close(r)); assert(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true });
}
