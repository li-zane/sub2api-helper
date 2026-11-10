import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OverloadMonitor, OVERLOAD_MESSAGE } from "../src/overload-monitor.mjs";
import { OverloadCooldown } from "../src/overload-cooldown.mjs";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-unified-overload-"));
const email = "shared@example.test", config = { baseUrl: "fixture", adminApiKey: "fixture" };
let now = Date.parse("2026-11-11T12:19:00Z"), failRequests = false, failOverloads = false, enabled = true, timerCallback, timerDelay, hold;
const calls = [], mutations = [], rows = ["12:04:00", "12:14:59", "12:15:00", "12:18:00"].map((s, id) => ({ id, account_id: 7, status_code: 503, message: OVERLOAD_MESSAGE, created_at: "2026-11-11T" + s + "Z" }));
const common = { getConfig: () => config, backendIdentity: c => c.baseUrl, now: () => now, clearTimer() {} };
const cooldown = new OverloadCooldown({ ...common, filePath: path.join(dir, "cooldown.json"),
  getSettings: () => ({ windowMinutes: 15, threshold: 3, cooldownMinutes: 1 }),
  setTimer: (fn, ms) => { timerCallback = fn; timerDelay = ms; return { unref() {} }; },
  listAccounts: async () => new Map([[email, [{ id: "7", enabled }]]]),
  request: async (_config, url, options) => { assert(!url.includes("/ops/")); enabled = JSON.parse(options.body).schedulable; mutations.push(enabled); },
});
const monitor = new OverloadMonitor({ ...common, filePath: path.join(dir, "counts.json"), setTimer: () => ({ unref() {} }),
  listAccounts: async () => new Map(enabled ? [[email, ["7"]]] : []), getAdditionalTargets: () => cooldown.countTargets(),
  onOverloadCounts: (email, sample) => cooldown.observeCounts(email, sample),
  request: async (_config, url) => {
    calls.push(url); const u = new URL(url, "http://fixture"), requests = u.pathname.endsWith("/requests");
    if (hold) await hold;
    if (requests ? failRequests : failOverloads) throw Error("fixture unavailable");
    const start = Date.parse(u.searchParams.get("start_time")), end = Date.parse(u.searchParams.get("end_time"));
    const items = requests ? [] : rows.filter(r => Date.parse(r.created_at) >= start && Date.parse(r.created_at) < end);
    return { data: { items, total: items.length } };
  } });
const drain = async () => { await cooldown.refresh(); if (cooldown.running) await cooldown.running; };
try {
  cooldown.stopped = false; await cooldown.setEnabled(email, true);
  await monitor.refresh(); await drain();
  assert.equal(cooldown.snapshot(email).windowCount, 2, "12:04 and 12:14 errors must not count in 12:15–12:30");
  assert.equal(calls.length, 1, "cooldown-only account needs one overload collection and no request collection");
  assert.equal(monitor.snapshot(email).enabled, false, "cooldown must not enable the display switch");
  assert.equal(monitor.snapshot(email).recentCount, 2); assert.equal(monitor.snapshot(email).countMode, "fixed_bucket");
  await monitor.setEnabled(email, true); calls.length = 0; now += 1000; failRequests = true;
  rows.push({ ...rows[0], id: 99, created_at: "2026-11-11T12:18:59Z" });
  await monitor.refresh(); await drain();
  assert.equal(calls.filter(url => url.includes("/upstream-errors")).length, 1, "display+cooldown share exactly one overload query");
  assert.deepEqual(mutations, [false]); assert.equal(cooldown.snapshot(email).windowCount, 3);
  assert.equal(monitor.snapshot(email).points.at(-1).count, 3); assert(monitor.snapshot(email).requestError);
  assert.equal(timerDelay, 60_000);
  // No count or status poll is needed to wake the saved deadline.
  failOverloads = true; now += 60_000; const before = calls.length; timerCallback(); await drain();
  assert.deepEqual(mutations, [false, true]); assert.equal(calls.length, before); assert.equal(cooldown.snapshot(email).phase, "idle");
  failOverloads = false; now += 1000; await monitor.refresh(); await drain(); assert.deepEqual(mutations, [false, true], "same bucket's old count cannot immediately cool again");
  now = Date.parse("2026-11-11T12:30:00Z"); await monitor.refresh(); assert.equal(monitor.snapshot(email).recentCount, 0);
  // Failed overload fetch must never turn a cached previous high count into a new pause.
  failOverloads = true; now += 60_000; await monitor.refresh(); assert.deepEqual(mutations, [false, true]);
  failOverloads = false; failRequests = false;
  rows.push(...[1, 2, 3].map(id => ({ ...rows[0], id: 100 + id, created_at: "2026-11-11T12:30:01Z" })));
  let release; hold = new Promise(r => { release = r; }); const inflight = monitor.refresh(); await new Promise(r => setImmediate(r));
  await cooldown.setEnabled(email, false); release(); await inflight; hold = null; await drain();
  assert.equal(enabled, true, "switch-off during sample blocks pending pause");
  console.log("UNIFIED_OVERLOAD_PASS fixed current bucket; one shared query; cooldown-only targets; independent metrics; threshold pause; exact deadline without polls; failure/rollover/switch races; same-bin rearm guard");
} finally { await monitor.stop(); await cooldown.stop(); await fs.rm(dir, { recursive: true, force: true }); }
