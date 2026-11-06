import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSessionMonitor, normalizeWebSessionMonitor, DEFAULT_WEB_SESSION_MONITOR } from "../src/web-session-monitor.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-session-monitor-unit-"));
let now = Date.parse("2026-11-04T00:00:00Z");
let settings = { ...DEFAULT_WEB_SESSION_MONITOR };
let calls = 0, repairs = 0;
const job = { email: "check@example.test", busy: false, saved: true };
let action = async () => ({ devices: [{ displayName: "Saved browser" }], workspaces: [{ id: "personal", planType: "free" }], currentWorkspaceId: "personal", planType: "free" });
const options = {
  filePath: path.join(root, "monitor.json"), getSettings: () => settings, listJobs: () => [job],
  hasSession: async j => j.saved, isBusy: j => j.busy, now: () => now,
  probe: async () => { calls++; return action(); }, repair: async () => { repairs++; }, tickMs: 10, retryDelayMs: 0,
};
let monitor = new WebSessionMonitor(options);
try {
  assert.throws(() => normalizeWebSessionMonitor({ enabled: "true" }));
  assert.throws(() => normalizeWebSessionMonitor({ intervalMinutes: 0 }));
  assert.throws(() => normalizeWebSessionMonitor({ retryMinutes: 1 }));
  await monitor.load(); await monitor.run({ force: true }); assert.equal(calls, 0, "defaults off");
  settings = normalizeWebSessionMonitor({ enabled: true });
  await Promise.all([monitor.run(), monitor.run()]); assert.equal(calls, 1, "one serialized scan");
  assert.equal(monitor.snapshot().accounts[job.email].devices[0].displayName, "Saved browser");
  await monitor.run(); assert.equal(calls, 1, "durable interval enforced");
  job.busy = true; await monitor.run({ force: true }); assert.equal(calls, 1); job.busy = false;
  job.saved = false; await monitor.run({ force: true }); assert.equal(calls, 1, "explicit logout/missing Web session not resurrected"); job.saved = true;
  action = async () => { throw new Error("SESSION_PROVIDER_ERROR: HTTP 503: access_token=SECRET"); };
  await monitor.run({ force: true }); assert.equal(repairs, 0); assert.equal(monitor.snapshot().accounts[job.email].status, "check_failed");
  assert(!(await fs.readFile(options.filePath, "utf8")).includes("SECRET"));
  action = async () => { throw new Error("SESSION_TOKEN_EXPIRED: confirmed"); };
  await monitor.run({ force: true }); assert.equal(repairs, 1);
  await monitor.run({ force: true }); assert.equal(repairs, 1, "no tight reauthentication loop");
  await monitor.stop(); monitor = new WebSessionMonitor(options); await monitor.load();
  await monitor.run({ force: true }); assert.equal(repairs, 1, "restart retains repair cooldown");
  now += 61 * 60_000;
  action = async () => ({ repairReason: "workspace_unavailable", workspaces: [{ id: "old", canAccess: false }] });
  await monitor.run(); assert.equal(repairs, 2, "verified workspace loss queues repair");
  now += 61 * 60_000;
  action = async () => { settings = { ...settings, enabled: false }; return { repairReason: "plan_changed" }; };
  await monitor.run({ force: true }); assert.equal(repairs, 2, "disable during in-flight check prevents repair");
  settings = { ...settings, enabled: true, autoRelogin: false };
  action = async () => ({ planType: "free", repairReason: "plan_changed" });
  await monitor.run({ force: true }); assert.equal(repairs, 2, "check-only mode");
  settings = { ...settings, autoRelogin: true };
  action = async () => ({ planType: "free", devices: [] });
  now += 61 * 60_000;
  const before = calls;
  monitor.start(); await new Promise(r => setTimeout(r, 40)); await monitor.stop();
  assert(calls > before, "background timer checks without a browser");
  const last = calls; await new Promise(r => setTimeout(r, 30)); assert.equal(calls, last);
  monitor = new WebSessionMonitor(options);
  action = async () => ({ planType: "free", expiresAt: new Date(now + 5 * 60_000).toISOString() });
  await monitor.run({ force: true });
  assert.equal(Date.parse(monitor.snapshot().accounts[job.email].nextCheckAt), now + 3 * 60_000, "renewal should precede known session expiry by two minutes");
  console.log("WEB_SESSION_MONITOR_UNIT_PASS defaults-off; live serial timer; busy/logout skip; transient failure separation; persistent snapshots/cooldown; restart/disable/shutdown");
} finally { await monitor.stop(); await fs.rm(root, { recursive: true, force: true }); }
