import assert from "node:assert/strict";
import { normalizeResetCredits } from "../src/sub2api-reset-credits.mjs";
const now = Date.parse("2026-11-01T00:00:00Z");
const future = "2027-01-01T00:00:00Z";
const expired = "2026-10-01T00:00:00Z";
assert.equal(normalizeResetCredits(undefined), null);
for (const available_count of [null, "3", -1, 1.5, true]) assert.equal(normalizeResetCredits({ available_count }), null);
assert.deepEqual(normalizeResetCredits({ available_count: 0 }), { availableCount: 0, credits: [] });
assert.equal(normalizeResetCredits({ available_count: 3 }).availableCount, 3, "live count does not require expiration details");
assert.equal(normalizeResetCredits({ available_count: 3 }, { cached: true, now }), null, "incomplete snapshot remains unknown");
assert.equal(normalizeResetCredits({ available_count: 1, credits: [{ expires_at: expired }] }, { cached: true, now }), null);
assert.deepEqual(normalizeResetCredits({ available_count: 2, credits: [{ expires_at: expired }, { expires_at: future, id: "private-credit", token: "private-token" }] }, { cached: true, now }),
  { availableCount: 1, credits: [{ expiresAt: future }] });
assert.equal(normalizeResetCredits({ available_count: 0 }, { cached: true, now }).availableCount, 0);
console.log("PASS: Sub2API live/snapshot reset-card counts, expiration filtering, unknown/zero separation and secret-free metadata");
