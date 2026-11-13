import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OverloadCooldown } from "../src/overload-cooldown.mjs";
import { OverloadMonitor, OVERLOAD_MESSAGE, recentIntervals } from "../src/overload-monitor.mjs";
import { overloadDashboard } from "../web/src/codex-dashboard.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-dual-window-"));
const email = "dual-window@example.test", config = { baseUrl: "fixture", adminApiKey: "fixture" };
let index = 0;
async function fixture({ counts, threshold = 4, windowMinutes = 15, display = true }) {
  let now = Date.parse("2026-11-13T09:41:00Z"), enabled = true, fail = false;
  const settings = { windowMinutes, threshold, cooldownMinutes: 1 }, calls = [], mutations = [];
  const grid = recentIntervals(now, windowMinutes);
  const rows = grid.flatMap((p, i) => Array.from({ length: counts[i] }, (_, n) => ({
    id: i * 100 + n, account_id: 7, status_code: 503, message: OVERLOAD_MESSAGE,
    created_at: new Date(Date.parse(p.start) + 1000).toISOString(),
  })));
  const common = { getConfig: () => config, backendIdentity: c => c.baseUrl, now: () => now,
    setTimer: () => ({ unref() {} }), clearTimer() {} };
  const options = { ...common, filePath: path.join(dir, `cooldown-${index++}.json`), getSettings: () => settings,
    listAccounts: async () => new Map([[email, [{ id: "7", enabled }]]]),
    request: async (_config, url, options) => {
      assert(!url.includes("/ops/")); enabled = JSON.parse(options.body).schedulable; mutations.push(enabled);
    } };
  let cooldown = new OverloadCooldown(options);
  const monitor = new OverloadMonitor({ ...common, filePath: path.join(dir, `counts-${index}.json`),
    getWindowMinutes: () => settings.windowMinutes,
    listAccounts: async () => new Map(enabled ? [[email, ["7"]]] : []),
    getAdditionalTargets: () => cooldown.countTargets(),
    onOverloadCounts: (email, sample) => cooldown.observeCounts(email, sample),
    request: async (_config, url) => {
      calls.push(url); if (fail) throw Error("fixture unavailable");
      const u = new URL(url, "http://fixture"), start = Date.parse(u.searchParams.get("start_time")), end = Date.parse(u.searchParams.get("end_time"));
      const items = u.pathname.endsWith("/requests") ? [] : rows.filter(r => Date.parse(r.created_at) >= start && Date.parse(r.created_at) < end);
      return { data: { items, total: items.length } };
    } });
  cooldown.stopped = false; await cooldown.setEnabled(email, true);
  if (display) await monitor.setEnabled(email, true);
  return { monitor, get cooldown() { return cooldown; }, settings, calls, mutations,
    advance(ms = 1000) { now += ms; }, fail(value) { fail = value; },
    sample(points, point = points.at(-1)) { return { config, accountIds: ["7"], points, point, sampledAt: now, windowMinutes: settings.windowMinutes }; },
    async refresh() { await monitor.refresh(); await cooldown.refresh(); if (cooldown.running) await cooldown.running; },
    async restart() { await cooldown.stop(); cooldown = new OverloadCooldown(options); await cooldown.load(); cooldown.stopped = false; },
    async close() { await monitor.stop(); await cooldown.stop(); },
  };
}

try {
  const f = await fixture({ counts: [3, 2, 2, 2, 2, 1], threshold: 5 });
  try {
    await f.refresh(); assert.deepEqual(f.mutations, []);
    const firstCalls = f.calls.length;
    f.settings.threshold = 4; f.advance(); await f.refresh();
    assert.deepEqual(f.mutations, [false], "lowering threshold 5→4 must pause at total=12 even when current=1");
    const state = f.cooldown.snapshot(email), dashboard = overloadDashboard(f.monitor.snapshot(email), state);
    assert.equal(state.windowCount, 1); assert.equal(state.historyCount, 12); assert.equal(state.triggerReason, "history");
    assert.equal(state.historyCount, dashboard.total.count); assert.equal(dashboard.total.limit, 12);
    const latestQuery = new URL(f.calls.filter(u => u.includes("upstream-errors")).at(-1), "http://fixture");
    assert.equal(Date.parse(latestQuery.searchParams.get("end_time")) - Date.parse(latestQuery.searchParams.get("start_time")), 26 * 60_000 + 1000,
      "warm sampling fetches only previous+current buckets and reuses the rest of history");
    assert.equal(f.calls.length - firstCalls, 2, "display+cooldown share one overload and one request query");
    f.advance(); await f.refresh(); assert.deepEqual(f.mutations, [false], "no duplicate pause when already cooling");
    await f.cooldown.manualOverride(email, ["7"], async () => f.cooldown.setSchedulable(config, "7", true), { enabled: true });
    await f.restart(); f.advance(); await f.refresh();
    assert.deepEqual(f.mutations, [false, true], "restart preserves same-bin resume protection for both thresholds");
    f.advance(15 * 60_000); await f.refresh();
    assert.deepEqual(f.mutations, [false, true], "aged-out history below threshold must not pause");
  } finally { await f.close(); }

  for (const [counts, reason, windowMinutes] of [
    [[2, 2, 2, 2, 2, 1], null, 15], // one below total limit
    [[1, 1, 1, 1, 1, 4], "current", 15],
    [[2, 2, 2, 1, 1, 4], "both", 15],
    [[0, 3, 3, 2, 3, 1], "history", 15],
    [[5, 5, 2], "history", 30],
    [[12], "both", 120],
  ]) {
    const f = await fixture({ counts, windowMinutes, display: false });
    try {
      await f.refresh(); assert.deepEqual(f.mutations, reason ? [false] : []);
      assert.equal(f.cooldown.snapshot(email).triggerReason, reason);
      assert.equal(f.calls.length, 1, "cooldown-only total requires no extra log queries");
      if (reason === "history" && counts[0] === 0) {
        await f.cooldown.manualOverride(email, ["7"], async () => f.cooldown.setSchedulable(config, "7", true), { enabled: true });
        f.advance(15 * 60_000); await f.refresh();
        assert.deepEqual(f.mutations, [false, true, false], "next bucket rearms total threshold after manual resume");
      }
    } finally { await f.close(); }
  }

  const invalid = await fixture({ counts: [0, 0, 0, 0, 0, 1] });
  try {
    const valid = recentIntervals(Date.parse("2026-11-13T09:41:00Z")).map(p => ({ ...p, count: 3 }));
    for (const points of [valid.slice(1), valid.map((p, i) => i === 0 ? { ...p, count: null } : p),
      valid.map((p, i) => i === 0 ? valid[1] : p), valid.map(p => ({ ...p, start: new Date(Date.parse(p.start) - 900_000).toISOString(), end: p.start })),
      valid.map((p, i) => i === 5 ? { ...p, count: 2 } : p), valid.map((p, i) => i === 0 ? { ...p, count: Number.MAX_SAFE_INTEGER } : p)]) {
      invalid.advance(); await invalid.cooldown.observeCounts(email, invalid.sample(points, valid.at(-1)));
      assert.deepEqual(invalid.mutations, [], "incomplete/misaligned/mismatched/overflowed history is not a pause signal");
    }
    invalid.advance(); await invalid.cooldown.observeCounts(email, invalid.sample([], { ...valid.at(-1), count: 4 }));
    assert.deepEqual(invalid.mutations, [false], "current threshold still works without history");
  } finally { await invalid.close(); }

  const failed = await fixture({ counts: [0, 3, 3, 2, 3, 1], threshold: 5 });
  try {
    await failed.refresh(); failed.settings.threshold = 4; failed.advance(); failed.fail(true); await failed.refresh();
    assert.deepEqual(failed.mutations, [], "failed refresh must not use old high totals to pause");
    failed.advance(); failed.fail(false); await failed.refresh(); assert.deepEqual(failed.mutations, [false]);
  } finally { await failed.close(); }
  console.log("DUAL_WINDOW_PASS current/history/both OR; exact thresholds; warm cache; cooldown-only; custom grid; validated history; failed refresh; durable resume guard and next-bin rearm");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
