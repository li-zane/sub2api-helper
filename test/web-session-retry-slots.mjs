import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { WebSessionMonitor } = await import(pathToFileURL(path.resolve(process.env.WEB_RETRY_MONITOR || "src/web-session-monitor.mjs")));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-retry-slots-"));
const job = { email: "probe@example.test" };
let enabled = true, busy = false, full = false, calls = 0, repairs = 0, held = 0, maxHeld = 0;
let action = async () => { throw new Error("SESSION_PROVIDER_ERROR: HTTP 503: SECRET"); };
const monitor = new WebSessionMonitor({
  filePath: path.join(root, "monitor.json"), getSettings: () => ({ enabled, autoRelogin: true, intervalMinutes: 15, retryMinutes: 60 }),
  listJobs: () => [job], hasSession: async () => true, isBusy: () => busy, retryDelayMs: 1,
  withSlot: async (_job, fn) => { if (full) return; held++; maxHeld = Math.max(maxHeld, held); try { return await fn(); } finally { held--; } },
  probe: async () => { calls++; return action(); }, repair: async () => { repairs++; },
});
try {
  await monitor.run({ force: true });
  assert.equal(calls, 3, "non-401 must stop after first attempt plus two retries");
  assert.equal(monitor.snapshot().accounts[job.email].checkAttempts, 3);
  assert.equal(repairs, 0); assert.equal(held, 0); assert.equal(maxHeld, 1, "all retries hold only one shared slot");
  assert(!(await fs.readFile(path.join(root, "monitor.json"), "utf8")).includes("SECRET"));
  for (const message of ["HTTP 403", "HTTP 429", "HTTP 502", "network timeout"]) {
    calls = 0; action = async () => { throw new Error(message); }; await monitor.run({ force: true }); assert.equal(calls, 3);
  }
  calls = 0; action = async () => { if (calls < 3) throw new Error("network timeout"); return { planType: "free", devices: [] }; };
  await monitor.run({ force: true }); assert.equal(calls, 3); assert.equal(monitor.snapshot().accounts[job.email].status, "valid");
  for (const error of [new Error("SESSION_PROVIDER_ERROR: HTTP 401: rejected"), Object.assign(new Error("unauthorized"), { status: 401 }), new Error("SESSION_TOKEN_EXPIRED: confirmed"), new Error("SESSION_CREDENTIALS_UNAVAILABLE: other account")]) {
    calls = 0; action = async () => { throw error; }; await monitor.run({ force: true }); assert.equal(calls, 1, "401 and terminal session errors are not retried");
  }
  const oldChecked = monitor.snapshot().accounts[job.email].lastCheckedAt;
  full = true; calls = 0; await monitor.run({ force: true }); assert.equal(calls, 0); assert.equal(monitor.snapshot().accounts[job.email].lastCheckedAt, oldChecked, "full shared pool must not mark a skipped check as completed"); full = false;
  calls = 0; action = async () => { busy = true; throw new Error("HTTP 403: account deactivated"); };
  await monitor.run({ force: true }); assert.equal(calls, 1, "ban/busy transition stops retry"); busy = false;
  calls = 0; action = async () => { enabled = false; throw new Error("HTTP 503"); };
  await monitor.run({ force: true }); assert.equal(calls, 1); enabled = true;
  calls = 0; action = async () => { throw new Error("HTTP 503"); };
  monitor.retryDelayMs = 60_000;
  const running = monitor.run({ force: true });
  while (!calls) await new Promise(r => setTimeout(r, 1));
  const start = Date.now(); await monitor.stop(); await running;
  assert(Date.now() - start < 1_000, "shutdown aborts retry delay"); assert.equal(calls, 1); assert.equal(held, 0);
  console.log("WEB_RETRY_SLOTS_PASS max-three-attempts; recovery; 401/terminal-no-retry; one-slot; full-pool-defer; ban/disable/shutdown-stop; redacted-state");
} catch (error) { console.error("WEB_RETRY_SLOTS_FAIL: " + error.message.split("\n")[0]); process.exitCode = 1; }
finally { await monitor.stop(); await fs.rm(root, { recursive: true, force: true }); }
