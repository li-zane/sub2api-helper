import "./legacy-import-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-reset-credit-"));
const output = path.join(temp, "output");
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();
const records = [
  { id: 101, email: "free-cards@example.test", plan: "free", extra: {
    keep: "unchanged", codex_fingerprint_mode: "full", auto_reset_credit_enabled: false,
    auto_reset_credit_5h_threshold: 0.75, auto_reset_credit_7d_threshold: 0.9,
    codex_auto_reset_credit_state: { status: "available", private: "runtime" },
    codex_reset_credit_snapshot: { available_count: 3, credits: [{ expires_at: past }, { expires_at: future }, { expires_at: future }] },
    codex_5h_used_percent: 28, codex_usage_updated_at: new Date().toISOString(),
  } },
  { id: 102, email: "plus-cards@example.test", plan: "plus", extra: { auto_reset_credit_enabled: true, codex_reset_credit_snapshot: { available_count: 0 } } },
  { id: 103, email: "unknown-cards@example.test", plan: "unknown", extra: {} },
].map(r => ({ ...r, name: r.email, platform: "openai", type: "oauth", status: "active", schedulable: true,
  credentials: { email: r.email, plan_type: r.plan, access_token: "fixture-token", refresh_token: "fixture-refresh" }, group_ids: [] }));
const calls = [];
let liveCount = 4;
let quotaAvailable = false;
let child;
let headers;
let logs = "";
const pool = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}"); calls.push({ method: req.method, path: req.url, body });
  res.setHeader("content-type", "application/json");
  const send = data => res.end(JSON.stringify({ code: 0, data }));
  if (req.url.startsWith("/api/v1/admin/accounts?") && req.method === "GET") return send({ items: records, total: records.length, pages: 1 });
  if (req.url.includes("/groups/all") || req.url.includes("/proxies/all")) return send([]);
  if (req.url.includes("/quota/refresh") && req.method === "POST") {
    if (!quotaAvailable) { res.statusCode = 503; return send({ message: "fixture unavailable" }); }
    return send({ fetched_at: Math.floor(Date.now() / 1000), rate_limit_reset_credits: liveCount === null ? null : { available_count: liveCount, credits: Array.from({ length: liveCount }, () => ({ expires_at: future, id: "private-credit-id" })) } });
  }
  if (req.url.includes("/usage?") && req.method === "GET") return send({ five_hour: { utilization: 37 }, fetched_at: Math.floor(Date.now() / 1000) });
  const match = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(req.url);
  if (match) {
    const record = records.find(r => r.id === Number(match[1]));
    if (req.method === "PUT") { Object.assign(record, body); return send(record); }
    if (req.method === "GET") return send(record);
  }
  res.statusCode = 404; return send({});
});
await new Promise(r => pool.listen(0, "127.0.0.1", r));
const slot = http.createServer(); await new Promise(r => slot.listen(0, "127.0.0.1", r));
const port = slot.address().port; await new Promise(r => slot.close(r));
const base = `http://127.0.0.1:${port}`;
const config = { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture-key", groupIds: [] };
let profiles = [{ id: "default", name: "Free", autoResetCreditEnabled: false }, { id: "paid", name: "Plus", autoResetCreditEnabled: true, autoResetCredit5hThresholdPercent: 90, autoResetCredit7dThresholdPercent: 95 }];
const body = () => ({ config, profiles, activeProfileId: "default", planTypeBindings: { free: "default", plus: "paid" } });
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: output,
      LOCALAPPDATA: temp, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(temp, "credentials"), TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(temp, "credentials"), SUB2API_MONITOR_ENABLED: "0" },
  });
  child.stdout.on("data", c => { logs += c; }); child.stderr.on("data", c => { logs += c; });
  let boot; await waitFor(async () => { try { const r = await fetch(base + "/api/bootstrap"); if (r.ok) boot = await r.json(); return Boolean(boot); } catch { return false; } });
  headers = { "x-console-token": boot.token, "content-type": "application/json" };
}
async function stop() { if (child && child.exitCode === null) { const exited = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await exited; } }
async function post(url, data) { const r = await fetch(base + url, { method: "POST", headers, body: JSON.stringify(data) }); return { status: r.status, data: await r.json() }; }
async function get(url) { const r = await fetch(base + url, { headers }); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; }
try {
  await start();
  let result = await post("/api/sub2api/settings", body()); assert.equal(result.status, 200);
  assert.equal(result.data.profiles.find(p => p.id === "paid").autoResetCreditEnabled, true);
  assert.equal(result.data.profiles.find(p => p.id === "paid").autoResetCredit5hThresholdPercent, 90, "5h threshold is stored per profile");
  assert.equal(result.data.profiles.find(p => p.id === "paid").autoResetCredit7dThresholdPercent, 95);
  assert.equal(result.data.profiles.find(p => p.id === "default").autoResetCredit5hThresholdPercent, 100, "legacy profile defaults to 100%");
  await get("/api/sub2api/account-status?refresh=1");
  let page = await get("/api/jobs"); const free = page.jobs.find(j => j.email === records[0].email);
  assert(free?.canDownload);
  assert.equal(free.sub2apiUsage.resetCredits.availableCount, 2, "expired cached cards are omitted");
  assert.equal(page.jobs.find(j => j.email === records[1].email).sub2apiUsage.resetCredits.availableCount, 0);
  const unknownUsage = page.jobs.find(j => j.email === records[2].email).sub2apiUsage;
  assert.equal(unknownUsage?.primary ?? null, null, "accounting metadata must not invent quota windows");
  assert.equal(unknownUsage?.totals?.tokens ?? null, null, "unavailable accounting must not become zero");
  profiles[0].autoResetCreditEnabled = true;
  const before = calls.length; result = await post("/api/sub2api/settings", body()); assert.equal(result.status, 200);
  const puts = calls.slice(before).filter(c => c.method === "PUT"); assert.equal(puts.length, 1);
  assert.equal(puts[0].path, "/api/v1/admin/accounts/101");
  assert.equal(puts[0].body.extra.auto_reset_credit_enabled, true);
  assert.equal(puts[0].body.extra.auto_reset_credit_5h_threshold, 1);
  assert.equal(puts[0].body.extra.auto_reset_credit_7d_threshold, 1);
  assert.equal(puts[0].body.extra.keep, "unchanged");
  assert.equal(puts[0].body.extra.codex_fingerprint_mode, "full", "toggling cards leaves unrelated per-account settings intact");
  assert(!Object.hasOwn(puts[0].body.extra, "codex_auto_reset_credit_state"));
  assert(!Object.hasOwn(puts[0].body, "credentials"));
  profiles[0].autoResetCredit5hThresholdPercent = 75.5;
  profiles[0].autoResetCredit7dThresholdPercent = 92;
  const thresholdStart = calls.length;
  result = await post("/api/sub2api/settings", body()); assert.equal(result.status, 200);
  const thresholdPuts = calls.slice(thresholdStart).filter(c => c.method === "PUT");
  assert.equal(thresholdPuts.length, 1, "threshold-only edits synchronize only the matching PlanType");
  assert.equal(thresholdPuts[0].body.extra.auto_reset_credit_enabled, true);
  assert.equal(thresholdPuts[0].body.extra.auto_reset_credit_5h_threshold, 0.755);
  assert.equal(thresholdPuts[0].body.extra.auto_reset_credit_7d_threshold, 0.92);
  assert.equal(thresholdPuts[0].body.extra.keep, "unchanged");
  assert.equal(thresholdPuts[0].body.extra.codex_fingerprint_mode, "full");
  profiles[0].codexFingerprintMode = "device";
  await post("/api/sub2api/settings", body());
  assert.equal(records[0].extra.auto_reset_credit_5h_threshold, 0.755, "unrelated profile edits retain thresholds");
  profiles[0].autoResetCreditEnabled = false; await post("/api/sub2api/settings", body());
  assert.equal(records[0].extra.auto_reset_credit_enabled, false);
  assert.equal(records[0].extra.auto_reset_credit_5h_threshold, 0.755, "disabling preserves the saved threshold");
  await stop(); await start(); result = { data: await get("/api/sub2api/settings") };
  assert.equal(result.data.profiles.find(p => p.id === "default").autoResetCreditEnabled, false);
  assert.equal(result.data.profiles.find(p => p.id === "paid").autoResetCreditEnabled, true);
  assert.equal(result.data.profiles.find(p => p.id === "default").autoResetCredit5hThresholdPercent, 75.5);
  assert.equal(result.data.profiles.find(p => p.id === "paid").autoResetCredit7dThresholdPercent, 95);
  // Older clients omitting this field preserve the configured value.
  profiles = profiles.map(({ autoResetCreditEnabled, autoResetCredit5hThresholdPercent, autoResetCredit7dThresholdPercent, ...p }) => p); await post("/api/sub2api/settings", body());
  assert.equal((await get("/api/sub2api/settings")).profiles.find(p => p.id === "paid").autoResetCreditEnabled, true);
  assert.equal((await get("/api/sub2api/settings")).profiles.find(p => p.id === "default").autoResetCredit5hThresholdPercent, 75.5);
  const putCount = calls.filter(c => c.method === "PUT").length;
  for (const invalid of [0, 0.01, 100.1, "", "nope", true]) {
    assert.equal((await post("/api/sub2api/settings", { config: { ...config, autoResetCredit5hThresholdPercent: invalid } })).status, 400);
  }
  assert.equal(calls.filter(c => c.method === "PUT").length, putCount, "invalid thresholds never reach upstream accounts");
  profiles[0].autoResetCredit5hThresholdPercent = 0.1;
  profiles[0].autoResetCredit7dThresholdPercent = 100;
  await post("/api/sub2api/settings", body());
  assert.equal(records[0].extra.auto_reset_credit_5h_threshold, 0.001);
  assert.equal(records[0].extra.auto_reset_credit_7d_threshold, 1);
  assert.equal((await post("/api/sub2api/settings", { config: { ...config, autoResetCreditEnabled: "true" } })).status, 400);
  quotaAvailable = true;
  let usage = (await get(`/api/jobs/${free.id}/usage?refresh=1`)).usage;
  assert.equal(usage.resetCredits.availableCount, 4, "explicit refresh reads Sub2API quota endpoint");
  assert.equal(usage.primary.usedPercent, 37);
  assert(!JSON.stringify(usage).includes("private-credit-id"));
  liveCount = null; usage = (await get(`/api/jobs/${free.id}/usage?refresh=1`)).usage;
  assert.equal(usage.resetCredits.availableCount, 4, "unknown response retains last known card count");
  assert.equal(usage.resetCreditsStale, true, "retained count must be identified as cached, not currently verified");
  liveCount = 0; usage = (await get(`/api/jobs/${free.id}/usage?refresh=1`)).usage;
  assert.equal(usage.resetCredits.availableCount, 0, "zero replaces previously positive count");
  assert.equal(usage.resetCreditsStale, false);
  liveCount = null; usage = (await get(`/api/jobs/${free.id}/usage?refresh=1`)).usage;
  assert.equal(usage.resetCredits.availableCount, 0, "unknown is not a new value and must retain the last confirmed zero");
  assert.equal(usage.resetCreditsStale, true);
  quotaAvailable = false; usage = (await get(`/api/jobs/${free.id}/usage?refresh=1`)).usage;
  assert.equal(usage.primary.usedPercent, 37, "older backend without reset-card endpoint retains ordinary usage");
  assert(!calls.some(c => c.path.includes("reset-quota") || c.path.includes("redeem")), "view and refresh never call consume endpoints");
  console.log("PASS: per-profile 5h/7d thresholds, percentage-to-ratio sync, threshold-only PUT, on/off persistence, validation boundaries, legacy/restart retention, card counts and no redemption");
  if (process.argv.includes("--serve")) {
    records[0].extra.codex_reset_credit_snapshot = { available_count: 2, credits: [{ expires_at: future }, { expires_at: future }] };
    quotaAvailable = true; liveCount = 4;
    await get("/api/sub2api/account-status?refresh=1");
    if (process.env.RESET_CREDIT_FIXTURE_FILE) await fs.writeFile(process.env.RESET_CREDIT_FIXTURE_FILE, JSON.stringify({ url: base, output, temp }));
    console.log("UI_FIXTURE=" + base);
    await new Promise(r => { process.once("SIGINT", r); process.once("SIGTERM", r); });
  }
} catch (e) { e.message += "\n" + logs; throw e; }
finally { await stop(); pool.closeAllConnections(); await new Promise(r => pool.close(r)); await fs.rm(temp, { recursive: true, force: true }); }
async function waitFor(fn) { const end = Date.now() + 25000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); } throw new Error("reset credit fixture startup timeout"); }
