import assert from "node:assert/strict";
import { createResetCreditsReader } from "../src/sub2api-reset-credits.mjs";

let time = Date.now(), calls = [], fail = false, value = 2, cap = 1;
const blocked = new Set(), config = { baseUrl: "http://fixture", adminApiKey: "fixture" };
const reader = createResetCreditsReader({ now: () => time, getSettings: () => ({ ttlMs: 900_000, concurrency: cap }),
  isBlocked: id => blocked.has(id), request: async (_config, route, options) => {
    calls.push({ route, options }); if (fail) throw Error("fixture unavailable");
    return { data: { rate_limit_reset_credits: value === null ? null : { available_count: value, secret: "never-exposed" } } };
  } });
const first = (await reader(config, [1, 1, "invalid"])).get("1");
assert.equal(first.resetCredits.availableCount, 2);
assert(!JSON.stringify(first).includes("never-exposed"));
time += 899_000; await reader(config, [1]); assert.equal(calls.length, 1);
time += 1_000; value = 0; assert.equal((await reader(config, [1])).get("1").resetCredits.availableCount, 0);
fail = true; time += 900_000; const stale = (await reader(config, [1])).get("1");
assert.equal(stale.resetCredits.availableCount, 0); assert.equal(stale.resetCreditsStale, true);
await reader(config, [1]); assert.equal(calls.length, 3, "failures are throttled too");
fail = false; value = null; const unknown = (await reader(config, [1], { forceRefresh: true })).get("1");
assert.equal(unknown.resetCredits, null); assert(unknown.resetCreditsObserved && unknown.resetCreditsStale);
blocked.add("1"); const count = calls.length;
assert.equal((await reader(config, [1], { forceRefresh: true })).get("1"), null);
assert.equal(calls.length, count);
value = 1; assert.equal((await reader(config, [1], { forceRefresh: true, manual: true })).get("1").resetCredits.availableCount, 1);

let active = 0, peak = 0, releases = [], started = [];
const limited = createResetCreditsReader({ getSettings: () => ({ ttlMs: 900_000, concurrency: cap }), request: async (_cfg, route) => {
  active++; peak = Math.max(peak, active); started.push(route);
  await new Promise(resolve => releases.push(resolve)); active--;
  return { rate_limit_reset_credits: { available_count: 3 } };
} });
const pending = limited(config, [1, 2, 3]); await new Promise(resolve => setTimeout(resolve, 0));
const manual = limited(config, [1], { forceRefresh: true, manual: true });
assert.equal(started.length, 1);
cap = 2; limited.refreshSettings(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(started.length, 2);
releases.shift()(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(started.length, 3); assert.equal((await manual).get("1").resetCredits.availableCount, 3);
for (const release of releases) release(); await pending; assert.equal(peak, 2);
assert(calls.every(call => call.options.method === "POST" && call.route.endsWith("/quota/refresh")));
const prior = calls.length; blocked.clear(); value = 7;
assert.equal((await reader({ ...config, adminApiKey: "other-backend" }, [1])).get("1").resetCredits.availableCount, 7);
assert.equal(calls.length, prior + 1, "backend credentials isolate the cache");
console.log("RESET_CREDIT_READER_PASS independent TTL; failed-attempt throttle; unknown/zero; blocked/manual; dedup; dynamic concurrency; backend isolation; no redemption");
