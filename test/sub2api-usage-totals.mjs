import assert from "node:assert/strict";
import { combineUsageTotals, createUsageTotalsReader, normalizeUsageTotals } from "../src/sub2api-usage-totals.mjs";
import { formatUsageTotal } from "../web/src/usage-totals.mjs";

let clock = Date.parse("2026-11-05T04:00:00Z"), calls = [], fail = false, active = 0, peak = 0;
const config = { baseUrl: "http://fixture.test", adminApiKey: "fixture-key" };
const read = createUsageTotalsReader({ now: () => clock, concurrency: 2, request: async (backend, endpoint, options) => {
  calls.push({ backend, url: new URL(endpoint, backend.baseUrl), options });
  active++; peak = Math.max(peak, active);
  await new Promise(resolve => setImmediate(resolve)); active--;
  if (fail) throw Error("fixture failure");
  return { data: { total_account_cost: 12.345, total_actual_cost: 0.12345, total_cost: 999, total_tokens: 1234567 } };
} });
const [a, b] = await Promise.all([read(config, [1, 2, 1, 3]), read(config, [1])]);
assert.equal(calls.length, 3); assert.equal(peak, 2); assert.deepEqual(a.get("1"), b.get("1"));
for (const call of calls) {
  assert.equal(call.url.pathname, "/api/v1/admin/usage/stats");
  assert.equal(call.url.searchParams.get("start_date"), "1970-01-01");
  assert.equal(call.url.searchParams.get("end_date"), "2026-11-05");
  assert.equal(call.url.searchParams.get("timezone"), "UTC");
  assert.equal(call.options.timeoutMs, 10_000);
}
const combined = combineUsageTotals([1, 2, 1], a);
assert.equal(combined.accountCost, 24.69); assert.equal(combined.userCost, 0.2469); assert.equal(combined.tokens, 2469134);
assert.equal(combineUsageTotals([1, 99], a).tokens, null, "partial totals must not look complete");
await read(config, [1]); assert.equal(calls.length, 3);
clock += 60_001; fail = true;
const stale = await read(config, [1, 4]);
assert.equal(stale.get("1").stale, true); assert.equal(stale.get("1").tokens, 1234567);
assert.equal(stale.get("4").tokens, null); assert.equal(stale.get("4").fetchedAt, null);
const failedCount = calls.length; await read(config, [4]); assert.equal(calls.length, failedCount, "failed requests should back off");
fail = false; await read(config, [1], { forceRefresh: true }); assert.equal(calls.at(-1).url.searchParams.get("nocache"), "true");
await read({ ...config, adminApiKey: "other-fixture-key" }, [1]); assert.equal(calls.length, failedCount + 2, "different credentials must isolate cache");
assert.equal(normalizeUsageTotals({ data: { total_account_cost: 0, total_actual_cost: 0, total_tokens: 0 } }, "now").tokens, 0);
assert.equal(normalizeUsageTotals({ data: { total_actual_cost: 1, total_cost: 99 } }, "now").accountCost, null, "standard cost is not account billed cost");
assert.throws(() => normalizeUsageTotals({ data: { total_account_cost: null, total_actual_cost: false, total_tokens: "" } }, "now"));
for (const [value, expected] of [[0,"0"],[999,"999"],[999499,"999K"],[999500,"1M"],[999500000,"1B"],[1234567890,"1.23B"],[1234,"1.23K"],[null,"—"],[NaN,"—"]]) assert.equal(formatUsageTotal(value, { tokens: true }), expected);
assert.equal(formatUsageTotal(0.00123456), "0.00123"); assert.equal(formatUsageTotal(12.3456), "12.3");
let manualReads = 0;
const blockedRead = createUsageTotalsReader({ isBlocked: () => true, request: async () => {
  manualReads++; return { total_account_cost: 1, total_actual_cost: 2, total_tokens: 3 };
} });
assert.equal((await blockedRead(config, [1], { forceRefresh: true })).get("1"), null);
assert.equal(manualReads, 0, "background force refresh must still skip banned accounts");
assert.equal((await blockedRead(config, [1], { forceRefresh: true, manual: true })).get("1").tokens, 3);
assert.equal(manualReads, 1, "explicit authenticated manual read bypasses automation-only exclusion");
console.log("USAGE_TOTALS_PASS all-history A/U/T semantics; unique account aggregation; concurrency/dedup/cache; stale/unknown isolation; forced refresh; manual blocked-account reads; three significant digits and K/M/B boundaries");
