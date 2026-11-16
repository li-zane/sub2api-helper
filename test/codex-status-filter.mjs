import assert from "node:assert/strict";
import { overloadFilterValue, fingerprintFilterValue } from "../web/src/codex-status-filter.mjs";

const detection = counts => ({ enabled: true, bucketMinutes: 15, countMode: "fixed_bucket", windowMinutes: 15,
  points: counts.map(count => ({ count })) });
const cooldown = { enabled: true, phase: "idle", settings: { threshold: 5, windowMinutes: 15 } };
assert.equal(overloadFilterValue(detection([0, 0, 0, 0, 0, 0]), cooldown), "normal");
assert.equal(overloadFilterValue(detection([0, 0, 0, 0, 0, 5]), cooldown), "overloaded");
assert.equal(overloadFilterValue(detection([3, 3, 3, 3, 3, 0]), cooldown), "overloaded");
assert.equal(overloadFilterValue(detection([2, 3, 3, 3, 3, 0]), cooldown), "normal");
assert.equal(overloadFilterValue(detection([null, 0, 0, 0, 0, 0]), cooldown), null);
assert.equal(overloadFilterValue(detection([null, 0, 0, 0, 0, 5]), cooldown), "overloaded");
assert.equal(overloadFilterValue(null, { ...cooldown, phase: "cooling" }), "overloaded");
assert.equal(overloadFilterValue(null, { ...cooldown, phase: "pausing" }), "overloaded");
assert.equal(overloadFilterValue(null, cooldown), null);
assert.equal(overloadFilterValue(detection([0, 0, 0, 0, 0, 0]), {}), null);
const round = (status, n) => ({ status, checkedAt: `2026-11-17T00:00:0${n}Z` });
assert.equal(fingerprintFilterValue({ enabled: true, recentResults: [round("match", 1)] }), "match");
assert.equal(fingerprintFilterValue({ enabled: true, recentResults: [round("mismatch", 2), round("match", 1)] }), "mismatch");
assert.equal(fingerprintFilterValue({ enabled: true, recentResults: [round("match", 1), round("mismatch", 2)] }), "mismatch");
for (const status of ["unknown", "error"]) {
  assert.equal(fingerprintFilterValue({ enabled: true, recentResults: [round(status, 3), round("match", 1)], result: round("match", 1) }), null);
}
assert.equal(fingerprintFilterValue({ enabled: true, previousResult: round("match", 1) }), "match");
assert.equal(fingerprintFilterValue({ enabled: true, result: { status: "match", checkedAt: "invalid" } }), null);
assert.equal(fingerprintFilterValue(null), null);
for (const enabled of [false, undefined]) {
  for (const status of ["match", "mismatch"]) assert.equal(fingerprintFilterValue({ enabled, recentResults: [round(status, 1)] }), null);
  for (const counts of [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 5]]) {
    assert.equal(overloadFilterValue({ ...detection(counts), enabled }, { ...cooldown, enabled: false }), null);
  }
  assert.equal(overloadFilterValue(null, { ...cooldown, phase: "cooling", enabled }), null);
}
assert.equal(overloadFilterValue({ ...detection([0, 0, 0, 0, 0, 0]), enabled: false }, { ...cooldown, phase: "cooling" }), "overloaded");
console.log("CODEX_FILTER_PASS enabled/current/90min/cooling; disabled or unknown switches excluded; latest definitive verdict only");
