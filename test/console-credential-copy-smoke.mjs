import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createCredentialStore } from "../src/credential-store.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-credential-copy-"));
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const email = n => `copy-${n}@example.test`;
const secret = "JBSWY3DPEHPK3PXP", replacement = "MZXW6YTBON2GK3TB";
const credentialRoot = path.join(temp, "credentials");
const store = createCredentialStore({ windowsRoot: path.join(temp, "toSub2", "credentials"), macRoot: credentialRoot,
  linuxRoot: credentialRoot, linuxKey: "ab".repeat(32) });
let child, token, base, logs = "";
async function api(route, { body, method = body === undefined ? "GET" : "POST", authenticated = true } = {}) {
  const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(authenticated ? { "x-console-token": token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
const copy = (ids, options = {}) => api("/api/jobs/copy-credentials", { body: { ids }, ...options });
async function start() {
  const listener = http.createServer(); let port;
  do { await new Promise(r => listener.listen(0, "127.0.0.1", r)); port = listener.address().port; await new Promise(r => listener.close(r)); } while (port <= 10080);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp,
      LOCALAPPDATA: temp, TOSUB2_LINUX_CREDENTIAL_ROOT: credentialRoot, TOSUB2_MAC_CREDENTIAL_ROOT: credentialRoot,
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
  for (const end = Date.now() + 15000; Date.now() < end;) {
    if (child.exitCode !== null) throw Error(logs);
    try { const r = await fetch(base + "/api/bootstrap"); token = (await r.json()).token; if (token) return; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  throw Error(logs || "fixture startup timeout");
}
async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; } }
try {
  for (let n = 1; n <= 4; n++) {
    const dir = path.join(temp, id(n)); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email: email(n), status: n === 2 ? "banned" : "completed",
      plan_type: "free", remark: "do-not-copy-remark", mail_api_url: "https://example.test/do-not-copy-mail",
      has_password: n !== 3, has_totp_key: n === 1 || n === 2, login_mode: n === 3 ? "manual" : "password" }));
    if (n < 3) await store.save(email(n), { password: `fixture-password-${n}`, totpSecret: secret });
    if (n === 1) await fs.writeFile(path.join(dir, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: {
      email: email(n), access_token: "do-not-copy-access", refresh_token: "do-not-copy-refresh" } }] }));
  }
  await start();
  const first = await copy([id(1)]);
  if (first.status !== 200) {
    console.log(`CREDENTIAL_COPY_BASELINE status=${first.status}; expected=200`);
    process.exitCode = 1;
  } else {
    assert.deepEqual(first.data, { text: `${email(1)}----fixture-password-1----${secret}`, count: 1 });
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.get("content-disposition"), null, "copy response must not download a file");
    assert.equal((await copy([id(1)], { authenticated: false })).status, 403);
    assert.equal((await copy([])).status, 400);
    assert.equal((await copy("invalid")).status, 400);
    assert.equal((await copy([id(1), id(999)])).status, 404);
    const batch = await copy([id(2), id(1), id(3), id(2)]);
    assert.deepEqual(batch.data, { text: `${email(2)}----fixture-password-2----${secret}\n${email(1)}----fixture-password-1----${secret}\n${email(3)}--------`, count: 3 });
    const jobs = (await api("/api/jobs")).data.jobs;
    assert.equal(jobs.find(j => j.id === id(2)).canDownload, false, "banned fixture unexpectedly has OAuth output");
    assert.equal(jobs.find(j => j.id === id(3)).canDownload, false, "Web-only fixture unexpectedly has OAuth output");
    assert(!JSON.stringify(jobs).includes(secret), "account list exposed a secret");
    assert.equal((await copy([id(4)])).status, 409, "unreadable saved password must not become an empty field");
    const update = (body) => api(`/api/jobs/${id(1)}/credentials`, { method: "PUT", body });
    assert.equal((await update({ password: "latest-fixture-password", totpSecret: replacement })).status, 200);
    assert.equal((await copy([id(1)])).data.text, `${email(1)}----latest-fixture-password----${replacement}`);
    assert.equal((await update({ totpSecret: "" })).status, 200);
    assert.equal((await copy([id(1)])).data.text, `${email(1)}----latest-fixture-password----`);
    assert.equal((await update({ password: "", totpSecret: replacement })).status, 200);
    assert.equal((await copy([id(1)])).data.text, `${email(1)}--------${replacement}`);
    assert.equal((await update({ password: "fixture\npassword" })).status, 200);
    assert.equal((await copy([id(1)])).status, 409, "multiline credential produced an extra account line");
    assert.equal((await update({ password: "fixture----password" })).status, 200);
    assert.equal((await copy([id(1)])).status, 409, "credential delimiter produced an extra field");
    assert.equal((await update({ password: "", totpSecret: "" })).status, 200);
    assert.equal((await copy([id(1)])).data.text, `${email(1)}--------`, "deleted local values were resurrected from history");
    await stop(); await start();
    assert.equal((await copy([id(1)])).data.text, `${email(1)}--------`, "cleared credentials returned after restart");
    assert.equal((await copy([id(2)])).data.text, `${email(2)}----fixture-password-2----${secret}`, "persisted credentials were lost on restart");
    assert.equal((await api(`/api/jobs/${id(1)}/download`)).status, 200, "legacy OAuth download API regressed");
    assert(!logs.includes(secret) && !logs.includes("latest-fixture-password"), "copy leaked credentials to logs");
    console.log("CREDENTIAL_COPY_HTTP_PASS single; batch/order/dedup; blank fields; banned/Web-only; latest/clear/restart; auth/no-store; unreadable-store; legacy-download");
  }
} finally { await stop(); await fs.rm(temp, { recursive: true, force: true }); }
