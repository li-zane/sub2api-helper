import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { WebSessionMonitor } from "../src/web-session-monitor.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-recovery-continuation-"));
let now = Date.now(), repairs = 0;
let action = async () => { throw new Error("SESSION_TOKEN_EXPIRED: fixture"); };
const job = { email: "continuation@example.test" };
const options = {
  filePath: path.join(root, "monitor.json"), now: () => now,
  getSettings: () => ({ enabled: true, autoRelogin: true, intervalMinutes: 15, retryMinutes: 60 }),
  listJobs: () => [job], isBusy: () => false, hasSession: () => true, retryDelayMs: 0,
  probe: () => action(), repair: () => { repairs++; },
};
let monitor = new WebSessionMonitor(options);
try {
  await monitor.run(); assert.equal(repairs, 1);
  await monitor.repairFinished(job.email, { webOnly: true });
  await monitor.stop(); monitor = new WebSessionMonitor(options); await monitor.load();
  action = async () => { throw new Error("HTTP 503"); };
  await monitor.run(); assert.equal(repairs, 1, "transient failure must retain continuation without logging in");
  assert.equal(monitor.snapshot().accounts[job.email].webRecoveryPending, true);
  action = async () => ({ repairReason: "workspace_changed" });
  await monitor.run({ force: true }); assert.equal(repairs, 2, "Web recovery continues through workspace repair across restart");
  await monitor.repairFinished(job.email, { webOnly: true });
  await monitor.run({ force: true }); assert.equal(repairs, 2, "an unresolved workspace cannot grant repeated cooldown bypasses");
  action = async () => { throw new Error("SESSION_TOKEN_EXPIRED: fixture"); };
  await monitor.run({ force: true }); assert.equal(repairs, 2, "a second expiry obeys cooldown");
  now += 61 * 60_000;
  await monitor.run(); assert.equal(repairs, 3);
  await monitor.repairFinished(job.email, { success: false, webOnly: true });
  action = async () => ({ repairReason: "plan_changed" });
  await monitor.run({ force: true }); assert.equal(repairs, 3, "failed Web login never grants a continuation");
  console.log("WEB_RECOVERY_CONTINUATION_PASS restart; transient retention; one continuation; failed-login cooldown");
} finally { await monitor.stop(); await fs.rm(root, { recursive: true, force: true }); }

for (const args of [
  ["--stable-oauth"], ["--same-plan-space"], ["--pending-oauth"],
  ["--pool-auth-error"], ["--pool-auth-error", "--manual-disabled"],
  ["--pool-auth-error", "--cooling"], ["--pool-auth-error", "--sync-failure"],
]) {
  const result = spawnSync(process.execPath, ["test/console-web-session-monitor-smoke.mjs", ...args], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("WEB_RECOVERY_PASS 7 HTTP scenarios and durable continuation");
