import assert from "node:assert/strict";
import { accountRateLimit } from "../src/account-rate-limit.mjs";
import { codexStatusEligible, codexStatusBlockReason } from "../web/src/codex-eligibility.mjs";
const now = Date.parse("2026-11-07T00:00:00Z");
for (const value of ["2026-11-17T04:58:51+08:00", now + 60000, (now + 60000) / 1000]) {
  assert.equal(accountRateLimit({ status: "active", schedulable: true, rate_limit_reset_at: value }, now).limited, true);
}
assert.equal(accountRateLimit({ rate_limited_at: "2020-01-01", rate_limit_reset_at: "2020-01-02", status: "error", error_message: "HTTP 429" }, now).limited, false, "expired window must not remain limited due to historical error");
for (const a of [{}, { status: "active", rate_limited_at: "2020-01-01" }, { status: "error", error_message: "HTTP 503" }, { rate_limit_reset_at: "invalid" }]) assert.equal(accountRateLimit(a, now).limited, false);
for (const a of [{ status: "rate_limited" }, { is_rate_limited: true }, { status: "error", error_message: "HTTP 429: rate_limit_exceeded" }]) assert.equal(accountRateLimit(a, now).limited, true);
const job = { sub2apiInPool: true, sub2apiEnabled: true, sub2apiRateLimited: true };
assert.equal(codexStatusEligible(job), false); assert.match(codexStatusBlockReason(job), /429/);
console.log("ACCOUNT_RATE_LIMIT_PASS active+schedulable still respects future reset; seconds/ms/ISO; expired windows and historical 429 cleared; transient 503 ignored; UI gate and reason");
