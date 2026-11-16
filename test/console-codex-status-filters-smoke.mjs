import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { recentIntervals } from "../src/overload-monitor.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-codex-filters-"));
const now = Date.now(), at = new Date(now - 1000).toISOString();
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const email = n => `codex-filter-${n}@example.test`;
const overload = {}, fingerprints = {}, records = [];
const variants = [
  { n: 46, plan: "free", fingerprint: true, overload: false, verdict: "match", count: 0 },
  { n: 47, fingerprint: false, overload: false, verdict: "mismatch", count: 10 },
  { n: 48, schedulable: false, verdict: "match", count: 10 },
  { n: 49, missing: true, verdict: "match", count: 0 },
  { n: 50, remoteStatus: "error", verdict: "mismatch", count: 0 },
  { n: 51, rateLimited: true, verdict: "match", count: 10 },
  { n: 52, quotaRestricted: true, verdict: "match", count: 0 },
  { n: 53, banned: true, verdict: "mismatch", count: 10 },
  { n: 54, fingerprint: false, verdict: "match", count: 0 },
  { n: 55, overload: false, verdict: "match", count: 10 },
  { n: 56, verdict: "unknown", count: null },
];
const cases = Array.from({ length: 45 }, (_, i) => ({ n: i + 1,
  plan: (i + 1) % 2 ? "team" : "business", verdict: (i + 1) % 4 === 1 ? "mismatch" : (i + 1) % 4 === 3 ? "unknown" : "match" })).concat(variants);
const expectedBase = predicate => cases.filter(c => c.n <= 45 && predicate(c.n)).map(c => email(c.n));
let child, base, headers, logs = "";
const pool = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  // Preserve seeded statistics while exercising real enabled monitor switches.
  if (req.url.includes("/ops/")) { res.statusCode = 503; return res.end("{}"); }
  if (req.url.startsWith("/api/v1/admin/accounts?")) return res.end(JSON.stringify({ data: { items: records, total: records.length, pages: 1 } }));
  return res.end("[]");
});
const listen = server => new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port)));
async function get(suffix = "") {
  const response = await fetch(base + "/api/jobs" + suffix, { headers }); assert.equal(response.status, 200); return response.json();
}
try {
  const poolBase = `http://127.0.0.1:${await listen(pool)}`;
  const backend = crypto.createHash("sha256").update(poolBase + "\0fixture").digest("hex").slice(0, 24);
  for (const c of cases) {
    const { n } = c, plan = c.plan || "team";
    const folder = path.join(root, id(n)); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "job-meta.json"), JSON.stringify({ version: 1, email: email(n), status: c.banned ? "banned" : "completed", plan_type: plan }));
    const counts = n > 45 ? [0, 0, 0, 0, 0, c.count] : n % 4 === 0 ? [0, 0, 0, 0, 0, 0] : n % 4 === 1 ? [0, 0, 0, 0, 0, 10] : n % 4 === 2 ? [6, 6, 6, 6, 6, 0] : [];
    overload[email(n)] = { enabled: c.overload !== false, updatedAt: at, overloadUpdatedAt: at,
      points: recentIntervals(now - 1000, 15).map((point, i) => ({ ...point, count: counts[i] ?? null })) };
    fingerprints[email(n)] = { override: { enabled: c.fingerprint ?? null }, recentResults: [
      { checkedAt: at, status: c.verdict, method: n % 2 ? "candy" : "fingerprint" },
      { checkedAt: new Date(now - 10000).toISOString(), status: "match", method: "candy" },
    ] };
    if (!c.missing) records.push({ id: n, name: email(n), platform: "openai", type: "oauth", status: c.remoteStatus || "active", schedulable: c.schedulable !== false,
      ...(c.rateLimited ? { rate_limit_reset_at: new Date(now + 3600000).toISOString() } : {}),
      ...(c.quotaRestricted ? { extra: { codex_5h_used_percent: 100 } } : {}),
      credentials: { email: email(n), plan_type: plan } });
  }
  await fs.writeFile(path.join(root, "overload-monitor.json"), JSON.stringify({ version: 2, backend, accounts: overload }));
  await fs.writeFile(path.join(root, "model-fingerprint.json"), JSON.stringify({ version: 1, settings: { enabledPlanTypes: ["team", "business"] }, accounts: fingerprints }));
  await fs.writeFile(path.join(root, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: poolBase, adminApiKey: "fixture" }, profiles: [] }));
  const server = path.resolve(process.env.CODEX_FILTER_SERVER || "src/console-server.mjs");
  const loaderPath = path.join(root, "cache-invalidation-loader.mjs"), registerPath = path.join(root, "register.mjs");
  // Deterministically reproduce a policy update invalidating the shared cache
  // after the list loaded it, before filtering, pagination and row rendering.
  await fs.writeFile(loaderPath, `export async function load(url, context, nextLoad) {
    const loaded = await nextLoad(url, context);
    if (url !== ${JSON.stringify(pathToFileURL(server).href)}) return loaded;
    const anchor = "await Promise.all(allJobs.map(inspectAccountWebSession));";
    const source = String(loaded.source);
    if (!source.includes(anchor)) throw Error("List snapshot test anchor missing");
    return { ...loaded, source: source.replace(anchor, anchor + "\\n  invalidateSub2ApiAccountStatusCache();") };
  }`);
  await fs.writeFile(registerPath, `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(loaderPath).href)});`);
  const loaderArgs = process.env.CODEX_FILTER_BASELINE === "1" ? [] : ["--import", pathToFileURL(registerPath).href];
  const listener = http.createServer(), port = await listen(listener); await new Promise(r => listener.close(r)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [...loaderArgs, server, "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: root,
      LOCALAPPDATA: root, TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"),
      TOSUB2_CREDENTIAL_KEY: "ab".repeat(32), SUB2API_MONITOR_ENABLED: "0" } });
  child.stdout.on("data", b => logs += b); child.stderr.on("data", b => logs += b);
  for (const end = Date.now() + 20000; Date.now() < end;) {
    if (child.exitCode !== null) throw Error(logs);
    try { const response = await fetch(base + "/api/bootstrap"), data = await response.json(); if (data.token) { headers = { "x-console-token": data.token, "content-type": "application/json" }; break; } } catch {}
    await new Promise(r => setTimeout(r, 40));
  }
  assert(headers, logs);
  const all = await get();
  const by = (predicate, extra = []) => [...expectedBase(predicate), ...extra.map(email)].sort();
  assert.equal(all.pagination.total, 56);
  // Historical data remains available in All, even when excluded from status filters.
  const hidden = await get("?search=codex-filter-46@");
  assert.equal(hidden.jobs[0].modelFingerprint.enabled, false);
  assert.equal(hidden.jobs[0].modelFingerprint.recentResults[0].status, "match");
  if (process.env.CODEX_FILTER_BASELINE === "1") {
    assert((await get("?fingerprint=match")).selection.some(j => j.email === email(46)));
    assert((await get("?overload=normal")).selection.some(j => j.email === email(46)));
    console.log("BASELINE_HTTP_REPRODUCED disabled_plan_history_included=true disabled_overload_history_included=true");
  } else {
    for (const [query, predicate, extra = []] of [
      ["overload=overloaded", n => n % 4 === 1 || n % 4 === 2], ["overload=normal", n => n % 4 === 0, [54]],
      ["fingerprint=match", n => n % 4 === 0 || n % 4 === 2, [55]], ["fingerprint=mismatch", n => n % 4 === 1],
      ["overload=overloaded&fingerprint=match", n => n % 4 === 2], ["overload=normal&fingerprint=mismatch", () => false],
      ["overload=overloaded&fingerprint=mismatch&planType=team", n => n % 4 === 1],
    ]) {
      const result = await get("?" + query); assert.deepEqual(result.selection.map(j => j.email).sort(), by(predicate, extra), query);
      assert.equal(result.pagination.total, by(predicate, extra).length); assert.equal(result.filter.active, true);
      assert.deepEqual(result.stats, all.stats, "filter changed global statistics");
    }
    const first = await get("?overload=overloaded"), second = await get("?overload=overloaded&page=2");
    assert.equal(first.jobs.length, 20); assert.equal(second.jobs.length, 3);
    assert.equal(new Set([...first.jobs, ...second.jobs].map(j => j.id)).size, 23);
    const response = await fetch(base + "/api/jobs/query", { method: "POST", headers,
      body: JSON.stringify({ emails: [email(1), email(2), email(3)], overload: "overloaded", fingerprint: "match" }) });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).jobs.map(j => j.email), [email(2)]);
    assert.equal((await get("?overload=invalid&fingerprint=invalid")).pagination.total, 56);
    assert.equal((await get("?overload=overloaded&search=codex-filter-45@")).jobs[0].email, email(45));
    for (const query of ["fingerprint=match", "fingerprint=mismatch", "overload=normal", "overload=overloaded"]) {
      const result = await get("?" + query), key = query.startsWith("fingerprint") ? "modelFingerprint" : "overloadDetection";
      for (const j of result.jobs) { assert.equal(j.codexStatusEligible, true, j.email); assert.equal(j[key].enabled, true, j.email); }
      for (const j of result.selection) { assert.equal(j.sub2apiInPool, true, j.email); assert.equal(j.sub2apiEnabled, true, j.email); }
    }
    const update = await fetch(base + "/api/model-fingerprint/settings", { method: "POST", headers,
      body: JSON.stringify({ settings: { enabledPlanTypes: ["team", "business", "free"] } }) });
    assert.equal(update.status, 200);
    assert((await get("?fingerprint=match")).selection.some(j => j.email === email(46)), "explicitly enabled free policy was excluded");
    console.log("CODEX_FILTER_HTTP_PASS all56 cross-page23; disabled/plan/absent/paused/error/banned/rate/quota excluded; independent switches; enabled-free supported; cache invalidation preserves filters, rows and selection");
  }
} finally {
  if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; }
  await new Promise(r => pool.close(r)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
