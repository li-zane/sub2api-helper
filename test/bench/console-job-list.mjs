// End-to-end latency: loopback HTTP, including the full body and JSON parse.
// Run from the project root: node test/bench/console-job-list.mjs [jobs] [samples]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const count = Number(process.argv[2] || 400), samples = Number(process.argv[3] || 25);
assert(Number.isSafeInteger(count) && count >= 20 && count <= 5000);
assert(Number.isSafeInteger(samples) && samples >= 5 && samples <= 1000);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "console-job-list-bench-"));
const email = i => `list-${i}@example.test`;
let child, exited, logs = "";
try {
  // Only terminal metadata; no credentials, pool, upstream calls or running jobs.
  for (let first = 0; first < count; first += 32) {
    await Promise.all(Array.from({ length: Math.min(32, count - first) }, async (_, n) => {
      const i = first + n, dir = path.join(root, `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`);
      await fs.mkdir(dir);
      const at = new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString();
      await fs.writeFile(path.join(dir, "job-meta.json"), JSON.stringify({
        version: 1, email: email(i), status: i % 2 ? "canceled" : "failed",
        created_at: at, updated_at: at, plan_type: "free",
      }));
    }));
  }
  const socket = http.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_ENV: "production", ONBOARDING_OUTPUT_ROOT: root, SUB2API_MONITOR_ENABLED: "0",
      LOCALAPPDATA: root, TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials"),
      TOSUB2_LINUX_CREDENTIAL_ROOT: path.join(root, "credentials"), TOSUB2_CREDENTIAL_KEY: "ab".repeat(32),
    },
  });
  exited = new Promise(resolve => child.once("exit", resolve));
  child.stdout.on("data", b => { logs = (logs + b).slice(-4000); });
  child.stderr.on("data", b => { logs = (logs + b).slice(-4000); });
  let token;
  for (const end = Date.now() + 120_000; Date.now() < end && !token;) {
    if (child.exitCode !== null) throw Error(logs);
    try { token = (await (await fetch(base + "/api/bootstrap")).json()).token; } catch {}
    if (!token) await delay(50);
  }
  assert(token, "Server startup timed out: " + logs);
  const headers = { "x-console-token": token, "content-type": "application/json" };
  const subset = Array.from({ length: 20 }, (_, i) => email(i));
  const cases = [
    { method: "GET", url: "/api/jobs", options: { headers }, total: count },
    { method: "POST", url: "/api/jobs/query", options: { method: "POST", headers, body: JSON.stringify({
      emails: subset, search: "LIST-", status: "failed", page: 999,
    }) }, total: 10 },
  ];
  for (const c of cases) c.times = [];
  for (let i = -5; i < samples; ++i) {
    for (const c of cases) {
      const start = performance.now();
      const res = await fetch(base + c.url, c.options);
      const data = await res.json(), ms = performance.now() - start;
      assert.equal(res.status, 200); assert.equal(data.pagination.totalAll, count);
      assert.equal(data.pagination.page, 1); assert.equal(data.selection.length, c.total);
      assert.equal(data.pagination.total, c.total); assert.equal(data.jobs.length, Math.min(c.total, 20));
      assert.equal(data.stats.pending, count);
      const wanted = c.method === "GET" ? count - 1 : 18;
      assert.equal(data.jobs[0].email, email(wanted));
      for (const [index, detail] of data.jobs.entries()) {
        for (const [key, value] of Object.entries(data.selection[index])) assert.deepEqual(detail[key], value, key);
      }
      if (i >= 0) c.times.push(ms);
    }
  }
  for (const c of cases) {
    const times = c.times.sort((a, b) => a - b);
    const q = p => times[Math.ceil(times.length * p) - 1].toFixed(2);
    console.log(`${c.method} ${c.url} jobs=${count} warmup=5 samples=${samples} p50_ms=${q(.50)} p95_ms=${q(.95)}`);
  }
} finally {
  if (child && child.exitCode === null) child.kill();
  if (exited) await exited;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
