import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubscriptionHistory, isSubscribedPlan, historicalSubscriptionEvidence } from "../src/subscription-history.mjs";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-subscriptions-"));
let now = "2026-11-15T00:00:00Z";
const file = path.join(dir, "history.json"), store = new SubscriptionHistory(file, { now: () => now });
try {
  for (const plan of [null, undefined, "", "free", "Free", "unknown", "null", "chatgptfreeplan"]) assert(!isSubscribedPlan(plan));
  for (const plan of ["team", "plus", "business", "business_premium", "pro"]) assert(isSubscribedPlan(plan));
  const base = { email: "Paid@Example.test", planType: "team", remark: "备注", accountCostCny: 12.34, userCostUsd: 10,
    credentials: { password: "old-password", totpSecret: "ABCDEFGHIJKLMNOP", sub2apiJson: '{"access_token":"private"}' } };
  await store.reconcile([base, { email: "free@example.test", planType: "free" }, { email: "unknown@example.test" }], [base.email]);
  assert.equal(store.size, 1); let record = store.list(7)[0];
  assert.equal(record.profitCents, "5766"); assert.equal(record.profitDisplay, "￥57.66"); assert.equal(record.email, "paid@example.test");
  assert(!JSON.stringify(record).includes("password")); assert(!JSON.stringify(record).includes("private"));
  const original = await fs.readFile(file, "utf8");
  await store.reconcile([base], [base.email]); assert.equal(await fs.readFile(file, "utf8"), original, "unchanged polling rewrote history");
  now = "2026-11-15T01:00:00Z";
  await store.reconcile([{ ...base, email: "paid@example.test", planType: "free", historicalPlanType: "plus", userCostUsd: undefined,
    credentials: { password: "new-password" } }], [base.email]);
  record = store.list(7)[0];
  assert.equal(record.lastPaidPlanType, "team", "old evidence replaced the most recent paid subscription");
  assert.equal(record.userCostUsd, 10, "missing statistics reset saved usage");
  assert.equal(store.credentials(record.id), "paid@example.test----new-password----ABCDEFGHIJKLMNOP");
  assert.equal(store.list(8)[0].profitDisplay, "￥67.66", "price multiplier change did not recompute profit");
  await store.reconcile([{ ...base, credentials: { password: "", totpSecret: "" }, userCostUsd: 0 }], [base.email]);
  assert.equal(store.credentials(record.id), '{"access_token":"private"}', "cleared credentials were copied from an old snapshot");
  assert.equal(store.list(7)[0].profitCents, "-1234", "real zero usage was discarded");
  await store.reconcile([], []); assert.equal(store.list(7)[0].present, false);
  const restored = new SubscriptionHistory(file); await restored.load();
  assert.equal(restored.size, 1); assert.equal(restored.credentials(record.id), '{"access_token":"private"}');
  const before = JSON.stringify(store.list(7));
  await fs.writeFile(path.join(dir, "blocked"), "fixture"); store.file = path.join(dir, "blocked", "history.json");
  await assert.rejects(store.reconcile([{ ...base, remark: "uncommitted" }], [base.email]));
  assert.equal(JSON.stringify(store.list(7)), before, "failed disk write published uncommitted history");
  store.file = file; await store.reconcile([{ ...base, remark: "retry" }], [base.email]); assert.equal(store.list(7)[0].remark, "retry");
  const evidence = historicalSubscriptionEvidence([{ type: "password", after: { planType: "pro" } },
    { type: "workspaces", at: "2026-11-01T00:00:00Z", before: { workspaces: [{ planType: "business" }] }, after: { workspaces: [{ planType: "free" }] } }]);
  assert.deepEqual(evidence, { planType: "business", at: "2026-11-01T00:00:00Z" });
  console.log("SUBSCRIPTION_HISTORY_PASS paid-only dedupe; exact profit/rate/zero; redacted lists; latest credentials/explicit clear; downgrade/delete/restart; stable polling; failed-write rollback; workspace backfill");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
