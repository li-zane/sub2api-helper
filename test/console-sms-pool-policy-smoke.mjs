import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { smsBowerModesFixture } from "./smsbower-modes-fixture.mjs";
const root = path.resolve(import.meta.dirname, ".."), dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-pool-policy-"));
let child, headers, logs = "", single = false, denyOnce = false; const buys = [], statuses = [];
const sms = http.createServer((req, res) => {
  const u = new URL(req.url, "http://fixture"), action = u.searchParams.get("action"), { prices, catalog } = smsBowerModesFixture();
  prices[12] = { dr: { 3209: { provider_id: 3209, price: 0.004, count: 1000 } } };
  catalog.services[247].countries.virtual = { title: "United States (virtual)", activate_org_code: "12", positions: { virtual: { price: 0.004, rank: { description: "gold" }, count: 1000, agent_ids: [3209] } } };
  if (single) { delete prices[73].dr[3253]; delete prices[73].dr[3328]; }
  if (u.searchParams.has("serviceId")) return res.end(JSON.stringify(catalog));
  if (action === "getPricesV3") return res.end(JSON.stringify(u.searchParams.has("country") ? { [u.searchParams.get("country")]: prices[u.searchParams.get("country")] } : prices));
  if (action === "getNumberV2") { const id = "paid-" + (buys.length + 1); buys.push({ id, country: u.searchParams.get("country"), providerId: u.searchParams.get("providerIds") }); return res.end(JSON.stringify({ activationId: id, phoneNumber: "1202555" + String(buys.length).padStart(4, "0"), activationCost: u.searchParams.get("maxPrice") })); }
  if (action === "getStatus") return res.end("STATUS_OK:654321");
  if (action === "setStatus") { const item = { id: u.searchParams.get("id"), status: u.searchParams.get("status") }; statuses.push(item); if (item.status === "8" && denyOnce) { denyOnce = false; return res.end("EARLY_CANCEL_DENIED"); } return res.end("ACCESS_READY"); }
  res.end("BAD_ACTION");
});
const listen = async s => { await new Promise(r => s.listen(0, "127.0.0.1", r)); return s.address().port; };
await listen(sms); const socket = http.createServer(), port = await listen(socket); await new Promise(r => socket.close(r)); const base = `http://127.0.0.1:${port}`;
const wait = async fn => { for (const end = Date.now() + 20000; Date.now() < end;) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 40)); } throw Error("fixture timed out\n" + logs); };
const api = async (url, body) => { const r = await fetch(base + url, { headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() }; };
const job = async id => (await api("/api/jobs")).data.jobs.find(j => j.id === id);
const waitJob = (id, fn) => wait(async () => { const j = await job(id); return j && fn(j) && j; });
const create = async prefix => { const r = await api("/api/jobs", { email: prefix + "@example.test" }); assert.equal(r.status, 201); return r.data.job.id; };
const metadata = async id => JSON.parse(await fs.readFile(path.join(dir, id, "job-meta.json"), "utf8"));
const config = mode => ({ apiKey: "fixture-sms-key", service: "DR", country: "73", selectionMode: mode, maxPrice: "0.04" });
const settings = (limit, mode = "global", maxAutoNumbers = 8) => api("/api/sms-provider-settings", { settings: { selectedProviderId: "smsbower", autoAcquire: true, maxAutoNumbers, ...(limit === undefined ? {} : { maxFailuresPerPool: limit }), configs: { smsbower: config(mode) } } });
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: dir, LOCALAPPDATA: dir, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(dir, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), ONBOARDING_PROTOCOL_SCRIPT: path.join(root, "test/mock-sms-pool-protocol.mjs"), SMSBOWER_API_BASE: `http://127.0.0.1:${sms.address().port}/api`, SMSBOWER_CATALOG_BASE: `http://127.0.0.1:${sms.address().port}/catalog`, SMS_POLL_INTERVAL_MS: "20", TOSUB2_SMS_CANCEL_RETRY_MS: "100", SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", d => logs += d); child.stderr.on("data", d => logs += d);
  const b = await wait(async () => { try { const r = await fetch(base + "/api/bootstrap"); return r.ok && r.json(); } catch { return null; } }); headers = { "x-console-token": b.token, "content-type": "application/json" };
}
async function stop() { if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; } }
try {
  await start(); assert.equal((await api("/api/sms-provider-settings")).data.settings.maxFailuresPerPool, 2); assert.equal((await settings()).status, 200);
  let before = buys.length, id = await create("pool-two"); await waitJob(id, j => j.status === "completed");
  assert.deepEqual(buys.slice(before).map(o => o.providerId), ["3243", "3243", "3253"], "two rejections must advance to the next pool");
  const m = await metadata(id); assert.equal(m.sms_pool_policy.failures["dr|73|3243"], 2); assert(!JSON.stringify(m.sms_pool_policy).includes("fixture-sms-key"));
  const history = (await api(`/api/jobs/${id}/logs`)).data.logs; assert.match(history, /明确拒绝 2\/2 次；达到阈值/);
  await settings(1); before = buys.length; id = await create("pool-one"); await waitJob(id, j => j.status === "completed"); assert.deepEqual(buys.slice(before).map(o => o.providerId), ["3243", "3253"]);
  await settings(10); before = buys.length; id = await create("pool-voip"); await waitJob(id, j => j.status === "completed"); assert.deepEqual(buys.slice(before).map(o => o.providerId), ["3243", "3253"]); assert.match((await api(`/api/jobs/${id}/logs`)).data.logs, /上游禁止 VoIP，立即排除/);
  await settings(2); before = buys.length; id = await create("pool-duplicate"); await waitJob(id, j => j.status === "completed"); assert.deepEqual(buys.slice(before).map(o => o.providerId), ["3243", "3243"]); assert.equal((await metadata(id)).sms_pool_policy.failures["dr|73|3243"], 1);
  await settings(1); before = buys.length; id = await create("pool-otp"); await waitJob(id, j => j.status === "completed"); assert.deepEqual(buys.slice(before).map(o => o.providerId), ["3243", "3253"]);
  for (const prefix of ["pool-rate", "pool-wrong"]) { before = buys.length; id = await create(prefix); await waitJob(id, j => j.smsStatus === "error"); await new Promise(r => setTimeout(r, 150)); assert.equal(buys.length - before, 1); assert.deepEqual((await metadata(id)).sms_pool_policy.failures, {}); await api(`/api/jobs/${id}/cancel`, {}); }
  single = true; await settings(1, "country"); before = buys.length; id = await create("pool-fixed"); await waitJob(id, j => j.smsStatus === "error" && /非虚拟/.test(j.smsError || "")); assert.equal(buys.length - before, 1); assert(buys.slice(before).every(o => o.country === "73"));
  const manual = await api(`/api/jobs/${id}/sms-number`, { providerId: "smsbower", config: config("country") }); assert.equal(manual.status, 502); assert.equal(buys.length - before, 1, "manual take-number bypassed current task exclusions");
  await api(`/api/jobs/${id}/cancel`, {}); before = buys.length; assert.equal((await api(`/api/jobs/${id}/retry`, {})).status, 200); await waitJob(id, j => j.smsStatus === "error" && /非虚拟/.test(j.smsError || "")); assert.equal(buys.length - before, 1, "new authorization did not reset pool state"); await api(`/api/jobs/${id}/cancel`, {});
  single = false; await settings(10, "global", 2); before = buys.length; id = await create("pool-all"); await waitJob(id, j => /上限 2 次/.test(j.prompt || "")); assert.equal(buys.length - before, 2); await api(`/api/jobs/${id}/cancel`, {});
  await api("/api/sms-provider-settings", { settings: { selectedProviderId: "smsbower", autoAcquire: false, maxFailuresPerPool: 10, configs: { smsbower: config("global") } } });
  before = buys.length; id = await create("pool-voip-manual"); await waitJob(id, j => j.status === "phone");
  assert.equal((await api(`/api/jobs/${id}/input`, { action: "phone", value: "+12025550123" })).status, 200);
  const manualPhone = await waitJob(id, j => /VoIP/.test(j.phoneError || "")); assert(!manualPhone.phoneError.includes("已排除")); assert.equal(buys.length, before);
  assert.equal((await metadata(id)).sms_pool_policy, null); await api(`/api/jobs/${id}/cancel`, {}); await settings(10);
  assert(buys.every(o => o.country !== "12" && o.providerId !== "3209"), "virtual pool was purchased");
  assert.equal((await settings(0)).status, 400); assert.equal((await api("/api/sms-provider-settings")).data.settings.maxFailuresPerPool, 10);
  await stop(); await start(); assert.equal((await api("/api/sms-provider-settings")).data.settings.maxFailuresPerPool, 10); assert(!logs.includes("fixture-sms-key"));
  console.log("SMS_POOL_HTTP_PASS threshold2/1/config persistence; VoIP immediate; virtual never purchased; duplicate/order/OTP dedupe; global429/wrongOTP no blacklist; fixed-country no cross; manual honors exclusions; new auth reset; total cap preserved; private durable policy; manual phone has no false pool claim");
} finally { await stop(); sms.closeAllConnections(); await new Promise(r => sms.close(r)); assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); }
