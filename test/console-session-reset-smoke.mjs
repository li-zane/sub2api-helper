import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { seedWebSession } from "./account-web-fixture.mjs";

for (const scenario of (process.env.SESSION_RESET_SCENARIO ? [process.env.SESSION_RESET_SCENARIO] : ["manual-proxy", "manual-direct", "automatic", "automatic-overdue", "logout-failure", "oauth-failure", "proxy-changed", "sync-retry", "queued", "automation-paused", "local-oauth", "oauth-retry", "banned"])) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "helper-reset-http-")), email = "reset@example.test";
  const id = "11111111-1111-4111-8111-111111111111", dir = path.join(temp, id), trace = path.join(temp, "trace.jsonl");
  const automatic = ["automatic", "automatic-overdue", "logout-failure", "automation-paused"].includes(scenario), direct = scenario === "manual-direct";
  let child, headers, logs = "", logouts = 0, updates = 0, creates = 0, failSync = scenario === "sync-retry";
  const mutations = [], row = { id: 7, platform: "openai", type: "oauth", name: email, status: "active", schedulable: !automatic,
    proxy_id: direct ? 0 : 3, group_ids: [91], priority: 17, credentials: { email, access_token: "old", refresh_token: "old-refresh", plan_type: "plus", custom: "retain" } };
  const proxy = { id: 3, name: "Original", protocol: "http", host: "fixed.fixture", port: 8080, ip_address: "198.51.100.3", status: "active" };
  const append = event => fs.appendFile(trace, JSON.stringify(event) + "\n");
  const json = (res, value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  const official = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url === "/mail") {
      await append({ phase: "mail-baseline" });
      return json(res, []);
    }
    if (req.url === "/backend-api/accounts/logout_all") {
      logouts++; await append({ phase: "logout" });
      return json(res, scenario === "logout-failure" ? { error: "fixture logout rejected" } : { ok: true }, scenario === "logout-failure" ? 503 : 200);
    }
    return json(res, { error: "unexpected official request" }, 404);
  });
  const pool = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture"), chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (url.pathname === "/api/v1/admin/accounts") return json(res, { data: { items: [row], total: 1, pages: 1 } });
    if (url.pathname === "/api/v1/admin/proxies/all") return json(res, [proxy]);
    if (url.pathname === "/api/v1/admin/accounts/batch") { creates++; return json(res, {}); }
    if (url.pathname === "/api/v1/admin/accounts/7/schedulable") {
      row.schedulable = body.schedulable; mutations.push(row.schedulable); await append({ phase: "schedule", enabled: row.schedulable }); return json(res, {});
    }
    if (url.pathname === "/api/v1/admin/accounts/7") {
      if (req.method === "PUT") {
        if (scenario === "banned" && Object.keys(body).length === 1 && body.proxy_id === 0) { row.proxy_id = 0; return json(res, { data: row }); }
        assert(!Object.hasOwn(body, "proxy_id"), "credential update changed binding");
        assert(!Object.hasOwn(body, "schedulable")); assert(!Object.hasOwn(body, "group_ids")); assert(!Object.hasOwn(body, "priority"));
        if (failSync) return json(res, { message: "fixture sync failed" }, 503);
        updates++; Object.assign(row, body); await append({ phase: "update" });
      }
      return json(res, { data: row });
    }
    if (url.pathname.endsWith("/upstream-errors") || url.pathname.endsWith("/requests")) return json(res, { data: { items: [], total: 0 } });
    return json(res, []);
  });
  const listen = async server => { await new Promise(r => server.listen(0, "127.0.0.1", r)); return server.address().port; };
  const officialBase = `http://127.0.0.1:${await listen(official)}`, poolBase = `http://127.0.0.1:${await listen(pool)}`;
  const config = { baseUrl: poolBase, adminApiKey: "fixture" }, backend = crypto.createHash("sha256").update(poolBase + "\0fixture").digest("hex").slice(0, 24);
  const slot = http.createServer(), port = await listen(slot); await new Promise(r => slot.close(r)); const base = `http://127.0.0.1:${port}`;
  const gate = path.join(temp, "continue");
  const probe = `import fs from 'node:fs/promises';
import {TlsFingerprintTransport} from ${JSON.stringify(pathToFileURL(path.resolve('src/tls-transport.mjs')).href)};
TlsFingerprintTransport.prototype.configure=async function(proxy){if(this.rotateProxySessions!==false)throw Error('logout transport must be pinned');this.configuredProxy=proxy;await fs.appendFile(${JSON.stringify(trace)},JSON.stringify({phase:'transport',proxy})+'\\n');};
TlsFingerprintTransport.prototype.fetch=async function(url,options){if(url.endsWith('/backend-api/accounts/logout_all'))await fs.appendFile(${JSON.stringify(trace)},JSON.stringify({phase:'logout-route',proxy:this.configuredProxy})+'\\n');return fetch(url,options);};
TlsFingerprintTransport.prototype.close=async function(){};`;
  const api = async (route, body) => { const r = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; };
  const job = async () => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
  const wait = async (fn, message) => { for (const until = Date.now() + 15000; Date.now() < until;) { if (await fn()) return; if (child?.exitCode != null) throw Error(logs); await new Promise(r => setTimeout(r, 30)); } throw Error(message + "\n" + logs + "\n" + JSON.stringify(await job())); };
  async function start() {
    child = spawn(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(probe), "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: temp,
        LOCALAPPDATA: temp, TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"),
        SUB2API_MONITOR_ENABLED: "0", CHATGPT_BASE: officialBase, AUTH_BASE: officialBase, SESSION_RESET_TRACE: trace,
        SESSION_RESET_GATE: gate, SESSION_RESET_FAIL_OAUTH: ["oauth-failure", "oauth-retry"].includes(scenario) && !(await fs.access(gate+".retry").then(()=>true,()=>false)) ? "1" : "0", TOSUB2_SESSION_NATIVE_HTTP: "0",
        ONBOARDING_PROTOCOL_SCRIPT: path.resolve("test/mock-session-reset-protocol.mjs") } });
    child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
    await wait(async () => { try { const b = await fetch(base + "/api/bootstrap").then(r => r.json()); if (!b.token) return false; headers = { "x-console-token": b.token, "content-type": "application/json" }; return true; } catch { return false; } }, "startup");
  }
  async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; } }
  try {
    await fs.mkdir(dir); await fs.writeFile(trace, "");
    const output = path.join(dir, "sub2api-import-oauth.json");
    await fs.writeFile(output, JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { ...row.credentials } }] }));
    await seedWebSession(output);
    await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({ version: 1, email, status: scenario === "banned" ? "banned" : "completed", authorization_proxy_selected: true, assigned_proxy_id: direct ? null : 3,
      bound_ip: direct ? null : "198.51.100.3", last_auth_automated: true, last_auth_requirements: { emailOtp: true }, mail_api_url: officialBase + "/mail",
      ...(scenario === "automation-paused" ? { login_automation_pause: { reason: "mfa_failed", at: new Date().toISOString() } } : {}) }));
    const blockerId = "22222222-2222-4222-8222-222222222222";
    if (scenario === "queued") {
      const blocker = path.join(temp, blockerId); await fs.mkdir(blocker);
      await fs.writeFile(path.join(blocker, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", accounts: [{ credentials: { email: "blocker@example.test", plan_type: "plus", access_token: "fixture", refresh_token: "fixture" } }] }));
      await fs.writeFile(path.join(blocker, "job-meta.json"), JSON.stringify({ version: 1, email: "blocker@example.test", status: "completed" }));
    }
    await fs.writeFile(path.join(temp, "task-settings.json"), JSON.stringify({ maxActiveJobs: 1, accountProxyMode: direct ? "global" : "plan", codexAuthMode: scenario === "local-oauth" ? "local" : "sub2api",
      overloadAutoCooldown: { windowMinutes: 15, threshold: 4, cooldownMinutes: 1, reauthorizeAfterCooldown: automatic }, monitoring: { overloadIntervalSeconds: 86400, accountStatusIntervalSeconds: 3600 } }));
    await fs.writeFile(path.join(temp, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { ...config, proxyId: "direct" }, profiles: [{ id: "default", name: "Direct plan", proxyId: "direct", groupIds: [] }], activeProfileId: "default" }));
    if (automatic) await fs.writeFile(path.join(temp, "overload-cooldown.json"), JSON.stringify({ version: 1, accounts: { [email]: { enabled: true, backend, phase: "cooling", resumeAccountIds: ["7"], coolingUntil: new Date(Date.now() + (scenario === "automatic-overdue" ? -1000 : 1800)).toISOString() } } }));
    await start();
    if (scenario !== "automatic-overdue") await api("/api/sub2api/account-status?refresh=1");
    if (scenario === "queued") {
      assert.equal((await api(`/api/jobs/${blockerId}/relogin`, {})).status, 200);
      await wait(async () => (await fs.readFile(trace, "utf8")).includes('"phase":"oauth"'), "blocker did not occupy slot");
      await fs.writeFile(trace, "");
    }
    const unauthorized = await fetch(base + `/api/jobs/${id}/session-reset`, { method: "POST", body: "{}" }); assert.equal(unauthorized.status, 403);
    if (scenario === "proxy-changed") proxy.ip_address = "198.51.100.99";
    if (!automatic) {
      const started = await api(`/api/jobs/${id}/session-reset`, {});
      assert.equal(started.status, ["proxy-changed", "banned"].includes(scenario) ? 409 : 202, JSON.stringify(started.data));
      if (scenario === "queued") {
        assert.equal((await job()).status, "queued"); await new Promise(r => setTimeout(r, 120));
        assert.equal(logouts, 0, "logout happened outside shared queue slot");
        assert.equal((await api(`/api/jobs/${blockerId}/cancel`, {})).status, 200);
      }
    }
    if (["proxy-changed", "banned"].includes(scenario)) {
      assert.equal(logouts, 0); assert.equal(updates, 0); assert.equal(row.proxy_id, scenario === "banned" ? 0 : 3);
    } else if (scenario === "automation-paused") {
      await wait(async () => (await job()).sessionReset?.status === "failed", "automatic eligibility was not checked");
      assert.equal(logouts, 0); assert.equal(updates, 0); assert.equal(row.schedulable, false);
    } else if (scenario === "logout-failure") {
      await wait(async () => (await job()).sessionReset?.status === "failed", "logout failure state");
      assert.equal(logouts, 1); assert.equal(updates, 0); assert.equal(row.schedulable, false);
      assert(!((await fs.readFile(trace, "utf8")).includes('"phase":"web"')));
    } else {
      await wait(async () => (await fs.readFile(trace, "utf8")).includes('"phase":"oauth"'), "OAuth never started");
      assert.equal(logouts, 1); assert.equal(updates, 0);
      assert.equal((await api(`/api/jobs/${id}/session-reset`, {})).status, 409, "duplicate reset accepted");
      if (automatic) assert.equal(row.schedulable, false, "pool resumed before credentials updated");
      const events = (await fs.readFile(trace, "utf8")).trim().split("\n").map(JSON.parse), web = events.find(e => e.phase === "web"), transport = events.find(e => e.phase === "logout-route");
      assert(events.findIndex(e => e.phase === "mail-baseline") >= 0
        && events.findIndex(e => e.phase === "mail-baseline") < events.findIndex(e => e.phase === "logout"), "old mailbox OTPs were not excluded before logout and fresh login");
      assert.equal(web.reused, false, "fresh reset reused pre-logout Web"); assert.equal(web.fixed, "1"); assert.equal(web.phased, "0");
      assert.equal(web.proxy, direct ? "" : "http://fixed.fixture:8080/"); assert.equal(transport.proxy, direct ? null : "http://fixed.fixture:8080/");
      assert.equal(web.mode, scenario === "local-oauth" ? "local" : "sub2api"); assert.equal(web.oauthProxyId, direct || scenario === "local-oauth" ? "" : "3");
      await fs.writeFile(gate, "continue");
      if (["oauth-failure", "oauth-retry"].includes(scenario)) {
        await wait(async () => (await job()).sessionReset?.status === "failed", "OAuth failure state"); assert.equal(updates, 0); assert.equal(row.credentials.access_token, "old");
        if (scenario === "oauth-retry") {
          await stop(); await fs.writeFile(gate+".retry", "retry"); await start();
          const retried = await api(`/api/jobs/${id}/session-reset`, {}); assert.equal(retried.status, 202, JSON.stringify({response:retried.data,job:await job()}));
          await wait(async () => (await job()).sessionReset?.status === "completed", "manual OAuth retry failed");
          assert.equal(logouts, 2); assert.equal(updates, 1); assert.equal(row.proxy_id, 3);
        }
      } else {
        if (scenario === "sync-retry") {
          await wait(async () => Boolean((await job()).poolRefreshError), "sync failure was not surfaced");
          const runningLog = (await api(`/api/jobs/${id}/logs?view=protocol`)).data.entries.find(e => e.type === "session_reset");
          assert.equal(runningLog.status, "running", "sync failure was reported as completed before credential update");
          await stop(); failSync = false; await start();
        }
        await wait(async () => (await job()).sessionReset?.status === "completed", "reset did not complete");
        if (automatic) await wait(async () => row.schedulable, "cooldown did not resume after reset");
        assert.equal(updates, 1); assert.equal(row.credentials.access_token, "reset-new-access"); assert.equal(row.credentials.custom, "retain");
        assert.equal(row.proxy_id, direct ? 0 : 3); assert.deepEqual(row.group_ids, [91]); assert.equal(row.priority, 17); assert.equal(logouts, 1);
        await wait(async () => (await api(`/api/jobs/${id}/logs?view=protocol`)).data.entries
          .some(e => e.type === "session_reset" && e.status === "completed"), "completed reset is missing from protocol menu");
        if (automatic) assert.deepEqual(mutations, [true]);
        await stop();
        if (scenario === "manual-proxy") {
          const metadataPath = path.join(dir, "job-meta.json"), metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
          metadata.pool_refresh_action = "session-reset"; metadata.pool_refresh_ready = true;
          await fs.writeFile(metadataPath, JSON.stringify(metadata));
        }
        await start();
        if (scenario === "manual-proxy") await wait(async () => !(await job()).poolRefreshAction, "durable completed reset replayed old pending synchronization");
        assert.equal((await job()).sessionReset.status, "completed"); assert.equal(logouts, 1); assert.equal(updates, 1);
      }
    }
    assert.equal(creates, 0);
    console.log(`SESSION_RESET_HTTP_PASS ${scenario} order/pinned-route/update-existing/no-duplicates verified`);
  } finally {
    await fs.writeFile(gate, "continue").catch(() => {}); await stop();
    official.closeAllConnections(); pool.closeAllConnections(); await Promise.all([new Promise(r => official.close(r)), new Promise(r => pool.close(r))]);
    await fs.rm(temp, { recursive: true, force: true });
  }
}
