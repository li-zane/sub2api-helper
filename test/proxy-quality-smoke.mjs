import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProxyQualityService, normalizeReputation } from "../src/proxy-quality.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-proxy-quality-"));
const output = path.join(temp, "output");
const proxyRequests = [];
const reputationRequests = [];
const heldResponses = [];
let mode = "stable";
let sampleNumber = 0;
let reputationMode = "normal";
let child;
let logs = "";
let headers;
const ipA = "198.51.100.10";
const ipB = "198.51.100.20";
const proxy = http.createServer((req, res) => {
  const auth = Buffer.from((req.headers["proxy-authorization"] || "").slice(6), "base64").toString();
  const route = new URL(req.url);
  proxyRequests.push({ auth, host: route.hostname, path: route.pathname });
  sampleNumber++;
  const send = () => {
    res.setHeader("content-type", "application/json");
    if (mode === "failed" || (mode === "partial" && sampleNumber % 2 === 1)) { res.writeHead(502); res.end("upstream secret fixture-user:fixture-password"); return; }
    res.end(JSON.stringify({ ip: mode === "invalid" ? "not-an-ip" : mode === "changed" && sampleNumber % 2 === 0 ? ipB : ipA }));
  };
  if (mode === "held") heldResponses.push(send); else if (mode === "timeout") setTimeout(send, 3000); else send();
});
const reputation = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  const ip = decodeURIComponent(url.pathname.split("/").at(-1));
  reputationRequests.push({ ip, auth: req.headers.authorization, proxyAuth: req.headers["proxy-authorization"], query: url.search });
  res.setHeader("content-type", "application/json");
  if (reputationMode === "unavailable") { res.writeHead(429); res.end('{"status":"denied","message":"quota"}'); return; }
  if (reputationMode === "malformed") { res.end('{"status":"ok","203.0.113.99":{"risk":0}}'); return; }
  res.end(JSON.stringify({ status: "ok", [ip]: reputationMode === "missing" ? { country: "Fixture", type: "Business" } : {
    proxy: ip === ipB ? "yes" : "no", type: ip === ipB ? "VPN" : "Residential", risk: ip === ipB ? 95 : 0,
    country: "Fixture", region: "Test Region", city: "Test City", asn: "AS64500", provider: "Fixture ISP",
  } }));
});
await Promise.all([listen(proxy), listen(reputation)]);
const proxyUrl = `http://fixture-user-sid-original:fixture-password@127.0.0.1:${proxy.address().port}/`;
const proxies = [1, 2, 3].map(id => ({ id, name: id === 1 ? "住宅出口 A" : `测试节点 ${id}`, protocol: "http", host: "127.0.0.1", port: proxy.address().port, username: id === 1 ? "fixture-user-sid-original" : `fixture-user-${id}`, password: "fixture-password", ip_address: ipA, status: "active" }));
const pool = http.createServer(async (req, res) => {
  for await (const unused of req) {}
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/api/v1/admin/proxies/all")) return res.end(JSON.stringify(proxies));
  if (req.url.startsWith("/api/v1/admin/groups/all")) return res.end("[]");
  if (req.url.startsWith("/api/v1/admin/accounts")) return res.end('{"data":{"items":[],"total":0,"pages":1}}');
  res.end("{}");
});
await listen(pool);
const exitUrl = "http://exit.fixture.invalid/ip";
const reputationUrl = `http://127.0.0.1:${reputation.address().port}/v2/`;
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

try {
  assert.equal(normalizeReputation({ risk: "" }).riskScore, null, "empty score stays unknown");
  assert.equal(normalizeReputation({ risk: null }).riskLevel, "unknown", "null does not become a clean score");
  assert.equal(normalizeReputation({ risk: 101 }).riskScore, null, "out-of-range score stays unknown");
  assert.equal(normalizeReputation({}).proxy, null);
  child = spawn(process.execPath, [path.join(root, "src/console-server.mjs"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, windowsHide: true, env: { ...process.env, NODE_ENV: "test", LOCALAPPDATA: path.join(temp, "local"), ONBOARDING_OUTPUT_ROOT: output, TOSUB2_TLS_PROFILE: "chrome142", TOSUB2_PROXY_EXIT_CHECK_URL: exitUrl, TOSUB2_PROXY_REPUTATION_URL: reputationUrl, TOSUB2_PROXY_CHECK_TIMEOUT_MS: "2000" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", data => { logs = `${logs}${data}`.slice(-12000); });
  child.stderr.on("data", data => { logs = `${logs}${data}`.slice(-12000); });
  await waitFor(async () => {
    const r = await fetch(`${base}/api/bootstrap`).catch(() => null);
    if (!r?.ok) return false;
    const bootstrap = await r.json();
    assert.equal(bootstrap.features.proxyQuality, true);
    headers = { "x-console-token": bootstrap.token, "content-type": "application/json" };
    return true;
  });
  assert.equal((await fetch(`${base}/api/proxy-quality/check`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"target":"global"}' })).status, 403);
  assert.equal((await post("/api/proxy-quality/check", { target: "global" })).status, 409);
  assert.equal((await post("/api/proxy-quality/check", { target: "direct" })).status, 400);
  assert.equal((await post("/api/proxy-quality/check", { target: "sub2api", proxyId: "bad" })).status, 400);
  assert.equal((await post("/api/account-proxy-settings", { proxyUrl, allowDirectFallback: true })).status, 200);
  assert.equal((await post("/api/sub2api/settings", { config: { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture-key" } })).status, 200);
  assert.equal((await post("/api/proxy-quality/check", { target: "sub2api", proxyId: 99 })).status, 404);
  const before = await (await fetch(`${base}/api/account-proxy-settings`, { headers })).json();
  const initialJobs = (await (await fetch(`${base}/api/jobs`, { headers })).json()).jobs;
  const result = await post("/api/proxy-quality/check", { target: "global", proxyUrl: "http://ignored.invalid" });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.status, "ok");
  assert.equal(result.body.result.stable, true);
  assert.equal(result.body.result.successCount, 2);
  assert.equal(result.body.result.exits[0].ip, ipA);
  assert.equal(result.body.result.exits[0].riskScore, 0);
  assert.equal(result.body.result.exits[0].provider, "Fixture ISP");
  assert.equal(result.body.result.sessionRotation, "rotated");
  const firstAuth = proxyRequests[0].auth;
  assert.notEqual(firstAuth, "fixture-user-sid-original:fixture-password", "global diagnostics rotate the saved session");
  assert.match(firstAuth, /^fixture-user-sid-[A-Za-z0-9]{8}:fixture-password$/);
  assert(proxyRequests.every(item => item.auth === firstAuth), "both exit samples share the same fresh session");
  assert(proxyRequests.every(item => item.host === "exit.fixture.invalid"), "exit request traverses the selected proxy");
  assert.equal(proxyRequests.length, 2);
  assert.equal(reputationRequests.length, 1);
  assert(reputationRequests.every(item => !item.auth && !item.proxyAuth));
  assert(!JSON.stringify(result.body).includes("fixture-password"));
  assert(!JSON.stringify(result.body).includes(firstAuth.split(":")[0]), "rotation metadata does not expose usernames");
  const repeated = await post("/api/proxy-quality/check", { target: "global" });
  assert.equal(repeated.body.result.sessionRotation, "rotated");
  assert.notEqual(proxyRequests[2].auth, firstAuth, "each later global check uses another fresh session");
  assert.equal(proxyRequests[2].auth, proxyRequests[3].auth);
  assert.equal(reputationRequests.length, 1, "fresh exit requests still share IP reputation cache");
  mode = "changed";
  sampleNumber = 0;
  const changed = await post("/api/proxy-quality/check", { target: "sub2api", proxyId: 1 });
  assert.equal(changed.body.result.sessionRotation, "fixed");
  assert(proxyRequests.slice(-2).every(item => item.auth === "fixture-user-sid-original:fixture-password"), "Sub2API nodes keep their exact configured session");
  assert.equal(changed.body.target.name, "住宅出口 A");
  assert.equal(changed.body.result.stable, false);
  assert.deepEqual(changed.body.result.exits.map(exit => exit.ip), [ipA, ipB]);
  assert.equal(changed.body.result.exits[1].riskScore, 95);
  assert.equal(changed.body.result.exits[1].riskLevel, "high");
  assert.equal(changed.body.result.exits[1].vpn, true);
  assert.equal(reputationRequests.length, 2, "reputation cache reuses the previously queried IP");
  mode = "partial"; sampleNumber = 0;
  const partial = await post("/api/proxy-quality/check", { target: "global" });
  assert.equal(partial.body.result.status, "partial");
  assert.equal(partial.body.result.stable, null);
  for (const failedMode of ["failed", "invalid", "timeout"]) {
    mode = failedMode;
    const failed = await post("/api/proxy-quality/check", { target: "global" });
    assert.equal(failed.body.result.status, "failed");
    assert.equal(failed.body.result.exits.length, 0);
    assert(!JSON.stringify(failed.body).includes("fixture-password"), "upstream errors never echo credentials");
  }
  mode = "held";
  const count = proxyRequests.length;
  const first = post("/api/proxy-quality/check", { target: "global" });
  await waitFor(() => proxyRequests.length > count);
  const duplicate = post("/api/proxy-quality/check", { target: "global" });
  const second = post("/api/proxy-quality/check", { target: "sub2api", proxyId: 2 });
  await waitFor(() => proxyRequests.some((entry, i) => i >= count && entry.auth === "fixture-user-2:fixture-password"));
  const excess = await post("/api/proxy-quality/check", { target: "sub2api", proxyId: 3 });
  assert.equal(excess.status, 429);
  mode = "stable";
  for (const send of heldResponses.splice(0)) send();
  const concurrent = await Promise.all([first, duplicate, second]);
  assert(concurrent.every(item => item.status === 200));
  assert.equal(proxyRequests.length - count, 4, "duplicate checks share a transport; only two unique proxies run");
  mode = "held";
  const isolatedCount = proxyRequests.length;
  const rotating = post("/api/proxy-quality/check", { target: "global" });
  await waitFor(() => proxyRequests.length > isolatedCount);
  const fixed = post("/api/proxy-quality/check", { target: "sub2api", proxyId: 1, rotateSession: true });
  await waitFor(() => proxyRequests.length === isolatedCount + 2);
  mode = "stable";
  for (const send of heldResponses.splice(0)) send();
  const isolated = await Promise.all([rotating, fixed]);
  assert.deepEqual(isolated.map(item => item.body.result.sessionRotation), ["rotated", "fixed"], "global and fixed checks never share rotated results; client override ignored");
  assert.equal(proxyRequests.length - isolatedCount, 4);
  assert.equal(proxyRequests.slice(isolatedCount).filter(item => item.auth === "fixture-user-sid-original:fixture-password").length, 2);
  mode = "stable";
  const rotationService = new ProxyQualityService({ exitUrl, reputationUrl, profile: "chrome142", timeoutMs: 500 });
  try {
    const kookeeyUrl = `http://fixture-user:fixture-US-12345678-30m@127.0.0.1:${proxy.address().port}/`;
    const passwordRotation = await rotationService.check(kookeeyUrl, { rotateSession: true });
    assert.equal(passwordRotation.sessionRotation, "rotated");
    assert.match(proxyRequests.at(-1).auth, /^fixture-user:fixture-US-\d{8}-30m$/);
    assert.notEqual(proxyRequests.at(-1).auth, "fixture-user:fixture-US-12345678-30m");
    assert.equal(proxyRequests.at(-1).auth, proxyRequests.at(-2).auth);
    const unsupported = await rotationService.check(`http://plain:fixture@127.0.0.1:${proxy.address().port}/`, { rotateSession: true });
    assert.equal(unsupported.sessionRotation, "unsupported");
    assert.equal(proxyRequests.at(-1).auth, "plain:fixture");
  } finally { await rotationService.close(); }
  for (const state of ["missing", "unavailable", "malformed"]) {
    reputationMode = state;
    const service = new ProxyQualityService({ exitUrl, reputationUrl, profile: "chrome142", timeoutMs: 500 });
    try {
      const unknown = await service.check(proxyUrl);
      assert.equal(unknown.status, "ok", "reputation failure preserves measured exit connectivity");
      assert.equal(unknown.exits[0].riskScore, null);
      assert.equal(unknown.exits[0].riskLevel, "unknown");
      assert.equal(unknown.exits[0].available, state === "missing");
    } finally { await service.close(); }
  }
  reputationMode = "normal";
  const service = new ProxyQualityService({ exitUrl, reputationUrl, profile: "chrome142", timeoutMs: 500 });
  mode = "timeout";
  const closingCheck = service.check(proxyUrl);
  await waitFor(() => service.running.size === 1);
  await service.close();
  await assert.rejects(closingCheck, /abort|closed/i);
  assert.equal(service.running.size, 0);
  mode = "stable";
  assert.deepEqual(await (await fetch(`${base}/api/account-proxy-settings`, { headers })).json(), before, "diagnostics preserve proxy/fallback settings");
  assert.deepEqual((await (await fetch(`${base}/api/jobs`, { headers })).json()).jobs, initialJobs, "diagnostics do not change jobs or bindings");
  console.log("PASS: fresh global session per check, two samples share session, fixed node isolation, username/password rotation, unsupported format reporting; latency/reputation/errors/concurrency/shutdown; saved proxy and bindings unchanged");
  if (process.argv.includes("--serve")) {
    await post("/api/task-settings", { accountProxyMode: "plan" });
    const fixture = { url: base, output, temp, proxyUrl, proxyPort: proxy.address().port };
    if (process.env.PROXY_QUALITY_FIXTURE_FILE) await fs.writeFile(process.env.PROXY_QUALITY_FIXTURE_FILE, JSON.stringify(fixture));
    console.log(`UI_FIXTURE=${base}`);
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} catch (error) { error.message += `\n${logs}`; throw error; }
finally {
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await exited; }
  await Promise.all([proxy, reputation, pool].map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
  await fs.rm(temp, { recursive: true, force: true });
}
async function post(route, body) { const r = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
function listen(server) { return new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); }
async function freePort() { const server = net.createServer(); await listen(server); const p = server.address().port; await new Promise(resolve => server.close(resolve)); return p; }
async function waitFor(predicate) { const until = Date.now() + 20_000; while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("Timed out waiting for proxy quality fixture"); }
