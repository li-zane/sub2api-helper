import { rankedFixtureReply } from "./smsbower-ranked-fixture.mjs";
import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
const project = path.resolve(import.meta.dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-oauth-sms-"));
let helper, headers, base, logs = "", noStock = false, gets = 0, statuses = [], hold = null, releaseHold;
const sms = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"), action = url.searchParams.get("action");
  const metadata = rankedFixtureReply(url); if (metadata !== null) return res.end(metadata);
  assert.equal(url.searchParams.get("api_key"), "fixture-sms-key");
  if (action === "getNumber") {
    const n = ++gets; if (hold) { await hold; hold = null; }
    return res.end(noStock ? "NO_NUMBERS" : `ACCESS_NUMBER:fixture-${n}:1202555${String(n).padStart(4, "0")}`);
  }
  if (action === "getStatus") return res.end("STATUS_OK:654321");
  if (action === "setStatus") { statuses.push({ id: url.searchParams.get("id"), status: url.searchParams.get("status") }); return res.end("ACCESS_READY"); }
  res.end("BAD_ACTION");
});
async function listen(s) { do { await new Promise(r => s.listen(0, "127.0.0.1", r)); if (s.address().port > 10080) return s.address().port; await new Promise(r => s.close(r)); } while (true); }
await listen(sms); const socket = http.createServer(), port = await listen(socket); await new Promise(r => socket.close(r)); base = `http://127.0.0.1:${port}`;
const wait = async fn => { const end = Date.now() + 15000; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise(r => setTimeout(r, 30)); } throw Error("fixture timeout\n" + logs); };
const api = async (route, body, method = "POST") => { const r = await fetch(base + route, { headers, ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; };
const job = async id => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
const waitJob = (id, test) => wait(async () => { const j = await job(id); return j && test(j) ? j : null; });
const create = async prefix => { const r = await api("/api/jobs", { email: prefix + "@example.test" }); assert.equal(r.status, 201); return r.data.job.id; };
const settings = (autoAcquire, maxAutoNumbers = 3) => api("/api/sms-provider-settings", { settings: { selectedProviderId: "smsbower", autoAcquire, maxAutoNumbers, maxFailuresPerPool: 10, configs: { smsbower: { apiKey: "fixture-sms-key", service: "dr", country: "1001", maxPrice: "0.42" } } } });
async function start() {
  helper = spawn(process.execPath, [process.env.SMS_TEST_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: project, windowsHide: true,
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root, LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32),
      ONBOARDING_PROTOCOL_SCRIPT: path.join(project, "test/mock-oauth-sms-protocol.mjs"), SMSBOWER_CATALOG_BASE: `http://127.0.0.1:${sms.address().port}/catalog`, SMSBOWER_API_BASE: `http://127.0.0.1:${sms.address().port}/handler_api.php`, SMS_POLL_INTERVAL_MS: "20", SMS_POLL_TIMEOUT_MS: "3000", SUB2API_MONITOR_ENABLED: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  helper.stdout.on("data", d => logs += d); helper.stderr.on("data", d => logs += d);
  const b = await wait(async () => { const r = await fetch(base + "/api/bootstrap"); return r.ok ? r.json() : null; }); headers = { "x-console-token": b.token, "content-type": "application/json" }; assert(!JSON.stringify(b).includes("fixture-sms-key"));
}
async function stop() { if (helper?.exitCode === null) { const done = new Promise(r => helper.once("exit", r)); helper.kill("SIGTERM"); await done; } }
try {
  await start(); assert.equal((await fetch(base + "/api/sms-provider-settings")).status, 403);
  assert.equal((await api("/api/sms-provider-settings")).data.settings.autoAcquire, false);
  const off = await create("auto-off"); await waitJob(off, j => j.status === "phone"); await new Promise(r => setTimeout(r, 100)); assert.equal(gets, 0);
  assert.equal((await settings(true)).status, 200);
  const done = await waitJob(off, j => j.status === "completed"); assert.equal(done.smsStatus, "completed"); assert.equal(gets, 1);
  assert(statuses.some(s => s.status === "1") && statuses.some(s => s.status === "6"));
  noStock = true;
  const no = await create("no-stock"); // Force a provider-level failure before acquiring any paid order.
  await waitJob(no, j => j.smsStatus === "error"); const count = gets; await new Promise(r => setTimeout(r, 200)); assert.equal(gets, count, "no-stock loop purchased repeatedly");
  await api(`/api/jobs/${no}/cancel`, {}); noStock = false;
  for (const prefix of ["reject-once", "partial-reject", "otp-risk"]) {
    const before = gets, id = await create(prefix);
    const result = await waitJob(id, j => j.status === "completed");
    assert.equal(result.smsStatus, "completed");
    assert.equal(gets - before, 2, prefix + " must automatically replace exactly one rejected number");
  }
  const beforeReject = gets, reject = await create("reject-phone");
  await waitJob(reject, j => j.status === "phone" && /上限/.test(j.prompt || ""));
  assert.equal(gets - beforeReject, 3, "default limit must include the first purchased number");
  const rejectedCount = gets; await new Promise(r => setTimeout(r, 200)); assert.equal(gets, rejectedCount, "risk rejection exceeded paid limit"); await api(`/api/jobs/${reject}/cancel`, {});
  for (const prefix of ["rate-limit", "wrong-otp"]) {
    const before = gets, id = await create(prefix);
    await waitJob(id, j => j.smsStatus === "error");
    await new Promise(r => setTimeout(r, 200)); assert.equal(gets - before, 1, prefix + " must not buy another number");
    await api(`/api/jobs/${id}/cancel`, {});
  }
  assert.equal((await settings(true, 2)).status, 200);
  const beforeTwo = gets, two = await create("reject-phone-limit-two");
  await waitJob(two, j => /上限 2 次/.test(j.prompt || "")); assert.equal(gets - beforeTwo, 2);
  await api(`/api/jobs/${two}/cancel`, {});
  hold = new Promise(r => releaseHold = r);
  const stale = await create("stale-order"); await waitJob(stale, j => j.smsStatus === "requesting");
  const cancel = api(`/api/jobs/${stale}/cancel`, {}); // Cancellation does not need to wait for the supplier.
  await cancel; releaseHold(); await wait(async () => statuses.some(s => s.id === "fixture-" + gets && s.status === "8"));
  assert.equal((await job(stale)).status, "canceled");
  await stop(); await start();
  assert.equal((await api("/api/sms-provider-settings")).data.settings.autoAcquire, true, "saved server config did not survive restart");
  assert.equal((await api("/api/sms-provider-settings")).data.settings.maxAutoNumbers, 2);
  const restored = await create("after-restart"); await waitJob(restored, j => j.status === "completed");
  const bad = await api("/api/sms-provider-settings", { settings: { selectedProviderId: "smsbower", autoAcquire: "true", configs: {} } }); assert.equal(bad.status, 400);
  assert.equal((await api("/api/sms-provider-settings")).data.settings.autoAcquire, true, "invalid save corrupted working settings");
  assert(!logs.includes("fixture-sms-key"));
  console.log("OAUTH_SMS_CONSOLE_PASS opt-in automatic acquire/poll/submit/complete; authenticated private persistence/restart; bounded phone-risk/OTP-risk replacement; split-output dedupe; global429/wrong-OTP/no-stock stop; configurable limit/restart; canceled-order release; invalid-save preservation; no stdout keys");
} finally { releaseHold?.(); await stop(); sms.closeAllConnections(); await new Promise(r => sms.close(r)); await fs.rm(root, { recursive: true, force: true }); }
