import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { recentIntervals } from "../src/overload-monitor.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-codex-filters-"));
const now = Date.now(), at = new Date(now - 1000).toISOString();
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const email = n => `codex-filter-${n}@example.test`;
const overload = {}, fingerprints = {}, records = [];
let child, base, headers, logs = "";
const pool = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
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
  for (let n = 1; n <= 45; n++) {
    const folder = path.join(root, id(n)); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "job-meta.json"), JSON.stringify({ version: 1, email: email(n), status: "completed", plan_type: n % 2 ? "team" : "free" }));
    const counts = n % 4 === 0 ? [0, 0, 0, 0, 0, 0] : n % 4 === 1 ? [0, 0, 0, 0, 0, 10] : n % 4 === 2 ? [6, 6, 6, 6, 6, 0] : [];
    overload[email(n)] = { enabled: false, updatedAt: at, overloadUpdatedAt: at,
      points: recentIntervals(now - 1000, 15).map((point, i) => ({ ...point, count: counts[i] ?? null })) };
    fingerprints[email(n)] = { override: { enabled: false }, recentResults: [
      { checkedAt: at, status: n % 4 === 1 ? "mismatch" : n % 4 === 3 ? "unknown" : "match", method: n % 2 ? "candy" : "fingerprint" },
      { checkedAt: new Date(now - 10000).toISOString(), status: "match", method: "candy" },
    ] };
    records.push({ id: n, name: email(n), platform: "openai", type: "oauth", status: "active", schedulable: true,
      credentials: { email: email(n), plan_type: n % 2 ? "team" : "free" } });
  }
  await fs.writeFile(path.join(root, "overload-monitor.json"), JSON.stringify({ version: 2, backend, accounts: overload }));
  await fs.writeFile(path.join(root, "model-fingerprint.json"), JSON.stringify({ version: 1, settings: { enabledPlanTypes: [] }, accounts: fingerprints }));
  await fs.writeFile(path.join(root, "sub2api-settings.json"), JSON.stringify({ version: 2, config: { baseUrl: poolBase, adminApiKey: "fixture" }, profiles: [] }));
  const listener = http.createServer(), port = await listen(listener); await new Promise(r => listener.close(r)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [process.env.CODEX_FILTER_SERVER || "src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
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
  const all = await get(), by = predicate => records.filter(a => predicate(a.id)).map(a => a.name).sort();
  assert.equal(all.pagination.total, 45);
  if (process.env.CODEX_FILTER_BASELINE === "1") {
    assert.equal((await get("?overload=overloaded&fingerprint=mismatch")).pagination.total, 45);
    console.log("CODEX_FILTER_BASELINE_PASS filters=ignored matched=45/45");
  } else {
    for (const [query, predicate] of [
      ["overload=overloaded", n => n % 4 === 1 || n % 4 === 2], ["overload=normal", n => n % 4 === 0],
      ["fingerprint=match", n => n % 4 === 0 || n % 4 === 2], ["fingerprint=mismatch", n => n % 4 === 1],
      ["overload=overloaded&fingerprint=match", n => n % 4 === 2], ["overload=normal&fingerprint=mismatch", () => false],
      ["overload=overloaded&fingerprint=mismatch&planType=team", n => n % 4 === 1],
    ]) {
      const result = await get("?" + query); assert.deepEqual(result.selection.map(j => j.email).sort(), by(predicate), query);
      assert.equal(result.pagination.total, by(predicate).length); assert.equal(result.filter.active, true);
      assert.deepEqual(result.stats, all.stats, "filter changed global statistics");
    }
    const first = await get("?overload=overloaded"), second = await get("?overload=overloaded&page=2");
    assert.equal(first.jobs.length, 20); assert.equal(second.jobs.length, 3);
    assert.equal(new Set([...first.jobs, ...second.jobs].map(j => j.id)).size, 23);
    const response = await fetch(base + "/api/jobs/query", { method: "POST", headers,
      body: JSON.stringify({ emails: [email(1), email(2), email(3)], overload: "overloaded", fingerprint: "match" }) });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).jobs.map(j => j.email), [email(2)]);
    assert.equal((await get("?overload=invalid&fingerprint=invalid")).pagination.total, 45);
    assert.equal((await get("?overload=overloaded&search=codex-filter-45@")).jobs[0].email, email(45));
    console.log("CODEX_FILTER_HTTP_PASS all45 cross-page23; current/history thresholds; latest verdict; unknown excluded; combined/search/plan/email filters; selection/pagination/global counts agree; readonly");
  }
} finally {
  if (child?.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill("SIGTERM"); await done; }
  await new Promise(r => pool.close(r)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
