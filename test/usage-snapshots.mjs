import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UsageSnapshots } from "../src/usage-snapshots.mjs";
import { mergeUsageTotals, createUsageTotalsReader } from "../src/sub2api-usage-totals.mjs";
import { hasUsageSnapshot, mergeUsageSnapshot } from "../web/src/usage-snapshot.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-snapshot-unit-")), file = path.join(dir, "usage.json");
const backend = "a".repeat(24), other = "b".repeat(24), email = "fixture@example.test", at = "2026-11-07T00:00:00Z";
const usage = { source: "sub2api", fetchedAt: at, primary: { usedPercent: 10 }, secondary: { usedPercent: 17 }, allowed: true,
  credits: { balance: "105" }, resetCredits: { availableCount: 2, credits: [] }, totals: { accountCost: 105, userCost: 117, tokens: 272000000, fetchedAt: at },
  access_token: "must-not-persist", enabled: true };
try {
  const cache = new UsageSnapshots(file); await cache.load();
  await cache.update(backend, [{ email, accountIds: [2, 1, 1], usage }]);
  const reloaded = new UsageSnapshots(file); await reloaded.load();
  assert.equal(reloaded.get(backend, email, [1, 2]).usage.totals.tokens, 272000000);
  assert.equal(reloaded.get(backend, email).usage.stale, true);
  assert.equal(reloaded.get(other, email), null); assert.equal(reloaded.get(backend, email, [1]), null);
  assert.equal(reloaded.get(backend, "other@example.test"), null);
  const exposed = reloaded.get(backend, email); exposed.usage.totals.tokens = 1;
  assert.equal(reloaded.get(backend, email).usage.totals.tokens, 272000000, "returned snapshots must not mutate the cache");
  const disk = await fs.readFile(file, "utf8"); assert(!disk.includes("must-not-persist")); assert(!disk.includes('"enabled"'));
  const partial = mergeUsageTotals(usage.totals, { accountCost: 0, userCost: null, tokens: null, fetchedAt: "2026-11-07T01:00:00Z", stale: false });
  assert.equal(partial.accountCost, 0); assert.equal(partial.userCost, 117); assert.equal(partial.tokens, 272000000); assert(partial.stale);
  const before = { ...usage, cacheKey: "same", status: "error", error: "old error" };
  assert(hasUsageSnapshot(before)); assert(hasUsageSnapshot(mergeUsageSnapshot(before, null)));
  const updated = mergeUsageSnapshot(before, { cacheKey: "same", fetchedAt: "2026-11-07T02:00:00Z", primary: { usedPercent: 0 },
    totals: { accountCost: 0, userCost: null }, resetCredits: { availableCount: 0, credits: [] } });
  assert.equal(updated.primary.usedPercent, 0); assert.equal(updated.secondary.usedPercent, 17);
  assert.equal(updated.totals.userCost, 117); assert.equal(updated.totals.tokens, 272000000); assert.equal(updated.error, null);
  assert.equal(updated.resetCredits.availableCount, 0);
  assert.equal(mergeUsageSnapshot(before, { resetCreditsObserved: true, resetCredits: null }).resetCredits, null, "confirmed unknown card result must not claim an old positive count is current");
  assert.equal(mergeUsageSnapshot(updated, { ...before }).primary.usedPercent, 0, "older polling snapshots must not overwrite a newer refresh");
  assert.equal(mergeUsageSnapshot(before, { cacheKey: "other", totals: null }).primary, undefined, "backend/remote-ID changes must isolate display data");
  await Promise.all([cache.update(backend, [{ email, accountIds: [1, 2], usage: updated }]), cache.update(other, [{ email, accountIds: [1], usage }])]);
  const again = new UsageSnapshots(file); await again.load(); assert.equal(again.get(backend, email).usage.primary.usedPercent, 0); assert(again.get(other, email));
  await again.removeEmail(email); const removed = new UsageSnapshots(file); await removed.load(); assert.equal(removed.get(backend, email), null); assert.equal(removed.get(other, email), null);
  await fs.writeFile(file, "{corrupted"); const broken = new UsageSnapshots(file); await broken.load(); assert.equal(broken.get(backend, email), null);
  let finishOld, started;
  const oldStarted = new Promise(r => started = r), hold = new Promise(r => finishOld = r);
  const reader = createUsageTotalsReader({ request: async (_config, route) => {
    if (!route.includes("nocache=true")) { started(); await hold; return { total_account_cost: 1, total_actual_cost: 1, total_tokens: 1 }; }
    return { total_account_cost: 2, total_actual_cost: 2, total_tokens: 2 };
  } });
  const config = { baseUrl: "http://fixture.test", adminApiKey: "fixture" };
  const pending = reader(config, [1]); await oldStarted;
  assert.equal((await reader(config, [1], { forceRefresh: true, manual: true })).get("1").tokens, 2);
  finishOld(); assert.equal((await pending).get("1").tokens, 2, "late background response must not overwrite manual refresh");
  assert.equal((await reader(config, [1])).get("1").tokens, 2);
  console.log("USAGE_SNAPSHOTS_PASS durable/atomic reload; backend/email/ID isolation; no credentials/readiness; delete/corruption; partial retention; real zero; UI loading/error snapshots; late-poll guard");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
